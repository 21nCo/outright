import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Archive, ArrowsClockwise, At, Bell, CaretDown, CaretRight, ChatCircle,
  Check, CheckCircle, ClockCounterClockwise, Command, Desktop, DotsThree,
  FolderOpen, FolderPlus, Folders, GearSix, GitBranch, GitDiff, Info,
  Layout, MagnifyingGlass, Moon, PaperPlaneTilt, PencilSimple, PushPin, Plus,
  ShieldCheck, SidebarSimple, Sparkle, Stop, Sun, TerminalWindow, Trash,
  WarningCircle, Wrench, X,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChangesPane } from "@/components/ChangesPane";
import { ESTIMATED_MESSAGE_HEIGHT, WindowedMessages } from "@/components/WindowedMessages";
import { CommandPalette } from "@/components/CommandPalette";
import { ContextPane } from "@/components/ContextPane";
import { SettingsDialog } from "@/components/SettingsDialog";
import { TerminalPane } from "@/components/TerminalPane";
import { LifecycleMark, LifecycleState, TeardownChoices, WorktreeLifecycleDialog } from "@/components/WorktreeLifecycle";
import { PaneLayout, paneId } from "@/components/PaneLayout";
import { domId, nextTabIndex } from "@/lib/accessibility";
import { api, connectRuntime, query } from "@/lib/runtime-api";
import { scheduleLayoutTick } from "@/lib/windowing";
import { foldFindText } from "@/lib/find-text";
import { modelMismatch, providerOptionLabel, providerReady, providerStatusText, providerSwitchProblem } from "@/lib/providers";
import { answerAccountText, runAccountText, withStartedRunAccount } from "@/lib/provider-accounts";
import { bufferConversationRuntimeEvent, checkpointCursors, draftAfterSubmission, isComposerSubmitKey, isStaleCheckpointMessage, messagePrecedesPage, recordCheckpointCursor, recoveryBelongsToConversation, recoveryGate, recoveryNoticeAction, replayConversationEvents, shouldReloadConversationForResolvedRun, streamingTextAfterRuntimeEvent, upsertRuntimeMessage } from "@/recovery-policy";
import { createTerminalCommandFence } from "@/lib/terminal-command-fence";
import { lifecycleFor, mergeLifecycleSnapshot, removalRequest, teardownProblem, upsertLifecycleState } from "@/lib/worktree-lifecycle";
import { PANE_LAYOUT_PRESETS, PANE_STORE_PROBLEMS, applyPreset, defaultPaneLayout, focusView, layoutViews, loadPaneLayout, paneRestoreMessage, savePaneLayout } from "@/lib/pane-layout";

const CHAT_TAB_DRAG_TYPE = "application/x-outright-chat-tab";
const MAX_RENDERED_MESSAGES = 1000;
function moveMessageViewport(viewport, top) {
  if (!viewport) return;
  const previous = viewport.scrollTop;
  viewport.scrollTop = top;
  // Hidden browsers may defer native scroll events. The virtualizer still
  // needs the new position when an explicit page or anchor move commits.
  if (Math.abs(viewport.scrollTop - previous) > 0.5) viewport.dispatchEvent(new Event("scroll"));
}
const ACTIVE_RUN_STATUSES = new Set(["queued", "launching", "running"]);
function activeCursorOwners(conversation) {
  return new Set((conversation?.runs ?? []).filter((run) => ACTIVE_RUN_STATUSES.has(run.status)).map((run) => run.id));
}
const MAX_STREAMING_CHARACTERS = 1024 * 1024;
const MAX_READING_LIVE_PREVIEW_CHARACTERS = 8192;
const MAX_PENDING_RUNTIME_EVENT_BYTES = 2 * 1024 * 1024;
const LIVE_TRUNCATION_MARKER = "\n\n[Live output truncated]";
const LIVE_OMITTED_PREFIX = "[Earlier live output omitted]\n";

function bootstrapFailureOutcome(error, manual) {
  if (manual) return "error";
  if (error.status !== 503) return "error";
  if (error.payload != null && !["ARCHIVE_MAINTENANCE_TRANSIENT", "RUN_RECOVERY_TRANSIENT"].includes(error.payload.code)) return "error";
  return "retry";
}

