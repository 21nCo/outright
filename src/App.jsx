import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Archive, ArrowsClockwise, At, Bell, CaretDown, CaretRight, ChatCircle,
  Check, CheckCircle, ClockCounterClockwise, Command, Desktop, DotsThree,
  FolderOpen, FolderPlus, Folders, GearSix, GitBranch, GitDiff, Info,
  MagnifyingGlass, Moon, PaperPlaneTilt, PencilSimple, PushPin, Plus,
  ShieldCheck, SidebarSimple, Sparkle, Stop, Sun, TerminalWindow, Trash,
  TreeStructure, WarningCircle, X,
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
import { CommandPalette } from "@/components/CommandPalette";
import { ContextPane } from "@/components/ContextPane";
import { SettingsDialog } from "@/components/SettingsDialog";
import { TerminalPane } from "@/components/TerminalPane";
import { domId, nextTabIndex } from "@/lib/accessibility";
import { api, connectRuntime, query } from "@/lib/runtime-api";
import { bufferConversationRuntimeEvent, checkpointCursors, draftAfterSubmission, isComposerSubmitKey, isStaleCheckpointMessage, recordCheckpointCursor, recoveryBelongsToConversation, recoveryGate, recoveryNoticeAction, replayConversationEvents, shouldReloadConversationForResolvedRun, streamingTextAfterRuntimeEvent, upsertRuntimeMessage } from "@/recovery-policy";

const MAX_RENDERED_MESSAGES = 1000;
const MAX_STREAMING_CHARACTERS = 1024 * 1024;
const MAX_PENDING_RUNTIME_EVENT_BYTES = 2 * 1024 * 1024;
const LIVE_TRUNCATION_MARKER = "\n\n[Live output truncated]";

