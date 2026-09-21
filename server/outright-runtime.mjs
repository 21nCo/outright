import { WebSocketServer } from "ws";
import chokidar from "chokidar";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createOutrightDatabase } from "./database.mjs";
import { createAgentManager } from "./agent-manager.mjs";
import { createTerminalManager } from "./terminal-manager.mjs";
import { createGitService } from "./git-service.mjs";
import { loadOutrightConfig, scanProjects } from "./project-scanner.mjs";
import { createRuntimeEventHub, validateSocketMessage } from "./runtime-events.mjs";

export function createOutrightRuntime({ configUrl, allowedHosts = runtimeAllowedHosts(), recoveryProcessAlive = defaultRecoveryProcessAlive }) {
  // The database-backed lease is acquired before reconciliation so another
  // live runtime can never have its queued/running rows treated as crash state.
  const database = createOutrightDatabase({ runtimeLease: true });
  const reconciliation = database.reconcileInterruptedRuns();
  if (reconciliation.count) database.audit("runtime.runs.reconciled", { target: "runtime", ...reconciliation });
  const eventHub = createRuntimeEventHub();
  const runtimeInstanceId = randomUUID();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  let latestScan = null;
  let latestScanAt = 0;
  let inFlightScan = null;
  let watcher = null;
  let watcherTimer = null;
  let shuttingDown = false;
  let shutdownPromise;

  function publish(event) {
    return eventHub.publish(event);
  }

  const agents = createAgentManager({ database, publish, validateConversation: async (conversation) => {
    const target = await resolveWorktreeTarget(conversation);
    return () => {
      if (!database.isProjectTrusted(target.project.id, target.project.path)) throw apiError(403, "Project trust is required");
    };
  } });
  const terminals = createTerminalManager({ database, publish });
  const git = createGitService({ database, getProjects: () => latestScan?.projects ?? [], getConfig: () => loadOutrightConfig(configUrl) });

  // Validates that a project/worktree/path triple names exactly one discovered
  // worktree belonging to that project. Trust and execution then bind to the
  // resolved path, not to independently supplied identifiers.
  async function resolveWorktreeTarget({ projectId, worktreeId, worktreePath }) {
    const canonical = await git.requireWorktree(worktreePath);
    const project = (await projects()).projects.find((item) => item.id === projectId);
    const worktree = project?.worktrees.find((item) => item.id === worktreeId);
    if (!project || !worktree) throw apiError(400, "Destination is not a discovered project worktree");
    if (await canonicalOf(worktree.path) !== canonical) throw apiError(400, "Worktree path does not match the discovered worktree");
    return { project, worktree, worktreePath: canonical };
  }

  async function projects(force = false) {
    const timestamp = Date.now();
    if (!force && latestScan && timestamp - latestScanAt < 1500) return latestScan;
    if (!inFlightScan) {
      inFlightScan = loadOutrightConfig(configUrl)
        .then(scanProjects)
        .then(async (result) => {
          latestScan = result;
          latestScanAt = Date.now();
          ensureDefaultGroups(result.projects);
          await refreshWatcher(result.projects);
          return result;
        })
        .finally(() => { inFlightScan = null; });
    }
    return inFlightScan;
  }

  async function refreshWatcher(projectList) {
    if (shuttingDown) return;
    const paths = projectList.flatMap((project) => project.worktrees.filter((worktree) => !worktree.isPrunable && !worktree.isBare).map((worktree) => worktree.path));
    if (watcher) await watcher.close();
    if (shuttingDown) return;
    watcher = chokidar.watch(paths, {
      depth: 1,
      ignoreInitial: true,
      ignored: (target) => /(?:^|\/)(?:node_modules|dist|\.next|\.turbo)(?:\/|$)/.test(target)
        || /(?:^|\/)\.git\/(?:objects|lfs|modules|worktrees)(?:\/|$)/.test(target),
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
    });
    watcher.on("all", (_eventName, changedPath) => {
      clearTimeout(watcherTimer);
      watcherTimer = setTimeout(async () => {
        try {
          const result = await projects(true);
          publish({ type: "projects.changed", payload: { changedPath, projects: result.projects, scannedAt: result.scannedAt } });
        } catch { /* The next manual refresh will surface scanner errors. */ }
      }, 500);
    });
    watcher.on("error", (error) => {
      if (process.env.OUTRIGHT_DEBUG === "1") console.warn("[outright:watcher]", error.message);
    });
  }

  function ensureDefaultGroups(projectList) {
    const current = database.listGroups();
    if (current.groups.length) return;
    const core = database.createGroup("Core systems");
    const experiments = database.createGroup("Experiments");
    for (const project of projectList) {
      database.setProjectGroup(project.id, /experiment|prototype|playground/i.test(`${project.name} ${project.path}`) ? experiments.id : core.id);
    }
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url, "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    try {
      assertRuntimeRequest(request, allowedHosts);
      if (shuttingDown) throw apiError(503, "Runtime is shutting down");
      if (url.pathname === "/api/bootstrap" && request.method === "GET") {
        const scan = await projects();
        return json(response, 200, {
          ...scan,
          projectGroups: database.listGroups(),
          settings: database.getSettings(),
          providers: agents.providers(),
          trustedProjects: database.listTrustedProjects(),
          templates: database.listTemplates(),
          terminals: terminals.list(),
          activeRuns: agents.activeRuns(),
        });
      }
      if (url.pathname === "/api/projects" && ["GET", "POST"].includes(request.method)) return json(response, 200, await projects(request.method === "POST"));
      if (url.pathname === "/api/providers" && request.method === "GET") return json(response, 200, { providers: agents.providers() });
      if (url.pathname === "/api/settings" && request.method === "GET") return json(response, 200, database.getSettings());
      if (url.pathname === "/api/settings" && request.method === "PATCH") return json(response, 200, database.updateSettings(await readJson(request)));

      if (url.pathname === "/api/groups" && request.method === "GET") return json(response, 200, database.listGroups());
      if (url.pathname === "/api/groups" && request.method === "POST") {
        const body = await readJson(request);
        if (!body.name?.trim()) throw apiError(400, "Group name is required");
        return json(response, 201, database.createGroup(body.name));
      }
      const groupMatch = url.pathname.match(/^\/api\/groups\/([^/]+)$/);
      if (groupMatch && request.method === "PATCH") return json(response, 200, database.updateGroup(groupMatch[1], await readJson(request)));
      if (groupMatch && request.method === "DELETE") return json(response, database.deleteGroup(groupMatch[1]) ? 204 : 404, null);
      if (url.pathname === "/api/project-memberships" && request.method === "PUT") {
        const body = await readJson(request); database.setProjectGroup(body.projectId, body.groupId); return json(response, 200, database.listGroups());
      }

      if (url.pathname === "/api/conversations" && request.method === "GET") return json(response, 200, { conversations: database.listConversations({ projectId: url.searchParams.get("projectId"), worktreeId: url.searchParams.get("worktreeId"), archived: url.searchParams.get("archived") === "true" }) });
      if (url.pathname === "/api/conversations" && request.method === "POST") {
        const body = await readJson(request);
        const { worktreePath } = await resolveWorktreeTarget(body);
        const conversation = database.createConversation({ ...body, worktreePath });
        database.audit("conversation.created", { target: conversation.id, projectId: body.projectId, worktreeId: body.worktreeId });
        publish({ type: "conversation.created", conversationId: conversation.id, payload: conversation });
        return json(response, 201, conversation);
      }
      const conversationMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)$/);
      if (conversationMatch && request.method === "GET") {
        const conversation = database.getConversation(conversationMatch[1]);
        if (!conversation) throw apiError(404, "Conversation not found");
        const messagePage = database.listMessagePage(conversation.id, { limit: 200 });
        return json(response, 200, {
          ...conversation,
          messages: messagePage.messages,
          messagePage: messagePage.page,
          runs: database.listRuns(conversation.id),
          oldestInterruptedRun: database.findUnresolvedInterruptedRun(conversation.id) ?? null,
        });
      }
      if (conversationMatch && request.method === "PATCH") {
        const conversation = database.updateConversation(conversationMatch[1], await readJson(request));
        publish({ type: "conversation.updated", conversationId: conversationMatch[1], payload: conversation });
        return json(response, conversation ? 200 : 404, conversation);
      }
      const conversationMessagesMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (conversationMessagesMatch && request.method === "GET") {
        if (!database.getConversation(conversationMessagesMatch[1])) throw apiError(404, "Conversation not found");
        const messagePage = database.listMessagePage(conversationMessagesMatch[1], {
          beforeId: url.searchParams.get("before") || undefined,
          limit: Number(url.searchParams.get("limit") || 200),
        });
        return json(response, 200, { messages: messagePage.messages, messagePage: messagePage.page });
      }
      const conversationMoveMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/move$/);
      if (conversationMoveMatch && request.method === "POST") {
        if (!database.getConversation(conversationMoveMatch[1])) throw apiError(404, "Conversation not found");
        const body = await readJson(request);
        const { worktreePath: destinationPath } = await resolveWorktreeTarget(body);
        const conversation = database.moveConversation(conversationMoveMatch[1], { projectId: body.projectId, worktreeId: body.worktreeId, worktreePath: destinationPath });
        database.audit("conversation.moved", { target: conversation.id, projectId: body.projectId, worktreeId: body.worktreeId, worktreePath: destinationPath });
        publish({ type: "conversation.updated", conversationId: conversation.id, payload: conversation });
        return json(response, 200, conversation);
      }
      const runCreateMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/runs$/);
      if (runCreateMatch && request.method === "POST") {
        const conversation = database.getConversation(runCreateMatch[1]);
        if (!conversation) throw apiError(404, "Conversation not found");
        const interrupted = database.findUnresolvedInterruptedRun(conversation.id);
        if (interrupted) throw apiError(409, "Resolve the interrupted run before starting more agent work", { code: "RUN_RECOVERY_REQUIRED", runId: interrupted.id });
        const body = await readJson(request);
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) throw apiError(400, "Prompt is required");
        if (Buffer.byteLength(prompt) > 256 * 1024) throw apiError(413, "Prompt must be 256 KiB or smaller");
        const target = await resolveWorktreeTarget({ projectId: conversation.projectId, worktreeId: conversation.worktreeId, worktreePath: conversation.worktreePath });
        if (!database.isProjectTrusted(target.project.id, target.project.path)) throw apiError(403, "Project trust is required", { code: "PROJECT_TRUST_REQUIRED", project: { id: target.project.id, name: target.project.name, path: target.project.path } });
        const settings = database.getSettings();
        const provider = body.provider || conversation.provider || settings.provider;
        const providerInfo = agents.providers().find((item) => item.id === provider);
        if (!providerInfo?.available) throw apiError(409, `${provider} CLI is not available`);
        const userMessage = database.addMessage({ conversationId: conversation.id, role: "user", kind: "text", body: prompt });
        publish({ type: "message.created", conversationId: conversation.id, payload: userMessage });
        const run = database.createRun({ conversationId: conversation.id, provider, model: body.model ?? conversation.model ?? settings.model, reasoningEffort: body.reasoningEffort || settings.reasoningEffort, approvalPolicy: body.approvalPolicy || settings.approvalPolicy, prompt });
        return json(response, 202, await agents.schedule({ conversation: database.getConversation(conversation.id), run }));
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (runMatch && request.method === "GET") {
        const run = database.getRun(runMatch[1]);
        return json(response, run ? 200 : 404, run ? { ...run, events: database.listRunEvents(run.id, Number(url.searchParams.get("after") ?? 0)) } : { error: "Run not found" });
      }
      const stopRunMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/stop$/);
      if (stopRunMatch && request.method === "POST") { const stopped = await agents.stop(stopRunMatch[1]); return json(response, stopped ? 202 : 404, { stopped }); }
      const resumeRunMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/resume$/);
      if (resumeRunMatch && request.method === "POST") {
        let interrupted = database.getRun(resumeRunMatch[1]);
        if (!interrupted) throw apiError(404, "Run not found");
        if (interrupted.status !== "interrupted" || interrupted.recoveryDecision) throw apiError(409, "Run is not waiting for a recovery decision");
        const body = await readJson(request);
        const policy = body.policy;
        if (!["discard", "resume-session", "retry"].includes(policy)) throw apiError(400, "Recovery policy must be discard, resume-session, or retry");
        const conversation = database.getConversation(interrupted.conversationId);
        if (!conversation) throw apiError(404, "Conversation not found");

        // Every unresolved interrupted run of the conversation is verified
        // before any decision is recorded — not only the selected one. A
        // conversation can carry an older started run plus a newer
        // never-started (queued) run at the crash; recovering the queued run
        // must not schedule replacement work while the older run's process
        // tree can still mutate the worktree.
        //
        // Each previously started run is re-probed regardless of its
        // restart-time classification: a detached leader can exit while
        // provider descendants still hold the process group. Only a
        // verified-exited (or never started) run may be resolved. A verifiably
        // live process blocks every policy; an unverifiable tree (e.g. on
        // Windows, where the spawned tree is not owned and a gone leader
        // proves nothing) blocks every policy too — including discard, because
        // a recorded discard would clear the submission gate and let a new run
        // start while the original descendants may still mutate the same
        // worktree.
        for (const pending of database.listUnresolvedInterruptedRuns(conversation.id)) {
          if (pending.recoveryClass === "never-started") continue;
          if (!(Number.isSafeInteger(pending.pid) && pending.pid > 0)) {
            throw apiError(409, "An interrupted provider process cannot be verified, so no recovery decision can be recorded yet", { code: "RECOVERY_PROCESS_UNKNOWN", runId: pending.id });
          }
          const verdict = recoveryVerdict(await recoveryProcessAlive(pending.pid));
          if (verdict === "alive") {
            throw apiError(409, "An interrupted provider process is still active; stop it before choosing a recovery policy", { code: "RECOVERY_PROCESS_ACTIVE", pid: pending.pid, runId: pending.id });
          }
          if (verdict !== "exited") {
            throw apiError(409, "An interrupted provider process cannot be verified, so no recovery decision can be recorded yet", { code: "RECOVERY_PROCESS_UNKNOWN", pid: pending.pid, runId: pending.id });
          }
          if (pending.id === interrupted.id) {
            // Record the verified-exited classification but keep the pid: a
            // later validation failure (unavailable provider, missing
            // resumable session) must leave the run retryable, not strip its
            // only process identity and permanently reject it as unknown.
            interrupted = database.updateRun(interrupted.id, { recoveryClass: "exited" });
          }
        }

        if (policy === "discard") {
          const resolved = database.resolveInterruptedRun(interrupted.id, policy);
          if (!resolved) throw apiError(409, "Run is not waiting for a recovery decision");
          database.audit("agent.run.recovery.discard", { target: interrupted.id, conversationId: conversation.id, recoveryClass: interrupted.recoveryClass });
          publish({ type: "run.resolved", conversationId: conversation.id, runId: interrupted.id, payload: resolved });
          return json(response, 200, resolved);
        }

        // Replacement work must respect conversation order: resuming or
        // retrying a run may not schedule its replacement while an older
        // unresolved interrupted run still awaits a decision, or the newer
        // run's side effects could later be overwritten or invalidated by a
        // recovery of the older run. Discarding a never-started run stays
        // allowed above because it schedules no work.
        const unresolved = database.listUnresolvedInterruptedRuns(conversation.id);
        const selected = unresolved.findIndex((candidate) => candidate.id === interrupted.id);
        if (selected > 0) {
          throw apiError(409, "Resolve the older interrupted run before resuming or retrying this one", { code: "RECOVERY_ORDER_REQUIRED", runId: unresolved[0].id });
        }

        // Resumed and retried runs revalidate worktree identity and trust at
        // submission, and again inside the agent drain before spawning.
        const target = await resolveWorktreeTarget({ projectId: conversation.projectId, worktreeId: conversation.worktreeId, worktreePath: conversation.worktreePath });
        if (!database.isProjectTrusted(target.project.id, target.project.path)) throw apiError(403, "Project trust is required", { code: "PROJECT_TRUST_REQUIRED", project: { id: target.project.id, name: target.project.name, path: target.project.path } });
        const providerInfo = agents.providers().find((item) => item.id === interrupted.provider);
        if (!providerInfo?.available) throw apiError(409, `${interrupted.provider} CLI is not available`);
        // Recovery is bound to the immutable run session first. A mutable
        // conversation session is only a compatible fallback when the
        // conversation still targets the same provider.
        const sessionId = interrupted.providerSessionId
          || (conversation.provider === interrupted.provider ? conversation.providerSessionId : null);
        if (policy === "resume-session" && !sessionId) throw apiError(409, "No provider session is available to resume", { code: "NO_PROVIDER_SESSION" });
        const recovery = database.beginInterruptedRunRecovery(interrupted.id, policy, { providerSessionId: sessionId });
        if (!recovery) throw apiError(409, "Run is not waiting for a recovery decision");
        database.audit(`agent.run.recovery.${policy}`, { target: recovery.run.id, recoveredFrom: interrupted.id, conversationId: conversation.id, recoveryClass: interrupted.recoveryClass });
        publish({ type: "run.resolved", conversationId: conversation.id, runId: interrupted.id, payload: recovery.interrupted });
        return json(response, 202, await agents.schedule({
          conversation: recovery.conversation,
          run: recovery.run,
          forceFreshSession: policy === "retry",
          providerSessionId: policy === "retry" ? null : sessionId,
        }));
      }

      if (url.pathname === "/api/trust" && request.method === "POST") {
        const body = await readJson(request);
        const project = (await projects()).projects.find((item) => item.id === body.projectId && item.path === body.projectPath);
        if (!project || body.confirmation !== project.path) throw apiError(400, "Exact project path confirmation is required");
        database.trustProject(project.id, project.path); database.audit("project.trusted", { target: project.id, path: project.path });
        return json(response, 200, { trusted: true, projectId: project.id });
      }
      if (url.pathname === "/api/trust" && request.method === "DELETE") { const body = await readJson(request); database.untrustProject(body.projectId); return json(response, 200, { trusted: false }); }

      if (url.pathname === "/api/terminals" && request.method === "GET") return json(response, 200, { terminals: terminals.list() });
      if (url.pathname === "/api/terminals" && request.method === "POST") { const body = await readJson(request); await projects(); const cwd = await git.requireWorktree(body.cwd); return json(response, 201, terminals.create({ ...body, cwd })); }
      const terminalMatch = url.pathname.match(/^\/api\/terminals\/([^/]+)$/);
      if (terminalMatch && request.method === "GET") { const terminal = terminals.get(terminalMatch[1]); return json(response, terminal ? 200 : 404, terminal ?? { error: "Terminal not found" }); }
      if (terminalMatch && request.method === "DELETE") return json(response, terminals.close(terminalMatch[1]) ? 204 : 404, null);

      if (url.pathname === "/api/git/status" && request.method === "GET") return json(response, 200, await git.status(requiredQuery(url, "path")));
      if (url.pathname === "/api/git/diff" && request.method === "GET") return json(response, 200, await git.diff(requiredQuery(url, "path"), url.searchParams.get("file"), url.searchParams.get("staged") === "true"));
      if (url.pathname === "/api/git/stage" && request.method === "POST") { const body = await readJson(request); return json(response, 200, await git.stage(body.path, body.files)); }
      if (url.pathname === "/api/git/unstage" && request.method === "POST") { const body = await readJson(request); return json(response, 200, await git.unstage(body.path, body.files)); }
      if (url.pathname === "/api/git/commit" && request.method === "POST") { const body = await readJson(request); return json(response, 200, await git.commit(body.path, body.message)); }
      if (url.pathname === "/api/context" && request.method === "GET") return json(response, 200, await git.context(requiredQuery(url, "path")));
      if (url.pathname === "/api/editor/open" && request.method === "POST") { const body = await readJson(request); return json(response, 200, await git.openInEditor(body.path, body.file, body.editor)); }

      if (url.pathname === "/api/worktrees" && request.method === "POST") { const result = await git.createWorktree(await readJson(request)); await projects(true); publish({ type: "projects.changed", payload: latestScan }); return json(response, 201, result); }
      if (url.pathname === "/api/worktrees" && request.method === "DELETE") { const result = await git.removeWorktree(await readJson(request)); await projects(true); publish({ type: "projects.changed", payload: latestScan }); return json(response, 200, result); }

      if (url.pathname === "/api/templates" && request.method === "GET") return json(response, 200, { templates: database.listTemplates() });
      if (url.pathname === "/api/templates" && request.method === "POST") return json(response, 201, database.saveTemplate(await readJson(request)));
      const templateMatch = url.pathname.match(/^\/api\/templates\/([^/]+)$/);
      if (templateMatch && request.method === "DELETE") return json(response, database.deleteTemplate(templateMatch[1]) ? 204 : 404, null);
      if (url.pathname === "/api/search" && request.method === "GET") return json(response, 200, database.search(requiredQuery(url, "q")));
      if (url.pathname === "/api/audit" && request.method === "GET") return json(response, 200, { entries: database.listAudit(Number(url.searchParams.get("limit") ?? 100)) });
      throw apiError(404, "API route not found");
    } catch (error) {
      return json(response, error.statusCode ?? 500, { error: error.message || "Internal server error", ...(error.details ?? {}) });
    }
  }

  function attach(server) {
    server.middlewares.use((request, response, next) => {
      handleRequest(request, response).then((handled) => { if (!handled && !response.writableEnded) next(); }).catch(next);
    });
    const upgrade = (request, socket, head) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname !== "/api/events") return;
      try { assertRuntimeRequest(request, allowedHosts); }
      catch { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
      wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
    };
    server.httpServer?.on("upgrade", upgrade);
    wss.on("connection", (client, request) => {
      const url = new URL(request.url, "http://localhost");
      const previousInstanceId = url.searchParams.get("instanceId");
      eventHub.connect(client, {
        after: url.searchParams.get("after"),
        payload: {
          activeRuns: agents.activeRuns(),
          terminals: terminals.list(),
          runtimeInstanceId,
          restarted: Boolean(previousInstanceId && previousInstanceId !== runtimeInstanceId),
        },
      });
      client.on("message", (data) => {
        try {
          const message = validateSocketMessage(JSON.parse(data.toString()));
          if (!message) { client.close(1008, "Invalid runtime message"); return; }
          if (message.type === "terminal.input") terminals.write(message.terminalId, message.data);
          if (message.type === "terminal.resize") terminals.resize(message.terminalId, message.cols, message.rows);
        } catch { client.close(1008, "Invalid runtime message"); }
      });
      client.on("close", () => eventHub.disconnect(client));
    });
    server.httpServer?.once("close", () => {
      server.httpServer?.off("upgrade", upgrade);
      shutdown().catch((error) => console.error("Runtime shutdown failed", error));
    });
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    clearTimeout(watcherTimer);
    shutdownPromise = (async () => {
      await Promise.all([watcher?.close(), agents.shutdown()]);
      await inFlightScan?.catch(() => {});
      terminals.shutdown();
      eventHub.shutdown();
      wss.close();
      database.close();
    })();
    return shutdownPromise;
  }

  return { attach, handleRequest, projects, publish, database, agents, terminals, git, shutdown };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
        tooLarge = true;
        body = "";
        reject(apiError(413, "Request body too large"));
      }
    });
    request.on("end", () => {
      if (tooLarge) return;
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(apiError(400, "Invalid JSON body")); }
    });
    request.on("error", reject);
  });
}
function json(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (status === 204) response.end(); else response.end(JSON.stringify(payload));
  return true;
}
function requiredQuery(url, name) { const value = url.searchParams.get(name); if (!value) throw apiError(400, `Missing ${name}`); return value; }
function apiError(statusCode, message, details) { const error = new Error(message); error.statusCode = statusCode; error.details = details; return error; }
export function assertRuntimeRequest(request, allowedHosts = runtimeAllowedHosts()) {
  const remoteAddress = request.socket?.remoteAddress;
  if (remoteAddress && !isLoopback(remoteAddress)) throw apiError(403, "Runtime access is limited to loopback clients");
  const hostHeader = request.headers.host;
  if (!hostHeader) throw apiError(400, "Host header is required");
  let requestHost;
  try { requestHost = new URL(`http://${hostHeader}`).hostname.toLowerCase(); }
  catch { throw apiError(400, "Invalid Host header"); }
  if (!allowedHosts.has(requestHost)) throw apiError(403, "Runtime host is not allowed");
  const origin = request.headers.origin;
  if (!origin) return;
  let originUrl;
  try { originUrl = new URL(origin); }
  catch { throw apiError(403, "Cross-origin runtime access is not allowed"); }
  const requestUrl = new URL(`${originUrl.protocol}//${hostHeader}`);
  if (originUrl.origin !== requestUrl.origin) throw apiError(403, "Cross-origin runtime access is not allowed");
}