export function App() {
  const [bootstrap, setBootstrap] = useState(null);
  // Worktree setup and teardown states, merged from bootstrap snapshots and
  // events by revision, so neither hides a newer one; a snapshot older than
  // one already applied is ignored.
  const [lifecycleStates, setLifecycleStates] = useState([]);
  const lifecycleSnapshotRef = useRef(-Infinity);
  const applyLifecycleSnapshot = useCallback((next) => {
    if (!Array.isArray(next?.worktreeLifecycle) || next.worktreeLifecycleRevision < lifecycleSnapshotRef.current) return;
    lifecycleSnapshotRef.current = next.worktreeLifecycleRevision ?? -Infinity;
    setLifecycleStates((current) => mergeLifecycleSnapshot(current, next.worktreeLifecycle, next.worktreeLifecycleRevision));
  }, []);
  const [bootstrapError, setBootstrapError] = useState("");
  const bootstrapLoadRef = useRef(null);
  const [selectedProjectId, setSelectedProjectId] = useState(() => localStorage.getItem("outright.selected-project") || "");
  const [selectedWorktreeId, setSelectedWorktreeId] = useState(() => localStorage.getItem("outright.selected-worktree") || "");
  const [selectedConversationId, setSelectedConversationId] = useState(() => localStorage.getItem("outright.selected-conversation") || "");
  const [conversations, setConversations] = useState([]);
  const [conversation, setConversation] = useState(null);
  const [conversationListFailed, setConversationListFailed] = useState(false);
  const [conversationListPending, setConversationListPending] = useState(true);
  const [conversationLoadFailed, setConversationLoadFailed] = useState(false);
  const [conversationDetailReady, setConversationDetailReady] = useState(false);
  const [expandedSpaces, setExpandedSpaces] = useState({});
  const [expandedProjects, setExpandedProjects] = useState({});
  const [draft, setDraft] = useState("");
  const draftRevisionRef = useRef(0);
  const [unsentCreatedChat, setUnsentCreatedChat] = useState(null);
  const [streamingText, setStreamingText] = useState("");
  const [liveCheckpoint, setLiveCheckpoint] = useState(null);
  const streamingTextRef = useRef("");
  const streamingFlushRef = useRef(null);
  const [runEvents, setRunEvents] = useState([]);
  const [pendingOutcomeRunIds, setPendingOutcomeRunIds] = useState(() => new Set());
  const [findResetGeneration, setFindResetGeneration] = useState(0);
  const [runtimeEvent, setRuntimeEvent] = useState(null);
  // Account changes have their own counter: in the shared runtimeEvent slot
  // a frequent one could replace a terminal chunk before it is written.
  const [accountsVersion, setAccountsVersion] = useState(0);
  // Saved terminal sessions change on the server (restore, eviction, expiry,
  // removal, storage failure). A counter cannot be replaced like the slot.
  const [terminalsVersion, setTerminalsVersion] = useState(0);
  const [unverifiedTerminalIds, setUnverifiedTerminalIds] = useState(() => new Set());
  const [connection, setConnection] = useState("connecting");
  const [isScanning, setIsScanning] = useState(true);
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === "undefined" || !window.matchMedia("(max-width: 760px)").matches);
  // Each worktree restores its own pane arrangement; views keep the selected
  // worktree, so a pane never shows another worktree's terminal or diff.
  const [paneState, setPaneState] = useState(() => ({ owner: "", layout: defaultPaneLayout(), problems: [], dirty: false }));
  const paneLayoutRef = useRef(null);
  const paneSaveWarnedRef = useRef(false);
  const paneStoreWarnedRef = useRef(false);
  const [theme, setTheme] = useState(() => knownTheme(localStorage.getItem("outright.theme")));
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatTitle, setNewChatTitle] = useState("");
  const [newSpaceOpen, setNewSpaceOpen] = useState(false);
  const [newSpaceName, setNewSpaceName] = useState("");
  const [trustRequest, setTrustRequest] = useState(null);
  const [pendingPrompt, setPendingPrompt] = useState(null);
  const [manageChatOpen, setManageChatOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState({ title: "", providerSessionId: "", openedSessionId: "", provider: "codex", model: "", modelChosenFor: "codex", destination: "" });
  const [worktreeDialog, setWorktreeDialog] = useState(null);
  const [worktreeDraft, setWorktreeDraft] = useState({ branch: "", name: "", baseBranch: "HEAD" });
  const [removeWorktreeOpen, setRemoveWorktreeOpen] = useState(false);
  const [removeConfirmation, setRemoveConfirmation] = useState("");
  const [removeState, setRemoveState] = useState({ pending: false, problem: null });
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  // Setup state and output events reach an open setup dialog through this.
  const [lifecycleEvents] = useState(() => new EventTarget());
  // A created worktree is selected once a project refresh discovers it.
  const pendingWorktreeRef = useRef(null);
  const socketRef = useRef(null);
  const terminalCommandFenceRef = useRef(null);
  if (!terminalCommandFenceRef.current) terminalCommandFenceRef.current = createTerminalCommandFence();
  const selectedConversationRef = useRef("");
  const selectedProjectRef = useRef(selectedProjectId);
  const selectedWorktreeRef = useRef(selectedWorktreeId);
  const pendingConversationRef = useRef("");
  const conversationRef = useRef(null);
  const dragConversationRef = useRef("");
  const runtimeHandlerRef = useRef(null);
  const messageViewportRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const readerAwayFromBottomRef = useRef(false);
  const readerScrollInputUntilRef = useRef(0);
  const pendingPrependScrollRef = useRef(null);
  const pendingEarlierRef = useRef(null);
  const pendingLiveScrollRef = useRef(null);
  const pendingLatestScrollRef = useRef(null);
  const restoreMessageAnchorId = useCallback(() => pendingPrependScrollRef.current?.conversationId === selectedConversationRef.current
    ? pendingPrependScrollRef.current.messageId
    : pendingLatestScrollRef.current?.conversationId === selectedConversationRef.current
      ? pendingLatestScrollRef.current.messageId : null, []);
  const livePreviewRunRef = useRef(null);
  const acceptedPreviewRunRef = useRef(null);
  const liveDeltaEventsRef = useRef(emptyLiveDeltaEvents());
  const historyGenerationRef = useRef(0);
  const messageCountRefreshRef = useRef({ generation: 0, timer: null, conversationId: null, inFlight: false });
  useEffect(() => () => {
    window.clearTimeout(messageCountRefreshRef.current.timer);
    messageCountRefreshRef.current = { generation: messageCountRefreshRef.current.generation + 1, timer: null, conversationId: null, inFlight: false };
  }, []);
  const pendingFindRef = useRef(null);
  const activeFindMatchRef = useRef(null);
  const boundVisibleMessage = useCallback((message) => {
    const match = activeFindMatchRef.current;
    return boundPageMessage(message, match?.conversationId === selectedConversationRef.current && match.messageId === message.id
      ? match.needle : "");
  }, []);
  const findProgressRef = useRef(null);
  const sidebarRef = useRef(null);
  const sidebarFocusIntentRef = useRef(null);
  const sidebarFocusOwnerRef = useRef(null);
  const sidebarFocusSourceRef = useRef(null);
  const sidebarFocusLastElementRef = useRef(null);
  const submissionPendingRef = useRef(false);
  const checkpointCursorsRef = useRef(new Map());
  const pendingConversationLoadRef = useRef(null);
  const readyConversationRef = useRef(null);
  const conversationListRequestRef = useRef(0);
  const conversationListPendingRef = useRef(true);
  const pendingListDetailRefreshRef = useRef(null);
  const trustGrantedRef = useRef(false);
  const conversationOwnerRef = useRef("");
  const conversationsRef = useRef([]);
  const archiveFocusRef = useRef(null);
  const settingsRefreshRef = useRef(0);
  const settingsVersionRef = useRef(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const applyStreamingText = useCallback((change, immediate = false) => {
    streamingTextRef.current = change(streamingTextRef.current);
    if (immediate) {
      streamingFlushRef.current?.();
      streamingFlushRef.current = null;
      setStreamingText(streamingTextRef.current);
    } else if (!streamingFlushRef.current) {
      // Stream paints have their own cadence. Layout ticks can run immediately
      // through MessageChannel in a hidden tab, turning each delta into a paint.
      const timer = window.setTimeout(() => {
        streamingFlushRef.current = null;
        setStreamingText(streamingTextRef.current);
      }, 32);
      streamingFlushRef.current = () => window.clearTimeout(timer);
    }
  }, []);
  useEffect(() => () => streamingFlushRef.current?.(), []);

  function stageConversations(next) {
    conversationsRef.current = next;
    setConversations(next);
  }

  function editDraft(next) {
    draftRevisionRef.current += 1;
    setDraft(next);
  }

  function selectConversation(nextId) {
    if (nextId === selectedConversationRef.current) return;
    // Selection owns the visible detail and submission target.
    selectedConversationRef.current = nextId;
    conversationRef.current = null;
    pendingConversationLoadRef.current?.controller?.abort();
    pendingConversationLoadRef.current = null;
    pendingFindRef.current?.abort();
    pendingFindRef.current = null;
    activeFindMatchRef.current = null;
    findProgressRef.current = null;
    pendingEarlierRef.current = null;
    pendingPrependScrollRef.current = null;
    pendingLiveScrollRef.current = null;
    pendingLatestScrollRef.current = null;
    pendingListDetailRefreshRef.current = null;
    window.clearTimeout(messageCountRefreshRef.current.timer);
    messageCountRefreshRef.current = { generation: messageCountRefreshRef.current.generation + 1, timer: null, conversationId: null, inFlight: false };
    ++historyGenerationRef.current;
    readyConversationRef.current = null;
    stickToBottomRef.current = true;
    readerAwayFromBottomRef.current = false;
    readerScrollInputUntilRef.current = 0;
    checkpointCursorsRef.current.clear();
    setConversation(null);
    setConversationDetailReady(false);
    setConversationLoadFailed(false);
    setLoadingEarlier(false);
    setFindResetGeneration((current) => current + 1);
    applyStreamingText(() => "", true);
    setLiveCheckpoint(null);
    livePreviewRunRef.current = null;
    acceptedPreviewRunRef.current = null;
    liveDeltaEventsRef.current = emptyLiveDeltaEvents();
    setRunEvents([]);
    setSelectedConversationId(nextId);
  }

  const loadBootstrap = useCallback(async (manual = false, isCurrent = () => true) => {
    setIsScanning(true);
    try {
      const next = manual ? await api("/api/projects", { method: "POST" }) : await api("/api/bootstrap");
      if (!isCurrent()) return false;
      if (manual) setBootstrap((current) => ({ ...current, ...next }));
      else setBootstrap(next);
      applyLifecycleSnapshot(next);
      if (!manual) setBootstrapError("");
      if (manual) setToast(`Found ${next.projects.length} Git projects`);
      return true;
    } catch (nextError) {
      if (!isCurrent()) return false;
      if (manual) setError(nextError.message);
      const outcome = bootstrapFailureOutcome(nextError, manual);
      if (!manual && outcome !== "retry") setBootstrapError(nextError.message);
      return outcome;
    }
    finally { if (isCurrent()) setIsScanning(false); }
  }, [applyLifecycleSnapshot]);

  useEffect(() => {
    let stopped = false;
    let retry;
    let bootstrapRetries = 0;
    const load = async (remaining = null) => {
      const loaded = await loadBootstrap(false, () => !stopped && bootstrapLoadRef.current === load);
      if (stopped) return loaded;
      if (remaining === null && loaded === "retry" && ++bootstrapRetries > 12) {
        setBootstrapError("Local runtime is still unavailable. Retry when recovery completes.");
        return "error";
      }
      if (remaining === null && loaded === true) bootstrapRetries = 0;
      if (remaining === null ? loaded === "retry" : loaded !== true && remaining > 0) {
        window.clearTimeout(retry);
        retry = window.setTimeout(() => { void load(remaining === null ? null : remaining - 1); }, 1000);
      }
      return loaded;
    };
    load.reset = () => { bootstrapRetries = 0; window.clearTimeout(retry); };
    bootstrapLoadRef.current = load;
    void load();
    return () => { stopped = true; bootstrapLoadRef.current = null; window.clearTimeout(retry); };
  }, [loadBootstrap]);
  const providersChecking = Boolean(bootstrap?.providers?.some((provider) => provider.checking));
  useEffect(() => {
    if (!providersChecking) return;
    let active = true;
    let pending = false;
    const refreshProviders = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await api("/api/providers");
        if (active) setBootstrap((current) => current ? { ...current, providers: next.providers } : current);
      } catch { /* A later poll or runtime event can still resolve discovery. */ }
      finally { pending = false; }
    };
    refreshProviders();
    const timer = window.setInterval(refreshProviders, 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [providersChecking]);
  useEffect(() => {
    if (!bootstrap?.projects.length) return;
    const project = bootstrap.projects.find((item) => item.id === selectedProjectId) ?? bootstrap.projects.find((item) => item.name === "superfunctions") ?? bootstrap.projects[0];
    const worktree = project.worktrees.find((item) => item.id === selectedWorktreeId) ?? preferredWorktree(project);
    setSelectedProjectId(project.id); setSelectedWorktreeId(worktree.id);
    setExpandedProjects((current) => ({ ...current, [project.id]: true }));
  }, [bootstrap?.projects, selectedProjectId, selectedWorktreeId]);

  const project = bootstrap?.projects.find((item) => item.id === selectedProjectId);
  const worktree = project?.worktrees.find((item) => item.id === selectedWorktreeId);
  const worktreeLifecycle = lifecycleFor(lifecycleStates, project, worktree);
  useEffect(() => {
    const pending = pendingWorktreeRef.current;
    const createdProject = pending && bootstrap?.projects.find((item) => item.id === pending.projectId);
    const created = createdProject?.worktrees.find((item) => item.path === pending.path);
    if (!created) return;
    pendingWorktreeRef.current = null;
    chooseProject(createdProject, created);
    if (pending.openSetup) setLifecycleOpen(true);
    // chooseProject reads refs; only a newly discovered worktree matters here.
  }, [bootstrap?.projects]);
  // A worktree id is a lossy slug of its path, so distinct worktrees can share
  // one. Layouts belong to the path; entries saved under an id never match a
  // path and age out of the bounded store.
  if (worktree && paneState.owner !== worktree.path) {
    const restored = loadPaneLayout(localStorage, worktree.path);
    setPaneState({ owner: worktree.path, layout: restored.layout, problems: restored.problems, dirty: false });
  }
  const changePaneLayout = useCallback((next) => {
    setPaneState((current) => current.layout === next ? current : { ...current, layout: next, problems: [], dirty: true });
  }, []);
  // Choosing a chat focuses its conversation pane, which brings it to the front
  // when panes are shown one at a time.
  const revealConversationPane = useCallback(() => {
    setPaneState((current) => {
      const next = focusView(current.layout, "conversation");
      return next === current.layout ? current : { ...current, layout: next, problems: [], dirty: true };
    });
  }, []);
  useEffect(() => {
    if (!paneState.dirty || !paneState.owner) return;
    if (!savePaneLayout(localStorage, paneState.owner, paneState.layout) && !paneSaveWarnedRef.current) {
      paneSaveWarnedRef.current = true;
      setError("Pane layout changes could not be saved in this browser; they will reset when Outright reloads.");
    }
  }, [paneState]);
  // Saved layouts that cannot be read at all are announced once, not again
  // for each worktree that falls back to the default.
  useEffect(() => {
    const message = paneRestoreMessage(paneState.problems);
    if (!message) return;
    if (paneState.problems.some((problem) => PANE_STORE_PROBLEMS.includes(problem))) {
      if (paneStoreWarnedRef.current) return;
      paneStoreWarnedRef.current = true;
    }
    setToast(message);
  }, [paneState.problems]);
  const spaces = useMemo(() => spaceState(bootstrap?.spaces, bootstrap?.projectGroups), [bootstrap?.spaces, bootstrap?.projectGroups]);
  const spaceProjects = useMemo(() => buildSpaceProjects(bootstrap?.projects ?? [], spaces), [bootstrap?.projects, spaces]);
  const settings = bootstrap?.settings ?? defaultSettings();
  const providers = bootstrap?.providers ?? [];
  const templates = bootstrap?.templates ?? [];
  const handleError = useCallback((nextError) => setError(nextError.message), []);

  const loadConversations = useCallback(async (preferredId) => {
    if (!project || !worktree) return;
    const forProjectId = project.id;
    const forWorktreeId = worktree.id;
    // A stale callback must not advance the shared generation or clear the
    // current worktree's list-error state before its own owner is checked.
    if (selectedProjectRef.current !== forProjectId || selectedWorktreeRef.current !== forWorktreeId) return;
    const request = ++conversationListRequestRef.current;
    // A list refresh may change the selected chat or its execution metadata.
    // Fence submission synchronously, before React renders the pending state.
    conversationListPendingRef.current = true;
    setConversationListPending(true);
    pendingConversationLoadRef.current?.controller?.abort();
    pendingConversationLoadRef.current = null;
    setConversationListFailed(false);
    try {
      const result = await api(query("/api/conversations", { projectId: forProjectId, worktreeId: forWorktreeId }));
      // A slower response from a previous selection must not overwrite the
      // conversations of the worktree the user has since switched to.
      if (request !== conversationListRequestRef.current || selectedProjectRef.current !== forProjectId || selectedWorktreeRef.current !== forWorktreeId) return;
      const available = result.conversations.filter((item) => !item.archived);
      stageConversations(available);
      const requested = pendingConversationRef.current;
      const wanted = preferredId || requested || selectedConversationRef.current;
      const selected = available.find((item) => item.id === wanted) ?? available[0];
      conversationListPendingRef.current = false;
      setConversationListPending(false);
      pendingConversationRef.current = "";
      // A chat the user chose outside the tabs (new chat, command palette,
      // recovery, a moved or created chat) is shown even when another pane is
      // in front. Runtime list refreshes never take the front.
      if (requested && selected?.id === requested) revealConversationPane();
      const changedSelection = selectedConversationRef.current !== (selected?.id ?? "");
      if (changedSelection) selectConversation(selected?.id ?? "");
      if (!changedSelection && selected && readyConversationRef.current?.id === selected.id) {
        readyConversationRef.current = { ...readyConversationRef.current, ...selected };
        pendingListDetailRefreshRef.current = selected.id;
        setConversationDetailReady(false);
      } else if (!changedSelection) {
        pendingListDetailRefreshRef.current = null;
        readyConversationRef.current = null;
        setConversationDetailReady(false);
      }
      if (!changedSelection) setConversation((current) => current?.id === selected?.id ? current : null);
      return selected ?? null;
    } catch (nextError) {
      if (request === conversationListRequestRef.current && selectedProjectRef.current === forProjectId && selectedWorktreeRef.current === forWorktreeId) {
        conversationListPendingRef.current = false;
        setConversationListPending(false);
        setConversationListFailed(true);
        setError(nextError.message);
        return { listFailed: true };
      }
    }
  }, [project?.id, worktree?.id]);

  function resetConversationContext() {
    window.clearTimeout(messageCountRefreshRef.current.timer);
    messageCountRefreshRef.current = { generation: messageCountRefreshRef.current.generation + 1, timer: null, conversationId: null, inFlight: false };
    pendingFindRef.current?.abort();
    pendingFindRef.current = null;
    activeFindMatchRef.current = null;
    pendingLiveScrollRef.current = null;
    pendingLatestScrollRef.current = null;
    pendingEarlierRef.current = null;
    pendingPrependScrollRef.current = null;
    ++historyGenerationRef.current;
    setLoadingEarlier(false);
    ++conversationListRequestRef.current;
    pendingConversationLoadRef.current?.controller?.abort();
    pendingConversationLoadRef.current = null;
    readyConversationRef.current = null;
    pendingListDetailRefreshRef.current = null;
    conversationListPendingRef.current = true;
    setConversationListPending(true);
    setConversationDetailReady(false);
    selectedConversationRef.current = "";
    stageConversations([]); setConversation(null); setSelectedConversationId("");
    setConversationListFailed(false); setConversationLoadFailed(false);
    applyStreamingText(() => "", true); setRunEvents([]); checkpointCursorsRef.current.clear();
    setLiveCheckpoint(null);
    livePreviewRunRef.current = null;
    acceptedPreviewRunRef.current = null;
    liveDeltaEventsRef.current = emptyLiveDeltaEvents();
  }
  useEffect(() => { loadConversations(); }, [project?.id, worktree?.id, loadConversations]);
  useLayoutEffect(() => { selectedConversationRef.current = selectedConversationId; }, [selectedConversationId]);
  useLayoutEffect(() => { conversationRef.current = conversation; }, [conversation]);
  useLayoutEffect(() => { selectedProjectRef.current = selectedProjectId; }, [selectedProjectId]);
  useLayoutEffect(() => { selectedWorktreeRef.current = selectedWorktreeId; }, [selectedWorktreeId]);
  useLayoutEffect(() => {
    if (!project || !worktree) return;
    const owner = `${project.id}::${worktree.id}`;
    if (conversationOwnerRef.current && conversationOwnerRef.current !== owner) resetConversationContext();
    conversationOwnerRef.current = owner;
  }, [project?.id, worktree?.id]);
  useEffect(() => { if (selectedProjectId) localStorage.setItem("outright.selected-project", selectedProjectId); }, [selectedProjectId]);
  useEffect(() => { if (selectedWorktreeId) localStorage.setItem("outright.selected-worktree", selectedWorktreeId); }, [selectedWorktreeId]);
  useEffect(() => { if (selectedConversationId) localStorage.setItem("outright.selected-conversation", selectedConversationId); }, [selectedConversationId]);
  const refreshMessageCount = useCallback(() => {
    const state = messageCountRefreshRef.current;
    state.generation += 1;
    state.conversationId = selectedConversationRef.current;
    if (state.timer || state.inFlight) return;
    state.timer = window.setTimeout(async () => {
      state.timer = null;
      const requestedId = state.conversationId;
      const generation = state.generation;
      state.inFlight = true;
      try {
        const result = await api(`/api/conversations/${requestedId}/messages/count`);
        if (!Number.isSafeInteger(result?.total) || result.total < 0) return;
        if (selectedConversationRef.current !== requestedId || generation !== state.generation) return;
        setConversation((current) => {
          if (current?.id !== requestedId || !current.messagePage) return current;
          const newerCount = Math.max(0, result.total - (current.messagePage.olderCount ?? 0) - current.messages.length);
          return { ...current, messagePage: { ...current.messagePage, total: result.total, newerCount, hasLater: newerCount > 0 } };
        });
      } catch { /* The next live event or explicit page load will retry. */ }
      finally {
        state.inFlight = false;
        if (messageCountRefreshRef.current === state && generation !== state.generation) refreshMessageCount();
      }
    }, 100);
  }, []);
  const loadConversation = useCallback(async (options = {}) => {
    // An old render can dispatch a deferred reload after selection changed but
    // before React committed the new callback. It must never claim the slot.
    if (selectedConversationId !== selectedConversationRef.current) return;
    const preservePage = options.preservePage === true;
    // A background completion must not cancel an explicit Return to latest or
    // retry that is already loading the reader's chosen page.
    if (preservePage && pendingConversationLoadRef.current && !pendingConversationLoadRef.current.preservePage) return;
    if (!preservePage) {
      pendingFindRef.current?.abort();
      pendingFindRef.current = null;
      activeFindMatchRef.current = null;
      findProgressRef.current = null;
      ++historyGenerationRef.current;
      pendingPrependScrollRef.current = null;
      pendingEarlierRef.current = null;
      pendingLiveScrollRef.current = null;
      pendingLatestScrollRef.current = null;
      setLoadingEarlier(false);
    }
    const startedHistoryGeneration = historyGenerationRef.current;
    if (readyConversationRef.current?.id !== selectedConversationId) readyConversationRef.current = null;
    setConversationDetailReady(false);
    setConversationLoadFailed(false);
    if (conversationListPendingRef.current || conversationListFailed) return;
    if (!selectedConversationId || !conversationsRef.current.some((item) => item.id === selectedConversationId)) {
      pendingConversationLoadRef.current?.controller?.abort();
      pendingConversationLoadRef.current = null;
      setConversation(null);
      return;
    }
    const requestedId = selectedConversationId;
    // A metadata read that starts while Find is pending must keep that page
    // intent even if the search resolves before this detail response does.
    // The detail still refreshes run/recovery state, but never resets Find.
    const preservePendingFind = preservePage && pendingFindRef.current?.conversationId === requestedId;
    pendingConversationLoadRef.current?.controller?.abort();
    const controller = new AbortController();
    // Carry already received, uncheckpointed deltas across a metadata read.
    // The request buffer alone only sees events that arrive after this point.
    const retained = conversationRef.current?.id === requestedId ? liveDeltaEventsRef.current : null;
    const pendingLoad = { conversationId: requestedId, preservePage, acceptedRunId: acceptedPreviewRunRef.current,
      liveRunId: livePreviewRunRef.current, omittedThroughSeq: retained?.omittedThroughSeq ?? 0,
      events: retained ? retained.events.slice(retained.start) : [],
      eventBytes: retained?.bytes ?? 0, overflowed: false, controller };
    pendingConversationLoadRef.current = pendingLoad;
    setConversation((current) => current?.id === requestedId && !current.archived ? current : null);
    try {
      const nextConversation = await api(`/api/conversations/${requestedId}`, { signal: controller.signal });
      // Stale responses from an earlier selection are discarded before they
      // can associate the composer or execution state with the wrong worktree.
      if (selectedConversationRef.current !== requestedId || !conversationsRef.current.some((item) => item.id === requestedId)) return;
      if (nextConversation.projectId !== selectedProjectRef.current || nextConversation.worktreeId !== selectedWorktreeRef.current) return;
      if (pendingConversationLoadRef.current !== pendingLoad || conversationListPendingRef.current || conversationListFailed) return;
      if (startedHistoryGeneration !== historyGenerationRef.current && !preservePage) {
        pendingConversationLoadRef.current = null;
        if (readyConversationRef.current?.id === requestedId) setConversationDetailReady(true);
        return;
      }
      if (nextConversation.archived) {
        removeArchivedChat(nextConversation);
        loadConversations();
        return;
      }
      pendingConversationLoadRef.current = null;
      // A launch reported while this snapshot was read names its account.
      for (const event of pendingLoad.events) {
        if (event.type === "run.event" && event.payload?.type === "run.started") nextConversation.runs = withStartedRunAccount(nextConversation.runs, event.runId, event.payload.payload?.account);
      }
      setPendingOutcomeRunIds((current) => {
        const settled = (nextConversation.runs ?? []).filter((run) => !ACTIVE_RUN_STATUSES.has(run.status) && current.has(run.id));
        if (!settled.length) return current;
        const next = new Set(current);
        for (const run of settled) next.delete(run.id);
        return next;
      });
      const activeRunIds = activeCursorOwners(nextConversation);
      const acceptedRunId = acceptedPreviewRunRef.current;
      const serverRunId = [...activeRunIds][0] ?? null;
      // A server snapshot is authoritative once it has a different active run.
      // A request started before POST may still return an older snapshot, so
      // keep the locally accepted run while that submission is in flight.
      const newlyAcceptedRun = acceptedRunId && acceptedRunId !== pendingLoad.acceptedRunId ? acceptedRunId : null;
      const pendingSubmissionRun = submissionPendingRef.current && livePreviewRunRef.current !== pendingLoad.liveRunId
        ? livePreviewRunRef.current : null;
      const previewRunId = newlyAcceptedRun ?? pendingSubmissionRun ?? serverRunId;
      if (acceptedRunId && acceptedRunId !== previewRunId) acceptedPreviewRunRef.current = null;
      const changedPreviewRun = previewRunId && livePreviewRunRef.current !== previewRunId;
      if (changedPreviewRun) {
        livePreviewRunRef.current = previewRunId;
        liveDeltaEventsRef.current = emptyLiveDeltaEvents(previewRunId);
        setLiveCheckpoint(null);
        applyStreamingText(() => "", true);
        setRunEvents([]);
      }
      const replayEvents = pendingLoad.events.filter((event) => event.type === "message.created"
        || (event.type === "run.event" && event.runId === previewRunId));
      const previewRunIds = previewRunId ? new Set([...activeRunIds, previewRunId]) : activeRunIds;
      const replayed = replayConversationEvents(nextConversation.messages, replayEvents, MAX_RENDERED_MESSAGES,
        previewRunIds, conversationRef.current?.id === requestedId ? checkpointCursorsRef.current : new Map(),
        nextConversation.messagePage);
      const replayCursor = replayed.cursors.get(previewRunId) ?? 0;
      const retainedDeltas = replayEvents.filter((event) => event.type === "run.event" && event.payload?.type === "assistant.delta"
        && (!Number.isSafeInteger(event.payload.seq) || event.payload.seq > replayCursor));
      const omittedThroughSeq = pendingLoad.omittedThroughSeq > replayCursor ? pendingLoad.omittedThroughSeq : 0;
      liveDeltaEventsRef.current = boundedLiveDeltaEvents(previewRunId, retainedDeltas, omittedThroughSeq);
      const latestActiveCheckpoint = [...replayed.messages].reverse().find((message) =>
        message.role === "assistant" && message.payload?.runId === previewRunId);
      if (latestActiveCheckpoint) setLiveCheckpoint((current) => {
        const candidate = readingLiveCheckpoint(latestActiveCheckpoint);
        if (previewRunId !== candidate.runId) return current;
        return current?.runId === candidate.runId && current.seq > candidate.seq ? current : candidate;
      });
      else if (!preservePage) {
        setLiveCheckpoint(null);
        // The active run can have deltas before its first durable checkpoint.
        // Keep its owner across a latest-page reload so the next delta extends
        // the replayed suffix instead of starting a new preview.
        if (!previewRunId) livePreviewRunRef.current = null;
      }
      const preserveReading = preservePage && (preservePendingFind || pendingFindRef.current?.conversationId === requestedId
        || conversationRef.current?.messagePage?.hasLater || readerAwayFromBottomRef.current || !stickToBottomRef.current
        || startedHistoryGeneration !== historyGenerationRef.current);
      readyConversationRef.current = nextConversation;
      setConversationDetailReady(true);
      if (!preserveReading) {
        stickToBottomRef.current = true;
        readerAwayFromBottomRef.current = false;
        readerScrollInputUntilRef.current = 0;
      }
      checkpointCursorsRef.current = checkpointCursors(replayed.messages, checkpointCursorsRef.current, activeCursorOwners(nextConversation));
      if (options.returnToLatest && !preserveReading && replayed.messages.length) {
        pendingLatestScrollRef.current = { conversationId: requestedId, generation: startedHistoryGeneration,
          messageId: replayed.messages.at(-1).id };
      }
      setConversation((current) => preserveReading && current?.id === requestedId ? (() => {
        const currentTotal = current.messagePage?.total ?? current.messages.length;
        const latestTotal = Math.max(nextConversation.messagePage?.total ?? nextConversation.messages.length,
          (nextConversation.messagePage?.olderCount ?? 0) + replayed.messages.length + replayed.dropped);
        const latestById = new Map(replayed.messages.map((message) => [message.id, message]));
        const messages = current.messages.map((message) => {
          const refreshed = latestById.get(message.id);
          if (!refreshed) return message;
          const oldSeq = message.payload?.checkpointEventSeq;
          const newSeq = refreshed.payload?.checkpointEventSeq;
          return Number.isSafeInteger(oldSeq) && Number.isSafeInteger(newSeq) && oldSeq > newSeq ? message : boundVisibleMessage(refreshed);
        });
        const total = Math.max(currentTotal, latestTotal);
        const newerCount = Math.max(0, total - (current.messagePage?.olderCount ?? 0) - messages.length);
        const hasLater = newerCount > 0;
        return {
          ...nextConversation,
          messages,
          messagePage: { ...current.messagePage, total, hasLater, newerCount },
        };
      })() : {
        ...nextConversation,
        messages: replayed.messages.map((message) => boundVisibleMessage(message)),
        messagePage: {
          ...nextConversation.messagePage,
          total: Math.max(nextConversation.messagePage?.total ?? nextConversation.messages.length,
            (nextConversation.messagePage?.olderCount ?? 0) + replayed.messages.length + replayed.dropped),
          hasMore: Boolean(nextConversation.messagePage?.hasMore || replayed.dropped),
          olderCount: (nextConversation.messagePage?.olderCount ?? 0) + replayed.dropped,
          beforeId: replayed.messages[0]?.id ?? null,
        },
      });
      refreshMessageCount();
      if (!preserveReading) setFindResetGeneration((current) => current + 1);
      if (previewRunId) applyStreamingText(() => boundStreamingText(`${liveDeltaEventsRef.current.omittedThroughSeq
        ? LIVE_OMITTED_PREFIX : ""}${replayed.streamingText}`), true);
      else if (!preserveReading) applyStreamingText(() => "", true);
      setRunEvents(replayed.runEvents);
      if (!preserveReading) scheduleLayoutTick(() => {
        const viewport = messageViewportRef.current;
        if (viewport && selectedConversationRef.current === requestedId && stickToBottomRef.current) moveMessageViewport(viewport, viewport.scrollHeight);
      });
    }
    catch (nextError) {
      if (pendingConversationLoadRef.current === pendingLoad) {
        pendingConversationLoadRef.current = null;
        if (nextError.name !== "AbortError") { setConversationLoadFailed(true); setError(nextError.message); }
      }
    }
    finally {
      if (pendingConversationLoadRef.current === pendingLoad) pendingConversationLoadRef.current = null;
    }
  }, [selectedConversationId, loadConversations, conversationListFailed, refreshMessageCount]);
  useEffect(() => {
    const refreshDetail = pendingListDetailRefreshRef.current === selectedConversationId;
    if (!conversationListPending && !conversationLoadFailed && selectedConversationId && !conversationDetailReady
      && (refreshDetail || readyConversationRef.current?.id !== selectedConversationId) && !pendingConversationLoadRef.current) {
      pendingListDetailRefreshRef.current = null;
      loadConversation({ preservePage: conversationRef.current?.id === selectedConversationId });
    }
  }, [loadConversation, conversationListPending, conversationLoadFailed, conversationDetailReady, selectedConversationId]);
  const selectedRecoveryRunId = recoveryGate(conversation)?.id ?? null;

  const handleRuntimeEvent = useCallback((event) => {
    if (terminalCommandFenceRef.current.observe(event)) {
      setUnverifiedTerminalIds(terminalCommandFenceRef.current.snapshot());
    }
    if (event.type === "run.outcome_pending" && typeof event.runId === "string") {
      setPendingOutcomeRunIds((current) => {
        const next = new Set(current);
        next.delete(event.runId);
        next.add(event.runId);
        if (next.size > 8) next.delete(next.values().next().value);
        return next;
      });
    }
    // A terminal event starts the durable detail refresh below. Keep the
    // pending reservation until that snapshot shows the terminal run; clearing
    // it here briefly announces the stale running state again.
    if (event.type === "provider-accounts.changed") setAccountsVersion((version) => version + 1);
    if (["terminals.changed", "terminal.history"].includes(event.type)) setTerminalsVersion((version) => version + 1);
    if (["projects.changed", "terminal.output", "terminal.exit", "terminal.audit-failed", "runtime.connected", "capacity.changed"].includes(event.type)
      || (event.type === "run.event" && ["run.completed", "run.failed", "run.stopped"].includes(event.payload?.type))) setRuntimeEvent(event);
    const pendingLoad = pendingConversationLoadRef.current;
    if (["message.created", "run.event"].includes(event.type)
      && bufferConversationRuntimeEvent(pendingLoad, event, MAX_PENDING_RUNTIME_EVENT_BYTES) === "overflow") {
      // Discard the stale response and immediately request a newer bounded
      // snapshot. Clearing first ensures subsequent events cannot grow the
      // overflowing buffer while the microtask schedules its replacement.
      pendingLoad.controller.abort();
      if (pendingConversationLoadRef.current === pendingLoad) pendingConversationLoadRef.current = null;
      queueMicrotask(() => loadConversation({ preservePage: pendingLoad.preservePage }));
    }
    const pendingFind = pendingFindRef.current;
    if (["message.created", "run.event"].includes(event.type)
      && bufferConversationRuntimeEvent(pendingFind, event, MAX_PENDING_RUNTIME_EVENT_BYTES) === "overflow") {
      pendingFind.abort();
      if (pendingFindRef.current === pendingFind) pendingFindRef.current = null;
      setError("Find interrupted by new output; retry");
    }
    if (event.type === "projects.changed") {
      const payload = event.payload.projects ? event.payload : { projects: event.payload };
      setBootstrap((current) => current ? { ...current, ...payload } : current);
    }
    if (event.type === "providers.changed") setBootstrap((current) => current ? { ...current, providers: event.payload.providers } : current);
    if (event.type === "worktree.lifecycle" && event.payload?.worktreePath) {
      setLifecycleStates((current) => upsertLifecycleState(current, event.payload, lifecycleSnapshotRef.current));
      lifecycleEvents.dispatchEvent(new CustomEvent("state", { detail: event.payload }));
    }
    if (event.type === "worktree.lifecycle.output" && event.payload) lifecycleEvents.dispatchEvent(new CustomEvent("output", { detail: event.payload }));
    // Output is never replayed, and a restarted runtime reports an
    // interrupted run without an event: an open setup dialog reloads.
    if (event.type === "runtime.connected") lifecycleEvents.dispatchEvent(new CustomEvent("reconnect"));
    if (event.type === "runtime.connected" && event.payload?.restarted) {
      // Another runtime's states and revisions do not compare with this one's.
      lifecycleSnapshotRef.current = -Infinity;
      setLifecycleStates([]);
    }
    if (event.type === "runtime.connected" && (event.payload?.replay?.missed || event.payload?.restarted)) {
      loadBootstrap();
      loadConversation({ preservePage: true });
    }
    if (event.type === "conversation.created" || event.type === "conversation.updated") loadConversations(event.conversationId);
    if (shouldReloadConversationForResolvedRun(event, selectedConversationRef.current, selectedRecoveryRunId)) loadConversation({ preservePage: true });
    if (event.type === "message.created" && event.conversationId === selectedConversationRef.current) {
      if (isStaleCheckpointMessage(checkpointCursorsRef.current, event.payload)) return;
      const displayed = conversationRef.current;
      const olderThanPage = displayed?.messagePage?.hasMore && displayed.messages.length
        && messagePrecedesPage(event.payload, displayed.messages[0]);
      const viewport = messageViewportRef.current;
      const atLatestBottom = !readerAwayFromBottomRef.current && !displayed?.messagePage?.hasLater && viewport
        && viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 96;
      if (atLatestBottom && !pendingPrependScrollRef.current) {
        stickToBottomRef.current = true;
        pendingLiveScrollRef.current = null;
      } else if (!displayed?.messagePage?.hasLater && !olderThanPage && !stickToBottomRef.current
        && !pendingPrependScrollRef.current && !pendingLiveScrollRef.current && viewport) {
        const frame = viewport.getBoundingClientRect();
        const anchor = [...viewport.querySelectorAll("[data-message-id]")].find((element) => {
          const row = element.getBoundingClientRect();
          return row.bottom > frame.top && row.top < frame.bottom;
        });
        pendingLiveScrollRef.current = {
          conversationId: event.conversationId,
          messageId: anchor?.dataset.messageId,
          top: anchor?.getBoundingClientRect().top,
          scrollTop: viewport.scrollTop,
        };
      }
      if (!displayed || olderThanPage || displayed.messagePage?.hasLater
        || displayed.messages.length >= MAX_RENDERED_MESSAGES) refreshMessageCount();
      recordCheckpointCursor(checkpointCursorsRef.current, event.payload, activeCursorOwners(displayed));
      if (event.payload?.payload?.runId === liveDeltaEventsRef.current.runId) {
        const cursor = checkpointCursorsRef.current.get(liveDeltaEventsRef.current.runId) ?? 0;
        const events = liveDeltaEventsRef.current.events.slice(liveDeltaEventsRef.current.start).filter((entry) =>
          !Number.isSafeInteger(entry.payload?.seq) || entry.payload.seq > cursor);
        liveDeltaEventsRef.current = boundedLiveDeltaEvents(liveDeltaEventsRef.current.runId, events,
          liveDeltaEventsRef.current.omittedThroughSeq > cursor ? liveDeltaEventsRef.current.omittedThroughSeq : 0);
      }
      if (!olderThanPage && event.payload.role === "assistant" && event.payload.payload?.runId) {
        const candidate = readingLiveCheckpoint(event.payload);
        if (submissionPendingRef.current && !acceptedPreviewRunRef.current
          && livePreviewRunRef.current !== candidate.runId) {
          livePreviewRunRef.current = candidate.runId;
          applyStreamingText(() => "", true);
          setRunEvents([]);
        }
        if ((!acceptedPreviewRunRef.current || acceptedPreviewRunRef.current === candidate.runId)
          && (activeCursorOwners(displayed).has(candidate.runId) || livePreviewRunRef.current === candidate.runId
            || acceptedPreviewRunRef.current === candidate.runId)) {
          // The following delta can arrive in the same browser task. Claim
          // the run before React processes the queued checkpoint state.
          livePreviewRunRef.current = candidate.runId;
          setLiveCheckpoint((current) => current?.runId === candidate.runId && current.seq > candidate.seq ? current : candidate);
        }
      }
      if (!olderThanPage) applyStreamingText((current) => streamingTextAfterRuntimeEvent(current, event), true);
      setConversation((current) => {
        if (!current) return current;
        const alreadyPresent = current.messages.some((message) => message.id === event.payload.id);
        // A checkpoint for an older, unloaded row is an update, not a new
        // message at the latest end of this bounded page.
        const olderThanPage = current.messagePage?.hasMore && current.messages.length
          && messagePrecedesPage(event.payload, current.messages[0]);
        if (olderThanPage && !alreadyPresent) return current;
        const total = (current.messagePage?.total ?? current.messages.length) + (alreadyPresent || current.messagePage?.hasLater ? 0 : 1);
        if (current.messagePage?.hasLater && !alreadyPresent) return {
          ...current,
          messagePage: { ...current.messagePage, total },
        };
        // Reader intent owns the page boundary. A stale bottom-follow bit can
        // survive a near-bottom upward gesture until the next scroll event.
        if (!alreadyPresent && current.messages.length >= MAX_RENDERED_MESSAGES
          && (readerAwayFromBottomRef.current || !stickToBottomRef.current || pendingLiveScrollRef.current)) return {
          ...current,
          messagePage: { ...current.messagePage, total, hasLater: true, newerCount: 1 },
        };
        const merged = upsertRuntimeMessage(current.messages, boundVisibleMessage(event.payload));
        const dropped = Math.max(0, merged.length - MAX_RENDERED_MESSAGES);
        const messages = merged.slice(-MAX_RENDERED_MESSAGES);
        return {
          ...current,
          messages,
          messagePage: {
            ...current.messagePage,
            total,
            hasMore: Boolean(current.messagePage?.hasMore || dropped),
            olderCount: (current.messagePage?.olderCount ?? 0) + dropped,
            beforeId: messages[0]?.id ?? null,
          },
        };
      });
    }
    if (event.type === "run.event" && event.conversationId === selectedConversationRef.current) {
      const runEvent = event.payload;
      const ownsLiveOutput = (!acceptedPreviewRunRef.current || acceptedPreviewRunRef.current === event.runId)
        && (livePreviewRunRef.current === null || livePreviewRunRef.current === event.runId
          || activeCursorOwners(conversationRef.current).has(event.runId) || submissionPendingRef.current);
      if (ownsLiveOutput && (runEvent.type === "assistant.delta" || runEvent.type === "assistant.message")
        && livePreviewRunRef.current !== event.runId) {
        livePreviewRunRef.current = event.runId;
        liveDeltaEventsRef.current = emptyLiveDeltaEvents(event.runId);
        setLiveCheckpoint(null);
        applyStreamingText(() => "", true);
        setRunEvents([]);
      }
      if (runEvent.type === "assistant.delta") {
        const checkpointEventSeq = checkpointCursorsRef.current.get(event.runId) ?? 0;
        if (ownsLiveOutput) {
          if (!Number.isSafeInteger(runEvent.seq) || runEvent.seq > checkpointEventSeq) {
            const retained = liveDeltaEventsRef.current.runId === event.runId ? liveDeltaEventsRef.current
              : emptyLiveDeltaEvents(event.runId);
            liveDeltaEventsRef.current = appendLiveDeltaEvent(retained, event);
          }
          // Browser timer throttling can delay a 32 ms stream flush while the
          // reader is on an older page. Show the first suffix byte after each
          // durable checkpoint now; coalesce the following deltas as usual.
          // The first byte must be visible without waiting for a throttled
          // timer, including when the tab has been hidden during a long run.
          const firstDelta = !streamingTextRef.current;
          applyStreamingText((current) => current.endsWith(LIVE_TRUNCATION_MARKER) ? current : boundStreamingText(streamingTextAfterRuntimeEvent(current, event, checkpointEventSeq)), firstDelta);
        }
      }
      if (runEvent.type === "assistant.message" && ownsLiveOutput) {
        liveDeltaEventsRef.current = emptyLiveDeltaEvents(event.runId);
        applyStreamingText((current) => streamingTextAfterRuntimeEvent(current, event), true);
      }
      if (runEvent.type.startsWith("tool.") && ownsLiveOutput) setRunEvents((current) => [...current, runEvent].slice(-20));
      if (runEvent.type === "run.started" && runEvent.payload?.account) {
        setConversation((current) => {
          if (current?.id !== event.conversationId) return current;
          const runs = withStartedRunAccount(current.runs, event.runId, runEvent.payload.account);
          return runs === current.runs ? current : { ...current, runs };
        });
      }
      if (["run.completed", "run.failed", "run.stopped"].includes(runEvent.type)) {
        if (acceptedPreviewRunRef.current === event.runId) acceptedPreviewRunRef.current = null;
        if (liveDeltaEventsRef.current.runId === event.runId) liveDeltaEventsRef.current = emptyLiveDeltaEvents();
        scheduleLayoutTick(() => loadConversation({ preservePage: true }));
        if (document.hidden && settings.notifications && Notification.permission === "granted") new Notification(`Outright run ${runEvent.type.split(".")[1]}`, { body: conversation?.title ?? "Agent run" });
      }
    }
  }, [loadConversation, loadConversations, settings.notifications, conversation?.title, selectedRecoveryRunId, applyStreamingText, refreshMessageCount, lifecycleEvents]);
  runtimeHandlerRef.current = handleRuntimeEvent;

  useEffect(() => {
    const connectionInstance = connectRuntime((event) => runtimeHandlerRef.current?.(event), setConnection);
    socketRef.current = connectionInstance;
    return () => connectionInstance.close();
  }, []);
  const sendRuntime = useCallback((message) => {
    if (terminalCommandFenceRef.current.allows(message)) socketRef.current?.send(message);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { const dark = theme === "dark" || (theme === "system" && media.matches); document.documentElement.classList.toggle("dark", dark); document.documentElement.style.colorScheme = dark ? "dark" : "light"; };
    apply(); localStorage.setItem("outright.theme", knownTheme(theme)); media.addEventListener("change", apply); return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    const keyboard = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(true); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); setNewChatOpen(true); }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        paneLayoutRef.current?.open("terminal");
      }
      if (event.key === "Escape" && !document.querySelector('[role="dialog"][data-open]:not(#project-sidebar)')) {
        if (isNarrow && sidebarOpen) closeSidebar();
      }
    };
    window.addEventListener("keydown", keyboard); return () => window.removeEventListener("keydown", keyboard);
  }, [isNarrow, sidebarOpen]);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 760px)");
    let wasNarrow = narrow.matches;
    const trackFocus = (event) => {
      // A layout transition can briefly focus BODY before the replacement
      // control commits. Pointer and keyboard input cancel the intent below.
      if (event.target === document.body) return;
      const target = sidebarFocusIntentRef.current === "opener"
        ? document.querySelector('[aria-label="Open projects sidebar"]')
        : sidebarRef.current?.querySelector('button:not(:disabled)');
      if (sidebarFocusIntentRef.current && event.target !== sidebarFocusSourceRef.current
        && event.target !== target) {
        sidebarFocusIntentRef.current = null;
        sidebarFocusSourceRef.current = null;
      }
      if (event.target.matches?.('[aria-label="Open projects sidebar"]')) sidebarFocusOwnerRef.current = "opener";
      else if (sidebarRef.current?.contains(event.target)) sidebarFocusOwnerRef.current = "sidebar";
      else {
        sidebarFocusOwnerRef.current = null;
      }
      sidebarFocusLastElementRef.current = sidebarFocusOwnerRef.current ? event.target : null;
    };
    const releaseFocusOwner = (event) => {
      // A click on blank workspace content leaves BODY focused without a
      // focusin event. Only an actual user gesture releases that ownership;
      // browser blur during a breakpoint transition still needs restoration.
      if (event.type === "pointerdown" || event.target === document.body) {
        sidebarFocusOwnerRef.current = null;
        sidebarFocusIntentRef.current = null;
        sidebarFocusSourceRef.current = null;
        sidebarFocusLastElementRef.current = null;
      }
    };
    const synchronizeLayout = () => {
      if (narrow.matches === wasNarrow) return;
      wasNarrow = narrow.matches;
      const activeElement = document.activeElement;
      let owner = null;
      if (activeElement === document.body) owner = sidebarFocusOwnerRef.current;
      else if (sidebarRef.current?.contains(activeElement)) owner = "sidebar";
      else if (activeElement?.matches?.('[aria-label="Open projects sidebar"]')) owner = "opener";
      sidebarFocusOwnerRef.current = owner;
      let focusIntent = null;
      if (wasNarrow && owner === "sidebar") focusIntent = "opener";
      else if (!wasNarrow && owner === "opener") focusIntent = "sidebar";
      sidebarFocusIntentRef.current = focusIntent;
      // Some browsers blur the disappearing control before dispatching the
      // media change. Retain that control as the source for its late focusout.
      let focusSource = null;
      if (focusIntent) focusSource = activeElement === document.body ? sidebarFocusLastElementRef.current : activeElement;
      sidebarFocusSourceRef.current = focusSource;
      setIsNarrow(wasNarrow);
      setSidebarOpen(!wasNarrow);
    };
    narrow.addEventListener("change", synchronizeLayout);
    window.addEventListener("resize", synchronizeLayout);
    document.addEventListener("focusin", trackFocus);
    document.addEventListener("pointerdown", releaseFocusOwner, true);
    document.addEventListener("keydown", releaseFocusOwner, true);
    return () => {
      narrow.removeEventListener("change", synchronizeLayout);
      window.removeEventListener("resize", synchronizeLayout);
      document.removeEventListener("focusin", trackFocus);
      document.removeEventListener("pointerdown", releaseFocusOwner, true);
      document.removeEventListener("keydown", releaseFocusOwner, true);
    };
  }, []);
  useLayoutEffect(() => {
    if (!isNarrow || !sidebarOpen) return;
    const sidebar = sidebarRef.current;
    let frame;
    let attempts = 0;
    const focusDialog = () => {
      if (sidebar?.contains(document.activeElement)) return;
      if (document.activeElement !== document.body
        && document.activeElement !== sidebarFocusSourceRef.current) return;
      const first = sidebar?.querySelector('button:not(:disabled)');
      if (first?.getClientRects().length) first.focus({ preventScroll: true });
      if (!sidebar?.contains(document.activeElement) && attempts++ < 12) frame = requestAnimationFrame(focusDialog);
    };
    focusDialog();
    const restoreDialog = () => {
      // Making the workspace inert can blur its opener after the first focus
      // attempt. Restore only when the browser has left focus on BODY.
      queueMicrotask(() => { if (document.activeElement === document.body) focusDialog(); });
    };
    document.addEventListener("focusout", restoreDialog, true);
    const containFocus = (event) => {
      if (event.key !== "Tab") return;
      const focusable = focusableElements(sidebar);
      if (!focusable.length) { event.preventDefault(); sidebar?.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === sidebar || document.activeElement === first)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    sidebar?.addEventListener("keydown", containFocus);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("focusout", restoreDialog, true); sidebar?.removeEventListener("keydown", containFocus); };
  }, [isNarrow, sidebarOpen]);
  useLayoutEffect(() => {
    const intent = sidebarFocusIntentRef.current;
    if (!intent || (intent === "opener" && sidebarOpen) || (intent === "sidebar" && !sidebarOpen)) return;
    let cancelRetry = () => {};
    let active = true;
    let attempts = 0;
    const maxAttempts = 30;
    let target;
    const watchFocus = () => {
      if (!active || sidebarFocusIntentRef.current !== intent) return;
      const focused = document.activeElement;
      if (focused === document.body) { transfer(); return; }
      if (focused !== target) {
        sidebarFocusIntentRef.current = null;
        sidebarFocusSourceRef.current = null;
        return;
      }
      const timer = window.setTimeout(watchFocus, 500);
      cancelRetry = () => clearTimeout(timer);
    };
    const transfer = () => {
      if (!active || sidebarFocusIntentRef.current !== intent) return;
      cancelRetry();
      cancelRetry = () => {};
      attempts += 1;
      target = intent === "opener" ? document.querySelector('[aria-label="Open projects sidebar"]')
        : sidebarRef.current?.querySelector('button:not(:disabled)');
      const focused = document.activeElement;
      const fromPriorControl = focused === sidebarFocusSourceRef.current;
      if (focused !== document.body && focused !== target && !fromPriorControl) {
        sidebarFocusIntentRef.current = null; // Do not override a newer user focus choice.
        sidebarFocusSourceRef.current = null;
        return;
      }
      if (target?.isConnected && target.getClientRects().length && getComputedStyle(target).visibility === "visible") {
        target.focus({ preventScroll: true });
        if (document.activeElement === target && target.getBoundingClientRect().width > 0) {
          sidebarFocusOwnerRef.current = intent;
          attempts = 0;
          const timer = window.setTimeout(watchFocus, 500);
          cancelRetry = () => clearTimeout(timer);
          return;
        }
      }
      if (attempts < maxAttempts) {
        let pending = true;
        let frame;
        let timer;
        const retry = () => {
          if (!pending) return;
          cancelRetry();
          transfer();
        };
        frame = requestAnimationFrame(retry);
        timer = window.setTimeout(retry, 100);
        cancelRetry = () => { pending = false; cancelAnimationFrame(frame); clearTimeout(timer); };
      }
    };
    // A breakpoint can detach or blur a control after focus() succeeds.
    // Some browser viewports omit focusout, so the bounded watch also checks
    // ownership after delayed layout tasks.
    const restoreAfterBlur = (event) => {
      const ownedControl = event.target === sidebarFocusSourceRef.current || (intent === "opener"
        ? event.target.matches?.('[aria-label="Open projects sidebar"]')
        : sidebarRef.current?.contains(event.target));
      if (!ownedControl || sidebarFocusIntentRef.current !== intent) return;
      queueMicrotask(() => {
        if (active && sidebarFocusIntentRef.current === intent && document.activeElement === document.body) transfer();
      });
      // Some engines dispatch focusout while the old control is still active
      // and clear activeElement only after this microtask. A committed layout
      // task gets another chance without overriding a newer focus owner.
      window.setTimeout(() => {
        if (active && sidebarFocusIntentRef.current === intent && document.activeElement === document.body) transfer();
      }, 0);
    };
    document.addEventListener("focusout", restoreAfterBlur, true);
    const releaseOnUserInput = (event) => {
      if (event.type === "pointerdown" && event.target === target) return;
      sidebarFocusIntentRef.current = null;
      sidebarFocusSourceRef.current = null;
      cancelRetry();
    };
    document.addEventListener("pointerdown", releaseOnUserInput, true);
    document.addEventListener("keydown", releaseOnUserInput, true);
    const observer = new ResizeObserver(() => {
      if (active && sidebarFocusIntentRef.current === intent && document.activeElement === document.body) transfer();
    });
    if (sidebarRef.current) observer.observe(sidebarRef.current);
    transfer();
    return () => { active = false; cancelRetry(); observer.disconnect(); document.removeEventListener("focusout", restoreAfterBlur, true); document.removeEventListener("pointerdown", releaseOnUserInput, true); document.removeEventListener("keydown", releaseOnUserInput, true); };
  }, [isNarrow, sidebarOpen]);
  useLayoutEffect(() => {
    const intent = archiveFocusRef.current;
    if (!intent) return;
    if (intent.projectId !== selectedProjectRef.current || intent.worktreeId !== selectedWorktreeRef.current) {
      archiveFocusRef.current = null;
      return;
    }
    if (intent.nextId !== selectedConversationId) {
      if (intent.nextId !== selectedConversationRef.current) archiveFocusRef.current = null;
      return;
    }
    archiveFocusRef.current = null;
    if (document.activeElement !== intent.source && document.activeElement !== document.body) return;
    const next = intent.nextId
      ? document.getElementById(domId("chat-tab", intent.nextId))
      : document.querySelector(".chat-tabs .add-tab");
    next?.focus({ preventScroll: true });
  }, [conversations, selectedConversationId]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 2800); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (!error) return; const timer = setTimeout(() => setError(""), 6000); return () => clearTimeout(timer); }, [error]);
  useEffect(() => {
    if (!bootstrap || !bootstrapError) return;
    const timer = setTimeout(() => setBootstrapError(""), 6000);
    return () => clearTimeout(timer);
  }, [Boolean(bootstrap), bootstrapError]);
  useEffect(() => {
    const viewport = messageViewportRef.current;
    if (!viewport) return;
    if (conversation?.messagePage?.hasLater) stickToBottomRef.current = false;
    let lastScrollTop = viewport.scrollTop;
    let lastMaximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    let growingFrom = null;
    let growingUntil = 0;
    let readerTowardBottom = false;
    let pointerReader = false;
    const updateStickiness = () => {
      const top = viewport.scrollTop;
      const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const now = performance.now();
      if (maximum > lastMaximum + 1) {
        growingFrom = now > growingUntil ? lastMaximum : Math.min(growingFrom ?? lastMaximum, lastMaximum);
        growingUntil = now + 750;
      }
      if (!pendingPrependScrollRef.current) {
        if (conversationRef.current?.messagePage?.hasLater) stickToBottomRef.current = false;
        else if (readerAwayFromBottomRef.current) {
          // An upward gesture owns the reader even inside the 96px return
          // zone. Only later reader input toward the bottom can resume follow;
          // a new row or measured virtual spacer cannot make that choice.
          const pointerMovedDown = pointerReader && now < readerScrollInputUntilRef.current
            && top > lastScrollTop + 1 && maximum <= lastMaximum + 1;
          if ((readerTowardBottom || pointerMovedDown) && maximum - top < 96) {
            readerAwayFromBottomRef.current = false;
            stickToBottomRef.current = true;
            readerTowardBottom = false;
            pointerReader = false;
          } else stickToBottomRef.current = false;
        }
        // A virtual row can be measured between a scroll-to-end and this
        // event. The previous end is still the reader's destination even if
        // the new spacer makes the current end much farther away.
        else if (top < lastScrollTop - 1 && maximum - top > 2 && now < readerScrollInputUntilRef.current) {
          stickToBottomRef.current = false;
          readerAwayFromBottomRef.current = true;
        }
        else if (maximum - top < 96
          || (now < growingUntil && growingFrom !== null && Math.abs(growingFrom - top) < 96)
          || (lastMaximum > 0 && Math.abs(lastMaximum - top) < 96)) {
          stickToBottomRef.current = true;
          readerAwayFromBottomRef.current = false;
        }
      }
      lastScrollTop = top;
      lastMaximum = maximum;
    };
    const readerWheel = (event) => {
      readerScrollInputUntilRef.current = performance.now() + 1000;
      if (event.deltaY < 0) {
        readerTowardBottom = false;
        readerAwayFromBottomRef.current = true;
        stickToBottomRef.current = false;
      } else if (event.deltaY > 0) readerTowardBottom = true;
    };
    const readerKey = (event) => {
      if (event.target !== viewport) return;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
        readerTowardBottom = false;
        readerAwayFromBottomRef.current = true;
        stickToBottomRef.current = false;
      } else if (["ArrowDown", "PageDown", "End"].includes(event.key)) readerTowardBottom = true;
      if (["ArrowUp", "PageUp", "Home", "ArrowDown", "PageDown", "End"].includes(event.key)) {
        readerScrollInputUntilRef.current = performance.now() + 1000;
      }
    };
    const readerPointer = () => { pointerReader = true; readerTowardBottom = false; readerScrollInputUntilRef.current = performance.now() + 2000; };
    const scrollOwner = viewport.parentElement;
    const scrollbarPointer = (event) => {
      if (event.target.closest?.('[data-slot="scroll-area-scrollbar"]')) readerPointer();
    };
    viewport.addEventListener("scroll", updateStickiness, { passive: true });
    viewport.addEventListener("wheel", readerWheel, { passive: true });
    viewport.addEventListener("keydown", readerKey);
    viewport.addEventListener("touchstart", readerPointer, { passive: true });
    scrollOwner?.addEventListener("pointerdown", scrollbarPointer, { passive: true });
    const followLatest = () => {
      if (stickToBottomRef.current && !pendingPrependScrollRef.current && !conversationRef.current?.messagePage?.hasLater) {
        if (readerAwayFromBottomRef.current) { stickToBottomRef.current = false; return; }
        moveMessageViewport(viewport, viewport.scrollHeight);
        lastMaximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      }
    };
    const resize = new ResizeObserver(followLatest);
    const column = viewport.querySelector(".message-column");
    if (column) resize.observe(column);
    viewport.addEventListener("windowed-range-change", followLatest);
    followLatest();
    return () => { viewport.removeEventListener("scroll", updateStickiness); viewport.removeEventListener("wheel", readerWheel); viewport.removeEventListener("keydown", readerKey); viewport.removeEventListener("touchstart", readerPointer); scrollOwner?.removeEventListener("pointerdown", scrollbarPointer); viewport.removeEventListener("windowed-range-change", followLatest); resize.disconnect(); };
  }, [conversation?.id, conversation?.messagePage?.hasLater]);
  useLayoutEffect(() => {
    const pending = pendingLiveScrollRef.current;
    if (!pending || pending.conversationId !== conversation?.id) return;
    const viewport = messageViewportRef.current;
    if (!viewport) return;
    let cancelTick = () => {};
    let remaining = 24;
    let stable = 0;
    const cancelForReader = (event) => {
      if (event.type === "keydown" && event.target !== viewport) return;
      if (pendingLiveScrollRef.current === pending) pendingLiveScrollRef.current = null;
      cancelTick();
    };
    const restore = () => {
      if (pendingLiveScrollRef.current !== pending) return;
      const anchor = pending.messageId && [...viewport.querySelectorAll("[data-message-id]")].find((element) => element.dataset.messageId === pending.messageId);
      if (anchor && pending.top !== undefined) {
        const delta = anchor.getBoundingClientRect().top - pending.top;
        if (Math.abs(delta) > 1) moveMessageViewport(viewport, viewport.scrollTop + delta);
        stable = Math.abs(anchor.getBoundingClientRect().top - pending.top) < 2 ? stable + 1 : 0;
      } else {
        // The virtual range may need one tick before the retained row mounts.
        if (remaining === 24) moveMessageViewport(viewport, pending.scrollTop);
        stable = 0;
      }
      if (--remaining > 0 && stable < 3) cancelTick = scheduleLayoutTick(restore);
      else if (pendingLiveScrollRef.current === pending) pendingLiveScrollRef.current = null;
    };
    const scrollOwner = viewport.parentElement;
    const cancelForScrollbar = (event) => {
      if (event.target.closest?.('[data-slot="scroll-area-scrollbar"]')) cancelForReader(event);
    };
    viewport.addEventListener("wheel", cancelForReader, { passive: true });
    viewport.addEventListener("touchstart", cancelForReader, { passive: true });
    viewport.addEventListener("pointerdown", cancelForReader, { passive: true });
    viewport.addEventListener("keydown", cancelForReader);
    scrollOwner?.addEventListener("pointerdown", cancelForScrollbar, { passive: true });
    restore();
    return () => {
      cancelTick();
      viewport.removeEventListener("wheel", cancelForReader);
      viewport.removeEventListener("touchstart", cancelForReader);
      viewport.removeEventListener("pointerdown", cancelForReader);
      viewport.removeEventListener("keydown", cancelForReader);
      scrollOwner?.removeEventListener("pointerdown", cancelForScrollbar);
    };
  }, [conversation]);
  useLayoutEffect(() => {
    const pending = pendingPrependScrollRef.current;
    const viewport = messageViewportRef.current;
    if (!pending || !viewport || pending.conversationId !== conversation?.id || pending.generation !== historyGenerationRef.current) return;
    const restoreAnchor = () => {
      const anchor = [...viewport.querySelectorAll("[data-message-id]")].find((element) => element.dataset.messageId === pending.messageId);
      if (anchor && pending.top !== undefined) moveMessageViewport(viewport, viewport.scrollTop + anchor.getBoundingClientRect().top - pending.top);
      else if (!pending.restoredFallback) {
        // Recenter the virtualizer on the retained row's new index. Subtracting
        // estimated heights from the old scroll offset can miss a row when the
        // removed messages had variable measured heights.
        if (pending.fallbackIndex !== undefined) moveMessageViewport(viewport, pending.fallbackIndex * ESTIMATED_MESSAGE_HEIGHT);
        else moveMessageViewport(viewport, viewport.scrollTop + (pending.prependedCount ?? 0) * ESTIMATED_MESSAGE_HEIGHT);
        pending.restoredFallback = true;
      }
    };
    restoreAnchor();
    let framesRemaining = 32;
    let framesElapsed = 0;
    let stableFrames = 0;
    let previousTop = null;
    let cancelTick = () => {};
    const cancelForUserScroll = (event) => {
      if (event.type === "keydown" && event.target !== viewport) return;
      if (pendingPrependScrollRef.current === pending) pendingPrependScrollRef.current = null;
      cancelTick();
    };
    const scrollOwner = viewport.parentElement;
    const cancelForScrollbar = (event) => {
      if (event.target.closest?.('[data-slot="scroll-area-scrollbar"]')) cancelForUserScroll(event);
    };
    viewport.addEventListener("pointerdown", cancelForUserScroll, { passive: true });
    scrollOwner?.addEventListener("pointerdown", cancelForScrollbar, { passive: true });
    viewport.addEventListener("wheel", cancelForUserScroll, { passive: true });
    viewport.addEventListener("touchstart", cancelForUserScroll, { passive: true });
    viewport.addEventListener("keydown", cancelForUserScroll);
    const keepAnchor = () => {
      if (pendingPrependScrollRef.current !== pending) return;
      restoreAnchor();
      const anchor = [...viewport.querySelectorAll("[data-message-id]")].find((element) => element.dataset.messageId === pending.messageId);
      const top = anchor?.getBoundingClientRect().top;
      stableFrames = top !== undefined && Math.abs(top - pending.top) < 2 && previousTop !== null && Math.abs(top - previousTop) < 1
        ? stableFrames + 1 : 0;
      previousTop = top;
      framesElapsed += 1;
      if (--framesRemaining > 0 && (framesElapsed < 12 || stableFrames < 3)) cancelTick = scheduleLayoutTick(keepAnchor);
      else if (pendingPrependScrollRef.current === pending) pendingPrependScrollRef.current = null;
    };
    cancelTick = scheduleLayoutTick(keepAnchor);
    return () => {
      cancelTick();
      viewport.removeEventListener("pointerdown", cancelForUserScroll);
      scrollOwner?.removeEventListener("pointerdown", cancelForScrollbar);
      viewport.removeEventListener("wheel", cancelForUserScroll);
      viewport.removeEventListener("touchstart", cancelForUserScroll);
      viewport.removeEventListener("keydown", cancelForUserScroll);
    };
  }, [conversation?.messages[0]?.id]);
  useEffect(() => {
    if (!stickToBottomRef.current || readerAwayFromBottomRef.current || pendingPrependScrollRef.current || conversation?.messagePage?.hasLater) return;
    scheduleLayoutTick(() => {
      const viewport = messageViewportRef.current;
      if (viewport && stickToBottomRef.current && !readerAwayFromBottomRef.current && !pendingPrependScrollRef.current) moveMessageViewport(viewport, viewport.scrollHeight);
    });
  }, [conversation?.messages.at(-1)?.id, conversation?.messagePage?.hasLater, streamingText]);
  useLayoutEffect(() => {
    const pending = pendingLatestScrollRef.current;
    const viewport = messageViewportRef.current;
    if (!pending || !viewport || pending.conversationId !== conversation?.id
      || pending.generation !== historyGenerationRef.current || conversation.messagePage?.hasLater) return;
    let cancelTick = () => {};
    let remaining = 32;
    let stable = 0;
    const cancelForReader = (event) => {
      if (event.type === "keydown" && event.target !== viewport) return;
      if (pendingLatestScrollRef.current === pending) pendingLatestScrollRef.current = null;
      cancelTick();
    };
    const scrollOwner = viewport.parentElement;
    const cancelForScrollbar = (event) => {
      if (event.target.closest?.('[data-slot="scroll-area-scrollbar"]')) cancelForReader(event);
    };
    const restore = () => {
      if (pendingLatestScrollRef.current !== pending) return;
      const row = [...viewport.querySelectorAll("[data-message-id]")].find((element) => element.dataset.messageId === pending.messageId);
      const frame = viewport.getBoundingClientRect();
      const bounds = row?.getBoundingClientRect();
      const visible = bounds && bounds.bottom > frame.top && bounds.top < frame.bottom;
      const atBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 2;
      if (visible && atBottom) stable += 1;
      else {
        stable = 0;
        // The virtual range and measured spacers can change after the first
        // scroll-to-end. Keep the explicit Return destination through them.
        moveMessageViewport(viewport, viewport.scrollHeight);
      }
      if (stable >= 2 || --remaining <= 0) {
        if (pendingLatestScrollRef.current === pending) pendingLatestScrollRef.current = null;
      } else cancelTick = scheduleLayoutTick(restore);
    };
    viewport.addEventListener("wheel", cancelForReader, { passive: true });
    viewport.addEventListener("touchstart", cancelForReader, { passive: true });
    viewport.addEventListener("pointerdown", cancelForReader, { passive: true });
    viewport.addEventListener("keydown", cancelForReader);
    scrollOwner?.addEventListener("pointerdown", cancelForScrollbar, { passive: true });
    restore();
    return () => {
      cancelTick();
      viewport.removeEventListener("wheel", cancelForReader);
      viewport.removeEventListener("touchstart", cancelForReader);
      viewport.removeEventListener("pointerdown", cancelForReader);
      viewport.removeEventListener("keydown", cancelForReader);
      scrollOwner?.removeEventListener("pointerdown", cancelForScrollbar);
    };
  }, [conversation?.id, conversation?.messages.at(-1)?.id, conversation?.messagePage?.hasLater]);

  function handleMessageViewportKeyDown(event) {
    if (event.target !== event.currentTarget || event.key !== "End" || conversation?.messagePage?.hasLater) return;
    const viewport = event.currentTarget;
    stickToBottomRef.current = true;
    readerAwayFromBottomRef.current = false;
    readerScrollInputUntilRef.current = 0;
    pendingLiveScrollRef.current = null;
    scheduleLayoutTick(() => { if (stickToBottomRef.current && viewport.isConnected) moveMessageViewport(viewport, viewport.scrollHeight); });
  }

  const pendingOutcomeRuns = conversation?.runs?.filter((run) => ACTIVE_RUN_STATUSES.has(run.status)
    && (run.outcomePending || pendingOutcomeRunIds.has(run.id))) ?? [];
  const pendingOutcomeIds = new Set(pendingOutcomeRuns.map((run) => run.id));
  const pendingOutcomeRun = pendingOutcomeRuns[0] ?? null;
  const activeRun = conversation?.runs?.find((run) => ACTIVE_RUN_STATUSES.has(run.status) && !pendingOutcomeIds.has(run.id));
  const outcomePending = Boolean(pendingOutcomeRun);
  const readingLiveText = conversation?.messagePage?.hasLater
    ? readingLivePreview(liveCheckpoint, streamingText) : "";
  const waitingForConversation = Boolean(selectedConversationId && (!conversation || !conversationDetailReady));
  const submissionUnavailable = conversationListPending || conversationListFailed
    || Boolean(selectedConversationId && (!conversationDetailReady || conversationLoadFailed));
  const unsentForOwner = unsentCreatedChat?.projectId === project?.id && unsentCreatedChat?.worktreeId === worktree?.id ? unsentCreatedChat : null;
  const firstPromptAwaitingSelection = Boolean(unsentCreatedChat && (!unsentForOwner || selectedConversationId !== unsentCreatedChat.id));
  const unsentProject = bootstrap?.projects.find((item) => item.id === unsentCreatedChat?.projectId);
  const unsentWorktree = unsentProject?.worktrees.find((item) => item.id === unsentCreatedChat?.worktreeId);
  const latestRun = conversation?.runs?.[0];
  // Answers name their own account; loaded runs cover older answers.
  const runAccounts = useMemo(() => new Map((conversation?.runs ?? []).map((run) => [run.id, runAccountText(run)])), [conversation?.runs]);
  const chatModelMismatch = manageChatOpen ? modelMismatch(providers, chatDraft, chatDraft.modelChosenFor) : "";
  const chatProviderProblem = manageChatOpen ? providerSwitchProblem(providers, chatDraft, conversation?.provider) : "";
  const chatSettingsProblem = [chatProviderProblem, chatModelMismatch].filter(Boolean).join(" ");
  // Worktree-wide recovery metadata gates sibling chats before submission;
  // the conversation-local values remain fallbacks for older runtimes.
  const interruptedRun = recoveryGate(conversation);
  const announcedRun = pendingOutcomeRun ?? activeRun ?? interruptedRun ?? latestRun;
  const runAnnouncement = runAnnouncementText(announcedRun, outcomePending);
  const recoveryConversation = conversation?.recoveryConversation ?? null;

  async function resolveRecovery(run, policy, useProviderDefaultModel = false) {
    try {
      if (policy === "discard-unverifiable" && !window.confirm("Only continue after you have verified outside Outright that the legacy provider is no longer running. Discard this unverifiable recovery record?")) return;
      await api(`/api/runs/${run.id}/resume`, { method: "POST", body: { policy, ...(policy === "discard-unverifiable" ? { confirmation: run.id } : {}), ...(useProviderDefaultModel ? { useProviderDefaultModel } : {}) } });
      await loadConversation();
    } catch (nextError) {
      // A model saved before validation is replaced only after an explicit yes.
      if (nextError.payload?.code === "RECOVERY_MODEL_UNLAUNCHABLE" && !useProviderDefaultModel
        && window.confirm(`This run was saved with the model “${run.model}”, which Outright can no longer launch safely. Continue it with the provider's default model instead? The interrupted run keeps its original record.`)) {
        return resolveRecovery(run, policy, true);
      }
      setError(nextError.payload?.code === "NO_PROVIDER_SESSION" ? "No provider session is available to resume" : nextError.message);
    }
  }

  async function openRecoveryConversation() {
    if (!recoveryConversation?.id) return;
    try {
      if (recoveryConversation.archived) {
        await api(`/api/conversations/${recoveryConversation.id}`, { method: "PATCH", body: { archived: false } });
      }
      if (recoveryConversation.projectId === selectedProjectRef.current && recoveryConversation.worktreeId === selectedWorktreeRef.current) {
        pendingConversationRef.current = recoveryConversation.id;
        await loadConversations(recoveryConversation.id);
        return;
      }
      const ownerProject = bootstrap?.projects.find((item) => item.id === recoveryConversation.projectId);
      const ownerWorktree = ownerProject?.worktrees.find((item) => item.id === recoveryConversation.worktreeId);
      if (!ownerProject || !ownerWorktree) throw new Error("The recovery chat worktree is no longer available");
      pendingConversationRef.current = recoveryConversation.id;
      chooseProject(ownerProject, ownerWorktree);
    } catch (nextError) { setError(nextError.message); }
  }

  function chooseProject(nextProject, explicitWorktree) {
    const nextWorktree = explicitWorktree ?? preferredWorktree(nextProject);
    const changed = selectedProjectRef.current !== nextProject.id || selectedWorktreeRef.current !== nextWorktree.id;
    if (changed) {
      resetConversationContext();
      selectedProjectRef.current = nextProject.id; selectedWorktreeRef.current = nextWorktree.id;
      setSelectedProjectId(nextProject.id); setSelectedWorktreeId(nextWorktree.id);
    } else if (pendingConversationRef.current) loadConversations(pendingConversationRef.current);
    setExpandedProjects((current) => ({ ...current, [nextProject.id]: true }));
    if (isNarrow && sidebarOpen) closeSidebar();
  }

  function closeSidebar() {
    if (!sidebarOpen) return;
    sidebarFocusIntentRef.current = "opener";
    sidebarFocusSourceRef.current = document.activeElement;
    setSidebarOpen(false);
  }

  function openSidebar() {
    if (sidebarOpen) return;
    sidebarFocusIntentRef.current = "sidebar";
    sidebarFocusSourceRef.current = document.activeElement;
    setSidebarOpen(true);
  }

  function navigateProjectButtons(event) {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const current = event.target.closest("button");
    const buttons = [...event.currentTarget.querySelectorAll("button:not(:disabled)")];
    const currentIndex = buttons.indexOf(current);
    if (currentIndex < 0) return;
    event.preventDefault();
    buttons[nextTabIndex(currentIndex, buttons.length, event.key)]?.focus();
  }

  function navigateTabs(event, selector, choose) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const current = event.target.closest?.(selector);
    if (!current || !event.currentTarget.contains(current)) return;
    const tabs = [...event.currentTarget.querySelectorAll(selector)];
    const currentIndex = tabs.indexOf(current);
    const nextIndex = nextTabIndex(currentIndex, tabs.length, event.key);
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = tabs[nextIndex];
    choose(next.dataset.tabId);
    next.focus();
    next.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  async function createConversation(title = newChatTitle, initialPrompt = false) {
    if (!project || !worktree) return null;
    let created;
    let privateListRequest;
    try {
      created = await api("/api/conversations", { method: "POST", body: { projectId: project.id, worktreeId: worktree.id, worktreePath: worktree.path, title: title.trim() || "New agent chat", provider: settings.provider, model: settings.model } });
      if (selectedProjectRef.current !== created.projectId || selectedWorktreeRef.current !== created.worktreeId) {
        if (initialPrompt) setUnsentCreatedChat({ id: created.id, projectId: created.projectId, worktreeId: created.worktreeId });
        return null;
      }
      pendingConversationRef.current = created.id; setNewChatTitle(""); setNewChatOpen(false);
      privateListRequest = conversationListRequestRef.current + 1;
      const selected = await loadConversations(created.id);
      let superseded = privateListRequest !== conversationListRequestRef.current;
      if (selected?.id === created.id) {
        // Dialog creation leaves detail loading to the selected-chat owner.
        // Only an immediate first prompt needs a private detail result.
        if (!initialPrompt) return null;
        const listRequest = conversationListRequestRef.current;
        const detail = await api(`/api/conversations/${created.id}`);
        superseded ||= listRequest !== conversationListRequestRef.current;
        if (!superseded && listRequest === conversationListRequestRef.current && !conversationListPendingRef.current && !conversationListFailed
          && selectedConversationRef.current === created.id && detail.id === created.id
          && detail.projectId === selectedProjectRef.current && detail.worktreeId === selectedWorktreeRef.current && !detail.archived) return detail;
      }
      if (initialPrompt) setUnsentCreatedChat({ id: created.id, projectId: created.projectId, worktreeId: created.worktreeId });
      else if (!superseded && !selected?.listFailed) setError("Chat created, but its details could not be loaded. Retry the chat list.");
      return null;
    } catch (nextError) {
      if (created && initialPrompt) {
        setUnsentCreatedChat({ id: created.id, projectId: created.projectId, worktreeId: created.worktreeId });
      } else if (!created || (privateListRequest === conversationListRequestRef.current
        && created.projectId === selectedProjectRef.current && created.worktreeId === selectedWorktreeRef.current)) {
        setError(nextError.message);
      }
      return null;
    }
  }
  function isSelectedTarget(target) {
    return !target?.archived && target?.id === selectedConversationRef.current && target.projectId === selectedProjectRef.current && target.worktreeId === selectedWorktreeRef.current;
  }
  async function sendPrompt(event, promptOverride, targetOverride) {
    event?.preventDefault();
    const submittedDraft = promptOverride ?? draft;
    const submittedDraftRevision = draftRevisionRef.current;
    const prompt = submittedDraft.trim();
    if (!prompt || activeRun || outcomePending || interruptedRun || firstPromptAwaitingSelection || conversationListPendingRef.current || conversationListFailed || submissionPendingRef.current) return false;
    if (selectedConversationRef.current && (!readyConversationRef.current || pendingConversationLoadRef.current || conversationLoadFailed || !isSelectedTarget(readyConversationRef.current))) return false;
    submissionPendingRef.current = true;
    let target = selectedConversationRef.current ? readyConversationRef.current : targetOverride ?? conversation;
    try {
      if (!target && selectedConversationRef.current) return false; // The selected chat is still loading.
      const createdHere = !target;
      if (createdHere) target = await createConversation(prompt.split(/\n/)[0].slice(0, 52), true);
      if (!target || !isSelectedTarget(target) || conversationListPendingRef.current || conversationListFailed) return false;
      if (!createdHere && (pendingConversationLoadRef.current || readyConversationRef.current !== target || conversationLoadFailed)) return false;
      // The default model was chosen for the default provider; a chat on
      // another provider with no model of its own uses that provider's default.
      const runProvider = target.provider || settings.provider;
      const run = await api(`/api/conversations/${target.id}/runs`, { method: "POST", body: { prompt, provider: runProvider, model: target.model || (runProvider === settings.provider ? settings.model : ""), reasoningEffort: settings.reasoningEffort, approvalPolicy: settings.approvalPolicy } });
      setUnsentCreatedChat((current) => current?.id === target.id && current.projectId === target.projectId && current.worktreeId === target.worktreeId ? null : current);
      setDraft((current) => draftRevisionRef.current === submittedDraftRevision ? draftAfterSubmission(current, submittedDraft) : current);
      if (!isSelectedTarget(target)) return true;
      const previewAlreadyOwnedByRun = livePreviewRunRef.current === run.id;
      livePreviewRunRef.current = run.id;
      acceptedPreviewRunRef.current = run.id;
      if (!previewAlreadyOwnedByRun) {
        liveDeltaEventsRef.current = emptyLiveDeltaEvents(run.id);
        setLiveCheckpoint(null); applyStreamingText(() => "", true); setRunEvents([]);
      }
      setConversation((current) => {
        if (current && current.id !== target.id) return current;
        const next = current ?? { ...target, messages: [], runs: [] };
        return { ...next, runs: [run, ...(next.runs ?? []).filter((item) => item.id !== run.id)] };
      });
      return true;
    } catch (nextError) {
      if (!isSelectedTarget(target)) return false;
      if (nextError.payload?.code === "PROJECT_TRUST_REQUIRED") { trustGrantedRef.current = false; setPendingPrompt({ prompt, target }); setTrustRequest(nextError.payload.project); }
      else {
        if (nextError.payload?.code === "RUN_RECOVERY_REQUIRED") await loadConversation();
        // Execution policy is a global default; name where to change it.
        setError(nextError.payload?.code === "PROVIDER_CONFIGURATION_UNSUPPORTED" ? `${nextError.message}. Change the default in Settings or this chat's provider.` : nextError.message);
      }
      return false;
    }
    finally { submissionPendingRef.current = false; }
  }
  async function trustAndRun() {
    const pending = pendingPrompt;
    if (!pending || !isSelectedTarget(pending.target)) { setTrustRequest(null); setPendingPrompt(null); trustGrantedRef.current = false; return; }
    if (conversationListPendingRef.current || conversationListFailed || !readyConversationRef.current
      || !isSelectedTarget(readyConversationRef.current) || pendingConversationLoadRef.current || conversationLoadFailed) return;
    try {
      if (!trustGrantedRef.current) {
        await api("/api/trust", { method: "POST", body: { projectId: trustRequest.id, projectPath: trustRequest.path, confirmation: trustRequest.path } });
        trustGrantedRef.current = true;
        setBootstrap((current) => ({ ...current, trustedProjects: [...current.trustedProjects, { projectId: trustRequest.id, projectPath: trustRequest.path }] }));
      }
      if (!isSelectedTarget(pending.target)) { setTrustRequest(null); setPendingPrompt(null); trustGrantedRef.current = false; return; }
      if (conversationListPendingRef.current || conversationListFailed || !readyConversationRef.current
        || !isSelectedTarget(readyConversationRef.current) || pendingConversationLoadRef.current || conversationLoadFailed) return;
      if (await sendPrompt(null, pending.prompt)) { setTrustRequest(null); setPendingPrompt(null); trustGrantedRef.current = false; }
    } catch (nextError) { setError(nextError.message); }
  }
  async function stopRun() {
    if (!activeRun) return;
    try { await api(`/api/runs/${activeRun.id}/stop`, { method: "POST" }); }
    catch (nextError) { setError(nextError.message); }
  }
  async function loadEarlierMessages() {
    if (!conversation?.messagePage?.hasMore || loadingEarlier || !conversation.messages[0]) return;
    pendingLatestScrollRef.current = null;
    activeFindMatchRef.current = null;
    pendingFindRef.current?.abort();
    pendingFindRef.current = null;
    const historyGeneration = ++historyGenerationRef.current;
    const viewport = messageViewportRef.current;
    const anchor = viewport?.querySelector(`[data-message-id="${CSS.escape(conversation.messages[0].id)}"]`);
    const pendingPrepend = { conversationId: conversation.id, generation: historyGeneration, messageId: conversation.messages[0].id, top: anchor?.getBoundingClientRect().top };
    pendingPrependScrollRef.current = pendingPrepend;
    pendingEarlierRef.current = pendingPrepend;
    stickToBottomRef.current = false;
    setLoadingEarlier(true);
    try {
      const result = await api(query(`/api/conversations/${conversation.id}/messages`, { before: conversation.messages[0].id, limit: 200 }));
      if (historyGeneration !== historyGenerationRef.current || selectedConversationRef.current !== conversation.id) return;
      if (pendingPrependScrollRef.current === pendingPrepend) pendingPrepend.prependedCount = result.messages.length;
      const pageMessages = result.messages.map((message) => boundPageMessage(message));
      checkpointCursorsRef.current = checkpointCursors(pageMessages, checkpointCursorsRef.current, activeCursorOwners(conversation));
      setConversation((current) => {
        if (current?.id !== conversation.id) return current;
        const merged = [...pageMessages, ...current.messages];
        const messages = merged.slice(0, MAX_RENDERED_MESSAGES);
        const total = Math.max(result.messagePage.total, current.messagePage?.total ?? 0);
        const olderCount = result.messagePage.olderCount;
        const newerCount = Math.max(0, total - olderCount - messages.length);
        return {
          ...current,
          messages,
          messagePage: {
            ...result.messagePage,
            total, olderCount, hasLater: newerCount > 0, newerCount,
          },
        };
      });
      refreshMessageCount();
    } catch (nextError) {
      if (pendingPrependScrollRef.current === pendingPrepend) pendingPrependScrollRef.current = null;
      if (historyGeneration === historyGenerationRef.current && selectedConversationRef.current === conversation.id) setError(nextError.message);
    } finally {
      if (pendingPrependScrollRef.current === pendingPrepend && (historyGeneration !== historyGenerationRef.current || selectedConversationRef.current !== conversation.id)) pendingPrependScrollRef.current = null;
      if (pendingEarlierRef.current === pendingPrepend) { pendingEarlierRef.current = null; setLoadingEarlier(false); }
    }
  }

  async function loadLaterMessages() {
    if (!conversation?.messagePage?.hasLater || loadingEarlier || !conversation.messages.at(-1)) return;
    pendingLatestScrollRef.current = null;
    activeFindMatchRef.current = null;
    pendingFindRef.current?.abort();
    pendingFindRef.current = null;
    const historyGeneration = ++historyGenerationRef.current;
    const viewport = messageViewportRef.current;
    const firstVisible = [...(viewport?.querySelectorAll("[data-message-id]") ?? [])].find((element) => element.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top);
    const pendingPage = { conversationId: conversation.id, generation: historyGeneration, messageId: firstVisible?.dataset.messageId ?? conversation.messages.at(-1).id, top: firstVisible?.getBoundingClientRect().top };
    pendingPrependScrollRef.current = pendingPage;
    pendingEarlierRef.current = pendingPage;
    stickToBottomRef.current = false;
    setLoadingEarlier(true);
    try {
      const result = await api(query(`/api/conversations/${conversation.id}/messages`, { after: conversation.messages.at(-1).id, limit: 200 }));
      if (historyGeneration !== historyGenerationRef.current || selectedConversationRef.current !== conversation.id) return;
      const pageMessages = result.messages.map((message) => boundPageMessage(message));
      checkpointCursorsRef.current = checkpointCursors(pageMessages, checkpointCursorsRef.current, activeCursorOwners(conversation));
      setConversation((current) => {
        if (current?.id !== conversation.id) return current;
        const merged = [...current.messages, ...pageMessages.filter((message) => !current.messages.some((entry) => entry.id === message.id))];
        const dropped = Math.max(0, merged.length - MAX_RENDERED_MESSAGES);
        const messages = merged.slice(dropped);
        if (dropped) pendingPage.fallbackIndex = Math.max(0, current.messages.findIndex((message) => message.id === pendingPage.messageId) - dropped);
        // A forward page may evict the visible row. Move the anchor to the
        // first surviving row explicitly; its predecessor remains reachable
        // through Load earlier. Never run the prepend-only pixel fallback.
        if (dropped && !messages.some((message) => message.id === pendingPage.messageId)) {
          pendingPage.messageId = messages[0].id;
          pendingPage.top = viewport?.getBoundingClientRect().top;
        }
        const olderCount = (current.messagePage?.olderCount ?? 0) + dropped;
        const total = Math.max(result.messagePage.total, current.messagePage?.total ?? 0);
        const newerCount = Math.max(0, total - olderCount - messages.length);
        return { ...current, messages, messagePage: {
          ...current.messagePage, total, olderCount, hasMore: olderCount > 0,
          hasLater: newerCount > 0, newerCount, beforeId: messages[0]?.id ?? null,
        } };
      });
      refreshMessageCount();
      if (conversation.messages.length + result.messages.length <= MAX_RENDERED_MESSAGES && pendingPrependScrollRef.current === pendingPage) pendingPrependScrollRef.current = null;
    } catch (nextError) {
      if (pendingPrependScrollRef.current === pendingPage) pendingPrependScrollRef.current = null;
      if (historyGeneration === historyGenerationRef.current && selectedConversationRef.current === conversation.id) setError(nextError.message);
    } finally {
      if (pendingPrependScrollRef.current === pendingPage && (historyGeneration !== historyGenerationRef.current || selectedConversationRef.current !== conversation.id)) pendingPrependScrollRef.current = null;
      if (pendingEarlierRef.current === pendingPage) { pendingEarlierRef.current = null; setLoadingEarlier(false); }
    }
  }

  async function findConversationMessage(needle, direction, afterId) {
    pendingLatestScrollRef.current = null;
    const conversationId = selectedConversationRef.current;
    if (!conversationId) return null;
    const priorProgress = findProgressRef.current;
    const continuation = priorProgress?.conversationId === conversationId
      && priorProgress.needle === needle && priorProgress.direction === direction
      && priorProgress.afterId === afterId && priorProgress.generation === historyGenerationRef.current;
    findProgressRef.current = null;
    pendingFindRef.current?.abort();
    // Find owns only the message page. A completion, reconnect, or list read
    // still owns fresh run and recovery metadata, even while Find is pending.
    // Explicit page loads are superseded by this new navigation request.
    if (pendingConversationLoadRef.current && !pendingConversationLoadRef.current.preservePage) {
      pendingConversationLoadRef.current.controller.abort();
      pendingConversationLoadRef.current = null;
    }
    const controller = new AbortController();
    const pendingFind = { conversationId, controller, abort: () => controller.abort(), events: [], eventBytes: 0, overflowed: false };
    pendingFindRef.current = pendingFind;
    const historyGeneration = ++historyGenerationRef.current;
    pendingPrependScrollRef.current = null;
    pendingEarlierRef.current = null;
    setLoadingEarlier(false);
    try {
      let cursor = continuation ? priorProgress.nextAfterId : afterId;
      let byteOffset = continuation ? priorProgress.nextByteOffset ?? 0 : 0;
      let contextOffset = continuation ? priorProgress.nextContextOffset ?? 0 : 0;
      let leftContextOffset = continuation ? priorProgress.nextLeftContextOffset ?? 0 : 0;
      let leftContextCased = continuation ? priorProgress.nextLeftContextCased ?? null : null;
      let originId = continuation ? priorProgress.originId : afterId;
      let wrapped = continuation ? priorProgress.wrapped : false;
      let result;
      for (let page = 0; page < 8; page += 1) {
        result = await api(query(`/api/conversations/${conversationId}/messages/find`, {
          q: needle, after: cursor || undefined, direction: direction < 0 ? "previous" : "next",
          origin: page || continuation ? originId ?? "none" : undefined,
          wrapped: wrapped ? "1" : undefined,
          byteOffset: byteOffset || undefined,
          contextOffset: contextOffset || undefined,
          leftContextOffset: leftContextOffset || undefined,
          leftContextCased: leftContextCased === null ? undefined : leftContextCased ? "1" : "0",
        }), { signal: controller.signal });
        if (!result.partial) break;
        if (!result.nextAfterId || (result.nextAfterId === cursor
          && !(result.nextByteOffset > byteOffset || (byteOffset > 0 && !result.nextByteOffset)
            || (result.nextByteOffset === byteOffset && result.nextContextOffset > contextOffset)
            || (result.nextByteOffset === byteOffset && result.nextLeftContextOffset > 0
              && (!leftContextOffset || result.nextLeftContextOffset < leftContextOffset))))) throw new Error("Search continuation did not advance");
        cursor = result.nextAfterId;
        byteOffset = result.nextByteOffset ?? 0;
        contextOffset = result.nextContextOffset ?? 0;
        leftContextOffset = result.nextLeftContextOffset ?? 0;
        leftContextCased = result.nextLeftContextCased ?? null;
        originId = result.originId;
        wrapped = result.wrapped;
        if (page === 7) {
          if (controller.signal.aborted || historyGeneration !== historyGenerationRef.current || selectedConversationRef.current !== conversationId) return undefined;
          findProgressRef.current = { conversationId, needle, direction, afterId, nextAfterId: cursor,
            nextByteOffset: byteOffset, nextContextOffset: contextOffset,
            nextLeftContextOffset: leftContextOffset, nextLeftContextCased: leftContextCased,
            originId, wrapped, generation: historyGeneration };
          return { partial: true };
        }
      }
      if (controller.signal.aborted || historyGeneration !== historyGenerationRef.current || selectedConversationRef.current !== conversationId) return undefined;
      if (!result.matchId) { activeFindMatchRef.current = null; return null; }
      activeFindMatchRef.current = { conversationId, messageId: result.matchId, needle };
      stickToBottomRef.current = false;
      const pageById = new Map(result.messages.map((message) => [message.id,
        boundPageMessage(message, message.id === result.matchId ? needle : "")]));
      let unseenEvent = false;
      for (const event of pendingFind.events) {
        if (event.type !== "message.created") continue;
        const previous = pageById.get(event.payload.id);
        if (!previous) { unseenEvent = true; continue; }
        const oldSeq = previous.payload?.checkpointEventSeq;
        const newSeq = event.payload?.payload?.checkpointEventSeq;
        if (!Number.isSafeInteger(oldSeq) || !Number.isSafeInteger(newSeq) || newSeq > oldSeq) pageById.set(event.payload.id,
          boundPageMessage(event.payload, event.payload.id === result.matchId ? needle : ""));
      }
      const messages = result.messages.map((message) => pageById.get(message.id));
      checkpointCursorsRef.current = checkpointCursors(messages, checkpointCursorsRef.current, activeCursorOwners(conversationRef.current));
      setConversation((current) => {
        if (current?.id !== conversationId) return current;
        const total = Math.max(result.messagePage.total ?? messages.length, current.messagePage?.total ?? 0);
        const newerCount = Math.max(0, total - (result.messagePage.olderCount ?? 0) - messages.length);
        return { ...current, messages, messagePage: {
          ...result.messagePage, total,
          hasLater: Boolean(result.messagePage.hasLater || unseenEvent || newerCount),
          newerCount,
        } };
      });
      refreshMessageCount();
      return result.matchId;
    } catch (error) {
      if (error.name === "AbortError") return undefined;
      throw error;
    } finally { if (pendingFindRef.current === pendingFind) pendingFindRef.current = null; }
  }

  async function createSpace(event) { event.preventDefault(); const routes = spaceRoutes(bootstrap); try { await api(routes.list, { method: "POST", body: { name: newSpaceName } }); setNewSpaceName(""); setNewSpaceOpen(false); await refreshSpaces(routes); setToast("Space created"); } catch (nextError) { setError(nextError.message); } }
  async function refreshSpaces(routes) { const listing = await api(routes.list); setBootstrap((current) => ({ ...current, [routes.key]: listing })); }
  async function moveProject(projectId, spaceId) { const routes = spaceRoutes(bootstrap); try { const listing = await api(routes.memberships, { method: "PUT", body: { projectId, [routes.field]: spaceId } }); setBootstrap((current) => ({ ...current, [routes.key]: listing })); setToast("Space updated"); } catch (nextError) { setError(nextError.message); } }
  function removeArchivedChat(updated, focusSource) {
    if (updated.projectId !== selectedProjectRef.current || updated.worktreeId !== selectedWorktreeRef.current) return;
    ++conversationListRequestRef.current;
    const remaining = conversationsRef.current.filter((item) => item.id !== updated.id);
    const nextId = selectedConversationRef.current === updated.id ? remaining[0]?.id ?? "" : selectedConversationRef.current;
    if (focusSource && document.activeElement === focusSource) {
      archiveFocusRef.current = { source: focusSource, nextId, projectId: updated.projectId, worktreeId: updated.worktreeId };
    }
    stageConversations(remaining);
    if (selectedConversationRef.current !== updated.id) return;
    readyConversationRef.current = null;
    setConversationDetailReady(false);
    pendingConversationLoadRef.current?.controller?.abort();
    pendingConversationLoadRef.current = null;
    pendingFindRef.current?.abort();
    pendingFindRef.current = null;
    activeFindMatchRef.current = null;
    findProgressRef.current = null;
    pendingEarlierRef.current = null;
    pendingPrependScrollRef.current = null;
    pendingLiveScrollRef.current = null;
    pendingLatestScrollRef.current = null;
    ++historyGenerationRef.current;
    stickToBottomRef.current = true;
    setLoadingEarlier(false);
    setLiveCheckpoint(null);
    livePreviewRunRef.current = null;
    acceptedPreviewRunRef.current = null;
    selectedConversationRef.current = nextId;
    setSelectedConversationId(nextId);
    setConversation(null); setConversationLoadFailed(false); applyStreamingText(() => "", true); setRunEvents([]); checkpointCursorsRef.current.clear();
  }
  async function archiveChat(item, focusSource) {
    try {
      const updated = await api(`/api/conversations/${item.id}`, { method: "PATCH", body: { archived: true } });
      removeArchivedChat(updated, focusSource);
      await loadConversations();
    } catch (nextError) { setError(nextError.message); }
  }
  async function updateConversation(patch) {
    try {
      const updated = await api(`/api/conversations/${conversation.id}`, { method: "PATCH", body: patch });
      if (updated.archived) removeArchivedChat(updated);
      else {
        if (readyConversationRef.current?.id === updated.id && isSelectedTarget(updated) && !pendingConversationLoadRef.current) {
          readyConversationRef.current = { ...readyConversationRef.current, ...updated };
        }
        setConversation((current) => current?.id === updated.id ? { ...current, ...updated } : current);
      }
      await loadConversations(updated.archived ? undefined : updated.id);
      return updated;
    } catch (nextError) { setError(nextError.message); return null; }
  }
  async function archiveConversation() { const updated = await updateConversation({ archived: true }); if (!updated) return; setManageChatOpen(false); }
  async function saveChatSettings(event) {
    event.preventDefault();
    if (chatSettingsProblem) return;
    const { destination, openedSessionId, modelChosenFor, ...patch } = chatDraft;
    // An untouched session field is not an edit. Sending its value from when
    // the dialog opened would discard a session the running agent recorded since.
    if (patch.provider === conversation.provider && patch.providerSessionId === openedSessionId) delete patch.providerSessionId;
    if (!destination || destination === `${conversation.projectId}::${conversation.worktreeId}`) {
      await updateConversation(patch); setManageChatOpen(false); return;
    }
    const [projectId, worktreeId] = destination.split("::");
    const nextProject = bootstrap.projects.find((item) => item.id === projectId);
    const nextWorktree = nextProject?.worktrees.find((item) => item.id === worktreeId);
    if (!nextProject || !nextWorktree) { setError("Destination worktree is no longer available"); return; }
    try {
      const moved = await api(`/api/conversations/${conversation.id}/move`, { method: "POST", body: { projectId, worktreeId, worktreePath: nextWorktree.path } });
      await api(`/api/conversations/${conversation.id}`, { method: "PATCH", body: patch });
      pendingConversationRef.current = moved.id; setManageChatOpen(false); chooseProject(nextProject, nextWorktree); setToast("Conversation moved");
    } catch (nextError) { setError(nextError.message); }
  }

  // Only a chat tab dragged in this worktree's tab strip reorders chats; a
  // pane title or anything else dropped on a tab is ignored.
  function isChatTabDrag(event) {
    return Boolean(dragConversationRef.current) && [...(event.dataTransfer?.types ?? [])].includes(CHAT_TAB_DRAG_TYPE);
  }

  async function reorderConversation(targetId) {
    const sourceId = dragConversationRef.current;
    dragConversationRef.current = "";
    const sourceIndex = conversations.findIndex((item) => item.id === sourceId);
    if (sourceIndex < 0 || sourceId === targetId || !conversations.some((item) => item.id === targetId)) return;
    const next = [...conversations];
    const [source] = next.splice(sourceIndex, 1);
    next.splice(next.findIndex((item) => item.id === targetId), 0, source);
    stageConversations(next);
    // Each tab saves its own position, so a failed write can leave the order
    // partly saved. Report it and show the order the server kept.
    const writes = await Promise.allSettled(next.map((item, index) => api(`/api/conversations/${item.id}`, { method: "PATCH", body: { tabPosition: index } })));
    const failed = writes.find((write) => write.status === "rejected");
    if (!failed) return;
    setError(failed.reason?.message || "Chat tab order could not be saved");
    try { await loadConversations(); } catch (nextError) { setError(nextError.message); }
  }

  async function createWorktree(event) {
    event.preventDefault();
    try {
      const result = await api("/api/worktrees", { method: "POST", body: { projectId: worktreeDialog.id, ...worktreeDraft } });
      const setupStatus = result.lifecycle?.state?.status;
      // Select the new worktree so its setup can be watched or reviewed.
      pendingWorktreeRef.current = { projectId: worktreeDialog.id, path: result.path, openSetup: ["needs-trust", "invalid"].includes(setupStatus) };
      setWorktreeDialog(null); setWorktreeDraft({ branch: "", name: "", baseBranch: "HEAD" });
      const refreshed = await bootstrapLoadRef.current?.(result.refreshDeferred ? 3 : 1);
      let message = refreshed === true ? "Worktree created" : "Worktree created; project refresh delayed";
      if (setupStatus === "running") message += "; setup is running";
      if (setupStatus === "needs-trust") message += "; review its setup commands";
      setToast(message);
      if (result.lifecycle?.error) setError(result.lifecycle.error);
    }
    catch (nextError) { setError(nextError.message); }
  }
  async function removeWorktree() {
    setRemoveState((current) => ({ ...current, pending: true, problem: null }));
    try { const result = await api("/api/worktrees", { method: "DELETE", body: removalRequest({ projectId: project.id, worktreePath: worktree.path, confirmation: removeConfirmation }, removeState.problem) }); setRemoveWorktreeOpen(false); setLifecycleOpen(false); setRemoveConfirmation(""); setRemoveState({ pending: false, problem: null }); setSelectedWorktreeId(""); const refreshed = await bootstrapLoadRef.current?.(result.refreshDeferred ? 3 : 1); setToast(refreshed === true ? "Worktree removed" : "Worktree removed; project refresh delayed"); }
    catch (nextError) {
      // Teardown problems keep the worktree; say why in the dialog and offer
      // the explicit choices.
      const problem = teardownProblem(nextError, worktree.path);
      if (problem) {
        setRemoveState({ pending: false, problem });
        setLifecycleOpen(false);
        setRemoveWorktreeOpen(true);
      }
      else { setRemoveState((current) => ({ ...current, pending: false })); setError(nextError.message); }
    }
  }
  async function refreshAll(includeTemplates = false) {
    const request = ++settingsRefreshRef.current;
    const settingsVersion = settingsVersionRef.current;
    try {
      const next = await api("/api/bootstrap");
      if (request !== settingsRefreshRef.current) return;
      setBootstrap((current) => ({ ...next, settings: settingsVersion === settingsVersionRef.current ? next.settings : current.settings }));
      applyLifecycleSnapshot(next);
      if (includeTemplates) setToast("Templates updated");
    } catch (nextError) { if (request === settingsRefreshRef.current) setError(nextError.message); }
  }
  function openManageChat() { if (!conversation || !conversationDetailReady || !isSelectedTarget(conversation)) return; setChatDraft({ title: conversation.title, providerSessionId: conversation.providerSessionId ?? "", openedSessionId: conversation.providerSessionId ?? "", provider: conversation.provider, model: conversation.model ?? "", modelChosenFor: conversation.provider, destination: `${conversation.projectId}::${conversation.worktreeId}` }); setManageChatOpen(true); }

  if (!bootstrap || !project || !worktree) return <LoadingScreen isScanning={isScanning} error={bootstrapError} onRetry={() => {
    setBootstrapError("");
    const retry = bootstrapLoadRef.current;
    if (retry) {
      retry.reset?.();
      retry().catch((retryError) => {
        if (bootstrapLoadRef.current === retry) setBootstrapError(retryError.message);
      });
    }
  }} />;

  let conversationContent = <EmptyChat worktree={worktree} onCreate={() => setNewChatOpen(true)} />;
  if (waitingForConversation) conversationContent = <output className="conversation-loading-status">{conversationLoadFailed ? "Could not load selected chat" : "Loading selected chat…"}</output>;
  if (conversation?.messages.length) conversationContent = <WindowedMessages key={conversation.id} messages={conversation.messages}
    messagePage={conversation.messagePage} viewportRef={messageViewportRef} restoreAnchorId={restoreMessageAnchorId}
    renderMessage={(message) => <Message message={message} conversationId={conversation.id} runAccount={answerAccountText(message, runAccounts)} />}
    onFind={findConversationMessage} onCancelFind={() => {
      pendingFindRef.current?.abort(); pendingFindRef.current = null; activeFindMatchRef.current = null; findProgressRef.current = null;
    }} resetFindGeneration={findResetGeneration} />;
  let unsentHelp = "Return to its worktree before sending again.";
  if (unsentForOwner) unsentHelp = firstPromptAwaitingSelection
    ? "Open the created chat before sending again." : "Send again when the chat is ready.";
  let composerPlaceholder = "Create a chat to start an agent…";
  if (conversation) composerPlaceholder = `Ask ${conversation.provider} to work in ${worktree.name}…`;
  if (waitingForConversation) composerPlaceholder = "Loading selected chat…";
  if (conversationLoadFailed) composerPlaceholder = "Chat unavailable; retry loading…";
  if (interruptedRun) composerPlaceholder = "Choose how to recover the interrupted run first…";
  let composerHint = <span className="send-hint"><Command /> Enter to send</span>;
  if (waitingForConversation) composerHint = <span className="send-hint" role="status" aria-live="polite">{conversationLoadFailed ? "Chat unavailable; retry loading" : "Loading selected chat"}</span>;
  if (interruptedRun) composerHint = <span className="send-hint running"><WarningCircle aria-hidden="true" />Recovery decision required</span>;
  if (outcomePending) composerHint = <span className="send-hint running"><WarningCircle aria-hidden="true" />Saving final run outcome</span>;
  if (activeRun) composerHint = <span className="send-hint running"><span className="status-dot demo" aria-hidden="true" />{`Agent is ${activeRun.status}`}</span>;
  let composerAction = <Button size="icon" type="submit" disabled={!draft.trim() || Boolean(interruptedRun) || submissionUnavailable || firstPromptAwaitingSelection} aria-label="Send message"><PaperPlaneTilt weight="fill" /></Button>;
  if (outcomePending) composerAction = <Button size="icon" type="button" variant="destructive" disabled aria-label="Final run outcome pending"><Stop weight="fill" /></Button>;
  if (activeRun) composerAction = <Button size="icon" type="button" variant="destructive" onClick={stopRun} aria-label="Stop active agent run"><Stop weight="fill" /></Button>;

  const paneViews = layoutViews(paneState.layout.root);
  const paneToggle = (view, label, Icon, hint) => {
    const shown = paneViews.includes(view);
    return <Tooltip><TooltipTrigger render={<Button variant={shown ? "secondary" : "ghost"} size="icon-sm" onClick={() => paneLayoutRef.current?.toggle(view)} aria-label={label} aria-pressed={shown} aria-controls={shown ? paneId(view) : undefined} />}><Icon /></TooltipTrigger><TooltipContent>{hint}</TooltipContent></Tooltip>;
  };
  const conversationView = <section className="conversation-pane" id="conversation-panel" role="tabpanel" aria-labelledby={selectedConversationId ? domId("chat-tab", selectedConversationId) : undefined}>
    <span className="sr-only run-announcement" role="status" aria-live="polite" aria-atomic="true">{runAnnouncement}</span>
    <ConversationHeader conversation={conversation} worktree={worktree} latestRun={latestRun} pendingRuns={pendingOutcomeRuns} onManage={openManageChat} />
    <ScrollArea className="message-scroll" viewportRef={messageViewportRef} viewportProps={{ tabIndex: 0, "aria-label": "Conversation messages", onKeyDown: handleMessageViewportKeyDown }}><div className="message-column">{conversationListFailed && <button className="history-loader" onClick={() => loadConversations()}>Retry chat list</button>}{conversationLoadFailed && <button className="history-loader" onClick={loadConversation}>Retry loading chat</button>}{conversation?.messagePage?.hasMore && <button className="history-loader" onClick={loadEarlierMessages} disabled={loadingEarlier}>{loadingEarlier ? "Loading earlier messages…" : `Load earlier messages · ${conversation.messagePage.olderCount} remaining`}</button>}{conversationContent}{!conversation?.messagePage?.hasLater && streamingText && <StreamingMessage text={streamingText} events={runEvents} busy={activeRun?.status === "running"} />}{!conversation?.messagePage?.hasLater && (activeRun || pendingOutcomeRun) && !streamingText && <RunningMessage run={activeRun ?? pendingOutcomeRun} events={runEvents} outcomePending={!activeRun && outcomePending} busy={activeRun?.status === "running"} />}</div></ScrollArea>
    {/* Notices share one bounded region between the transcript and the composer,
        so together they never take the transcript's minimum share of the pane. */}
    <div className="conversation-notices">
      {readingLiveText && <section className="history-live-tail" aria-label={activeRun ? "Live output while reading history" : "Recent output while reading history"} tabIndex={0}><strong>{activeRun ? "Live output" : "Recent output"}</strong><p>{readingLiveText}</p></section>}
      {conversation?.messagePage?.hasLater && <div className="history-forward"><button className="history-later" onClick={loadLaterMessages} disabled={loadingEarlier}>{loadingEarlier ? "Loading later messages…" : `Load later messages · ${conversation.messagePage.newerCount} remaining`}</button><button className="history-return" onClick={() => loadConversation({ returnToLatest: true })}>Return to latest{conversation.messagePage.newerCount ? ` · ${conversation.messagePage.newerCount} new` : ""}</button></div>}
      {outcomePending && <div className="recovery-notice"><WarningCircle weight="fill" /><span className="recovery-copy"><strong>Run outcome waiting for storage</strong><span>The agent process has exited. Outright is saving the final result for {pendingOutcomeRuns.length === 1 ? "run" : "runs"} {pendingOutcomeRuns.map((run, index) => <code key={run.id}>{run.id}{index < pendingOutcomeRuns.length - 1 ? ", " : ""}</code>)} and will update this chat when storage recovers.</span></span></div>}
      {interruptedRun && <RecoveryNotice run={interruptedRun} conversation={conversation} recoveryConversation={recoveryConversation} onOpenRecovery={openRecoveryConversation} onResolve={resolveRecovery} />}
      {unsentCreatedChat && <div className="first-prompt-notice" role="status" aria-live="polite"><span>Chat created, but your message was not sent. {unsentHelp}</span><span className="first-prompt-actions">{unsentForOwner && firstPromptAwaitingSelection && conversations.some((item) => item.id === unsentForOwner.id) && <Button type="button" variant="outline" size="sm" onClick={() => { revealConversationPane(); selectConversation(unsentForOwner.id); }}>Open created chat</Button>}{!unsentForOwner && unsentProject && unsentWorktree && <Button type="button" variant="outline" size="sm" onClick={() => { pendingConversationRef.current = unsentCreatedChat.id; chooseProject(unsentProject, unsentWorktree); }}>Return to created chat</Button>}<Button type="button" variant="ghost" size="sm" onClick={() => { setUnsentCreatedChat(null); editDraft(""); }}>Discard unsent message</Button></span></div>}
    </div>
    <form className="composer" onSubmit={sendPrompt}><textarea aria-label="Message the agent" disabled={Boolean(interruptedRun) || submissionUnavailable} aria-busy={waitingForConversation && !conversationLoadFailed} placeholder={composerPlaceholder} value={draft} onChange={(event) => editDraft(event.target.value)} onKeyDown={(event) => { if (isComposerSubmitKey(event)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><div className="composer-actions"><div><Button type="button" variant="ghost" size="icon-sm" disabled aria-label="Attach files (coming soon)"><Plus /></Button><Button type="button" variant="ghost" size="icon-sm" disabled aria-label="Mention context (coming soon)"><At /></Button><TemplateMenu templates={templates} onSelect={editDraft} /><button type="button" className="model-button" onClick={() => setSettingsOpen(true)} aria-label="Agent provider and model settings"><span className="model-orb" aria-hidden="true" />{conversation?.provider ?? settings.provider}{conversation?.model ? ` · ${conversation.model}` : ""}<CaretDown /></button></div>{composerHint}{composerAction}</div></form>
  </section>;
  // Only views in the layout mount; the others are inert element objects.
  const paneViewElements = {
    conversation: conversationView,
    changes: <ChangesPane worktree={worktree} runtimeEvent={runtimeEvent} settings={settings} onError={handleError} onToast={setToast} />,
    terminal: <TerminalPane worktree={worktree} runtimeEvent={runtimeEvent} terminalsVersion={terminalsVersion} unverifiedTerminalIds={unverifiedTerminalIds} sendRuntime={sendRuntime} onError={handleError} />,
    context: <ContextPane worktree={worktree} settings={settings} onError={handleError} />,
  };

  return <div className={`app-shell ${sidebarOpen ? "sidebar-is-open" : "sidebar-is-closed"}`}>
    <aside className="sidebar" id="project-sidebar" role={isNarrow && sidebarOpen ? "dialog" : undefined} aria-modal={isNarrow && sidebarOpen ? true : undefined} aria-label="Projects and worktrees" aria-hidden={!sidebarOpen} tabIndex={isNarrow ? -1 : undefined} ref={sidebarRef}>
      <header className="sidebar-brand"><div className="brand-lockup"><span className="brand-glyph"><Sparkle weight="fill" /></span><strong>Outright</strong></div><Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={closeSidebar} aria-label="Close projects sidebar" />}><SidebarSimple /></TooltipTrigger><TooltipContent>Close sidebar</TooltipContent></Tooltip></header>
      <div className="sidebar-actions"><Button className="new-chat-action" onClick={() => setNewChatOpen(true)}><Plus weight="bold" /> New chat <kbd>⌘N</kbd></Button><Button variant="ghost" className="sidebar-action" onClick={() => setCommandOpen(true)}><MagnifyingGlass /> Search <kbd>⌘K</kbd></Button><Button variant="ghost" className="sidebar-action" onClick={() => loadBootstrap(true)}><ArrowsClockwise className={isScanning ? "spin" : ""} /> Scan projects</Button></div>
      <Separator /><div className="project-section-heading"><span>Projects</span><Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-xs" onClick={() => setNewSpaceOpen(true)} aria-label="New space" />}><FolderPlus /></TooltipTrigger><TooltipContent>New space</TooltipContent></Tooltip></div>
      <ScrollArea className="project-scroll" viewportProps={{ tabIndex: 0, "aria-label": "Spaces, projects, and worktrees", onKeyDown: navigateProjectButtons }}><div className="space-list">{spaceProjects.map((space) => { const isOpen = expandedSpaces[space.id] ?? true; return <section className="project-space" key={space.id}><button className="space-heading" aria-expanded={isOpen} onClick={() => setExpandedSpaces((current) => ({ ...current, [space.id]: !isOpen }))}>{isOpen ? <CaretDown /> : <CaretRight />}<Folders weight="duotone" /><span>{space.name}</span><small>{space.projects.length}</small></button>{isOpen && space.projects.map((item) => <ProjectTree key={item.id} project={item} activeProjectId={project.id} activeWorktreeId={worktree.id} expanded={expandedProjects[item.id] ?? item.id === project.id} spaces={spaces.spaces} onToggle={() => setExpandedProjects((current) => ({ ...current, [item.id]: !(current[item.id] ?? item.id === project.id) }))} onSelectProject={() => chooseProject(item)} onSelectWorktree={(nextWorktree) => chooseProject(item, nextWorktree)} onMove={(spaceId) => moveProject(item.id, spaceId)} onCreateWorktree={() => setWorktreeDialog(item)} lifecycle={lifecycleStates} />)}</section>; })}</div></ScrollArea>
      <footer className="sidebar-footer"><span className={`status-dot ${connection === "connected" ? "live" : "demo"}`} aria-hidden="true" /><span role="status" aria-live="polite">{connection === "connected" ? "Runtime connected" : connection}</span>{bootstrap.truncated ? <small className="scan-limit" title={`Showing ${bootstrap.projects.length} of ${bootstrap.repositoryCount} discovered repositories. Increase maxProjects in outright.config.json to show more.`}><WarningCircle />{bootstrap.projects.length}/{bootstrap.repositoryCount}</small> : <small>{bootstrap.scanDurationMs ? `${Math.round(bootstrap.scanDurationMs)}ms` : ""}</small>}<Button variant="ghost" size="icon-xs" onClick={() => setSettingsOpen(true)} aria-label="Settings"><GearSix /></Button></footer>
    </aside>
    {isNarrow && sidebarOpen && <div className="mobile-scrim" onClick={closeSidebar} aria-hidden="true" />}

    <main id="main-workspace" className="workspace" inert={isNarrow && sidebarOpen ? true : undefined} aria-hidden={isNarrow && sidebarOpen ? true : undefined}>
      <header className="workspace-bar">{!sidebarOpen && <Button variant="ghost" size="icon-sm" onClick={openSidebar} aria-label="Open projects sidebar" aria-controls="project-sidebar" aria-expanded={sidebarOpen}><SidebarSimple /></Button>}<div className="workspace-context"><span>{project.name}</span><CaretRight /><GitBranch /><strong>{worktree.name}</strong></div><div className="workspace-tools"><RunState run={pendingOutcomeRun ?? activeRun ?? latestRun} outcomePending={outcomePending} /><WorktreeState worktree={worktree} /><LifecycleState key={worktree.path} state={worktreeLifecycle} onOpen={() => setLifecycleOpen(true)} />{paneToggle("changes", "Changes", GitDiff, "Changes")}{paneToggle("terminal", "Terminal", TerminalWindow, "Terminal ⌘⇧T")}{paneToggle("context", "Project context", Info, "Project context")}<DropdownMenu><span id="pane-layout-hint" className="sr-only">F6 moves focus between panes</span><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Pane layout" aria-describedby="pane-layout-hint" />}><Layout /></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-auto min-w-60" aria-describedby="pane-layout-hint"><DropdownMenuGroup><DropdownMenuLabel>Pane layout</DropdownMenuLabel>{PANE_LAYOUT_PRESETS.map((preset) => <DropdownMenuItem key={preset.id} onClick={() => changePaneLayout(applyPreset(paneState.layout, preset.id))}>{preset.label}</DropdownMenuItem>)}</DropdownMenuGroup><DropdownMenuSeparator /><p className="pane-layout-hint" aria-hidden="true">F6 moves focus between panes</p></DropdownMenuContent></DropdownMenu><ThemeMenu theme={theme} onThemeChange={setTheme} /><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Worktree options" />}><DotsThree weight="bold" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => api("/api/editor/open", { method: "POST", body: { path: worktree.path, editor: settings.editor } }).then(() => setToast(`Opened in ${settings.editor}`)).catch((nextError) => setError(nextError.message))}><PencilSimple />Open in {settings.editor}</DropdownMenuItem><DropdownMenuItem onClick={() => setWorktreeDialog(project)}><GitBranch />New worktree</DropdownMenuItem><DropdownMenuItem onClick={() => setLifecycleOpen(true)}><Wrench />Worktree setup</DropdownMenuItem>{worktree.isLinked && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onClick={() => { setRemoveState({ pending: false, problem: null }); setRemoveWorktreeOpen(true); }}><Trash />Remove worktree</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu></div></header>
      <nav className="chat-tabs" aria-label="Agent chats"><div className="chat-tabs-scroll" role="tablist" aria-label="Open agent chats" aria-orientation="horizontal" onKeyDown={(event) => navigateTabs(event, '[role="tab"]', (id) => { revealConversationPane(); selectConversation(id); })}>{conversations.map((item) => <div className={`chat-tab ${item.id === selectedConversationId ? "is-active" : ""}`} key={item.id} draggable onDragStart={(event) => { dragConversationRef.current = item.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData(CHAT_TAB_DRAG_TYPE, item.id); }} onDragEnd={() => { dragConversationRef.current = ""; }} onDragOver={(event) => { if (isChatTabDrag(event)) event.preventDefault(); }} onDrop={(event) => { if (!isChatTabDrag(event)) return; event.preventDefault(); void reorderConversation(item.id); }}><button className="tab-select" id={domId("chat-tab", item.id)} data-tab-id={item.id} role="tab" aria-selected={item.id === selectedConversationId} aria-controls="conversation-panel" tabIndex={item.id === selectedConversationId ? 0 : -1} onClick={() => { revealConversationPane(); selectConversation(item.id); }} onDoubleClick={() => { selectConversation(item.id); window.setTimeout(openManageChat, 0); }}>{item.pinned ? <PushPin weight="fill" /> : <ChatCircle weight={item.id === selectedConversationId ? "fill" : "regular"} />}<span>{item.title}</span></button><button className="tab-close" aria-label={`Archive ${item.title}`} onClick={(event) => { event.stopPropagation(); void archiveChat(item, event.currentTarget); }}><X /></button></div>)}</div><Button variant="ghost" size="icon-sm" className="add-tab" onClick={() => setNewChatOpen(true)} aria-label="New chat tab"><Plus /></Button></nav>
      <PaneLayout ref={paneLayoutRef} className="work-area" layout={paneState.layout} onChange={changePaneLayout} compactPreferred={isNarrow} views={paneViewElements} />
    </main>

    <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} projects={bootstrap.projects} onSelectProject={chooseProject} onSelectConversation={(item) => { const nextProject = bootstrap.projects.find((entry) => entry.id === item.projectId); const nextWorktree = nextProject?.worktrees.find((entry) => entry.id === item.worktreeId); if (nextProject && nextWorktree) { pendingConversationRef.current = item.id; chooseProject(nextProject, nextWorktree); } }} />
    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} settings={settings} providers={providers} templates={templates} runtimeEvent={runtimeEvent} accountsVersion={accountsVersion} onSaved={(nextSettings, refresh) => { if (refresh !== "history" && refresh !== "settings" && refresh !== "templates") { ++settingsVersionRef.current; setBootstrap((current) => ({ ...current, settings: nextSettings })); if (nextSettings.notifications && window.Notification && Notification.permission === "default") requestNotificationPermission(); } if (refresh) void refreshAll(refresh === "templates"); }} onError={handleError} />

    <SimpleDialog open={newChatOpen} onOpenChange={setNewChatOpen} title="New agent chat" description={`${project.name} / ${worktree.name}`} onSubmit={(event) => { event.preventDefault(); createConversation(); }} submit="Create chat"><label htmlFor="chat-title">What should the agent work on?</label><Input id="chat-title" autoFocus value={newChatTitle} onChange={(event) => setNewChatTitle(event.target.value)} placeholder="Review the worktree scanner" /></SimpleDialog>
    <SimpleDialog open={newSpaceOpen} onOpenChange={setNewSpaceOpen} title="Create space" description="Organize related projects together in the sidebar." onSubmit={createSpace} submit="Create space" disabled={!newSpaceName.trim()}><label htmlFor="space-name">Space name</label><Input id="space-name" autoFocus value={newSpaceName} onChange={(event) => setNewSpaceName(event.target.value)} placeholder="Client work" /></SimpleDialog>
    <Dialog open={Boolean(trustRequest)} onOpenChange={(open) => !open && setTrustRequest(null)}><DialogContent><DialogHeader><DialogTitle>Trust this project?</DialogTitle><DialogDescription>Agents can read and, under the selected policy, modify files or run commands inside this project.</DialogDescription></DialogHeader>{trustRequest && <div className="trust-card"><ShieldCheck /><div><strong>{trustRequest.name}</strong><code>{trustRequest.path}</code></div></div>}<p className="trust-note">Outright will pass <strong>{settings.approvalPolicy}</strong> to the provider. Full-access mode can make changes beyond the worktree and should only be used in an external sandbox.</p><DialogFooter><Button variant="outline" onClick={() => setTrustRequest(null)}>Cancel</Button><Button disabled={submissionUnavailable} onClick={trustAndRun}>Trust and run</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={manageChatOpen} onOpenChange={setManageChatOpen}><DialogContent><form className="dialog-form" onSubmit={saveChatSettings}><DialogHeader><DialogTitle>Conversation settings</DialogTitle><DialogDescription>Rename, move, pin, or attach an existing provider session.</DialogDescription></DialogHeader><label htmlFor="chat-settings-title">Title</label><Input id="chat-settings-title" value={chatDraft.title} onChange={(event) => setChatDraft({ ...chatDraft, title: event.target.value })} /><label htmlFor="chat-settings-destination">Move to worktree</label><select id="chat-settings-destination" value={chatDraft.destination} onChange={(event) => setChatDraft({ ...chatDraft, destination: event.target.value })}>{bootstrap.projects.map((item) => <optgroup key={item.id} label={item.name}>{item.worktrees.filter((entry) => !entry.isPrunable && !entry.isBare).map((entry) => <option key={entry.id} value={`${item.id}::${entry.id}`}>{entry.name} · {entry.branch}</option>)}</optgroup>)}</select><label htmlFor="chat-settings-provider">Provider</label><select id="chat-settings-provider" aria-describedby="chat-settings-provider-status" aria-invalid={chatProviderProblem ? true : undefined} value={chatDraft.provider} onChange={(event) => setChatDraft({ ...chatDraft, provider: event.target.value, providerSessionId: event.target.value === conversation?.provider ? conversation.providerSessionId ?? "" : "" })}>{providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!providerReady(provider) && provider.id !== conversation?.provider}>{providerOptionLabel(provider)}</option>)}</select><p id="chat-settings-provider-status" className="provider-status" role="status" aria-live="polite">{providerStatusText(providers.find((provider) => provider.id === chatDraft.provider))}{chatDraft.provider !== conversation?.provider ? " Switching providers starts a new provider session." : ""}{chatSettingsProblem && ` ${chatSettingsProblem}`}</p><label htmlFor="chat-settings-model">Model</label><Input id="chat-settings-model" aria-invalid={chatModelMismatch ? true : undefined} aria-describedby={chatModelMismatch ? "chat-settings-provider-status" : undefined} value={chatDraft.model} onChange={(event) => setChatDraft({ ...chatDraft, model: event.target.value, modelChosenFor: chatDraft.provider })} placeholder="Provider default" /><label htmlFor="chat-settings-session">Provider session ID</label><Input id="chat-settings-session" disabled={providers.find((provider) => provider.id === chatDraft.provider)?.capabilities?.resume === false} value={chatDraft.providerSessionId} onChange={(event) => setChatDraft({ ...chatDraft, providerSessionId: event.target.value })} placeholder="Attach or resume an existing session" /><div className="manage-actions"><Button type="button" variant="outline" onClick={() => updateConversation({ pinned: !conversation.pinned })}><PushPin />{conversation?.pinned ? "Unpin" : "Pin"}</Button><Button type="button" variant="destructive" onClick={archiveConversation}><Archive />Archive conversation</Button></div><DialogFooter><Button variant="outline" type="button" onClick={() => setManageChatOpen(false)}>Cancel</Button><Button type="submit" disabled={Boolean(chatSettingsProblem)}>Save</Button></DialogFooter></form></DialogContent></Dialog>
    <SimpleDialog open={Boolean(worktreeDialog)} onOpenChange={(open) => !open && setWorktreeDialog(null)} title="Create worktree" description={worktreeDialog?.name ?? ""} onSubmit={createWorktree} submit="Create worktree" disabled={!worktreeDraft.branch.trim()}><label htmlFor="worktree-branch">Branch name</label><Input id="worktree-branch" value={worktreeDraft.branch} onChange={(event) => setWorktreeDraft({ ...worktreeDraft, branch: event.target.value })} placeholder="feature/my-change" /><label htmlFor="worktree-directory">Directory name <small>optional</small></label><Input id="worktree-directory" value={worktreeDraft.name} onChange={(event) => setWorktreeDraft({ ...worktreeDraft, name: event.target.value })} placeholder="project-my-change" /><label htmlFor="worktree-base">Base revision</label><Input id="worktree-base" value={worktreeDraft.baseBranch} onChange={(event) => setWorktreeDraft({ ...worktreeDraft, baseBranch: event.target.value })} /></SimpleDialog>
    <Dialog open={removeWorktreeOpen} onOpenChange={setRemoveWorktreeOpen}><DialogContent><DialogHeader><DialogTitle>Remove worktree?</DialogTitle><DialogDescription>This is allowed only when the linked worktree has no uncommitted changes. If the repository defines teardown commands, they run first, and the worktree is kept if one fails. Type its exact path to confirm.</DialogDescription></DialogHeader><code className="confirm-path">{worktree.path}</code><label htmlFor="remove-worktree-confirmation">Confirmation path</label><Input id="remove-worktree-confirmation" value={removeConfirmation} onChange={(event) => setRemoveConfirmation(event.target.value)} placeholder="Exact worktree path" />{removeState.pending && <div className="lifecycle-note" role="status"><p>Removing. Any teardown commands are running first.</p><Button type="button" variant="outline" size="sm" onClick={() => { setRemoveWorktreeOpen(false); setLifecycleOpen(true); }}>Show teardown progress</Button></div>}{removeState.problem && <div className="lifecycle-error" role="alert"><p>{removeState.problem.message}</p><Button type="button" variant="outline" size="sm" onClick={() => { setRemoveWorktreeOpen(false); setLifecycleOpen(true); }}>Open worktree setup</Button></div>}<TeardownChoices problem={removeState.problem?.worktreePath === worktree.path ? removeState.problem : null} onChoose={(choice) => setRemoveState((current) => ({ ...current, problem: current.problem && { ...current.problem, choice } }))} /><DialogFooter><Button variant="outline" onClick={() => setRemoveWorktreeOpen(false)}>Cancel</Button><Button variant="destructive" disabled={removeConfirmation !== worktree.path || removeState.pending || Boolean(removeState.problem?.choices.length && !removeState.problem.choices.includes(removeState.problem.choice))} onClick={removeWorktree}>{removeState.pending ? "Removing…" : "Remove worktree"}</Button></DialogFooter></DialogContent></Dialog>
    <WorktreeLifecycleDialog key={worktree.path} open={lifecycleOpen} onOpenChange={setLifecycleOpen} project={project} worktree={worktree} events={lifecycleEvents} onError={handleError} />
    {toast && <div className="toast" role="status" aria-live="polite"><CheckCircle weight="fill" />{toast}</div>}
    {(error || bootstrapError) && <div className="error-toast-stack">
      {error && <div className="error-toast" role="alert" aria-live="assertive"><WarningCircle weight="fill" /><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X /></button></div>}
      {bootstrapError && <div className="error-toast" role="alert" aria-live="assertive"><WarningCircle weight="fill" /><span>{bootstrapError}</span><button onClick={() => setBootstrapError("")} aria-label="Dismiss loading error"><X /></button></div>}
    </div>}
  </div>;
}