export function App() {
  const [bootstrap, setBootstrap] = useState(null);
  const [selectedProjectId, setSelectedProjectId] = useState(() => localStorage.getItem("outright.selected-project") || "");
  const [selectedWorktreeId, setSelectedWorktreeId] = useState(() => localStorage.getItem("outright.selected-worktree") || "");
  const [selectedConversationId, setSelectedConversationId] = useState(() => localStorage.getItem("outright.selected-conversation") || "");
  const [conversations, setConversations] = useState([]);
  const [conversation, setConversation] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState({});
  const [expandedProjects, setExpandedProjects] = useState({});
  const [draft, setDraft] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [runEvents, setRunEvents] = useState([]);
  const [runtimeEvent, setRuntimeEvent] = useState(null);
  const [connection, setConnection] = useState("connecting");
  const [isScanning, setIsScanning] = useState(true);
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === "undefined" || !window.matchMedia("(max-width: 760px)").matches);
  const [inspector, setInspector] = useState(null);
  const [theme, setTheme] = useState(() => localStorage.getItem("outright.theme") || "system");
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatTitle, setNewChatTitle] = useState("");
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [trustRequest, setTrustRequest] = useState(null);
  const [pendingPrompt, setPendingPrompt] = useState(null);
  const [manageChatOpen, setManageChatOpen] = useState(false);
  const [chatDraft, setChatDraft] = useState({ title: "", providerSessionId: "", provider: "codex", model: "", destination: "" });
  const [worktreeDialog, setWorktreeDialog] = useState(null);
  const [worktreeDraft, setWorktreeDraft] = useState({ branch: "", name: "", baseBranch: "HEAD" });
  const [removeWorktreeOpen, setRemoveWorktreeOpen] = useState(false);
  const [removeConfirmation, setRemoveConfirmation] = useState("");
  const socketRef = useRef(null);
  const selectedConversationRef = useRef("");
  const selectedProjectRef = useRef(selectedProjectId);
  const selectedWorktreeRef = useRef(selectedWorktreeId);
  const pendingConversationRef = useRef("");
  const dragConversationRef = useRef("");
  const runtimeHandlerRef = useRef(null);
  const messageViewportRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const pendingPrependScrollRef = useRef(null);
  const sidebarRef = useRef(null);
  const sidebarFocusIntentRef = useRef(null);
  const inspectorRef = useRef(null);
  const inspectorInvokerRef = useRef(null);
  const inspectorReturnFocusRef = useRef(null);
  const submissionPendingRef = useRef(false);
  const checkpointCursorsRef = useRef(new Map());
  const pendingConversationLoadRef = useRef(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const loadBootstrap = useCallback(async (manual = false) => {
    setIsScanning(true);
    try {
      const next = await api(manual ? "/api/projects" : "/api/bootstrap", manual ? { method: "POST" } : undefined);
      if (manual) setBootstrap((current) => ({ ...current, ...next }));
      else setBootstrap(next);
      if (manual) setToast(`Found ${next.projects.length} Git projects`);
    } catch (nextError) { setError(nextError.message); }
    finally { setIsScanning(false); }
  }, []);

  useEffect(() => { loadBootstrap(); }, [loadBootstrap]);
  useEffect(() => {
    if (!bootstrap?.projects.length) return;
    const project = bootstrap.projects.find((item) => item.id === selectedProjectId) ?? bootstrap.projects.find((item) => item.name === "superfunctions") ?? bootstrap.projects[0];
    const worktree = project.worktrees.find((item) => item.id === selectedWorktreeId) ?? preferredWorktree(project);
    setSelectedProjectId(project.id); setSelectedWorktreeId(worktree.id);
    setExpandedProjects((current) => ({ ...current, [project.id]: true }));
  }, [bootstrap?.projects, selectedProjectId, selectedWorktreeId]);

  const project = bootstrap?.projects.find((item) => item.id === selectedProjectId);
  const worktree = project?.worktrees.find((item) => item.id === selectedWorktreeId);
  const groups = bootstrap?.projectGroups ?? { groups: [], memberships: {} };
  const groupedProjects = useMemo(() => buildGroupedProjects(bootstrap?.projects ?? [], groups), [bootstrap?.projects, groups]);
  const settings = bootstrap?.settings ?? defaultSettings();
  const providers = bootstrap?.providers ?? [];
  const templates = bootstrap?.templates ?? [];
  const handleError = useCallback((nextError) => setError(nextError.message), []);

  const loadConversations = useCallback(async (preferredId) => {
    if (!project || !worktree) return;
    const forProjectId = project.id;
    const forWorktreeId = worktree.id;
    try {
      const result = await api(query("/api/conversations", { projectId: forProjectId, worktreeId: forWorktreeId }));
      // A slower response from a previous selection must not overwrite the
      // conversations of the worktree the user has since switched to.
      if (selectedProjectRef.current !== forProjectId || selectedWorktreeRef.current !== forWorktreeId) return;
      setConversations(result.conversations);
      const wanted = preferredId || pendingConversationRef.current || selectedConversationRef.current;
      const selected = result.conversations.find((item) => item.id === wanted) ?? result.conversations[0];
      pendingConversationRef.current = "";
      selectedConversationRef.current = selected?.id ?? "";
      setSelectedConversationId(selected?.id ?? "");
    } catch (nextError) { setError(nextError.message); }
  }, [project?.id, worktree?.id]);

  useEffect(() => { setSelectedConversationId(""); setConversation(null); loadConversations(); }, [project?.id, worktree?.id, loadConversations]);
  useLayoutEffect(() => { selectedConversationRef.current = selectedConversationId; }, [selectedConversationId]);
  useLayoutEffect(() => { selectedProjectRef.current = selectedProjectId; }, [selectedProjectId]);
  useLayoutEffect(() => { selectedWorktreeRef.current = selectedWorktreeId; }, [selectedWorktreeId]);
  useEffect(() => { if (selectedProjectId) localStorage.setItem("outright.selected-project", selectedProjectId); }, [selectedProjectId]);
  useEffect(() => { if (selectedWorktreeId) localStorage.setItem("outright.selected-worktree", selectedWorktreeId); }, [selectedWorktreeId]);
  useEffect(() => { if (selectedConversationId) localStorage.setItem("outright.selected-conversation", selectedConversationId); }, [selectedConversationId]);
  const loadConversation = useCallback(async () => {
    if (!selectedConversationId || !conversations.some((item) => item.id === selectedConversationId)) {
      pendingConversationLoadRef.current?.controller?.abort();
      pendingConversationLoadRef.current = null;
      setConversation(null);
      return;
    }
    const requestedId = selectedConversationId;
    pendingConversationLoadRef.current?.controller?.abort();
    const controller = new AbortController();
    const pendingLoad = { conversationId: requestedId, events: [], eventBytes: 0, overflowed: false, controller };
    pendingConversationLoadRef.current = pendingLoad;
    try {
      const nextConversation = await api(`/api/conversations/${requestedId}`, { signal: controller.signal });
      // Stale responses from an earlier selection are discarded before they
      // can associate the composer or execution state with the wrong worktree.
      if (selectedConversationRef.current !== requestedId) return;
      if (nextConversation.projectId !== selectedProjectRef.current || nextConversation.worktreeId !== selectedWorktreeRef.current) return;
      if (pendingConversationLoadRef.current !== pendingLoad) return;
      pendingConversationLoadRef.current = null;
      const replayed = replayConversationEvents(nextConversation.messages, pendingLoad.events, MAX_RENDERED_MESSAGES);
      stickToBottomRef.current = true;
      checkpointCursorsRef.current = replayed.cursors;
      setConversation({
        ...nextConversation,
        messages: replayed.messages,
        messagePage: {
          ...nextConversation.messagePage,
          hasMore: Boolean(nextConversation.messagePage?.hasMore || replayed.dropped),
          olderCount: (nextConversation.messagePage?.olderCount ?? 0) + replayed.dropped,
          beforeId: replayed.messages[0]?.id ?? null,
        },
      });
      setStreamingText(boundStreamingText(replayed.streamingText));
      setRunEvents(replayed.runEvents);
      window.requestAnimationFrame(() => {
        const viewport = messageViewportRef.current;
        if (viewport) viewport.scrollTop = viewport.scrollHeight;
      });
    }
    catch (nextError) {
      if (pendingConversationLoadRef.current === pendingLoad) pendingConversationLoadRef.current = null;
      if (nextError.name !== "AbortError") setError(nextError.message);
    }
  }, [selectedConversationId, conversations]);
  useEffect(() => { loadConversation(); }, [loadConversation]);
  const selectedRecoveryRunId = recoveryGate(conversation)?.id ?? null;

  const handleRuntimeEvent = useCallback((event) => {
    setRuntimeEvent(event);
    const pendingLoad = pendingConversationLoadRef.current;
    if (["message.created", "run.event"].includes(event.type)
      && bufferConversationRuntimeEvent(pendingLoad, event, MAX_PENDING_RUNTIME_EVENT_BYTES) === "overflow") {
      // Discard the stale response and immediately request a newer bounded
      // snapshot. Clearing first ensures subsequent events cannot grow the
      // overflowing buffer while the microtask schedules its replacement.
      pendingLoad.controller.abort();
      if (pendingConversationLoadRef.current === pendingLoad) pendingConversationLoadRef.current = null;
      queueMicrotask(loadConversation);
    }
    if (event.type === "projects.changed") {
      const payload = event.payload.projects ? event.payload : { projects: event.payload };
      setBootstrap((current) => current ? { ...current, ...payload } : current);
    }
    if (event.type === "runtime.connected" && (event.payload?.replay?.missed || event.payload?.restarted)) {
      loadBootstrap();
      loadConversation();
    }
    if (event.type === "conversation.created" || event.type === "conversation.updated") loadConversations(event.conversationId);
    if (shouldReloadConversationForResolvedRun(event, selectedConversationRef.current, selectedRecoveryRunId)) loadConversation();
    if (event.type === "message.created" && event.conversationId === selectedConversationRef.current) {
      if (isStaleCheckpointMessage(checkpointCursorsRef.current, event.payload)) return;
      recordCheckpointCursor(checkpointCursorsRef.current, event.payload);
      setStreamingText((current) => streamingTextAfterRuntimeEvent(current, event));
      setConversation((current) => {
        if (!current) return current;
        const alreadyPresent = current.messages.some((message) => message.id === event.payload.id);
        const total = (current.messagePage?.total ?? current.messages.length) + (alreadyPresent ? 0 : 1);
        if (current.messagePage?.hasLater) return {
          ...current,
          messagePage: { ...current.messagePage, total, newerCount: (current.messagePage.newerCount ?? 0) + (alreadyPresent ? 0 : 1) },
        };
        const merged = upsertRuntimeMessage(current.messages, event.payload);
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
      if (runEvent.type === "assistant.delta") {
        const checkpointEventSeq = checkpointCursorsRef.current.get(event.runId) ?? 0;
        setStreamingText((current) => current.endsWith(LIVE_TRUNCATION_MARKER) ? current : boundStreamingText(streamingTextAfterRuntimeEvent(current, event, checkpointEventSeq)));
      }
      if (runEvent.type === "assistant.message") setStreamingText((current) => streamingTextAfterRuntimeEvent(current, event));
      if (runEvent.type.startsWith("tool.")) setRunEvents((current) => [...current, runEvent].slice(-20));
      if (["run.completed", "run.failed", "run.stopped"].includes(runEvent.type)) {
        window.setTimeout(loadConversation, 80);
        if (document.hidden && settings.notifications && Notification.permission === "granted") new Notification(`Outright run ${runEvent.type.split(".")[1]}`, { body: conversation?.title ?? "Agent run" });
      }
    }
  }, [loadConversation, loadConversations, settings.notifications, conversation?.title, selectedRecoveryRunId]);
  runtimeHandlerRef.current = handleRuntimeEvent;

  useEffect(() => {
    const connectionInstance = connectRuntime((event) => runtimeHandlerRef.current?.(event), setConnection);
    socketRef.current = connectionInstance;
    return () => connectionInstance.close();
  }, []);
  const sendRuntime = useCallback((message) => socketRef.current?.send(message), []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { const dark = theme === "dark" || (theme === "system" && media.matches); document.documentElement.classList.toggle("dark", dark); document.documentElement.style.colorScheme = dark ? "dark" : "light"; };
    apply(); localStorage.setItem("outright.theme", theme); media.addEventListener("change", apply); return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    const keyboard = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(true); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); setNewChatOpen(true); }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        inspectorInvokerRef.current = document.querySelector('[aria-label="Terminal"]');
        setInspector("terminal");
      }
      if (event.key === "Escape" && !document.querySelector('[role="dialog"]:not(#project-sidebar)')) {
        if (isNarrow && sidebarOpen) closeSidebar();
        else if (inspector) closeInspector();
      }
    };
    window.addEventListener("keydown", keyboard); return () => window.removeEventListener("keydown", keyboard);
  }, [inspector, isNarrow, sidebarOpen]);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 760px)");
    let wasNarrow = narrow.matches;
    const synchronizeLayout = () => {
      if (narrow.matches === wasNarrow) return;
      wasNarrow = narrow.matches;
      const activeElement = document.activeElement;
      sidebarFocusIntentRef.current = wasNarrow
        ? (sidebarRef.current?.contains(activeElement) ? "opener" : null)
        : (activeElement?.matches?.('[aria-label="Open projects sidebar"]') ? "sidebar" : null);
      setIsNarrow(wasNarrow);
      setSidebarOpen(!wasNarrow);
    };
    narrow.addEventListener("change", synchronizeLayout);
    window.addEventListener("resize", synchronizeLayout);
    return () => {
      narrow.removeEventListener("change", synchronizeLayout);
      window.removeEventListener("resize", synchronizeLayout);
    };
  }, []);
  useLayoutEffect(() => {
    if (!isNarrow || !sidebarOpen) return;
    const sidebar = sidebarRef.current;
    if (!sidebar?.contains(document.activeElement)) sidebar?.focus();
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
    return () => sidebar?.removeEventListener("keydown", containFocus);
  }, [isNarrow, sidebarOpen]);
  useLayoutEffect(() => {
    const intent = sidebarFocusIntentRef.current;
    if (intent === "opener") {
      if (sidebarOpen) return;
      sidebarFocusIntentRef.current = null;
      document.querySelector('[aria-label="Open projects sidebar"]')?.focus({ preventScroll: true });
      return;
    }
    if (intent === "sidebar") {
      if (!sidebarOpen) return;
      sidebarFocusIntentRef.current = null;
      sidebarRef.current?.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    }
  }, [isNarrow, sidebarOpen]);
  useLayoutEffect(() => {
    if (!inspector) return;
    inspectorRef.current?.querySelector('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }, [inspector]);
  useLayoutEffect(() => {
    if (inspector || !inspectorReturnFocusRef.current) return;
    const invoker = inspectorReturnFocusRef.current;
    inspectorReturnFocusRef.current = null;
    if (invoker.isConnected) invoker.focus({ preventScroll: true });
  }, [inspector]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 2800); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (!error) return; const timer = setTimeout(() => setError(""), 6000); return () => clearTimeout(timer); }, [error]);
  useEffect(() => {
    const viewport = messageViewportRef.current;
    if (!viewport) return;
    const updateStickiness = () => { stickToBottomRef.current = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 96; };
    viewport.addEventListener("scroll", updateStickiness, { passive: true });
    return () => viewport.removeEventListener("scroll", updateStickiness);
  }, [conversation?.id]);
  useLayoutEffect(() => {
    const pending = pendingPrependScrollRef.current;
    const viewport = messageViewportRef.current;
    if (!pending || !viewport) return;
    const restoreAnchor = () => {
      const anchor = [...viewport.querySelectorAll("[data-message-id]")].find((element) => element.dataset.messageId === pending.messageId);
      if (anchor) viewport.scrollTop += anchor.getBoundingClientRect().top - pending.top;
    };
    restoreAnchor();
    const firstFrame = window.requestAnimationFrame(() => {
      restoreAnchor();
      const secondFrame = window.requestAnimationFrame(() => {
        restoreAnchor();
        pendingPrependScrollRef.current = null;
      });
      pending.cancelSecondFrame = () => window.cancelAnimationFrame(secondFrame);
    });
    return () => { window.cancelAnimationFrame(firstFrame); pending.cancelSecondFrame?.(); };
  }, [conversation?.messages[0]?.id]);
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    window.requestAnimationFrame(() => {
      const viewport = messageViewportRef.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    });
  }, [conversation?.messages.at(-1)?.id, streamingText]);

  const activeRun = conversation?.runs?.find((run) => ["queued", "launching", "running"].includes(run.status));
  const latestRun = conversation?.runs?.[0];
  // Worktree-wide recovery metadata gates sibling chats before submission;
  // the conversation-local values remain fallbacks for older runtimes.
  const interruptedRun = recoveryGate(conversation);
  const recoveryConversation = conversation?.recoveryConversation ?? null;

  async function resolveRecovery(run, policy) {
    try {
      if (policy === "discard-unverifiable" && !window.confirm("Only continue after you have verified outside Outright that the legacy provider is no longer running. Discard this unverifiable recovery record?")) return;
      await api(`/api/runs/${run.id}/resume`, { method: "POST", body: { policy, ...(policy === "discard-unverifiable" ? { confirmation: run.id } : {}) } });
      await loadConversation();
    } catch (nextError) {
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
        await loadConversations(recoveryConversation.id);
        return;
      }
      const ownerProject = bootstrap?.projects.find((item) => item.id === recoveryConversation.projectId);
      const ownerWorktree = ownerProject?.worktrees.find((item) => item.id === recoveryConversation.worktreeId);
      if (!ownerProject || !ownerWorktree) throw new Error("The recovery chat worktree is no longer available");
      pendingConversationRef.current = recoveryConversation.id;
      await chooseProject(ownerProject, ownerWorktree);
    } catch (nextError) { setError(nextError.message); }
  }

  async function chooseProject(nextProject, explicitWorktree) {
    const nextWorktree = explicitWorktree ?? preferredWorktree(nextProject);
    selectedProjectRef.current = nextProject.id; selectedWorktreeRef.current = nextWorktree.id; selectedConversationRef.current = "";
    setSelectedProjectId(nextProject.id); setSelectedWorktreeId(nextWorktree.id); setSelectedConversationId("");
    setExpandedProjects((current) => ({ ...current, [nextProject.id]: true }));
    if (isNarrow && sidebarOpen) closeSidebar();
  }

  function closeSidebar() {
    if (!sidebarOpen) return;
    sidebarFocusIntentRef.current = "opener";
    setSidebarOpen(false);
  }

  function openSidebar() {
    if (sidebarOpen) return;
    sidebarFocusIntentRef.current = "sidebar";
    setSidebarOpen(true);
  }

  function toggleInspector(nextInspector, invoker) {
    if (inspector === nextInspector) { closeInspector(); return; }
    inspectorInvokerRef.current = invoker;
    setInspector(nextInspector);
  }

  function closeInspector() {
    inspectorReturnFocusRef.current = inspectorInvokerRef.current;
    inspectorInvokerRef.current = null;
    setInspector(null);
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
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
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
  async function createConversation(title = newChatTitle) {
    if (!project || !worktree) return null;
    try {
      const created = await api("/api/conversations", { method: "POST", body: { projectId: project.id, worktreeId: worktree.id, worktreePath: worktree.path, title: title.trim() || "New agent chat", provider: settings.provider, model: settings.model } });
      if (selectedProjectRef.current !== created.projectId || selectedWorktreeRef.current !== created.worktreeId) return null;
      pendingConversationRef.current = created.id; setNewChatTitle(""); setNewChatOpen(false); await loadConversations(created.id); return created;
    } catch (nextError) { setError(nextError.message); return null; }
  }
  function isSelectedTarget(target) {
    return target?.id === selectedConversationRef.current && target.projectId === selectedProjectRef.current && target.worktreeId === selectedWorktreeRef.current;
  }
  async function sendPrompt(event, promptOverride, targetOverride) {
    event?.preventDefault();
    const submittedDraft = promptOverride ?? draft;
    const prompt = submittedDraft.trim();
    if (!prompt || activeRun || interruptedRun || submissionPendingRef.current) return;
    submissionPendingRef.current = true;
    let target = targetOverride ?? conversation;
    try {
      if (!target) target = await createConversation(prompt.split(/\n/)[0].slice(0, 52));
      if (!target || !isSelectedTarget(target)) return;
      const run = await api(`/api/conversations/${target.id}/runs`, { method: "POST", body: { prompt, provider: target.provider || settings.provider, model: target.model || settings.model, reasoningEffort: settings.reasoningEffort, approvalPolicy: settings.approvalPolicy } });
      if (!isSelectedTarget(target)) return;
      setDraft((current) => draftAfterSubmission(current, submittedDraft)); setStreamingText(""); setRunEvents([]);
      setConversation((current) => {
        if (current && current.id !== target.id) return current;
        const next = current ?? { ...target, messages: [], runs: [] };
        return { ...next, runs: [run, ...(next.runs ?? []).filter((item) => item.id !== run.id)] };
      });
    } catch (nextError) {
      if (!isSelectedTarget(target)) return;
      if (nextError.payload?.code === "PROJECT_TRUST_REQUIRED") { setPendingPrompt({ prompt, target }); setTrustRequest(nextError.payload.project); }
      else {
        if (nextError.payload?.code === "RUN_RECOVERY_REQUIRED") await loadConversation();
        setError(nextError.message);
      }
    }
    finally { submissionPendingRef.current = false; }
  }
  async function trustAndRun() {
    const pending = pendingPrompt;
    if (!pending || !isSelectedTarget(pending.target)) { setTrustRequest(null); setPendingPrompt(null); return; }
    try {
      await api("/api/trust", { method: "POST", body: { projectId: trustRequest.id, projectPath: trustRequest.path, confirmation: trustRequest.path } });
      setBootstrap((current) => ({ ...current, trustedProjects: [...current.trustedProjects, { projectId: trustRequest.id, projectPath: trustRequest.path }] }));
      setTrustRequest(null); setPendingPrompt(null); await sendPrompt(null, pending.prompt, pending.target);
    } catch (nextError) { setError(nextError.message); }
  }
  async function stopRun() { try { await api(`/api/runs/${activeRun.id}/stop`, { method: "POST" }); } catch (nextError) { setError(nextError.message); } }
  async function loadEarlierMessages() {
    if (!conversation?.messagePage?.hasMore || loadingEarlier || !conversation.messages[0]) return;
    const viewport = messageViewportRef.current;
    const anchor = viewport?.querySelector(`[data-message-id="${CSS.escape(conversation.messages[0].id)}"]`);
    pendingPrependScrollRef.current = anchor ? { messageId: conversation.messages[0].id, top: anchor.getBoundingClientRect().top } : null;
    stickToBottomRef.current = false;
    setLoadingEarlier(true);
    try {
      const result = await api(query(`/api/conversations/${conversation.id}/messages`, { before: conversation.messages[0].id, limit: 200 }));
      checkpointCursorsRef.current = checkpointCursors(result.messages, checkpointCursorsRef.current);
      setConversation((current) => {
        if (current?.id !== conversation.id) return current;
        const merged = [...result.messages, ...current.messages];
        const dropped = Math.max(0, merged.length - MAX_RENDERED_MESSAGES);
        return {
          ...current,
          messages: merged.slice(0, MAX_RENDERED_MESSAGES),
          messagePage: {
            ...result.messagePage,
            hasLater: Boolean(current.messagePage?.hasLater || dropped),
            newerCount: current.messagePage?.newerCount ?? 0,
          },
        };
      });
    } catch (nextError) { pendingPrependScrollRef.current = null; setError(nextError.message); }
    finally { setLoadingEarlier(false); }
  }

  async function createGroup(event) { event.preventDefault(); try { await api("/api/groups", { method: "POST", body: { name: newGroupName } }); setNewGroupName(""); setNewGroupOpen(false); await refreshGroups(); setToast("Project group created"); } catch (nextError) { setError(nextError.message); } }
  async function refreshGroups() { const projectGroups = await api("/api/groups"); setBootstrap((current) => ({ ...current, projectGroups })); }
  async function moveProject(projectId, groupId) { try { const projectGroups = await api("/api/project-memberships", { method: "PUT", body: { projectId, groupId } }); setBootstrap((current) => ({ ...current, projectGroups })); setToast("Project group updated"); } catch (nextError) { setError(nextError.message); } }
  async function updateConversation(patch) { try { const updated = await api(`/api/conversations/${conversation.id}`, { method: "PATCH", body: patch }); setConversation((current) => ({ ...current, ...updated })); await loadConversations(updated.id); return updated; } catch (nextError) { setError(nextError.message); return null; } }
  async function archiveConversation() { const updated = await updateConversation({ archived: true }); if (!updated) return; setSelectedConversationId(""); setManageChatOpen(false); }
  async function saveChatSettings(event) {
    event.preventDefault();
    const { destination, ...patch } = chatDraft;
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
      pendingConversationRef.current = moved.id; setManageChatOpen(false); await chooseProject(nextProject, nextWorktree); setToast("Conversation moved");
    } catch (nextError) { setError(nextError.message); }
  }

  async function reorderConversation(targetId) {
    const sourceId = dragConversationRef.current;
    if (!sourceId || sourceId === targetId) return;
    const next = [...conversations];
    const [source] = next.splice(next.findIndex((item) => item.id === sourceId), 1);
    next.splice(next.findIndex((item) => item.id === targetId), 0, source);
    setConversations(next);
    await Promise.all(next.map((item, index) => api(`/api/conversations/${item.id}`, { method: "PATCH", body: { tabPosition: index } })));
  }

  async function createWorktree(event) {
    event.preventDefault();
    try { await api("/api/worktrees", { method: "POST", body: { projectId: worktreeDialog.id, ...worktreeDraft } }); setWorktreeDialog(null); setWorktreeDraft({ branch: "", name: "", baseBranch: "HEAD" }); await loadBootstrap(); setToast("Worktree created"); }
    catch (nextError) { setError(nextError.message); }
  }
  async function removeWorktree() {
    try { await api("/api/worktrees", { method: "DELETE", body: { projectId: project.id, worktreePath: worktree.path, confirmation: removeConfirmation } }); setRemoveWorktreeOpen(false); setRemoveConfirmation(""); setSelectedWorktreeId(""); await loadBootstrap(); setToast("Worktree removed"); }
    catch (nextError) { setError(nextError.message); }
  }
  async function refreshAll(includeTemplates = false) {
    try { const next = await api("/api/bootstrap"); setBootstrap(next); if (includeTemplates) setToast("Templates updated"); } catch (nextError) { setError(nextError.message); }
  }
  function openManageChat() { if (!conversation) return; setChatDraft({ title: conversation.title, providerSessionId: conversation.providerSessionId ?? "", provider: conversation.provider, model: conversation.model ?? "", destination: `${conversation.projectId}::${conversation.worktreeId}` }); setManageChatOpen(true); }

  if (!bootstrap || !project || !worktree) return <LoadingScreen isScanning={isScanning} />;

  return <div className={`app-shell ${sidebarOpen ? "sidebar-is-open" : "sidebar-is-closed"}`}>
    <aside className="sidebar" id="project-sidebar" role={isNarrow && sidebarOpen ? "dialog" : undefined} aria-modal={isNarrow && sidebarOpen ? true : undefined} aria-label="Projects and worktrees" aria-hidden={!sidebarOpen} tabIndex={isNarrow ? -1 : undefined} ref={sidebarRef}>
      <header className="sidebar-brand"><div className="brand-lockup"><span className="brand-glyph"><Sparkle weight="fill" /></span><strong>Outright</strong></div><Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={closeSidebar} aria-label="Close projects sidebar" />}><SidebarSimple /></TooltipTrigger><TooltipContent>Close sidebar</TooltipContent></Tooltip></header>
      <div className="sidebar-actions"><Button className="new-chat-action" onClick={() => setNewChatOpen(true)}><Plus weight="bold" /> New chat <kbd>⌘N</kbd></Button><Button variant="ghost" className="sidebar-action" onClick={() => setCommandOpen(true)}><MagnifyingGlass /> Search <kbd>⌘K</kbd></Button><Button variant="ghost" className="sidebar-action" onClick={() => loadBootstrap(true)}><ArrowsClockwise className={isScanning ? "spin" : ""} /> Scan projects</Button></div>
      <Separator /><div className="project-section-heading"><span>Projects</span><Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-xs" onClick={() => setNewGroupOpen(true)} aria-label="New project group" />}><FolderPlus /></TooltipTrigger><TooltipContent>New project group</TooltipContent></Tooltip></div>
      <ScrollArea className="project-scroll" viewportProps={{ tabIndex: 0, "aria-label": "Project groups, projects, and worktrees", onKeyDown: navigateProjectButtons }}><div className="group-list">{groupedProjects.map((group) => { const isOpen = expandedGroups[group.id] ?? true; return <section className="project-group" key={group.id}><button className="group-heading" aria-expanded={isOpen} onClick={() => setExpandedGroups((current) => ({ ...current, [group.id]: !isOpen }))}>{isOpen ? <CaretDown /> : <CaretRight />}<Folders weight="duotone" /><span>{group.name}</span><small>{group.projects.length}</small></button>{isOpen && group.projects.map((item) => <ProjectTree key={item.id} project={item} activeProjectId={project.id} activeWorktreeId={worktree.id} expanded={expandedProjects[item.id] ?? item.id === project.id} groups={groups.groups} onToggle={() => setExpandedProjects((current) => ({ ...current, [item.id]: !(current[item.id] ?? item.id === project.id) }))} onSelectProject={() => chooseProject(item)} onSelectWorktree={(nextWorktree) => chooseProject(item, nextWorktree)} onMove={(groupId) => moveProject(item.id, groupId)} onCreateWorktree={() => setWorktreeDialog(item)} />)}</section>; })}</div></ScrollArea>
      <footer className="sidebar-footer"><span className={`status-dot ${connection === "connected" ? "live" : "demo"}`} aria-hidden="true" /><span role="status" aria-live="polite">{connection === "connected" ? "Runtime connected" : connection}</span>{bootstrap.truncated ? <small className="scan-limit" title={`Showing ${bootstrap.projects.length} of ${bootstrap.repositoryCount} discovered repositories. Increase maxProjects in outright.config.json to show more.`}><WarningCircle />{bootstrap.projects.length}/{bootstrap.repositoryCount}</small> : <small>{bootstrap.scanDurationMs ? `${Math.round(bootstrap.scanDurationMs)}ms` : ""}</small>}<Button variant="ghost" size="icon-xs" onClick={() => setSettingsOpen(true)} aria-label="Settings"><GearSix /></Button></footer>
    </aside>
    {isNarrow && sidebarOpen && <div className="mobile-scrim" onClick={closeSidebar} aria-hidden="true" />}

    <main id="main-workspace" className={`workspace ${inspector ? "has-inspector" : ""}`} inert={isNarrow && sidebarOpen ? true : undefined} aria-hidden={isNarrow && sidebarOpen ? true : undefined}>
      <header className="workspace-bar">{!sidebarOpen && <Button variant="ghost" size="icon-sm" onClick={openSidebar} aria-label="Open projects sidebar" aria-controls="project-sidebar" aria-expanded={sidebarOpen}><SidebarSimple /></Button>}<div className="workspace-context"><span>{project.name}</span><CaretRight /><GitBranch /><strong>{worktree.name}</strong></div><div className="workspace-tools"><RunState run={activeRun ?? latestRun} /><WorktreeState worktree={worktree} /><Tooltip><TooltipTrigger render={<Button variant={inspector === "changes" ? "secondary" : "ghost"} size="icon-sm" onClick={(event) => toggleInspector("changes", event.currentTarget)} aria-label="Changes" aria-controls="workspace-inspector" aria-expanded={inspector === "changes"} />}><GitDiff /></TooltipTrigger><TooltipContent>Changes</TooltipContent></Tooltip><Tooltip><TooltipTrigger render={<Button variant={inspector === "terminal" ? "secondary" : "ghost"} size="icon-sm" onClick={(event) => toggleInspector("terminal", event.currentTarget)} aria-label="Terminal" aria-controls="workspace-inspector" aria-expanded={inspector === "terminal"} />}><TerminalWindow /></TooltipTrigger><TooltipContent>Terminal ⌘⇧T</TooltipContent></Tooltip><Tooltip><TooltipTrigger render={<Button variant={inspector === "context" ? "secondary" : "ghost"} size="icon-sm" onClick={(event) => toggleInspector("context", event.currentTarget)} aria-label="Project context" aria-controls="workspace-inspector" aria-expanded={inspector === "context"} />}><Info /></TooltipTrigger><TooltipContent>Project context</TooltipContent></Tooltip><ThemeMenu theme={theme} onThemeChange={setTheme} /><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Worktree options" />}><DotsThree weight="bold" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => api("/api/editor/open", { method: "POST", body: { path: worktree.path, editor: settings.editor } }).then(() => setToast(`Opened in ${settings.editor}`)).catch((nextError) => setError(nextError.message))}><PencilSimple />Open in {settings.editor}</DropdownMenuItem><DropdownMenuItem onClick={() => setWorktreeDialog(project)}><GitBranch />New worktree</DropdownMenuItem>{worktree.isLinked && <><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onClick={() => setRemoveWorktreeOpen(true)}><Trash />Remove worktree</DropdownMenuItem></>}</DropdownMenuContent></DropdownMenu></div></header>
      <nav className="chat-tabs" aria-label="Agent chats"><div className="chat-tabs-scroll" role="tablist" aria-label="Open agent chats" aria-orientation="horizontal" onKeyDown={(event) => navigateTabs(event, '[role="tab"]', setSelectedConversationId)}>{conversations.map((item) => <div className={`chat-tab ${item.id === selectedConversationId ? "is-active" : ""}`} key={item.id} draggable onDragStart={() => { dragConversationRef.current = item.id; }} onDragOver={(event) => event.preventDefault()} onDrop={() => reorderConversation(item.id)}><button className="tab-select" id={domId("chat-tab", item.id)} data-tab-id={item.id} role="tab" aria-selected={item.id === selectedConversationId} aria-controls="conversation-panel" tabIndex={item.id === selectedConversationId ? 0 : -1} onClick={() => setSelectedConversationId(item.id)} onDoubleClick={() => { setSelectedConversationId(item.id); window.setTimeout(openManageChat, 0); }}>{item.pinned ? <PushPin weight="fill" /> : <ChatCircle weight={item.id === selectedConversationId ? "fill" : "regular"} />}<span>{item.title}</span></button><button className="tab-close" aria-label={`Archive ${item.title}`} onClick={(event) => { event.stopPropagation(); api(`/api/conversations/${item.id}`, { method: "PATCH", body: { archived: true } }).then(() => loadConversations()).catch((nextError) => setError(nextError.message)); }}><X /></button></div>)}</div><Button variant="ghost" size="icon-sm" className="add-tab" onClick={() => setNewChatOpen(true)} aria-label="New chat tab"><Plus /></Button></nav>
      <div className="work-area">
        <section className="conversation-pane" id="conversation-panel" role="tabpanel" aria-labelledby={selectedConversationId ? domId("chat-tab", selectedConversationId) : undefined}>
          <ConversationHeader conversation={conversation} worktree={worktree} latestRun={latestRun} onManage={openManageChat} />
          <ScrollArea className="message-scroll" viewportRef={messageViewportRef} viewportProps={{ tabIndex: 0, "aria-label": "Conversation messages" }}><div className="message-column">{conversation?.messagePage?.hasMore && <button className="history-loader" onClick={loadEarlierMessages} disabled={loadingEarlier}>{loadingEarlier ? "Loading earlier messages…" : `Load earlier messages · ${conversation.messagePage.olderCount} remaining`}</button>}{conversation?.messages.length ? conversation.messages.map((message) => <Message key={message.id} message={message} />) : <EmptyChat worktree={worktree} onCreate={() => setNewChatOpen(true)} />}{streamingText && <StreamingMessage text={streamingText} events={runEvents} />}{activeRun && !streamingText && <RunningMessage run={activeRun} events={runEvents} />}{conversation?.messagePage?.hasLater && <button className="history-return" onClick={loadConversation}>Return to latest{conversation.messagePage.newerCount ? ` · ${conversation.messagePage.newerCount} new` : ""}</button>}</div></ScrollArea>
          {interruptedRun && <RecoveryNotice run={interruptedRun} conversation={conversation} recoveryConversation={recoveryConversation} onOpenRecovery={openRecoveryConversation} onResolve={resolveRecovery} />}
          <form className="composer" onSubmit={sendPrompt}><textarea aria-label="Message the agent" disabled={Boolean(interruptedRun)} placeholder={interruptedRun ? "Choose how to recover the interrupted run first…" : conversation ? `Ask ${conversation.provider} to work in ${worktree.name}…` : "Create a chat to start an agent…"} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (isComposerSubmitKey(event)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} /><div className="composer-actions"><div><Button type="button" variant="ghost" size="icon-sm" disabled aria-label="Attach files (coming soon)"><Plus /></Button><Button type="button" variant="ghost" size="icon-sm" disabled aria-label="Mention context (coming soon)"><At /></Button><TemplateMenu templates={templates} onSelect={setDraft} /><button type="button" className="model-button" onClick={() => setSettingsOpen(true)} aria-label="Agent provider and model settings"><span className="model-orb" aria-hidden="true" />{conversation?.provider ?? settings.provider}{conversation?.model ? ` · ${conversation.model}` : ""}<CaretDown /></button></div>{activeRun ? <span className="send-hint running" role="status" aria-live="polite"><span className="status-dot demo" aria-hidden="true" />Agent is {activeRun.status}</span> : interruptedRun ? <span className="send-hint running" role="status" aria-live="polite"><WarningCircle aria-hidden="true" />Recovery decision required</span> : <span className="send-hint"><Command /> Enter to send</span>}{activeRun ? <Button size="icon" type="button" variant="destructive" onClick={stopRun} aria-label="Stop active agent run"><Stop weight="fill" /></Button> : <Button size="icon" type="submit" disabled={!draft.trim() || Boolean(interruptedRun)} aria-label="Send message"><PaperPlaneTilt weight="fill" /></Button>}</div></form>
        </section>
        {inspector && <aside className="inspector" id="workspace-inspector" aria-label="Workspace inspector" tabIndex={-1} ref={inspectorRef}><header><nav role="tablist" aria-label="Inspector panels" aria-orientation="horizontal" onKeyDown={(event) => navigateTabs(event, '[role="tab"]', setInspector)}><button id="inspector-tab-changes" data-tab-id="changes" role="tab" className={inspector === "changes" ? "is-active" : ""} aria-selected={inspector === "changes"} aria-controls="inspector-content" tabIndex={inspector === "changes" ? 0 : -1} onClick={() => setInspector("changes")}><GitDiff />Changes</button><button id="inspector-tab-terminal" data-tab-id="terminal" role="tab" className={inspector === "terminal" ? "is-active" : ""} aria-selected={inspector === "terminal"} aria-controls="inspector-content" tabIndex={inspector === "terminal" ? 0 : -1} onClick={() => setInspector("terminal")}><TerminalWindow />Terminal</button><button id="inspector-tab-context" data-tab-id="context" role="tab" className={inspector === "context" ? "is-active" : ""} aria-selected={inspector === "context"} aria-controls="inspector-content" tabIndex={inspector === "context" ? 0 : -1} onClick={() => setInspector("context")}><TreeStructure />Context</button></nav><Button variant="ghost" size="icon-xs" onClick={closeInspector} aria-label="Close inspector"><X /></Button></header><div className="inspector-body" id="inspector-content" role="tabpanel" aria-labelledby={`inspector-tab-${inspector}`}>{inspector === "changes" && <ChangesPane worktree={worktree} runtimeEvent={runtimeEvent} settings={settings} onError={handleError} onToast={setToast} />}{inspector === "terminal" && <TerminalPane worktree={worktree} runtimeEvent={runtimeEvent} sendRuntime={sendRuntime} onError={handleError} />}{inspector === "context" && <ContextPane worktree={worktree} settings={settings} onError={handleError} />}</div></aside>}
      </div>
    </main>

    <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} projects={bootstrap.projects} onSelectProject={chooseProject} onSelectConversation={(item) => { const nextProject = bootstrap.projects.find((entry) => entry.id === item.projectId); const nextWorktree = nextProject?.worktrees.find((entry) => entry.id === item.worktreeId); if (nextProject && nextWorktree) { pendingConversationRef.current = item.id; chooseProject(nextProject, nextWorktree); } }} />
    <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} settings={settings} providers={providers} templates={templates} onSaved={(nextSettings, refresh) => { setBootstrap((current) => ({ ...current, settings: nextSettings })); if (nextSettings.notifications && window.Notification && Notification.permission === "default") Notification.requestPermission(); if (refresh) refreshAll(true); }} onError={handleError} />

    <SimpleDialog open={newChatOpen} onOpenChange={setNewChatOpen} title="New agent chat" description={`${project.name} / ${worktree.name}`} onSubmit={(event) => { event.preventDefault(); createConversation(); }} submit="Create chat"><label htmlFor="chat-title">What should the agent work on?</label><Input id="chat-title" autoFocus value={newChatTitle} onChange={(event) => setNewChatTitle(event.target.value)} placeholder="Review the worktree scanner" /></SimpleDialog>
    <SimpleDialog open={newGroupOpen} onOpenChange={setNewGroupOpen} title="Create project group" description="Organize related projects together in the sidebar." onSubmit={createGroup} submit="Create group" disabled={!newGroupName.trim()}><label htmlFor="group-name">Group name</label><Input id="group-name" autoFocus value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} placeholder="Client work" /></SimpleDialog>
    <Dialog open={Boolean(trustRequest)} onOpenChange={(open) => !open && setTrustRequest(null)}><DialogContent><DialogHeader><DialogTitle>Trust this project?</DialogTitle><DialogDescription>Agents can read and, under the selected policy, modify files or run commands inside this project.</DialogDescription></DialogHeader>{trustRequest && <div className="trust-card"><ShieldCheck /><div><strong>{trustRequest.name}</strong><code>{trustRequest.path}</code></div></div>}<p className="trust-note">Outright will pass <strong>{settings.approvalPolicy}</strong> to the provider. Full-access mode can make changes beyond the worktree and should only be used in an external sandbox.</p><DialogFooter><Button variant="outline" onClick={() => setTrustRequest(null)}>Cancel</Button><Button onClick={trustAndRun}>Trust and run</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={manageChatOpen} onOpenChange={setManageChatOpen}><DialogContent><form className="dialog-form" onSubmit={saveChatSettings}><DialogHeader><DialogTitle>Conversation settings</DialogTitle><DialogDescription>Rename, move, pin, or attach an existing provider session.</DialogDescription></DialogHeader><label htmlFor="chat-settings-title">Title</label><Input id="chat-settings-title" value={chatDraft.title} onChange={(event) => setChatDraft({ ...chatDraft, title: event.target.value })} /><label htmlFor="chat-settings-destination">Move to worktree</label><select id="chat-settings-destination" value={chatDraft.destination} onChange={(event) => setChatDraft({ ...chatDraft, destination: event.target.value })}>{bootstrap.projects.map((item) => <optgroup key={item.id} label={item.name}>{item.worktrees.filter((entry) => !entry.isPrunable && !entry.isBare).map((entry) => <option key={entry.id} value={`${item.id}::${entry.id}`}>{entry.name} · {entry.branch}</option>)}</optgroup>)}</select><label htmlFor="chat-settings-provider">Provider</label><select id="chat-settings-provider" value={chatDraft.provider} onChange={(event) => setChatDraft({ ...chatDraft, provider: event.target.value })}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select><label htmlFor="chat-settings-model">Model</label><Input id="chat-settings-model" value={chatDraft.model} onChange={(event) => setChatDraft({ ...chatDraft, model: event.target.value })} placeholder="Provider default" /><label htmlFor="chat-settings-session">Provider session ID</label><Input id="chat-settings-session" value={chatDraft.providerSessionId} onChange={(event) => setChatDraft({ ...chatDraft, providerSessionId: event.target.value })} placeholder="Attach or resume an existing session" /><div className="manage-actions"><Button type="button" variant="outline" onClick={() => updateConversation({ pinned: !conversation.pinned })}><PushPin />{conversation?.pinned ? "Unpin" : "Pin"}</Button><Button type="button" variant="destructive" onClick={archiveConversation}><Archive />Archive conversation</Button></div><DialogFooter><Button variant="outline" type="button" onClick={() => setManageChatOpen(false)}>Cancel</Button><Button type="submit">Save</Button></DialogFooter></form></DialogContent></Dialog>
    <SimpleDialog open={Boolean(worktreeDialog)} onOpenChange={(open) => !open && setWorktreeDialog(null)} title="Create worktree" description={worktreeDialog?.name ?? ""} onSubmit={createWorktree} submit="Create worktree" disabled={!worktreeDraft.branch.trim()}><label htmlFor="worktree-branch">Branch name</label><Input id="worktree-branch" value={worktreeDraft.branch} onChange={(event) => setWorktreeDraft({ ...worktreeDraft, branch: event.target.value })} placeholder="feature/my-change" /><label htmlFor="worktree-directory">Directory name <small>optional</small></label><Input id="worktree-directory" value={worktreeDraft.name} onChange={(event) => setWorktreeDraft({ ...worktreeDraft, name: event.target.value })} placeholder="project-my-change" /><label htmlFor="worktree-base">Base revision</label><Input id="worktree-base" value={worktreeDraft.baseBranch} onChange={(event) => setWorktreeDraft({ ...worktreeDraft, baseBranch: event.target.value })} /></SimpleDialog>
    <Dialog open={removeWorktreeOpen} onOpenChange={setRemoveWorktreeOpen}><DialogContent><DialogHeader><DialogTitle>Remove worktree?</DialogTitle><DialogDescription>This is allowed only when the linked worktree has no uncommitted changes. Type its exact path to confirm.</DialogDescription></DialogHeader><code className="confirm-path">{worktree.path}</code><label htmlFor="remove-worktree-confirmation">Confirmation path</label><Input id="remove-worktree-confirmation" value={removeConfirmation} onChange={(event) => setRemoveConfirmation(event.target.value)} placeholder="Exact worktree path" /><DialogFooter><Button variant="outline" onClick={() => setRemoveWorktreeOpen(false)}>Cancel</Button><Button variant="destructive" disabled={removeConfirmation !== worktree.path} onClick={removeWorktree}>Remove worktree</Button></DialogFooter></DialogContent></Dialog>
    {toast && <div className="toast" role="status" aria-live="polite"><CheckCircle weight="fill" />{toast}</div>}{error && <div className="error-toast" role="alert" aria-live="assertive"><WarningCircle weight="fill" /><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X /></button></div>}
  </div>;
}