export function runtimeAllowedHosts(environment = process.env) {
  const configured = environment.OUTRIGHT_ALLOWED_HOSTS?.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean) ?? [];
  return new Set(["127.0.0.1", "localhost", "::1", "[::1]", "terminal.local", ...configured]);
}

function isLoopback(address) {
  const normalized = String(address).toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::") return true;
  const ipv4 = normalized.replace(/^::ffff:/, "");
  return ipv4.startsWith("127.");
}

// Recovery verdicts are tri-state: "alive" (still running), "exited"
// (verified terminated), "unknown" (cannot verify). Legacy boolean probes map
// conservatively; anything unrecognized is unknown.
function recoveryVerdict(value) {
  if (value === true) return "alive";
  if (value === false) return "exited";
  return ["alive", "exited", "unknown"].includes(value) ? value : "unknown";
}

export function defaultRecoveryProcessAlive(pid, platform = process.platform) {
  if (platform === "win32") {
    // The spawned tree is not owned on Windows, so a gone leader says nothing
    // about its descendants: only a live leader is verifiable.
    try { process.kill(pid, 0); return "alive"; }
    catch { return "unknown"; }
  }
  try {
    process.kill(-pid, 0);
    return "alive";
  } catch (error) {
    return error.code === "ESRCH" ? "exited" : "unknown";
  }
}

async function canonicalOf(target) {
  try { return await realpath(target); }
  catch { return path.resolve(target); }
}
