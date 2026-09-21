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

export function createOutrightRuntime({ configUrl, allowedHosts = runtimeAllowedHosts() }) {
  const database = createOutrightDatabase();
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
        return json(response, 200, { ...conversation, messages: messagePage.messages, messagePage: messagePage.page, runs: database.listRuns(conversation.id) });
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
        const interrupted = database.getRun(resumeRunMatch[1]);
        if (!interrupted) throw apiError(404, "Run not found");
        if (interrupted.status !== "interrupted" || interrupted.recoveryDecision) throw apiError(409, "Run is not waiting for a recovery decision");
        const body = await readJson(request);
        const policy = body.policy;
        if (!["discard", "resume-session", "retry"].includes(policy)) throw apiError(400, "Recovery policy must be discard, resume-session, or retry");
        const conversation = database.getConversation(interrupted.conversationId);
        if (!conversation) throw apiError(404, "Conversation not found");

        if (policy === "discard") {
          const resolved = database.resolveInterruptedRun(interrupted.id, policy);
          database.audit("agent.run.recovery.discard", { target: interrupted.id, conversationId: conversation.id, recoveryClass: interrupted.recoveryClass });
          publish({ type: "run.resolved", conversationId: conversation.id, runId: interrupted.id, payload: resolved });
          return json(response, 200, resolved);
        }

        // Resumed and retried runs revalidate worktree identity and trust at
        // submission, and again inside the agent drain before spawning.
        const target = await resolveWorktreeTarget({ projectId: conversation.projectId, worktreeId: conversation.worktreeId, worktreePath: conversation.worktreePath });
        if (!database.isProjectTrusted(target.project.id, target.project.path)) throw apiError(403, "Project trust is required", { code: "PROJECT_TRUST_REQUIRED", project: { id: target.project.id, name: target.project.name, path: target.project.path } });
        const providerInfo = agents.providers().find((item) => item.id === interrupted.provider);
        if (!providerInfo?.available) throw apiError(409, `${interrupted.provider} CLI is not available`);
        const sessionId = conversation.providerSessionId ?? interrupted.providerSessionId;
        if (policy === "resume-session" && !sessionId) throw apiError(409, "No provider session is available to resume", { code: "NO_PROVIDER_SESSION" });
        if (sessionId && conversation.providerSessionId !== sessionId) database.updateConversation(conversation.id, { providerSessionId: sessionId });

        const resolved = database.resolveInterruptedRun(interrupted.id, policy);
        if (!resolved) throw apiError(409, "Run is not waiting for a recovery decision");
        const run = database.createRun({ conversationId: conversation.id, provider: interrupted.provider, model: interrupted.model, reasoningEffort: interrupted.reasoningEffort, approvalPolicy: interrupted.approvalPolicy, prompt: interrupted.prompt });
        database.audit(`agent.run.recovery.${policy}`, { target: run.id, recoveredFrom: interrupted.id, conversationId: conversation.id, recoveryClass: interrupted.recoveryClass });
        publish({ type: "run.resolved", conversationId: conversation.id, runId: interrupted.id, payload: resolved });
        return json(response, 202, await agents.schedule({ conversation: database.getConversation(conversation.id), run, forceFreshSession: policy === "retry" }));
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

async function canonicalOf(target) {
  try { return await realpath(target); }
  catch { return path.resolve(target); }
}