function ProjectTree({ project, activeProjectId, activeWorktreeId, expanded, groups, onToggle, onSelectProject, onSelectWorktree, onMove, onCreateWorktree }) {
  return <div className={`project-tree ${project.id === activeProjectId ? "is-active" : ""}`}><div className="project-row"><button className="tree-caret" onClick={onToggle} aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`} aria-expanded={expanded}>{expanded ? <CaretDown /> : <CaretRight />}</button><button className="project-select" onClick={onSelectProject}><FolderOpen weight={project.id === activeProjectId ? "fill" : "duotone"} /><span><strong>{project.name}</strong><small>{compactPath(project.path)}</small></span></button><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" className="project-menu" aria-label={`Project options for ${project.name}`} />}><DotsThree weight="bold" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={onCreateWorktree}><GitBranch />New worktree</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuGroup><DropdownMenuLabel>Move to group</DropdownMenuLabel>{groups.map((group) => <DropdownMenuItem key={group.id} onClick={() => onMove(group.id)}><Folders />{group.name}</DropdownMenuItem>)}</DropdownMenuGroup><DropdownMenuItem onClick={() => onMove(null)}>Ungrouped</DropdownMenuItem></DropdownMenuContent></DropdownMenu></div>{expanded && <div className="worktree-list">{project.worktrees.map((item) => <button className={`worktree-row ${project.id === activeProjectId && item.id === activeWorktreeId ? "is-active" : ""}`} aria-current={project.id === activeProjectId && item.id === activeWorktreeId ? "page" : undefined} key={item.id} onClick={() => onSelectWorktree(item)}><span /><GitBranch /><span className="worktree-copy"><strong>{item.name}</strong><small>{item.branch}</small></span><GitHealth worktree={item} /></button>)}</div>}</div>;
}
function ConversationHeader({ conversation, worktree, latestRun, onManage }) { return <section className="conversation-header"><div className="conversation-symbol"><ChatCircle weight="duotone" /></div><div><h1>{conversation?.title ?? "No conversation selected"}</h1><p><GitBranch />{worktree.branch}<span>·</span>{compactPath(worktree.path)}</p></div><div className="conversation-meta">{conversation && <button onClick={onManage}><span>{conversation.provider}</span><PencilSimple /></button>}{latestRun && <small>{runSummary(latestRun)}</small>}</div></section>; }
function Message({ message }) { const user = message.role === "user"; if (message.kind === "tool") return <article className="message is-agent is-tool" data-message-id={message.id}><div className="avatar"><CheckCircle weight="fill" /></div><div className="message-body"><p className="message-text">{message.body}</p></div></article>; return <article className={`message ${user ? "is-user" : "is-agent"}`} data-message-id={message.id}><div className="avatar">{user ? "Y" : <Sparkle weight="fill" />}</div><div className="message-body"><div className="message-meta"><strong>{user ? "You" : "Outright"}</strong><time>{formatTime(message.createdAt)}</time></div><p className="message-text">{message.body}</p>{message.payload?.runId && <small className="message-run">{message.payload.provider} · {message.payload.runId.slice(0, 8)}</small>}</div></article>; }
function StreamingMessage({ text, events }) { return <article className="message is-agent is-streaming" aria-busy="true"><div className="avatar"><Sparkle weight="fill" /></div><div className="message-body"><div className="message-meta"><strong>Outright</strong><span className="typing-dot" aria-hidden="true" /></div><p className="message-text">{text}</p><ToolActivity events={events} /></div></article>; }
function RunningMessage({ run, events }) { return <article className="message is-agent is-streaming" role="status" aria-live="polite"><div className="avatar"><Sparkle weight="fill" /></div><div className="message-body"><div className="message-meta"><strong>Outright</strong><span className="typing-dot" aria-hidden="true" /></div><p className="thinking-copy">{run.status === "queued" ? "Waiting for an execution slot…" : "Working in this worktree…"}</p><ToolActivity events={events} /></div></article>; }
// Interrupted runs surface here until the operator picks a continuation
// policy; the preserved partial output stays visible above the notice.
function RecoveryNotice({ run, conversation, recoveryConversation, onOpenRecovery, onResolve }) {
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
  const copy = action === "discard-unverifiable"
    ? "Outright cannot verify this legacy provider or its original worktree. After checking outside Outright that it is no longer running, discard only this recovery record to release its gate."
    : ownsRecovery
      ? `Reconciliation found ${classCopy}. Review the preserved partial output above, then choose how to continue before anything is retried.`
      : "Another chat in this worktree owns an interrupted run. Open it to inspect the preserved output and choose an explicit continuation policy.";
  return <div className="recovery-notice" role="alert"><WarningCircle weight="fill" /><div className="recovery-copy"><strong>{title}</strong><p>{copy}</p></div><div className="recovery-actions">{action === "discard-unverifiable" ? <Button size="sm" variant="destructive" onClick={() => onResolve(run, "discard-unverifiable")}>Discard legacy record</Button> : action === "owner" ? <><Button size="sm" disabled={!sessionId} onClick={() => onResolve(run, "resume-session")}><ArrowsClockwise />Resume session</Button><Button size="sm" variant="outline" onClick={() => onResolve(run, "retry")}>Retry from scratch</Button><Button size="sm" variant="ghost" onClick={() => onResolve(run, "discard")}>Discard</Button></> : <Button size="sm" onClick={onOpenRecovery}><ChatCircle />Open recovery chat</Button>}</div></div>;
}
function ToolActivity({ events }) { if (!events.length) return null; return <div className="tool-activity">{events.slice(-4).map((event) => <div key={event.id}><CheckCircle /><span>{toolLabel(event)}</span></div>)}</div>; }
function EmptyChat({ worktree, onCreate }) { return <div className="empty-chat"><ChatCircle size={29} /><h2>Start in {worktree.name}</h2><p>Create a durable conversation, then run Codex or Claude directly in this worktree.</p><Button onClick={onCreate}><Plus />New chat</Button></div>; }
function WorktreeState({ worktree }) { if (worktree.isPrunable) return <span className="worktree-state warning"><WarningCircle />stale</span>; if (worktree.changedCount) return <span className="worktree-state warning"><GitDiff />{worktree.changedCount} changed</span>; return <span className="worktree-state clean"><Check />clean</span>; }
function RunState({ run }) { if (!run) return null; const running = ["queued", "launching", "running"].includes(run.status); const pendingDecision = run.status === "interrupted" && !run.recoveryDecision; return <span className={`run-state ${run.status}`} role="status" aria-live="polite" title={pendingDecision ? "Restart interrupted this run; choose a continuation below" : undefined}><span className={`status-dot ${running || pendingDecision ? "demo" : run.status === "completed" ? "live" : "error"}`} aria-hidden="true" />{run.status}{run.costUsd != null && <small>${Number(run.costUsd).toFixed(3)}</small>}</span>; }
function GitHealth({ worktree }) { if (worktree.isPrunable) return <span className="git-health warning"><WarningCircle /></span>; if (worktree.changedCount) return <span className="git-health warning"><span className="status-dot demo" />{worktree.changedCount}</span>; return <span className="git-health clean"><Check /></span>; }
function TemplateMenu({ templates, onSelect }) { if (!templates.length) return null; return <DropdownMenu><DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="Prompt templates" />}><ClockCounterClockwise /></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuGroup><DropdownMenuLabel>Prompt templates</DropdownMenuLabel>{templates.map((template) => <DropdownMenuItem key={template.id} onClick={() => onSelect(template.prompt)}>{template.title}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu>; }
function ThemeMenu({ theme, onThemeChange }) { const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Desktop; return <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Change theme" />}><Icon /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup><DropdownMenuLabel>Appearance</DropdownMenuLabel></DropdownMenuGroup><DropdownMenuRadioGroup value={theme} onValueChange={onThemeChange}><DropdownMenuRadioItem value="system"><Desktop />System</DropdownMenuRadioItem><DropdownMenuRadioItem value="light"><Sun />Light</DropdownMenuRadioItem><DropdownMenuRadioItem value="dark"><Moon />Dark</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>; }
function SimpleDialog({ open, onOpenChange, title, description, onSubmit, submit, disabled, children }) { return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><form className="dialog-form" onSubmit={onSubmit}><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>{children}<DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={disabled}>{submit}</Button></DialogFooter></form></DialogContent></Dialog>; }
function LoadingScreen({ isScanning }) { return <div className="loading-screen" role="status" aria-live="polite"><span className="brand-glyph"><Sparkle weight="fill" /></span><h1>Outright</h1><p>{isScanning ? "Starting the local runtime…" : "No projects found"}</p></div>; }
function buildGroupedProjects(projects, state) { const result = state.groups.map((group) => ({ ...group, projects: projects.filter((project) => state.memberships[project.id] === group.id) })); const ungrouped = projects.filter((project) => !state.groups.some((group) => group.id === state.memberships[project.id])); return ungrouped.length ? [...result, { id: "ungrouped", name: "Ungrouped", projects: ungrouped }] : result; }
function preferredWorktree(project) { return project.worktrees.find((item) => item.name === "dev" || item.path.endsWith("-dev")) ?? project.worktrees.find((item) => item.branch === "next") ?? project.worktrees[0]; }
function compactPath(value = "") { return value.replace(/^\/Users\/[^/]+/, "~"); }
function defaultSettings() { return { provider: "codex", model: "", reasoningEffort: "medium", approvalPolicy: "workspace-write", editor: "zed", notifications: true, maxConcurrentRuns: 3 }; }
function focusableElements(container) { return container ? [...container.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter((element) => element.getClientRects().length && element.getAttribute("aria-hidden") !== "true") : []; }
function boundStreamingText(value) { return value.length > MAX_STREAMING_CHARACTERS ? `${value.slice(0, MAX_STREAMING_CHARACTERS)}${LIVE_TRUNCATION_MARKER}` : value; }
function formatTime(value) { return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function runSummary(run) { const tokens = Number(run.inputTokens ?? 0) + Number(run.outputTokens ?? 0); return `${run.status}${tokens ? ` · ${tokens.toLocaleString()} tokens` : ""}${run.costUsd != null ? ` · $${Number(run.costUsd).toFixed(3)}` : ""}`; }
function toolLabel(event) { const item = event.payload?.item ?? {}; return item.command || item.name || item.type || (event.type === "tool.started" ? "Tool started" : "Tool completed"); }
