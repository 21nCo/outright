import { WebSocketServer } from "ws";
import chokidar from "chokidar";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createOutrightDatabase } from "./database.mjs";
import { AGENT_SUPERVISOR, createAgentManager, defaultGroupMembers, hardenWindowsLaunchDirectory, terminateTree } from "./agent-manager.mjs";
import { createTerminalManager } from "./terminal-manager.mjs";
import { createGitService } from "./git-service.mjs";
import { loadOutrightConfig, scanProjects } from "./project-scanner.mjs";
import { utilityProcesses } from "./subprocess-budget.mjs";
import { createRuntimeEventHub, validateSocketMessage } from "./runtime-events.mjs";
import { RESOURCE_BUDGETS } from "./resource-budgets.mjs";

export function createOutrightRuntime({ configUrl, allowedHosts = runtimeAllowedHosts(), subprocesses = utilityProcesses, recoveryProcessAlive = (pid, handshake) => defaultRecoveryProcessAlive(pid, process.platform, defaultGroupMembers, process.kill, handshake, spawnSync), recoveryProcessIdentity = (pid, ownershipToken, platformOwnershipId) => defaultRecoveryProcessIdentity(pid, process.platform, readFileSync, spawnSync, ownershipToken, platformOwnershipId), terminateRecoveryProcess = defaultTerminateRecoveryProcess, recoveryTerminationGraceMs = 3500, recoveryTerminationTimeoutMs = 8000, deletionWorkerGate, deletionCopyGate, deletionCopyPhase, databaseFactory = createOutrightDatabase, agentManagerFactory = createAgentManager, hardenLaunchDirectory = process.platform === "win32" ? hardenWindowsLaunchDirectory : () => {}, terminalManagerFactory = createTerminalManager } = {}) {
  // The database-backed lease is acquired before reconciliation so another
  // live runtime can never have its queued/running rows treated as crash state.
  let agents;
  let terminals;
  let publish;
  let runtimeCapacity;
  let shuttingDown = false;
  let terminalAuditReconciliation = Promise.resolve();
  const database = databaseFactory({ runtimeLease: true, deletionWorkerGate, deletionCopyGate, deletionCopyPhase, onMigrationComplete: () => {
    agents.resumeQueued();
    publish({ type: "capacity.changed", payload: runtimeCapacity() });
  }, onDeletionWorkerStart: () => {
    publish({ type: "capacity.changed", payload: runtimeCapacity() });
  }, onDeletionWorkerExit: () => {
    agents.resumeQueued();
    publish({ type: "capacity.changed", payload: runtimeCapacity() });
  }, onTerminalAuditReconciled: () => {
    if (shuttingDown || !terminals) return;
    terminals.reloadUnknownReservations();
    terminalAuditReconciliation = terminals.reconcileUnknown().then(() => {
      if (!shuttingDown) publish({ type: "capacity.changed", payload: runtimeCapacity() });
    })
      .catch((error) => { if (process.env.OUTRIGHT_DEBUG === "1") console.warn("[outright:terminal-recovery]", error); });
  }, onTerminalAuditError: (error) => {
    if (process.env.OUTRIGHT_DEBUG === "1") console.warn("[outright:terminal-audit]", error);
  } });
  let eventHub;
  let wss;
  try {
  // Completion markers are trusted recovery evidence. Secure their directory
  // before reconciliation reads any record, rather than waiting for the agent
  // manager to initialize after recovery has already classified pending rows.
  hardenLaunchDirectory(database.launchDirectory);
  database.reconcilePendingRetentionCleanup();
  database.reconcileTerminalAudit();
  const reconciliation = database.reconcileInterruptedRuns({
    probeAlive: (pid, handshake) => defaultRecoveryProcessAlive(pid, process.platform, defaultGroupMembers, process.kill, handshake, spawnSync),
  });
  if (reconciliation.count) database.audit("runtime.runs.reconciled", { target: "runtime", ...reconciliation });
  eventHub = createRuntimeEventHub();
  const runtimeInstanceId = randomUUID();
  wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  let latestScan = null;
  let latestScanAt = 0;
  let inFlightScan = null;
  let watcher = null;
  let watcherTimer = null;
  let shutdownPromise;
  let resolveShutdownCompletion;
  const shutdownCompletion = new Promise((resolve) => { resolveShutdownCompletion = resolve; });

  publish = function publish(event) {
    return eventHub.publish(event);
  };

  terminals = terminalManagerFactory({ database, publish, subprocesses });
  const git = createGitService({ database, getProjects: () => latestScan?.projects ?? [], getConfig: () => loadOutrightConfig(configUrl), subprocesses });
  runtimeCapacity = function runtimeCapacity() {
    const capacity = database.capacity();
    return { ...capacity, activeProcesses: agents?.activeProcessCount() ?? 0,
      pendingRunOutcomes: agents?.pendingOutcomeCount() ?? 0,
      limits: { ...capacity.limits, maxPendingRunOutcomes: RESOURCE_BUDGETS.maxPendingRunOutcomes },
      utilityProcesses: subprocesses.capacity(), terminalProcesses: terminals.capacity() };
  };
  // Construct the agent manager after the remaining synchronous startup
  // checks. No provider discovery owner then needs asynchronous teardown on
  // a failed synchronous constructor path.
  agents = agentManagerFactory({ database, publish,
    onShutdownRecovery: () => {
      // The first shutdown may have failed while both SQLite and its outcome
      // journal refused writes. Once an exited result commits, resume the
      // finalizer without asking Vite or a signal handler to call it again.
      if (shuttingDown) void shutdown().catch((error) => console.error("Runtime shutdown recovery failed", error));
    },
    onProvidersChanged: (providers) => publish({ type: "providers.changed", payload: { providers } }), validateConversation: async (conversation) => {
    const target = await resolveWorktreeTarget(conversation);
    return () => {
      if (database.getConversation(conversation.id)?.archived) throw apiError(409, "Archived conversations cannot start agent runs", { code: "CONVERSATION_ARCHIVED" });
      if (!database.isProjectTrusted(target.project.id, target.project.path)) throw apiError(403, "Project trust is required");
    };
  } });
  terminalAuditReconciliation = terminals.reconcileUnknown().then((resolved) => {
    if (resolved && !shuttingDown) publish({ type: "capacity.changed", payload: runtimeCapacity() });
  }).catch(() => {});

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
        .then((config) => scanProjects(config, subprocesses))
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

  async function refreshProjectsAfterMutation(result) {
    try {
      await projects(true);
      publish({ type: "projects.changed", payload: latestScan });
      return result;
    } catch {
      // The Git effect and its audit outcome have already committed. A scan
      // failure cannot turn that success into a retryable failure.
      latestScanAt = 0;
      return { ...result, refreshDeferred: true };
    }
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
    try {
      database.ensureDefaultGroups(projectList);
    } catch (error) {
      // An over-quota legacy database still needs bootstrap and retention UI.
      // The next scan can finish creating defaults once space is reclaimed.
      if (error.statusCode !== 507) throw error;
    }
  }

  function editRetainedData(edit) {
    const launchable = database.canLaunchRun();
    const result = edit();
    if (!launchable && database.canLaunchRun()) agents.resumeQueued();
    return result;
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url, "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;
    try {
      assertRuntimeRequest(request, allowedHosts);
      if (shuttingDown) throw apiError(503, "Runtime is shutting down");
      if (database.maintenanceActive && url.pathname !== "/api/capacity") {
        throw apiError(503, "Archive maintenance is running; retry shortly");
      }
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
          capacity: runtimeCapacity(),
        });
      }
      if (url.pathname === "/api/projects" && ["GET", "POST"].includes(request.method)) return json(response, 200, await projects(request.method === "POST"));
      if (url.pathname === "/api/providers" && request.method === "GET") return json(response, 200, { providers: agents.providers() });
      if (url.pathname === "/api/settings" && request.method === "GET") return json(response, 200, database.getSettings());
      if (url.pathname === "/api/settings" && request.method === "PATCH") {
        const settings = database.updateSettings(await readJson(request));
        agents.resumeQueued();
        publish({ type: "capacity.changed", payload: runtimeCapacity() });
        return json(response, 200, settings);
      }
      if (url.pathname === "/api/capacity" && request.method === "GET") return json(response, 200, runtimeCapacity());
      if (url.pathname === "/api/retention/archived" && request.method === "GET") {
        const limitText = url.searchParams.get("limit");
        const limit = limitText === null ? 100 : Number(limitText);
        return json(response, 200, database.listDeletableArchivedConversations({ limit, cursor: url.searchParams.get("cursor") }));
      }
      if (url.pathname === "/api/retention/delete-archived" && request.method === "POST") {
        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw apiError(400, "Retention request must be a JSON object");
        const result = await database.deleteArchivedConversation(body.id, body.confirmation);
        agents.resumeQueued();
        return json(response, result.deferred ? 202 : 200, { deleted: result.deleted, deferred: Boolean(result.deferred), capacity: runtimeCapacity() });
      }
      if (url.pathname === "/api/retention/cleanup" && request.method === "POST") {
        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw apiError(400, "Retention request must be a JSON object");
        const cutoff = database.validateRetentionCutoff(body.before);
        const operationId = randomUUID();
        await database.auditRetentionCleanupRequested({ operationId, before: cutoff });
        let result;
        try {
          result = await database.pruneHistory({ before: cutoff, limit: 100 });
        } catch (error) {
          await database.auditRequired("retention.cleanup.unknown", { operationId, before: cutoff,
            reason: "cleanup failed after admission", error: error.message });
          throw error;
        }
        await database.auditRequired("retention.cleaned", { operationId, deleted: result.deleted, deferred: result.deferred, before: cutoff });
        agents.resumeQueued();
        return json(response, 200, { deleted: result.deleted, deferred: result.deferred, capacity: runtimeCapacity() });
      }

      if (url.pathname === "/api/groups" && request.method === "GET") return json(response, 200, database.listGroups());
      if (url.pathname === "/api/groups" && request.method === "POST") {
        const body = await readJson(request);
        if (!body.name?.trim()) throw apiError(400, "Group name is required");
        return json(response, 201, database.createGroup(body.name));
      }
      const groupMatch = url.pathname.match(/^\/api\/groups\/([^/]+)$/);
      if (groupMatch && request.method === "PATCH") {
        const patch = await readJson(request);
        const group = editRetainedData(() => database.updateGroup(groupMatch[1], patch));
        return json(response, 200, group);
      }
      if (groupMatch && request.method === "DELETE") {
        const deleted = database.deleteGroup(groupMatch[1]);
        if (deleted) agents.resumeQueued();
        return json(response, deleted ? 204 : 404, null);
      }
      if (url.pathname === "/api/project-memberships" && request.method === "PUT") {
        const body = await readJson(request);
        database.setProjectGroup(body.projectId, body.groupId);
        if (!body.groupId) agents.resumeQueued();
        return json(response, 200, database.listGroups());
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
        const worktreeInterruptedRun = database.findUnresolvedInterruptedRunForWorktree(conversation.worktreePath) ?? null;
        const recoveryConversation = worktreeInterruptedRun ? database.getConversation(worktreeInterruptedRun.conversationId) : null;
        return json(response, 200, {
          ...conversation,
          messages: messagePage.messages,
          messagePage: messagePage.page,
          runs: database.listRuns(conversation.id).map((run) => ({
            ...run, outcomePending: agents.isOutcomePending(run.id),
          })),
          oldestInterruptedRun: database.findUnresolvedInterruptedRun(conversation.id) ?? null,
          worktreeInterruptedRun,
          recoveryConversation: recoveryConversation ? {
            id: recoveryConversation.id,
            title: recoveryConversation.title,
            projectId: recoveryConversation.projectId,
            worktreeId: recoveryConversation.worktreeId,
            worktreePath: recoveryConversation.worktreePath,
            archived: Boolean(recoveryConversation.archived),
            provider: recoveryConversation.provider,
            providerSessionId: recoveryConversation.providerSessionId,
          } : null,
        });
      }
      if (conversationMatch && request.method === "PATCH") {
        const patch = await readJson(request);
        const conversation = editRetainedData(() => database.updateConversation(conversationMatch[1], patch));
        publish({ type: "conversation.updated", conversationId: conversationMatch[1], payload: conversation });
        return json(response, conversation ? 200 : 404, conversation);
      }
      const conversationMessagesMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      const conversationCountMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/count$/);
      if (conversationCountMatch && request.method === "GET") {
        if (!database.getConversation(conversationCountMatch[1])) throw apiError(404, "Conversation not found");
        return json(response, 200, { total: database.messageCount(conversationCountMatch[1]) });
      }
      if (conversationMessagesMatch && request.method === "GET") {
        if (!database.getConversation(conversationMessagesMatch[1])) throw apiError(404, "Conversation not found");
        const messagePage = database.listMessagePage(conversationMessagesMatch[1], {
          beforeId: url.searchParams.get("before") || undefined,
          afterId: url.searchParams.get("after") || undefined,
          limit: Number(url.searchParams.get("limit") || 200),
        });
        return json(response, 200, { messages: messagePage.messages, messagePage: messagePage.page });
      }
      const messageBodyMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/body$/);
      if (messageBodyMatch && request.method === "GET") {
        if (!database.getConversation(messageBodyMatch[1])) throw apiError(404, "Conversation not found");
        const offsetText = url.searchParams.get("offset") ?? "0";
        if (!/^(0|[1-9][0-9]*)$/.test(offsetText) || !Number.isSafeInteger(Number(offsetText))) throw apiError(400, "Message body offset is invalid");
        let messageId;
        try { messageId = decodeURIComponent(messageBodyMatch[2]); }
        catch { throw apiError(400, "Message id is invalid"); }
        const body = database.getMessageBodyChunk(messageBodyMatch[1], messageId, Number(offsetText));
        return json(response, body ? 200 : 404, body);
      }
      const conversationFindMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/find$/);
      if (conversationFindMatch && request.method === "GET") {
        if (!database.getConversation(conversationFindMatch[1])) throw apiError(404, "Conversation not found");
        const needle = requiredQuery(url, "q").trim();
        if (!needle || needle.length > 200) throw apiError(400, "Search text must be 1 to 200 characters");
        const direction = url.searchParams.get("direction") ?? "next";
        if (!["next", "previous"].includes(direction)) throw apiError(400, "Search direction is invalid");
        const findController = new AbortController();
        const abortFind = () => findController.abort();
        response.once?.("close", abortFind);
        try {
          const originParam = url.searchParams.get("origin");
          const wrappedParam = url.searchParams.get("wrapped");
          const byteOffsetParam = url.searchParams.get("byteOffset");
          const contextOffsetParam = url.searchParams.get("contextOffset");
          const leftContextOffsetParam = url.searchParams.get("leftContextOffset");
          const leftContextCasedParam = url.searchParams.get("leftContextCased");
          if (wrappedParam && (wrappedParam !== "1" || originParam === null)) throw apiError(400, "Search continuation is invalid");
          if (byteOffsetParam !== null && (!/^[1-9][0-9]*$/.test(byteOffsetParam)
            || !Number.isSafeInteger(Number(byteOffsetParam)) || !url.searchParams.get("after") || originParam === null)) {
            throw apiError(400, "Search byte offset is invalid");
          }
          if (contextOffsetParam !== null && (!/^[1-9][0-9]*$/.test(contextOffsetParam)
            || !Number.isSafeInteger(Number(contextOffsetParam)) || !url.searchParams.get("after") || originParam === null)) {
            throw apiError(400, "Search context offset is invalid");
          }
          if (leftContextOffsetParam !== null && (!/^[1-9][0-9]*$/.test(leftContextOffsetParam)
            || !Number.isSafeInteger(Number(leftContextOffsetParam)) || !url.searchParams.get("after") || originParam === null)) {
            throw apiError(400, "Search left context offset is invalid");
          }
          if (leftContextCasedParam !== null && (!["0", "1"].includes(leftContextCasedParam) || contextOffsetParam === null)) {
            throw apiError(400, "Search left context state is invalid");
          }
          const result = await database.findMessagePage(
            conversationFindMatch[1], needle, url.searchParams.get("after"), direction === "previous" ? -1 : 1, findController.signal,
            originParam === null ? undefined : { originId: originParam === "none" ? null : originParam,
              wrapped: wrappedParam === "1", byteOffset: Number(byteOffsetParam ?? 0), contextOffset: Number(contextOffsetParam ?? 0),
              leftContextOffset: Number(leftContextOffsetParam ?? 0), leftContextCased: leftContextCasedParam === null ? null : leftContextCasedParam === "1" },
          );
          if (response.destroyed) return true;
          return json(response, 200, result);
        } finally { response.off?.("close", abortFind); }
      }
      const conversationMoveMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/move$/);
      if (conversationMoveMatch && request.method === "POST") {
        if (!database.getConversation(conversationMoveMatch[1])) throw apiError(404, "Conversation not found");
        const body = await readJson(request);
        const unresolved = database.listUnresolvedInterruptedRuns(conversationMoveMatch[1]);
        if (unresolved.some((run) => !run.worktreePath || run.worktreePath !== body.worktreePath)) {
          throw apiError(409, "Resolve the interrupted run before moving this conversation away from its recovery worktree", { code: "RUN_RECOVERY_REQUIRED" });
        }
        const { worktreePath: destinationPath } = await resolveWorktreeTarget(body);
        const conversation = editRetainedData(() => database.moveConversation(conversationMoveMatch[1],
          { projectId: body.projectId, worktreeId: body.worktreeId, worktreePath: destinationPath }));
        database.audit("conversation.moved", { target: conversation.id, projectId: body.projectId, worktreeId: body.worktreeId, worktreePath: destinationPath });
        publish({ type: "conversation.updated", conversationId: conversation.id, payload: conversation });
        return json(response, 200, conversation);
      }
      const runCreateMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/runs$/);
      if (runCreateMatch && request.method === "POST") {
        const conversation = database.getConversation(runCreateMatch[1]);
        if (!conversation) throw apiError(404, "Conversation not found");
        if (conversation.archived) throw apiError(409, "Archived conversations cannot start agent runs", { code: "CONVERSATION_ARCHIVED" });
        // Recovery ownership is scoped to the worktree, not the chat. Another
        // conversation targeting the same checkout must not start while an
        // interrupted process tree may still mutate it.
        const interrupted = database.findUnresolvedInterruptedRunForWorktree(conversation.worktreePath);
        if (interrupted) throw apiError(409, "Resolve the interrupted run before starting more agent work", { code: "RUN_RECOVERY_REQUIRED", runId: interrupted.id });
        const body = await readJson(request);
        const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) throw apiError(400, "Prompt is required");
        if (Buffer.byteLength(prompt) > 256 * 1024) throw apiError(413, "Prompt must be 256 KiB or smaller");
        const target = await resolveWorktreeTarget({ projectId: conversation.projectId, worktreeId: conversation.worktreeId, worktreePath: conversation.worktreePath });
        if (!database.isProjectTrusted(target.project.id, target.project.path)) throw apiError(403, "Project trust is required", { code: "PROJECT_TRUST_REQUIRED", project: { id: target.project.id, name: target.project.name, path: target.project.path } });
        const settings = database.getSettings();
        const provider = body.provider || conversation.provider || settings.provider;
        if (!await agents.providerAvailable(provider)) throw apiError(409, `${provider} CLI is not available`);
        if (!database.isProjectTrusted(target.project.id, target.project.path)) throw apiError(403, "Project trust is required", { code: "PROJECT_TRUST_REQUIRED", project: { id: target.project.id, name: target.project.name, path: target.project.path } });
        // Archive, move, or recovery can commit during either validation await.
        // Fence both message and run creation to the current durable target.
        const currentConversation = database.getConversation(conversation.id);
        if (!currentConversation || currentConversation.archived) throw apiError(409, "Archived conversations cannot start agent runs", { code: "CONVERSATION_ARCHIVED" });
        if (["projectId", "worktreeId", "worktreePath"].some((key) => currentConversation[key] !== conversation[key])) {
          throw apiError(409, "Conversation target changed while preparing the run", { code: "CONVERSATION_TARGET_CHANGED" });
        }
        const currentInterrupted = database.findUnresolvedInterruptedRunForWorktree(conversation.worktreePath);
        if (currentInterrupted) throw apiError(409, "Resolve the interrupted run before starting more agent work", { code: "RUN_RECOVERY_REQUIRED", runId: currentInterrupted.id });
        const { run, message: userMessage } = database.submitRun({ conversationId: conversation.id, worktreePath: conversation.worktreePath, provider, model: body.model ?? conversation.model ?? settings.model, reasoningEffort: body.reasoningEffort || settings.reasoningEffort, approvalPolicy: body.approvalPolicy || settings.approvalPolicy, prompt }, prompt);
        publish({ type: "message.created", conversationId: conversation.id, payload: userMessage });
        return json(response, 202, await agents.schedule({ conversation: database.getConversation(conversation.id), run }));
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (runMatch && request.method === "GET") {
        const run = database.getRun(runMatch[1]);
        if (!run || !database.getConversation(run.conversationId)) return json(response, 404, { error: "Run not found" });
        return json(response, 200, { ...run, events: database.listRunEvents(run.id, Number(url.searchParams.get("after") ?? 0)) });
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
        if (!["discard", "discard-unverifiable", "resume-session", "retry"].includes(policy)) throw apiError(400, "Recovery policy must be discard, discard-unverifiable, resume-session, or retry");
        const conversation = database.getConversation(interrupted.conversationId);
        if (!conversation) throw apiError(404, "Conversation not found");
        // Replacement requests must not tear down any process on an archived
        // chat's worktree, including a live sibling, merely to return 409.
        // Discard policies still verify and clean the interrupted process.
        if (conversation.archived && ["retry", "resume-session"].includes(policy)) {
          throw apiError(409, "Archived conversations cannot start agent runs", { code: "CONVERSATION_ARCHIVED" });
        }

        // Databases created before durable process ownership can contain a
        // running row with neither pid nor immutable launch worktree. There is
        // no process tree the runtime can verify or signal, so ordinary
        // recovery stays fail-closed. The operator can explicitly acknowledge
        // that legacy uncertainty and discard only that row; no replacement
        // work is scheduled, and any remaining legacy rows keep the global
        // recovery gate closed.
        if (policy === "discard-unverifiable") {
          const legacyUnverifiable = interrupted.recoveryClass === "unknown"
            && !(Number.isSafeInteger(interrupted.pid) && interrupted.pid > 0)
            && !interrupted.worktreePath;
          if (!legacyUnverifiable) throw apiError(409, "Only a legacy run without process or worktree identity can use manual cleanup", { code: "RECOVERY_MANUAL_CLEANUP_UNAVAILABLE", runId: interrupted.id });
          if (body.confirmation !== interrupted.id) throw apiError(400, "Exact run id confirmation is required for unverifiable legacy cleanup", { code: "RECOVERY_CONFIRMATION_REQUIRED", runId: interrupted.id });
          const resolved = database.resolveInterruptedRun(interrupted.id, policy);
          if (!resolved) throw apiError(409, "Run is not waiting for a recovery decision");
          publish({ type: "run.resolved", conversationId: conversation.id, runId: interrupted.id, payload: resolved });
          return json(response, 200, resolved);
        }

        // Every unresolved interrupted run of the worktree is verified before
        // any decision is recorded — not only runs from the selected chat. A
        // sibling conversation can carry a started run while this chat holds a
        // never-started run; recovering either one must not schedule work while
        // the sibling process tree can still mutate the same checkout.
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
        for (const pending of database.listUnresolvedInterruptedRunsForWorktree(interrupted.worktreePath)) {
          // Both classes are durable proofs made during restart reconciliation.
          // Re-probing an exited row later would let an unrelated process that
          // reused the PID turn a settled fact back into an unknown/alive gate.
          if (["never-started", "exited"].includes(pending.recoveryClass)) continue;
          if (!(Number.isSafeInteger(pending.pid) && pending.pid > 0)) {
            throw apiError(409, "An interrupted provider process cannot be verified, so no recovery decision can be recorded yet", { code: "RECOVERY_PROCESS_UNKNOWN", runId: pending.id });
          }
          const handshake = database.getLaunchHandshake(pending.id);
          let verdict = recoveryVerdict(await recoveryProcessAlive(pending.pid, handshake));
          if (verdict === "alive") {
            const processIdentity = await recoveryProcessIdentity(pending.pid, handshake?.ownershipToken, handshake?.platformOwnershipId);
            if (!recoveryIdentityMatches(pending, handshake, processIdentity)) {
              throw apiError(409, "The interrupted provider process identity cannot be verified, so it will not be signaled", { code: "RECOVERY_PROCESS_UNKNOWN", pid: pending.pid, runId: pending.id });
            }
            let terminationProven = false;
            try { terminationProven = await terminateRecoveryProcess(pending.pid, "SIGTERM", handshake) === true; }
            catch { /* Verification below remains fail-closed. */ }
            if (terminationProven) verdict = "exited";
            const started = Date.now();
            const deadline = Date.now() + recoveryTerminationTimeoutMs;
            let escalated = false;
            while (verdict === "alive" && Date.now() < deadline) {
              if (!escalated && Date.now() - started >= recoveryTerminationGraceMs) {
                const currentIdentity = await recoveryProcessIdentity(pending.pid, handshake?.ownershipToken, handshake?.platformOwnershipId);
                if (!recoveryIdentityMatches(pending, handshake, currentIdentity)) {
                  throw apiError(409, "The interrupted provider process identity changed before escalation, so it will not be signaled", { code: "RECOVERY_PROCESS_UNKNOWN", pid: pending.pid, runId: pending.id });
                }
                if (handshake?.providerPid && handshake?.providerProcessIdentity) {
                  const providerIdentity = await recoveryProcessIdentity(handshake.providerPid);
                  if (providerIdentity !== handshake.providerProcessIdentity) {
                    throw apiError(409, "The interrupted provider child identity changed before escalation, so it will not be signaled", { code: "RECOVERY_PROCESS_UNKNOWN", pid: handshake.providerPid, runId: pending.id });
                  }
                }
                try { terminationProven = await terminateRecoveryProcess(pending.pid, "SIGKILL", handshake) === true; }
                catch { /* Verification below remains fail-closed. */ }
                if (terminationProven) verdict = "exited";
                escalated = true;
              }
              if (verdict !== "alive") break;
              await new Promise((resolve) => setTimeout(resolve, 50));
              verdict = recoveryVerdict(await recoveryProcessAlive(pending.pid, handshake));
            }
            if (verdict === "alive") {
              throw apiError(409, "The interrupted provider process did not stop, so no recovery decision was recorded", { code: "RECOVERY_PROCESS_ACTIVE", pid: pending.pid, runId: pending.id });
            }
          }
          if (verdict !== "exited") {
            throw apiError(409, "An interrupted provider process cannot be verified, so no recovery decision can be recorded yet", { code: "RECOVERY_PROCESS_UNKNOWN", pid: pending.pid, runId: pending.id });
          }
          // Persist every proof established by this pass, including sibling
          // conversations. On Windows the Job Object handle disappears after
          // termination, so a later request cannot reconstruct that proof
          // from the leader pid alone. Keep the pid: validation failures must
          // leave the run retryable without discarding its process identity.
          const verified = database.updateRun(pending.id, { recoveryClass: "exited" });
          publish({ type: "run.recovery-updated", conversationId: verified.conversationId, runId: verified.id, payload: verified });
          if (pending.id === interrupted.id) interrupted = verified;
        }

        if (policy === "discard") {
          const resolved = database.resolveInterruptedRun(interrupted.id, policy);
          if (!resolved) throw apiError(409, "Run is not waiting for a recovery decision");
          publish({ type: "run.resolved", conversationId: conversation.id, runId: interrupted.id, payload: resolved });
          return json(response, 200, resolved);
        }

        // A legacy archived chat may discard above, but must never schedule a
        // replacement or consume a retry/resume recovery decision.
        if (database.getConversation(conversation.id)?.archived) {
          throw apiError(409, "Archived conversations cannot start agent runs", { code: "CONVERSATION_ARCHIVED" });
        }

        // Replacement work must respect worktree order across conversations:
        // resuming or retrying a run may not schedule its replacement while an
        // older unresolved run still awaits a decision, or the newer run's
        // side effects could later be overwritten by the older recovery.
        // Discard remains allowed above because it schedules no work.
        const unresolved = database.listUnresolvedInterruptedRunsForWorktree(interrupted.worktreePath);
        const selected = unresolved.findIndex((candidate) => candidate.id === interrupted.id);
        if (selected > 0) {
          throw apiError(409, "Resolve the older interrupted run before resuming or retrying this one", { code: "RECOVERY_ORDER_REQUIRED", runId: unresolved[0].id });
        }

        if (!interrupted.worktreePath) {
          throw apiError(409, "This legacy run has no trustworthy launch worktree; discard it after process verification instead", { code: "RECOVERY_TARGET_UNKNOWN", runId: interrupted.id });
        }
        if (conversation.worktreePath !== interrupted.worktreePath) {
          throw apiError(409, "The conversation target changed after this run started; move it back before resuming or retrying", { code: "RECOVERY_TARGET_CHANGED", runId: interrupted.id, worktreePath: interrupted.worktreePath });
        }

        // Resumed and retried runs revalidate worktree identity and trust at
        // submission, and again inside the agent drain before spawning.
        const target = await resolveWorktreeTarget({ projectId: conversation.projectId, worktreeId: conversation.worktreeId, worktreePath: conversation.worktreePath });
        if (!database.isProjectTrusted(target.project.id, target.project.path)) throw apiError(403, "Project trust is required", { code: "PROJECT_TRUST_REQUIRED", project: { id: target.project.id, name: target.project.name, path: target.project.path } });
        if (!await agents.providerAvailable(interrupted.provider)) throw apiError(409, `${interrupted.provider} CLI is not available`);
        if (!database.isProjectTrusted(target.project.id, target.project.path)) throw apiError(403, "Project trust is required", { code: "PROJECT_TRUST_REQUIRED", project: { id: target.project.id, name: target.project.name, path: target.project.path } });
        // Recovery is bound to the immutable run session first. A mutable
        // conversation session is only a compatible fallback when the
        // conversation still targets the same provider.
        const sessionId = interrupted.providerSessionId
          || (conversation.provider === interrupted.provider ? conversation.providerSessionId : null);
        if (policy === "resume-session" && !sessionId) throw apiError(409, "No provider session is available to resume", { code: "NO_PROVIDER_SESSION" });
        const currentRecoveryConversation = database.getConversation(conversation.id);
        if (!currentRecoveryConversation || currentRecoveryConversation.archived) {
          throw apiError(409, "Archived conversations cannot start agent runs", { code: "CONVERSATION_ARCHIVED" });
        }
        if (["projectId", "worktreeId", "worktreePath"].some((key) => currentRecoveryConversation[key] !== conversation[key])) {
          throw apiError(409, "Conversation target changed while preparing recovery", { code: "RECOVERY_TARGET_CHANGED", runId: interrupted.id });
        }
        const recovery = database.beginInterruptedRunRecovery(interrupted.id, policy, { providerSessionId: sessionId });
        if (!recovery) throw apiError(409, "Run is not waiting for a recovery decision");
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
        database.trustProject(project.id, project.path);
        return json(response, 200, { trusted: true, projectId: project.id });
      }
      if (url.pathname === "/api/trust" && request.method === "DELETE") {
        const body = await readJson(request);
        database.untrustProject(body.projectId);
        agents.resumeQueued();
        return json(response, 200, { trusted: false });
      }

      if (url.pathname === "/api/terminals" && request.method === "GET") return json(response, 200, { terminals: terminals.list() });
      if (url.pathname === "/api/terminals" && request.method === "POST") {
        const body = await readJson(request);
        if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.cwd !== "string" || !body.cwd
          || (body.name !== undefined && (typeof body.name !== "string" || body.name.length > 200))
          || (body.cols !== undefined && (!Number.isInteger(body.cols) || body.cols < 20 || body.cols > 400))
          || (body.rows !== undefined && (!Number.isInteger(body.rows) || body.rows < 5 || body.rows > 200))) {
          throw apiError(400, "Terminal path, name, or dimensions are invalid");
        }
        await projects();
        const cwd = await git.requireWorktree(body.cwd);
        return json(response, 201, await terminals.create({ ...body, cwd }));
      }
      const terminalMatch = url.pathname.match(/^\/api\/terminals\/([^/]+)$/);
      if (terminalMatch && request.method === "GET") { const terminal = terminals.get(terminalMatch[1]); return json(response, terminal ? 200 : 404, terminal ?? { error: "Terminal not found" }); }
      if (terminalMatch && request.method === "DELETE") return json(response, await terminals.close(terminalMatch[1]) ? 204 : 404, null);

      if (url.pathname === "/api/git/status" && request.method === "GET") return json(response, 200, await git.status(requiredQuery(url, "path")));
      if (url.pathname === "/api/git/diff" && request.method === "GET") return json(response, 200, await git.diff(requiredQuery(url, "path"), url.searchParams.get("file"), url.searchParams.get("staged") === "true"));
      if (url.pathname === "/api/git/stage" && request.method === "POST") { const body = await readJson(request); return json(response, 200, await git.stage(body.path, body.files)); }
      if (url.pathname === "/api/git/unstage" && request.method === "POST") { const body = await readJson(request); return json(response, 200, await git.unstage(body.path, body.files)); }
      if (url.pathname === "/api/git/commit" && request.method === "POST") { const body = await readJson(request); return json(response, 200, await git.commit(body.path, body.message)); }
      if (url.pathname === "/api/context" && request.method === "GET") return json(response, 200, await git.context(requiredQuery(url, "path")));
      if (url.pathname === "/api/editor/open" && request.method === "POST") { const body = await readJson(request); return json(response, 200, await git.openInEditor(body.path, body.file, body.editor)); }

      if (url.pathname === "/api/worktrees" && request.method === "POST") { const result = await git.createWorktree(await readJson(request)); return json(response, 201, await refreshProjectsAfterMutation(result)); }
      if (url.pathname === "/api/worktrees" && request.method === "DELETE") { const result = await git.removeWorktree(await readJson(request)); return json(response, 200, await refreshProjectsAfterMutation(result)); }

      if (url.pathname === "/api/templates" && request.method === "GET") return json(response, 200, { templates: database.listTemplates() });
      if (url.pathname === "/api/templates" && request.method === "POST") {
        const input = await readJson(request);
        const template = editRetainedData(() => database.saveTemplate(input));
        return json(response, 201, template);
      }
      const templateMatch = url.pathname.match(/^\/api\/templates\/([^/]+)$/);
      if (templateMatch && request.method === "DELETE") {
        const deleted = database.deleteTemplate(templateMatch[1]);
        if (deleted) agents.resumeQueued();
        return json(response, deleted ? 204 : 404, null);
      }
      if (url.pathname === "/api/search" && request.method === "GET") return json(response, 200, database.search(requiredQuery(url, "q")));
      if (url.pathname === "/api/audit" && request.method === "GET") return json(response, 200, { entries: database.listAudit(Number(url.searchParams.get("limit") ?? 100)) });
      throw apiError(404, "API route not found");
    } catch (error) {
      if (response.destroyed) return true;
      if (["SQLITE_BUSY", "SQLITE_LOCKED"].includes(error?.code)) {
        return json(response, 503, { error: "Storage cleanup is writing; retry shortly" });
      }
      if (error?.message?.includes("OUTRIGHT_RETAINED_LIMIT")) return json(response, 507, { error: "Retained history is full; archive conversations, then delete selected archived chats or clean up older history" });
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
      const shutdownErrors = [];
      const preliminaries = await Promise.allSettled([watcher?.close(), agents.shutdown()]);
      for (const result of preliminaries) if (result.status === "rejected") shutdownErrors.push(result.reason);
      // A failed agent shutdown may be the sole owner of an exited provider's
      // result while both SQLite and its recovery sidecar are unavailable.
      // Keep the database and its exclusive lease alive for its retry timer.
      if (shutdownErrors.length) {
        const error = new AggregateError(shutdownErrors, "Runtime shutdown retains recovery ownership");
        if (agents.hasPendingFinishes()) error.code = "OUTRIGHT_SHUTDOWN_RECOVERY_PENDING";
        throw error;
      }
      await inFlightScan?.catch(() => {});
      await terminalAuditReconciliation;
      try { await terminals.shutdown(); }
      catch (error) { shutdownErrors.push(error); }
      eventHub.shutdown();
      wss.close();
      await database.close();
      resolveShutdownCompletion();
      if (shutdownErrors.length) throw new AggregateError(shutdownErrors, "Runtime shutdown did not finish cleanly");
    })().catch((error) => {
      shutdownPromise = null;
      throw error;
    });
    return shutdownPromise;
  }

  return { attach, handleRequest, projects, publish, database, agents, terminals, git, shutdown,
    whenShutdownComplete: () => shutdownCompletion };
  } catch (error) {
    // No runtime was returned, so neither Vite nor standalone can call its
    // shutdown. Stop startup-owned managers before releasing the physical
    // lease. The constructor is synchronous; no agent or PTY has been admitted.
    const cleanupErrors = [];
    try { eventHub?.shutdown(); } catch (failure) { cleanupErrors.push(failure); }
    try { wss?.close(); } catch (failure) { cleanupErrors.push(failure); }
    try { database.closeFailedStartup(); }
    catch (failure) { cleanupErrors.push(failure); }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "Runtime startup and cleanup failed");
    throw error;
  }
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