function ProjectTree({ project, activeProjectId, activeWorktreeId, expanded, spaces, onToggle, onSelectProject, onSelectWorktree, onMove, onCreateWorktree, lifecycle }) {
  return <div className={`project-tree ${project.id === activeProjectId ? "is-active" : ""}`}><div className="project-row"><button className="tree-caret" onClick={onToggle} aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`} aria-expanded={expanded}>{expanded ? <CaretDown /> : <CaretRight />}</button><button className="project-select" onClick={onSelectProject}><FolderOpen weight={project.id === activeProjectId ? "fill" : "duotone"} /><span><strong>{project.name}</strong><small>{compactPath(project.path)}</small></span></button><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="project-menu" aria-label={`Project options for ${project.name}`} />}><DotsThree weight="bold" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={onCreateWorktree}><GitBranch />New worktree</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuGroup><DropdownMenuLabel>Move to space</DropdownMenuLabel>{spaces.map((space) => <DropdownMenuItem key={space.id} onClick={() => onMove(space.id)}><Folders />{space.name}</DropdownMenuItem>)}</DropdownMenuGroup><DropdownMenuItem onClick={() => onMove(null)}>Ungrouped</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>{expanded && <div className="worktree-list">{project.worktrees.map((item) => <button className={`worktree-row ${project.id === activeProjectId && item.id === activeWorktreeId ? "is-active" : ""}`} aria-current={project.id === activeProjectId && item.id === activeWorktreeId ? "page" : undefined} key={item.id} onClick={() => onSelectWorktree(item)}><span /><GitBranch /><span className="worktree-copy"><strong>{item.name}</strong><small>{item.branch}</small></span><LifecycleMark state={lifecycleFor(lifecycle, project, item)} /><GitHealth worktree={item} /></button>)}</div>}</div>;
}
function ConversationHeader({ conversation, worktree, latestRun, pendingRuns, onManage }) {
  const latestPending = pendingRuns.some((run) => run.id === latestRun?.id);
  const earlierPending = pendingRuns.length - Number(latestPending);
  // The latest run's account has its own line, shown at every width while the
  // rest of the run summary is hidden on narrow screens.
  const latestAccount = runAccountText(latestRun) && `${latestRun.provider} · ${runAccountText(latestRun)}`;
  return <section className="conversation-header"><div className="conversation-symbol"><ChatCircle weight="duotone" /></div><div><h1>{conversation?.title ?? "No conversation selected"}</h1><p><GitBranch />{worktree.branch}<span>·</span>{compactPath(worktree.path)}</p></div><div className="conversation-meta">{conversation && <button type="button" onClick={onManage} aria-label={`Conversation settings · ${conversation.provider}`}><span>{conversation.provider}</span><PencilSimple /></button>}{latestAccount && <small className="conversation-account" title={latestAccount}>{latestAccount}</small>}{latestRun && <small>{runSummary(latestRun, latestPending)}</small>}{earlierPending > 0 && <small>{earlierPending} earlier outcome{earlierPending === 1 ? "" : "s"} pending</small>}</div></section>;
}
function Message({ message, conversationId, runAccount }) {
  const [bodyPage, setBodyPage] = useState(null);
  const [bodyError, setBodyError] = useState("");
  const [bodyLoading, setBodyLoading] = useState(false);
  const bodyRequestRef = useRef(null);
  useEffect(() => () => bodyRequestRef.current?.abort(), []);
  async function readBody(offset) {
    bodyRequestRef.current?.abort();
    const controller = new AbortController();
    bodyRequestRef.current = controller;
    setBodyLoading(true);
    setBodyError("");
    try {
      const page = await api(query(`/api/conversations/${conversationId}/messages/${encodeURIComponent(message.id)}/body`, { offset }), { signal: controller.signal });
      if (!controller.signal.aborted) setBodyPage(page);
    } catch (error) {
      if (!controller.signal.aborted) setBodyError(error.message);
    } finally {
      if (bodyRequestRef.current === controller) { bodyRequestRef.current = null; setBodyLoading(false); }
    }
  }
  const user = message.role === "user";
  const bodyReader = message.findExcerpt && <div className="message-full-reader"><button type="button" onClick={() => readBody(bodyPage?.offset ?? 0)} disabled={bodyLoading}>{bodyPage ? "Reload this section" : "Read full message"}</button>{bodyPage && <><p>Bytes {bodyPage.offset + 1}–{bodyPage.nextOffset} of {bodyPage.totalBytes}</p><pre tabIndex={0} aria-label="Full message section">{bodyPage.body}</pre><div><button type="button" disabled={bodyLoading || bodyPage.offset === 0} onClick={() => readBody(Math.max(0, bodyPage.offset - 65536))}>Previous section</button><button type="button" disabled={bodyLoading || !bodyPage.hasMore} onClick={() => readBody(bodyPage.nextOffset)}>Next section</button></div></>}{bodyLoading && <span role="status">Loading message section…</span>}{bodyError && <span role="alert">{bodyError}</span>}</div>;
  if (message.kind === "tool") return <article className="message is-agent is-tool" data-message-id={message.id}><div className="avatar"><CheckCircle weight="fill" /></div><div className="message-body"><p className="message-text">{message.body}</p>{bodyReader}</div></article>;
  return <article className={`message ${user ? "is-user" : "is-agent"}`} data-message-id={message.id}><div className="avatar">{user ? "Y" : <Sparkle weight="fill" />}</div><div className="message-body"><div className="message-meta"><strong>{user ? "You" : "Outright"}</strong><time>{formatTime(message.createdAt)}</time></div><p className="message-text">{message.body}</p>{bodyReader}{message.payload?.runId && <small className="message-run">{message.payload.provider}{runAccount ? ` · ${runAccount}` : ""} · {message.payload.runId.slice(0, 8)}</small>}</div></article>;
}
function StreamingMessage({ text, events, busy }) { return <article className="message is-agent is-streaming" aria-busy={busy}><div className="avatar"><Sparkle weight="fill" /></div><div className="message-body"><div className="message-meta"><strong>Outright</strong><span className="typing-dot" aria-hidden="true" /></div><p className="message-text">{text}</p><ToolActivity events={events} /></div></article>; }
function RunningMessage({ run, events, outcomePending = false, busy }) {
  let activityText = "Working in this worktree…";
  if (run.status === "queued") activityText = "Waiting for an execution slot…";
  if (outcomePending) activityText = "Waiting for storage to save the final result…";
  return <article className="message is-agent is-streaming" aria-busy={busy}><div className="avatar"><Sparkle weight="fill" /></div><div className="message-body"><div className="message-meta"><strong>Outright</strong><span className="typing-dot" aria-hidden="true" /></div><p className="thinking-copy">{activityText}</p><ToolActivity events={events} /></div></article>;
}
// Interrupted runs surface here until the operator picks a continuation
// policy; the preserved partial output stays visible above the notice.
function RecoveryNotice({ run, conversation, recoveryConversation, onOpenRecovery, onResolve }) {
  const evidenceUnreadable = run.recoveryClass?.startsWith("outcome-unreadable-");
  const classCopy = {
    "never-started": "it was still queued, so no provider process started and no side effects happened",
    exited: "its provider process exited during the restart; partial side effects may exist in the worktree",
    alive: "its provider process was still running after the restart and is no longer supervised; partial side effects may exist",
    unknown: "the provider process state could not be determined; partial side effects may exist",
  }[run.recoveryClass ?? "unknown"];
  // `||`, not `??`: an empty-string conversation session must not hide a
  // session still recorded on the interrupted run.
  const ownsRecovery = recoveryBelongsToConversation(run, conversation);
  const owner = ownsRecovery ? conversation : recoveryConversation;
  const sessionId = run.providerSessionId || (owner?.provider === run.provider ? owner?.providerSessionId : null);
  const action = recoveryNoticeAction(run, conversation);
  const title = action === "discard-unverifiable"
    ? "Unverifiable legacy recovery requires cleanup"
    : ownsRecovery ? "Run interrupted by a runtime restart" : `Recovery required in ${owner?.title ?? "another chat"}`;
  let copy;
  if (action === "discard-unverifiable") {
    copy = "Outright cannot verify this legacy provider or its original worktree. After checking outside Outright that it is no longer running, discard only this recovery record to release its gate.";
  } else if (ownsRecovery && evidenceUnreadable) {
    copy = "The final result is temporarily unreadable. Outright is protecting its recovery record. Retry a decision after storage recovers; a valid result will be replayed before any new work starts.";
  } else if (ownsRecovery) {
    copy = `Reconciliation found ${classCopy}. Review the preserved partial output above, then choose how to continue before anything is retried.`;
  } else {
    copy = "Another chat in this worktree owns an interrupted run. Open it to inspect the preserved output and choose an explicit continuation policy.";
  }
  return <div className="recovery-notice" role="alert"><WarningCircle weight="fill" /><div className="recovery-copy"><strong>{title}</strong><p>{copy}</p></div><div className="recovery-actions">{action === "discard-unverifiable" ? <Button size="sm" variant="destructive" onClick={() => onResolve(run, "discard-unverifiable")}>Discard legacy record</Button> : action === "owner" ? <><Button size="sm" disabled={!sessionId} onClick={() => onResolve(run, "resume-session")}><ArrowsClockwise />Resume session</Button><Button size="sm" variant="outline" onClick={() => onResolve(run, "retry")}>Retry from scratch</Button><Button size="sm" variant="ghost" onClick={() => onResolve(run, "discard")}>Discard</Button></> : <Button size="sm" onClick={onOpenRecovery}><ChatCircle />Open recovery chat</Button>}</div></div>;
}
function ToolActivity({ events }) { if (!events.length) return null; return <div className="tool-activity">{events.slice(-4).map((event) => <div key={event.id}><CheckCircle /><span>{toolLabel(event)}</span></div>)}</div>; }
function EmptyChat({ worktree, onCreate }) { return <div className="empty-chat"><ChatCircle size={29} /><h2>Start in {worktree.name}</h2><p>Create a durable conversation, then run Codex or Claude directly in this worktree.</p><Button onClick={onCreate}><Plus />New chat</Button></div>; }
function WorktreeState({ worktree }) { if (worktree.isPrunable) return <span className="worktree-state warning"><WarningCircle />stale</span>; if (worktree.changedCount) return <span className="worktree-state warning"><GitDiff />{worktree.changedCount} changed</span>; return <span className="worktree-state clean"><Check />clean</span>; }
function runAnnouncementText(run, outcomePending) {
  if (!run) return "";
  if (outcomePending) return "Saving final run outcome";
  if (run.status === "interrupted") return "Run interrupted; recovery decision required";
  return `Run ${run.status}`;
}
function RunState({ run, outcomePending = false }) {
  if (!run) return null;
  const running = ["queued", "launching", "running"].includes(run.status);
  const pendingDecision = run.status === "interrupted" && !run.recoveryDecision;
  let dotState = "error";
  if (running || pendingDecision) dotState = "demo";
  else if (run.status === "completed") dotState = "live";
  return <span className={`run-state ${run.status}`} title={pendingDecision ? "Restart interrupted this run; choose a continuation below" : undefined}><span className={`status-dot ${dotState}`} aria-hidden="true" />{outcomePending ? "outcome pending" : run.status}{run.transcriptOmitted ? " · output omitted" : ""}{run.costUsd != null && <small>${Number(run.costUsd).toFixed(3)}</small>}</span>;
}
function GitHealth({ worktree }) { if (worktree.isPrunable) return <span className="git-health warning"><WarningCircle /></span>; if (worktree.changedCount) return <span className="git-health warning"><span className="status-dot demo" />{worktree.changedCount}</span>; return <span className="git-health clean"><Check /></span>; }
function TemplateMenu({ templates, onSelect }) { if (!templates.length) return null; return <DropdownMenu><DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Prompt templates" />}><ClockCounterClockwise /></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuGroup><DropdownMenuLabel>Prompt templates</DropdownMenuLabel>{templates.map((template) => <DropdownMenuItem key={template.id} onClick={() => onSelect(template.prompt)}>{template.title}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu>; }
// Only a known theme name is read from or written to storage.
const THEMES = Object.freeze({ light: "light", dark: "dark", system: "system" });
function knownTheme(value) { return Object.hasOwn(THEMES, value) ? THEMES[value] : THEMES.system; }
function ThemeMenu({ theme, onThemeChange }) { const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Desktop; return <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Change theme" />}><Icon /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuLabel>Appearance</DropdownMenuLabel></DropdownMenuGroup><DropdownMenuRadioGroup value={theme} onValueChange={onThemeChange}><DropdownMenuRadioItem value="system"><Desktop />System</DropdownMenuRadioItem><DropdownMenuRadioItem value="light"><Sun />Light</DropdownMenuRadioItem><DropdownMenuRadioItem value="dark"><Moon />Dark</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>; }
function SimpleDialog({ open, onOpenChange, title, description, onSubmit, submit, disabled, children }) { return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><form className="dialog-form" onSubmit={onSubmit}><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>{children}<DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={disabled}>{submit}</Button></DialogFooter></form></DialogContent></Dialog>; }
function LoadingScreen({ isScanning, error, onRetry }) { return <div className="loading-screen" role="status" aria-live="polite"><span className="brand-glyph"><Sparkle weight="fill" /></span><h1>Outright</h1>{error ? <><p role="alert">{error}</p><Button onClick={onRetry}>Retry</Button></> : <p>{isScanning ? "Starting the local runtime…" : "No projects found"}</p>}</div>; }
// Pre-spaces runtimes return only `projectGroups` and serve only the group
// routes; read and write through them for one release.
function spaceState(spaces, legacy) { if (spaces) return spaces; return legacy ? { spaces: legacy.groups, memberships: legacy.memberships } : { spaces: [], memberships: {} }; }
function spaceRoutes(bootstrap) { return bootstrap?.spaces || !bootstrap?.projectGroups ? { list: "/api/spaces", memberships: "/api/space-memberships", field: "spaceId", key: "spaces" } : { list: "/api/groups", memberships: "/api/project-memberships", field: "groupId", key: "projectGroups" }; }
function buildSpaceProjects(projects, state) { const result = state.spaces.map((space) => ({ ...space, projects: projects.filter((project) => state.memberships[project.id] === space.id) })); const ungrouped = projects.filter((project) => !state.spaces.some((space) => space.id === state.memberships[project.id])); return ungrouped.length ? [...result, { id: "ungrouped", name: "Ungrouped", projects: ungrouped }] : result; }
function preferredWorktree(project) { return project.worktrees.find((item) => item.name === "dev" || item.path.endsWith("-dev")) ?? project.worktrees.find((item) => item.branch === "next") ?? project.worktrees[0]; }
function compactPath(value = "") { return value.replace(/^\/Users\/[^/]+/, "~"); }
function defaultSettings() { return { provider: "codex", model: "", reasoningEffort: "medium", approvalPolicy: "workspace-write", editor: "zed", notifications: true, maxConcurrentRuns: 3 }; }
function focusableElements(container) { return container ? [...container.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter((element) => element.getClientRects().length && element.getAttribute("aria-hidden") !== "true") : []; }

function requestNotificationPermission() {
  // The microtask also turns older browsers' synchronous throws into a
  // rejection, so both failure paths are handled by the same promise chain.
  void Promise.resolve().then(() => Notification.requestPermission()).catch(() => {});
}
function boundStreamingText(value) { return value.length > MAX_STREAMING_CHARACTERS ? `${value.slice(0, MAX_STREAMING_CHARACTERS)}${LIVE_TRUNCATION_MARKER}` : value; }

function boundPageMessage(message, matchNeedle = "") {
  const body = String(message.body ?? "");
  let bounded = message;
  // HTTP pages apply the same ceiling before hydration. Live events and
  // buffered replay must not bypass the retained 1000-row memory bound.
  if (body.length > 16_000) {
    const foldedIndex = matchNeedle ? foldFindText(body).indexOf(foldFindText(matchNeedle)) : -1;
    if (foldedIndex >= 0) {
      // Find may return a server excerpt centered on a match far from both
      // ends. Keep that context when applying the smaller client heap cap.
      let originalIndex = 0;
      let foldedPosition = 0;
      for (const point of body) {
        if (foldedPosition >= foldedIndex) break;
        foldedPosition += foldFindText(point).length;
        originalIndex += point.length;
      }
      let start = Math.max(0, originalIndex - 7_500);
      if (start && /[\uDC00-\uDFFF]/.test(body[start])) start -= 1;
      let end = Math.min(body.length, start + 15_000);
      if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1])) end -= 1;
      bounded = { ...bounded, body: `${start ? "[Earlier text omitted from this page]\n" : ""}${body.slice(start, end)}${end < body.length ? "\n[Later text omitted from this page]" : ""}`, findExcerpt: true };
    } else {
      const prefix = body.slice(0, 8_000).replace(/[\uD800-\uDBFF]$/, "");
      const suffix = body.slice(-8_000).replace(/^[\uDC00-\uDFFF]/, "");
      bounded = { ...bounded, body: `${prefix}\n[Middle text omitted from this page]\n${suffix}`, findExcerpt: true };
    }
  }
  if (message.payload && JSON.stringify(message.payload).length > 32_000) {
    bounded = { ...bounded, payload: { runId: message.payload.runId, provider: message.payload.provider,
      checkpointEventSeq: message.payload.checkpointEventSeq }, payloadOmitted: true };
  }
  return bounded;
}

function emptyLiveDeltaEvents(runId = null) { return { runId, events: [], start: 0, bytes: 0, omittedThroughSeq: 0 }; }

function appendLiveDeltaEvent(state, event) {
  state.events.push(event);
  state.bytes += JSON.stringify(event).length * 2;
  while (state.bytes > MAX_PENDING_RUNTIME_EVENT_BYTES / 2 && state.events.length - state.start > 1) {
    const removed = state.events[state.start++];
    state.bytes -= JSON.stringify(removed).length * 2;
    state.omittedThroughSeq = Number.isSafeInteger(removed.payload?.seq)
      ? Math.max(state.omittedThroughSeq, removed.payload.seq) : Number.POSITIVE_INFINITY;
  }
  if (state.start > 128 && state.start * 2 > state.events.length) {
    state.events = state.events.slice(state.start);
    state.start = 0;
  }
  return state;
}

function boundedLiveDeltaEvents(runId, events, omittedThroughSeq = 0) {
  const state = emptyLiveDeltaEvents(runId);
  state.omittedThroughSeq = omittedThroughSeq;
  for (const event of events) appendLiveDeltaEvent(state, event);
  return state;
}

function readingLiveCheckpoint(message) {
  const body = String(message.body ?? "");
  return { runId: message.payload.runId, seq: message.payload.checkpointEventSeq ?? 0,
    text: body.slice(-MAX_READING_LIVE_PREVIEW_CHARACTERS), truncated: body.length > MAX_READING_LIVE_PREVIEW_CHARACTERS };
}

function readingLivePreview(checkpoint, suffix) {
  if (!checkpoint?.text && !suffix) return "";
  const text = `${checkpoint?.text ?? ""}${suffix.slice(-MAX_READING_LIVE_PREVIEW_CHARACTERS)}`;
  const truncated = Boolean(checkpoint?.truncated) || text.length > MAX_READING_LIVE_PREVIEW_CHARACTERS
    || suffix.length > MAX_READING_LIVE_PREVIEW_CHARACTERS;
  const visible = text.slice(-MAX_READING_LIVE_PREVIEW_CHARACTERS);
  return truncated ? `[Earlier live output omitted]\n${visible}` : visible;
}
function formatTime(value) { return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function runSummary(run, outcomePending = false) {
  const tokens = Number(run.inputTokens ?? 0) + Number(run.outputTokens ?? 0);
  const omission = run.transcriptOmitted ? " · output omitted" : "";
  const tokenSummary = tokens ? ` · ${tokens.toLocaleString()} tokens` : "";
  const costSummary = run.costUsd == null ? "" : ` · $${Number(run.costUsd).toFixed(3)}`;
  return `${outcomePending ? "outcome pending" : run.status}${omission}${tokenSummary}${costSummary}`;
}
function toolLabel(event) { const item = event.payload?.item ?? {}; return item.command || item.name || item.type || (event.type === "tool.started" ? "Tool started" : "Tool completed"); }