const DARWIN_OWNERSHIP_PREFIX = "com.21n.outright.";

function darwinLaunchdTarget(handshake) {
  const ownershipToken = handshake?.ownershipToken;
  const platformOwnershipId = handshake?.platformOwnershipId;
  if (typeof ownershipToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownershipToken)) return null;
  if (platformOwnershipId !== `${DARWIN_OWNERSHIP_PREFIX}${ownershipToken}`) return null;
  const uid = process.getuid?.();
  return Number.isInteger(uid) ? `gui/${uid}/${platformOwnershipId}` : null;
}

export function defaultRecoveryProcessAlive(pid, platform = process.platform, groupMembers = defaultGroupMembers, kill = process.kill, handshake = null, run = spawnSync) {
  let darwinOwnershipUnknown = false;
  if (platform === "darwin") {
    const target = darwinLaunchdTarget(handshake);
    if (target) {
      const result = run(AGENT_SUPERVISOR, ["--probe", handshake.platformOwnershipId], { encoding: "utf8" });
      const verdict = result.stdout?.trim();
      if (["alive", "exited"].includes(verdict)) return verdict;
      if (verdict === "absent") {
        // A unique launchd label can be absent briefly after the authorized
        // wrapper has spawned its supervisor but before launchctl submit has
        // completed. The matching wrapper proves that launch is still in
        // progress, but there is not yet a kernel boundary that recovery can
        // terminate, so keep the run unresolved until the job appears or the
        // wrapper exits. A live mismatched/reused pid also fails closed.
        const wrapperIdentity = defaultRecoveryProcessIdentity(
          pid, platform, readFileSync, run, handshake.ownershipToken, handshake.platformOwnershipId,
        );
        if (wrapperIdentity === handshake.processIdentity) return "unknown";
        // The gated native supervisor is durably identified before it can
        // submit the launchd job. While that exact process is alive it may
        // still submit, so fail closed. Once its boot-scoped identity no
        // longer matches, an absent unique job proves that no launch owner
        // remains, even if the wrapper pid has since been reused.
        const supervisorPid = Number(handshake.providerPid);
        const supervisorIdentity = typeof handshake.providerProcessIdentity === "string"
          ? handshake.providerProcessIdentity
          : null;
        if (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 0 || !supervisorIdentity) return "unknown";
        const liveSupervisorIdentity = defaultRecoveryProviderProcessIdentity(supervisorPid, platform, run);
        if (liveSupervisorIdentity == null) {
          try { kill(supervisorPid, 0); return "unknown"; }
          catch (error) {
            if (error.code !== "ESRCH") return "unknown";
          }
        }
        if (liveSupervisorIdentity === supervisorIdentity) return "unknown";
        // launchctl submit is forked by the supervisor and inherits the
        // wrapper-owned process group. If the supervisor dies while submit is
        // in flight, that child can still create the job, so the whole group
        // must be empty before an absent label is accepted as exited.
        try { kill(-pid, 0); return "unknown"; }
        catch (error) {
          if (error.code !== "ESRCH") return "unknown";
        }
        // The first absent-label sample predates the group probe. Submit may
        // have succeeded immediately before its child exited, so re-read the
        // unique label after the group is empty to form a coherent proof.
        const settled = run(AGENT_SUPERVISOR, ["--probe", handshake.platformOwnershipId], { encoding: "utf8" }).stdout?.trim();
        return settled === "absent" ? "exited" : recoveryVerdict(settled);
      }
      darwinOwnershipUnknown = true;
      // The handshake is written before the platform supervisor submits its
      // launchd job. During that short interval, a live wrapper is still a
      // valid owner; if it is gone too, fail closed as unknown.
    }
  }
  if (platform === "win32") {
    // The spawned tree is not owned on Windows, so a gone leader says nothing
    // about its descendants: only a live leader is verifiable.
    try { kill(pid, 0); return "alive"; }
    catch { return "unknown"; }
  }
  try {
    kill(-pid, 0);
    const members = groupMembers(pid);
    if (members == null) return "alive";
    return members.some((member) => member.state !== "Z") ? "alive" : "exited";
  } catch (error) {
    return error.code === "ESRCH" && !darwinOwnershipUnknown ? "exited" : "unknown";
  }
}

export function defaultRecoveryProviderProcessIdentity(pid, platform = process.platform, run = spawnSync) {
  if (platform !== "darwin") return null;
  try {
    const boot = run("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
    const started = run("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    return boot.status === 0 && started.status === 0 && started.stdout.trim()
      ? `darwin-process:${boot.stdout.trim()}:${started.stdout.trim()}`
      : null;
  } catch { return null; }
}

export function defaultRecoveryProcessIdentity(pid, platform = process.platform, readFile = readFileSync, run = spawnSync, ownershipToken = null, platformOwnershipId = null) {
  try {
    if (platform === "linux") {
      const bootId = readFile("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = readFile(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      const startTicks = stat.slice(close + 2).split(" ")[19];
      return bootId && startTicks ? `linux:${bootId}:${startTicks}` : null;
    }
    if (platform === "darwin") {
      if (typeof ownershipToken !== "string" || !/^[0-9a-f-]{36}$/i.test(ownershipToken)) return null;
      const bootResult = run("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
      const launchdTarget = darwinLaunchdTarget({ ownershipToken, platformOwnershipId });
      if (launchdTarget) {
        const launchdResult = run("/bin/launchctl", ["print", launchdTarget], { encoding: "utf8" });
        const boot = bootResult.status === 0 ? bootResult.stdout.trim() : "";
        if (boot && launchdResult.status === 0) return `darwin:${boot}:${ownershipToken}`;
      }
      const processResult = run("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
      const boot = bootResult.status === 0 ? bootResult.stdout.trim() : "";
      const command = processResult.status === 0 ? processResult.stdout.trim() : "";
      return boot && command === `outright-agent-${ownershipToken}` ? `darwin:${boot}:${ownershipToken}` : null;
    }
    if (platform === "win32") {
      const script = `$boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks;$start=(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks;Write-Output ($boot.ToString() + ':' + $start.ToString())`;
      const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
      const started = result.status === 0 ? result.stdout.trim() : "";
      return started ? `win32:${started}` : null;
    }
  } catch { /* A missing or unreadable process is not identifiable. */ }
  return null;
}

function recoveryIdentityMatches(run, handshake, processIdentity) {
  return handshake?.authorized === true
    && handshake.pid === run.pid
    && typeof handshake.processIdentity === "string"
    && handshake.processIdentity.length > 0
    && handshake.processIdentity === processIdentity;
}

export function defaultTerminateRecoveryProcess(pid, signal = "SIGTERM", handshake = null, platform = process.platform, run = spawnSync, kill = process.kill) {
  if (platform === "win32") {
    const result = run("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    if (result.status !== 0) throw new Error("Unable to terminate the recovered Windows process tree");
    return true;
  }
  if (platform === "linux" && signal === "SIGKILL") {
    const providerPid = Number(handshake?.providerPid);
    if (Number.isSafeInteger(providerPid) && providerPid > 0 && typeof handshake?.providerProcessIdentity === "string") {
      kill(providerPid, "SIGKILL");
      return false;
    }
    throw new Error("A verified provider identity is required for Linux recovery escalation");
  }
  if (platform === "darwin") {
    const target = darwinLaunchdTarget(handshake);
    if (target) {
      const result = run(AGENT_SUPERVISOR, ["--terminate", handshake.platformOwnershipId], { stdio: "ignore" });
      if (result.status !== 0) throw new Error("Unable to terminate the recovered macOS process coalition");
      return true;
    }
  }
  terminateTree({ pid }, signal, platform, run, kill);
  return false;
}

async function canonicalOf(target) {
  try { return await realpath(target); }
  catch { return path.resolve(target); }
}
