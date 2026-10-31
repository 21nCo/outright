// Open /tests/ui-races.html on the local Vite server. All API and socket traffic
// is replaced in this page; no real project, conversation or terminal is changed.
import React, { startTransition, Suspense } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.jsx";
import { ChangesPane } from "../src/components/ChangesPane.jsx";
import { WindowedMessages } from "../src/components/WindowedMessages.jsx";
import { WindowedDiff, diffFindTop, diffRowsHeight } from "../src/components/WindowedDiff.jsx";
import { CommandPalette } from "../src/components/CommandPalette.jsx";
import { SettingsDialog } from "../src/components/SettingsDialog.jsx";
import { TeardownChoices, WorktreeLifecycleDialog } from "../src/components/WorktreeLifecycle.jsx";
import { WorktreeCheckpointsDialog } from "../src/components/WorktreeCheckpoints.jsx";
import { ProviderAccounts } from "../src/components/ProviderAccounts.jsx";
import { TerminalPane } from "../src/components/TerminalPane.jsx";
import { PaneBody, PaneLayout } from "../src/components/PaneLayout.jsx";
import { computePaneRects } from "../src/lib/pane-layout.js";
import { TooltipProvider } from "../src/components/ui/tooltip.jsx";
import { scheduleLayoutTick } from "../src/lib/windowing.js";
import { createTerminalCommandFence } from "../src/lib/terminal-command-fence.js";
import { removalRequest, teardownProblem } from "../src/lib/worktree-lifecycle.js";
import { savedOutputRows, savedPageText, savedRowPages } from "../src/lib/terminal-exit-state.js";
import { Terminal } from "@xterm/xterm";
import "../src/styles.css";

const host = document.getElementById("root");
const results = document.getElementById("results");
const root = createRoot(host);
const originalFetch = window.fetch;
const OriginalSocket = window.WebSocket;
const keys = ["outright.selected-project", "outright.selected-worktree", "outright.selected-conversation"];
const saved = keys.map((key) => localStorage.getItem(key));
// Pane layouts persist per worktree; each step starts from the default.
const LAYOUT_KEY = "outright.pane-layouts";
const savedLayouts = localStorage.getItem(LAYOUT_KEY);
const projects = ["A", "B"].map((id) => ({ id, name: `Review ${id}`, path: `/fixture/${id}`, worktrees: [{ id, name: id, path: `/fixture/${id}`, branch: "main", changedCount: 0 }] }));
const chats = Object.fromEntries(projects.map(({ id }) => [id, { id: `chat-${id}`, title: `Conversation ${id}`, projectId: id, worktreeId: id, worktreePath: `/fixture/${id}`, provider: "codex", messages: [], runs: [] }]));
const terminal = (id) => ({ id: `term-${id}`, name: `Terminal ${id}`, cwd: `/fixture/${id[0]}`, status: "running" });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const frame = () => new Promise((resolve) => scheduleLayoutTick(resolve));
async function settle() { await frame(); await frame(); }
function terminalReady(name) { return host.querySelector('.terminal-tabs[aria-busy="false"] [role="tab"][aria-selected="true"]')?.textContent === name; }
async function until(check, label) {
  const deadline = performance.now() + 5000;
  while (!check()) {
    // A hidden page paints no frames, so frame-driven focus cannot settle.
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}; page ${document.visibilityState}`);
    await frame();
  }
}
async function remainsTrue(check, durationMs, label) {
  const deadline = performance.now() + durationMs;
  while (performance.now() < deadline) {
    assert(check(), label);
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - performance.now())))); // NOSONAR S9382: polls one condition until its deadline
  }
  assert(check(), label);
}
function assert(value, message) { if (!value) throw new Error(message); }
function deferred() { let resolve; let reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function setControlValue(control, value) {
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}
function visibleFocusable(container) { return [...container.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter((element) => element.getClientRects().length && element.getAttribute("aria-hidden") !== "true"); }
let route;
const fixtureSockets = [];
window.fetch = async (input, options = {}) => {
  const url = new URL(input, location.origin);
  if (!url.pathname.startsWith("/api/")) throw new Error(`Unexpected test request: ${url}`);
  return route(url, options);
};
window.WebSocket = class extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  constructor() { super(); fixtureSockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send() {}
  close() { this.readyState = 3; }
};

async function chatRace(rejectForTrust, switchTarget = true) {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const pendingRun = deferred();
  let submitted = false;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats[url.searchParams.get("projectId")]] });
    if (url.pathname.endsWith("/runs")) { submitted = true; return pendingRun.promise; }
    const match = url.pathname.match(/^\/api\/conversations\/chat-([AB])$/);
    if (match) return response(chats[match[1]]);
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('textarea[placeholder*="in A"]'), "conversation A");
  const input = host.querySelector('textarea[aria-label="Message the agent"]');
  setControlValue(input, "Delayed response regression");
  await until(() => !host.querySelector('[aria-label="Send message"]').disabled, "enabled composer");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => submitted, "run submitted in A");
  if (switchTarget) {
    [...host.querySelectorAll("button")].find((button) => button.textContent.includes("Review B")).click();
    await until(() => host.querySelector('textarea[placeholder*="in B"]'), "conversation B");
  }
  pendingRun.resolve(rejectForTrust
    ? response({ error: "Project trust is required", code: "PROJECT_TRUST_REQUIRED", project: projects[0] }, 403)
    : response({ id: "run-A", conversationId: "chat-A", status: "running" }));
  if (switchTarget) await settle();
  else await until(() => Boolean(host.querySelector('[aria-label="Stop active agent run"]')), "current conversation run");
  assert(Boolean(host.querySelector('[aria-label="Stop active agent run"]')) === !switchTarget, switchTarget ? "A's run was attached to B" : "Current conversation did not receive its run");
  assert(!document.querySelector('[role="dialog"]'), "A's trust response opened in B");
}

async function terminalRace() {
  root.render(null);
  await settle();
  let holdLists = false;
  const delayedList = deferred();
  const delayedBuffer = deferred();
  let bufferRequested = false;
  const errors = [];
  const onError = (error) => errors.push(error);
  const sendRuntime = () => {};
  route = async (url) => {
    if (url.pathname === "/api/terminals") return holdLists ? delayedList.promise : response({ terminals: [terminal("A"), terminal("A2"), terminal("B")] });
    if (url.pathname === "/api/terminals/term-A2") { bufferRequested = true; return delayedBuffer.promise; }
    return response({ buffer: `Output ${url.pathname}\r\n` });
  };
  const show = (project) => root.render(<TerminalPane worktree={project.worktrees[0]} runtimeEvent={null} onError={onError} sendRuntime={sendRuntime} />);
  show(projects[0]);
  await until(() => terminalReady("Terminal A"), "terminal A ready");
  [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Terminal A2").click();
  await until(() => bufferRequested, "pending second terminal buffer");
  holdLists = true;
  show(projects[1]);
  await settle();
  assert(!host.querySelector('[role="tab"]'), "Old worktree tabs remained selectable");
  assert(host.querySelector('[aria-label="New terminal"]').disabled, "Terminal controls enabled before reconciliation");
  delayedList.resolve(response({ terminals: [terminal("A"), terminal("B")] }));
  await until(() => terminalReady("Terminal B"), "terminal B ready");
  delayedBuffer.resolve(response({ buffer: "Stale A output\r\n" }));
  await settle();
  assert(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Terminal B", "Late A selection replaced B");
  assert(errors.length === 0, "Terminal reconciliation reported errors");
}

async function chatTabControlRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const secondChat = { ...chats.A, id: "chat-A2", title: "Conversation A2" };
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A, secondChat] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    if (url.pathname === "/api/conversations/chat-A2") return response(secondChat);
    if (url.pathname === "/api/git/status") return response({ branch: "main", files: [], stagedCount: 0 });
    if (url.pathname === "/api/context") return response({ instructionFiles: [], skills: [], pullRequest: null });
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A")] });
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelectorAll('[role="tab"][id^="chat-tab-"]').length === 2, "two chat tabs");
  const selected = host.querySelector('[role="tab"][aria-selected="true"]');
  const archive = host.querySelector('[aria-label="Archive Conversation A"]');
  archive.focus();
  for (const key of ["ArrowRight", "Home", "End"]) {
    archive.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await settle();
    assert(document.activeElement === archive, `Chat tablist handled ${key} from the Archive control`);
    assert(selected.getAttribute("aria-selected") === "true", `Chat selection changed after ${key} on the Archive control`);
  }
  const assertVerticalKeysIgnored = async (tab, selectedTab, label) => {
    tab.focus();
    for (const key of ["ArrowUp", "ArrowDown"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      tab.dispatchEvent(event);
      await settle();
      assert(!event.defaultPrevented, `${label} captured ${key} in a horizontal tablist`);
      assert(document.activeElement === tab && selectedTab.getAttribute("aria-selected") === "true", `${label} changed focus or selection on ${key}: active=${document.activeElement?.outerHTML.slice(0, 180)}, selected=${selectedTab.getAttribute("aria-selected")}`);
    }
  };
  await assertVerticalKeysIgnored(selected, selected, "Chat");
  selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await until(() => host.querySelector('[role="tab"][id="chat-tab-chat-A2"][aria-selected="true"]'), "right arrow selects second chat");
  const nextChat = host.querySelector('[id="chat-tab-chat-A2"]');
  nextChat.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
  await until(() => selected.getAttribute("aria-selected") === "true", "Home returns to first chat");
  const changes = host.querySelector('[aria-label="Changes"]');
  assert(!host.querySelector("#pane-changes") && changes.getAttribute("aria-pressed") === "false", "Changes pane was already open before Changes click");
  changes.focus();
  changes.click();
  await until(() => document.activeElement === host.querySelector("#pane-changes"), "Changes pane opened with focus");
  assert(changes.getAttribute("aria-pressed") === "true" && changes.getAttribute("aria-controls") === "pane-changes",
    `Changes toggle does not report its pane: ${changes.outerHTML.slice(0, 300)}`);
  assert(host.querySelector('[role="tab"][aria-selected="true"]') === selected, "Opening a pane changed the selected chat");
  changes.focus();
  changes.click();
  await until(() => !host.querySelector("#pane-changes"), "Changes toggle closes its pane");
  assert(changes.getAttribute("aria-pressed") === "false" && !changes.hasAttribute("aria-controls"), "Closed Changes pane is still reported open");
  assert(document.activeElement === changes, "Closing from the toolbar moved focus away from the toggle");
}

async function sameWorktreeChatSelectionRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const message = (id, body) => ({ id, role: "user", kind: "text", body, createdAt: "2026-09-24T00:00:00Z" });
  const first = { ...chats.A, messages: [message("message-A", "First chat content")] };
  const second = { ...chats.A, id: "chat-A2", title: "Second chat", provider: "claude", messages: [message("message-A2", "Second chat content")] };
  const created = { ...chats.A, id: "chat-A3", title: "Created chat", messages: [message("message-A3", "Created chat content")] };
  const heldSecond = deferred();
  const heldCreated = deferred();
  let list = [first, second];
  let secondRequests = 0;
  const runs = [];
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: list });
    if (url.pathname === "/api/conversations/chat-A") return response(first);
    if (url.pathname === "/api/conversations/chat-A2") return ++secondRequests === 1 ? heldSecond.promise : response(second);
    if (url.pathname === "/api/conversations/chat-A3") return heldCreated.promise;
    if (url.pathname.endsWith("/runs")) { runs.push({ path: url.pathname, body: JSON.parse(options.body) }); return response({ id: "run", status: "queued" }, 202); }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('.message-text')?.textContent.includes("First chat content"), "first chat loaded");
  setControlValue(host.querySelector('textarea[aria-label="Message the agent"]'), "Only second chat may send");
  host.querySelector('#chat-tab-chat-A2').click();
  await until(() => host.querySelector('#chat-tab-chat-A2[aria-selected="true"]'), "second chat tab selected");
  assert(!host.querySelector('.conversation-header h1')?.textContent.includes(first.title), "Old header stayed under second tab");
  assert(!host.querySelector('.message-text')?.textContent.includes("First chat content"), "Old transcript stayed under second tab");
  assert(host.querySelector('textarea[aria-label="Message the agent"]')?.disabled, "Composer stayed enabled before second detail loaded");
  host.querySelector('.composer').requestSubmit();
  assert(runs.length === 0, "Pending second chat submitted through first chat");
  heldSecond.resolve(response(second));
  await until(() => host.querySelector('.conversation-header h1')?.textContent === second.title && host.querySelector('.message-text')?.textContent.includes("Second chat content"), "second chat detail loaded");
  assert(!host.querySelector('[aria-label="Send message"]')?.disabled, "Second chat composer did not become ready");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => runs.length === 1, "second chat send");
  assert(runs[0].path === "/api/conversations/chat-A2/runs" && runs[0].body.provider === "claude", "Send used the prior chat owner");
  const secondTab = host.querySelector('#chat-tab-chat-A2');
  secondTab.focus();
  secondTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
  await until(() => host.querySelector('#chat-tab-chat-A[aria-selected="true"]') && host.querySelector('.message-text')?.textContent.includes("First chat content"), "keyboard returned to first detail");
  assert(!host.querySelector('.message-text')?.textContent.includes("Second chat content"), "Keyboard selection retained second transcript");
  list = [first, second, created];
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.created", conversationId: created.id }) }));
  await until(() => host.querySelector('#chat-tab-chat-A3[aria-selected="true"]'), "created chat selected from list");
  assert(!host.querySelector('.message-text')?.textContent.includes("First chat content"), "Created chat tab showed prior transcript");
  assert(host.querySelector('textarea[aria-label="Message the agent"]')?.disabled, "Created chat composer enabled before detail");
  heldCreated.resolve(response(created));
  await until(() => host.querySelector('.conversation-header h1')?.textContent === created.title && host.querySelector('.message-text')?.textContent.includes("Created chat content"), "created chat detail loaded");
}

async function chatSettingsArchiveRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const sibling = { ...chats.A, id: "chat-A2", title: "Conversation A2" };
  let archived = false;
  let archivedSibling = false;
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: archivedSibling ? [] : archived ? [sibling] : [chats.A, sibling] });
    if (url.pathname === "/api/conversations/chat-A" && options.method === "PATCH") {
      assert(JSON.parse(options.body).archived === true, "Settings did not archive the selected conversation");
      archived = true;
      return response({ ...chats.A, archived: true });
    }
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    if (url.pathname === "/api/conversations/chat-A2" && options.method === "PATCH") {
      assert(JSON.parse(options.body).archived === true, "Inline archive did not archive the sibling");
      archivedSibling = true;
      return response({ ...sibling, archived: true });
    }
    if (url.pathname === "/api/conversations/chat-A2") return response(sibling);
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('#chat-tab-chat-A[aria-selected="true"]') && host.querySelector('#chat-tab-chat-A2'), "two chat tabs with A selected");
  await until(() => host.querySelector('.conversation-header h1')?.textContent === chats.A.title, "selected conversation content before settings");
  host.querySelector('.conversation-meta button').click();
  await until(() => document.querySelector('[role="dialog"]')?.textContent.includes("Conversation settings"), "conversation settings dialog");
  const archive = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.includes("Archive conversation"));
  assert(archive, "Settings archive action is missing");
  archive.click();
  await until(() => archived && !document.querySelector('[role="dialog"]') && host.querySelectorAll('.chat-tabs [role="tab"]').length === 1, "archive and sibling selection");
  const selected = host.querySelector('#chat-tab-chat-A2');
  assert(selected?.getAttribute("aria-selected") === "true" && selected.tabIndex === 0, "Remaining chat is not selected and tabbable after settings archive");
  assert(!host.querySelector('#chat-tab-chat-A'), "Archived chat remains in the tablist");
  assert(host.querySelector('#conversation-panel')?.getAttribute('aria-labelledby') === selected.id, "Conversation panel does not label itself from the remaining tab");
  await until(() => host.querySelector('.conversation-header h1')?.textContent === sibling.title, "sibling conversation content");
  const preceding = visibleFocusable(host.querySelector('.workspace-bar')).at(-1);
  assert(preceding, "No keyboard entry point preceding the chat tabs");
  preceding.focus();
  if (window.__fixtureSendKey) {
    await window.__fixtureSendKey("Tab");
    assert(document.activeElement === selected, `Tab did not reach the remaining chat: ${document.activeElement?.outerHTML.slice(0, 180)}`);
  }
  selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await settle();
  assert(document.activeElement === selected && selected.getAttribute("aria-selected") === "true", "Arrow navigation lost the sole remaining chat");
  host.querySelector('[aria-label="Archive Conversation A2"]').click();
  await until(() => archivedSibling && !host.querySelector('.chat-tabs [role="tab"]') && host.querySelector('.conversation-header h1')?.textContent === "No conversation selected", "inline archive of last chat");
  assert(!host.querySelector('#conversation-panel')?.hasAttribute('aria-labelledby'), "Empty conversation panel still references an archived tab");
}

async function chatSettingsSessionEditRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  let current = { ...chats.A, providerSessionId: "session-A" };
  const patches = [];
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [current] });
    if (url.pathname === "/api/conversations/chat-A" && options.method === "PATCH") {
      const patch = JSON.parse(options.body);
      patches.push(patch);
      current = { ...current, ...patch, providerSessionId: patch.providerSessionId === undefined ? current.providerSessionId : patch.providerSessionId || null };
      return response(current);
    }
    if (url.pathname === "/api/conversations/chat-A") return response(current);
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('.conversation-header h1')?.textContent === chats.A.title, "session edit fixture loaded");
  const save = async (edit, label) => {
    host.querySelector('.conversation-meta button').click();
    await until(() => document.querySelector('#chat-settings-session')?.value === (current.providerSessionId ?? ""), `${label}: dialog opened`);
    edit();
    await settle();
    [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Save").click();
    await until(() => patches.length && !document.querySelector('[role="dialog"]'), `${label}: saved`);
    return patches.splice(0).at(-1);
  };
  // Before, every Save sent the session from when the dialog opened, which
  // discards a session the running agent recorded meanwhile.
  const renamed = await save(() => setControlValue(document.querySelector('#chat-settings-title'), "Renamed"), "rename");
  assert(renamed.title === "Renamed" && !("providerSessionId" in renamed), `A rename sent the session field: ${JSON.stringify(renamed)}`);
  const cleared = await save(() => setControlValue(document.querySelector('#chat-settings-session'), ""), "clear");
  assert(cleared.providerSessionId === "", `Clearing the session did not send it: ${JSON.stringify(cleared)}`);
}

function chooseOption(select, value) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

async function providerSwitchChoicesRegression() {
  root.render(null);
  await settle();
  const providers = [
    { id: "codex", label: "Codex", available: true, compatible: true, modelProvider: "openai", models: ["gpt-5.4"], capabilities: { permissionModes: ["read-only", "workspace-write", "danger-full-access"], reasoningEfforts: ["low", "medium", "high", "xhigh"], resume: true } },
    { id: "claude", label: "Claude Code", available: true, compatible: true, modelProvider: "anthropic", models: ["sonnet"], capabilities: { permissionModes: ["read-only", "workspace-write", "danger-full-access"], reasoningEfforts: ["low", "medium", "high", "xhigh"], resume: true } },
    { id: "anthropic-api", label: "Anthropic API", available: true, compatible: true, modelProvider: "anthropic", models: ["claude-opus-5-5"], capabilities: { permissionModes: ["read-only"], reasoningEfforts: ["medium"], resume: false } },
  ];
  const initial = { provider: "codex", model: "gpt-5.4", approvalPolicy: "workspace-write", reasoningEffort: "high",
    editor: "code", notifications: false, maxConcurrentRuns: 2, maxQueuedRuns: 32, maxRetainedMiB: 64, retentionDays: 90 };
  const patches = [];
  route = async (url, options) => {
    if (url.pathname === "/api/settings" && options.method === "PATCH") { patches.push(JSON.parse(options.body)); return response({ ...initial, ...patches.at(-1) }); }
    return response({});
  };
  root.render(<TooltipProvider><SettingsDialog open onOpenChange={() => {}} settings={initial} providers={providers} templates={[]} onSaved={() => {}} onError={(error) => { throw error; }} /></TooltipProvider>);
  const control = (label) => [...document.querySelectorAll('[role="dialog"] .setting-row')].find((row) => row.textContent.startsWith(label))?.querySelector("select, input");
  const saveButton = () => [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.includes("Save settings"));
  const status = () => document.querySelector("#default-provider-status").textContent;
  const values = () => ["Approval policy", "Reasoning effort", "Default model"].map((label) => control(label).value).join(",");
  const blamed = () => ["Approval policy", "Reasoning effort", "Default model"].filter((label) => control(label).getAttribute("aria-invalid") === "true"
    && control(label).getAttribute("aria-describedby") === "default-provider-status").join(",");
  await until(() => control("Default provider")?.value === "codex", "provider settings opened");
  // Before, the switch rewrote the global policy and effort to read-only/medium.
  chooseOption(control("Default provider"), "anthropic-api");
  await until(() => status().includes("does not support"), "unsupported choices announced");
  assert(values() === "workspace-write,high,gpt-5.4", `A provider switch changed another choice: ${values()}`);
  assert(saveButton().disabled && status().includes("was chosen for Codex"), "Save allowed choices the provider cannot honour");
  assert(blamed() === "Approval policy,Reasoning effort,Default model", `Invalid controls were not tied to the status: ${blamed()}`);
  chooseOption(control("Default provider"), "codex");
  await until(() => !saveButton().disabled, "switching back restores a saveable draft");
  assert(values() === "workspace-write,high,gpt-5.4", "switching back did not keep the original choices");
  // A model edited under another provider belongs to that provider, on every later switch.
  chooseOption(control("Default provider"), "claude");
  setControlValue(control("Default model"), "sonnet");
  chooseOption(control("Default provider"), "anthropic-api");
  await until(() => status().includes("“sonnet” was chosen for Claude Code"), "an edited model is revalidated on the next switch");
  assert(saveButton().disabled && control("Default model").getAttribute("aria-invalid") === "true", "Save allowed a Claude Code alias for the Anthropic API");
  chooseOption(control("Default provider"), "claude");
  setControlValue(control("Default model"), "claude-opus-5-5");
  chooseOption(control("Default provider"), "anthropic-api");
  await until(() => status().includes("does not support") && !status().includes("was chosen for"), "a model the target lists is kept");
  chooseOption(control("Default provider"), "anthropic-api");
  chooseOption(control("Approval policy"), "read-only");
  chooseOption(control("Reasoning effort"), "medium");
  setControlValue(control("Default model"), "");
  await until(() => !saveButton().disabled, "explicit supported choices enable Save");
  assert(blamed() === "" && !control("Default model").hasAttribute("aria-invalid"), "Corrected controls are still marked invalid");
  saveButton().click();
  await until(() => patches.length === 1, "provider settings saved");
  const expectedPatch = { provider: "anthropic-api", model: "", approvalPolicy: "read-only", reasoningEffort: "medium" };
  assert(Object.keys(patches[0]).length === Object.keys(expectedPatch).length && Object.entries(expectedPatch).every(([key, value]) => patches[0][key] === value),
    `Unexpected settings patch: ${JSON.stringify(patches[0])}`);

  // The conversation dialog applies the same rule to its model.
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  let chat = { ...chats.A, model: "gpt-5.4" };
  const runs = [];
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: initial, providers, templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chat] });
    if (url.pathname === "/api/conversations/chat-A" && options.method === "PATCH") { patches.push(JSON.parse(options.body)); chat = { ...chat, ...patches.at(-1) }; return response(chat); }
    if (url.pathname === "/api/conversations/chat-A/runs") { runs.push(JSON.parse(options.body)); return response({ id: "run", status: "queued" }, 202); }
    if (url.pathname === "/api/conversations/chat-A") return response(chat);
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('.conversation-header h1')?.textContent === chats.A.title, "chat provider fixture loaded");
  host.querySelector('.conversation-meta button').click();
  await until(() => document.querySelector('#chat-settings-model')?.value === "gpt-5.4", "chat settings opened");
  const chatSave = () => [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Save");
  chooseOption(document.querySelector('#chat-settings-provider'), "claude");
  await until(() => document.querySelector('#chat-settings-provider-status').textContent.includes("was chosen for Codex"), "chat model mismatch announced");
  const chatModel = () => document.querySelector('#chat-settings-model');
  assert(chatSave().disabled && chatModel().value === "gpt-5.4", "the chat kept a Codex model for Claude Code silently");
  assert(chatModel().getAttribute("aria-invalid") === "true" && chatModel().getAttribute("aria-describedby") === "chat-settings-provider-status", "the chat model was not tied to its error");
  setControlValue(document.querySelector('#chat-settings-model'), "sonnet");
  await until(() => !chatSave().disabled, "an explicit model enables Save");
  // Before, an edited model was compared only with the opened one, so this switch kept the alias.
  const chatStatus = () => document.querySelector('#chat-settings-provider-status').textContent;
  chooseOption(document.querySelector('#chat-settings-provider'), "anthropic-api");
  await until(() => chatStatus().includes("“sonnet” was chosen for Claude Code"), "an edited chat model is revalidated on the next switch");
  assert(chatSave().disabled && chatModel().getAttribute("aria-invalid") === "true", "a Claude Code alias entered in this session was kept for the Anthropic API");
  setControlValue(chatModel(), "claude-custom");
  await until(() => !chatSave().disabled, "an explicit custom model for the target enables Save");
  chooseOption(document.querySelector('#chat-settings-provider'), "claude");
  await until(() => chatStatus().includes("“claude-custom” was chosen for Anthropic API") && chatSave().disabled, "a custom model stays with the provider it was entered for");
  setControlValue(chatModel(), "sonnet");
  await until(() => !chatSave().disabled, "an explicit model enables Save again");
  chatSave().click();
  await until(() => patches.length === 2, "chat provider saved");
  assert(patches[1].provider === "claude" && patches[1].model === "sonnet", `Unexpected chat patch: ${JSON.stringify(patches[1])}`);
  // Before, a shared vendor let a Claude Code alias reach the Messages API.
  await until(() => !chatModel() && host.querySelector('textarea[placeholder*="Ask claude"]'), "chat saved on Claude Code");
  host.querySelector('.conversation-meta button').click();
  await until(() => chatModel()?.value === "sonnet", "chat settings reopened");
  chooseOption(document.querySelector('#chat-settings-provider'), "anthropic-api");
  await until(() => document.querySelector('#chat-settings-provider-status').textContent.includes("was chosen for Claude Code"), "alias mismatch announced");
  assert(chatSave().disabled && chatModel().getAttribute("aria-invalid") === "true", "a Claude Code alias was kept for the Anthropic API");
  setControlValue(chatModel(), "");
  await until(() => !chatSave().disabled && !chatModel().hasAttribute("aria-invalid"), "clearing the alias enables Save");
  chatSave().click();
  await until(() => patches.length === 3, "chat moved to the direct provider");
  assert(patches[2].provider === "anthropic-api" && patches[2].model === "", `Unexpected chat patch: ${JSON.stringify(patches[2])}`);
  // The default model was chosen for Codex; this chat runs its own provider's default.
  await until(() => !chatModel() && host.querySelector('textarea[placeholder*="Ask anthropic-api"]'), "chat saved on the direct provider");
  setControlValue(host.querySelector('textarea[aria-label="Message the agent"]'), "Answer with the provider default");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => runs.length === 1, "direct-provider chat sent");
  assert(runs[0].provider === "anthropic-api" && runs[0].model === "", `The run inherited another provider's default model: ${JSON.stringify(runs[0])}`);
}

// Before, widths of 920px or less hid the header's settings button, leaving
// a conversation's provider and model reachable only by double-click.
async function conversationSettingsKeyboardRegression() {
  if (!window.__fixtureSetViewport || !window.__fixtureSendKey) return false;
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const provider = (id, label, ready) => ({ id, label, kind: "harness", version: "9.9.9", available: ready, compatible: ready, reason: ready ? "" : `${label} is not installed`,
    capabilities: { permissionModes: ["read-only", "workspace-write", "danger-full-access"], reasoningEfforts: ["low", "medium", "high", "xhigh"], resume: true } });
  const providers = [provider("codex", "Codex", true), provider("claude", "Claude Code", false)];
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers, templates: [], trustedProjects: [] });
    if (url.pathname === "/api/providers") return response({ providers });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    return response({});
  };
  try {
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelector('.conversation-header h1')?.textContent === chats.A.title, "conversation settings fixture");
    for (const width of [360, 760, 900]) {
      await window.__fixtureSetViewport(width);
      await until(() => window.innerWidth === width, `real ${width}px layout`); // NOSONAR S9382: each width settles before its control is checked
      window.dispatchEvent(new Event("resize"));
      await settle(); // NOSONAR S9382: each width settles before its control is checked
      const manage = host.querySelector('button[aria-label="Conversation settings · codex"]');
      const bounds = manage?.getBoundingClientRect();
      assert(bounds && bounds.width >= 24 && bounds.height >= 24 && bounds.right <= window.innerWidth, `No visible conversation settings control at ${width}px: ${JSON.stringify(bounds?.toJSON())}`);
      host.querySelector('[aria-label="New chat tab"]').focus();
      await window.__fixtureSendKey("Tab"); // NOSONAR S9382: keys are delivered in order
      assert(document.activeElement === manage, `Tab did not reach conversation settings at ${width}px: ${document.activeElement?.outerHTML.slice(0, 160)}`);
      await window.__fixtureSendKey("Enter"); // NOSONAR S9382: keys are delivered in order
      await until(() => document.querySelector('#chat-settings-provider'), `Enter opened conversation settings at ${width}px`); // NOSONAR S9382: each width opens its own dialog
      const select = document.querySelector('#chat-settings-provider');
      await until(() => select.closest('[role="dialog"]').contains(document.activeElement), `focus entered conversation settings at ${width}px`); // NOSONAR S9382: each width opens its own dialog
      const visited = [];
      for (let step = 0; step < 6 && document.activeElement !== select; step += 1) {
        visited.push(document.activeElement?.id || document.activeElement?.outerHTML.slice(0, 60));
        await window.__fixtureSendKey("Tab"); // NOSONAR S9382: keys are delivered in order
      }
      assert(document.activeElement === select, `Tab did not reach the provider select at ${width}px: ${visited.join(" > ")}`);
      const claude = select.querySelector('option[value="claude"]');
      assert(claude.disabled && claude.textContent === "Claude Code (unavailable)", `An unready provider was offered at ${width}px: ${claude.outerHTML}`);
      assert(select.getAttribute("aria-describedby") === "chat-settings-provider-status" && document.querySelector('#chat-settings-provider-status').textContent.startsWith("Codex 9.9.9"), `Provider status was not announced at ${width}px`);
      await window.__fixtureSendKey("Escape"); // NOSONAR S9382: keys are delivered in order
      await until(() => !document.querySelector('#chat-settings-provider') && document.activeElement === manage, `Escape restored focus to conversation settings at ${width}px`); // NOSONAR S9382: each width closes its own dialog
    }
  } finally {
    await window.__fixtureSetViewport(1280);
  }
}

async function providerReadinessSelectionRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const provider = (id, label, state) => ({ id, label, kind: "harness", version: "9.9.9", available: state === "ready" || state === "incompatible",
    compatible: state === "ready", checking: state === "checking", capabilities: { permissionModes: ["read-only", "workspace-write", "danger-full-access"], reasoningEfforts: ["low", "medium", "high", "xhigh"], resume: true } });
  const snapshot = (pi) => [provider("codex", "Codex", "ready"), provider("claude", "Claude Code", "unavailable"),
    provider("anthropic-api", "Anthropic API", "incompatible"), provider("hermes", "Hermes", "checking"), provider("pi", "Pi", pi)];
  const unready = { claude: "Claude Code is unavailable", "anthropic-api": "Anthropic API is an unsupported version", hermes: "Hermes is still being checked", gone: "gone is not supported" };
  let chat = { ...chats.A, model: "" };
  let piState = "ready";
  const patches = [];
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: snapshot(piState), templates: [], trustedProjects: [] });
    // Hermes stays checking, so the app keeps polling this snapshot.
    if (url.pathname === "/api/providers") return response({ providers: snapshot(piState) });
    if (url.pathname === "/api/conversations") return response({ conversations: [chat] });
    if (url.pathname === "/api/conversations/chat-A" && options.method === "PATCH") { patches.push(JSON.parse(options.body)); chat = { ...chat, ...patches.at(-1) }; return response(chat); }
    if (url.pathname === "/api/conversations/chat-A") return response(chat);
    return response({});
  };
  const socketCount = fixtureSockets.length;
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('.conversation-header h1')?.textContent === chats.A.title && fixtureSockets.length > socketCount, "readiness fixture loaded");
  const publish = (pi) => { piState = pi; fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "providers.changed", payload: { providers: snapshot(pi) } }) })); };
  const select = () => document.querySelector('#chat-settings-provider');
  const status = () => document.querySelector('#chat-settings-provider-status').textContent;
  const save = () => [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Save");
  const blocked = (reason) => save().disabled && status().includes(reason) && select().getAttribute("aria-invalid") === "true";
  host.querySelector('.conversation-meta button').click();
  await until(() => select()?.value === "codex", "chat settings opened");
  const disabled = () => [...select().options].filter((option) => option.disabled).map((option) => option.value).join(",");
  assert(disabled() === "claude,anthropic-api,hermes", `Unready providers were selectable: ${disabled()}`);
  // Before, an unready provider with no model saved and left the chat unable to run.
  for (const [id, reason] of Object.entries(unready)) {
    if (id === "gone") select().append(new Option("gone", "gone"));
    chooseOption(select(), id);
    await until(() => blocked(reason), `a switch to ${id} blocks Save`);
    select().closest("form").requestSubmit();
    await settle();
    assert(patches.length === 0, `An unready provider was saved: ${JSON.stringify(patches)}`);
  }
  chooseOption(select(), "pi");
  await until(() => !save().disabled && !select().hasAttribute("aria-invalid"), "a ready provider is saveable");
  publish("unavailable");
  await until(() => blocked("Pi is unavailable"), "a provider that stops being ready while open blocks Save");
  publish("ready");
  await until(() => !save().disabled && !status().includes("choose a ready provider"), "a provider that is ready again is saveable");
  save().click();
  await until(() => patches.length === 1, "ready provider saved");
  assert(patches[0].provider === "pi" && patches[0].model === "", `Unexpected chat patch: ${JSON.stringify(patches[0])}`);
  await until(() => !select(), "chat settings closed");
  // The opened provider stays saveable while unready, so unrelated edits still work.
  publish("unavailable");
  host.querySelector('.conversation-meta button').click();
  await until(() => select()?.value === "pi", "chat settings reopened");
  assert(!select().querySelector('option[value="pi"]').disabled && !save().disabled && !select().hasAttribute("aria-invalid"), "the unready current provider blocked an unrelated edit");
  setControlValue(document.querySelector('#chat-settings-title'), "Renamed while unready");
  save().click();
  await until(() => patches.length === 2, "title saved on an unready provider");
  assert(patches[1].title === "Renamed while unready" && patches[1].provider === "pi" && !("providerSessionId" in patches[1]), `Unexpected title patch: ${JSON.stringify(patches[1])}`);

  // Settings applies the same rule to the default provider.
  root.render(null);
  await settle();
  const initial = { provider: "codex", model: "", approvalPolicy: "read-only", reasoningEffort: "medium",
    editor: "code", notifications: false, maxConcurrentRuns: 2, maxQueuedRuns: 32, maxRetainedMiB: 64, retentionDays: 90 };
  route = async (url, options) => {
    if (url.pathname === "/api/settings" && options.method === "PATCH") { patches.push(JSON.parse(options.body)); return response({ ...initial, ...patches.at(-1) }); }
    return response({});
  };
  const settings = (pi) => root.render(<TooltipProvider><SettingsDialog open onOpenChange={() => {}} settings={initial} providers={snapshot(pi)} templates={[]} onSaved={() => {}} onError={(error) => { throw error; }} /></TooltipProvider>);
  settings("ready");
  const control = () => [...document.querySelectorAll('[role="dialog"] .setting-row')].find((row) => row.textContent.startsWith("Default provider"))?.querySelector("select");
  const settingsSave = () => [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.includes("Save settings"));
  const settingsStatus = () => document.querySelector("#default-provider-status").textContent;
  await until(() => control()?.value === "codex", "provider settings opened");
  chooseOption(control(), "pi");
  await until(() => !settingsSave().disabled, "a ready default provider is saveable");
  settings("unavailable");
  await until(() => settingsSave().disabled && settingsStatus().includes("Pi is unavailable") && control().getAttribute("aria-invalid") === "true", "a default provider that stops being ready blocks Save");
  // Comparing with the draft kept the selected unready provider enabled.
  assert(control().querySelector('option[value="pi"]').disabled && !control().querySelector('option[value="codex"]').disabled, "options were not compared with the opened provider");
  settings("ready");
  await until(() => !settingsSave().disabled && !control().hasAttribute("aria-invalid"), "a ready default provider is saveable again");
  settingsSave().click();
  await until(() => patches.length === 3, "default provider saved");
  assert(patches[2].provider === "pi" && Object.keys(patches[2]).length === 1, `Unexpected settings patch: ${JSON.stringify(patches[2])}`);
}

async function recoveryModelCorrectionRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const interrupted = { id: "run-legacy-model", conversationId: "chat-A", status: "interrupted", recoveryClass: "exited", provider: "codex", model: "gpt 5 codex" };
  const recoveryChat = { ...chats.A, runs: [interrupted] };
  const requests = [];
  const prompts = [];
  const confirm = window.confirm;
  window.confirm = (text) => { prompts.push(text); return prompts.length > 1; };
  try {
    route = async (url, options) => {
      if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
      if (url.pathname === "/api/conversations") return response({ conversations: [recoveryChat] });
      if (url.pathname === "/api/runs/run-legacy-model/resume") {
        const body = JSON.parse(options.body);
        requests.push(body);
        if (!body.useProviderDefaultModel) return response({ error: "This run's saved model name can no longer be launched safely.", code: "RECOVERY_MODEL_UNLAUNCHABLE" }, 409);
        return response({ id: "run-replacement" }, 202);
      }
      if (url.pathname === "/api/conversations/chat-A") return response(recoveryChat);
      return response({});
    };
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelectorAll(".recovery-actions button").length === 3, "legacy recovery actions");
    const retry = () => [...host.querySelectorAll(".recovery-actions button")].find((button) => button.textContent.includes("Retry from scratch"));
    // A declined confirmation sends nothing more; an accepted one retries with the default model.
    retry().click();
    await until(() => prompts.length === 1 && host.textContent.includes("can no longer be launched safely"), "declined correction surfaces the refusal");
    assert(requests.length === 1 && prompts[0].includes("“gpt 5 codex”"), "the correction was not explained before replacing the model");
    retry().click();
    await until(() => requests.length === 3, "confirmed correction retried");
    assert(JSON.stringify(requests.slice(1)) === JSON.stringify([{ policy: "retry" }, { policy: "retry", useProviderDefaultModel: true }]), `Unexpected recovery requests: ${JSON.stringify(requests)}`);
  } finally { window.confirm = confirm; }
}

async function settingsRetentionDraftRegression() {
  root.render(null);
  await settle();
  const initial = { provider: "codex", model: "", approvalPolicy: "workspace-write", reasoningEffort: "medium",
    editor: "code", notifications: false, maxConcurrentRuns: 2, maxQueuedRuns: 32, maxRetainedMiB: 64, retentionDays: 90 };
  let saved = initial;
  let cleanupCalls = 0;
  let patchCalls = 0;
  route = async (url, options) => {
    if (url.pathname === "/api/capacity") return response({ queued: 0, active: 0, recoverable: 0,
      retainedBytes: 0, availableForNewWorkBytes: 63 * 1048576,
      limits: { maxQueuedRuns: 32, maxConcurrentRuns: 2, maxRetainedBytes: 64 * 1048576, reservedRetainedBytes: 1048576 } });
    if (url.pathname === "/api/retention/archived") return response({});
    if (url.pathname === "/api/retention/cleanup") {
      cleanupCalls++;
      assert(JSON.stringify(JSON.parse(options.body)) === "{}", "Cleanup sent an unsaved draft cutoff");
      assert(saved.retentionDays === 90, "Cleanup changed the saved retention window");
      return response({ deleted: 0, capacity: { limits: null } });
    }
    if (url.pathname === "/api/settings" && options.method === "PATCH") {
      patchCalls++;
      saved = { ...saved, ...JSON.parse(options.body) };
      return response(saved);
    }
    return response({});
  };
  function Fixture() {
    const [open, setOpen] = React.useState(false);
    const [settings, setSettings] = React.useState(initial);
    return <><button onClick={() => setOpen(true)}>Open settings fixture</button><SettingsDialog open={open}
      onOpenChange={setOpen} settings={settings} providers={[{ id: "codex", label: "Codex", available: true }]}
      templates={[]} onSaved={(nextSettings, refresh) => { setSettings(refresh === "history" ? { ...saved } : nextSettings); }}
      onError={(error) => { throw error; }} /></>;
  }
  root.render(<TooltipProvider><Fixture /></TooltipProvider>);
  await until(() => host.querySelector("button"), "settings fixture mounted");
  const open = () => host.querySelector("button").click();
  const age = () => document.querySelector('[role="dialog"] label:last-of-type input');
  open();
  await until(() => age()?.value === "90", "saved retention age in settings");
  setControlValue(age(), "1");
  await until(() => age()?.value === "1", "edited retention age");
  [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.trim() === "Cancel").click();
  await until(() => !document.querySelector('[role="dialog"]'), "settings cancelled");
  open();
  await until(() => age()?.value === "90", "cancelled draft reset to saved age");
  setControlValue(age(), "45");
  await until(() => age()?.value === "45", "unsaved retention edit before cleanup");
  [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.includes("Clean old archived history")).click();
  await until(() => cleanupCalls === 1 && document.querySelector('[role="dialog"]')?.textContent.includes("Deleted 0 old archived chats"), "cleanup used saved age");
  assert(age()?.value === "45", "History refresh discarded an unsaved Settings draft");
  assert(!document.querySelector(".archived-history-list"), "Missing archived array crashed or rendered a list");
  setControlValue(age(), "60");
  // A second authorized session tightens execution limits after this dialog
  // opened. Saving the age must leave those shared limits intact.
  saved = { ...saved, maxConcurrentRuns: 1, maxQueuedRuns: 1, approvalPolicy: "read-only" };
  [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.includes("Save settings")).click();
  await until(() => !document.querySelector('[role="dialog"]'), "saved settings closed");
  open();
  try { await until(() => age()?.value === "60", "saved retention age reloaded"); }
  catch (error) { throw new Error(`${error.message}; patchCalls=${patchCalls}, saved=${saved.retentionDays}, visible=${age()?.value}, dialog=${Boolean(document.querySelector('[role="dialog"]'))}`); }
  assert(patchCalls === 1 && saved.retentionDays === 60, "Settings save did not persist the new age once");
  assert(saved.maxConcurrentRuns === 1 && saved.maxQueuedRuns === 1 && saved.approvalPolicy === "read-only",
    "An older Settings draft overwrote another session's resource or execution policy");
}

async function settingsSaveSessionFenceRegression() {
  const settings = { provider: "codex", model: "", approvalPolicy: "read-only", reasoningEffort: "medium",
    editor: "code", notifications: false, maxConcurrentRuns: 2, maxQueuedRuns: 32, maxRetainedMiB: 64, retentionDays: 90 };
  for (const method of ["GET", "PATCH"]) {
    for (const outcome of ["success", "failure"]) {
      root.render(null);
      await settle();
      const held = deferred();
      let started = false;
      let saved = 0;
      let errors = 0;
      let requests = 0;
      route = async (url, options) => {
        if (url.pathname === "/api/capacity") return response({});
        if (url.pathname === "/api/retention/archived") return response({ conversations: [] });
        if (url.pathname === "/api/settings") {
          requests += 1;
          if (requests === 1) { started = true; return held.promise; }
          return response({ ...settings, retentionDays: 70 });
        }
        return response({});
      };
      function Fixture() {
        const [open, setOpen] = React.useState(false);
        return <><button onClick={() => setOpen(true)}>Open save fixture</button><SettingsDialog open={open}
          onOpenChange={setOpen} settings={settings} providers={[{ id: "codex", label: "Codex", available: true }]}
          templates={[]} onSaved={(_, refresh) => { if (!refresh) saved += 1; }} onError={() => { errors += 1; }} /></>;
      }
      root.render(<TooltipProvider><Fixture /></TooltipProvider>);
      await until(() => host.querySelector("button"), "save fixture mounted"); // NOSONAR S9382: Settings session steps observe the previous step
      const open = () => host.querySelector("button").click();
      const age = () => document.querySelector('[role="dialog"] label:last-of-type input');
      const action = (label) => [...document.querySelectorAll('[role="dialog"] button')]
        .find((button) => button.textContent.includes(label)).click();
      open();
      await until(() => age()?.value === "90", "save fixture opened"); // NOSONAR S9382: Settings session steps observe the previous step
      if (method === "PATCH") setControlValue(age(), "60");
      action("Save settings");
      await until(() => started, "old Settings save held"); // NOSONAR S9382: Settings session steps observe the previous step
      action("Cancel");
      await until(() => !document.querySelector('[role="dialog"]'), "old Settings closed"); // NOSONAR S9382: Settings session steps observe the previous step
      open();
      await until(() => age()?.value === "90", "new Settings session opened"); // NOSONAR S9382: Settings session steps observe the previous step
      setControlValue(age(), "70");
      age().focus();
      if (outcome === "success") held.resolve(response({ ...settings, retentionDays: 60 }));
      else held.reject(new Error("old Settings request failed"));
      await settle();
      assert(age()?.value === "70" && document.activeElement === age(), `${method} ${outcome} changed new Settings draft or focus`);
      assert(saved === 0 && errors === 0, `${method} ${outcome} published an old Settings completion`);
      action("Save settings");
      await until(() => !document.querySelector('[role="dialog"]') && saved === 1, // NOSONAR S9382: Settings session steps observe the previous step
        `current Settings save after stale ${method} ${outcome}`);
    }
  }
  await settingsAppRefreshFenceRegression();
}

async function settingsAppRefreshFenceRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const initial = { provider: "codex", model: "", approvalPolicy: "read-only", reasoningEffort: "medium",
    editor: "code", notifications: false, maxConcurrentRuns: 2, maxQueuedRuns: 32, maxRetainedMiB: 64, retentionDays: 90 };
  const oldPatch = deferred();
  const oldBootstrap = deferred();
  let saved = initial;
  let patches = 0;
  let holdBootstrap = false;
  let heldBootstrapStarted = false;
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") {
      if (holdBootstrap) { holdBootstrap = false; heldBootstrapStarted = true; return oldBootstrap.promise; }
      return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: saved,
        providers: [{ id: "codex", label: "Codex", available: true }], templates: [], trustedProjects: [] });
    }
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    if (url.pathname === "/api/capacity") return response({});
    if (url.pathname === "/api/retention/archived") return response({ conversations: [] });
    if (url.pathname === "/api/settings" && options.method === "PATCH") {
      patches += 1;
      saved = { ...saved, ...JSON.parse(options.body) };
      return patches === 1 ? oldPatch.promise : response(saved);
    }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('[aria-label="Settings"]'), "app settings refresh fixture");
  const open = () => host.querySelector('[aria-label="Settings"]').click();
  const age = () => document.querySelector('[role="dialog"] label:last-of-type input');
  const action = (label) => [...document.querySelectorAll('[role="dialog"] button')]
    .find((button) => button.textContent.includes(label)).click();
  open();
  await until(() => age()?.value === "90", "old app Settings opened");
  setControlValue(age(), "60");
  action("Save settings");
  await until(() => patches === 1, "old app Settings PATCH held");
  action("Cancel");
  await until(() => !document.querySelector('[role="dialog"]'), "old app Settings closed");
  open();
  await until(() => age()?.value === "90", "new app Settings opened");
  setControlValue(age(), "70");
  holdBootstrap = true;
  oldPatch.resolve(response({ ...initial, retentionDays: 60 }));
  await until(() => heldBootstrapStarted, "stale PATCH requested authoritative refresh");
  assert(age()?.value === "70", "stale PATCH replaced the new App Settings draft");
  action("Save settings");
  await until(() => patches === 2 && !document.querySelector('[role="dialog"]'), "current app Settings saved");
  oldBootstrap.resolve(response({ projects, projectGroups: { groups: [], memberships: {} },
    settings: { ...initial, retentionDays: 60 }, providers: [{ id: "codex", label: "Codex", available: true }],
    templates: [], trustedProjects: [] }));
  await settle();
  open();
  await until(() => age()?.value === "70", "stale bootstrap did not undo current Settings save");
}

async function settingsSharedRefreshOrderRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const settings = { provider: "codex", model: "", approvalPolicy: "read-only", reasoningEffort: "medium",
    editor: "code", notifications: false, maxConcurrentRuns: 2, maxQueuedRuns: 32, maxRetainedMiB: 64, retentionDays: 90 };
  const heldBootstrap = deferred();
  let holdRefresh = false;
  let refreshStarted = false;
  let saved = settings;
  const bootstrap = (currentSettings, templates = []) => ({ projects, projectGroups: { groups: [], memberships: {} },
    settings: currentSettings, providers: [{ id: "codex", label: "Codex", available: true }], templates, trustedProjects: [] });
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") {
      if (holdRefresh) { refreshStarted = true; holdRefresh = false; return heldBootstrap.promise; }
      return response(bootstrap(saved));
    }
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    if (url.pathname === "/api/capacity") return response({});
    if (url.pathname === "/api/retention/archived") return response({ conversations: [] });
    if (url.pathname === "/api/templates") { holdRefresh = true; return response({ id: "template-1" }); }
    if (url.pathname === "/api/settings" && options.method === "PATCH") {
      saved = { ...saved, ...JSON.parse(options.body) };
      return response(saved);
    }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('[aria-label="Settings"]'), "shared refresh app loaded");
  host.querySelector('[aria-label="Settings"]').click();
  await until(() => document.querySelector('[aria-label="Template name"]'), "shared refresh settings opened");
  setControlValue(document.querySelector('[aria-label="Template name"]'), "Review");
  setControlValue(document.querySelector('[aria-label="Template prompt"]'), "Review diff");
  [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Add template").click();
  await until(() => refreshStarted, "template bootstrap held");
  const age = document.querySelector('[role="dialog"] label:last-of-type input');
  setControlValue(age, "30");
  [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Save settings").click();
  await until(() => !document.querySelector('[role="dialog"]'), "settings saved while template refresh pending");
  heldBootstrap.resolve(response(bootstrap(settings, [{ id: "template-1", title: "Review", prompt: "Review diff" }])));
  host.querySelector('[aria-label="Settings"]').click();
  await until(() => document.querySelector('[role="dialog"] label:last-of-type input')?.value === "30", "newer saved quota preserved");
  await until(() => document.querySelector(".template-list")?.textContent.includes("Review diff"), "earlier template refresh still committed");
}

async function bootstrapRefreshErrorOwnershipRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const linkedProjects = projects.map((item) => item.id === "A"
    ? { ...item, worktrees: [{ ...item.worktrees[0], isLinked: true }] } : item);
  const heldBootstrap = deferred();
  const scanError = `Scan failed: ${"A long project scan error must stay readable when it wraps. ".repeat(8)}`;
  const loadingError = `Bootstrap failed: ${"The background refresh could not read the project inventory. ".repeat(5)}`;
  let bootstrapCalls = 0;
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) return response({ projects: linkedProjects, projectGroups: { groups: [], memberships: {} },
        settings: { provider: "codex", approvalPolicy: "read-only" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
      if (bootstrapCalls === 2) return heldBootstrap.promise;
      return response({ error: loadingError }, 500);
    }
    if (url.pathname === "/api/worktrees" && options.method === "DELETE") return response({});
    if (url.pathname === "/api/projects" && options.method === "POST") return response({ error: scanError }, 500);
    if (url.pathname === "/api/conversations") return response({ conversations: [] });
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('[aria-label="Worktree options"]'), "linked worktree options");
  host.querySelector('[aria-label="Worktree options"]').click();
  await until(() => [...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent.includes("Remove worktree")), "remove worktree menu item");
  [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes("Remove worktree")).click();
  await until(() => document.querySelector("#remove-worktree-confirmation"), "remove worktree confirmation");
  setControlValue(document.querySelector("#remove-worktree-confirmation"), "/fixture/A");
  [...document.querySelectorAll('[role="dialog"] button')].find((item) => item.textContent === "Remove worktree").click();
  await until(() => bootstrapCalls === 2, "background bootstrap held after worktree removal");
  const nativeSetTimeout = window.setTimeout;
  const nativeClearTimeout = window.clearTimeout;
  const dismissTimers = new Map();
  let virtualNow = 0;
  let nextTimer = 1_000_000;
  window.setTimeout = (callback, delay, ...args) => {
    if (delay !== 6000) return nativeSetTimeout.call(window, callback, delay, ...args);
    const id = nextTimer++;
    dismissTimers.set(id, { due: virtualNow + delay, callback, args });
    return id;
  };
  window.clearTimeout = (id) => {
    if (dismissTimers.delete(id)) return;
    nativeClearTimeout.call(window, id);
  };
  try {
    [...host.querySelectorAll("button")].find((item) => item.textContent.includes("Scan projects")).click();
    await until(() => host.querySelector('.error-toast')?.textContent.includes("Scan failed"), "manual scan error displayed");
    heldBootstrap.resolve(response({ projects: [projects[1]], projectGroups: { groups: [], memberships: {} },
      settings: { provider: "codex", approvalPolicy: "read-only" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] }));
    await until(() => host.querySelector('.workspace-context')?.textContent.includes("Review B"), "background bootstrap finished");
    assert(host.querySelector('.error-toast')?.textContent.includes("Scan failed"), "background bootstrap dismissed an unrelated operation error");
    fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "runtime.connected", payload: { restarted: true } }) }));
    await until(() => host.querySelectorAll('.error-toast').length === 2, "operation and bootstrap errors remain visible together");
    const [operationToast, bootstrapToast] = host.querySelectorAll('.error-toast');
    const operationBox = operationToast.getBoundingClientRect();
    const bootstrapBox = bootstrapToast.getBoundingClientRect();
    assert(operationBox.height > 52 && bootstrapBox.bottom + 8 <= operationBox.top,
      `Wrapped errors overlap: operation=${operationBox.top}/${operationBox.bottom}, bootstrap=${bootstrapBox.top}/${bootstrapBox.bottom}`);
    await settle();
    // Advance only the six-second dismissal timer. Provider updates replace
    // bootstrap state, but cannot postpone an error already announced.
    for (let index = 0; index < 3; index += 1) {
      virtualNow += 1000;
      fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "providers.changed", payload: { providers: [{ id: "codex", available: true }] } }) }));
      await settle();
    }
    virtualNow = 6500;
    for (const [id, timer] of dismissTimers) {
      if (timer.due <= virtualNow) { dismissTimers.delete(id); timer.callback(...timer.args); }
    }
    await settle();
    assert(!host.querySelector('[aria-label="Dismiss loading error"]'),
      "bootstrap error timer restarted after unrelated provider updates");
  } finally {
    window.setTimeout = nativeSetTimeout;
    window.clearTimeout = nativeClearTimeout;
  }
}

async function settingsMigrationCompletionRegression() {
  root.render(null);
  await settle();
  const settings = { provider: "codex", model: "", approvalPolicy: "read-only", reasoningEffort: "medium",
    editor: "code", notifications: false, maxConcurrentRuns: 2, maxQueuedRuns: 32, maxRetainedMiB: 64, retentionDays: 90 };
  let measured = false;
  let signalCompletion;
  let reads = 0;
  route = async (url) => {
    if (url.pathname === "/api/capacity") {
      reads += 1;
      return response({ queued: 0, active: 0, recoverable: 0,
        retainedBytes: measured ? 1024 : null, migrationStatus: measured ? "ready" : "migrating",
        availableForNewWorkBytes: measured ? 63 * 1048576 : 0,
        limits: { maxQueuedRuns: 32, maxConcurrentRuns: 2, maxRetainedBytes: 64 * 1048576, reservedRetainedBytes: 1048576 } });
    }
    if (url.pathname === "/api/retention/archived") return response({ conversations: [] });
    return response({});
  };
  function Fixture() {
    const [open, setOpen] = React.useState(false);
    const [event, setEvent] = React.useState(null);
    signalCompletion = () => { measured = true; setEvent({ type: "capacity.changed" }); };
    return <><button onClick={() => setOpen(true)}>Open migration fixture</button><SettingsDialog open={open}
      onOpenChange={setOpen} settings={settings} providers={[{ id: "codex", label: "Codex", available: true }]}
      templates={[]} runtimeEvent={event} onSaved={() => {}} onError={(error) => { throw error; }} /></>;
  }
  root.render(<TooltipProvider><Fixture /></TooltipProvider>);
  await until(() => host.querySelector("button")?.textContent === "Open migration fixture", "migration settings fixture");
  host.querySelector("button").click();
  await until(() => document.querySelector(".capacity-status")?.textContent.includes("new work paused"), "migration warning shown");
  signalCompletion();
  await until(() => document.querySelector(".capacity-status")?.textContent.includes("available for new work"), "migration warning cleared while Settings stayed open");
  assert(reads >= 2, "capacity completion did not read authoritative state");
}

// An open setup dialog reloads on reconnect: a restarted runtime reports an
// interrupted run without any event. An older read that answers late never
// replaces a newer state, also across closing and reopening. Unconfirmed
// processes are acknowledged explicitly. Teardown choices are a labelled
// radio group, and the acknowledgement it sends is bound to its worktree.
async function worktreeLifecycleRegression() {
  root.render(null); await settle();
  const project = projects[0];
  const worktree = project.worktrees[0];
  const config = { digest: "sha256:abc", error: null, trusted: true, teardown: [],
    setup: [{ name: "Install", command: ["npm", "ci"], timeoutSeconds: 600 }, { name: "Seed", command: ["npm", "run", "seed"], timeoutSeconds: 600 }] };
  const state = { worktreePath: worktree.path, discoveredPath: worktree.path, projectId: project.id, phase: "setup", configDigest: "sha256:abc", steps: ["Install", "Seed"],
    stepIndex: 1, runId: "run-1", output: "installed\n", outputEnd: 10, outputTruncated: false, outcomeUnknown: false };
  let detail = { file: "outright.worktree.json", worktreePath: worktree.path, config, running: "setup", state: { ...state, status: "running" } };
  const reads = [];
  const posts = [];
  // A read answered by the test, in any order, instead of at once.
  let held = null;
  route = async (url, options) => {
    if (url.pathname === "/api/worktrees/lifecycle") {
      reads.push(url.searchParams.get("path"));
      if (held) { const answer = deferred(); held.push(answer); return answer.promise; }
      return response(detail);
    }
    if (options.method === "POST") posts.push({ path: url.pathname, body: JSON.parse(options.body) });
    return response({});
  };
  const events = new EventTarget();
  const errors = [];
  const render = (open) => root.render(<TooltipProvider><WorktreeLifecycleDialog open={open} onOpenChange={() => {}} project={project} worktree={worktree} events={events} onError={(error) => errors.push(error)} /></TooltipProvider>);
  render(true);
  const dialog = () => document.querySelector(".lifecycle-dialog");
  const buttons = () => [...(dialog()?.querySelectorAll("button") ?? [])].map((button) => button.textContent);
  await until(() => buttons().includes("Cancel setup"), "running setup offers cancel");
  assert(reads.every((path) => path === worktree.path), "the dialog named its worktree by something other than its path");
  // The runtime restarted while the client was away.
  const checkpoints = { setup: { configDigest: "sha256:abc", stepIndex: 1 } };
  const running = detail;
  const interrupted = { ...detail, running: null, state: { ...state, status: "interrupted", checkpoints, error: "Outright stopped during step 2; its effects may be partial." } };
  detail = interrupted;
  events.dispatchEvent(new CustomEvent("reconnect"));
  await until(() => buttons().includes("Retry from step 2"), "reconnect did not reconcile the interrupted run");
  assert(!buttons().includes("Cancel setup"), "an interrupted run still offered cancel");
  const summary = dialog().querySelector('.lifecycle-summary[role="status"]');
  assert(/Setup interrupted at step 2 of 2, Seed/.test(summary?.textContent ?? ""), "the interrupted state was not announced");

  // Two reads overlap and the older one, from while setup ran, answers last.
  const failedDetail = { ...interrupted, state: { ...interrupted.state, status: "failed", runId: "run-2", error: "\"Seed\" exited with status 1." } };
  held = [];
  events.dispatchEvent(new CustomEvent("reconnect"));
  events.dispatchEvent(new CustomEvent("reconnect"));
  await until(() => held.length === 2, "both reads were not issued");
  held[1].resolve(response(failedDetail));
  await until(() => /Setup failed/.test(dialog().querySelector(".lifecycle-summary")?.textContent ?? ""), "the newer failure was not shown");
  held[0].resolve(response(running));
  await remainsTrue(() => /Setup failed/.test(dialog().querySelector(".lifecycle-summary")?.textContent ?? "") && !buttons().includes("Cancel setup"),
    150, "a late older read replaced the newer failure");
  assert(buttons().includes("Retry from step 2"), "the failure lost its retry control");
  // A read from before the dialog closed never lands in the reopened one.
  held = [];
  events.dispatchEvent(new CustomEvent("reconnect"));
  await until(() => held.length === 1, "the read before closing was not issued");
  render(false); await settle();
  render(true);
  await until(() => held.length === 2, "reopening did not read again");
  held[1].resolve(response(failedDetail));
  await until(() => buttons().includes("Retry from step 2"), "the reopened dialog did not load");
  held[0].resolve(response(running));
  await remainsTrue(() => !buttons().includes("Cancel setup"), 150, "a read from before closing replaced the reopened dialog's state");
  // A read answered after newer output of the same run keeps that output.
  held = null;
  detail = running;
  events.dispatchEvent(new CustomEvent("reconnect"));
  await until(() => buttons().includes("Cancel setup"), "the running setup did not load");
  held = [];
  events.dispatchEvent(new CustomEvent("reconnect"));
  await until(() => held.length === 1, "the read was not issued");
  const output = () => dialog().querySelector(".lifecycle-output")?.textContent ?? "";
  events.dispatchEvent(new CustomEvent("output", { detail: { worktreePath: worktree.path, runId: "run-1", start: 10, text: "seeding\n" } }));
  await until(() => output().includes("installed\nseeding\n"), "streamed output was not shown");
  held[0].resolve(response(running));
  await remainsTrue(() => output().includes("installed\nseeding\n"), 150, "a read answered late took away newer streamed output");
  held = null;

  // Unconfirmed processes hold agent work until the user acknowledges them.
  detail = { ...interrupted, state: { ...interrupted.state, outcomeUnknown: true } };
  events.dispatchEvent(new CustomEvent("reconnect"));
  await until(() => buttons().includes("Acknowledge"), "unconfirmed processes offered no acknowledgement");
  const acknowledge = [...dialog().querySelectorAll("button")].find((button) => button.textContent === "Acknowledge");
  assert(acknowledge.disabled, "acknowledgement did not wait for the user's confirmation");
  assert(/agent runs here wait/.test(dialog().querySelector(".lifecycle-summary")?.textContent ?? ""), "the hold on agent runs was not stated");
  const confirm = () => dialog().querySelector('.lifecycle-acknowledge input[type="checkbox"]');
  confirm().click();
  await until(() => !acknowledge.disabled, "the acknowledgement stayed disabled");
  // A newer attempt that also left processes unconfirmed is never shown as
  // already checked: each attempt needs its own acknowledgement.
  detail = { ...interrupted, state: { ...interrupted.state, runId: "run-3", outcomeUnknown: true } };
  events.dispatchEvent(new CustomEvent("reconnect"));
  await until(() => !confirm().checked && acknowledge.disabled, "a newer unconfirmed attempt kept the earlier acknowledgement");
  confirm().click();
  await until(() => !acknowledge.disabled, "the acknowledgement stayed disabled");
  detail = interrupted;
  acknowledge.click();
  await until(() => posts.some((post) => post.path === "/api/worktrees/lifecycle/acknowledge"), "the acknowledgement was not sent");
  const sentAcknowledgement = posts.find((post) => post.path === "/api/worktrees/lifecycle/acknowledge");
  assert(sentAcknowledgement.body.worktreePath === worktree.path && sentAcknowledgement.body.projectId === project.id, "the acknowledgement named another worktree");
  assert(sentAcknowledgement.body.acknowledgeUnconfirmed === "run-3", "the acknowledgement did not name the attempt shown");
  await until(() => !buttons().includes("Acknowledge"), "the acknowledged state was not reloaded");
  // Progress belongs to the file version that ran: after the file changes,
  // none of its steps is marked, and the outcome says it was for the earlier file.
  const changed = { ...config, digest: "sha256:def", setup: [...config.setup, { name: "Migrate", command: ["npm", "run", "migrate"], timeoutSeconds: 600 }] };
  for (const status of ["ready", "failed"]) {
    detail = { ...interrupted, config: changed, state: { ...interrupted.state, status, checkpoints: {} } };
    events.dispatchEvent(new CustomEvent("reconnect"));
    await until(() => dialog().querySelectorAll(".lifecycle-steps li").length === 3, `${status}: the changed file was not shown`);
    const marked = [...dialog().querySelectorAll(".lifecycle-steps li")].filter((step) => step.className);
    assert(marked.length === 0, `${status}: steps of the changed file were marked ${marked.map((step) => step.className).join(", ")}`);
    assert(/earlier version of outright\.worktree\.json/.test(dialog().querySelector(".lifecycle-summary")?.textContent ?? ""), `${status}: the outcome was not tied to the earlier file`);
  }
  assert(buttons().includes("Run setup"), "a changed file offered to run setup again or retry");
  // Trusting a file can leave setup unrun, so a teardown that a removal
  // refused for review runs from its checkpoint before setup provisions.
  detail = { ...interrupted, config: { ...config, trusted: false, teardown: [{ name: "Down", command: ["docker", "compose", "down"], timeoutSeconds: 600 }] },
    state: { ...state, phase: "teardown", status: "needs-trust", steps: ["Down"], stepIndex: 0, checkpoints: { teardown: { configDigest: "sha256:abc", stepIndex: 0 } } } };
  events.dispatchEvent(new CustomEvent("reconnect"));
  await until(() => buttons().includes("Trust without running setup") && buttons().includes("Trust and run setup"), "trusting offered no choice to leave setup unrun");
  posts.length = 0;
  [...dialog().querySelectorAll("button")].find((button) => button.textContent === "Trust without running setup").click();
  await until(() => posts.some((post) => post.path === "/api/worktrees/lifecycle/trust"), "trust was not sent");
  await remainsTrue(() => !posts.some((post) => post.path === "/api/worktrees/lifecycle/setup"), 150, "trusting started setup");
  assert(posts[0].body.digest === "sha256:abc", "trust did not name the reviewed file");
  assert(errors.length === 0, `unexpected lifecycle errors: ${errors.map((error) => error.message).join("; ")}`);

  const failure = Object.assign(new Error("Teardown did not finish"), { payload: { code: "LIFECYCLE_OUTCOME_UNKNOWN", runId: "run-3" } });
  let problem = teardownProblem(failure, worktree.path);
  const sent = [];
  function Choices() {
    const [current, setCurrent] = React.useState(problem);
    problem = current;
    return <div><TeardownChoices problem={current} onChoose={(choice) => setCurrent({ ...current, choice })} />
      <button type="button" onClick={() => sent.push(removalRequest({ projectId: project.id, worktreePath: worktree.path, confirmation: worktree.path }, current))}>Remove fixture</button></div>;
  }
  root.render(<Choices />);
  await until(() => host.querySelector(".lifecycle-choices legend")?.textContent === "Next attempt", "teardown choices render as a labelled group");
  const radios = [...host.querySelectorAll('.lifecycle-choices input[type="radio"]')];
  assert(radios.length === 2 && radios.every((radio) => !radio.checked), "unconfirmed processes preselected a choice");
  assert(radios.every((radio) => radio.closest("label")?.textContent.length > 20), "a teardown choice has no visible label");
  radios[0].focus();
  radios[0].click();
  await until(() => problem.choice === "acknowledge", "the acknowledgement was not chosen");
  host.querySelector("button").click();
  assert(sent.at(-1)?.acknowledgeUnconfirmed === "run-3" && sent.at(-1).skipTeardown === undefined, "the acknowledgement was not sent with the removal");
  radios[1].click();
  await until(() => problem.choice === "skip", "skip was not chosen");
  host.querySelector("button").click();
  assert(sent.at(-1)?.skipTeardown === true && sent.at(-1).acknowledgeUnconfirmed === "run-3", "skipping beside unconfirmed processes did not acknowledge them");
  assert(/confirmed stopped/.test(radios[1].closest("label").textContent), "the skip choice did not say it acknowledges the processes");
  // Without teardown steps the only choice is an acknowledged removal.
  root.render(null); await settle();
  problem = teardownProblem(Object.assign(new Error("Unconfirmed"), { payload: { code: "LIFECYCLE_OUTCOME_UNKNOWN", runId: "run-4", teardown: false } }), worktree.path);
  root.render(<Choices />);
  await until(() => host.querySelectorAll('.lifecycle-choices input[type="radio"]').length === 1, "a removal without teardown offered teardown choices");
  const only = host.querySelector('.lifecycle-choices input[type="radio"]');
  assert(/I checked them; remove the worktree/.test(only.closest("label").textContent) && !only.checked, "the removal acknowledgement was not explicit");
  only.click();
  await until(() => problem.choice === "acknowledge", "the removal acknowledgement was not chosen");
  host.querySelector("button").click();
  assert(sent.at(-1)?.acknowledgeUnconfirmed === "run-4" && sent.at(-1).skipTeardown === undefined, "the removal did not name the attempt shown");
  root.render(null); await settle();
  await lifecycleStatusOrder();
}

// The toolbar chip, sidebar mark and announcement show the newest state:
// a bootstrap snapshot read before an event never replaces it, whichever
// arrives first, and events before the first bootstrap are kept.
async function lifecycleStatusOrder() {
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const worktree = projects[0].worktrees[0];
  const state = (status, revision) => ({ worktreePath: worktree.path, discoveredPath: worktree.path, projectId: "A", phase: "setup",
    status, steps: ["Install", "Seed"], stepIndex: 1, runId: "run-1", revision });
  let held = deferred();
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return held.promise;
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    return response({});
  };
  const snapshot = (states, revision) => response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" },
    providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [], worktreeLifecycle: states, worktreeLifecycleRevision: revision });
  const send = (event) => fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  const chip = () => host.querySelector(".workspace-tools .lifecycle-state")?.textContent ?? "";
  const mark = () => host.querySelector(".worktree-row.is-active .lifecycle-mark")?.textContent ?? "";
  const announced = () => [...host.querySelectorAll('.workspace-tools [role="status"]')].map((node) => node.textContent).join(" ");
  const sockets = fixtureSockets.length;
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => fixtureSockets.length > sockets, "the runtime socket did not open");
  // An event before the first bootstrap answers is newer than its snapshot.
  send({ type: "worktree.lifecycle", payload: state("failed", 12) });
  held.resolve(snapshot([state("running", 10)], 11));
  await until(() => chip() === "Setup failed", "the bootstrap snapshot replaced an earlier-delivered newer failure");
  await remainsTrue(() => chip() === "Setup failed" && /Setup failed at step 2 of 2/.test(mark()), 150, "the sidebar did not show the newer failure");
  // A reload is held while a newer state and then a removal arrive.
  for (const [order, base] of [["event first", 20], ["snapshot first", 30]]) {
    send({ type: "worktree.lifecycle", payload: state("running", base) });
    await until(() => chip() === "Setup 2/2", `${order}: the running state was not shown`);
    held = deferred();
    send({ type: "runtime.connected", payload: { replay: { missed: true } } });
    if (order === "event first") {
      send({ type: "worktree.lifecycle", payload: state("failed", base + 2) });
      await until(() => chip() === "Setup failed" && /Setup failed/.test(announced()), `${order}: the failure was not shown`);
      held.resolve(snapshot([state("running", base)], base + 1));
      await remainsTrue(() => chip() === "Setup failed" && /Setup failed/.test(mark()) && /Setup failed/.test(announced()), 150,
        `${order}: an older snapshot replaced the newer failure (chip "${chip()}", mark "${mark()}", announced "${announced()}")`);
      send({ type: "worktree.lifecycle", payload: { worktreePath: worktree.path, removed: true, revision: base + 3 } });
    } else {
      held.resolve(snapshot([state("running", base)], base + 1));
      await settle();
      send({ type: "worktree.lifecycle", payload: state("failed", base + 2) });
      send({ type: "worktree.lifecycle", payload: { worktreePath: worktree.path, removed: true, revision: base + 3 } });
      // A late copy of the failure never brings a removed state back.
      send({ type: "worktree.lifecycle", payload: state("failed", base + 2) });
    }
    await until(() => !chip() && !mark(), `${order}: the removal was not shown`);
    held = deferred();
    send({ type: "runtime.connected", payload: { replay: { missed: true } } });
    held.resolve(snapshot([state("failed", base + 2)], base + 2));
    await remainsTrue(() => !chip() && !mark(), 150, `${order}: a snapshot read before the removal brought the state back`);
  }
  // Trusting the file from a sibling worktree runs nothing here, so this
  // worktree's setup is still a visible prompt.
  send({ type: "worktree.lifecycle", payload: { ...state("trusted", 40), stepIndex: 0 } });
  await until(() => chip() === "Run setup" && /setup has not run/.test(mark()), `a trusted setup that has not run looked ready (chip "${chip()}", mark "${mark()}")`);
  // A refresh that no longer lists the worktree decides it as of its read:
  // a late replayed event from before then stays out, and a newer one shows.
  held = deferred();
  send({ type: "runtime.connected", payload: { replay: { missed: true } } });
  held.resolve(snapshot([], 50));
  await until(() => !chip() && !mark(), "a snapshot without the state did not clear it");
  send({ type: "worktree.lifecycle", payload: state("failed", 48) });
  await remainsTrue(() => !chip() && !mark(), 150, `an event older than the applied snapshot came back (chip "${chip()}")`);
  send({ type: "worktree.lifecycle", payload: state("failed", 51) });
  await until(() => chip() === "Setup failed", "an event newer than the snapshot was not shown");
  root.render(null); await settle();
  await lifecycleDialogAfterRemoval();
  await lifecycleRemovalCancel();
}

// Watching teardown progress during a removal never leaves the setup dialog
// open for whichever worktree is selected after the removal.
async function lifecycleDialogAfterRemoval() {
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const linkedProjects = projects.map((item) => item.id === "A" ? { ...item, worktrees: [{ ...item.worktrees[0], isLinked: true }] } : item);
  const removal = deferred();
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: linkedProjects, projectGroups: { groups: [], memberships: {} },
      settings: { provider: "codex", approvalPolicy: "read-only" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/worktrees" && options.method === "DELETE") return removal.promise;
    if (url.pathname === "/api/worktrees/lifecycle") return response({ file: "outright.worktree.json", worktreePath: url.searchParams.get("path"), config: null, state: null, running: null });
    if (url.pathname === "/api/conversations") return response({ conversations: [] });
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('[aria-label="Worktree options"]'), "linked worktree options");
  host.querySelector('[aria-label="Worktree options"]').click();
  await until(() => [...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent.includes("Remove worktree")), "remove worktree menu item");
  [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes("Remove worktree")).click();
  await until(() => document.querySelector("#remove-worktree-confirmation"), "remove worktree confirmation");
  setControlValue(document.querySelector("#remove-worktree-confirmation"), "/fixture/A");
  [...document.querySelectorAll('[role="dialog"] button')].find((item) => item.textContent === "Remove worktree").click();
  await until(() => [...document.querySelectorAll("button")].some((item) => item.textContent === "Show teardown progress"), "teardown progress was not offered");
  [...document.querySelectorAll("button")].find((item) => item.textContent === "Show teardown progress").click();
  await until(() => document.querySelector(".lifecycle-dialog"), "teardown progress did not open");
  removal.resolve(response({ removed: true }));
  await until(() => document.querySelector(".toast")?.textContent.includes("Worktree removed"), "the removal did not finish");
  await remainsTrue(() => !document.querySelector(".lifecycle-dialog"), 150, "the setup dialog stayed open after the removal");
  root.render(null); await settle();
}

// A pending removal is cancelled only by Cancel removal, for the worktree it
// started for; closing the dialog lets it continue, and its outcome never
// shows under another worktree.
async function lifecycleRemovalCancel() {
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const sibling = { id: "A2", name: "A2", path: "/fixture/A2", branch: "next", changedCount: 0, isLinked: true };
  const linkedProjects = projects.map((item) => item.id === "A" ? { ...item, worktrees: [{ ...item.worktrees[0], isLinked: true }, sibling] } : item);
  let removal = deferred();
  let cancelReply = () => response({ state: null });
  const sent = [];
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: linkedProjects, projectGroups: { groups: [], memberships: {} },
      settings: { provider: "codex", approvalPolicy: "read-only" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname.startsWith("/api/worktrees") && options?.method && options.method !== "GET") sent.push({ path: url.pathname, body: JSON.parse(options.body ?? "null") });
    if (url.pathname === "/api/worktrees" && options?.method === "DELETE") return removal.promise;
    if (url.pathname === "/api/worktrees/lifecycle/cancel") return cancelReply();
    if (url.pathname === "/api/conversations") return response({ conversations: [] });
    return response({});
  };
  const buttons = (scope = document) => [...scope.querySelectorAll("button")];
  const dialog = () => [...document.querySelectorAll('[role="dialog"]')].find((node) => node.querySelector("#remove-worktree-confirmation"));
  const kept = (message) => response({ error: message, code: "WORKTREE_TEARDOWN_FAILED", lifecycle: { worktreePath: "/fixture/A", phase: "teardown", status: "cancelled" } }, 409);
  async function startRemoval(path) {
    host.querySelector('[aria-label="Worktree options"]').click();
    await until(() => [...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent.includes("Remove worktree")), "remove worktree menu item");
    [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes("Remove worktree")).click();
    await until(() => dialog(), "remove worktree confirmation");
    setControlValue(document.querySelector("#remove-worktree-confirmation"), path);
    buttons(dialog()).find((item) => item.textContent === "Remove worktree").click();
    await until(() => buttons(dialog()).some((item) => item.textContent === "Cancel removal"), "Cancel removal was not offered while removing");
  }
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('[aria-label="Worktree options"]'), "linked worktree options");
  // Cancel removal stops this worktree's teardown, and the worktree is kept.
  await startRemoval("/fixture/A");
  assert(!buttons(dialog()).some((item) => item.textContent === "Cancel") && buttons(dialog()).some((item) => item.textContent === "Close"), "dismissing a pending removal was labeled Cancel");
  buttons(dialog()).find((item) => item.textContent === "Cancel removal").click();
  await until(() => sent.some((item) => item.path === "/api/worktrees/lifecycle/cancel"), "Cancel removal did not cancel teardown");
  assert(sent.at(-1).body.worktreePath === "/fixture/A" && sent.at(-1).body.projectId === "A", "the cancel did not name the worktree being removed");
  removal.resolve(kept("Cancelled before Git removed anything, so the worktree was kept."));
  await until(() => /worktree was kept/.test(dialog()?.querySelector('[role="alert"]')?.textContent ?? ""), "a cancelled removal did not say the worktree was kept");
  assert(dialog().querySelectorAll('.lifecycle-choices input[type="radio"]').length > 0, "a cancelled removal offered no choices");
  assert([...host.querySelectorAll(".worktree-row strong")].some((node) => node.textContent === "A"), "a cancelled removal hid the worktree");
  // Once Git has started, the refused cancel is announced and nothing else is sent.
  buttons(dialog()).find((item) => item.textContent === "Cancel").click();
  await until(() => !dialog(), "the removal dialog did not close");
  removal = deferred();
  cancelReply = () => response({ error: "Git is already removing this worktree; that can no longer be cancelled", code: "WORKTREE_REMOVAL_STARTED" }, 409);
  await startRemoval("/fixture/A");
  const before = sent.length;
  buttons(dialog()).find((item) => item.textContent === "Cancel removal").click();
  await until(() => /can no longer be cancelled/.test(dialog().querySelector('[role="status"]')?.textContent ?? ""), "a cancel refused once Git started was not announced");
  await remainsTrue(() => sent.length === before + 1, 100, "a refused cancel sent another request");
  // Closing lets the removal continue; its refusal belongs to A, not to A2.
  buttons(dialog()).find((item) => item.textContent === "Close").click();
  await until(() => !dialog(), "Close did not close the pending removal dialog");
  assert(sent.length === before + 1, "Close cancelled the removal");
  [...host.querySelectorAll(".worktree-row")].find((row) => row.querySelector("strong")?.textContent === "A2").click();
  await until(() => host.querySelector(".workspace-context strong")?.textContent === "A2", "worktree A2 was not selected");
  // A2's dialog, open while A is still being removed, never takes A's outcome.
  host.querySelector('[aria-label="Worktree options"]').click();
  await until(() => [...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent.includes("Remove worktree")), "remove worktree menu item for A2");
  [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes("Remove worktree")).click();
  await until(() => /Another worktree is being removed/.test(dialog()?.textContent ?? ""), "A2's removal dialog did not say another removal is running");
  assert(!buttons(dialog()).some((item) => item.textContent === "Cancel removal"), "A2's dialog offered to cancel A's removal");
  removal.resolve(kept("Teardown did not finish, so the worktree was kept. Step Down failed."));
  await until(() => !/Another worktree is being removed/.test(dialog()?.textContent ?? ""), "A's removal did not finish");
  await remainsTrue(() => dialog() && !/Teardown did not finish/.test(dialog().textContent) && !dialog().querySelector(".lifecycle-choices"), 150, "A2's removal dialog showed A's refusal or choices");
  root.render(null); await settle();
}

// The refresh that drops a removed worktree can land before its DELETE
// answers and move the selection to the primary checkout. The remove and setup
// dialogs stay bound to the worktree they were opened for: they never show or
// act for the primary checkout, and a dialog opened for another worktree is
// left alone.
async function worktreeRemovalRetargetRegression() {
  keys.forEach((key, index) => localStorage.setItem(key, ["A", "A-two", "chat-A"][index]));
  const linked = (name) => ({ id: name, name, path: `/fixture/${name}`, branch: name, changedCount: 0, isLinked: true });
  const listed = (...names) => projects.map((item) => item.id === "A" ? { ...item, worktrees: [item.worktrees[0], ...names.map(linked)] } : item);
  let current = listed("A-two", "A-three", "A-four");
  let removal = deferred();
  let loads = 0;
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") { loads += 1; return response({ projects: current, projectGroups: { groups: [], memberships: {} },
      settings: { provider: "codex", approvalPolicy: "read-only" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] }); }
    if (url.pathname === "/api/worktrees" && options?.method === "DELETE") return removal.promise;
    if (url.pathname === "/api/worktrees/lifecycle") return response({ file: "outright.worktree.json", worktreePath: url.searchParams.get("path"), config: null, state: null, running: null });
    if (url.pathname === "/api/conversations") return response({ conversations: [] });
    return response({});
  };
  const buttons = (scope = document) => [...scope.querySelectorAll("button")];
  const dialog = () => [...document.querySelectorAll('[role="dialog"]')].find((node) => node.querySelector("#remove-worktree-confirmation"));
  const selected = () => host.querySelector(".workspace-context strong")?.textContent;
  const primaryShown = () => [...document.querySelectorAll('[role="dialog"]')].some((node) => node.querySelector(".confirm-path")?.textContent === "/fixture/A")
    || Boolean(document.querySelector(".lifecycle-dialog"));
  async function openRemove(path, confirmation) {
    host.querySelector('[aria-label="Worktree options"]').click();
    await until(() => [...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent.includes("Remove worktree")), `remove worktree menu item for ${path}`);
    [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes("Remove worktree")).click();
    await until(() => dialog()?.querySelector(".confirm-path")?.textContent === path, `the remove dialog did not open for ${path}`);
    setControlValue(document.querySelector("#remove-worktree-confirmation"), confirmation);
  }
  async function startRemoval(path) {
    await openRemove(path, path);
    buttons(dialog()).find((item) => item.textContent === "Remove worktree").click();
    await until(() => buttons(dialog()).some((item) => item.textContent === "Cancel removal"), `the removal of ${path} did not start`);
  }
  // Git has removed the worktree: the server's refresh lands, then the DELETE answers.
  async function finishAfterRefresh(removed, ...remaining) {
    current = listed(...remaining);
    fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "projects.changed", payload: { projects: current } }) }));
    await until(() => ![...host.querySelectorAll(".worktree-row strong")].some((node) => node.textContent === removed), `the refresh did not drop ${removed}`);
    await remainsTrue(() => !primaryShown(), 100, `a dialog for ${removed} was retargeted to the primary checkout before its removal answered`);
    const before = loads;
    removal.resolve(response({ removed: true }));
    await until(() => loads > before, "the removal did not finish");
    removal = deferred();
  }
  const choose = async (name) => {
    [...host.querySelectorAll(".worktree-row")].find((row) => row.querySelector("strong")?.textContent === name).click();
    await until(() => selected() === name, `worktree ${name} was not selected`);
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => selected() === "A-two", "linked worktree A-two was not selected");
  // The remove dialog is open when the refresh moves the selection to main.
  await startRemoval("/fixture/A-two");
  await finishAfterRefresh("A-two", "A-three", "A-four");
  assert(selected() === "A", "the removal did not fall back to the primary checkout");
  await until(() => !dialog(), "the remove dialog stayed open after its worktree was removed");
  await remainsTrue(() => !dialog() && !primaryShown(), 150, "a dialog was retargeted to the primary checkout after the removal");
  // A dialog opened for another worktree while one is being removed keeps its own target and confirmation.
  await choose("A-three");
  await startRemoval("/fixture/A-three");
  buttons(dialog()).find((item) => item.textContent === "Close").click();
  await until(() => !dialog(), "Close did not close the pending removal dialog");
  await choose("A-four");
  await openRemove("/fixture/A-four", "/fixture/A-fo");
  await finishAfterRefresh("A-three", "A-four");
  await remainsTrue(() => dialog()?.querySelector(".confirm-path")?.textContent === "/fixture/A-four"
    && document.querySelector("#remove-worktree-confirmation")?.value === "/fixture/A-fo", 150, "another worktree's removal closed or cleared this remove dialog");
  // Watching teardown progress when the refresh moves the selection to main.
  setControlValue(document.querySelector("#remove-worktree-confirmation"), "/fixture/A-four");
  buttons(dialog()).find((item) => item.textContent === "Remove worktree").click();
  await until(() => buttons(dialog()).some((item) => item.textContent === "Show teardown progress"), "teardown progress was not offered");
  buttons(dialog()).find((item) => item.textContent === "Show teardown progress").click();
  await until(() => document.querySelector(".lifecycle-dialog"), "teardown progress did not open");
  await finishAfterRefresh("A-four");
  await until(() => selected() === "A" && !document.querySelector(".lifecycle-dialog"), "the setup dialog stayed open after its worktree was removed");
  await remainsTrue(() => !dialog() && !primaryShown(), 150, "the setup dialog was retargeted to the primary checkout after the removal");
  root.render(null); await settle();
}

async function settingsCapacityWithoutEventRegression() {
  root.render(null); await settle();
  const settings = { provider: "codex", model: "", approvalPolicy: "read-only", reasoningEffort: "medium",
    editor: "code", notifications: false, maxConcurrentRuns: 2, maxQueuedRuns: 32, maxRetainedMiB: 64, retentionDays: 90 };
  let reads = 0;
  let otherClientCapacity = { queued: 0, active: 0, recoverable: 0, retainedBytes: 0,
    diskAllocatedBytes: 3 * 1048576, diskUsageStatus: "measured", availablePhysicalForNewWorkBytes: 5 * 1048576,
    utilityProcesses: { active: 0, limit: 8 }, terminalProcesses: { active: 0, unknown: 0, limit: 12 } };
  route = async (url) => {
    if (url.pathname === "/api/capacity") {
      reads += 1;
      return response({ migrationStatus: "ready", ...otherClientCapacity,
        availableForNewWorkBytes: 63 * 1048576 - otherClientCapacity.retainedBytes,
        limits: { maxQueuedRuns: 32, maxConcurrentRuns: 2, maxPendingRunOutcomes: 8, maxRetainedBytes: 64 * 1048576,
          reservedRetainedBytes: 1048576, maxPhysicalBytes: 10 * 1048576 } });
    }
    if (url.pathname === "/api/retention/archived") return response({ conversations: [] });
    return response({});
  };
  let signalChange;
  let eventSequence = 0;
  function Fixture() {
    const [open, setOpen] = React.useState(false);
    const [event, setEvent] = React.useState(null);
    signalChange = () => setEvent({ type: "capacity.changed", stamp: ++eventSequence });
    return <><button onClick={() => setOpen(true)}>Open live capacity</button><SettingsDialog open={open}
      onOpenChange={setOpen} settings={settings} providers={[{ id: "codex", label: "Codex", available: true }]}
      templates={[]} runtimeEvent={event} onSaved={() => {}} onError={(error) => { throw error; }} /></>;
  }
  root.render(<TooltipProvider><Fixture /></TooltipProvider>);
  await until(() => host.querySelector("button")?.textContent === "Open live capacity", "live capacity fixture");
  host.querySelector("button").click();
  await until(() => document.querySelector(".capacity-status")?.textContent.includes("0 of 32 queued"), "initial capacity read");
  otherClientCapacity = { ...otherClientCapacity, queued: 2, active: 1, recoverable: 0, retainedBytes: 4 * 1048576 };
  await until(() => document.querySelector(".capacity-status")?.textContent.includes("2 of 32 queued")
    && document.querySelector(".capacity-status")?.textContent.includes("4.0 of 64 MiB retained"),
  "capacity converges without an event after another client writes");
  const capacityText = () => document.querySelector(".capacity-status")?.textContent ?? "";
  const capacityAnnouncement = () => document.querySelector('[aria-labelledby="capacity-retention-heading"] [role="status"]')?.textContent ?? "";
  assert(document.querySelector(".capacity-status")?.tagName === "P",
    "polled measurements should be readable without a live status announcement on every value change");
  assert(capacityAnnouncement() === "Capacity is available for new work.", "initial capacity state was not announced");
  const liveStatus = document.querySelector('[aria-labelledby="capacity-retention-heading"] [role="status"]');
  const liveChanges = [];
  const liveObserver = new MutationObserver(() => { liveChanges.push(liveStatus.textContent); });
  liveObserver.observe(liveStatus, { childList: true, characterData: true, subtree: true });
  try {
  const unchangedReads = reads;
  await until(() => reads > unchangedReads, "unchanged capacity poll completed");
  await settle();
  assert(liveChanges.length === 0, "unchanged capacity poll mutated the live announcement");
  assert(document.querySelector('[aria-labelledby="capacity-retention-heading"] h3')?.textContent === "Capacity and retention",
    "capacity controls lost their named heading");
  const beforeTerminalLimit = liveChanges.length;
  otherClientCapacity = { ...otherClientCapacity, terminalProcesses: { active: 12, unknown: 0, limit: 12 } };
  signalChange();
  await until(() => capacityAnnouncement() === "Terminal capacity is full. Close a terminal before opening another.",
    "full terminal admission is announced instead of available capacity");
  await settle();
  assert(liveChanges.slice(beforeTerminalLimit).filter((value) => value === "Terminal capacity is full. Close a terminal before opening another.").length === 1,
    "one terminal limit transition must mutate the live region once");
  otherClientCapacity = { ...otherClientCapacity, terminalProcesses: { active: 0, unknown: 0, limit: 12 },
    utilityProcesses: { active: 8, limit: 8 } };
  signalChange();
  await until(() => capacityAnnouncement() === "Utility process capacity is full. Retry when a process finishes.",
    "full utility admission is announced instead of available capacity");
  otherClientCapacity = { ...otherClientCapacity, terminalProcesses: { active: 12, unknown: 0, limit: 12 },
    queued: 32, active: 2, availablePhysicalForNewWorkBytes: 32 * 1024 };
  signalChange();
  await until(() => ["Terminal capacity is full", "Utility process capacity is full", "Run queue is full",
    "Concurrent run slots are full", "Physical storage is full"].every((part) => capacityAnnouncement().includes(part))
    && !capacityAnnouncement().includes("Capacity is available"),
  "simultaneous process, queue and storage limits remain distinct in the live announcement");
  otherClientCapacity = { ...otherClientCapacity, terminalProcesses: { active: 0, unknown: 0, limit: 12 },
    utilityProcesses: { active: 0, limit: 8 }, queued: 2, active: 1, availablePhysicalForNewWorkBytes: 5 * 1048576 };
  signalChange();
  await until(() => capacityAnnouncement() === "Capacity is available for new work.",
    "combined limits clear without a stale warning");
  otherClientCapacity = { ...otherClientCapacity, utilityProcesses: { active: 0, limit: 8 }, queued: 32 };
  signalChange();
  await until(() => capacityAnnouncement() === "Run queue is full. Wait for capacity or stop queued work.",
    "full run queue is announced");
  otherClientCapacity = { ...otherClientCapacity, queued: 2, active: 2 };
  signalChange();
  await until(() => capacityAnnouncement() === "Concurrent run slots are full. New runs will queue.",
    "full active run slots are announced without claiming queue admission is closed");
  otherClientCapacity = { ...otherClientCapacity, active: 1, recoverable: 1 };
  signalChange();
  await until(() => capacityAnnouncement() === "Runs are awaiting recovery.", "run recovery is announced");
  await settle();
  const changesBeforeCountPoll = liveChanges.length;
  const eventReads = reads;
  otherClientCapacity = { ...otherClientCapacity, recoverable: 2 };
  await until(() => reads > eventReads && capacityText().includes("2 awaiting recovery"),
    "the next capacity poll returned the changed recovery count");
  assert(capacityAnnouncement() === "Runs are awaiting recovery.", "recovery count polling changed the spoken category");
  await settle();
  assert(liveChanges.length === changesBeforeCountPoll,
    "a changed recovery count repeated the unchanged live category");
  otherClientCapacity = { ...otherClientCapacity, recoverable: 0, pendingRunOutcomes: 7 };
  signalChange();
  await until(() => capacityAnnouncement().includes("Run starts are paused until an active run or pending outcome releases recovery capacity."),
    "full pending-outcome reservation pauses run starts in the live announcement");
  otherClientCapacity = { ...otherClientCapacity, pendingRunOutcomes: 0 };
  signalChange();
  await until(() => capacityAnnouncement() === "Capacity is available for new work.", "pending-outcome capacity clearance is announced");
  otherClientCapacity = { ...otherClientCapacity, recoverable: 0, cleanupPending: true };
  signalChange();
  await until(() => capacityAnnouncement() === "Archived cleanup is pending.", "pending cleanup is announced");
  otherClientCapacity = { ...otherClientCapacity, cleanupPending: false };
  signalChange();
  await until(() => capacityAnnouncement() === "Capacity is available for new work.",
    "status returns to available after process, queue, recovery and cleanup capacity clears");
  otherClientCapacity = { ...otherClientCapacity, terminalProcesses: { active: 1, unknown: 1, limit: 12 } };
  signalChange();
  await until(() => capacityAnnouncement() === "Terminal ownership is unverified. New terminals may be paused.",
    "unverified terminal ownership is announced");
  otherClientCapacity = { ...otherClientCapacity, terminalProcesses: { active: 0, unknown: 0, limit: 12 } };
  signalChange();
  await until(() => capacityAnnouncement() === "Capacity is available for new work.", "terminal recovery returns status to available");
  const unprovenOwner = { id: "00000000-0000-4000-8000-000000000001", reason: "job-absent-without-marker", releasable: false };
  otherClientCapacity = { ...otherClientCapacity, utilityProcesses: { active: 1, unknown: 1, limit: 8 },
    utilityOwners: [{ ...unprovenOwner, clearsAfterRestart: true }] };
  signalChange();
  await until(() => capacityAnnouncement() === "Utility process ownership is unverified (job-absent-without-marker). Its capacity stays reserved until its processes are proven gone or the computer restarts.",
    "an unproven utility owner names its reason and the restart that clears it");
  otherClientCapacity = { ...otherClientCapacity, utilityOwners: [{ ...unprovenOwner, clearsAfterRestart: false }] };
  signalChange();
  await until(() => capacityAnnouncement() === "Utility process ownership is unverified (job-absent-without-marker). Its capacity stays reserved until its processes are proven gone.",
    "a restart is not promised for an owner without a recorded boot");
  otherClientCapacity = { ...otherClientCapacity, utilityProcesses: { active: 0, limit: 8 }, utilityOwners: [] };
  signalChange();
  await until(() => capacityAnnouncement() === "Capacity is available for new work.", "utility recovery returns status to available");
  otherClientCapacity = { ...otherClientCapacity, utilityProcesses: null, terminalProcesses: null };
  signalChange();
  await until(() => capacityAnnouncement() === "Terminal capacity is unknown. Utility process capacity is unknown.",
    "missing process measurements cannot announce available capacity");
  otherClientCapacity = { ...otherClientCapacity, utilityProcesses: { active: 0, limit: 8 },
    terminalProcesses: { active: 0, unknown: 0, limit: 12 }, diskUsageStatus: "estimated" };
  signalChange();
  await until(() => capacityAnnouncement() === "Capacity is available for new work. Physical storage use is estimated.",
    "Windows disk estimates remain distinct from an unknown storage measurement");
  otherClientCapacity = { ...otherClientCapacity, diskUsageStatus: "measured" };
  signalChange();
  await until(() => capacityAnnouncement() === "Capacity is available for new work.", "measured storage restores the available announcement");
  otherClientCapacity = { ...otherClientCapacity, diskUsageStatus: "invalid" };
  signalChange();
  await until(() => capacityAnnouncement() === "Physical storage use is unknown. New work is paused.",
    "an unrecognized disk measurement cannot announce available capacity with stale byte values");
  otherClientCapacity = { ...otherClientCapacity, diskUsageStatus: "measured" };
  signalChange();
  await until(() => capacityAnnouncement() === "Capacity is available for new work.", "storage measurement recovery is announced");
  otherClientCapacity = { ...otherClientCapacity, availablePhysicalForNewWorkBytes: 32 * 1024 };
  await until(() => capacityText().includes("New work is paused at the physical storage threshold"),
    "32 KiB physical headroom announces the same pause as run admission");
  assert(capacityAnnouncement() === "Physical storage is full. New work is paused.", "physical pause was not announced");
  otherClientCapacity = { ...otherClientCapacity, migrationStatus: "maintenance",
    diskUsageStatus: "partial", availablePhysicalForNewWorkBytes: 0 };
  await until(() => capacityText().includes("(partial)") && !capacityText().includes("physical storage threshold"),
    "maintenance pause is not mislabeled as a physical limit");
  assert(capacityAnnouncement() === "Archived storage cleanup is in progress. New work is paused.",
    "cleanup transition was not announced");
  otherClientCapacity = { ...otherClientCapacity, migrationStatus: "ready",
    diskUsageStatus: "measured", availablePhysicalForNewWorkBytes: 0 };
  await until(() => capacityText().includes("(measured)") && capacityText().includes("physical storage threshold"),
    "zero physical headroom keeps the pause warning");
  otherClientCapacity = { ...otherClientCapacity, diskAllocatedBytes: null, diskUsageStatus: "unknown" };
  await until(() => capacityText().includes("Allocated disk use is unknown"),
    "an unknown measurement does not present a numeric budget");
  assert(capacityAnnouncement() === "Physical storage use is unknown. New work is paused.",
    "unknown storage state was not announced");
  assert(!capacityText().includes(" MiB budget") && !capacityText().includes("physical storage threshold"),
    "unknown physical use cannot show a measured budget or threshold warning");
  [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Cancel").click();
  const readsAtClose = reads;
  await new Promise((resolve) => setTimeout(resolve, 2200));
  assert(reads === readsAtClose, "closed Settings kept polling capacity");
  } finally { liveObserver.disconnect(); }
}

// No run or account event arrives when a run ages out of a rolling window.
async function providerAccountsWindowAgingRegression() {
  root.render(null); await settle();
  const changesAt = Date.now() + 1200;
  let reads = 0;
  const period = (runs) => ({ period: "5h", label: "Last 5 hours", since: "", changesAt: runs ? new Date(changesAt).toISOString() : null,
    runs, inputTokens: runs ? 10 : null, outputTokens: runs ? 5 : null, runsWithoutTokens: 0, costUsd: null, runsWithoutCost: runs });
  route = async (url) => {
    if (url.pathname !== "/api/provider-accounts") return response({});
    reads += 1;
    const runs = Date.now() < changesAt ? 1 : 0;
    return response({ generatedAt: new Date().toISOString(), limitStaleAfterMs: 1_800_000, providers: [{ provider: "codex", label: "Codex", kind: "harness",
      homeVariable: "CODEX_HOME", switchable: true, usageLimits: false, activeAccountId: "codex:default",
      accounts: [{ id: "codex:default", label: "Default login", isDefault: true, homePath: null, active: true,
        login: { status: "signed-in", identity: null, error: null, checkedAt: null }, measured: [period(runs)], limits: null }] }] });
  };
  const onError = (error) => { throw error; };
  root.render(<TooltipProvider><ProviderAccounts open runtimeEvent={null} onError={onError} /></TooltipProvider>);
  const measured = () => [...host.querySelectorAll(".provider-accounts small")].find((line) => line.textContent.startsWith("Measured by Outright"))?.textContent ?? "";
  await until(() => measured().includes("1 run"), "the run in the 5-hour window is shown");
  await until(() => measured().endsWith("No runs"), "the run leaves the shown 5-hour total when it ages out");
  assert(reads === 2, `the listing is read once more at the window change, not ${reads} times`);
  await remainsTrue(() => reads === 2, 1500, "an unchanging listing is not polled");
}

// A reload that fails when a run leaves a rolling window must not leave the
// old total looking current; account changes reload through their own signal.
async function providerAccountsFailedReloadRegression() {
  root.render(null); await settle();
  const changesAt = Date.now() + 1200;
  let reads = 0;
  let failing = false;
  const errors = [];
  const period = (runs) => ({ period: "5h", label: "Last 5 hours", since: "", changesAt: runs ? new Date(changesAt).toISOString() : null,
    runs, inputTokens: runs ? 10 : null, outputTokens: runs ? 5 : null, runsWithoutTokens: 0, costUsd: null, runsWithoutCost: runs });
  route = async (url) => {
    if (url.pathname !== "/api/provider-accounts") return response({});
    reads += 1;
    if (Date.now() >= changesAt && failing) return response({ error: "Runtime unavailable" }, 503);
    const runs = Date.now() < changesAt ? 1 : 0;
    return response({ generatedAt: new Date().toISOString(), limitStaleAfterMs: 1_800_000, providers: [{ provider: "codex", label: "Codex", kind: "harness",
      homeVariable: "CODEX_HOME", switchable: true, usageLimits: false, activeAccountId: "codex:default",
      accounts: [{ id: "codex:default", label: "Default login", isDefault: true, homePath: null, active: true, sameAsDefault: false,
        login: { status: "signed-in", identity: null, error: null, checkedAt: null }, measured: [period(runs)], limits: null }] }] });
  };
  const onError = (error) => { errors.push(error); };
  const render = (accountsVersion) => root.render(<TooltipProvider><ProviderAccounts open runtimeEvent={null} accountsVersion={accountsVersion} onError={onError} /></TooltipProvider>);
  failing = true;
  render(0);
  const measured = () => [...host.querySelectorAll(".provider-accounts small")].find((line) => line.textContent.startsWith("Measured by Outright"))?.textContent ?? "";
  await until(() => measured().includes("1 run"), "the run in the 5-hour window is shown");
  await until(() => errors.length > 0, "the reload at the window change fails");
  await until(() => measured().includes("(out of date"), "the failed reload marks the expired total out of date");
  assert(measured().includes("as of "), "an out-of-date total names its snapshot time");
  // An account change is delivered without the shared runtime event.
  failing = false;
  const before = reads;
  render(1);
  await until(() => reads > before && measured().endsWith("No runs"), "an account change reloads the listing, which drops the expired run");
  assert(!measured().includes("out of date"), "a successful reload clears the out-of-date mark");
}

// An account added while its fields are edited again clears only what it sent.
async function providerAccountsAddKeepsNewerDraftRegression() {
  root.render(null); await settle();
  const post = deferred();
  let posted = null;
  const listing = (accounts) => ({ generatedAt: new Date().toISOString(), limitStaleAfterMs: 1_800_000, providers: [{ provider: "codex", label: "Codex", kind: "harness",
    homeVariable: "CODEX_HOME", switchable: true, usageLimits: false, activeAccountId: "codex:default",
    accounts: accounts.map((label) => ({ id: label === "Default login" ? "codex:default" : `codex:${label}`, label, isDefault: label === "Default login", homePath: label === "Default login" ? null : `/homes/${label}`,
      active: label === "Default login", sameAsDefault: false, login: { status: "signed-in", identity: null, error: null, checkedAt: null }, measured: [], limits: null })) }] });
  route = async (url, init) => {
    if (url.pathname !== "/api/provider-accounts") return response({});
    if (init?.method === "POST") { posted = JSON.parse(init.body); return post.promise; }
    return response(listing(["Default login"]));
  };
  const onError = (error) => { throw error; };
  root.render(<TooltipProvider><ProviderAccounts open runtimeEvent={null} onError={onError} /></TooltipProvider>);
  const field = (label) => host.querySelector(`[aria-label="${label}"]`);
  await until(() => field("Account name") && field("CODEX_HOME directory"), "the add form is shown");
  setControlValue(field("Account name"), "Work");
  setControlValue(field("CODEX_HOME directory"), "/homes/Work");
  [...host.querySelectorAll("button")].find((button) => button.textContent === "Add account").click();
  await until(() => posted, "the add request started");
  assert(posted.label === "Work" && posted.homePath === "/homes/Work", "the submitted draft is sent");
  // The next account is typed while the first is being added.
  setControlValue(field("Account name"), "Personal");
  setControlValue(field("CODEX_HOME directory"), "/homes/Personal");
  post.resolve(response(listing(["Default login", "Work"]), 201));
  await until(() => host.textContent.includes("Codex · Work"), "the added account is listed");
  await settle();
  assert(field("Account name").value === "Personal" && field("CODEX_HOME directory").value === "/homes/Personal", "the newer draft is kept");
  posted = null;
  const second = deferred();
  route = async (url, init) => {
    if (url.pathname !== "/api/provider-accounts") return response({});
    if (init?.method === "POST") { posted = JSON.parse(init.body); return second.promise; }
    return response(listing(["Default login", "Work"]));
  };
  [...host.querySelectorAll("button")].find((button) => button.textContent === "Add account").click();
  await until(() => posted?.label === "Personal", "the newer draft is added");
  second.resolve(response(listing(["Default login", "Work", "Personal"]), 201));
  await until(() => field("Account name").value === "" && field("CODEX_HOME directory").value === "", "an unchanged submitted draft is cleared");
}

// A switch's response computed before another client's switch must not
// replace the listing that switch produced, and must not drop a load that
// started after the switch.
async function providerAccountsResponseOrderRegression() {
  root.render(null); await settle();
  let sequence = 0;
  let active = "codex:default";
  const listing = () => ({ revision: { runtime: "runtime-1", sequence: ++sequence }, generatedAt: new Date().toISOString(), limitStaleAfterMs: 1_800_000,
    providers: [{ provider: "codex", label: "Codex", kind: "harness", homeVariable: "CODEX_HOME", switchable: true, usageLimits: false, activeAccountId: active,
      accounts: ["Default login", "Work", "Personal"].map((label) => {
        const id = label === "Default login" ? "codex:default" : `codex:${label}`;
        return { id, label, isDefault: id === "codex:default", homePath: id === "codex:default" ? null : `/homes/${label}`, active: id === active, sameAsDefault: false,
          login: { status: "signed-in", identity: null, error: null, checkedAt: null }, measured: [], limits: null };
      }) }] });
  let put = null;
  let held = null;
  route = async (url, init) => {
    if (url.pathname === "/api/provider-accounts/active" && init?.method === "PUT") {
      active = JSON.parse(init.body).accountId;
      const value = listing();
      put = deferred();
      return put.promise.then(() => response(value));
    }
    if (url.pathname !== "/api/provider-accounts") return response({});
    const value = listing();
    if (held) return held.promise.then(() => response(value));
    return response(value);
  };
  const onError = (error) => { throw error; };
  const render = (accountsVersion) => root.render(<TooltipProvider><ProviderAccounts open runtimeEvent={null} accountsVersion={accountsVersion} onError={onError} /></TooltipProvider>);
  render(0);
  const activeLabel = () => [...host.querySelectorAll(".provider-accounts strong")].find((line) => line.textContent.endsWith("(active)"))?.textContent ?? "";
  const use = (label) => [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === `Use ${label} for new Codex sessions`);
  await until(() => activeLabel() === "Codex · Default login (active)" && use("Work"), "the default login is active");
  use("Work").click();
  await until(() => put, "the switch to Work was sent");
  // Another client switches to Personal; its change reloads this listing.
  active = "codex:Personal";
  render(1);
  await until(() => activeLabel() === "Codex · Personal (active)", "the other client's switch is shown");
  put.resolve();
  // Its announcement does not claim an account the shown listing contradicts.
  await until(() => host.querySelector('[role="status"]')?.textContent === "Switched to Work, but a later change made Personal active for new Codex sessions.",
    `the delayed switch response is announced against the shown listing: ${host.querySelector('[role="status"]')?.textContent}`);
  await settle();
  assert(activeLabel() === "Codex · Personal (active)", `a response computed before the newer listing replaced it: ${activeLabel()}`);

  // A load that starts while a switch is pending and answers after it is kept.
  put = null;
  use("Work").click();
  await until(() => put, "the second switch was sent");
  held = deferred();
  active = "codex:default";
  render(2);
  await settle();
  put.resolve();
  await until(() => host.querySelector('[role="status"]')?.textContent === "Codex now starts new sessions with Work.", "the second switch response arrived");
  held.resolve();
  held = null;
  await until(() => activeLabel() === "Codex · Default login (active)", "the load computed after the switch is shown");
}

// A switch hands focus to the account's Check only if focus is still on its
// Use button; focus moved elsewhere while it was pending stays there.
async function providerAccountsSwitchFocusRegression() {
  root.render(null); await settle();
  let active = "codex:default";
  const listing = () => ({ generatedAt: new Date().toISOString(), limitStaleAfterMs: 1_800_000,
    providers: [{ provider: "codex", label: "Codex", kind: "harness", homeVariable: "CODEX_HOME", switchable: true, usageLimits: false, activeAccountId: active,
      accounts: ["Default login", "Work"].map((label) => {
        const id = label === "Default login" ? "codex:default" : `codex:${label}`;
        return { id, label, isDefault: id === "codex:default", homePath: id === "codex:default" ? null : `/homes/${label}`, active: id === active, sameAsDefault: false,
          login: { status: "signed-in", identity: null, error: null, checkedAt: null }, measured: [], limits: null };
      }) }] });
  let put = null;
  route = async (url, init) => {
    if (url.pathname === "/api/provider-accounts/active" && init?.method === "PUT") {
      active = JSON.parse(init.body).accountId;
      const value = listing();
      put = deferred();
      return put.promise.then(() => response(value));
    }
    if (url.pathname !== "/api/provider-accounts") return response({});
    return response(listing());
  };
  const onError = (error) => { throw error; };
  root.render(<TooltipProvider><ProviderAccounts open runtimeEvent={null} onError={onError} /></TooltipProvider>);
  const button = (label) => [...host.querySelectorAll("button")].find((entry) => entry.getAttribute("aria-label") === label);
  const status = () => host.querySelector('[role="status"]')?.textContent;
  await until(() => button("Use Work for new Codex sessions"), "the default login is active");
  button("Use Work for new Codex sessions").focus();
  button("Use Work for new Codex sessions").click();
  await until(() => put, "the switch to Work was sent");
  // The next account's name is typed while the switch is pending.
  const name = host.querySelector('[aria-label="Account name"]');
  name.focus();
  put.resolve();
  await until(() => status() === "Codex now starts new sessions with Work.", "the switch response arrived");
  await settle();
  assert(document.activeElement === name, `focus was taken from the account name to ${document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName}`);

  // Focus left on Use follows the switched account to its Check.
  put = null;
  button("Use Default login for new Codex sessions").focus();
  button("Use Default login for new Codex sessions").click();
  await until(() => put, "the switch back was sent");
  put.resolve();
  await until(() => status() === "Codex now starts new sessions with Default login.", "the switch back arrived");
  await settle();
  assert(document.activeElement === button("Check Codex account Default login"), "focus on Use continues on the switched account's Check");
}

async function settingsCapacityAndDeletionOrderRegression() {
  root.render(null);
  await settle();
  const settings = { provider: "codex", model: "", approvalPolicy: "read-only", reasoningEffort: "medium",
    editor: "code", notifications: false, maxConcurrentRuns: 2, maxQueuedRuns: 32, maxRetainedMiB: 64, retentionDays: 90 };
  const entries = ["first", "second"].map((id) => ({ id, title: id, worktreePath: "/worktree", updatedAt: "2026-09-01T00:00:00.000Z" }));
  const initial = deferred();
  const changed = deferred();
  const deletion = deferred();
  const reportError = (error) => { throw error; };
  let reads = 0;
  let deleting = false;
  let signalChange;
  route = async (url) => {
    if (url.pathname === "/api/capacity") return (++reads === 1 ? initial.promise : changed.promise).then((value) => response(value));
    if (url.pathname === "/api/retention/archived") return response({ conversations: entries });
    if (url.pathname === "/api/retention/delete-archived") { deleting = true; return deletion.promise; }
    return response({});
  };
  function Fixture() {
    const [open, setOpen] = React.useState(false);
    const [event, setEvent] = React.useState(null);
    signalChange = () => setEvent({ type: "capacity.changed", stamp: Date.now() });
    return <><button onClick={() => setOpen(true)}>Open ordered settings</button><SettingsDialog open={open}
      onOpenChange={setOpen} settings={settings} providers={[{ id: "codex", label: "Codex", available: true }]}
      templates={[]} runtimeEvent={event} onSaved={() => {}} onError={reportError} /></>;
  }
  root.render(<TooltipProvider><Fixture /></TooltipProvider>);
  await until(() => host.querySelector("button")?.textContent === "Open ordered settings", "ordered settings mounted");
  host.querySelector("button").click();
  await until(() => reads === 1 && document.querySelectorAll(".archived-history-list button").length === 2, "initial settings reads");
  signalChange();
  await until(() => reads >= 2, "capacity event requested authoritative data");
  const capacity = (retainedBytes) => ({ queued: 0, active: 0, recoverable: 0,
    retainedBytes, migrationStatus: "ready", availableForNewWorkBytes: 64 * 1048576 - retainedBytes,
    diskAllocatedBytes: 3 * 1048576, diskUsageStatus: "measured", availablePhysicalForNewWorkBytes: 5 * 1048576,
    limits: { maxQueuedRuns: 32, maxRetainedBytes: 64 * 1048576, reservedRetainedBytes: 1048576,
      maxPhysicalBytes: 10 * 1048576 } });
  changed.resolve(capacity(2 * 1048576));
  await until(() => document.querySelector(".capacity-status")?.textContent.includes("2.0 of 64 MiB"), "new capacity committed");
  assert(document.querySelector(".capacity-status")?.textContent.includes("Allocated disk: 3.0 MiB of 10 MiB budget (measured)"),
    "Settings hid the measured physical budget");
  initial.resolve(capacity(60 * 1048576));
  await settle();
  assert(document.querySelector(".capacity-status")?.textContent.includes("2.0 of 64 MiB"), "stale capacity replaced event refresh");
  document.querySelector('.archived-history-list button[aria-label*="(first)"]').click();
  await until(() => document.querySelector(".archive-delete-confirm")?.textContent.includes("first"), "first archive selected");
  document.querySelectorAll(".archive-delete-confirm button")[1].click();
  await until(() => deleting, "first deletion in flight");
  const second = document.querySelector('.archived-history-list button[aria-label*="(second)"]');
  assert(second.disabled, "second archive action stayed enabled during deletion");
  second.click();
  assert(document.querySelector(".archive-delete-confirm")?.textContent.includes("first"), "second click changed pending confirmation");
  deletion.resolve(response({ deleted: 1, capacity: { retainedBytes: 1048576 } }));
  await until(() => !document.querySelector(".archive-delete-confirm"), "first deletion completed");
  const queuedInput = [...document.querySelectorAll('[role="dialog"] label')].find((label) => label.textContent.includes("Queued runs"))?.querySelector("input");
  setControlValue(queuedInput, "2.5");
  await until(() => [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Save settings")?.disabled,
    "fractional quota disables save");
  assert(queuedInput.getAttribute("aria-invalid") === "true", "fractional quota did not mark its input invalid");
  const error = document.getElementById(queuedInput.getAttribute("aria-describedby"));
  assert(error?.textContent.includes("whole numbers") && error.getAttribute("role") === "status" && error.getAttribute("aria-live") === "polite",
    "invalid quota lacks a live error announcement");
  setControlValue(queuedInput, "32");
  await until(() => !queuedInput.hasAttribute("aria-invalid") && !queuedInput.hasAttribute("aria-describedby"),
    "corrected quota clears input error semantics");
}

async function settingsTemplateCompletionRegression() {
  root.render(null);
  await settle();
  const settings = { provider: "codex", model: "", approvalPolicy: "read-only", reasoningEffort: "medium",
    editor: "code", notifications: false, maxConcurrentRuns: 2, maxQueuedRuns: 32, maxRetainedMiB: 64, retentionDays: 90 };
  const post = deferred();
  let posted = false;
  route = async (url) => {
    if (url.pathname === "/api/capacity") return response({});
    if (url.pathname === "/api/retention/archived") return response({ conversations: [] });
    if (url.pathname === "/api/templates") { posted = true; return post.promise; }
    return response({});
  };
  function Fixture() {
    const [open, setOpen] = React.useState(false);
    return <><button onClick={() => setOpen(true)}>Open template settings</button><SettingsDialog open={open}
      onOpenChange={setOpen} settings={settings} providers={[{ id: "codex", label: "Codex", available: true }]}
      templates={[]} onSaved={() => {}} onError={(error) => { throw error; }} /></>;
  }
  root.render(<TooltipProvider><Fixture /></TooltipProvider>);
  await until(() => host.querySelector("button")?.textContent === "Open template settings", "template settings mounted");
  host.querySelector("button").click();
  await until(() => document.querySelector('[aria-label="Template name"]'), "template editor visible");
  setControlValue(document.querySelector('[aria-label="Template name"]'), "Review");
  setControlValue(document.querySelector('[aria-label="Template prompt"]'), "Review the current diff");
  [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Add template").click();
  await until(() => posted, "template POST started");
  [...document.querySelectorAll('[role="dialog"] button')].findLast((button) => button.textContent === "Cancel").click();
  await until(() => !document.querySelector('[role="dialog"]'), "template dialog closed during POST");
  host.querySelector("button").click();
  await until(() => document.querySelector('[aria-label="Template name"]')?.value === "Review", "submitted draft visible after reopen");
  post.resolve(response({ id: "created" }));
  await until(() => document.querySelector('[aria-label="Template name"]')?.value === "", "successful submitted draft cleared");
}

async function rejectedNotificationPermissionRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const settings = { provider: "codex", model: "", approvalPolicy: "read-only", reasoningEffort: "medium",
    editor: "code", notifications: false, maxConcurrentRuns: 2, maxQueuedRuns: 32, maxRetainedMiB: 64, retentionDays: 90 };
  let requested = 0;
  let unhandled = 0;
  const originalNotification = Object.getOwnPropertyDescriptor(window, "Notification");
  const onUnhandled = () => { unhandled += 1; };
  Object.defineProperty(window, "Notification", { configurable: true, value: class {
    static permission = "default";
    static requestPermission() { requested += 1; return Promise.reject(new Error("permission refused")); }
  } });
  window.addEventListener("unhandledrejection", onUnhandled);
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings,
      providers: [{ id: "codex", label: "Codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    if (url.pathname === "/api/capacity") return response({});
    if (url.pathname === "/api/retention/archived") return response({ conversations: [] });
    if (url.pathname === "/api/settings" && options.method === "PATCH") return response({ ...settings, ...JSON.parse(options.body) });
    return response({});
  };
  try {
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelector('[aria-label="Agent provider and model settings"]'), "notification settings control");
    host.querySelector('[aria-label="Agent provider and model settings"]').click();
    await until(() => document.querySelector('[aria-label="Notify when runs finish"]'), "notification setting");
    document.querySelector('[aria-label="Notify when runs finish"]').click();
    [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.includes("Save settings")).click();
    await until(() => !document.querySelector('[role="dialog"]'), "settings saved after permission denial");
    await settle();
    assert(requested === 1 && unhandled === 0, "permission rejection escaped Settings save");
  } finally {
    window.removeEventListener("unhandledrejection", onUnhandled);
    if (originalNotification) Object.defineProperty(window, "Notification", originalNotification);
    else delete window.Notification;
  }
}

async function archivedSettingsPagingFocusRegression() {
  root.render(null);
  await settle();
  const settings = { provider: "codex", model: "", approvalPolicy: "read-only", reasoningEffort: "medium",
    editor: "code", notifications: false, maxConcurrentRuns: 2, maxQueuedRuns: 32, maxRetainedMiB: 64, retentionDays: 90 };
  const entries = Array.from({ length: 101 }, (_, index) => ({ id: `archive-${index}`, title: index === 1 ? "Archived 0" : `Archived ${index}`,
    worktreePath: "/worktree", updatedAt: new Date(Date.now() - index * 1000).toISOString() }));
  let deleted = false;
  route = async (url, options) => {
    if (url.pathname === "/api/capacity") return response({});
    if (url.pathname === "/api/retention/archived") {
      if (url.searchParams.get("cursor") === "older") return response({ conversations: deleted ? [] : entries.slice(100), nextCursor: null });
      return response({ conversations: entries.slice(0, 100), nextCursor: "older" });
    }
    if (url.pathname === "/api/retention/delete-archived") {
      const body = JSON.parse(options.body);
      assert(body.id === entries[100].id && body.confirmation === body.id, "The oldest selected archive was not confirmed");
      deleted = true;
      return response({ deleted: 1, capacity: {} });
    }
    return response({});
  };
  function Fixture() {
    const [open, setOpen] = React.useState(false);
    return <><button onClick={() => setOpen(true)}>Open archive fixture</button><SettingsDialog open={open}
      onOpenChange={setOpen} settings={settings} providers={[{ id: "codex", label: "Codex", available: true }]}
      templates={[]} onSaved={() => {}} onError={(error) => { throw error; }} /></>;
  }
  root.render(<TooltipProvider><Fixture /></TooltipProvider>);
  await until(() => host.querySelector("button"), "archive fixture mounted");
  host.querySelector("button").click();
  await until(() => document.querySelectorAll(".archived-history-list button").length === 100, "first archived page");
  const archiveActions = [...document.querySelectorAll(".archived-history-list button")];
  const actionNames = archiveActions.map((button) => button.getAttribute("aria-label"));
  assert(new Set(actionNames).size === 100, "Each archived delete action needs a distinct accessible name");
  assert(actionNames[0]?.includes(entries[0].title) && actionNames[0]?.includes(entries[0].id),
    "An archived delete action must identify its chat even when titles repeat");
  const load = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Next archived page");
  assert(load, "Older archived history has no keyboard-reachable page action");
  load.focus();
  assert(document.activeElement === load, "Archived page action cannot receive keyboard focus");
  load.click();
  await until(() => document.querySelectorAll(".archived-history-list button").length === 1, "oldest archived row loaded in a bounded page");
  const oldestTrigger = [...document.querySelectorAll(".archived-history-list button")].at(-1);
  assert(oldestTrigger.getAttribute("aria-label")?.includes(entries[100].title), "The older page action must identify its chat");
  await until(() => document.activeElement === oldestTrigger, "focus moved into the new archived page");
  oldestTrigger.click();
  await until(() => document.querySelector(".archive-delete-confirm button"), "archive confirmation");
  const cancel = document.querySelector(".archive-delete-confirm button");
  await until(() => document.activeElement === cancel, "confirmation focus");
  cancel.click();
  await until(() => !document.querySelector(".archive-delete-confirm"), "archive confirmation cancelled");
  assert(document.activeElement === oldestTrigger, "Cancel did not restore focus to the originating delete action");
  oldestTrigger.click();
  await until(() => document.querySelectorAll(".archive-delete-confirm button").length === 2, "archive confirmation reopened");
  document.querySelectorAll(".archive-delete-confirm button")[1].click();
  await until(() => deleted && !document.querySelector(".archive-delete-confirm"), "oldest archive deleted");
  const cleanup = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Clean old archived history");
  await until(() => document.activeElement === cleanup, "focus restored after deleting the originating row");
  assert(document.querySelector('[role="dialog"]'), "Settings closed after deletion");
}

async function archivedSettingsSessionFenceRegression() {
  root.render(null);
  await settle();
  const settings = { provider: "codex", model: "", approvalPolicy: "read-only", reasoningEffort: "medium",
    editor: "code", notifications: false, maxConcurrentRuns: 2, maxQueuedRuns: 32, maxRetainedMiB: 64, retentionDays: 90 };
  const entries = ["Old", "Current"].map((title) => ({ id: title.toLowerCase(), title,
    worktreePath: "/worktree", updatedAt: "2026-09-01T00:00:00.000Z" }));
  const cleanup = deferred();
  const deletion = deferred();
  const reportError = (error) => { throw error; };
  let cleanupStarted = false;
  let deletionStarted = false;
  let historyRefreshes = 0;
  route = async (url) => {
    if (url.pathname === "/api/capacity") return response({});
    if (url.pathname === "/api/retention/archived") return response({ conversations: entries, nextCursor: null });
    if (url.pathname === "/api/retention/cleanup") { cleanupStarted = true; return cleanup.promise; }
    if (url.pathname === "/api/retention/delete-archived") { deletionStarted = true; return deletion.promise; }
    return response({});
  };
  function Fixture() {
    const [open, setOpen] = React.useState(false);
    return <><button onClick={() => setOpen(true)}>Open archive session fixture</button><SettingsDialog open={open}
      onOpenChange={setOpen} settings={settings} providers={[{ id: "codex", label: "Codex", available: true }]}
      templates={[]} onSaved={(_, reason) => { if (reason === "history") historyRefreshes += 1; }}
      onError={reportError} /></>;
  }
  root.render(<TooltipProvider><Fixture /></TooltipProvider>);
  const open = () => host.querySelector("button").click();
  const close = () => [...document.querySelectorAll('[role="dialog"] button')].findLast((button) => button.textContent.trim() === "Cancel").click();
  const choose = (id) => document.querySelector(`.archived-history-list button[aria-label*="(${id})"]`).click();
  await until(() => host.querySelector("button")?.textContent === "Open archive session fixture", "archive session fixture mounted");
  open();
  await until(() => document.querySelectorAll(".archived-history-list button").length === 2, "archive session first page");
  [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Clean old archived history").click();
  await until(() => cleanupStarted, "held cleanup started");
  close();
  await until(() => !document.querySelector('[role="dialog"]'), "closed during cleanup");
  open();
  await until(() => document.querySelectorAll(".archived-history-list button").length === 2, "reopened during cleanup");
  choose("current");
  await until(() => document.querySelector(".archive-delete-confirm")?.textContent.includes("Current"), "new selection during cleanup");
  cleanup.resolve(response({ deleted: 1, capacity: { retainedBytes: 1 } }));
  await until(() => historyRefreshes === 1, "stale cleanup refreshed app history");
  assert(document.querySelector(".archive-delete-confirm")?.textContent.includes("Current"), "stale cleanup replaced the new selection");
  assert(!document.querySelector(".capacity-status")?.textContent.includes("Deleted"), "stale cleanup changed the new status");

  close();
  await until(() => !document.querySelector('[role="dialog"]'), "closed before deletion");
  open();
  await until(() => document.querySelectorAll(".archived-history-list button").length === 2, "reopened for deletion");
  choose("old");
  await until(() => document.querySelector(".archive-delete-confirm")?.textContent.includes("Old"), "old selection confirmed");
  document.querySelectorAll(".archive-delete-confirm button")[1].click();
  await until(() => deletionStarted, "held deletion started");
  close();
  await until(() => !document.querySelector('[role="dialog"]'), "closed during deletion");
  open();
  await until(() => document.querySelectorAll(".archived-history-list button").length === 2, "reopened during deletion");
  choose("current");
  await until(() => document.querySelector(".archive-delete-confirm")?.textContent.includes("Current"), "new selection during deletion");
  const focused = document.activeElement;
  deletion.resolve(response({ deleted: 1, capacity: { retainedBytes: 2 } }));
  await until(() => historyRefreshes === 2, "stale deletion refreshed app history");
  assert(document.querySelector(".archive-delete-confirm")?.textContent.includes("Current"), "stale deletion cleared the new selection");
  assert(document.activeElement === focused, "stale deletion moved focus in the reopened Settings dialog");
  assert(!document.querySelector(".capacity-status")?.textContent.includes("Deleted"), "stale deletion changed the new status");
}

async function archivedChatOwnershipRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const sibling = { ...chats.A, id: "chat-A2", title: "Conversation A2" };
  const oldChat = { ...chats.A, messages: [{ id: "old-archived-message", role: "user", kind: "text", body: "Archived content must disappear", createdAt: "2026-09-24T00:00:00Z" }] };
  const heldList = deferred();
  const heldDetail = deferred();
  let archived = false;
  let retryList = false;
  let retryDetail = false;
  let postCount = 0;
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return archived ? retryList ? response({ conversations: [sibling] }) : heldList.promise : response({ conversations: [chats.A, sibling] });
    if (url.pathname === "/api/conversations/chat-A" && options.method === "PATCH") { archived = true; return response({ ...chats.A, archived: true }); }
    if (url.pathname === "/api/conversations/chat-A") return response(oldChat);
    if (url.pathname === "/api/conversations/chat-A2") return retryDetail ? response(sibling) : heldDetail.promise;
    if (url.pathname.endsWith("/runs")) { postCount += 1; return response({ id: "run-A", status: "running" }, 202); }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('#chat-tab-chat-A[aria-selected="true"]') && host.querySelector('.message-text')?.textContent === "Archived content must disappear", "loaded chat before archive");
  host.querySelector('.conversation-meta button').click();
  await until(() => document.querySelector('[role="dialog"]')?.textContent.includes("Conversation settings"), "settings before held archive");
  [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.includes("Archive conversation")).click();
  await until(() => archived, "archive PATCH completed while list is held");
  await settle();
  assert(host.querySelector('.conversation-header h1')?.textContent !== chats.A.title, "Archived chat remained the visible, executable pane during held refresh");
  assert(!host.querySelector('.message-text')?.textContent.includes('Archived content'), "Archived chat message remained under sibling tab");
  assert(host.querySelector('[aria-label="Send message"]')?.disabled, "Send remained available while sibling detail was pending");
  const composer = host.querySelector('textarea[aria-label="Message the agent"]');
  setControlValue(composer, "Should never run on archived chat");
  await settle();
  host.querySelector('[aria-label="Send message"]')?.click();
  await settle();
  assert(postCount === 0, "Archived chat accepted a run while refresh was held");
  heldList.resolve(response({ error: "List unavailable" }, 500));
  await until(() => host.querySelector('[role="alert"]')?.textContent.includes("List unavailable"), "failed archive refresh");
  assert(!host.querySelector('#chat-tab-chat-A'), "Archived chat remained a tab after failed refresh");
  const listRetry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry chat list');
  assert(listRetry, "Failed list has no keyboard-reachable retry action");
  listRetry.focus();
  assert(document.activeElement === listRetry, "Failed list retry cannot receive keyboard focus");
  retryList = true;
  listRetry.click();
  await until(() => ![...host.querySelectorAll('button')].some((button) => button.textContent === 'Retry chat list'), "list recovery");
  heldDetail.resolve(response({ error: "Detail unavailable" }, 500));
  await until(() => [...host.querySelectorAll('button')].some((button) => button.textContent === 'Retry loading chat'), "failed sibling detail");
  assert(host.querySelector('.conversation-header h1')?.textContent !== chats.A.title, "Failed sibling detail restored archived content");
  retryDetail = true;
  [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry loading chat').click();
  await until(() => host.querySelector('.conversation-header h1')?.textContent === sibling.title, "sibling loads after detail retry");
  assert(postCount === 0, "Archived chat was submitted during list or detail recovery");
}

async function sameOwnerArchiveRefreshRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const sibling = { ...chats.A, id: "chat-A2", title: "Conversation A2" };
  const fresh = { ...chats.A, id: "chat-A3", title: "Conversation A3" };
  const patch = deferred();
  let list = [chats.A, sibling];
  let refreshFails = false;
  let patchStarted = false;
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return refreshFails ? response({ error: "Refresh failed" }, 503) : response({ conversations: list });
    if (url.pathname === "/api/conversations/chat-A" && options.method === "PATCH") { patchStarted = true; return patch.promise; }
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    if (url.pathname === "/api/conversations/chat-A3") return response(fresh);
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('#chat-tab-chat-A[aria-selected="true"]') && host.querySelector('#chat-tab-chat-A2'), "initial same-owner tabs");
  host.querySelector('[aria-label="Archive Conversation A"]').click();
  await until(() => patchStarted, "held same-owner archive");
  // A current-owner runtime refresh replaces B with C while the old archive
  // handler still captures [A, B]. The next GET fails, so its local update
  // must not resurrect B or drop C.
  list = [chats.A, fresh];
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.created", conversationId: fresh.id }) }));
  await until(() => host.querySelector('#chat-tab-chat-A3[aria-selected="true"]') && !host.querySelector('#chat-tab-chat-A2'), "new authoritative same-owner list");
  refreshFails = true;
  patch.resolve(response({ ...chats.A, archived: true }));
  await until(() => host.querySelector('.history-loader')?.textContent === "Retry chat list", "failed archive follow-up refresh");
  assert(!host.querySelector('#chat-tab-chat-A'), "Archived tab remained after failed refresh");
  assert(!host.querySelector('#chat-tab-chat-A2'), "Archived PATCH resurrected removed sibling B");
  const selected = host.querySelector('#chat-tab-chat-A3');
  assert(selected?.getAttribute("aria-selected") === "true" && selected.tabIndex === 0, "Archived PATCH dropped current sibling C or its roving selection");
  assert(host.querySelector('#conversation-panel')?.getAttribute('aria-labelledby') === selected.id, "Panel lost the current sibling owner");
}

async function chatDetailRefreshOwnershipRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const oldDetail = { ...chats.A, provider: "codex" };
  const freshDetail = { ...chats.A, provider: "claude" };
  const heldRefresh = deferred();
  const heldRetry = deferred();
  const heldTrustRefresh = deferred();
  let detailRequests = 0;
  const runs = [];
  let trustRequests = 0;
  let requireTrust = true;
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") {
      detailRequests += 1;
      if (detailRequests === 1) return response(oldDetail);
      if (detailRequests === 2) return heldRefresh.promise;
      if (detailRequests === 3) return heldRetry.promise;
      if (detailRequests === 4) return heldTrustRefresh.promise;
      return response(freshDetail);
    }
    if (url.pathname === "/api/conversations/chat-A/runs") {
      runs.push(JSON.parse(options.body));
      return requireTrust ? response({ error: "Trust required", code: "PROJECT_TRUST_REQUIRED", project: projects[0] }, 403) : response({ id: `run-${runs.length}`, status: "queued" }, 202);
    }
    if (url.pathname === "/api/trust") { trustRequests += 1; return response({}); }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('textarea[placeholder*="Ask codex"]'), "loaded old detail");
  const composer = host.querySelector('textarea[aria-label="Message the agent"]');
  setControlValue(composer, "Must use current detail");
  const refresh = () => fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "runtime.connected", payload: { restarted: true } }) }));
  refresh();
  await until(() => detailRequests === 2, "held same-chat detail refresh");
  assert(host.querySelector('#chat-tab-chat-A[aria-selected="true"]'), "Refresh lost the selected chat tab");
  heldRefresh.resolve(response({ error: "Detail offline" }, 503));
  await until(() => [...host.querySelectorAll('button')].some((button) => button.textContent === "Retry loading chat"), "failed same-chat refresh");
  assert(host.querySelector('#conversation-panel')?.getAttribute('aria-labelledby') === "chat-tab-chat-A", "Failure lost selected panel ownership");
  assert(host.querySelector('[aria-label="Send message"]')?.disabled, "Failed detail refresh left send available");
  composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  host.querySelector('[aria-label="Send message"]')?.click();
  host.querySelector('.composer').requestSubmit(); // A direct form submit must obey the same guard.
  await settle();
  assert(runs.length === 0, "Failed same-chat detail submitted a stale run via Enter or button");
  [...host.querySelectorAll('button')].find((button) => button.textContent === "Retry loading chat").click();
  await until(() => detailRequests === 3, "held detail retry");
  assert(host.querySelector('[aria-label="Send message"]')?.disabled, "Pending detail retry re-enabled send");
  host.querySelector('.composer').requestSubmit();
  await settle();
  assert(runs.length === 0, "Pending detail retry submitted a stale run");
  heldRetry.resolve(response(freshDetail));
  await until(() => host.querySelector('textarea[placeholder*="Ask claude"]'), "fresh detail after retry");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => document.querySelector('[role="dialog"]')?.textContent.includes("Trust this project?"), "pending trust continuation");
  assert(runs.length === 1 && runs[0].provider === "claude", "First submission did not use fresh detail");
  refresh();
  await until(() => detailRequests === 4, "held trust continuation refresh");
  await until(() => [...document.querySelectorAll('[role="dialog"] button')].some((button) => button.textContent === "Trust and run" && button.disabled), "trust continuation disabled during refresh");
  heldTrustRefresh.resolve(response({ error: "Detail offline again" }, 503));
  await until(() => [...host.querySelectorAll('button')].some((button) => button.textContent === "Retry loading chat"), "failed trust continuation refresh");
  const trustButton = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Trust and run");
  assert(trustButton.disabled, "Trust continuation remained enabled after failed detail refresh");
  trustButton.click();
  await settle();
  assert(runs.length === 1, "Trust continuation submitted another run from stale detail");
  assert(trustRequests === 0, "Trust continuation changed trust while detail was unavailable");
  document.querySelector('[role="dialog"] button')?.click();
  requireTrust = false;
  [...host.querySelectorAll('button')].find((button) => button.textContent === "Retry loading chat").click();
  await until(() => host.querySelector('textarea[placeholder*="Ask claude"]') && !host.querySelector('[aria-label="Send message"]')?.disabled, "successful detail retry after trust failure");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => runs.length === 2, "submission after fresh detail");
  assert(runs[1].provider === "claude", "Final submission used stale provider");
}

async function chatFailedWorktreeListRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  let failB = true;
  const oldChat = { ...chats.A, messages: [{ id: "old-worktree-message", role: "user", kind: "text", body: "Previous worktree message", createdAt: "2026-09-24T00:00:00Z" }] };
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") {
      if (url.searchParams.get("projectId") === "B" && failB) return response({ error: "List unavailable" }, 500);
      return response({ conversations: [chats[url.searchParams.get("projectId")]] });
    }
    if (url.pathname === "/api/conversations/chat-A") return response(oldChat);
    if (url.pathname === "/api/conversations/chat-B") return response(chats.B);
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('#chat-tab-chat-A[aria-selected="true"]') && host.querySelector('.message-text')?.textContent === "Previous worktree message", "first worktree chat");
  [...host.querySelectorAll("button")].find((button) => button.textContent.includes("Review B")).click();
  await until(() => host.querySelector('[role="alert"]')?.textContent.includes("List unavailable"), "rejected next worktree list");
  assert(!host.querySelector('#chat-tab-chat-A'), "Failed B list left A's stale, untabbable chat in the B tablist");
  assert(!host.querySelector('.message-text')?.textContent.includes('Previous worktree'), "Failed B list exposed A's message content");
  failB = false;
  [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry chat list').click();
  await until(() => host.querySelector('#chat-tab-chat-B[aria-selected="true"]'), "recovered next worktree list");
  assert(host.querySelector('#chat-tab-chat-B')?.tabIndex === 0, "Recovered chat tab cannot be reached with Tab");
  assert(host.querySelector('#conversation-panel')?.getAttribute('aria-labelledby') === 'chat-tab-chat-B', "Recovered panel has the wrong owner");
  const tab = host.querySelector('#chat-tab-chat-B');
  tab.focus();
  tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await settle();
  assert(document.activeElement === tab && tab.getAttribute('aria-selected') === 'true', "Recovered chat lost keyboard roving focus");
}

async function chatListSubmissionFenceRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const pendingList = deferred();
  let listRequests = 0;
  let detailRequests = 0;
  const runs = [];
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") {
      listRequests++;
      return listRequests === 2 ? pendingList.promise : response({ conversations: [chats.A] });
    }
    if (url.pathname === "/api/conversations/chat-A") {
      detailRequests++;
      return response({ ...chats.A, provider: detailRequests === 1 ? "codex" : "claude" });
    }
    if (url.pathname === "/api/conversations/chat-A/runs") { runs.push(JSON.parse(options.body)); return response({ id: "run", status: "queued" }, 202); }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('textarea[placeholder*="Ask codex"]'), "old chat detail");
  setControlValue(host.querySelector('textarea[aria-label="Message the agent"]'), "Use current metadata");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.updated", conversationId: "chat-A" }) }));
  await until(() => listRequests === 2, "held list refresh");
  host.querySelector('.composer').requestSubmit();
  assert(runs.length === 0, "Synchronous list fence allowed a stale run before rerender");
  await settle();
  assert(host.querySelector('[aria-label="Send message"]')?.disabled, "Held list refresh left stale chat executable");
  host.querySelector('.composer').requestSubmit();
  await settle();
  assert(runs.length === 0, "Held list refresh posted a stale run");
  pendingList.resolve(response({ conversations: [chats.A] }));
  await until(() => host.querySelector('textarea[placeholder*="Ask claude"]'), "fresh detail after list refresh");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => runs.length === 1, "send after list refresh");
  assert(runs[0].provider === "claude", "Send used stale metadata after list refresh");
}

async function initialChatListFailureSubmissionRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "" : "A"));
  let fail = true;
  let runs = 0;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return fail ? response({ error: "List offline" }, 503) : response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    if (url.pathname.endsWith("/runs")) { runs++; return response({ id: "run", status: "queued" }, 202); }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => [...host.querySelectorAll('button')].some((button) => button.textContent === "Retry chat list"), "initial list failure");
  setControlValue(host.querySelector('textarea[aria-label="Message the agent"]'), "Do not silently discard");
  assert(host.querySelector('[aria-label="Send message"]')?.disabled, "Initial list failure left composer enabled");
  host.querySelector('.composer').requestSubmit();
  await settle();
  assert(runs === 0, "Initial list failure posted a run");
  fail = false;
  [...host.querySelectorAll('button')].find((button) => button.textContent === "Retry chat list").click();
  await until(() => host.querySelector('#chat-tab-chat-A[aria-selected="true"]') && !host.querySelector('[aria-label="Send message"]')?.disabled, "list recovery");
}

async function trustPendingListRefreshRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const pendingTrust = deferred();
  const pendingList = deferred();
  let listRequests = 0;
  let detailRequests = 0;
  let trustRequests = 0;
  const runs = [];
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") {
      listRequests++;
      return listRequests === 2 ? pendingList.promise : response({ conversations: [chats.A] });
    }
    if (url.pathname === "/api/conversations/chat-A") {
      detailRequests++;
      return response({ ...chats.A, provider: detailRequests === 1 ? "codex" : "claude" });
    }
    if (url.pathname === "/api/conversations/chat-A/runs") {
      runs.push(JSON.parse(options.body));
      return runs.length === 1 ? response({ error: "Trust required", code: "PROJECT_TRUST_REQUIRED", project: projects[0] }, 403) : response({ id: "run", status: "queued" }, 202);
    }
    if (url.pathname === "/api/trust") { trustRequests++; return trustRequests === 1 ? pendingTrust.promise : response({}); }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('textarea[placeholder*="Ask codex"]'), "old detail before trust");
  setControlValue(host.querySelector('textarea[aria-label="Message the agent"]'), "Preserve pending prompt");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => document.querySelector('[role="dialog"]')?.textContent.includes("Trust this project?"), "trust request");
  [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Trust and run").click();
  await until(() => trustRequests === 1, "held trust POST");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.updated", conversationId: "chat-A" }) }));
  await until(() => listRequests === 2, "held list during trust POST");
  pendingTrust.resolve(response({}));
  await settle();
  assert(runs.length === 1, "Trust continuation submitted while chat list was pending");
  assert(document.querySelector('[role="dialog"]')?.textContent.includes("Trust this project?"), "Trust refresh race discarded pending prompt");
  pendingList.resolve(response({ conversations: [chats.A] }));
  await until(() => host.querySelector('textarea[placeholder*="Ask claude"]'), "fresh detail after trust race");
  [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Trust and run").click();
  await until(() => runs.length === 2, "resumed pending trust prompt");
  assert(trustRequests === 1, "Trust continuation repeated an already granted trust request");
  assert(runs[1].provider === "claude" && runs[1].prompt === "Preserve pending prompt", "Trust continuation used stale metadata or lost prompt");
}

async function newChatSupersededListRegression(failSuccessor = false) {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "" : "A"));
  const created = { ...chats.A, id: "chat-new", title: "First prompt", provider: "codex" };
  const fresh = { ...created, provider: "claude", model: "fresh-model" };
  const heldPostCreateList = deferred();
  let lists = 0;
  const runs = [];
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations" && options.method === "POST") return response(created, 201);
    if (url.pathname === "/api/conversations") {
      lists++;
      if (lists === 1) return response({ conversations: [] });
      if (lists === 2) return heldPostCreateList.promise;
      if (lists === 3 && failSuccessor) return response({ error: "List unavailable" }, 503);
      return response({ conversations: [created] });
    }
    if (url.pathname === "/api/conversations/chat-new") return response(fresh);
    if (url.pathname === "/api/conversations/chat-new/runs") { runs.push(JSON.parse(options.body)); return response({ id: `run-${runs.length}`, status: "queued" }, 202); }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('textarea[aria-label="Message the agent"]:not(:disabled)'), "new chat composer ready");
  setControlValue(host.querySelector('textarea[aria-label="Message the agent"]'), "First prompt must survive");
  await until(() => host.querySelector('[aria-label="Send message"]:not(:disabled)'), "first prompt enabled");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => lists === 2, "held post-create list");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.created", conversationId: created.id }) }));
  await until(() => lists === 3, "superseding chat list");
  if (failSuccessor) {
    await until(() => host.querySelector('.history-loader')?.textContent === "Retry chat list", "successor list failure");
  } else {
    await until(() => host.querySelector('#chat-tab-chat-new[aria-selected="true"]') && !host.querySelector('[aria-label="Send message"]')?.disabled, "successor selected created chat");
  }
  heldPostCreateList.resolve(response({ conversations: [created] }));
  await until(() => host.querySelector('.first-prompt-notice')?.textContent.includes("your message was not sent"),
    `created chat retry notice after superseded list ${lists}`);
  assert(runs.length === 0, "Superseded list submitted a run before the current list/detail owner was ready");
  assert(host.querySelector('textarea[aria-label="Message the agent"]')?.value === "First prompt must survive", "Superseded list discarded the first draft");
  assert(host.textContent.includes("Chat created, but your message was not sent"), "Created chat silently dropped the first prompt without a visible retry instruction");
  assert(getComputedStyle(host.querySelector('.first-prompt-notice')).display !== 'none', "Unsent first-prompt notice is visually hidden");
  if (failSuccessor) {
    assert(host.querySelector('[aria-label="Send message"]')?.disabled, "Failed successor list left Send enabled");
    [...host.querySelectorAll('button')].find((button) => button.textContent === "Retry chat list").click();
    await until(() => host.querySelector('#chat-tab-chat-new[aria-selected="true"]') && !host.querySelector('[aria-label="Send message"]')?.disabled, "failed successor list recovery");
  }
  assert(host.querySelector('textarea[placeholder*="Ask claude"]'), "Retry did not use fresh detail metadata");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => runs.length === 1, "explicit retry of first prompt");
  assert(runs[0].prompt === "First prompt must survive" && runs[0].provider === "claude" && runs[0].model === "fresh-model", "Explicit first-prompt retry lost prompt or fresh provider/model");
  await until(() => !host.querySelector('.first-prompt-notice'), "successful retry clears the unsent notice");
}

async function newChatOrdinaryRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "" : "A"));
  const created = { ...chats.A, id: "chat-new", provider: "codex" };
  const runs = [];
  let lists = 0;
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations" && options.method === "POST") return response(created, 201);
    if (url.pathname === "/api/conversations") return response({ conversations: url.searchParams.get("projectId") === "A" ? (++lists === 1 ? [] : [created]) : [chats.B] });
    if (url.pathname === "/api/conversations/chat-new") return response({ ...created, provider: "claude" });
    if (url.pathname === "/api/conversations/chat-new/runs") { runs.push(JSON.parse(options.body)); return response({ id: "run-new", status: "queued" }, 202); }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('textarea[aria-label="Message the agent"]:not(:disabled)'), "ordinary empty chat");
  setControlValue(host.querySelector('textarea[aria-label="Message the agent"]'), "First ordinary prompt");
  await until(() => host.querySelector('[aria-label="Send message"]:not(:disabled)'), "ordinary prompt enabled");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => runs.length === 1, "ordinary first run");
  assert(runs[0].provider === "claude" && runs[0].prompt === "First ordinary prompt", "Ordinary first send lost current detail metadata");
  assert(!host.textContent.includes("Chat created, but your message was not sent"), "Ordinary first send showed a false retry warning");
}

async function newChatOwnerSwitchRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "" : "A"));
  const created = { ...chats.A, id: "chat-new" };
  const heldList = deferred();
  let aLists = 0;
  let runs = 0;
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations" && options.method === "POST") return response(created, 201);
    if (url.pathname === "/api/conversations") {
      if (url.searchParams.get("projectId") === "B") return response({ conversations: [chats.B] });
      aLists++;
      return aLists === 1 ? response({ conversations: [] }) : aLists === 2 ? heldList.promise : response({ conversations: [created] });
    }
    if (url.pathname === "/api/conversations/chat-B") return response(chats.B);
    if (url.pathname === "/api/conversations/chat-new") return response({ ...created, provider: "claude" });
    if (url.pathname.endsWith("/runs")) { runs++; return response({ id: "run", status: "queued" }, 202); }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('textarea[aria-label="Message the agent"]:not(:disabled)'), "empty owner A");
  setControlValue(host.querySelector('textarea[aria-label="Message the agent"]'), "Owner A draft");
  await until(() => host.querySelector('[aria-label="Send message"]:not(:disabled)'), "owner A prompt enabled");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => aLists === 2, "held owner A post-create list");
  [...host.querySelectorAll("button")].find((button) => button.textContent.includes("Review B")).click();
  await until(() => host.querySelector('#chat-tab-chat-B[aria-selected="true"]'), "owner B selected");
  heldList.resolve(response({ conversations: [created] }));
  await settle();
  assert(runs === 0 && !host.querySelector('#chat-tab-chat-new'), "Old-owner handoff submitted or selected the created chat in B");
  assert(host.querySelector('[aria-label="Send message"]')?.disabled && host.querySelector('.first-prompt-notice')?.textContent.includes("Return to its worktree"), "Owner B could submit A's unsent draft without a visible owner warning");
  [...host.querySelectorAll("button")].find((button) => button.textContent.includes("Review A")).click();
  await until(() => host.querySelector('#chat-tab-chat-new[aria-selected="true"]'), "returned to created chat in A");
  assert(host.textContent.includes("Chat created, but your message was not sent"), "Owner switch lost the unsent first-prompt notice");
  assert(host.querySelector('textarea[aria-label="Message the agent"]')?.value === "Owner A draft", "Owner switch discarded the unsent draft");
  await until(() => host.querySelector('[aria-label="Send message"]:not(:disabled)'), "owner A retry ready");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => runs === 1, "owner A explicit retry");
}

async function terminalExitWhileCreatingRegression() {
  root.render(null);
  await settle();
  const pendingCreate = deferred();
  let posts = 0;
  let exited = false;
  const runtimeMessages = [];
  const onError = (error) => { throw error; };
  const sendRuntime = (message) => runtimeMessages.push(message);
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") { posts += 1; return pendingCreate.promise; }
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A")] });
    if (url.pathname === "/api/terminals/term-A") return response({ buffer: "", outputCursor: 0, status: exited ? "exited" : "running", exitCode: exited ? 7 : undefined });
    if (url.pathname.startsWith("/api/terminals/")) return response({ buffer: "", outputCursor: 0, status: "running" });
    return response({});
  };
  const show = (runtimeEvent) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={runtimeEvent} onError={onError} sendRuntime={sendRuntime} />);
  show(null);
  await until(() => terminalReady("Terminal A"), "initial terminal before concurrent create and exit");
  host.querySelector('[aria-label="New terminal"]').click();
  await until(() => posts === 1, "held create POST");
  exited = true;
  show({ type: "terminal.exit", terminalId: "term-A", payload: { exitCode: 7 } });
  await until(() => host.querySelector('#terminal-tab-term-A')?.getAttribute('aria-label')?.includes('process exited 7'), "old terminal exit while create pending");
  pendingCreate.resolve(response(terminal("A2")));
  await until(() => terminalReady("Terminal A2"), "new terminal after held create");
  assert(host.querySelector('#terminal-tab-term-A')?.getAttribute('aria-label')?.includes('process exited 7'), "Late create revived an exited terminal in the tablist");
  const priorResizeCount = runtimeMessages.filter((message) => message.type === "terminal.resize" && message.terminalId === "term-A").length;
  host.querySelector('#terminal-tab-term-A').click();
  await until(() => terminalReady("Terminal A"), "return to exited terminal after create");
  assert([...host.querySelectorAll('.terminal-pane [role="status"]')].some((notice) => notice.textContent.includes('process exited 7')), "Exiting terminal lost its notice after the new tab activated");
  assert(runtimeMessages.filter((message) => message.type === "terminal.resize" && message.terminalId === "term-A").length === priorResizeCount, "Exited terminal sent another resize");
  assert(host.querySelector('#terminal-tab-term-A')?.getAttribute('aria-label')?.includes('process exited 7'), "Exited terminal became running on reselect");
}

async function terminalExitWhileClosingRegression() {
  root.render(null);
  await settle();
  const deletion = deferred();
  const remainingDetail = deferred();
  const sent = [];
  let exited = false;
  let detailRequested = false;
  route = async (url, options) => {
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A"), terminal("A2")] });
    if (options.method === "DELETE") return deletion.promise;
    if (url.pathname === "/api/terminals/term-A2") { detailRequested = true; return remainingDetail.promise; }
    if (url.pathname.startsWith("/api/terminals/")) return response({ buffer: "", outputCursor: 0, status: "running" });
    return response({});
  };
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event} onError={(error) => { throw error; }} sendRuntime={(message) => sent.push(message)} />);
  show();
  await until(() => terminalReady("Terminal A"), "terminal before pending close");
  host.querySelector('[aria-label="Close terminal Terminal A"]').click();
  await until(() => host.querySelector('.terminal-tabs[aria-busy="true"]'), "held terminal DELETE");
  exited = true;
  show({ type: "terminal.exit", terminalId: "term-A2", payload: { exitCode: 9 } });
  await until(() => host.querySelector('#terminal-tab-term-A2')?.getAttribute('aria-label')?.includes('process exited 9'), "other terminal exit while DELETE held");
  deletion.resolve(response({}));
  await until(() => detailRequested, "remaining terminal detail held");
  assert(host.querySelector('#terminal-tab-term-A2')?.getAttribute('aria-label')?.includes('process exited 9'), "Closing a different tab revived the exit before activation");
  remainingDetail.resolve(response({ buffer: "", outputCursor: 0, status: exited ? "exited" : "running", exitCode: 9 }));
  await until(() => terminalReady("Terminal A2"), "remaining terminal selected after close");
  assert(host.querySelector('#terminal-tab-term-A2')?.getAttribute('aria-label')?.includes('process exited 9'), "Closing a different tab revived the exited terminal");
  assert(host.querySelector('.terminal-pane [role="status"]')?.textContent.includes('process exited 9'), "Remaining terminal exit not announced");
  assert(!sent.some((item) => item.type === "terminal.resize" && item.terminalId === "term-A2"), "Exited remaining terminal was resized");
}

async function staleArchiveWorktreeRegression(rejectFirstList = false) {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const patch = deferred();
  const bList = deferred();
  let bRequested = false;
  let bRetry = false;
  let aPatched = false;
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations" && url.searchParams.get("projectId") === "B") { bRequested = true; return bRetry ? response({ conversations: [chats.B] }) : bList.promise; }
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A" && options.method === "PATCH") { aPatched = true; return patch.promise; }
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    if (url.pathname === "/api/conversations/chat-B") return response(chats.B);
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('#chat-tab-chat-A[aria-selected="true"]'), "selected A before archive");
  host.querySelector('[aria-label="Archive Conversation A"]').click();
  await until(() => aPatched, "held A archive PATCH");
  [...host.querySelectorAll("button")].find((button) => button.textContent.includes("Review B")).click();
  await until(() => bRequested, "B list in flight");
  patch.resolve(response({ ...chats.A, archived: true }));
  await settle();
  bList.resolve(rejectFirstList ? response({ error: "B list unavailable" }, 503) : response({ conversations: [chats.B] }));
  if (rejectFirstList) {
    await until(() => host.querySelector('.history-loader')?.textContent === 'Retry chat list', "B list error remains retryable");
    bRetry = true;
    host.querySelector('.history-loader').click();
  }
  await until(() => host.querySelector('#chat-tab-chat-B[aria-selected="true"]'), "B list accepted after A archive");
  assert(host.querySelector('#chat-tab-chat-B')?.tabIndex === 0, "B tab not keyboard reachable after stale archive");
  assert(host.querySelector('#conversation-panel')?.getAttribute('aria-labelledby') === 'chat-tab-chat-B', "B panel owner lost");
}

async function terminalKeyboardRegression() {
  root.render(null);
  await settle();
  const pendingBuffer = deferred();
  let secondBufferRequests = 0;
  route = async (url) => {
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A"), terminal("A2")] });
    if (url.pathname === "/api/terminals/term-A2") { secondBufferRequests += 1; return pendingBuffer.promise; }
    return response({ buffer: `Output ${url.pathname}\r\n` });
  };
  root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={null} onError={(error) => { throw error; }} sendRuntime={() => {}} />);
  await until(() => terminalReady("Terminal A"), "keyboard terminal A ready");
  const first = [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Terminal A");
  first.focus();
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await until(() => secondBufferRequests === 1, "keyboard terminal A2 request");
  const second = [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Terminal A2");
  assert(document.activeElement === second, "Switching terminal tabs dropped focus");
  assert(second.getAttribute("aria-disabled") === "true" && !second.disabled, "Loading terminal tab became unfocusable");
  for (const key of ["ArrowLeft", "Home", "End"]) {
    second.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await settle();
    assert(document.activeElement === second, `${key} moved focus to an unselected tab while loading`);
    assert(secondBufferRequests === 1, `${key} started a second request while loading`);
  }
  pendingBuffer.resolve(response({ buffer: "Terminal A2 output\r\n" }));
  await until(() => terminalReady("Terminal A2"), "keyboard terminal A2 activation");
  assert(document.activeElement === second, "Activated terminal did not retain focus");
  second.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
  await settle();
  assert(secondBufferRequests === 1, "Navigating to the active terminal re-fetched its buffer");
  assert(document.activeElement === second, "Navigating to the active terminal moved focus");
  const close = second.parentElement.querySelector('[aria-label^="Close terminal"]');
  close.focus();
  close.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  await settle();
  assert(document.activeElement === close, "Terminal tablist handled an arrow key from the close control");
}

async function terminalUnknownRegression() {
  root.render(null);
  await settle();
  const sent = [];
  const paneCallbacks = [];
  let created = 0;
  let unknown = false;
  const commandFence = createTerminalCommandFence();
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") { created += 1; return response(terminal("A2")); }
    if (url.pathname === "/api/terminals") return response({ terminals: [{ ...terminal("A"), status: unknown ? "unknown" : "running" }] });
    return response({ buffer: "Retained output\r\n", status: unknown ? "unknown" : "running" });
  };
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]}
    runtimeEvent={event} unverifiedTerminalIds={commandFence.snapshot()}
    onError={(error) => { throw error; }} sendRuntime={(message) => {
      paneCallbacks.push(message);
      if (commandFence.allows(message)) sent.push(message);
    }} />);
  show();
  await until(() => terminalReady("Terminal A"), "running terminal before unknown ownership");
  const before = sent.length;
  const auditFailed = { type: "terminal.audit-failed", terminalId: "term-A" };
  commandFence.observe(auditFailed);
  assert(!commandFence.allows({ type: "terminal.input", terminalId: "term-A", data: "x" })
    && !commandFence.allows({ type: "terminal.resize", terminalId: "term-A", cols: 80, rows: 24 }),
  "App command fence allowed an unverified terminal command");
  show(auditFailed);
  // A later event can replace App's latest-event prop before React commits.
  // The separately retained ownership state must still commit the warning.
  show({ type: "capacity.changed", payload: {} });
  await until(() => host.querySelector('[data-tab-id="term-A"]')?.getAttribute("aria-label").includes("ownership unverified"), "unknown ownership announcement");
  assert(host.querySelector('.terminal-pane [role="status"]')?.textContent.includes("ownership is unverified"), "Unknown terminal lacks a spoken status");
  // The App fence starts at event receipt. React may run one previously
  // scheduled pane callback before the unknown prop commits; only the fence
  // can block that interval. Inspect raw pane callbacks after the warning is
  // committed, when the pane itself owns the unknown state.
  const paneAfterWarning = paneCallbacks.length;
  host.querySelector('.terminal-host').style.width = "540px";
  const input = host.querySelector('.terminal-host .xterm-helper-textarea');
  input.focus();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "x", code: "KeyX", keyCode: 88, which: 88, bubbles: true, cancelable: true }));
  await settle();
  assert(!paneCallbacks.slice(paneAfterWarning).some((message) => message.type === "terminal.input" || message.type === "terminal.resize"),
    "Unverified terminal still accepted input or resize");
  assert(!sent.slice(before).some((message) => message.type === "terminal.input" || message.type === "terminal.resize"),
    "App command fence allowed an unverified terminal command");
  root.render(null);
  await settle();
  unknown = true;
  show();
  await until(() => terminalReady("Terminal A"), "unknown terminal restored after restart");
  assert(created === 0, "Unknown terminal silently created a replacement process");
  assert(host.querySelector('[data-tab-id="term-A"]').getAttribute("aria-label").includes("ownership unverified"),
    "Unknown terminal restart lost its ownership warning");
  const afterRemount = sent.length;
  const paneAfterRemount = paneCallbacks.length;
  const restoredInput = host.querySelector('.terminal-host .xterm-helper-textarea');
  restoredInput.focus();
  restoredInput.dispatchEvent(new KeyboardEvent("keydown", { key: "x", code: "KeyX", keyCode: 88, which: 88, bubbles: true, cancelable: true }));
  host.querySelector('.terminal-host').style.width = "600px";
  await settle();
  assert(!paneCallbacks.slice(paneAfterRemount).some((message) => message.type === "terminal.input" || message.type === "terminal.resize"),
    "Restored unknown terminal accepted input or resize");
  assert(!sent.slice(afterRemount).some((message) => message.type === "terminal.input" || message.type === "terminal.resize"),
    "App command fence allowed a restored unverified terminal command");
}

async function terminalUnknownDuringActivationRegression() {
  root.render(null);
  await settle();
  const staleDetail = deferred();
  const sent = [];
  let created = 0;
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") { created += 1; return response(terminal("A2")); }
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A")] });
    if (url.pathname === "/api/terminals/term-A") return staleDetail.promise;
    return response({});
  };
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]}
    runtimeEvent={event} onError={(error) => { throw error; }} sendRuntime={(message) => sent.push(message)} />);
  show();
  await until(() => host.querySelector('.terminal-tab-select[data-tab-id="term-A"]'), "terminal detail request pending");
  show({ type: "terminal.audit-failed", terminalId: "term-A" });
  staleDetail.resolve(response({ ...terminal("A"), status: "running", buffer: "old output", outputCursor: 1 }));
  await until(() => host.querySelector('[data-tab-id="term-A"]')?.getAttribute("aria-label").includes("ownership unverified"),
    "new unknown ownership survives stale activation detail");
  assert(!sent.some((message) => message.type === "terminal.input" || message.type === "terminal.resize"),
    "stale running detail re-enabled terminal interaction");
  assert(created === 0, "unknown terminal started a replacement process");
}

function savedTerminal(id, name, endReason, exitCode, endedAt) {
  return { id, name, cwd: "/fixture/A", pid: null, status: "ended", saved: true, endReason, exitCode, endedAt, createdAt: "2026-10-20T00:00:00.000Z" };
}
function terminalStatusText() { return [...host.querySelectorAll('.terminal-pane [role="status"]')].map((node) => node.textContent).join(" "); }

// Find reads the retained scrollback without taking keys from the process:
// its shortcut and query never reach the terminal, Escape inside the
// terminal still does, and closing Find gives the keyboard back.
async function terminalScrollbackFindRegression() {
  root.render(null);
  await settle();
  const sent = [];
  const errors = [];
  const lines = Array.from({ length: 4900 }, (_, index) => index % 700 === 350 ? `step ${index} FAIL build` : `row ${index} ok`);
  lines.splice(2000, 0, "Straße 日本語 ✓ done");
  route = async (url) => {
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A")] });
    return response({ ...terminal("A"), buffer: `${lines.join("\r\n")}\r\n$ `, outputCursor: 1 });
  };
  const sendRuntime = (message) => sent.push(message);
  const show = (event = null) => root.render(<div className="fixture-terminal-frame" style={{ width: 640, height: 420 }}><TerminalPane worktree={projects[0].worktrees[0]}
    runtimeEvent={event} onError={(error) => errors.push(error)} sendRuntime={sendRuntime} /></div>);
  const rows = () => host.querySelector(".terminal-host .xterm-rows")?.textContent ?? "";
  const find = () => host.querySelector('input[aria-label="Find in terminal output"]');
  const status = () => host.querySelector(".terminal-find > span[aria-hidden]")?.textContent ?? "";
  const inputs = () => sent.filter((message) => message.type === "terminal.input").map((message) => message.data);
  const textarea = () => host.querySelector(".terminal-host .xterm-helper-textarea");
  const key = (target, init) => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  show();
  await until(() => terminalReady("Terminal A") && rows().includes("row 4899 ok") && sent.some((message) => message.type === "terminal.resize"), "large retained output ready for input");

  textarea().focus();
  key(textarea(), { key: "Escape", code: "Escape", keyCode: 27 });
  assert(inputs().join("") === "\x1b" && !find(), "Escape in the terminal did not reach the process");
  const resizes = () => sent.filter((message) => message.type === "terminal.resize").length;
  const resizesBeforeFind = resizes();
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const shortcut = mac ? { metaKey: true } : { ctrlKey: true, shiftKey: true };
  key(textarea(), { key: mac ? "f" : "F", code: "KeyF", keyCode: 70, ...shortcut });
  await until(() => find() && document.activeElement === find(), "Find shortcut focuses the query");
  const opener = host.querySelector('[aria-label="Find in terminal"]');
  assert(opener.getAttribute("aria-expanded") === "true" && opener.getAttribute("aria-keyshortcuts") === (mac ? "Meta+F" : "Control+Shift+F"), "Find toggle state or shortcut is not exposed");

  const startedAt = performance.now();
  setControlValue(find(), "fail");
  const searchMs = performance.now() - startedAt;
  window.__performanceEvidence = { ...window.__performanceEvidence, terminalFindMs: Math.round(searchMs) };
  await until(() => status() === "7 of 7", "a new query selects the newest match");
  assert(searchMs < 500, `Searching 4,900 retained lines took ${Math.round(searchMs)}ms`);
  await until(() => rows().includes("step 4550 FAIL build"), "newest match shown");
  // Enter that confirms an IME composition stays with the composition.
  key(find(), { key: "Enter", isComposing: true });
  key(find(), { key: "Enter", keyCode: 229 });
  await settle();
  assert(status() === "7 of 7", "Enter during IME composition moved the match");
  key(find(), { key: "Enter", shiftKey: true });
  await until(() => status() === "6 of 7" && rows().includes("step 3850 FAIL build"), "Shift+Enter moves to the previous match");
  key(find(), { key: "Enter" });
  key(find(), { key: "Enter" });
  await until(() => status() === "1 of 7" && rows().includes("step 350 FAIL build"), "Enter wraps to the earliest match");
  host.querySelector('[aria-label="Previous terminal match"]').click();
  await until(() => status() === "7 of 7", "Previous wraps to the newest match");
  await until(() => host.querySelector(".terminal-find [role=status]").textContent === "Match 7 of 7", "match state announced");
  assert(host.querySelector(".terminal-host .xterm-selection")?.childElementCount > 0, "The current match is not highlighted");

  setControlValue(find(), "STRASSE 日本");
  await until(() => status() === "1 of 1" && rows().includes("Straße 日本語"), "Unicode case folding finds a wide-character line");
  setControlValue(find(), "r.w 1");
  await until(() => status() === "No matches", "a regex-looking query is literal");
  assert(!inputs().slice(1).length, `Find sent keys to the process: ${JSON.stringify(inputs())}`);
  await settle();
  assert(resizes() === resizesBeforeFind, "Opening Find resized the process's terminal");

  // A new query starts from the view, still at the Unicode line. New output
  // recounts without moving the current match; a full reset drops it, and
  // the next step starts in the new buffer.
  setControlValue(find(), "fail");
  await until(() => status() === "3 of 7" && rows().includes("step 1750 FAIL build"), "a query selects the newest match above the view's bottom");
  show({ type: "terminal.output", terminalId: "term-A", payload: { cursor: 2, data: "\r\nstep new FAIL again\r\n$ " } });
  await until(() => status() === "3 of 8", "new output counted while the current match stays");
  assert(rows().includes("step 1750 FAIL build"), "New output moved the view away from the current match");
  // The reset buffer's only match is on its first row, at the right edge
  // under the bar, where the view cannot scroll it out from under the bar.
  const size = () => sent.filter((message) => message.type === "terminal.resize").at(-1);
  show({ type: "terminal.output", terminalId: "term-A", payload: { cursor: 3, data: `\x1bc\x1b[1;${size().cols - 14}Hfresh FAIL only\r\n$ ` } });
  await until(() => status() === "1 match", "a terminal reset recounts and drops the earlier match");
  key(find(), { key: "Enter" });
  await until(() => status() === "1 of 1", "Enter selects in the reset buffer");
  await until(() => host.querySelector(".terminal-find.is-lowered"), "the bar moves off a match it covers");
  await settle();
  const bar = host.querySelector(".terminal-find").getBoundingClientRect();
  const selected = [...host.querySelectorAll(".terminal-host .xterm-selection > *")].map((node) => node.getBoundingClientRect());
  assert(selected.length && selected.every((rect) => rect.right <= bar.left || rect.left >= bar.right || rect.bottom <= bar.top || rect.top >= bar.bottom),
    "The Find bar covers the current match on the first row");
  assert(resizes() === resizesBeforeFind, "Moving the Find bar resized the process's terminal");

  const next = host.querySelector('[aria-label="Next terminal match"]');
  next.focus();
  key(next, { key: "Escape" });
  await until(() => !find() && document.activeElement === textarea(), "Escape from a Find button closes Find and returns focus to the terminal");
  await until(() => !host.querySelector(".terminal-host .xterm-selection")?.childElementCount, "closing Find clears its match selection");
  key(textarea(), { key: "Escape", code: "Escape", keyCode: 27 });
  assert(inputs().join("") === "\x1b\x1b", "Input did not return to the process after Find closed");
  opener.click();
  await until(() => find()?.value === "fail" && document.activeElement === find() && status() === "1 of 1", "reopened Find searches its query again");
  key(find(), { key: "Escape", isComposing: true });
  await settle();
  assert(find(), "Escape that cancels an IME composition closed Find");

  // A wide character that does not fit in the last column wraps and leaves
  // an empty cell behind, which Find does not read as a space.
  show({ type: "terminal.output", terminalId: "term-A", payload: { cursor: 4, data: `\r\n${"a".repeat(size().cols - 2)}d日 end\r\n$ ` } });
  await until(() => rows().includes("日 end"), "a wide character wrapped past the last column");
  setControlValue(find(), "d日");
  await until(() => status() === "1 of 1", "a wide character wrapped to the next row is found");
  setControlValue(find(), "d 日");
  await until(() => status() === "No matches", "the cell a wide character wrapped past is not a space");

  // xterm clears the selection when the view's height changes; Find selects
  // its current match again, but never in place of the user's selection.
  const highlighted = () => host.querySelector(".terminal-host .xterm-selection")?.childElementCount > 0;
  const terminalFrame = host.querySelector(".fixture-terminal-frame");
  const settledResize = async (height, label) => {
    const count = sent.filter((message) => message.type === "terminal.resize").length;
    terminalFrame.style.height = height;
    await until(() => sent.filter((message) => message.type === "terminal.resize").length > count, label);
    // Past the recount, so xterm has painted the selection it cleared.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await settle();
  };
  // xterm measures cells in the terminal font once it has loaded and applies
  // them at a later fit. Fit until the width holds, so the resizes below
  // change only the height.
  await document.fonts.load('12px "DM Sans Variable"');
  await settledResize("400px", "the terminal measures its loaded font");
  for (let attempt = 0, cols = 0; attempt < 4 && size().cols !== cols; attempt += 1) {
    cols = size().cols;
    await settledResize(attempt % 2 ? "400px" : "390px", "the terminal fits its loaded font");
  }
  setControlValue(find(), "日 end");
  await until(() => status() === "1 of 1" && highlighted(), "the wrapped wide-character match is current and highlighted");
  const before = size();
  await settledResize("340px", "the terminal is resized to fewer rows");
  assert(size().cols === before.cols && size().rows < before.rows, `The resize changed more than the height: ${JSON.stringify([before, size()])}`);
  assert(status() === "1 of 1" && highlighted(), "A resize left the current match without its highlight");
  assert(rows().includes("日 end"), "The resize moved the view");
  const screen = host.querySelector(".terminal-host .xterm-screen").getBoundingClientRect();
  const rowHeight = screen.height / size().rows;
  const selectedRows = () => [...host.querySelectorAll(".terminal-host .xterm-selection > *")].map((node) => Math.round((node.getBoundingClientRect().top - screen.top) / rowHeight));
  // The user double-clicks the word that wraps onto the match's row, from
  // the row above it, which Find's selection does not cover.
  const userRow = Math.min(...selectedRows()) - 1;
  const point = { bubbles: true, cancelable: true, button: 0, clientX: screen.left + 4, clientY: screen.top + rowHeight * (userRow + 0.5) };
  host.querySelector(".terminal-host .xterm-screen").dispatchEvent(new MouseEvent("mousedown", { ...point, detail: 2 }));
  document.dispatchEvent(new MouseEvent("mouseup", { ...point, detail: 2 }));
  await until(() => selectedRows().includes(userRow), "the user's double-click replaces Find's selection");
  await settledResize("420px", "the terminal is resized back");
  assert(size().cols === before.cols && status() === "1 of 1", `The resize back dropped the current match: ${status()}`);
  assert(!highlighted(), "A resize put Find's match back in place of the user's selection");

  // The bar covers only the right part of the top rows: a match left of it
  // stays where it is and the bar stays up; one under it is scrolled out.
  const viewRows = () => [...host.querySelectorAll(".terminal-host .xterm-rows > div")].map((row) => row.textContent);
  const filler = (count) => Array.from({ length: count }, (_, index) => `fill ${index}\r\n`).join("");
  show({ type: "terminal.output", terminalId: "term-A", payload: { cursor: 5, data: `\r\n${filler(40)}LEFT mark\r\n${" ".repeat(size().cols - 14)}RIGHT mark\r\n${filler(size().rows - 3)}$ ` } });
  await until(() => viewRows()[0]?.startsWith("LEFT mark") && viewRows()[1]?.trim() === "RIGHT mark", "a match at the top left and one at the top right of the view");
  setControlValue(find(), "left mark");
  await until(() => status() === "1 of 1" && host.querySelector(".terminal-host .xterm-selection")?.childElementCount > 0, "the top-left match is current");
  await settle();
  assert(viewRows()[0]?.startsWith("LEFT mark"), `Find scrolled a match the bar does not cover: ${JSON.stringify(viewRows()[0])}`);
  assert(!host.querySelector(".terminal-find.is-lowered"), "The Find bar lowered over the prompt for a match it does not cover");
  // Reopened with its query, from the shortcut or the button, Find decides
  // from the mounted bar too: the bar is never drawn lowered for it.
  const lowered = [];
  const watchLowered = new MutationObserver(() => { if (host.querySelector(".terminal-find.is-lowered")) lowered.push(status()); });
  const reopensLeftOfBar = async (text, query) => {
    for (const [label, open] of [["the shortcut", () => key(textarea(), { key: mac ? "f" : "F", code: "KeyF", keyCode: 70, ...shortcut })], ["the button", () => opener.click()]]) {
      key(find(), { key: "Escape" });
      await until(() => !find() && document.activeElement === textarea(), `Escape closes Find before it reopens from ${label}`);
      watchLowered.observe(host, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });
      open();
      await until(() => find()?.value === query && document.activeElement === find() && status() === "1 of 1" && highlighted(), `Find reopens from ${label} on ${text}`);
      await settle();
      watchLowered.disconnect();
      assert(viewRows()[0]?.startsWith(text), `Reopening Find from ${label} scrolled a match the bar does not cover: ${JSON.stringify(viewRows()[0])}`);
      assert(!lowered.length, `Reopening Find from ${label} lowered the bar for a match it does not cover`);
    }
  };
  await reopensLeftOfBar("LEFT mark", "left mark");
  setControlValue(find(), "right mark");
  await until(() => status() === "1 of 1" && !viewRows()[1]?.includes("RIGHT mark"), "Find scrolls a match the bar covers out from under it");
  await settle();
  const barRect = host.querySelector(".terminal-find").getBoundingClientRect();
  const marked = [...host.querySelectorAll(".terminal-host .xterm-selection > *")].map((node) => node.getBoundingClientRect());
  assert(marked.length && marked.every((rect) => rect.bottom <= barRect.top || rect.top >= barRect.bottom), "The Find bar covers the current match at the top right");
  assert(!host.querySelector(".terminal-find.is-lowered"), "The Find bar lowered for a match scrolled out from under it");
  // A match that starts on the last row of the view and wraps below it is
  // scrolled until it is shown whole.
  const middle = size().rows - 1 - Math.floor(size().rows / 2);
  show({ type: "terminal.output", terminalId: "term-A", payload: { cursor: 6, data: `\r\n${filler(40)}ANCHOR mark\r\n${filler(middle - 1)}${" ".repeat(size().cols - 4)}WRAP mark\r\n${filler(size().rows)}$ ` } });
  // Output is parsed by the second frame.
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await settle();
  setControlValue(find(), "anchor mark");
  await until(() => status() === "1 of 1" && viewRows().at(-1)?.trimEnd().endsWith("WRAP"), "the view ends on the first row of a wrapped match");
  setControlValue(find(), "wrap mark");
  await until(() => status() === "1 of 1" && highlighted(), "the wrapped match is current");
  await settle();
  const wrapRow = viewRows().findIndex((row) => row.trimEnd().endsWith("WRAP"));
  assert(wrapRow >= 0 && viewRows()[wrapRow + 1]?.trim() === "mark", `Find left the wrapped part of its match below the view: ${JSON.stringify(viewRows().slice(-2))}`);
  // At the top of the buffer the view cannot scroll, so only the bar's
  // real left edge keeps it up for a top-left match.
  show({ type: "terminal.output", terminalId: "term-A", payload: { cursor: 7, data: "\x1bcTOP mark\r\n$ " } });
  await until(() => viewRows()[0]?.startsWith("TOP mark") && status() === "No matches", "a reset buffer starts with a top-left match");
  setControlValue(find(), "top mark");
  await until(() => status() === "1 of 1" && highlighted(), "the match at the top of the buffer is current");
  await reopensLeftOfBar("TOP mark", "top mark");
  host.querySelector('[aria-label="Close terminal find"]').click();
  await until(() => !find() && document.activeElement === textarea(), "Close returns focus to the terminal");
  assert(!errors.length, `Unexpected terminal errors: ${errors.map((error) => error.message).join("; ")}`);
}

// Find's highlight stays on its current match's text wherever output or a
// resize moves the match, only that highlight is drawn as the match, a
// selection the user made or is dragging is left alone, and streaming output does not keep
// re-announcing the count.
async function terminalFindHighlightRegression() {
  root.render(null);
  await settle();
  const sent = [];
  const errors = [];
  let cursor = 1;
  route = async (url) => {
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A")] });
    return response({ ...terminal("A"), buffer: "alpha\r\nfirst\r\nTARGET one\r\nlast\r\n$ ", outputCursor: 1 });
  };
  const sendRuntime = (message) => sent.push(message);
  const show = (data = null) => root.render(<div className="fixture-terminal-frame" style={{ width: 640, height: 420 }}><TerminalPane worktree={projects[0].worktrees[0]}
    runtimeEvent={data === null ? null : { type: "terminal.output", terminalId: "term-A", payload: { cursor: ++cursor, data } }}
    onError={(error) => errors.push(error)} sendRuntime={sendRuntime} /></div>);
  // Output is parsed by the second frame, and its recount follows 200ms later.
  const write = async (data) => { show(data); await settle(); await new Promise((resolve) => setTimeout(resolve, 300)); await settle(); };
  const find = () => host.querySelector('input[aria-label="Find in terminal output"]');
  const status = () => host.querySelector(".terminal-find > span[aria-hidden]")?.textContent ?? "";
  // An unchanged announcement toggles a trailing no-break space, which trim drops.
  const announced = () => host.querySelector(".terminal-find [role=status]")?.textContent.trim() ?? "";
  const size = () => sent.filter((message) => message.type === "terminal.resize").at(-1);
  const textarea = () => host.querySelector(".terminal-host .xterm-helper-textarea");
  const key = (target, init) => target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  // Records the live region's text each time it is mounted or changes.
  const watchAnnouncements = () => {
    const seen = [];
    let last = host.querySelector(".terminal-find [role=status]");
    let lastText = last?.textContent;
    const record = () => {
      const region = host.querySelector(".terminal-find [role=status]");
      if (!region || (region === last && region.textContent === lastText)) return;
      last = region;
      lastText = region.textContent;
      seen.push(lastText.trim());
    };
    const observer = new MutationObserver(record);
    observer.observe(host, { childList: true, characterData: true, subtree: true });
    return { seen, stop: () => observer.disconnect() };
  };
  // xterm copies its own selection, so the copied text is what it selected.
  const selectedText = () => {
    const clipboardData = new DataTransfer();
    textarea().dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    return clipboardData.getData("text/plain");
  };
  const amber = ["rgb(196, 132, 12)", "rgb(232, 176, 74)"];
  const selectionColor = () => { const node = host.querySelector(".terminal-host .xterm-selection > *"); return node ? getComputedStyle(node).backgroundColor : ""; };
  const screenRows = () => [...host.querySelectorAll(".terminal-host .xterm-rows > div")].map((row) => row.textContent);
  const doubleClick = (text) => {
    const screen = host.querySelector(".terminal-host .xterm-screen");
    const box = screen.getBoundingClientRect();
    const rowHeight = box.height / size().rows;
    const row = screenRows().findIndex((line) => line.startsWith(text));
    assert(row >= 0, `No row starts with ${text}`);
    const point = { bubbles: true, cancelable: true, button: 0, clientX: box.left + 4, clientY: box.top + rowHeight * (row + 0.5) };
    screen.dispatchEvent(new MouseEvent("mousedown", { ...point, detail: 2 }));
    document.dispatchEvent(new MouseEvent("mouseup", { ...point, detail: 2 }));
  };
  const frameElement = () => host.querySelector(".fixture-terminal-frame");
  const settledResize = async (property, value, label) => {
    const count = sent.filter((message) => message.type === "terminal.resize").length;
    frameElement().style[property] = value;
    await until(() => sent.filter((message) => message.type === "terminal.resize").length > count, label);
    // The recount follows xterm's resize, which is sent before this.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
  };
  show();
  await until(() => terminalReady("Terminal A") && screenRows().some((line) => line.startsWith("TARGET one")) && size(), "terminal ready");
  // The terminal font's late load changes its cells at a later fit; fit until
  // the size holds, so the resizes below change only what they mean to.
  await document.fonts.load('12px "DM Sans Variable"');
  await settledResize("height", "390px", "the terminal measures its loaded font");
  for (let attempt = 0, cols = 0; attempt < 4 && size().cols !== cols; attempt += 1) {
    cols = size().cols;
    await settledResize("height", attempt % 2 ? "390px" : "360px", "the terminal fits its loaded font");
  }

  host.querySelector('[aria-label="Find in terminal"]').click();
  await until(() => document.activeElement === find(), "Find opens");
  setControlValue(find(), "target one");
  await until(() => status() === "1 of 1" && selectedText() === "TARGET one", "the query selects its match");
  await until(() => amber.includes(selectionColor()), "Find's match is drawn in the match color");

  // A line inserted (CSI L) or deleted (CSI M) above the match moves it, while
  // xterm keeps the selection on the same cells.
  await write("\x1b7\x1b[1;1H\x1b[L\x1b8");
  assert(status() === "1 of 1" && selectedText() === "TARGET one", `A line inserted above left Find's highlight on ${JSON.stringify(selectedText())}`);
  await write("\x1b7\x1b[1;1H\x1b[M\x1b8");
  assert(status() === "1 of 1" && selectedText() === "TARGET one", `A line deleted above left Find's highlight on ${JSON.stringify(selectedText())}`);

  // The user's selection is theirs: drawn in the normal color and not moved
  // or replaced as output moves the match.
  doubleClick("first");
  await until(() => selectedText() === "first" && selectionColor() && !amber.includes(selectionColor()), "the user's selection keeps the normal selection color");
  await write("\x1b7\x1b[1;1H\x1b[L\x1b8");
  assert(selectedText() === "alpha" && status() === "1 of 1", `Find moved the user's selection after a line was inserted: ${JSON.stringify(selectedText())}`);
  await write("\x1b7\x1b[1;1H\x1b[M\x1b8");
  assert(selectedText() === "first", `Find moved the user's selection after a line was deleted: ${JSON.stringify(selectedText())}`);
  key(find(), { key: "Enter" });
  await until(() => selectedText() === "TARGET one" && amber.includes(selectionColor()), "Next highlights the match in the match color again");

  // A width change reflows a long line above the match onto more rows.
  await write(`\r\n${"x".repeat(size().cols - 4)}\r\nTARGET two\r\n$ `);
  setControlValue(find(), "target two");
  await until(() => status() === "1 of 1" && selectedText() === "TARGET two", "the match below a long line is selected");
  const wide = size();
  await settledResize("width", "420px", "the terminal is narrowed");
  assert(size().rows === wide.rows && size().cols < wide.cols - 4, `The resize changed more than the width: ${JSON.stringify([wide, size()])}`);
  assert(status() === "1 of 1" && selectedText() === "TARGET two", `A reflow above left Find's highlight on ${JSON.stringify(selectedText())}`);
  doubleClick("first");
  await until(() => selectedText() === "first", "the user selects other text");
  await settledResize("width", "640px", "the terminal is widened");
  assert(size().cols === wide.cols && status() === "1 of 1" && selectedText() === "first", `Find took over the user's selection on a reflow: ${JSON.stringify(selectedText())}`);

  // Output alone announces the count at most every few seconds; the visible
  // count still follows it.
  await write("\r\ntick 0\r\n$ ");
  setControlValue(find(), "tick");
  await until(() => announced() === "Match 1 of 1", "a new query is announced");

  // A user action is announced even when its text does not change: Next on
  // the only match, and Find reopened within the output pacing interval.
  let watch = watchAnnouncements();
  key(find(), { key: "Enter" });
  await until(() => watch.seen.length && announced() === "Match 1 of 1", "Next on the only match is announced again");
  watch.stop();
  key(find(), { key: "Escape" });
  await until(() => !find(), "Escape closes Find");
  watch = watchAnnouncements();
  host.querySelector('[aria-label="Find in terminal"]').click();
  await until(() => find() && announced() === "Match 1 of 1", "the reopened query is announced");
  await new Promise((resolve) => setTimeout(resolve, 300));
  watch.stop();
  assert(watch.seen[0] === "" && watch.seen.at(-1) === "Match 1 of 1", `Reopening Find did not change its live region: ${JSON.stringify(watch.seen)}`);
  const announcements = [];
  const observer = new MutationObserver(() => announcements.push(announced()));
  observer.observe(host.querySelector(".terminal-find [role=status]"), { childList: true, characterData: true, subtree: true });
  for (let index = 1; index <= 12; index += 1) {
    show(`\r\ntick ${index}\r\n$ `);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await until(() => status() === "1 of 13", "streamed output is counted");
  observer.disconnect();
  assert(announcements.length <= 1, `Streaming output re-announced the count: ${JSON.stringify(announcements)}`);
  key(find(), { key: "Enter" });
  await until(() => announced() === "Match 2 of 13", "a step is announced at once");

  // A current match that newer output pushes out of the newest 1,000 matches
  // is no longer current.
  await write(Array.from({ length: 1100 }, (_, index) => `\r\nhit ${index}`).join("") + "\r\n$ ");
  setControlValue(find(), "hit");
  await until(() => /^(1|1000) of 1000\+$/.test(status()), "one of many matches is current");
  if (status() !== "1 of 1000+") key(find(), { key: "Enter" });
  await until(() => status() === "1 of 1000+" && selectedText() === "hit", "the oldest counted match is current");
  await write("\r\nhit again\r\n$ ");
  await until(() => status() === "1000+ matches" && !selectedText(), "a match pushed out of the newest 1,000 is dropped with its highlight");

  // Once the scrollback is full, output trims the oldest lines and xterm
  // moves the selection with its text, so Find's highlight stays on its match
  // without being drawn again.
  const fill = Array.from({ length: 5100 }, (_, index) => `\r\nfill ${index}`).join("");
  await write(`${fill}\r\nNEEDLE row${Array.from({ length: 5 }, (_, index) => `\r\nafter ${index}`).join("")}\r\n$ `);
  setControlValue(find(), "needle row");
  await until(() => status() === "1 of 1" && selectedText() === "NEEDLE row" && amber.includes(selectionColor()), "the match in a full scrollback is highlighted");
  const select = Terminal.prototype.select;
  let selects = 0;
  Terminal.prototype.select = function countSelect(...args) { selects += 1; return select.apply(this, args); };
  const stream = async (label, count = 3) => {
    for (let index = 0; index < count; index += 1) {
      show(`\r\n${label} ${index}`);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await settle();
  };
  try {
    await stream("more");
    assert(selects === 0, `Streaming into a full scrollback drew Find's highlight again ${selects} times`);
  } finally {
    Terminal.prototype.select = select;
  }
  assert(status() === "1 of 1" && selectedText() === "NEEDLE row" && amber.includes(selectionColor()), `Streaming into a full scrollback moved Find's highlight to ${JSON.stringify(selectedText())}`);

  // A drag the user starts is theirs before xterm reports it on release, so a
  // recount during the drag, after output trims the scrollback or inserts a
  // line above the match, neither replaces nor ends it.
  const drag = async (text, during) => {
    const screen = host.querySelector(".terminal-host .xterm-screen");
    const box = screen.getBoundingClientRect();
    const rowHeight = box.height / size().rows;
    const row = screenRows().findIndex((line) => line.startsWith(text));
    assert(row >= 0, `No row starts with ${text}`);
    const clientY = box.top + rowHeight * (row + 0.5);
    const point = { bubbles: true, cancelable: true, button: 0, clientY };
    screen.dispatchEvent(new MouseEvent("mousedown", { ...point, buttons: 1, detail: 1, clientX: box.left + 1 }));
    document.dispatchEvent(new MouseEvent("mousemove", { ...point, buttons: 1, clientX: box.right - 2 }));
    await during();
    assert(selectionColor() && !amber.includes(selectionColor()), `The user's drag across ${text} is drawn as Find's match before release`);
    document.dispatchEvent(new MouseEvent("mouseup", { ...point, clientX: box.right - 2 }));
    await settle();
  };
  await drag("after 1", () => stream("drag"));
  assert(selectedText() === "after 1" && status() === "1 of 1", `A recount during the user's drag in a full scrollback replaced it with ${JSON.stringify(selectedText())}`);
  assert(selectionColor() && !amber.includes(selectionColor()), "The user's drag is drawn as Find's match");
  key(find(), { key: "Enter" });
  await until(() => selectedText() === "NEEDLE row" && amber.includes(selectionColor()), "Next highlights the match again");
  // The inserted line moves the text under the user's cells down one row.
  await drag("after 3", () => write("\x1b7\x1b[1;1H\x1b[L\x1b8"));
  assert(selectedText() === "after 2" && status() === "1 of 1", `A recount during the user's drag after a line was inserted replaced it with ${JSON.stringify(selectedText())}`);
  assert(selectionColor() && !amber.includes(selectionColor()), "The user's drag is drawn as Find's match after a line was inserted");
  // xterm clears the selection for a change of height; Find draws its
  // highlight again at once, before the recount. A drag, typing or a paste
  // that comes after the change and before the recount is the user's, so the
  // recount leaves it alone and the input still reaches the process.
  const tall = size();
  const tallHeight = frameElement().style.height;
  const heightChanged = async (height, label) => {
    key(find(), { key: "Enter" });
    await until(() => selectedText() === "NEEDLE row" && amber.includes(selectionColor()), `Find highlights its match before ${label}`);
    const before = size();
    frameElement().style.height = height;
    await until(() => size() !== before && host.querySelectorAll(".terminal-host .xterm-rows > div").length === size().rows, `the height changes before ${label}`);
    assert(size().cols === tall.cols && size().rows !== before.rows, `The resize changed more than the height: ${JSON.stringify([before, size()])}`);
    assert(selectedText() === "NEEDLE row" && amber.includes(selectionColor()), `A change of height left Find's highlight on ${JSON.stringify(selectedText())} before ${label}`);
  };
  await heightChanged("300px", "a drag");
  await drag("after 1", () => new Promise((resolve) => setTimeout(resolve, 300)));
  assert(selectedText() === "after 1" && status() === "1 of 1", `A recount after a change of height replaced the user's drag with ${JSON.stringify(selectedText())}`);
  assert(selectionColor() && !amber.includes(selectionColor()), "The user's drag after a change of height is drawn as Find's match");
  const sends = (data) => sent.filter((message) => message.type === "terminal.input" && message.data === data).length;
  for (const [label, height, data, input] of [
    ["typing", tallHeight, "x", () => key(textarea(), { key: "x", code: "KeyX", keyCode: 88, which: 88 })],
    ["a paste", "300px", "pasted", () => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "pasted");
      textarea().dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
    }],
  ]) {
    await heightChanged(height, label);
    const count = sends(data);
    input();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
    assert(sends(data) === count + 1, `${label} after a change of height did not reach the process`);
    assert(!selectedText() && !amber.includes(selectionColor()) && status() === "1 of 1",
      `A recount after ${label} drew Find's highlight again on ${JSON.stringify(selectedText())}`);
  }
  await settledResize("height", tallHeight, "the terminal is resized back");

  // A press xterm does not select with leaves Find's highlight Find's: one on
  // the scrollbar, a right-click on the highlight, and a click while a
  // program tracks the mouse. These are native presses, so the browser
  // decides which mouse events reach the page. Afterwards a line inserted
  // above still moves the highlight with its match, and closing Find
  // removes it.
  assert(window.__fixtureMouse, "Native mouse input is unavailable");
  const press = async (x, y, button = "left") => {
    await window.__fixtureMouse("mousePressed", x, y, button);
    await window.__fixtureMouse("mouseReleased", x, y, button);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await settle();
  };
  const rowPoint = (text) => {
    const box = host.querySelector(".terminal-host .xterm-screen").getBoundingClientRect();
    const rowHeight = box.height / size().rows;
    const row = screenRows().findIndex((line) => line.startsWith(text));
    assert(row >= 0, `No row starts with ${text}`);
    return { x: box.left + 4, y: box.top + rowHeight * (row + 0.5) };
  };
  const keepsHighlight = async (label, pressed) => {
    key(find(), { key: "Enter" });
    await until(() => selectedText() === "NEEDLE row" && amber.includes(selectionColor()), `Find highlights its match before ${label}`);
    await pressed();
    assert(status() === "1 of 1" && selectedText() === "NEEDLE row" && amber.includes(selectionColor()), `${label} took Find's highlight from it (${JSON.stringify(selectedText())}, ${selectionColor()})`);
    await write("\x1b7\x1b[1;1H\x1b[L\x1b8");
    assert(status() === "1 of 1" && selectedText() === "NEEDLE row" && amber.includes(selectionColor()), `After ${label}, a line inserted above left Find's highlight on ${JSON.stringify(selectedText())}`);
    key(find(), { key: "Escape" });
    await until(() => !find(), `Escape closes Find after ${label}`);
    assert(!selectedText(), `Closing Find after ${label} left ${JSON.stringify(selectedText())} selected`);
    host.querySelector('[aria-label="Find in terminal"]').click();
    await until(() => document.activeElement === find() && status() === "1 of 1", `Find reopens after ${label}`);
  };
  await keepsHighlight("a press on the scrollbar", async () => {
    const slider = host.querySelector(".terminal-host .xterm-scrollable-element > .scrollbar.vertical > .slider");
    assert(slider, "The terminal has no scrollbar slider");
    const box = slider.getBoundingClientRect();
    const shown = screenRows().join("\n");
    // The scrollbar takes presses once the pointer over the terminal shows it.
    await window.__fixtureMouse("mouseMoved", box.left + box.width / 2, box.top + box.height / 2);
    await until(() => document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === slider, "the scrollbar shows under the pointer");
    await press(box.left + box.width / 2, box.top + box.height / 2);
    assert(screenRows().join("\n") === shown, "Pressing the scrollbar slider scrolled the terminal");
  });
  await keepsHighlight("a right-click on the highlight", async () => {
    const { x, y } = rowPoint("NEEDLE row");
    await press(x, y, "right");
  });
  await write("\x1b[?1000h");
  await keepsHighlight("a click while the program tracks the mouse", async () => {
    assert(host.querySelector(".terminal-host .xterm.enable-mouse-events"), "The terminal does not track the mouse");
    const { x, y } = rowPoint("after 4");
    await press(x, y);
  });
  await write("\x1b[?1000l");
  key(find(), { key: "Escape" });
  await until(() => !find() && document.activeElement === textarea(), "Escape closes Find");
  assert(!errors.length, `Unexpected terminal errors: ${errors.map((error) => error.message).join("; ")}`);
}

async function terminalSavedSessionRegression() {
  root.render(null);
  await settle();
  const restarted = savedTerminal("term-S", "Server", "restart", null, "2026-10-21T01:00:00.000Z");
  const exited = savedTerminal("term-E", "Build", "exit", 7, "2026-10-21T00:00:00.000Z");
  const sent = [];
  const errors = [];
  const posts = [];
  const deletes = [];
  let failPost = true;
  let listed = [exited, restarted];
  let listings = 0;
  const relaunched = { id: "term-N", name: "Server", cwd: "/fixture/A", pid: 4100, status: "running", relaunchedFrom: "term-S", createdAt: "2026-10-21T02:00:00.000Z" };
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") {
      posts.push(JSON.parse(options.body));
      if (failPost) return response({ error: "Terminal capacity is full" }, 429);
      listed = [...listed, relaunched];
      return response(relaunched, 201);
    }
    if (url.pathname === "/api/terminals") { listings += 1; return response({ terminals: listed, history: { persistent: true, warning: null } }); }
    if (options.method === "DELETE") { deletes.push(url.pathname); listed = listed.filter((item) => !url.pathname.endsWith(item.id)); return response({}); }
    if (url.pathname.endsWith(relaunched.id)) return response({ ...relaunched, buffer: "$ ", outputCursor: 1 });
    const item = listed.find((entry) => url.pathname.endsWith(entry.id));
    return response({ ...item, buffer: `${item.name} saved line\r\n`, outputCursor: 0 });
  };
  const onError = (error) => errors.push(error);
  const sendRuntime = (message) => sent.push(message);
  const show = (version = 0) => root.render(<div className="fixture-terminal-frame" style={{ width: 360, height: 420 }}><TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={null}
    terminalsVersion={version} onError={onError} sendRuntime={sendRuntime} /></div>);
  show();
  await until(() => terminalReady("ServerSaved"), "newest saved session selected without starting a shell");
  const bar = () => host.querySelector('.terminal-saved-bar');
  assert(bar()?.textContent.includes("Saved output, read-only: ended when Outright restarted."), "Restart-ended session lacks its saved label");
  assert(host.querySelector('#terminal-tab-term-S').getAttribute("aria-label") === "Server, saved output, ended when Outright restarted", "Saved tab label is not truthful");
  assert(terminalStatusText().includes("Server saved output, ended when Outright restarted. Read-only."), "Saved session was not announced");
  assert(posts.length === 0, "A saved session auto-started a shell");
  const input = host.querySelector('.terminal-host .xterm-helper-textarea');
  input.focus();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "x", code: "KeyX", keyCode: 88, which: 88, bubbles: true, cancelable: true }));
  host.querySelector('.terminal-host').style.width = "300px";
  await settle();
  assert(!sent.some((message) => message.type === "terminal.input" || message.type === "terminal.resize"), "Saved output accepted input or resize");

  host.querySelector('#terminal-tab-term-E').click();
  await until(() => terminalReady("BuildSaved"), "exit-ended saved session selected");
  assert(bar()?.textContent.includes("process exited 7"), "Exit-ended session lacks its exit status");
  assert(!sent.length, "Selecting saved output sent a terminal command");
  host.querySelector('#terminal-tab-term-S').click();
  await until(() => terminalReady("ServerSaved"), "restart-ended session reselected");

  const startButton = () => [...host.querySelectorAll('.terminal-saved-bar button')].find((button) => button.textContent === "Start new shell");
  startButton().focus();
  startButton().click();
  await until(() => errors.length === 1, "failed relaunch reported");
  await until(() => host.querySelector('.terminal-tabs[aria-busy="false"]'), "failed relaunch settles");
  assert(document.activeElement === startButton(), "A failed relaunch dropped focus from Start new shell");
  assert(posts[0].relaunchedFrom === "term-S" && posts[0].cwd === "/fixture/A", "Relaunch did not name its saved session and worktree");

  failPost = false;
  startButton().click();
  await until(() => terminalReady("ServerNew shell"), "new shell selected after relaunch");
  assert(posts.length === 2 && posts[1].relaunchedFrom === "term-S", "Relaunch POST lacked its source");
  assert(document.activeElement === host.querySelector('#terminal-tab-term-N'), "Focus did not move to the new shell's tab");
  assert(host.querySelector('#terminal-tab-term-N').getAttribute("aria-label") === "Server, new shell", "New shell tab is not labelled as new");
  assert(host.querySelector('#terminal-tab-term-S')?.getAttribute("aria-label").includes("saved output"), "Relaunch replaced the saved session tab");
  assert(!bar(), "The saved bar remained over a running shell");
  // xterm parses and paints its writes after the tab settles; nothing later
  // may reset the view while the new shell stays selected.
  const markerShown = () => host.querySelector('.terminal-host').textContent.includes("new shell started; the saved session was not resumed");
  await until(markerShown, "new shell marker rendered");
  await until(() => terminalStatusText().includes("Server new shell started; the saved session was not resumed"), "new shell announcement");
  const listingsBeforeSync = listings;
  show(1);
  await until(() => listings > listingsBeforeSync && host.querySelector('.terminal-tabs[aria-busy="false"]'), "listing sync after relaunch");
  await remainsTrue(() => markerShown() && terminalReady("ServerNew shell"), 150, "A listing sync erased the new shell marker");

  const dismiss = host.querySelector('[aria-label="Dismiss saved terminal Build"]');
  assert(dismiss && !dismiss.disabled, "Saved session cannot be dismissed");
  dismiss.click();
  await until(() => !host.querySelector('#terminal-tab-term-E') && host.querySelector('.terminal-tabs[aria-busy="false"]'), "dismissed saved tab removed");
  assert(deletes.length === 1 && deletes[0] === "/api/terminals/term-E", "Dismiss did not delete its saved session");
  assert(errors.length === 1, `Unexpected terminal errors: ${errors.map((error) => error.message).join("; ")}`);
}

async function terminalReservationRestoredRegression() {
  root.render(null);
  await settle();
  const reservation = { id: "term-R", name: "Terminal recovery required", cwd: "/fixture/A", pid: null, status: "unknown", createdAt: null, recoveryReservation: true };
  const restored = savedTerminal("term-R", "Server", "restart", null, "2026-10-21T01:00:00.000Z");
  const errors = [];
  let posts = 0;
  let current = reservation;
  let historyStatus = null;
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") { posts += 1; return response({ error: "unexpected" }, 500); }
    if (url.pathname === "/api/terminals") return response({ terminals: [current], history: historyStatus });
    if (options.method === "DELETE") return response({});
    return response({ ...current, buffer: "before restart\r\n", outputCursor: 0 });
  };
  const warning = "Terminal history is not saved because its storage directory is not private to this user. Terminal output stays in memory only.";
  let version = 0;
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event} terminalsVersion={version}
    onError={(error) => errors.push(error.message)} sendRuntime={() => {}} />);
  show();
  await until(() => terminalReady("Terminal recovery required"), "reservation listed before proof");
  assert(host.querySelector('[aria-label="Close terminal Terminal recovery required"]')?.disabled, "Reservation could be closed");
  const reservedBar = host.querySelector('.terminal-saved-bar')?.textContent ?? "";
  assert(reservedBar.includes("owner is unverified") && !reservedBar.includes("Start new shell") && !reservedBar.includes("ended"),
    "Reservation was shown as ended or relaunchable saved output");
  current = restored;
  version += 1;
  show({ type: "terminals.changed" });
  await until(() => terminalReady("ServerSaved"), "reservation replaced by saved session without a remount");
  const dismiss = host.querySelector('[aria-label="Dismiss saved terminal Server"]');
  assert(dismiss && !dismiss.disabled, "Restored session cannot be dismissed");
  assert([...host.querySelectorAll('.terminal-saved-bar button')].some((button) => button.textContent === "Start new shell"), "Restored session lacks Start new shell");
  assert(host.querySelector('.terminal-saved-bar')?.textContent.includes("ended when Outright restarted"), "Restored session lacks its label");
  assert(posts === 0, "Restoring a reservation started a shell");

  const connected = { type: "runtime.connected", payload: { restarted: true, terminals: [], history: { persistent: false, warning } } };
  show(connected);
  await until(() => errors.length === 1 && host.querySelector('.terminal-tabs[aria-busy="false"]'), "unsafe store announced on restart reconnect");
  assert(errors[0] === warning, "The unsafe store warning was not announced");
  assert(terminalReady("ServerSaved"), "A reconnect snapshot without saved sessions removed the saved tab");
  show({ ...connected, payload: { ...connected.payload, restarted: false } });
  show({ type: "terminal.history", payload: { persistent: false, warning } });
  await settle();
  assert(errors.length === 1, "The same storage warning was announced twice");
  // A write failure whose event was replaced in the shared slot still
  // reaches the pane through the change counter and its listing.
  historyStatus = { persistent: false, warning: "Terminal history could not be saved (ENOSPC). Terminal output stays in memory only." };
  version += 1;
  show({ type: "capacity.changed" });
  await until(() => errors.length === 2, "a later write failure announced to the mounted pane");
}

async function terminalSavedSessionSyncRegression() {
  root.render(null);
  await settle();
  const reserved = (id) => ({ id, name: "Terminal recovery required", cwd: "/fixture/A", pid: null, status: "unknown", createdAt: null, recoveryReservation: true });
  const errors = [];
  const deletes = [];
  let posts = 0;
  let listed = [reserved("term-A"), reserved("term-B"), reserved("term-C")];
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") {
      posts += 1;
      return response({ id: "term-N", name: "A", cwd: "/fixture/A", pid: 4100, status: "running", createdAt: "2026-10-21T02:00:00.000Z" }, 201);
    }
    if (url.pathname === "/api/terminals") return response({ terminals: listed, history: { persistent: true, warning: null } });
    const item = listed.find((entry) => url.pathname.endsWith(entry.id));
    if (options.method === "DELETE") { deletes.push(url.pathname); return item ? response({}) : response({ error: "Terminal not found" }, 404); }
    if (item) return response({ ...item, buffer: `${item.name} line\r\n`, outputCursor: 0 });
    return response({ id: "term-N", status: "running", buffer: "$ ", outputCursor: 1 });
  };
  let version = 0;
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event} terminalsVersion={version}
    onError={(error) => errors.push(error.message)} sendRuntime={() => {}} />);
  show();
  await until(() => terminalReady("Terminal recovery required") && host.querySelectorAll('.terminal-tab').length === 3, "three reservations listed");

  // Proof resolves every reservation; capacity.changed replaces the change
  // event in the same tick, and the counter still carries it.
  listed = [savedTerminal("term-A", "Server", "restart", null, "2026-10-21T01:00:00.000Z"),
    savedTerminal("term-B", "Build", "exit", 3, "2026-10-21T00:30:00.000Z"),
    savedTerminal("term-C", "Logs", "exit", 0, "2026-10-21T00:10:00.000Z")];
  version += 1;
  show({ type: "terminals.changed" });
  show({ type: "capacity.changed" });
  await until(() => terminalReady("ServerSaved"), "selected reservation becomes saved output");
  for (const name of ["Server", "Build", "Logs"]) {
    const dismiss = host.querySelector(`[aria-label="Dismiss saved terminal ${name}"]`);
    assert(dismiss && !dismiss.disabled, `${name} was left as a reservation that cannot be dismissed`);
  }
  assert(host.querySelector('.terminal-saved-bar')?.textContent.includes("ended when Outright restarted"), "Restored session lacks its label");

  // Quota eviction of a session that is not selected removes its tab.
  listed = listed.filter((item) => item.id !== "term-C");
  version += 1;
  show({ type: "terminals.changed" });
  await until(() => !host.querySelector('#terminal-tab-term-C'), "evicted saved tab removed");
  assert(terminalReady("ServerSaved"), "Eviction of another tab changed the selection");

  // Dismissing a session retention already expired removes the tab quietly.
  listed = listed.filter((item) => item.id !== "term-B");
  host.querySelector('[aria-label="Dismiss saved terminal Build"]').click();
  await until(() => !host.querySelector('#terminal-tab-term-B') && host.querySelector('.terminal-tabs[aria-busy="false"]'), "expired saved tab dismissed");
  assert(deletes.at(-1) === "/api/terminals/term-B", "Dismiss did not reach the server");

  // The selected session expires too: its view leaves with it.
  listed = [];
  version += 1;
  show({ type: "terminals.changed" });
  await until(() => !host.querySelector('#terminal-tab-term-A') && terminalReady("A"), "expired selected session replaced");
  assert(!host.querySelector('.terminal-saved-bar'), "Saved bar remained for an expired session");
  assert(posts === 1, `Expected one replacement shell, saw ${posts}`);
  assert(errors.length === 0, `Unexpected terminal errors: ${errors.join("; ")}`);
}

// The server stops holding an exited terminal once its retention ends or
// capacity needs the slot, and lists it as saved output. The open pane
// follows that listing in place, with no re-selection or new shell.
async function terminalExitedBecomesSavedRegression() {
  root.render(null);
  await settle();
  const errors = [];
  let posts = 0;
  let listed = [{ ...terminal("A"), name: "Build" }];
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") { posts += 1; return response({ error: "unexpected" }, 500); }
    if (url.pathname === "/api/terminals") return response({ terminals: listed, history: { persistent: true, warning: null } });
    const [item] = listed;
    return item.status === "ended"
      ? response({ ...item, buffer: "earliest saved line\r\nlive tail line\r\n", outputCursor: 0 })
      : response({ ...item, buffer: "live tail line\r\n", outputCursor: 1 });
  };
  let version = 0;
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event} terminalsVersion={version}
    onError={(error) => errors.push(error.message)} sendRuntime={() => {}} />);
  const tab = () => host.querySelector('#terminal-tab-term-A');
  const bar = () => host.querySelector('.terminal-saved-bar');
  show();
  await until(() => terminalReady("Build"), "running terminal selected");
  show({ type: "terminal.exit", terminalId: "term-A", payload: { exitCode: 3 } });
  await until(() => tab()?.getAttribute("aria-label").includes("process exited 3"), "live exit shown");
  assert(!bar(), "An exited live terminal was shown as saved before the server listed it so");

  listed = [savedTerminal("term-A", "Build", "exit", 3, "2026-10-21T00:00:00.000Z")];
  version += 1;
  show({ type: "terminals.changed" });
  await until(() => terminalReady("BuildSaved") && bar(), "exited terminal follows the listing to saved output");
  assert(bar().textContent.includes("Saved output, read-only: process exited 3."), "Saved bar lacks the exit label");
  assert([...bar().querySelectorAll('button')].some((button) => button.textContent === "Start new shell"), "Saved output lacks Start new shell");
  await until(() => host.querySelector('.terminal-host .xterm-rows')?.textContent.includes("earliest saved line"), "saved output beyond the live tail shown");
  assert(tab().getAttribute("aria-selected") === "true" && host.querySelectorAll('.terminal-tab').length === 1, "The selection changed");
  assert(posts === 0, "Saved output started a shell");
  assert(errors.length === 0, `Unexpected terminal errors: ${errors.join("; ")}`);
}

async function terminalListingAddsSessionsRegression() {
  root.render(null);
  await settle();
  const live = (id, name) => ({ id, name, cwd: "/fixture/A", pid: 4100, status: "running", createdAt: "2026-10-21T00:00:00.000Z" });
  const errors = [];
  const details = [];
  let posts = 0;
  let listed = [live("term-A", "Shell")];
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") { posts += 1; return response({ error: "unexpected" }, 500); }
    if (url.pathname === "/api/terminals") return response({ terminals: listed, history: { persistent: true, warning: null } });
    details.push(url.pathname);
    const item = listed.find((entry) => url.pathname.endsWith(entry.id));
    return response({ ...item, buffer: "$ ", outputCursor: 1 });
  };
  let version = 0;
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event} terminalsVersion={version}
    onError={(error) => errors.push(error.message)} sendRuntime={() => {}} />);
  show();
  await until(() => terminalReady("Shell"), "first terminal selected");
  // Another window starts a shell in this worktree.
  listed = [...listed, live("term-B", "Other")];
  version += 1;
  show({ type: "terminals.changed" });
  await until(() => host.querySelector('#terminal-tab-term-B'), "a newly listed terminal joins the tabs");
  // The audit scan finds a prior-run owner awaiting proof.
  listed = [...listed, { id: "term-C", name: "Terminal recovery required", cwd: "/fixture/A", pid: null, status: "unknown", createdAt: null, recoveryReservation: true }];
  version += 1;
  show({ type: "terminals.changed" });
  await until(() => host.querySelector('#terminal-tab-term-C'), "a late recovery reservation joins the tabs");
  assert(host.querySelector('[aria-label="Close terminal Terminal recovery required"]')?.disabled, "The reservation could be closed");
  assert(terminalReady("Shell"), "New sessions changed the selection");
  assert(details.length === 1 && posts === 0, `The pane remounted or relaunched: ${details.length} reads, ${posts} creates`);
  assert(errors.length === 0, `Unexpected terminal errors: ${errors.join("; ")}`);
}

// A reservation still awaiting ownership proof pages the same saved output
// read-only, with no relaunch, dismissal or input.
async function terminalSavedPagingRegression(reservation = false) {
  root.render(null);
  await settle();
  const lines = Array.from({ length: 15_000 }, (_, index) => `saved line ${index}\r\n`);
  lines[0] = "FIRST saved line\r\n";
  // A full-screen program ended by a full reset: the output before and after
  // it stays readable, the program's screen does not.
  // The reset also ends a line-drawing character set.
  lines[1] = "BEFORE reset line\x1b(0\x1b[?1049hFULLSCREEN\x1bcAFTER reset line\r\n";
  // A rendition set on the first page and never reset is in effect on every later page.
  lines[2] = "\x1b[31mRED saved line\r\n";
  // Line drawing ended by DECANM, or restored with the cursor, stays ended on every later page.
  lines[3] = "\x1b(0\x1b[?2hDECANM ended line drawing\r\n";
  lines[4] = "\x1b7\x1b(0\x1b8RESTORED cursor ended line drawing\r\n";
  // The saved label reads as plain text after output that left modes on.
  lines[lines.length - 1] = "LAST saved line\r\n\x1b(0\x1b[4h";
  const saved = reservation
    ? { id: "term-L", name: "Terminal recovery required", cwd: "/fixture/A", pid: 4242, status: "unknown", createdAt: null, recoveryReservation: true }
    : savedTerminal("term-L", "Long", "exit", 0, "2026-10-21T01:00:00.000Z");
  const sent = [];
  const errors = [];
  let details = 0;
  route = async (url) => {
    if (url.pathname === "/api/terminals") return response({ terminals: [saved], history: { persistent: true, warning: null } });
    details += 1;
    return response({ ...saved, buffer: lines.join(""), outputCursor: 0 });
  };
  root.render(<div className="fixture-terminal-frame" style={{ width: 360, height: 420 }}><TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={null}
    onError={(error) => errors.push(error)} sendRuntime={(message) => sent.push(message)} /></div>);
  await until(() => terminalReady(reservation ? saved.name : "LongSaved"), "long saved session selected");
  const output = () => host.querySelector('.terminal-host').textContent;
  const topRow = () => host.querySelector('.terminal-host .xterm-rows')?.firstElementChild;
  const control = (name) => [...host.querySelectorAll('.terminal-saved-bar button')].find((button) => button.textContent === name);
  const part = () => /Part (\d+) of (\d+)/.exec(host.querySelector('.terminal-saved-bar')?.textContent ?? "");
  await until(() => output().includes("LAST saved line"), "newest saved output shown");
  assert(output().includes("[saved output; "), "The saved label was drawn in the modes saved output left on");
  assert(part() && part()[1] === part()[2] && Number(part()[2]) > 1, "Long saved output is not paged");
  assert(control("Later output").getAttribute("aria-disabled") === "true", "The newest page offers later output");
  if (reservation) {
    assert(!control("Start new shell") && host.querySelector('.terminal-tab-close').disabled, "A recovery reservation offered relaunch or dismissal");
    assert(host.querySelector('[role="tab"][aria-selected="true"]').getAttribute("aria-label").includes("ownership unverified"), "A reservation was labelled running or ended");
  }
  for (let step = 0; step < 100 && control("Earlier output").getAttribute("aria-disabled") !== "true"; step += 1) {
    control("Earlier output").click();
    await settle();
  }
  assert(part()?.[1] === "1", "Paging did not reach the earliest saved output");
  await until(() => topRow()?.textContent.startsWith("FIRST saved line"), "earliest saved line shown");
  const shownRows = host.querySelector('.terminal-host .xterm-rows').textContent;
  assert(shownRows.includes("BEFORE reset line") && shownRows.includes("AFTER reset line") && !shownRows.includes("FULLSCREEN"),
    "A full reset after a full-screen program hid or erased saved output");
  assert(shownRows.includes("DECANM ended line drawing") && shownRows.includes("RESTORED cursor ended line drawing"), "Saved output drew ASCII as line drawing");
  assert(terminalStatusText().includes("part 1 of") && terminalStatusText().includes("the earliest"), "The earliest page was not announced");
  // Pages requested before the previous one is written replace it whole.
  flushSync(() => control("Later output").click());
  flushSync(() => control("Earlier output").click());
  await settle();
  await until(() => part()?.[1] === "1" && topRow()?.textContent.startsWith("FIRST saved line"), "earliest page alone after Later then Earlier");
  control("Later output").click();
  await settle();
  flushSync(() => control("Earlier output").click());
  flushSync(() => control("Later output").click());
  await settle();
  await until(() => part()?.[1] === "2" && /^saved line \d+/.test(topRow()?.textContent ?? ""), "second page alone after Earlier then Later");
  assert(topRow().querySelector("span")?.classList.contains("xterm-fg-1"), "The rendition set on an earlier page was lost at the next page start");
  assert(details === 1, `Paging re-read the session ${details} times`);
  assert(!sent.length && !errors.length, "Paging saved output sent a command or failed");
}

// Saved output reads in the view as the terminal showed it. The oracle is
// xterm itself: one continuous render, each full reset starting a fresh
// terminal below the rows before it. The view's pages, each written alone
// after a full reset, show the same glyphs, colours and wraps.
async function terminalSavedModesRegression() {
  const size = { cols: 80, rows: 24 };
  const drawnRows = (xterm, count = -1) => {
    const normal = xterm.buffer.normal;
    const cell = normal.getNullCell();
    const rows = [];
    for (let y = 0; y < normal.length; y += 1) {
      const line = normal.getLine(y);
      let text = line.isWrapped ? "~" : "";
      let kept = text.length;
      for (let x = 0; x < size.cols; x += 1) {
        line.getCell(x, cell);
        if (cell.getWidth() === 0) continue;
        const chars = cell.getChars() || " ";
        text += cell.isAttributeDefault() ? chars : `${chars}{${[cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(), cell.isBold(), cell.isInverse()].join()}}`;
        if (chars !== " " || !cell.isAttributeDefault()) kept = text.length;
      }
      rows.push(text.slice(0, kept));
    }
    if (count >= 0) return rows.slice(0, count);
    let end = rows.length;
    while (end > normal.baseY && !rows[end - 1].replace("~", "")) end -= 1;
    return rows.slice(0, end);
  };
  // Each write's rows are read in its callback, before the next one.
  const render = async (writes, options, rowCounts = []) => {
    const xterm = new Terminal({ ...size, convertEol: true, ...options });
    let rows = [];
    await new Promise((resolve) => writes.forEach((data, index) => xterm.write(data, () => {
      rows = rows.concat(drawnRows(xterm, rowCounts[index] ?? -1));
      if (index === writes.length - 1) resolve();
    })));
    xterm.dispose();
    return rows;
  };
  const continuous = (segments) => render(segments.map((segment, index) => `${index ? "\x1bc" : ""}${segment}`), { scrollback: 100_000, scrollOnEraseInDisplay: true });
  // The pane's saved view: one terminal, a full reset before each page.
  const view = async (buffer, pageRows) => {
    const { rows } = await savedOutputRows(buffer, size, Terminal);
    const pages = savedRowPages(rows, pageRows);
    return render(pages.map((page) => `\x1bc${savedPageText(rows, page)}`), { scrollback: 10_000 }, pages.map(([start, end]) => end - start));
  };
  const same = (actual, expected, label) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${label}: ${JSON.stringify(actual.slice(0, 3))} ... differs from ${JSON.stringify(expected.slice(0, 3))} ...`);
  // Short lines and lines that wrap once.
  const lines = (name, count) => Array.from({ length: count }, (_, index) => `${name} ${String(index).padStart(3, "0")} line${index % 2 ? "" : ` ${"=".repeat(80)}`}\r\n`).join("");
  const state = {
    "DECANM": "\x1b(0\x1b[?2h", "DECSC character set": "\x1b7\x1b(0\x1b8", "DECSC rendition": "\x1b7\x1b[31;44m\x1b8", "SCOSC rendition": "\x1b[s\x1b[32m\x1b[u",
    "1048 character set": "\x1b[?1048h\x1b(0\x1b[?1048l", "cursor restored on a later row": `\x1b7${lines("between", 30)}\x1b8OVER`,
  };
  for (const [name, sequence] of Object.entries(state)) {
    const buffer = `${sequence}${lines("after", 40)}`;
    for (const pageRows of [2_000, 7]) same(await view(buffer, pageRows), await continuous([buffer]), `${name} in pages of ${pageRows}`);
  }
  const modes = { margins: "\x1b[5;20r", origin: "\x1b[?6h", insert: "\x1b[4h", nowrap: "\x1b[?7l", "line drawing": "\x1b(0", "shift out": "\x1b)0\x0e", "locking shift": "\x1b*0\x1bn" };
  for (const [name, mode] of Object.entries(modes)) {
    // A mode on before a full reset ends there; one on through the output
    // stays on where every page opens.
    const pre = `${lines("pre", 30)}${mode}`;
    const shown = await view(`${pre}\x1bc${lines("post", 60)}`, 13);
    same(shown, await continuous([pre, lines("post", 60)]), `${name} before a reset`);
    const post = shown.filter((text) => text.startsWith("post "));
    assert(post.length === 60 && post.every((text, index) => text === `post ${String(index).padStart(3, "0")} line${index % 2 ? "" : ` ${"=".repeat(80)}`}`.slice(0, 80)),
      `${name} before a reset hid or redrew later saved lines`);
    const opened = `${mode}${lines("mid", 40)}`;
    same(await view(opened, 9), await continuous([opened]), `${name} on through the output`);
  }
}

// Saved output whose escapes expand far past the row budget activates within
// bounds and keeps the page responsive. Its newest rows are shown, and its
// earliest page says, and announces, that older output was left out. A
// worktree switch stops a parse in progress.
async function terminalSavedBudgetRegression() {
  root.render(null);
  await settle();
  const huge = savedTerminal("term-H", "Huge", "exit", 0, "2026-10-21T01:00:00.000Z");
  const other = { ...savedTerminal("term-B", "Other", "exit", 0, "2026-10-21T01:00:00.000Z"), cwd: "/fixture/B" };
  // About 2 MiB that erases a red screen 123,000 times: millions of rows.
  const erased = `${"\x1b[41m\x1b[24;1Hx\x1b[2J".repeat(Math.floor(2 ** 21 / 17))}\x1b[0mNEWEST saved line\r\n`;
  // About 2 MiB of scrolls and repeats with counts of 2^31 - 1.
  const dense = `${`x\x1b[${2 ** 31 - 1}S`.repeat(2 ** 16)}${`a\x1b[${2 ** 31 - 1};1b`.repeat(2 ** 16)}\r\nNEWEST dense line\r\n`;
  let saved = erased;
  const errors = [];
  route = async (url) => {
    if (url.pathname === "/api/terminals") return response({ terminals: [huge, other], history: { persistent: true, warning: null } });
    if (url.pathname.endsWith(huge.id)) return response({ ...huge, buffer: saved, outputCursor: 0 });
    return response({ ...other, buffer: "other saved line\r\n", outputCursor: 0 });
  };
  // Writes of the huge output to the offscreen terminal that parses it.
  let parsed = 0;
  let finished = false;
  const write = Terminal.prototype.write;
  Terminal.prototype.write = function recordWrite(data, callback) {
    if (!this.element && data.includes("\x1b[2J")) parsed += 1;
    if (!this.element && data.includes("NEWEST saved line")) finished = true;
    return write.call(this, data, callback);
  };
  const show = (worktree) => root.render(<div className="fixture-terminal-frame" style={{ width: 360, height: 420 }}><TerminalPane worktree={worktree}
    runtimeEvent={null} onError={(error) => errors.push(error)} sendRuntime={() => {}} /></div>);
  // Activates the huge session and returns how long that took and the longest
  // a 10 ms timer waited meanwhile.
  const activate = async () => {
    let last = performance.now();
    let longest = 0;
    const ticker = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 10);
    const started = performance.now();
    show(projects[0].worktrees[0]);
    try { await longWait(() => terminalReady("HugeSaved"), "huge saved session selected"); }
    finally { clearInterval(ticker); }
    return { elapsedMs: Math.round(performance.now() - started), longestTimerGapMs: Math.round(longest) };
  };
  const longWait = async (check, label) => {
    const deadline = performance.now() + 20_000;
    while (!check()) {
      assert(performance.now() < deadline, `Timed out: ${label}`);
      await frame();
    }
  };
  try {
    show(projects[0].worktrees[0]);
    await until(() => parsed > 0, "huge saved output parsing");
    show(projects[1].worktrees[0]);
    await until(() => terminalReady("OtherSaved"), "other worktree's saved session selected");
    const stoppedAt = parsed;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert(parsed === stoppedAt && !finished, `A superseded parse went on: ${parsed} writes`);

    const timing = await activate();
    assert(timing.longestTimerGapMs < 1_000, `Activation blocked the page for ${timing.longestTimerGapMs} ms`);
    const output = () => host.querySelector('.terminal-host .xterm-rows')?.textContent ?? "";
    const part = () => /Part (\d+) of (\d+)/.exec(host.querySelector('.terminal-saved-bar')?.textContent ?? "");
    await until(() => output().includes("NEWEST saved line"), "newest saved output shown");
    assert(part() && Number(part()[2]) <= 10, `The kept rows exceed the row budget: ${part()?.[0]}`);
    assert(terminalStatusText().includes("Earlier saved output not shown."), "Leaving out older output was not announced");
    const earlier = () => [...host.querySelectorAll('.terminal-saved-bar button')].find((button) => button.textContent === "Earlier output");
    for (let step = 0; step < 20 && earlier().getAttribute("aria-disabled") !== "true"; step += 1) {
      earlier().click();
      await settle();
    }
    await until(() => output().includes("[earlier saved output not shown]"), "earliest kept page discloses the left-out output");
    assert(terminalStatusText().includes("part 1 of") && terminalStatusText().includes("earlier saved output not shown"), "The earliest kept page did not announce the left-out output");
    // Counts of any size cost at most a screen of work each.
    show(projects[1].worktrees[0]);
    await until(() => terminalReady("OtherSaved"), "other worktree's saved session selected again");
    saved = dense;
    const denseTiming = await activate();
    window.__performanceEvidence = { ...window.__performanceEvidence, savedOutput: { bytes: erased.length, ...timing, dense: { bytes: dense.length, ...denseTiming } } };
    assert(denseTiming.elapsedMs < 10_000 && denseTiming.longestTimerGapMs < 250, `Dense counts took ${denseTiming.elapsedMs} ms and blocked the page for ${denseTiming.longestTimerGapMs} ms`);
    await until(() => output().includes("NEWEST dense line"), "newest dense saved output shown");
    assert(!errors.length, `Saved output failed: ${errors.map((error) => error.message).join("; ")}`);
  } finally {
    Terminal.prototype.write = write;
  }
}

// A storage status change delivered in the same task as terminal output or
// an exit reaches the pane through its counter; it never replaces that
// output or exit in App's shared event slot.
async function terminalHistoryEventSlotRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const shell = { id: "term-S", name: "Shell", cwd: "/fixture/A", pid: 4500, status: "running", createdAt: "2026-10-21T00:00:00.000Z" };
  let history = { persistent: true, warning: null };
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    if (url.pathname === "/api/git/status") return response({ branch: "main", files: [], stagedCount: 0 });
    if (url.pathname === "/api/context") return response({ instructionFiles: [], skills: [], pullRequest: null });
    if (url.pathname === "/api/terminals") return response({ terminals: [shell], history });
    if (url.pathname === "/api/terminals/term-S") return response({ ...shell, buffer: "$ ", outputCursor: 1 });
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('[aria-label="Terminal"]'), "workspace");
  host.querySelector('[aria-label="Terminal"]').click();
  await until(() => terminalReady("Shell"), "live terminal ready");
  const deliver = (...events) => {
    for (const event of events) fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  };
  history = { persistent: false, warning: "Terminal history could not be saved (EIO). Terminal output stays in memory only." };
  deliver({ type: "terminal.output", terminalId: "term-S", payload: { data: "OUTPUT BEFORE STORAGE FAILURE\r\n", cursor: 2 } }, { type: "terminal.history", payload: history });
  await until(() => host.querySelector(".terminal-host .xterm-rows")?.textContent.includes("OUTPUT BEFORE STORAGE FAILURE"), "output delivered with a storage status change is written");
  await until(() => host.querySelector(".error-toast")?.textContent.includes("EIO"), "storage failure announced");
  deliver({ type: "terminal.exit", terminalId: "term-S", payload: { exitCode: 3 } }, { type: "terminal.history", payload: history });
  await until(() => host.querySelector("#terminal-tab-term-S")?.getAttribute("aria-label")?.includes("process exited 3"), "exit delivered with a storage status change is shown");
  await until(() => host.querySelector(".terminal-host .xterm-rows").textContent.includes("[process exited 3]"), "exit written to the terminal");
}

async function terminalCloseHistoryFailureRegression() {
  root.render(null);
  await settle();
  const sent = [];
  const errors = [];
  const failure = "Saved terminal output could not be deleted; check storage and dismiss it again";
  let listed = [{ id: "term-L", name: "Shell", cwd: "/fixture/A", pid: 4200, status: "running", createdAt: "2026-10-21T00:00:00.000Z" }];
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") return response({ error: "unexpected" }, 500);
    if (url.pathname === "/api/terminals") return response({ terminals: listed, history: { persistent: false, warning: null } });
    if (options.method === "DELETE") {
      // The process is gone; only its saved output could not be removed.
      listed = [savedTerminal("term-L", "Shell", "closed", null, "2026-10-21T01:00:00.000Z")];
      return response({ error: failure }, 503);
    }
    return response({ ...listed[0], buffer: "$ ", outputCursor: 1 });
  };
  root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={null}
    onError={(error) => errors.push(error.message)} sendRuntime={(message) => sent.push(message)} />);
  await until(() => terminalReady("Shell") && sent.some((message) => message.type === "terminal.resize"), "live terminal ready");
  const before = sent.length;
  host.querySelector('[aria-label="Close terminal Shell"]').click();
  await until(() => terminalReady("ShellSaved"), "failed close re-lists the ended session");
  assert(errors.length === 1 && errors[0] === failure, `Close failure was not reported once: ${errors.join("; ")}`);
  assert(host.querySelector('.terminal-saved-bar')?.textContent.includes("closed; its saved output could not be deleted"), "Closed session lacks its label");
  const dismiss = host.querySelector('[aria-label="Dismiss saved terminal Shell"]');
  assert(dismiss && !dismiss.disabled, "Closed session cannot be dismissed again");
  const input = host.querySelector('.terminal-host .xterm-helper-textarea');
  input.focus();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "x", code: "KeyX", keyCode: 88, which: 88, bubbles: true, cancelable: true }));
  host.querySelector('.terminal-host').style.width = "320px";
  await settle();
  assert(!sent.slice(before).some((message) => message.type === "terminal.input" || message.type === "terminal.resize"),
    "A closed session accepted input or resize after the failed close");
}

async function terminalFencedSavedSessionRegression() {
  root.render(null);
  await settle();
  const sent = [];
  let listed = [{ id: "term-F", name: "Server", cwd: "/fixture/A", pid: 4300, status: "running", createdAt: "2026-10-21T00:00:00.000Z" }];
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") return response({ error: "unexpected" }, 500);
    if (url.pathname === "/api/terminals") return response({ terminals: listed, history: { persistent: true, warning: null } });
    return response({ ...listed[0], buffer: "server output\r\n", outputCursor: 1 });
  };
  const show = (event = null, fenced = new Set()) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event}
    unverifiedTerminalIds={fenced} onError={(error) => { throw error; }} sendRuntime={(message) => sent.push(message)} />);
  show();
  await until(() => terminalReady("Server"), "live terminal ready");
  const fence = new Set(["term-F"]);
  show({ type: "terminal.audit-failed", terminalId: "term-F" }, fence);
  await until(() => host.querySelector('#terminal-tab-term-F')?.getAttribute("aria-label").includes("ownership unverified"), "audit failure fences the terminal");
  const before = sent.length;
  // Outright restarts; native proof shows the owner is gone.
  listed = [savedTerminal("term-F", "Server", "restart", null, "2026-10-21T01:00:00.000Z")];
  show({ type: "runtime.connected", payload: { restarted: true, terminals: listed } }, fence);
  await until(() => terminalReady("ServerSaved"), "the server's saved status wins over the page fence");
  assert(host.querySelector('#terminal-tab-term-F').getAttribute("aria-label") === "Server, saved output, ended when Outright restarted", "Fenced saved tab label is not truthful");
  assert(host.querySelector('.terminal-saved-bar')?.textContent.includes("ended when Outright restarted"), "Fenced saved session lacks its label");
  assert([...host.querySelectorAll('.terminal-saved-bar button')].some((button) => button.textContent === "Start new shell"), "Fenced saved session lacks Start new shell");
  const input = host.querySelector('.terminal-host .xterm-helper-textarea');
  input.focus();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "x", code: "KeyX", keyCode: 88, which: 88, bubbles: true, cancelable: true }));
  host.querySelector('.terminal-host').style.width = "330px";
  await settle();
  assert(!sent.slice(before).some((message) => message.type === "terminal.input" || message.type === "terminal.resize"),
    "A fenced saved session sent input or resize");
}

// A pane wired like App for one terminal: every runtime event reaches the
// command fence, listings change by version, and only the pane's own event
// types are handed to it. The server lists what listed() returns.
async function reattachFencePane(terminalId, key, listed) {
  root.render(null);
  await settle();
  const sent = [];
  const fence = createTerminalCommandFence();
  let version = 0;
  let paneEvent = null;
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") return response({ error: "unexpected" }, 500);
    if (url.pathname === "/api/terminals") return response({ terminals: listed(), history: { persistent: true, warning: null } });
    return response({ ...listed()[0], buffer: "kept running\r\n", outputCursor: 1 });
  };
  const show = (event) => {
    fence.observe(event);
    if (["terminals.changed", "terminal.history"].includes(event.type)) version += 1;
    if (["terminal.audit-failed", "runtime.connected", "capacity.changed"].includes(event.type)) paneEvent = event;
    root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={paneEvent} terminalsVersion={version}
      unverifiedTerminalIds={fence.snapshot()} onError={(error) => { throw error; }}
      sendRuntime={(message) => { if (fence.allows(message)) sent.push(message); }} />);
  };
  const tabLabel = () => host.querySelector(`#terminal-tab-${terminalId}`)?.getAttribute("aria-label") ?? "";
  // Types one key and widens the view. A fenced pane sends neither command.
  // An open one sends its input at once and its resize when the observer,
  // or the fit after a reload still in progress, delivers it.
  const typeAndResize = async (width, { open }) => {
    const before = sent.length;
    const commands = () => sent.slice(before).filter((message) => message.terminalId === terminalId).map((message) => message.type);
    const input = host.querySelector('.terminal-host .xterm-helper-textarea');
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().codePointAt(0),
      which: key.toUpperCase().codePointAt(0), bubbles: true, cancelable: true }));
    host.querySelector('.terminal-host').style.width = width;
    if (open) await until(() => commands().includes("terminal.input") && commands().includes("terminal.resize"), "reattached input and resize").catch(() => {});
    else await settle();
    return commands();
  };
  const assertOpen = async (width) => {
    const commands = await typeAndResize(width, { open: true });
    assert(commands.includes("terminal.input") && commands.includes("terminal.resize"), `Reattached terminal dropped input or resize: ${commands}`);
  };
  // Runtime A shows the live terminal, then reports its audit failure.
  const fenceInRuntimeA = async (name, payload) => {
    show({ type: "runtime.connected", payload: { runtimeInstanceId: "runtime-A", terminals: listed(), replay: { requestedAfter: 0 } } });
    await until(() => terminalReady(name), "live terminal ready");
    show({ type: "terminal.audit-failed", terminalId, ...(payload ? { payload } : {}) });
    await until(() => tabLabel().includes("ownership unverified"), "audit failure fences the terminal");
  };
  // Runtime B connects while it still proves the prior-run owner.
  const connectReservedInRuntimeB = async () => {
    show({ type: "runtime.connected", payload: { runtimeInstanceId: "runtime-B", restarted: true, terminals: listed(), replay: { requestedAfter: 5, missed: true } } });
    await settle();
    await until(() => host.querySelector('.terminal-tabs[aria-busy="false"]') && tabLabel().includes("ownership unverified"), "the reservation is shown");
  };
  return { fence, show, tabLabel, typeAndResize, assertOpen, fenceInRuntimeA, connectReservedInRuntimeB };
}

// The App fence is page state from the runtime that failed its audit. A
// later runtime that verifies a live reattach of the same terminal lifts it;
// a reconnect to the fencing runtime does not.
async function terminalReattachLiftsFenceRegression() {
  let listed = [{ id: "term-X", name: "Server", cwd: "/fixture/A", pid: 4400, status: "running", createdAt: "2026-10-21T00:00:00.000Z" }];
  const { fence, show, tabLabel, typeAndResize, assertOpen, fenceInRuntimeA } = await reattachFencePane("term-X", "x", () => listed);
  await fenceInRuntimeA("Server");

  // The same runtime reconnects; its listing cannot lift the page fence.
  listed = [{ ...listed[0], status: "running", reattached: true }];
  show({ type: "runtime.connected", payload: { runtimeInstanceId: "runtime-A", terminals: listed, replay: { requestedAfter: 5 } } });
  await until(() => host.querySelector('.terminal-tabs[aria-busy="false"]') && tabLabel().includes("ownership unverified"), "same-runtime reconnect settles");
  assert(fence.snapshot().has("term-X"), "A same-runtime reconnect lifted the fence");
  assert((await typeAndResize("520px", { open: false })).length === 0, "A same-runtime reconnect reopened input or resize");

  // Outright restarts inside the detach window and verifies a live reattach.
  show({ type: "runtime.connected", payload: { runtimeInstanceId: "runtime-B", restarted: true, terminals: listed, replay: { requestedAfter: 5, missed: true } } });
  await until(() => terminalReady("ServerReattached") && tabLabel() === "Server, live process reattached", "a verified reattach in a new runtime lifts the fence");
  assert(!fence.snapshot().has("term-X"), "The unverified set kept a verified reattached terminal");
  assert(terminalStatusText().includes("live process reattached"), "Reattached terminal lacks its spoken status");
  assert(!terminalStatusText().includes("ownership is unverified"), "Reattached terminal still announces unknown ownership");
  await assertOpen("560px");
}

// Recovery can verify the reattach after the page has connected to the new
// runtime, while the terminal is still listed as a reservation. Its
// terminal.reattached event lifts the fence without another reconnect.
async function terminalReattachAfterConnectRegression() {
  const base = { id: "term-Y", name: "Worker", cwd: "/fixture/A", pid: 4500, createdAt: "2026-10-21T00:00:00.000Z" };
  let listed = [{ ...base, status: "running" }];
  const { fence, show, tabLabel, assertOpen, fenceInRuntimeA, connectReservedInRuntimeB } = await reattachFencePane("term-Y", "y", () => listed);
  await fenceInRuntimeA("Worker", { runtimeInstanceId: "runtime-A" });

  // Runtime B is still proving the prior-run owner when the page connects.
  listed = [{ ...base, status: "unknown", recoveryReservation: true }];
  await connectReservedInRuntimeB();
  assert(fence.snapshot().has("term-Y"), "A reservation lifted the fence");

  // B verifies the reattach and publishes it, then the coalesced listing change.
  listed = [{ ...base, status: "running", reattached: true }];
  show({ type: "terminal.reattached", terminalId: "term-Y", payload: { ...listed[0], runtimeInstanceId: "runtime-B" } });
  show({ type: "terminals.changed" });
  show({ type: "capacity.changed" });
  await until(() => terminalReady("WorkerReattached") && tabLabel() === "Worker, live process reattached", "a reattach verified after connect lifts the fence");
  assert(!fence.snapshot().has("term-Y"), "The unverified set kept a verified reattached terminal");
  assert(terminalStatusText().includes("live process reattached"), "Reattached terminal lacks its spoken status");
  await assertOpen("540px");
}

// The new runtime's listing can already show the reattach while the page
// still holds the fence, so the pane stores the tab as unknown. When the
// fence lifts, the tab follows the server again without a reload.
async function terminalReattachListedBeforeReleaseRegression() {
  const base = { id: "term-Z", name: "Queue", cwd: "/fixture/A", pid: 4600, createdAt: "2026-10-21T00:00:00.000Z" };
  let listed = [{ ...base, status: "running" }];
  const { fence, show, tabLabel, typeAndResize, assertOpen, fenceInRuntimeA, connectReservedInRuntimeB } = await reattachFencePane("term-Z", "z", () => listed);
  await fenceInRuntimeA("Queue", { runtimeInstanceId: "runtime-A" });
  listed = [{ ...base, status: "unknown", recoveryReservation: true }];
  await connectReservedInRuntimeB();

  // B's listing and detail report the reattach before its event arrives.
  listed = [{ ...base, status: "running", reattached: true }];
  show({ type: "terminals.changed" });
  await settle();
  await until(() => terminalReady("Queue") && tabLabel() === "Queue, ownership unverified", "the reattach listed while fenced stays unverified");
  assert(fence.snapshot().has("term-Z"), "A listing lifted the fence");
  assert(!host.querySelector('.terminal-tab-badge'), "An unverified tab was badged as reattached");
  assert(!host.querySelector('.terminal-host')?.textContent.includes("live process reattached"), "An unverified tab was marked as the live process");

  // The fencing runtime's own event keeps the fence.
  show({ type: "terminal.reattached", terminalId: "term-Z", payload: { ...listed[0], runtimeInstanceId: "runtime-A" } });
  show({ type: "terminals.changed" });
  await settle();
  await until(() => terminalReady("Queue") && tabLabel() === "Queue, ownership unverified", "an A-attributed reattach settles");
  assert((await typeAndResize("500px", { open: false })).length === 0, "The fencing runtime's event reopened input or resize");

  // B's event alone lifts the fence; the tab is read again from the server.
  show({ type: "terminal.reattached", terminalId: "term-Z", payload: { ...listed[0], runtimeInstanceId: "runtime-B" } });
  await until(() => terminalReady("QueueReattached") && tabLabel() === "Queue, live process reattached", "a lifted fence restores the server's state");
  assert(terminalStatusText().includes("live process reattached"), "Reattached terminal lacks its spoken status");
  assert(!terminalStatusText().includes("ownership is unverified"), "Reattached terminal still announces unknown ownership");
  show({ type: "terminals.changed" });
  await settle();
  await assertOpen("540px");
}

async function terminalSelectionReconnectRegression() {
  root.render(null);
  await settle();
  const heldBuffer = deferred();
  let holdBuffer = true;
  let requests = 0;
  let lists = 0;
  const errors = [];
  const onError = (error) => errors.push(error);
  const sendRuntime = () => {};
  route = async (url) => {
    if (url.pathname === "/api/terminals") { lists += 1; return response({ terminals: [terminal("A"), terminal("A2")] }); }
    if (url.pathname === "/api/terminals/term-A2") {
      requests += 1;
      return holdBuffer ? heldBuffer.promise : response({ buffer: "A2 selected output\r\n", status: "running" });
    }
    return response({ buffer: "A original output\r\n", status: "running" });
  };
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event} onError={onError} sendRuntime={sendRuntime} />);
  show();
  await until(() => terminalReady("Terminal A"), "initial selection before reconnect");
  const next = host.querySelector('[data-tab-id="term-A2"]');
  next.focus();
  next.click();
  await until(() => requests === 1 && host.querySelector('.terminal-tabs[aria-busy="true"]'), "held selected tab buffer");
  show({ type: "runtime.connected", payload: { replay: { requestedAfter: 1 }, terminals: [terminal("A"), terminal("A2")] } });
  await settle();
  holdBuffer = false;
  heldBuffer.resolve(response({ buffer: "A2 selected output\r\n", status: "running" }));
  await until(() => terminalReady("Terminal A2"), "selected tab survives reconnect");
  await until(() => lists === 2 && requests === 2 && host.querySelector('.terminal-tabs[aria-busy="false"]'), "authoritative reconnect after selected tab");
  await until(() => host.querySelector('.xterm-rows')?.textContent.includes("A2 selected output"), "reconnected selected output");
  assert(document.activeElement === next, "Reconnect moved focus away from selected terminal tab");
  assert(errors.length === 0, "Reconnect during selection reported errors");
}

async function terminalActivationOwnershipRegression() {
  root.render(null);
  await settle();
  host.style.width = "";
  // Earlier full-suite layouts may leave the fixture root wider than the
  // terminal. Exercise a real narrow pane without assuming root width.
  host.style.minWidth = "1280px";
  const pending = deferred();
  let holdSecond = true;
  const sent = [];
  const sendRuntime = (message) => sent.push(message);
  const onError = (error) => { throw error; };
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") return response(terminal("A3"));
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A"), terminal("A2")] });
    if (options.method === "DELETE") return response({});
    if (url.pathname === "/api/terminals/term-A2" && holdSecond) return pending.promise;
    if (url.pathname === "/api/terminals/term-A2") return response({ buffer: "A2 refreshed\r\n", outputCursor: 2 });
    if (url.pathname === "/api/terminals/term-A3") return response({ buffer: "A3 ready\r\n", outputCursor: 0 });
    return response({ buffer: "Old A output\r\n", outputCursor: 0 });
  };
  let frameWidth = 320;
  const show = (event = null) => root.render(<div className="fixture-terminal-frame" style={{ width: frameWidth, height: "100%" }}>
    <TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event} onError={onError} sendRuntime={sendRuntime} />
  </div>);
  show();
  await until(() => terminalReady("Terminal A"), "ownership fixture initial terminal ready");
  const paneFrame = host.querySelector(".fixture-terminal-frame");
  await until(() => Math.abs(paneFrame.getBoundingClientRect().width - 320) < 2
    && Math.abs(host.querySelector(".terminal-host").getBoundingClientRect().width - 320) < 2,
  "actual narrow terminal baseline");
  assert(host.getBoundingClientRect().width > 1000, "fixture did not exercise a wide outer root");
  const initialSize = sent.findLast((message) => message.type === "terminal.resize");
  const initialRootWidth = paneFrame.getBoundingClientRect().width;
  const initialHostWidth = host.querySelector(".terminal-host").getBoundingClientRect().width;
  assert(initialSize?.terminalId === "term-A", "Initial activation did not synchronize the selected PTY size");
  assert(Math.abs(initialHostWidth - initialRootWidth) < 2, `Terminal host exceeded its narrow pane: root=${initialRootWidth}, host=${initialHostWidth}`);
  host.querySelector('[data-tab-id="term-A2"]').click();
  await until(() => host.querySelector('.terminal-tabs[aria-busy="true"]'), "pending terminal activation");
  assert(host.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tabId === "term-A", "Pending candidate was selected before its buffer was installed");
  await until(() => host.querySelector(".xterm-rows")?.textContent.includes("Old A output"), "committed terminal output");
  frameWidth = 540;
  paneFrame.style.width = "540px";
  try { await until(() => host.querySelector(".terminal-host")?.getBoundingClientRect().width > initialHostWidth + 100, "terminal host expanded during activation"); }
  catch (error) {
    throw new Error(`${error.message}: frame=${paneFrame.getBoundingClientRect().width}, pane=${host.querySelector('.terminal-pane')?.getBoundingClientRect().width}, tabs=${host.querySelector('.terminal-tabs')?.getBoundingClientRect().width}, host=${host.querySelector('.terminal-host')?.getBoundingClientRect().width}, initial=${initialHostWidth}, loading=${host.querySelector('.terminal-tabs')?.getAttribute('aria-busy')}`, { cause: error });
  }
  await settle();
  show({ type: "terminal.output", terminalId: "term-A2", payload: { data: "Included snapshot\r\n", cursor: 1 } });
  await settle();
  show({ type: "terminal.output", terminalId: "term-A2", payload: { data: "After snapshot\r\n", cursor: 2 } });
  await settle();
  pending.resolve(response({ buffer: "Included snapshot\r\n", outputCursor: 1 }));
  await until(() => terminalReady("Terminal A2"), "activation with buffered output");
  holdSecond = false;
  await until(() => host.querySelector(".xterm-rows")?.textContent.includes("After snapshot"), "live output after snapshot");
  const screen = host.querySelector(".xterm-rows").textContent;
  assert(screen.split("Included snapshot").length === 2 && !screen.includes("Old A output"), "Activation duplicated snapshot output or retained the wrong buffer");
  const sizes = sent.filter((message) => message.type === "terminal.resize" && message.terminalId === "term-A2");
  const currentHostWidth = host.querySelector(".terminal-host").getBoundingClientRect().width;
  const currentGridWidth = host.querySelector(".xterm-screen").getBoundingClientRect().width;
  assert(Math.abs(currentHostWidth - paneFrame.getBoundingClientRect().width) < 2, `Activated terminal host did not track its pane: host=${currentHostWidth}, frame=${paneFrame.getBoundingClientRect().width}`);
  assert(sizes.length && sizes.at(-1).cols > initialSize.cols && sizes.at(-1).rows > 0,
    `Activation lost fitted PTY size: initial=${JSON.stringify(initialSize)}, next=${JSON.stringify(sizes)}, host=${initialHostWidth}->${currentHostWidth}, grid=${currentGridWidth}`);
  host.querySelector('[aria-label="New terminal"]').click();
  await until(() => terminalReady("Terminal A3"), "created terminal ready");
  assert(sent.some((message) => message.type === "terminal.resize" && message.terminalId === "term-A3"), "Created terminal did not receive its fitted PTY size");
  host.querySelector('[aria-label="Close terminal Terminal A3"]').click();
  await until(() => terminalReady("Terminal A2"), "terminal after close ready");
  const beforeReconnect = sent.length;
  show({ type: "runtime.connected", payload: { replay: { requestedAfter: 1 }, terminals: [terminal("A"), terminal("A2")] } });
  await until(() => terminalReady("Terminal A2") && sent.length > beforeReconnect, "reconnected terminal ready");
  assert(sent.slice(beforeReconnect).some((message) => message.type === "terminal.resize" && message.terminalId === "term-A2"), "Reconnection did not synchronize PTY size");
  host.style.minWidth = "";
}

async function terminalRejectedSwitchRegression() {
  root.render(null);
  await settle();
  host.style.width = "";
  const pending = deferred();
  const errors = [];
  const sent = [];
  const resizeSnapshots = [];
  let retry = false;
  route = async (url) => {
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A"), terminal("A2")] });
    if (url.pathname === "/api/terminals/term-A2") return retry ? response({ buffer: "Retry output\r\n" }) : pending.promise;
    return response({ buffer: "Terminal A output\r\n" });
  };
  root.render(<div className="fixture-terminal-frame" style={{ width: 320, height: "100%" }}><TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={null} onError={(error) => errors.push(error)} sendRuntime={(message) => {
    sent.push(message);
    if (message.type === "terminal.resize") resizeSnapshots.push({ message,
      busy: host.querySelector(".terminal-tabs")?.getAttribute("aria-busy"),
      selected: host.querySelector('.terminal-tabs [aria-selected="true"]')?.dataset.tabId,
      hostWidth: host.querySelector(".terminal-host")?.getBoundingClientRect().width });
  }} /></div>);
  await until(() => terminalReady("Terminal A"), "rejection fixture terminal A ready");
  const paneFrame = host.querySelector(".fixture-terminal-frame");
  await until(() => Math.abs(paneFrame.getBoundingClientRect().width - 320) < 2
    && Math.abs(host.querySelector(".terminal-host").getBoundingClientRect().width - 320) < 2,
  "rejection fixture actual narrow terminal baseline");
  const narrowSize = sent.findLast((message) => message.type === "terminal.resize");
  const first = [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Terminal A");
  first.focus();
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await until(() => document.activeElement?.textContent === "Terminal A2", "pending rejected terminal");
  paneFrame.style.width = "540px";
  await until(() => host.querySelector('.terminal-host')?.getBoundingClientRect().width > 500, "terminal host widens during rejected activation");
  pending.reject(new Error("Buffer failed"));
  await until(() => errors.length === 1 && host.querySelector('.terminal-tabs[aria-busy="false"]'), "rejected terminal response");
  assert(host.querySelector('[role="tab"][aria-selected="true"]') === first && first.tabIndex === 0, "Failed terminal switch changed selection");
  assert(document.activeElement === first, "Failed terminal switch left focus on an unselected tab");
  retry = true;
  host.querySelector('[data-tab-id="term-A2"]').click();
  await until(() => terminalReady("Terminal A2"), "rejected activation retry");
  const retrySize = sent.findLast((message) => message.type === "terminal.resize");
  const retrySnapshot = resizeSnapshots.findLast((snapshot) => snapshot.message === retrySize);
  assert(retrySnapshot?.busy === "false" && retrySnapshot.selected === "term-A2",
    `Retried terminal published a PTY size before the selected pane committed: ${JSON.stringify(retrySnapshot)}`);
  assert(retrySize?.terminalId === "term-A2" && retrySize.cols > narrowSize.cols,
    `Retried terminal did not fit the current pane: narrow=${JSON.stringify(narrowSize)}, retry=${JSON.stringify(retrySnapshot)}`);
  for (const width of [320, 540, 320, 540]) {
    paneFrame.style.width = `${width}px`;
    await until(() => Math.abs(host.querySelector('.terminal-host')?.getBoundingClientRect().width - width) < 2, // NOSONAR S9382: each width settles before its terminals are checked
      `terminal host width ${width}`);
    host.querySelector('[data-tab-id="term-A"]').click();
    await until(() => terminalReady("Terminal A"), `terminal A at ${width}`); // NOSONAR S9382: each width settles before its terminals are checked
    const before = sent.length;
    host.querySelector('[data-tab-id="term-A2"]').click();
    await until(() => terminalReady("Terminal A2") && sent.slice(before).some((message) => message.type === "terminal.resize" && message.terminalId === "term-A2"), // NOSONAR S9382: each width settles before its terminals are checked
      `terminal A2 fitted at ${width}`);
    const fitted = sent.findLast((message) => message.type === "terminal.resize" && message.terminalId === "term-A2");
    assert(width === 540 ? fitted.cols > narrowSize.cols : fitted.cols <= narrowSize.cols,
      `Terminal published a stale grid after ${width}px layout: ${JSON.stringify(fitted)}`);
  }
}

async function terminalExitDuringActivationRegression() {
  root.render(null);
  await settle();
  const pending = deferred();
  const sent = [];
  let requested = false;
  const onError = (error) => { throw error; };
  const sendRuntime = (message) => sent.push(message);
  route = async (url) => {
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A"), terminal("A2")] });
    if (url.pathname === "/api/terminals/term-A2") { requested = true; return pending.promise; }
    return response({ buffer: "A running\r\n", outputCursor: 0 });
  };
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event} onError={onError} sendRuntime={sendRuntime} />);
  show();
  await until(() => terminalReady("Terminal A"), "initial terminal before exit race");
  host.querySelector('[data-tab-id="term-A2"]').click();
  await until(() => requested && host.querySelector('.terminal-tabs[aria-busy="true"]'), "held activation before exit");
  show({ type: "terminal.exit", terminalId: "term-A2", payload: { exitCode: 7 } });
  await settle();
  pending.resolve(response({ buffer: "A2 snapshot\r\n", outputCursor: 0, status: "exited", exitCode: 7 }));
  await until(() => terminalReady("Terminal A2"), "exited session snapshot");
  await until(() => host.querySelector('.xterm-rows')?.textContent.includes("process exited 7"), "exited terminal announcement");
  assert(!sent.some((message) => message.type === "terminal.resize" && message.terminalId === "term-A2"), "Exited terminal was sized as if it accepted input");
  assert(host.querySelector('.terminal-pane [role="status"]')?.textContent.includes("process exited 7"), "Exited session was not announced accessibly");
  host.querySelector('[data-tab-id="term-A"]').click();
  await until(() => terminalReady("Terminal A"), "running session after exited tab");
  assert(!host.querySelector('.terminal-pane [role="status"]')?.textContent, "Running terminal retained an exit notice");
  show({ type: "terminal.exit", terminalId: "term-A", payload: { exitCode: 8 } });
  await until(() => host.querySelector('.xterm-rows')?.textContent.includes("process exited 8"), "active terminal exit");
  assert(host.querySelector('.terminal-pane [role="status"]')?.textContent.includes("process exited 8"), "Active exit was not announced accessibly");
  assert(host.querySelector('[data-tab-id="term-A"]').getAttribute("aria-label").includes("process exited 8"), "Exited tab still presented as running");
  root.render(null);
  await settle();
  route = async (url) => url.pathname === "/api/terminals"
    ? response({ terminals: [terminal("A"), terminal("A2")] })
    : response(url.pathname.endsWith("term-A2")
      ? { buffer: "Already exited\r\n", status: "exited", exitCode: 9 }
      : { buffer: "Still running\r\n", status: "running" });
  show();
  await until(() => terminalReady("Terminal A"), "initial tab before exited snapshot");
  host.querySelector('[data-tab-id="term-A2"]').click();
  await until(() => terminalReady("Terminal A2"), "exited snapshot without event");
  assert(host.querySelector('.terminal-pane [role="status"]')?.textContent.includes("process exited 9"), "Snapshot-only exit was not announced");
  assert(!sent.some((message) => message.type === "terminal.resize" && message.terminalId === "term-A2"), "Snapshot-only exit made input ready");
}

async function terminalExitRejectionRegression() {
  root.render(null);
  await settle();
  const pending = deferred();
  const errors = [];
  const sent = [];
  let hold = true;
  let candidateRequests = 0;
  const onError = (error) => errors.push(error);
  const sendRuntime = (message) => sent.push(message);
  route = async (url) => {
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A"), terminal("A2")] });
    if (url.pathname === "/api/terminals/term-A2" && hold) { candidateRequests += 1; return pending.promise; }
    return response({ buffer: "Running output\r\n", status: "running" });
  };
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event} onError={onError} sendRuntime={sendRuntime} />);
  show();
  await until(() => terminalReady("Terminal A"), "running A before rejected exit");
  host.querySelector('[data-tab-id="term-A2"]').click();
  await until(() => candidateRequests === 1 && host.querySelector('.terminal-tabs[aria-busy="true"]'), "pending candidate before rejection");
  show({ type: "terminal.exit", terminalId: "term-A2", payload: { exitCode: 7 } });
  await until(() => host.querySelector('[data-tab-id="term-A2"]')?.getAttribute("aria-label").includes("process exited 7"), "candidate exit retained during held activation");
  assert(host.querySelector('.terminal-tabs[aria-busy="true"]'), "candidate exit released the held activation");
  show({ type: "terminal.exit", terminalId: "term-A", payload: { exitCode: 8 } });
  await until(() => host.querySelector('[data-tab-id="term-A"]')?.getAttribute("aria-label").includes("process exited 8"), "active exit retained during held activation");
  pending.reject(new Error("Buffer unavailable"));
  await until(() => errors.length === 1 && host.querySelector('.terminal-tabs[aria-busy="false"]'), "rejected candidate after both exits");
  assert(host.querySelector('[data-tab-id="term-A"]').getAttribute("aria-label").includes("process exited 8"), "Active exit disappeared on recovery");
  assert(host.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tabId === "term-A", "Rejection lost selected tab");
  const before = sent.length;
  host.querySelector('.terminal-host').style.width = "540px";
  const input = host.querySelector('.terminal-host .xterm-helper-textarea');
  input.focus();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "x", code: "KeyX", keyCode: 88, which: 88, bubbles: true, cancelable: true }));
  await settle();
  assert(!sent.slice(before).some((message) => message.type === "terminal.input" || message.type === "terminal.resize"), "Rejected activation restored input/resize to an exited session");
  hold = false;
  host.querySelector('[data-tab-id="term-A2"]').click();
  await until(() => terminalReady("Terminal A2"), "exited candidate reacquired as running");
  assert(!host.querySelector('[data-tab-id="term-A2"]').getAttribute("aria-label").includes("exited"), "Fresh running snapshot retained stale exit state");
  assert(!host.querySelector('.terminal-pane [role="status"]')?.textContent, "Fresh running snapshot retained an exit notice");
  assert(sent.slice(before).some((message) => message.type === "terminal.resize" && message.terminalId === "term-A2"), "Running reacquisition did not synchronize the selected PTY");
}

async function terminalRepeatedExitCloseRegression() {
  root.render(null);
  await settle();
  let all = [terminal("A")];
  let created = 0;
  const errors = [];
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") {
      const next = terminal(`A${++created}`);
      all = [...all, next];
      return response(next);
    }
    if (url.pathname === "/api/terminals") return response({ terminals: all });
    if (options.method === "DELETE") {
      all = all.filter((item) => !url.pathname.endsWith(item.id));
      return response({});
    }
    return response({ buffer: "Running\r\n", status: "running" });
  };
  const onError = (error) => errors.push(error);
  const sendRuntime = () => {};
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event} onError={onError} sendRuntime={sendRuntime} />);
  show();
  await until(() => terminalReady("Terminal A"), "initial terminal before repeated exits");
  for (let index = 1; index <= 4; index += 1) {
    const name = `Terminal A${index}`;
    const id = `term-A${index}`;
    host.querySelector('[aria-label="New terminal"]').click();
    await until(() => terminalReady(name), `created terminal ${index}`);
    show({ type: "terminal.exit", terminalId: id, payload: { exitCode: index } });
    await until(() => host.querySelector(`[data-tab-id="${id}"]`)?.getAttribute("aria-label").includes(`process exited ${index}`), `exited terminal ${index}`);
    await until(() => host.querySelector('.xterm-rows')?.textContent.includes(`process exited ${index}`), `exit banner ${index}`);
    assert(host.querySelector('.xterm-rows')?.textContent.includes("Running"), `Exit ${index} lost previous terminal output`);
    show({ type: "terminal.output", terminalId: id, payload: { cursor: index, data: `After exit ${index}\r\n` } });
    await settle();
    assert(host.querySelector('.xterm-rows')?.textContent.includes(`process exited ${index}`), `Rerender lost exit banner ${index}`);
    host.querySelector(`[aria-label="Close terminal ${name}"]`).click();
    await until(() => terminalReady("Terminal A") && !host.querySelector(`[data-tab-id="${id}"]`), `closed exited terminal ${index}`);
    assert(host.querySelectorAll('[role="tab"]').length === 1, `Exited terminal ${index} remained in the tablist`);
  }
  assert(errors.length === 0 && created === 4, "Repeated exit and close lost terminal ownership");
}

async function terminalReconnectMutationRegression() {
  root.render(null);
  await settle();
  const creating = deferred();
  const deleting = deferred();
  let all = [terminal("A")];
  const errors = [];
  const onError = (error) => errors.push(error);
  const sendRuntime = () => {};
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") return creating.promise;
    if (url.pathname === "/api/terminals") return response({ terminals: all });
    if (options.method === "DELETE") return deleting.promise;
    return response({ buffer: "Running\r\n", status: "running" });
  };
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event} onError={onError} sendRuntime={sendRuntime} />);
  show();
  await until(() => terminalReady("Terminal A"), "initial tab before reconnect mutation");
  host.querySelector('[aria-label="New terminal"]').click();
  await until(() => host.querySelector('.terminal-tabs[aria-busy="true"]'), "pending create before reconnect");
  show({ type: "runtime.connected", payload: { replay: { requestedAfter: 1 }, terminals: [terminal("A")] } });
  await settle();
  all = [terminal("A"), terminal("A2")];
  creating.resolve(response(terminal("A2")));
  await until(() => terminalReady("Terminal A2"), "created terminal after stale reconnect");
  await until(() => host.querySelector('.terminal-tabs[aria-busy="false"]'), "authoritative create reconciliation");
  assert(host.querySelectorAll('[role="tab"]').length === 2, "Reconnect discarded newly created terminal");
  host.querySelector('[aria-label="Close terminal Terminal A2"]').click();
  await until(() => host.querySelector('.terminal-tabs[aria-busy="true"]'), "pending delete before reconnect");
  show({ type: "runtime.connected", payload: { replay: { requestedAfter: 1 }, terminals: [terminal("A"), terminal("A2")] } });
  await settle();
  all = [terminal("A")];
  deleting.resolve(response({}));
  await until(() => terminalReady("Terminal A"), "remaining tab after stale reconnect");
  await until(() => host.querySelector('.terminal-tabs[aria-busy="false"]'), "authoritative delete reconciliation");
  assert(host.querySelectorAll('[role="tab"]').length === 1 && !host.querySelector('[data-tab-id="term-A2"]'), "Reconnect resurrected deleted terminal");
  assert(errors.length === 0, "Reconnect mutation reported an error");
}

async function terminalSamePaneRestartRegression() {
  root.render(null);
  await settle();
  const creating = deferred();
  const deleting = deferred();
  let all = [terminal("A")];
  let lists = 0;
  let posts = 0;
  const errors = [];
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") { posts += 1; return creating.promise; }
    if (url.pathname === "/api/terminals") { lists += 1; return response({ terminals: all }); }
    if (options.method === "DELETE") return deleting.promise;
    return response({ buffer: "Running\r\n", status: "running" });
  };
  const show = (name, event = null) => root.render(<TerminalPane worktree={{ ...projects[0].worktrees[0], name }} runtimeEvent={event} onError={(error) => errors.push(error)} sendRuntime={() => {}} />);
  show("A");
  await until(() => terminalReady("Terminal A"), "terminal before same-pane restart");
  host.querySelector('[aria-label="New terminal"]').click();
  await until(() => posts === 1, "pending create before same-pane restart");
  show("A renamed");
  await settle();
  assert(lists === 1 && host.querySelector('.terminal-tabs[aria-busy="true"]') && !host.querySelector('[data-tab-id="term-A2"]'),
    "Metadata-only rerender restarted the terminal list or released the pending creation");
  show("A renamed", { type: "runtime.connected", payload: { replay: { requestedAfter: 1 }, terminals: [terminal("A")] } });
  await settle();
  all = [terminal("A"), terminal("A2")];
  creating.resolve(response(terminal("A2")));
  await until(() => lists >= 2 && host.querySelector('[data-tab-id="term-A2"]'), "authoritative list after same-pane mutation and reconnect");
  await until(() => host.querySelector('.terminal-tabs[aria-busy="false"]'), "ready after same-pane creation");
  host.querySelector('[aria-label="Close terminal Terminal A2"]').click();
  await until(() => host.querySelector('.terminal-tabs[aria-busy="true"]'), "pending delete before same-pane restart");
  show("A renamed again");
  await settle();
  assert(host.querySelector('.terminal-tabs[aria-busy="true"]') && host.querySelector('[data-tab-id="term-A2"]'),
    "Metadata-only rerender released the pending deletion");
  const beforeDeleteReconcile = lists;
  show("A renamed again", { type: "runtime.connected", payload: { replay: { requestedAfter: 1 }, terminals: [terminal("A"), terminal("A2")] } });
  await settle();
  all = [terminal("A")];
  deleting.resolve(response({}));
  await until(() => lists > beforeDeleteReconcile && !host.querySelector('[data-tab-id="term-A2"]'), "authoritative list after same-pane deletion and reconnect");
  assert(posts === 1 && errors.length === 0, "Same-pane restart created a ghost terminal or surfaced an error");
}

async function terminalReconnectOwnershipRegression() {
  root.render(null);
  await settle();
  const firstCreation = deferred();
  let posts = 0;
  let lists = 0;
  let all = [terminal("A")];
  const errors = [];
  const onError = (error) => errors.push(error);
  const sendRuntime = () => {};
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") {
      posts += 1;
      return posts === 1 ? firstCreation.promise : response(terminal("A3"));
    }
    if (url.pathname === "/api/terminals") { lists += 1; return response({ terminals: all }); }
    return response({ buffer: "Running\r\n", status: "running" });
  };
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event} onError={onError} sendRuntime={sendRuntime} />);
  show();
  await until(() => terminalReady("Terminal A"), "terminal before overlapping reconnects");
  // A reconnect lists over HTTP; the socket snapshot omits saved sessions.
  all = [{ ...terminal("A"), status: "exited" }];
  const reconnect = () => ({ type: "runtime.connected", payload: { replay: { requestedAfter: 1 }, terminals: [] } });
  show(reconnect());
  await until(() => posts === 1, "first reconnect creation");
  show(reconnect());
  await settle();
  assert(posts === 1, `Overlapping reconnects created ${posts} PTYs instead of coalescing`);
  all = [terminal("A"), terminal("A2")];
  firstCreation.resolve(response(terminal("A2")));
  await until(() => terminalReady("Terminal A2"), "single reconciled terminal");
  assert(posts === 1 && errors.length === 0, "Reconnect left an untracked terminal");

  const pending = deferred();
  const deleting = deferred();
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST") { posts += 1; return pending.promise; }
    if (url.pathname === "/api/terminals") { lists += 1; return response({ terminals: [terminal("A")] }); }
    if (options.method === "DELETE") return deleting.promise;
    return response({ buffer: "Running\r\n", status: "running" });
  };
  show();
  await settle();
  host.querySelector('[aria-label="New terminal"]').click();
  await until(() => host.querySelector('.terminal-tabs[aria-busy="true"]'), "create before unmount");
  show({ type: "runtime.connected", payload: { replay: { requestedAfter: 1 }, terminals: [terminal("A")] } });
  await settle();
  root.render(null);
  await settle();
  const before = [lists, posts];
  pending.resolve(response(terminal("A3")));
  await settle();
  assert(lists === before[0] && posts === before[1], "Unmounted create issued a queued reconnect request");
  show();
  await until(() => terminalReady("Terminal A"), "terminal before unmounted delete");
  host.querySelector('[aria-label="Close terminal Terminal A"]').click();
  await until(() => host.querySelector('.terminal-tabs[aria-busy="true"]'), "delete before unmount");
  show({ type: "runtime.connected", payload: { replay: { requestedAfter: 1 }, terminals: [terminal("A")] } });
  await settle();
  root.render(null);
  await settle();
  const beforeDelete = [lists, posts];
  deleting.resolve(response({}));
  await settle();
  assert(lists === beforeDelete[0] && posts === beforeDelete[1], "Unmounted delete created a replacement or issued queued reconnect");
}

async function terminalBackgroundActivationRegression() {
  root.render(null);
  await settle();
  const prior = Object.getOwnPropertyDescriptor(document, "hidden");
  const sent = [];
  const onError = (error) => { throw error; };
  const sendRuntime = (message) => sent.push(message);
  route = async (url) => url.pathname === "/api/terminals"
    ? response({ terminals: [terminal("A"), terminal("A2")] })
    : response({ buffer: "Background output\r\n", status: "running" });
  try {
    root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={null} onError={onError} sendRuntime={sendRuntime} />);
    await until(() => terminalReady("Terminal A"), "visible terminal before background activation");
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    host.querySelector('[data-tab-id="term-A2"]').click();
    await until(() => terminalReady("Terminal A2"), "background activation without animation frame");
    assert(!sent.some((message) => message.type === "terminal.resize" && message.terminalId === "term-A2"), "Hidden terminal published a stale fitted size");
  } finally {
    if (prior) Object.defineProperty(document, "hidden", prior);
    else delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  }
  await until(() => sent.some((message) => message.type === "terminal.resize" && message.terminalId === "term-A2"), "visible terminal fitted before input");
}

async function terminalInitialFailureRegression() {
  root.render(null);
  await settle();
  const errors = [];
  const sent = [];
  route = async (url) => {
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A"), terminal("A2")] });
    if (url.pathname === "/api/terminals/term-A") return response({ error: "Buffer failed" }, 500);
    return response({ buffer: "" });
  };
  root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={null} onError={(error) => errors.push(error)} sendRuntime={(message) => sent.push(message)} />);
  await until(() => errors.length === 1 && host.querySelector('.terminal-tabs[aria-busy="false"]'), "initial terminal buffer rejection");
  assert(host.querySelectorAll('[role="tab"]').length === 2, "Fixture lost existing terminal tabs");
  assert(host.querySelectorAll('[role="tab"][tabindex="0"]').length === 1, "Buffer failure left no keyboard-reachable terminal tab");
  const before = sent.length;
  host.querySelector('.terminal-host').style.width = "540px";
  await settle();
  assert(!sent.slice(before).some((message) => message.type === "terminal.resize" || message.type === "terminal.input"), "Failed initial activation became input-ready on resize");
}

async function terminalMutationFailureRegression() {
  root.render(null);
  await settle();
  const errors = [];
  const onError = (error) => errors.push(error);
  const sent = [];
  const sendRuntime = (message) => sent.push(message);
  let failure = "";
  let pendingReconnect;
  let heldBufferRequested = false;
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST" && failure === "create") return response({ error: "Create failed" }, 500);
    if (url.pathname === "/api/terminals" && options.method === "POST") return response(terminal("A3"));
    if (url.pathname === "/api/terminals" && failure === "reconnect-list") return response({ error: "List failed" }, 500);
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A"), terminal("A2")] });
    if (url.pathname === "/api/terminals/term-A" && options.method === "DELETE" && failure === "delete") return response({ error: "Delete failed" }, 500);
    if (url.pathname === "/api/terminals/term-A2" && failure === "replacement-buffer") return response({ error: "Buffer failed" }, 500);
    if (url.pathname === "/api/terminals/term-A" && failure === "reconnect-buffer") return response({ error: "Reconnect failed" }, 500);
    if (url.pathname === "/api/terminals/term-A" && failure === "hold-reconnect-buffer") { heldBufferRequested = true; return pendingReconnect.promise; }
    return response({ buffer: "Retained output\r\n", status: "running" });
  };
  const show = (runtimeEvent = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={runtimeEvent} onError={onError} sendRuntime={sendRuntime} />);
  show();
  await until(() => terminalReady("Terminal A"), "mutation fixture terminal A ready");
  const selected = () => host.querySelector('[role="tab"][aria-selected="true"][tabindex="0"]');
  const typeIntoTerminal = () => {
    const input = host.querySelector('.terminal-host .xterm-helper-textarea');
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "x", code: "KeyX", keyCode: 88, which: 88, bubbles: true, cancelable: true }));
  };
  typeIntoTerminal();
  await until(() => sent.some((message) => message.type === "terminal.input" && message.terminalId === "term-A" && message.data === "x"), "baseline running terminal input");
  failure = "create";
  host.querySelector('[aria-label="New terminal"]').click();
  await until(() => errors.length === 1 && host.querySelector('.terminal-tabs[aria-busy="false"]'), "failed terminal creation");
  assert(selected()?.textContent === "Terminal A", "Failed creation lost the selected tab");
  failure = "delete";
  host.querySelector('[aria-label="Close terminal Terminal A"]').click();
  await until(() => errors.length === 2 && host.querySelector('.terminal-tabs[aria-busy="false"]'), "failed terminal deletion");
  assert(selected()?.textContent === "Terminal A", "Failed deletion lost the selected tab");
  failure = "replacement-buffer";
  host.querySelector('[aria-label="Close terminal Terminal A"]').focus();
  host.querySelector('[aria-label="Close terminal Terminal A"]').click();
  await until(() => errors.length === 3 && host.querySelector('.terminal-tabs[aria-busy="false"]'), "failed replacement buffer");
  assert(selected()?.textContent === "Terminal A2", "Failed replacement buffer lost the remaining tab");
  await until(() => document.activeElement === selected(), "focus after deleting selected terminal");

  // A fresh pane keeps the previous tab reachable if a reconnect buffer fails.
  root.render(null);
  await settle();
  failure = "";
  show();
  await until(() => selected()?.textContent === "Terminal A", "reconnection fixture terminal A");
  failure = "reconnect-buffer";
  show({ type: "runtime.connected", payload: { replay: { requestedAfter: 1 }, terminals: [terminal("A"), terminal("A2")] } });
  await until(() => errors.length === 4 && host.querySelector('.terminal-tabs[aria-busy="false"]'), "failed terminal reconnection");
  assert(selected()?.textContent === "Terminal A", "Failed reconnection left no selected tab");
  const beforeInput = sent.filter((message) => message.type === "terminal.input" && message.terminalId === "term-A").length;
  typeIntoTerminal();
  await until(() => sent.filter((message) => message.type === "terminal.input" && message.terminalId === "term-A").length > beforeInput, "running terminal input after failed reconnect buffer");
  const beforeResize = sent.filter((message) => message.type === "terminal.resize" && message.terminalId === "term-A").length;
  host.querySelector('.terminal-host').style.width = "540px";
  await until(() => sent.filter((message) => message.type === "terminal.resize" && message.terminalId === "term-A").length > beforeResize, "running terminal resize after failed reconnect buffer");
  assert(host.querySelector('.xterm-rows')?.textContent.includes("Retained output"), "Rejected buffer discarded the prior terminal output");

  pendingReconnect = deferred();
  heldBufferRequested = false;
  failure = "hold-reconnect-buffer";
  show({ type: "runtime.connected", payload: { replay: { requestedAfter: 2 }, terminals: [terminal("A"), terminal("A2")] } });
  await until(() => heldBufferRequested, "first reconnect buffer held before queued list refresh");
  show({ type: "runtime.connected", payload: { replay: { requestedAfter: 3 }, terminals: [terminal("A"), terminal("A2")] } });
  await settle();
  failure = "reconnect-list";
  pendingReconnect.resolve(response({ buffer: "Retained output\r\n", status: "running" }));
  await until(() => errors.length === 5 && host.querySelector('.terminal-tabs[aria-busy="false"]'), "failed authoritative reconnect list");
  assert(selected()?.textContent === "Terminal A", "Failed list request lost the selected tab");
  const beforeListInput = sent.filter((message) => message.type === "terminal.input" && message.terminalId === "term-A").length;
  typeIntoTerminal();
  await until(() => sent.filter((message) => message.type === "terminal.input" && message.terminalId === "term-A").length > beforeListInput, "running terminal input after rejected list");
  const beforeListResize = sent.filter((message) => message.type === "terminal.resize" && message.terminalId === "term-A").length;
  host.querySelector('.terminal-host').style.width = "460px";
  await until(() => sent.filter((message) => message.type === "terminal.resize" && message.terminalId === "term-A").length > beforeListResize, "running terminal resize after rejected list");
  assert(host.querySelector('.xterm-rows')?.textContent.includes("Retained output"), "Rejected list discarded the prior terminal output");
}

async function terminalDeleteFocusOwnershipRegression() {
  for (const chooseOther of [false, true]) {
    root.render(null);
    await settle();
    const deletion = deferred();
    let deleting = false;
    route = async (url, options) => {
      if (url.pathname === "/api/terminals" && options.method === "POST") return response(terminal("A"));
      if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A"), terminal("A2")] });
      if (url.pathname === "/api/terminals/term-A" && options.method === "DELETE") { deleting = true; return deletion.promise; }
      return response({ buffer: "ready", status: "running" });
    };
    root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={null} onError={(error) => { throw error; }} sendRuntime={() => {}} />);
    await until(() => terminalReady("Terminal A"), "terminal focus fixture ready"); // NOSONAR S9382: deletion focus steps depend on the prior commit
    const close = host.querySelector('[aria-label="Close terminal Terminal A"]');
    close.focus();
    close.click();
    await until(() => deleting, "terminal deletion held"); // NOSONAR S9382: deletion focus steps depend on the prior commit
    const other = chooseOther ? document.createElement("button") : null;
    if (other) { document.body.append(other); other.focus(); }
    try {
      deletion.resolve(response({}));
      await until(() => terminalReady("Terminal A2"), "replacement terminal selected"); // NOSONAR S9382: deletion focus steps depend on the prior commit
      if (other) {
        assert(document.activeElement === other, "Delayed terminal deletion stole a newer focus choice");
      } else {
        await until(() => document.activeElement === host.querySelector('[role="tab"][aria-selected="true"]'), "replacement tab receives focus after commit"); // NOSONAR S9382: deletion focus steps depend on the prior commit
      }
    } finally { other?.remove(); }
  }
}

async function commandPaletteRegression() {
  root.render(null);
  await settle();
  const oldResults = deferred();
  const currentResults = deferred();
  const retryResults = deferred();
  const staleFailure = deferred();
  const latestResults = deferred();
  const requested = new Set();
  let failureRequests = 0;
  let selected = null;
  route = async (url) => {
    if (url.pathname !== "/api/search") return response({});
    const search = url.searchParams.get("q");
    requested.add(search);
    if (search === "older") return oldResults.promise;
    if (search === "current") return currentResults.promise;
    if (search === "failure") {
      failureRequests += 1;
      if (failureRequests === 1) throw new Error("Search service unavailable");
      return retryResults.promise;
    }
    if (search === "stale-failure") return staleFailure.promise;
    if (search === "none") return response({ conversations: [], partial: true });
    if (search === "mixed") return response({ conversations: [], partial: true });
    if (search === "complete") return response({ conversations: [
      { id: "first", title: "First", provider: "codex", worktreePath: "/first" },
      { id: "second", title: "Second", provider: "codex", worktreePath: "/second" }], partial: false });
    return latestResults.promise;
  };
  root.render(<CommandPalette open onOpenChange={() => {}} projects={[]} onSelectProject={() => {}} onSelectConversation={(conversation) => { selected = conversation; }} />);
  await until(() => document.querySelector('[role="combobox"]'), "command palette input");
  const input = document.querySelector('[role="combobox"]');
  setControlValue(input, "   ");
  await settle();
  assert(Boolean(document.querySelector(".command-hint")), "Whitespace-only command query hid the search hint");
  setControlValue(input, "older");
  await until(() => requested.has("older"), "older command search");
  setControlValue(input, "current");
  await until(() => requested.has("current"), "current command search");
  oldResults.resolve(response({ conversations: [{ id: "old", title: "Old result", provider: "codex", worktreePath: "/old" }], messages: [] }));
  await settle();
  assert(!document.body.textContent.includes("Old result"), "A stale command search response remained selectable");
  currentResults.resolve(response({ conversations: [{ id: "current", title: "Current result", provider: "codex", worktreePath: "/current" }], partial: true }));
  await until(() => document.querySelector('[role="option"]')?.textContent.includes("Current result"), "current command result");
  assert(document.querySelector(".command-search-scope")?.textContent.includes("recent conversations"), "bounded search was not explained");
  assert(document.querySelector('.command-results [role="status"]')?.textContent.includes("Conversation text covers recent conversations and short messages"),
    "partial search scope was absent from the result announcement");
  assert(document.querySelector('.command-results [role="status"]')?.textContent.startsWith("1 result is available"),
    "partial search did not announce its visible result count");
  await until(() => input.getAttribute("aria-activedescendant") === "command-result-0", "active remote command result");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert(selected?.id === "current", "Enter did not select the asynchronously loaded command result");
  assert([...document.querySelector('[role="listbox"]').children].every((element) => element.getAttribute("role") === "option"), "Command listbox contains non-option children");

  setControlValue(input, "none");
  await until(() => document.querySelector('.command-results [role="status"]')?.textContent.startsWith("No matching projects, worktrees"),
    "partial search with zero matches incorrectly announced available results");
  root.render(<CommandPalette open onOpenChange={() => {}} projects={[{ id: "mixed-project", name: "Mixed", worktrees: [] }]} onSelectProject={() => {}} onSelectConversation={(conversation) => { selected = conversation; }} />);
  setControlValue(document.querySelector('[role="combobox"]'), "mixed");
  await until(() => document.querySelector('.command-results [role="status"]')?.textContent.includes("Conversation text covers recent conversations"),
    "mixed-source partial search scope");
  assert(document.querySelector('.command-results [role="status"]').textContent.startsWith("1 result is available."),
    "local project result was attributed to partial conversation text");
  setControlValue(input, "complete");
  await until(() => document.querySelector('.command-results [role="status"]')?.textContent === "2 results are available",
    "completed search omitted its visible result count");

  setControlValue(input, "failure");
  await until(() => failureRequests === 1, "failed command search");
  await until(() => document.querySelector(".command-error"), "command search failure message");
  assert(document.querySelector(".command-error").textContent.includes("Search failed"), "Command search failure was reported as an empty result");
  assert(!document.querySelector('.command-error[role="alert"]'), "Retryable search failure interrupted speech with an assertive alert");
  assert(document.querySelector('.command-results [role="status"]')?.textContent.includes("Retry search available"), "Search failure and retry availability were not announced politely");
  assert(!document.querySelector(".no-results"), "Command search failure also rendered the no-results state");
  document.querySelector(".command-error button").click();
  await until(() => failureRequests === 2, "retried command search");
  retryResults.resolve(response({ conversations: [{ id: "retry", title: "Retry result", provider: "codex", worktreePath: "/retry" }], messages: [] }));
  await until(() => document.querySelector('[role="option"]')?.textContent.includes("Retry result"), "retried command result");
  assert(!document.querySelector(".command-error"), "Successful retry left the search failure visible");

  setControlValue(input, "stale-failure");
  await until(() => requested.has("stale-failure"), "stale failed search");
  setControlValue(input, "latest");
  await until(() => requested.has("latest"), "latest search after failure");
  staleFailure.reject(new Error("Stale search failed"));
  await settle();
  assert(!document.querySelector(".command-error"), "A stale failed search replaced the current query state");
  latestResults.resolve(response({ conversations: [{ id: "latest", title: "Latest result", provider: "codex", worktreePath: "/latest" }], messages: [] }));
  await until(() => document.querySelector('[role="option"]')?.textContent.includes("Latest result"), "latest result after stale failure");
}

async function changesLoadingRegression() {
  root.render(null);
  await settle();
  const pendingStatus = deferred();
  route = async (url) => url.pathname === "/api/git/status" ? pendingStatus.promise : response({ diff: "" });
  root.render(<ChangesPane worktree={projects[0].worktrees[0]} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => { throw error; }} onToast={() => {}} />);
  await settle();
  assert(!host.querySelector(".clean-state"), "Changes pane announced a clean tree before status loaded");
  pendingStatus.resolve(response({ branch: "main", files: [], stagedCount: 0 }));
  await until(() => host.querySelector(".clean-state"), "loaded clean tree status");
}

async function changesDiscardedRenderRegression() {
  root.render(null); await settle();
  const pendingStatus = deferred();
  const pendingRender = deferred();
  let attempted = false;
  let released = false;
  route = async (url) => {
    if (url.pathname !== "/api/git/status") return response({ diff: "" });
    return url.searchParams.get("path") === projects[0].worktrees[0].path
      ? pendingStatus.promise : response({ branch: "B branch", files: [], stagedCount: 0 });
  };
  function Gate() { if (!released) { attempted = true; throw pendingRender.promise; } return null; }
  const pane = (tree, gate = false) => <Suspense fallback={<div>Pending worktree</div>}><ChangesPane worktree={tree} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => { throw error; }} onToast={() => {}} />{gate && <Gate />}</Suspense>;
  root.render(pane(projects[0].worktrees[0]));
  await until(() => host.querySelector(".changes-pane"), "committed A changes pane");
  startTransition(() => root.render(pane(projects[1].worktrees[0], true)));
  await until(() => attempted, "B render reached the suspension boundary");
  assert(host.querySelector(".changes-pane") && !host.textContent.includes("Pending worktree"), "The pending B render replaced committed A");
  pendingStatus.resolve(response({ branch: "A branch", files: [], stagedCount: 0 }));
  await until(() => host.querySelector(".pane-toolbar strong")?.textContent === "A branch", "committed A status survived discarded B render");
  released = true;
  pendingRender.resolve();
  await until(() => host.querySelector(".pane-toolbar strong")?.textContent === "B branch", "B status loaded after commit");
}

async function staleDiffSelectionRegression() {
  root.render(null);
  await settle();
  const older = deferred();
  const staleStatus = deferred();
  let holdStatus = false;
  route = async (url) => {
    if (url.pathname === "/api/git/status") {
      if (url.searchParams.get("path") === projects[1].worktrees[0].path) return response({ branch: "B branch", files: [], stagedCount: 0 });
      if (holdStatus) return staleStatus.promise;
      return response({ branch: "A branch", files: [{ path: "a.txt", status: " M", index: " ", worktree: "M" }, { path: "b.txt", status: " M", index: " ", worktree: "M" }], stagedCount: 0 });
    }
    if (url.pathname === "/api/git/diff") return url.searchParams.get("file") === "a.txt" ? older.promise : response({ diff: "+current B\n" });
    return response({});
  };
  root.render(<ChangesPane worktree={projects[0].worktrees[0]} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => { throw error; }} onToast={() => {}} />);
  await until(() => host.querySelectorAll(".change-file-select").length === 2, "two changed files");
  [...host.querySelectorAll(".change-file-select")].find((button) => button.textContent.includes("b.txt")).click();
  await until(() => host.querySelector(".diff-view")?.textContent.includes("current B"), "newer selected diff");
  older.resolve(response({ diff: "+stale A\n" }));
  await settle();
  assert(host.querySelector(".diff-view")?.textContent.includes("current B") && !host.querySelector(".diff-view")?.textContent.includes("stale A"), "A late diff response replaced the selected file");
  holdStatus = true;
  host.querySelector('[aria-label="Refresh changes"]').click();
  await settle();
  root.render(<ChangesPane worktree={projects[1].worktrees[0]} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => { throw error; }} onToast={() => {}} />);
  await until(() => host.querySelector('.pane-toolbar strong')?.textContent === "B branch", "new worktree status");
  staleStatus.resolve(response({ branch: "A branch", files: [], stagedCount: 0 }));
  await settle();
  assert(host.querySelector('.pane-toolbar strong')?.textContent === "B branch", "A stale worktree status replaced B's status");
}

async function changesSelectionRefreshRegression() {
  root.render(null); await settle();
  const pendingStatus = deferred();
  const requests = [];
  let holdStatus = false;
  const pendingMutation = deferred();
  const files = ["a.txt", "b.txt"].map((file) => ({ path: file, status: "MM", index: "M", worktree: "M" }));
  route = async (url) => {
    requests.push(`${url.pathname}:${url.searchParams.get("file") ?? ""}:${url.searchParams.get("staged") ?? ""}`);
    if (url.pathname === "/api/git/status") return holdStatus ? pendingStatus.promise : response({ branch: "main", files, stagedCount: 2 });
    if (url.pathname === "/api/git/diff") return response({ diff: `${url.searchParams.get("file")}:${url.searchParams.get("staged")}` });
    if (url.pathname === "/api/git/unstage") return pendingMutation.promise;
    return response({});
  };
  const tree = projects[0].worktrees[0];
  const pane = (event) => <PaneBody style={{ width: 448, height: 600 }}><ChangesPane worktree={tree} runtimeEvent={event} settings={{ editor: "code" }} onError={(error) => { throw error; }} onToast={() => {}} /></PaneBody>;
  root.render(pane(null));
  await until(() => host.querySelectorAll('.change-file-select').length === 2, "change selection ready");
  holdStatus = true;
  host.querySelector('[aria-label="Refresh changes"]').click();
  await settle();
  [...host.querySelectorAll('.change-file-select')].find((button) => button.textContent.includes("b.txt")).click();
  host.querySelector('.diff-mode button').click();
  await until(() => host.querySelector('.diff-view')?.textContent.includes("b.txt:false"), "new file and mode diff");
  pendingStatus.resolve(response({ branch: "main", files, stagedCount: 2 }));
  holdStatus = false;
  await settle();
  assert(host.querySelector('.change-file.is-active')?.textContent.includes("b.txt") && host.querySelector('.diff-mode button[aria-pressed="true"]')?.textContent === "Unstaged", "Pending status restored an obsolete file or mode");
  assert(host.querySelector('.diff-view')?.textContent.includes("b.txt:false"), "Pending status restored an obsolete diff");
  const event = { type: "run.event", payload: { type: "run.completed" } };
  const beforeCompletion = requests.filter((item) => item.startsWith("/api/git/status")).length;
  root.render(pane(event));
  await until(() => requests.filter((item) => item.startsWith("/api/git/status")).length === beforeCompletion + 1,
    "committed completion event status refresh");
  await until(() => host.querySelector('.changed-files')?.getAttribute('aria-busy') === 'false'
    && host.querySelector('.diff-view')?.textContent.includes("b.txt:false"), "completion refresh settled");
  const statusCount = requests.filter((item) => item.startsWith("/api/git/status")).length;
  root.render(pane(event)); await settle();
  assert(requests.filter((item) => item.startsWith("/api/git/status")).length === statusCount, "Retained completion event retriggered status on selection rerender");
  host.querySelector('[aria-label="Unstage b.txt"]').click();
  await until(() => requests.some((item) => item.startsWith("/api/git/unstage")), "same-worktree mutation pending");
  [...host.querySelectorAll('.change-file-select')].find((button) => button.textContent.includes("a.txt")).click();
  host.querySelector('.diff-mode button').click();
  const beforeMutationRefresh = requests.filter((item) => item.startsWith("/api/git/status")).length;
  const beforeMutationDiff = requests.filter((item) => item.startsWith("/api/git/diff")).length;
  pendingMutation.resolve(response({ ok: true }));
  await until(() => requests.filter((item) => item.startsWith("/api/git/status")).length > beforeMutationRefresh
    && requests.filter((item) => item.startsWith("/api/git/diff")).length > beforeMutationDiff
    && host.querySelector('.change-file.is-active')?.textContent.includes("a.txt")
    && host.querySelector('.diff-view')?.textContent.includes("a.txt:false"), "mutation follow-up preserved the selected file and mode");
}

async function changesDiffFailureOwnershipRegression() {
  root.render(null); await settle();
  const pendingFile = deferred();
  const pendingMode = deferred();
  const errors = [];
  route = async (url) => {
    if (url.pathname === "/api/git/status") return response({ branch: "main", files: ["a.txt", "b.txt"].map((path) => ({ path, status: "MM", index: "M", worktree: "M" })), stagedCount: 2 });
    if (url.pathname === "/api/git/diff") {
      const file = url.searchParams.get("file");
      const staged = url.searchParams.get("staged") === "true";
      if (file === "b.txt" && staged) return pendingFile.promise;
      if (file === "b.txt" && !staged) return pendingMode.promise;
      return response({ diff: "+A content\n" });
    }
    return response({});
  };
  root.render(<PaneBody style={{ width: 448, height: 600 }}><ChangesPane worktree={projects[0].worktrees[0]} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => errors.push(error.message)} onToast={() => {}} /></PaneBody>);
  await until(() => host.querySelector('.diff-view')?.textContent.includes("A content"), "initial A diff");
  [...host.querySelectorAll('.change-file-select')].find((button) => button.textContent.includes("b.txt")).click();
  await settle();
  assert(host.querySelector('.change-file.is-active')?.textContent.includes("b.txt") && !host.querySelector('.diff-view')?.textContent.includes("A content"), "Previous file diff remained under B while pending");
  pendingFile.reject(new Error("B staged unavailable"));
  await until(() => errors.includes("B staged unavailable"), "B diff failure reported");
  assert(!host.querySelector('.diff-view')?.textContent.includes("A content"), "Previous file diff remained after B failure");
  host.querySelector('.diff-mode button[aria-pressed="false"]').click();
  await settle();
  assert(!host.querySelector('.diff-view')?.textContent.includes("A content"), "Previous mode diff remained during unstaged load");
  pendingMode.resolve(response({ diff: "+B unstaged\n" }));
  await until(() => host.querySelector('.diff-view')?.textContent.includes("B unstaged"), "new mode diff loaded");
}

async function diffRefreshAnchorRegression() {
  root.render(null); await settle();
  const original = Array.from({ length: 5_000 }, (_, index) => `+line ${index}\n`).join("");
  const changed = original.replace("+line 2500", "+LINE 2500");
  const pending = [];
  let hold = false;
  const errors = [];
  route = async (url) => {
    if (url.pathname === "/api/git/status") return response({ branch: "main", files: [{ path: "large.txt", status: "MM", index: "M", worktree: "M" }], stagedCount: 1 });
    if (url.pathname === "/api/git/diff") {
      if (hold) { const request = deferred(); pending.push(request); return request.promise; }
      return response({ diff: original });
    }
    return response({});
  };
  const tree = projects[0].worktrees[0];
  const pane = (event) => <PaneBody style={{ width: 448, height: 600 }}><ChangesPane worktree={tree} runtimeEvent={event} settings={{ editor: "code" }} onError={(error) => errors.push(error.message)} onToast={() => {}} /></PaneBody>;
  root.render(pane(null));
  await until(() => host.querySelector(".diff-view")?.textContent.includes("line 0"), "large diff ready");
  const viewport = host.querySelector(".diff-view");
  await withDiffTrace(viewport, async () => {
    const find = host.querySelector('input[aria-label="Find in diff"]');
    setControlValue(find, "line 2500");
    find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const foundRowIsAligned = () => {
      const row = viewport.querySelector('[data-find-match="true"]');
      if (!row?.textContent.includes("2500")) return false;
      return Math.abs(diffFindRowOffset(viewport)) < 2;
    };
    await until(() => foundRowIsAligned() && viewport.scrollTop > 20_000,
      "large diff find aligned at its committed reading position");
    // The mark may mount before the queued Find alignment settles on slower
    // hosts. Start the refresh comparison from the completed reading position.
    await settle();
    assert(foundRowIsAligned(), "Large diff Find lost its aligned row before refresh");
    const anchor = viewport.scrollTop;
    hold = true;
    root.render(pane({ type: "projects.changed" }));
    await until(() => pending.length === 1, "background diff refresh pending");
    assert(viewport.textContent.includes("line 2500") && viewport.querySelector('[data-find-match="true"]'), "Background refresh erased the reader's diff or find");
    assert(Math.abs(viewport.scrollTop - anchor) < 24 && foundRowIsAligned(),
      `Background refresh moved the diff anchor before its response: ${anchor} -> ${viewport.scrollTop}, row=${viewport.querySelector('[data-find-match="true"]')?.getBoundingClientRect().top}, viewport=${viewport.getBoundingClientRect().top}`);
    pending.shift().resolve(response({ diff: original }));
    await settle();
    assert(Math.abs(viewport.scrollTop - anchor) < 24 && viewport.querySelector('[data-find-match="true"]'), "Identical diff refresh lost the anchor or find");
    host.querySelector('[aria-label="Refresh changes"]').click();
    await until(() => pending.length === 1, "changed diff refresh pending");
    pending.shift().resolve(response({ diff: changed }));
    await until(() => viewport.querySelector('[data-find-match="true"]')?.textContent.includes("LINE 2500"), "changed diff find retained");
    assert(Math.abs(viewport.scrollTop - anchor) < 24, "Changed diff refresh moved the reader's line");
    host.querySelector('[aria-label="Refresh changes"]').click();
    await until(() => pending.length === 1, "failed same-selection refresh pending");
    pending.shift().reject(new Error("Diff offline"));
    await until(() => errors.includes("Diff offline"), "same-selection failure reported");
    assert(viewport.textContent.includes("LINE 2500") && Math.abs(viewport.scrollTop - anchor) < 24, "Failed same-selection refresh erased the last valid diff");
  });
}

// Windows CI lost a Find match to a late queued scroll only at some viewport
// heights: where the aligned first row equals the Find anchor, the late
// scroll changes no mounted row and nothing aligned the match again. With
// classic scrollbars, as on that runner, rows 252-279px tall do that; these
// heights cover that range with a margin for platform chrome.
async function diffFindOwnershipRegression() {
  root.render(null); await settle();
  const style = document.createElement("style");
  style.textContent = ".diff-view::-webkit-scrollbar { width: 17px; height: 17px; } .diff-view::-webkit-scrollbar-thumb { background: #888; }";
  document.head.append(style);
  const diff = Array.from({ length: 5_000 }, (_, index) => `-unstaged ${index}\n`).join("");
  try {
    for (const height of [287, 294, 301, 308]) {
      root.render(null); await settle(); // NOSONAR S9382: each height starts from a fresh viewport
      root.render(<PaneBody style={{ width: 448, height }}><WindowedDiff diff={diff} label={`Diff at ${height}px`} /></PaneBody>);
      await until(() => host.querySelector(".diff-view")?.textContent.includes("unstaged 0"), `diff at ${height}px`); // NOSONAR S9382: each height starts from a fresh viewport
      const viewport = host.querySelector(".diff-view");
      const find = host.querySelector('input[aria-label="Find in diff"]');
      setControlValue(find, "unstaged 2500");
      find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await until(() => diffFindLanded(viewport, "unstaged 2500", 2500), `Find at ${height}px`); // NOSONAR S9382: each height starts from a fresh viewport
      await assertFindKeepsOwnership(viewport, "unstaged 2500", `Find at ${height}px (${viewport.clientHeight}px rows)`); // NOSONAR S9382: each height starts from a fresh viewport
    }
    // A commit can land after a scroll Find did not cause and before that
    // scroll's event. The commit itself must show the match at its target,
    // and while a seek has not moved the viewport yet, the window must not
    // mount the match where the viewport is not.
    const pane = (label) => <PaneBody style={{ width: 448, height: 600 }}><WindowedDiff diff={diff} label={label} /></PaneBody>;
    root.render(null); await settle();
    root.render(pane("Diff before a commit"));
    await until(() => host.querySelector(".diff-view")?.textContent.includes("unstaged 0"), "diff for a commit before a scroll event");
    const viewport = host.querySelector(".diff-view");
    const find = host.querySelector('input[aria-label="Find in diff"]');
    const native = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    await withDiffTrace(viewport, async () => {
      setControlValue(find, "unstaged 2500");
      find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await until(() => diffFindLanded(viewport, "unstaged 2500", 2500), "Find before a late scroll and commit");
      native.set.call(viewport, viewport.scrollHeight);
      flushSync(() => root.render(pane("Diff committed before its scroll event")));
      assert(Math.abs(diffFindRowOffset(viewport)) < 2, `A commit before the late scroll's event left the Find match ${diffFindRowOffset(viewport)}px from its target; ${diffFindState(viewport, 2500)}`);
    });
    root.render(null); await settle();
    root.render(pane("Diff with a held seek"));
    await until(() => host.querySelector(".diff-view")?.textContent.includes("unstaged 0"), "diff for a held seek");
    const held = host.querySelector(".diff-view");
    await withDiffTrace(held, async () => {
      // Hold the seek over the trace's own scrollTop recorder, then give it back.
      const traced = Object.getOwnPropertyDescriptor(held, "scrollTop");
      Object.defineProperty(held, "scrollTop", { configurable: true, get: () => native.get.call(held), set: () => {} });
      try {
        const input = host.querySelector('input[aria-label="Find in diff"]');
        setControlValue(input, "unstaged 2500");
        flushSync(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
        await settle();
        const mark = held.querySelector('[data-find-match="true"]')?.getBoundingClientRect();
        const view = held.getBoundingClientRect();
        assert(!mark || (mark.bottom > view.top && mark.top < view.bottom), `A held seek mounted the Find match outside the viewport: mark=${mark?.top}, viewport=${view.top}/${view.bottom}, scroll=${held.scrollTop}, mounted=${held.dataset.mountedStart}/${held.dataset.mountedEnd}`);
      } finally { Object.defineProperty(held, "scrollTop", traced); }
      // Once the viewport can move, the next commit reclaims the match, and
      // that commit's layout must show it at its target. On failure, the
      // states one and two frames later tell a late layout from a wrong one.
      flushSync(() => root.render(pane("Diff after a held seek")));
      if (!diffFindLanded(held, "unstaged 2500", 2500)) {
        const committed = diffFindState(held, 2500);
        await frame();
        const oneFrame = diffFindState(held, 2500);
        await frame();
        throw new Error(`A commit after a held seek did not land Find: ${committed}; +1f ${oneFrame}; +2f ${diffFindState(held, 2500)}`);
      }
    });
  } finally { style.remove(); }
}

// The Find row's distance from a third of the way down the diff rows. The
// rows height is WindowedDiff's own definition; the row comes from layout.
function diffFindRowOffset(viewport) {
  const row = viewport.querySelector('[data-find-match="true"]');
  return row ? row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - diffRowsHeight(viewport) / 3 : Number.NaN;
}

// Where layout put the marked row, split in two: its place in the track
// against its line's position, and the track against the scroll position.
// Both are 0 when the window placed the row where its line belongs.
function diffRowPlacement(viewport) {
  const row = viewport.querySelector('[data-find-match="true"]');
  const track = viewport.firstElementChild;
  if (!row || !track) return null;
  const line = Number(row.querySelector("i")?.textContent) - 1;
  const padding = Number.parseFloat(getComputedStyle(viewport).paddingTop) || 0;
  const trackTop = track.getBoundingClientRect().top;
  return { place: row.getBoundingClientRect().top - trackTop - line * 14, track: trackTop - (viewport.getBoundingClientRect().top + padding - viewport.scrollTop) };
}

// Everything that decides whether Find landed, for a failure message: the
// scroll position against its target, the committed window, the mark, and the
// row's place from layout offsets, which involve no scrolling, beside its
// place from rects, which do.
function diffFindState(viewport, line) {
  const row = viewport.querySelector('[data-find-match="true"]');
  const track = viewport.firstElementChild;
  const spacer = track?.querySelector(".diff-spacer");
  const spacerSize = spacer ? `${spacer.style.height}/${spacer.offsetHeight}` : "none";
  const placement = diffRowPlacement(viewport);
  const fixed = (value) => Number.isFinite(value) ? value.toFixed(2) : String(value);
  return [
    `scroll=${viewport.scrollTop} findTop=${fixed(diffFindTop(viewport, line))}`,
    `box=${viewport.offsetHeight} client=${viewport.clientHeight} scrollHeight=${viewport.scrollHeight}`,
    `first=${viewport.dataset.firstLine} mounted=${viewport.dataset.mountedStart}/${viewport.dataset.mountedEnd}`,
    `mark=${row ? JSON.stringify(row.textContent.trim()) : "none"} row=${fixed(diffFindRowOffset(viewport))}`,
    placement ? `place=${fixed(placement.place)} track=${fixed(placement.track)}` : "place=unmounted",
    `offsetPlace=${row && track ? row.offsetTop - track.offsetTop - line * 14 : "unmounted"}`,
    `spacer=${spacerSize} page=${document.visibilityState}`,
  ].join(" ");
}

// Records what moves a diff viewport, by animation frame: each script write to
// scrollTop and its writer, each scroll event and whether a script write
// explains it, each resize delivery, and each committed window or Find mark
// with the Find row's offset. A failing diff assertion appends the record.
const fixtureNativeFrame = window.requestAnimationFrame.bind(window);
function traceDiffViewport(viewport) {
  const entries = [];
  const writes = [];
  const unexplained = [];
  let frameIndex = 0;
  let firstMarked = null;
  let frameRequest = fixtureNativeFrame(function tick() { frameIndex += 1; frameRequest = fixtureNativeFrame(tick); });
  const native = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  const top = () => native.get.call(viewport);
  const record = (kind, detail) => {
    entries.push(`f${frameIndex} ${kind} ${detail}${document.visibilityState === "visible" ? "" : " [page hidden]"}`);
    if (entries.length > 60) entries.shift();
  };
  const owned = !Object.hasOwn(viewport, "scrollTop");
  if (owned) Object.defineProperty(viewport, "scrollTop", { configurable: true, get: top, set(value) {
    const before = top();
    native.set.call(viewport, value);
    const writer = new Error("trace").stack.split("\n").slice(2).map((line) => line.trim().match(/^at (?:async )?([\w$.]+)/)?.[1]).find(Boolean) ?? "unknown";
    writes.push(top());
    record("write", `${writer} ${before}->${top()} (set ${value})`);
  } });
  const onScroll = (event) => {
    const explained = !event.isTrusted || writes.includes(top());
    if (!explained) unexplained.push(top());
    record("scroll", `${top()}${event.isTrusted ? "" : " synthetic"}${explained ? "" : " WITHOUT A SCRIPT WRITE"}`);
  };
  viewport.addEventListener("scroll", onScroll, true);
  const resize = new ResizeObserver(() => record("resize", `box=${viewport.offsetHeight} client=${viewport.clientHeight}`));
  resize.observe(viewport);
  const commits = new MutationObserver(() => {
    const marked = Boolean(viewport.querySelector('[data-find-match="true"]'));
    const offset = diffFindRowOffset(viewport);
    if (marked && firstMarked == null) firstMarked = offset;
    // The same row after one and two frames tells stale synchronous geometry
    // from a frame that really showed the row elsewhere.
    const placed = (kind) => {
      const placement = diffRowPlacement(viewport);
      record(kind, `first=${viewport.dataset.firstLine} mounted=${viewport.dataset.mountedStart}/${viewport.dataset.mountedEnd} top=${top()} row=${placement ? diffFindRowOffset(viewport).toFixed(2) : "unmounted"}${placement ? ` place=${placement.place.toFixed(2)} track=${placement.track.toFixed(2)}` : ""}`);
    };
    placed("commit");
    if (marked) fixtureNativeFrame(() => { placed("commit+1f"); fixtureNativeFrame(() => placed("commit+2f")); });
  });
  commits.observe(viewport, { attributes: true, childList: true, subtree: true, attributeFilter: ["data-first-line", "data-mounted-start", "data-mounted-end", "data-find-match"] });
  return {
    firstMarkedOffset: () => firstMarked,
    unexplained: () => unexplained,
    text: () => entries.join(" | "),
    stop() {
      window.cancelAnimationFrame(frameRequest);
      viewport.removeEventListener("scroll", onScroll, true);
      resize.disconnect();
      commits.disconnect();
      if (owned) delete viewport.scrollTop;
    },
  };
}
async function withDiffTrace(viewport, run) {
  const trace = traceDiffViewport(viewport);
  try { return await run(trace); }
  catch (error) { throw new Error(`${error.message}; ${navigator.userAgent}; trace: ${trace.text()}`, { cause: error }); }
  finally { trace.stop(); }
}
// Find is ready when the viewport is at the match's target and layout shows
// the match row there, not merely when the row is mounted.
function diffFindLanded(viewport, text, line) {
  return viewport.querySelector('[data-find-match="true"]')?.textContent.includes(text)
    && Math.abs(viewport.scrollTop - diffFindTop(viewport, line)) <= 1
    && Math.abs(diffFindRowOffset(viewport)) < 2;
}

async function diffScrollbarFeedbackRegression() {
  root.render(null); await settle();
  // Classic scrollbars (CI on macOS and Windows) take layout space. A long row
  // mounted at the window edge then shows a horizontal scrollbar that changes
  // the viewport height, which changes the mounted rows in turn. Windows CI
  // also showed a Find that landed beside its target and was moved by a later
  // corrective pass, so the first committed frame must already be final.
  const style = document.createElement("style");
  document.head.append(style);
  let diff = "";
  route = async (url) => {
    if (url.pathname === "/api/git/status") return response({ branch: "main", files: [{ path: "large.txt", status: "MM", index: "M", worktree: "M" }], stagedCount: 1 });
    if (url.pathname === "/api/git/diff") return response({ diff });
    return response({});
  };
  const render = async (long) => {
    diff = Array.from({ length: 5_000 }, (_, index) => index === long ? `+${"x".repeat(400)}\n` : `+line ${index}\n`).join("");
    root.render(null); await settle();
    root.render(<PaneBody style={{ width: 448, height: 600 }}><ChangesPane worktree={projects[0].worktrees[0]} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => { throw error; }} onToast={() => {}} /></PaneBody>);
    await until(() => host.querySelector(".diff-view")?.textContent.includes("line 0"), `diff with a long row at ${long} ready`);
    return host.querySelector(".diff-view");
  };
  const find = async (viewport, trace, label) => {
    const input = host.querySelector('input[aria-label="Find in diff"]');
    setControlValue(input, "line 2500");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => diffFindLanded(viewport, "line 2500", 2500), `${label}: Find landed`);
    assert(Math.abs(trace.firstMarkedOffset()) < 2, `${label}: the first commit that showed the Find row placed it ${trace.firstMarkedOffset()}px from its target`);
    assert(!trace.unexplained().length, `${label}: the browser moved the diff to ${trace.unexplained().join(", ")} without a script write while Find owned it`);
  };
  try {
    for (const size of [15, 17]) {
      style.textContent = `.diff-view::-webkit-scrollbar { width: ${size}px; height: ${size}px; } .diff-view::-webkit-scrollbar-thumb { background: #888; }`;
      const plain = await render(-1); // NOSONAR S9382: each case starts from a fresh viewport
      await withDiffTrace(plain, (trace) => find(plain, trace, `${size}px scrollbars, reference window`)); // NOSONAR S9382: each case starts from a fresh viewport
      for (let index = 0; index < 4; index += 1) await frame(); // NOSONAR S9382: the plain window is the reference for the edge cases
      const start = Number(plain.dataset.mountedStart);
      const end = Number(plain.dataset.mountedEnd);
      for (const long of [-1, start - 2, start - 1, start, start + 1, end - 2, end - 1, end, end + 1]) {
        const viewport = await render(long); // NOSONAR S9382: each case starts from a fresh viewport
        const label = `${size}px scrollbars, long row at ${long}`;
        await withDiffTrace(viewport, async (trace) => { // NOSONAR S9382: each case starts from a fresh viewport
          await find(viewport, trace, label);
          const place = () => `${viewport.scrollTop}:${viewport.clientHeight}:${viewport.dataset.mountedStart}:${viewport.dataset.mountedEnd}`;
          const settled = place();
          for (let index = 0; index <= 20; index += 1) {
            assert(place() === settled, `${label}: the diff window moved ${index} frames after Find landed: ${settled} -> ${place()}`);
            assert(Math.abs(diffFindRowOffset(viewport)) < 2, `${label}: the Find row was ${diffFindRowOffset(viewport)}px from its target ${index} frames after Find landed`);
            if (index < 20) await frame(); // NOSONAR S9382: one sample per frame
          }
          assert(!trace.unexplained().length, `${label}: the browser moved the diff to ${trace.unexplained().join(", ")} without a script write while Find owned it`);
          const row = viewport.querySelector('[data-find-match="true"]').getBoundingClientRect();
          const frameTop = viewport.getBoundingClientRect().top;
          assert(row.top >= frameTop && row.bottom <= frameTop + viewport.clientHeight, `${label}: the Find match was outside the diff viewport`);
        });
      }
    }
  } finally { style.remove(); }
}

// Find, Next and Previous land aligned in the seek itself, and a pane resize
// while Find owns the diff aligns the match before that frame paints, without
// waiting for an animation frame.
async function diffFindResizeRegression() {
  root.render(null); await settle();
  const style = document.createElement("style");
  style.textContent = ".diff-view::-webkit-scrollbar { width: 17px; height: 17px; } .diff-view::-webkit-scrollbar-thumb { background: #888; }";
  document.head.append(style);
  const diff = Array.from({ length: 5_000 }, (_, index) => `-unstaged ${index}\n`).join("");
  const nativeFrame = window.requestAnimationFrame;
  let probe;
  let trace;
  try {
    root.render(<PaneBody style={{ width: 448, height: 600 }}><WindowedDiff diff={diff} label="Resized diff" /></PaneBody>);
    await until(() => host.querySelector(".diff-view")?.textContent.includes("unstaged 0"), "resizable diff ready");
    const viewport = host.querySelector(".diff-view");
    trace = traceDiffViewport(viewport);
    const find = host.querySelector('input[aria-label="Find in diff"]');
    setControlValue(find, "unstaged 31");
    const steps = [
      ["Find", "unstaged 31", () => find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))],
      ["Next", "unstaged 310", () => host.querySelector('[aria-label="Next diff match"]').click()],
      ["Next", "unstaged 311", () => host.querySelector('[aria-label="Next diff match"]').click()],
      ["Previous", "unstaged 310", () => host.querySelector('[aria-label="Previous diff match"]').click()],
    ];
    for (const [name, text, act] of steps) {
      act();
      await until(() => viewport.querySelector('[data-find-match="true"]')?.textContent.endsWith(`-${text}\n`), `${name} reaches ${text}`); // NOSONAR S9382: each navigation waits for its own match
      const top = viewport.scrollTop;
      for (let index = 0; index <= 10; index += 1) {
        assert(Math.abs(diffFindRowOffset(viewport)) < 2 && viewport.scrollTop === top, `${name} to ${text}: the match was ${diffFindRowOffset(viewport)}px from its target, scroll ${top} -> ${viewport.scrollTop}, ${index} frames after it committed`);
        if (index < 10) await frame(); // NOSONAR S9382: one sample per frame
      }
    }
    // Observers deliver in creation order, so this one samples after the
    // diff's own observer in the same delivery, before paint.
    let sample = null;
    probe = new ResizeObserver(() => { sample ??= { offset: diffFindRowOffset(viewport), height: viewport.offsetHeight }; });
    probe.observe(viewport);
    await settle();
    // Animation frames are delayed, so only work done before paint counts.
    window.requestAnimationFrame = (callback) => nativeFrame(() => nativeFrame(() => nativeFrame(callback)));
    // Resize outside React, as a window, font or sibling layout change does.
    const body = host.querySelector(".pane-body");
    for (const [width, height] of [[448, 520], [448, 640], [320, 640]]) {
      sample = null;
      Object.assign(body.style, { width: `${width}px`, height: `${height}px` });
      await until(() => sample, `diff resized to ${width}x${height}`); // NOSONAR S9382: each resize is observed on its own
      assert(Math.abs(sample.offset) < 2, `A resize to ${width}x${height} (${sample.height}px rows) left the Find match ${sample.offset}px from its target in the resize frame`);
      for (let index = 0; index < 10; index += 1) { // NOSONAR S9382: one sample per frame
        await frame();
        assert(Math.abs(diffFindRowOffset(viewport)) < 2, `A resize to ${width}x${height} moved the Find match ${diffFindRowOffset(viewport)}px from its target ${index + 1} frames later`);
      }
    }
  } catch (error) { throw new Error(`${error.message}; ${navigator.userAgent}; trace: ${trace?.text()}`, { cause: error }); }
  finally { window.requestAnimationFrame = nativeFrame; probe?.disconnect(); trace?.stop(); style.remove(); }
}

async function changesMutationOwnerRegression(reject = false, mode = "stage") {
  root.render(null); await settle();
  const pending = deferred();
  const requests = [];
  const errors = [];
  route = async (url) => {
    requests.push(`${url.pathname}:${url.searchParams.get("path") ?? ""}`);
    if (url.pathname === "/api/git/status") return response({ branch: url.searchParams.get("path") === projects[0].worktrees[0].path ? "A branch" : "B branch", files: [{ path: "file.txt", status: mode === "unstage" ? "M " : " M", index: mode === "unstage" ? "M" : " ", worktree: mode === "unstage" ? " " : "M" }], stagedCount: mode === "unstage" ? 1 : 0 });
    if (url.pathname === "/api/git/diff") return response({ diff: "+current\n" });
    if (url.pathname === `/api/git/${mode}`) return pending.promise;
    return response({});
  };
  const pane = (tree) => <PaneBody style={{ width: 448, height: 600 }}><ChangesPane worktree={tree} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => errors.push(error.message)} onToast={() => {}} /></PaneBody>;
  root.render(pane(projects[0].worktrees[0]));
  await until(() => host.querySelector('.pane-toolbar strong')?.textContent === "A branch", "A changes ready");
  host.querySelector(`[aria-label="${mode === "unstage" ? "Unstage" : "Stage"} file.txt"]`).click();
  await until(() => requests.some((item) => item.startsWith(`/api/git/${mode}`)), `A ${mode} pending`);
  root.render(pane(projects[1].worktrees[0]));
  await until(() => host.querySelector('.pane-toolbar strong')?.textContent === "B branch", "B changes ready");
  const bStatusCount = requests.filter((item) => item === `/api/git/status:${projects[1].worktrees[0].path}`).length;
  if (reject) pending.reject(new Error("old A failure")); else pending.resolve(response({ branch: "A branch", files: [], stagedCount: 0 }));
  await settle();
  assert(host.querySelector('.pane-toolbar strong')?.textContent === "B branch", "Late A mutation replaced B status");
  assert(requests.filter((item) => item === `/api/git/status:${projects[1].worktrees[0].path}`).length === bStatusCount, "Late A mutation refreshed B");
  assert(!errors.includes("old A failure"), "Late A failure surfaced in B");
}

async function changesCommitOwnerRegression(reject = false) {
  root.render(null); await settle();
  const pending = deferred();
  const requests = [];
  const errors = [];
  const toasts = [];
  route = async (url) => {
    requests.push(`${url.pathname}:${url.searchParams.get("path") ?? ""}`);
    if (url.pathname === "/api/git/status") return response({ branch: url.searchParams.get("path") === projects[0].worktrees[0].path ? "A branch" : "B branch", files: [{ path: "file.txt", status: "M ", index: "M", worktree: " " }], stagedCount: 1 });
    if (url.pathname === "/api/git/diff") return response({ diff: "+current\n" });
    if (url.pathname === "/api/git/commit") return pending.promise;
    return response({});
  };
  const pane = (tree) => <PaneBody style={{ width: 448, height: 600 }}><ChangesPane worktree={tree} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => errors.push(error.message)} onToast={(message) => toasts.push(message)} /></PaneBody>;
  root.render(pane(projects[0].worktrees[0]));
  await until(() => host.querySelector('.pane-toolbar strong')?.textContent === "A branch", "A commit pane ready");
  setControlValue(host.querySelector('[aria-label="Commit message"]'), "Commit A");
  await settle();
  host.querySelector('.commit-bar button').click();
  await until(() => requests.some((item) => item.startsWith("/api/git/commit")), "A commit pending");
  root.render(pane(projects[1].worktrees[0]));
  await until(() => host.querySelector('.pane-toolbar strong')?.textContent === "B branch", "B commit pane ready");
  const bStatusCount = requests.filter((item) => item === `/api/git/status:${projects[1].worktrees[0].path}`).length;
  if (reject) pending.reject(new Error("old A commit failed")); else pending.resolve(response({ committed: true }));
  await settle();
  assert(host.querySelector('.pane-toolbar strong')?.textContent === "B branch", "Late A commit replaced B status");
  assert(host.querySelector('[aria-label="Commit message"]').value === "", "A commit draft leaked to B");
  assert(requests.filter((item) => item === `/api/git/status:${projects[1].worktrees[0].path}`).length === bStatusCount, "Late A commit refreshed B");
  assert(toasts.length === 0 && errors.length === 0, "Late A commit reported in B");
}

async function productionDiffViewportRegression() {
  root.render(null); await settle();
  const staged = Array.from({ length: 50_000 }, (_, index) => `+staged ${index}\n`).join("");
  const unstaged = Array.from({ length: 50_000 }, (_, index) => `-unstaged ${index}\n`).join("");
  route = async (url) => {
    if (url.pathname === "/api/git/status") return response({ branch: "main", files: [{ path: "huge.txt", status: "MM", index: "M", worktree: "M" }], stagedCount: 1 });
    if (url.pathname === "/api/git/diff") return response({ diff: url.searchParams.get("staged") === "true" ? staged : unstaged });
    return response({});
  };
  root.render(<PaneBody style={{ width: 448, height: 600 }}><ChangesPane worktree={projects[0].worktrees[0]} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => { throw error; }} onToast={() => {}} /></PaneBody>);
  await until(() => host.querySelector('.diff-view')?.textContent.includes("-unstaged 0"), "initial production diff");
  host.querySelector('[aria-label="Diff view"] button[aria-pressed="false"]').click();
  await until(() => host.querySelector('.diff-view')?.textContent.includes("+staged 0"), "staged production diff");
  let viewport = host.querySelector('.diff-view');
  assert(viewport.clientHeight > 0 && viewport.clientHeight < 600, `Production diff viewport grew to ${viewport.clientHeight}px`);
  assert(viewport.querySelectorAll("span").length < 200, "Production diff mounted all staged lines");
  const ordinaryBeforeZoom = viewport.scrollTop;
  assert(viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true })),
    "Ordinary diff intercepted browser zoom");
  assert(viewport.scrollTop === ordinaryBeforeZoom, "Ordinary diff scrolled during browser zoom");
  if (window.__fixtureWheel) {
    viewport.scrollIntoView({ block: "center" });
    await frame();
    const initialRemaining = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    const wheelTrace = [];
    let attemptBudget = 1;
    let minimumProgress = Infinity;
    const wheelBudgetMs = window.__fixtureWheelCap > 0 && window.__fixtureWheelCap <= 1000 ? 300_000 : 120_000;
    const wheelDeadline = Date.now() + wheelBudgetMs;
    let exitReason = "budget-or-deadline";
    for (let step = 0; step < attemptBudget && Date.now() < wheelDeadline; step += 1) {
      // Virtual rows and the browser's scroll geometry can commit after a
      // wheel acknowledgement. Only the settled viewport and final row can
      // establish that native navigation reached the tail.
      await settle();
      if (viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 1) {
        if (viewport.textContent.includes("staged 49999")) { exitReason = "tail-visible"; break; }
        const atEnd = viewport.scrollHeight - viewport.clientHeight;
        for (let pendingFrame = 0; pendingFrame < 8 && viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 1
          && !viewport.textContent.includes("staged 49999"); pendingFrame += 1) await frame();
        if (viewport.textContent.includes("staged 49999")) { exitReason = "tail-visible-after-commit"; break; }
        if (viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 1) {
          exitReason = `physical-end-without-tail:${atEnd}->${viewport.scrollHeight - viewport.clientHeight}`;
          break;
        }
      }
      const bounds = viewport.getBoundingClientRect();
      const before = viewport.scrollTop;
      const delivery = await window.__fixtureWheel(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2, 120_000);
      assert(delivery.viewport === viewport, `Large wheel missed the diff viewport at step ${step}`);
      try { await until(() => viewport.scrollTop > before, `large native wheel scroll at step ${step}`); }
      catch (error) { throw new Error(`${error.message}; trace=${JSON.stringify(wheelTrace)}; delivered=${delivery.deltaY}; canceled=${delivery.defaultPrevented}; physical=${viewport.scrollTop}; logical=${viewport.dataset.firstLine}; mounted=${viewport.dataset.mountedStart}/${viewport.dataset.mountedEnd}`, { cause: error }); }
      await settle();
      const progress = viewport.scrollTop - before;
      const frameBounds = viewport.getBoundingClientRect();
      const mountedRows = viewport.querySelectorAll("span");
      wheelTrace.push({ requested: 120_000, delivered: delivery.deltaY, canceled: delivery.defaultPrevented,
        before, after: viewport.scrollTop, max: viewport.scrollHeight - viewport.clientHeight,
        frame: [frameBounds.top, frameBounds.bottom], logical: viewport.dataset.firstLine,
        mounted: [viewport.dataset.mountedStart, viewport.dataset.mountedEnd],
        row: [mountedRows[0]?.getBoundingClientRect().top, mountedRows[0]?.getBoundingClientRect().bottom] });
      assert(progress > 0 && viewport.querySelectorAll("span").length < 200,
        `Native wheel lost progress or mounted unbounded rows: ${JSON.stringify(wheelTrace)}`);
      minimumProgress = Math.min(minimumProgress, progress);
      const remaining = Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop);
      attemptBudget = Math.min(2048, Math.max(attemptBudget, step + 1 + Math.ceil(remaining / minimumProgress) + 8));
    }
    await settle();
    assert(viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 1 && viewport.textContent.includes("staged 49999"),
      `Native wheels did not reach the staged diff tail: ${JSON.stringify({
        exitReason, initialRemaining, attempts: wheelTrace.length, attemptBudget, elapsedLimitMs: wheelBudgetMs,
        remaining: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
        physical: viewport.scrollTop, logical: viewport.dataset.firstLine,
        mounted: [viewport.dataset.mountedStart, viewport.dataset.mountedEnd], trace: wheelTrace.slice(-16) })}`);
  } else { viewport.scrollTop = viewport.scrollHeight; viewport.dispatchEvent(new Event("scroll")); }
  try { await until(() => viewport.textContent.includes("staged 49999"), "staged final line"); }
  catch (error) { throw new Error(`${error.message}; scroll=${viewport.scrollTop}/${viewport.scrollHeight - viewport.clientHeight}`); }
  if (window.__fixtureWheel) {
    viewport.scrollTop = 200_000;
    await settle();
    const beforeSmallWheel = viewport.scrollTop;
    const frame = viewport.getBoundingClientRect();
    const delivery = await window.__fixtureWheel(frame.left + frame.width / 2, frame.top + frame.height / 2, 14);
    await until(() => viewport.scrollTop > beforeSmallWheel, "ordinary diff small native wheel advanced");
    assert(delivery.viewport === viewport && delivery.defaultPrevented
      && Math.abs(viewport.scrollTop - beforeSmallWheel - Math.min(14, delivery.deltaY)) < 2,
    `Ordinary diff wheel lost its delivered delta: ${JSON.stringify({ beforeSmallWheel, after: viewport.scrollTop, delivered: delivery.deltaY, canceled: delivery.defaultPrevented })}`);
    viewport.focus();
    await window.__fixtureSendKey("End");
    await until(() => viewport.textContent.includes("staged 49999"), "ordinary diff End restores staged tail after wheel");
  }
  host.querySelector('[aria-label="Diff view"] button[aria-pressed="false"]').click();
  await until(() => host.querySelector('.diff-view')?.textContent.includes("-unstaged 0"), "unstaged production diff");
  viewport = host.querySelector('.diff-view');
  viewport.focus();
  if (window.__fixtureSendKey) await window.__fixtureSendKey("End");
  else { viewport.scrollTop = viewport.scrollHeight; viewport.dispatchEvent(new Event("scroll")); }
  try { await until(() => viewport.textContent.includes("unstaged 49999"), "unstaged final line"); }
  catch (error) { throw new Error(`${error.message}; height=${viewport.clientHeight}/${viewport.scrollHeight}; scroll=${viewport.scrollTop}; rows=${viewport.querySelectorAll("span").length}; text=${viewport.textContent.slice(-100)}`); }
  assert(viewport.querySelectorAll("span").length < 200, "Production diff mounted all unstaged lines");
  assert(host.querySelectorAll('[aria-label="Diff view"] button').length === 2, "Mode controls were clipped");
  const find = host.querySelector('input[aria-label="Find in diff"]');
  setControlValue(find, "unstaged 25000");
  await settle();
  find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  // Let the first alignment commit, then deliver a queued native End/scroll.
  // A one-shot layout correction must not give the older key event ownership.
  await settle();
  await settle();
  viewport.scrollTop = viewport.scrollHeight;
  viewport.dispatchEvent(new Event("scroll"));
  await settle();
  const matchIsVisible = () => {
    const mark = viewport.querySelector('[data-find-match="true"]');
    if (!mark?.textContent.includes("unstaged 25000")) return false;
    const row = mark.getBoundingClientRect();
    const bounds = viewport.getBoundingClientRect();
    return row.bottom > bounds.top && row.top < bounds.bottom;
  };
  try { await until(matchIsVisible, "offscreen diff match"); }
  catch (error) { throw new Error(`${error.message}; status=${host.querySelector('.window-find [aria-hidden="true"]')?.textContent}; scroll=${viewport.scrollTop}/${viewport.scrollHeight - viewport.clientHeight}; rows=${[...viewport.querySelectorAll('[data-find-match], span')].slice(0, 3).map((row) => row.textContent.slice(0, 30)).join('|')}; marked=${viewport.querySelector('[data-find-match="true"]')?.textContent.slice(0, 80)}`); }
  assert(viewport.querySelector('[data-find-match="true"]')?.textContent.includes("unstaged 25000"), "Found diff line was not marked");
  assert(viewport.querySelectorAll("span").length < 200, "Finding a diff match mounted all lines");
  await assertFindKeepsOwnership(viewport, "unstaged 25000", "448px pane Find");
  viewport.focus();
  if (window.__fixtureSendKey) await window.__fixtureSendKey("End");
  else { viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })); viewport.scrollTop = viewport.scrollHeight; viewport.dispatchEvent(new Event("scroll")); }
  await until(() => viewport.textContent.includes("unstaged 49999"), "real End takes ownership after Find");
  host.querySelector('[aria-label="Next diff match"]').click();
  await until(matchIsVisible, "Find realigns after a real End key");
  root.render(<PaneBody style={{ width: 320, height: 480 }}><ChangesPane worktree={projects[0].worktrees[0]} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => { throw error; }} onToast={() => {}} /></PaneBody>);
  await settle();
  assert(host.querySelector('.diff-view').clientHeight > 0 && host.querySelector('.diff-view').clientHeight < 480, "Narrow pane lost its bounded diff viewport");
  assert(host.querySelector('.diff-view').querySelectorAll("span").length < 200, "Narrow pane mounted all diff lines");
  await assertFindKeepsOwnership(host.querySelector('.diff-view'), "unstaged 25000", "320px pane Find");
}

async function longTranscriptWindowRegression() {
  root.render(null);
  await settle();
  const messages = Array.from({ length: 1_000 }, (_, index) => ({ id: `message-${index}`, body: `Message ${index}` }));
  const viewport = React.createRef();
  const started = performance.now();
  root.render(<div ref={viewport} style={{ height: 420, overflowY: "auto" }} tabIndex={0} aria-label="Long conversation fixture"><WindowedMessages messages={messages} viewportRef={viewport} renderMessage={(message) => <article data-message-id={message.id} style={{ minHeight: 80, marginBottom: 30 }}>{message.body}</article>} /></div>);
  await until(() => host.querySelectorAll('[role="listitem"]').length > 0 && host.querySelectorAll('[role="listitem"]').length < 40, "bounded initial transcript DOM");
  const mountedAt = performance.now();
  const initialCount = host.querySelectorAll('[role="listitem"]').length;
  viewport.current.scrollTop = viewport.current.scrollHeight;
  viewport.current.dispatchEvent(new Event("scroll"));
  try { await until(() => host.querySelector('[data-message-id="message-999"]'), "last message after long scroll"); }
  catch (error) { throw new Error(`${error.message}; scroll=${viewport.current.scrollTop}/${viewport.current.scrollHeight}, rows=${[...host.querySelectorAll('[data-message-id]')].map((row) => row.dataset.messageId).join(",")}`); }
  assert(host.querySelectorAll('[role="listitem"]').length < 40, "Long scroll mounted the whole transcript");
  viewport.current.scrollTop = 0;
  viewport.current.dispatchEvent(new Event("scroll"));
  await until(() => host.querySelector('[data-message-id="message-0"]'), "first message after return scroll");
  const navigatedAt = performance.now();
  const find = host.querySelector('input[aria-label="Find in conversation"]');
  setControlValue(find, "Message 999");
  await settle();
  find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  try { await until(() => host.querySelector('[data-find-match="true"] [data-message-id="message-999"]'), "last offscreen message found"); }
  catch (error) { throw new Error(`${error.message}; status=${host.querySelector('.history-find .history-find-status')?.textContent}; scroll=${viewport.current.scrollTop}/${viewport.current.scrollHeight}; rows=${[...host.querySelectorAll('[data-message-id]')].map((row) => row.dataset.messageId).join(",")}`); }
  const firstFoundAt = performance.now();
  setControlValue(find, "Message 0");
  await settle();
  find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="message-0"]'), "first offscreen message found");
  assert(host.querySelectorAll('[role="listitem"]').length < 40, "Finding offscreen messages mounted the full transcript");
  assert(document.activeElement !== viewport.current || viewport.current.tabIndex === 0, "Transcript lost keyboard scroll access");
  const elapsedMs = Math.round(performance.now() - started);
  const scrollMs = Math.round(navigatedAt - mountedAt);
  assert(scrollMs < 1_000, `Scrolling the long transcript to both ends exceeded its 1s budget: ${scrollMs}ms`);
  window.__performanceEvidence = { ...(window.__performanceEvidence ?? {}), transcript: {
    elapsedMs, mountMs: Math.round(mountedAt - started), scrollMs,
    findLastMs: Math.round(firstFoundAt - navigatedAt), findFirstMs: Math.round(performance.now() - firstFoundAt),
    mountedAtStart: initialCount, heapBytes: performance.memory?.usedJSHeapSize ?? null,
  } };
}

async function previousFindStartRegression() {
  root.render(null); await settle();
  const viewport = React.createRef();
  const messages = [
    { id: "first", body: "Other" },
    { id: "penultimate", body: "Needle" },
    { id: "last", body: "Needle" },
  ];
  root.render(<div ref={viewport} style={{ height: 350, overflowY: "auto" }}><WindowedMessages
    messages={messages} viewportRef={viewport}
    renderMessage={(message) => <p data-message-id={message.id}>{message.body}</p>}
  /></div>);
  await until(() => host.querySelector('.history-find input'), "local Find ready");
  setControlValue(host.querySelector('.history-find input'), "Needle");
  await settle();
  host.querySelector('[aria-label="Previous conversation match"]').click();
  await until(() => host.querySelector('[data-find-match="true"]'), "initial Previous found a row");
  assert(host.querySelector('[data-find-match="true"] [data-message-id]')?.dataset.messageId === "last",
    "Initial Previous must start at the final matching row");
  setControlValue(host.querySelector('.history-find input'), "Σ");
  messages[0].body = "ΟΣ";
  root.render(<div ref={viewport} style={{ height: 350, overflowY: "auto" }}><WindowedMessages
    messages={[...messages]} viewportRef={viewport}
    renderMessage={(message) => <p data-message-id={message.id}>{message.body}</p>}
  /></div>);
  await settle();
  host.querySelector('[aria-label="Next conversation match"]').click();
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="first"]'), "loaded transcript matches final sigma");
  messages[0].body = "Straße";
  root.render(<div ref={viewport} style={{ height: 350, overflowY: "auto" }}><WindowedMessages
    messages={[...messages]} viewportRef={viewport}
    renderMessage={(message) => <p data-message-id={message.id}>{message.body}</p>}
  /></div>);
  setControlValue(host.querySelector('.history-find input'), "STRASSE");
  await settle();
  host.querySelector('[aria-label="Next conversation match"]').click();
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="first"]'), "loaded transcript matches full case fold");
  messages[0].body = "ﬃ";
  root.render(<div ref={viewport} style={{ height: 350, overflowY: "auto" }}><WindowedMessages
    messages={[...messages]} viewportRef={viewport}
    renderMessage={(message) => <p data-message-id={message.id}>{message.body}</p>}
  /></div>);
  setControlValue(host.querySelector('.history-find input'), "FFI");
  await settle();
  host.querySelector('[aria-label="Next conversation match"]').click();
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="first"]'), "loaded transcript matches a ligature fold");
}

async function assertVariableHeightEdgeScrollOwnership(index, input, viewport) {
  setControlValue(input, String(index)); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector(`[data-find-match="true"] [data-message-id="variable-${index}"]`), `edge match ${index}`);
  for (let frameIndex = 0; frameIndex < 20; frameIndex += 1) await frame();
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
  viewport.scrollTop = index === 0 ? 700 : 0;
  viewport.dispatchEvent(new Event("scroll"));
  await remainsTrue(() => index === 0 ? viewport.scrollTop > 500 : viewport.scrollTop < 50,
    350, `Edge match ${index} kept snapping the reader back after the scroll gesture`);
}

async function assertVariableHeightFindResize(viewport, visible) {
  const initialWidth = viewport.clientWidth;
  viewport.style.width = "180px";
  await until(() => viewport.clientWidth < initialWidth - 20, "Find viewport narrowed");
  await settle(); await settle();
  assert(visible(), "Width-only wrapping displaced the found message");
  viewport.style.width = "";
  await until(() => viewport.clientWidth > 200, "Find viewport width restored");
  await settle(); await settle();
  assert(visible(), "Restoring viewport width lost the found message");
  viewport.style.height = "720px";
  await until(() => viewport.clientHeight > 700, "Find viewport grew");
  await settle(); await settle();
  assert(visible(), "Growing the viewport lost the found message beyond the old overscan");
  viewport.style.height = "300px";
  await until(() => viewport.clientHeight < 320, "Find viewport shrank");
  await settle(); await settle();
  assert(visible(), "Viewport resize lost the found message");
}

async function variableHeightFindAnchorRegression() {
  root.render(null); await settle();
  const viewport = React.createRef();
  const messages = Array.from({ length: 200 }, (_, index) => ({ id: `variable-${index}`, body: `Variable ${index}`, height: index % 3 === 0 ? 360 : 54 }));
  messages[99].body += ` ${"wrapping text ".repeat(150)}`;
  const render = (rows) => <div><div ref={viewport} style={{ height: 420, overflowY: "auto" }} tabIndex={0}><WindowedMessages messages={rows} viewportRef={viewport} onFind={(query) => `variable-${Number(query)}`} renderMessage={(message) => <article data-message-id={message.id} style={{ minHeight: message.height }}>{message.body}</article>} /></div><div data-slot="scroll-area-scrollbar" /></div>;
  root.render(render(messages));
  await until(() => host.querySelector('.history-find input'), "variable-height find ready");
  const input = host.querySelector('.history-find input');
  setControlValue(input, "100"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="variable-100"]'), "variable-height target mounted");
  await settle(); await settle();
  const visible = () => { const row = host.querySelector('[data-find-match="true"]'); const bounds = row?.getBoundingClientRect(); const area = viewport.current.getBoundingClientRect(); return bounds && bounds.top >= area.top && bounds.top < area.bottom; };
  assert(visible(), "Measured tall rows displaced the found message");
  assert(host.querySelectorAll('[role="listitem"]').length < 40, "Variable-height find mounted too many rows");
  await assertVariableHeightFindResize(viewport.current, visible);
  viewport.current.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
  viewport.current.scrollTop = 0; viewport.current.dispatchEvent(new Event("scroll"));
  await settle();
  root.render(render([...messages, { id: "variable-200", body: "new", height: 360 }]));
  await settle();
  assert(viewport.current.scrollTop < 50, "Live append snapped back to an old find target after user scrolling");
  for (const index of [0, 200]) {
    await assertVariableHeightEdgeScrollOwnership(index, input, viewport.current); // NOSONAR S9382: edge checks share one scrolled viewport
  }
  setControlValue(input, "100"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="variable-100"]'), "thumb cancellation target");
  host.querySelector('[data-slot="scroll-area-scrollbar"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  viewport.current.scrollTop = 0; viewport.current.dispatchEvent(new Event("scroll"));
  await settle(); await settle();
  assert(viewport.current.scrollTop < 50, "Scrollbar thumb interaction lost the reader's scroll position");
}

function physicallyVisibleWithin(element, viewport) {
  if (!element) return false;
  const mark = element.getBoundingClientRect();
  const bounds = viewport.getBoundingClientRect();
  return mark.bottom > bounds.top && mark.top < bounds.bottom;
}

async function largeDiffWindowRegression() {
  root.render(null);
  await settle();
  const diff = Array.from({ length: 50_000 }, (_, index) => `+line ${index}\n`).join("");
  const started = performance.now();
  root.render(<div style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", height: 420 }}><WindowedDiff diff={diff} label="Large diff fixture" /></div>);
  await until(() => host.querySelector(".diff-view")?.querySelectorAll("span").length > 0, "large diff initial rows");
  const viewport = host.querySelector(".diff-view");
  assert(viewport.querySelectorAll("span").length < 200, "Large diff mounted every line");
  viewport.scrollTop = viewport.scrollHeight;
  viewport.dispatchEvent(new Event("scroll"));
  await until(() => viewport.textContent.includes("+line 49999"), "last diff line after scroll");
  assert(viewport.querySelectorAll("span").length < 200, "Large diff scroll mounted every line");
  const elapsedMs = Math.round(performance.now() - started);
  const find = host.querySelector('input[aria-label="Find in diff"]');
  setControlValue(find, "line 35000"); await settle();
  find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => viewport.querySelector('[data-find-match="true"]')?.textContent.includes("line 35000"), "ordinary diff Find match");
  for (let tick = 0; tick < 16; tick += 1) await frame(); // NOSONAR S9382: waits for successive animation frames
  const ordinaryHeight = viewport.clientHeight;
  root.render(<div style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", height: 300 }}><WindowedDiff diff={diff} label="Large diff fixture" /></div>);
  await until(() => viewport.clientHeight < ordinaryHeight - 40, "ordinary diff resized after Find settled");
  await until(() => physicallyVisibleWithin(viewport.querySelector('[data-find-match="true"]'), viewport),
    "ordinary diff Find remains physically visible after resize");
  window.__performanceEvidence = { ...(window.__performanceEvidence ?? {}), diff: { elapsedMs, mountedAtEnd: viewport.querySelectorAll("span").length, heapBytes: performance.memory?.usedJSHeapSize ?? null } };
}

// Find owns the diff viewport until a user gesture or a new query. A scroll
// queued long after the seek settled, as a native End can be on a slow host,
// must bring the match back and keep it there, with bounded commits a frame.
async function assertFindKeepsOwnership(viewport, text, label) {
  await withDiffTrace(viewport, () => findKeepsOwnership(viewport, text, label));
}
async function findKeepsOwnership(viewport, text, label) {
  const matchShown = () => {
    const mark = viewport.querySelector('[data-find-match="true"]');
    if (!mark?.textContent.includes(text)) return false;
    const row = mark.getBoundingClientRect();
    const view = viewport.getBoundingClientRect();
    return row.bottom > view.top && row.top < view.bottom;
  };
  const describe = () => `scroll=${viewport.scrollTop}/${viewport.scrollHeight - viewport.clientHeight}; first=${viewport.dataset.firstLine}; mounted=${viewport.dataset.mountedStart}/${viewport.dataset.mountedEnd}; marked=${viewport.querySelector('[data-find-match="true"]')?.textContent.slice(0, 40)}`;
  for (let tick = 0; tick < 16; tick += 1) await frame(); // NOSONAR S9382: outlasts the old 12-frame settling budget
  assert(matchShown(), `${label}: the match was not shown before the late scroll; ${describe()}`);
  let commits = 0;
  let peak = 0;
  const observer = new MutationObserver((records) => { commits += records.filter((record) => record.attributeName === "data-first-line").length; });
  observer.observe(viewport, { attributes: true, attributeFilter: ["data-first-line"] });
  try {
    viewport.scrollTop = viewport.scrollHeight;
    viewport.dispatchEvent(new Event("scroll"));
    let realigned = false;
    for (let tick = 0; tick < 60 && !realigned; tick += 1) { // NOSONAR S9382: one sample per frame
      await frame();
      await Promise.resolve();
      peak = Math.max(peak, commits); commits = 0;
      realigned = matchShown();
    }
    assert(realigned, `${label}: a late queued scroll took the match out of view; ${describe()}`);
    for (let tick = 0; tick < 10; tick += 1) { // NOSONAR S9382: one sample per frame
      await frame();
      await Promise.resolve();
      peak = Math.max(peak, commits); commits = 0;
      assert(matchShown(), `${label}: the match left the view ${tick + 1} frames after realigning; ${describe()}`);
    }
  } finally { observer.disconnect(); }
  assert(peak <= 9, `${label}: ${peak} window commits in one frame`);
}

async function awaitPhysicalCompressedMatch(viewport, text, label) {
  try {
    await until(() => {
      const mark = viewport.querySelector('[data-find-match="true"]');
      if (!mark?.textContent.includes(text)) return false;
      const row = mark.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      return row.top < view.bottom && row.bottom > view.top;
    }, label);
  } catch (error) {
    const row = viewport.querySelector('[data-find-match="true"]')?.getBoundingClientRect();
    const view = viewport.getBoundingClientRect();
    throw new Error(`${error.message}; mark=${row?.top}/${row?.bottom}, viewport=${view.top}/${view.bottom}, scroll=${viewport.scrollTop}/${viewport.scrollHeight}, first=${viewport.dataset.firstLine}, mounted=${viewport.dataset.mountedStart}/${viewport.dataset.mountedEnd}`);
  }
}

async function extremeDiffHeightRegression() {
  root.render(null); await settle();
  const diff = "+\n".repeat(600_000) + "+MIDDLE MATCH\n" + "+\n".repeat(650_000) + "+TAIL MATCH\n";
  root.render(<div style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", height: 420 }}><WindowedDiff diff={diff} label="Tall diff" /></div>);
  await until(() => host.querySelector(".diff-view"), "tall diff mounted");
  const viewport = host.querySelector(".diff-view");
  assert(viewport.scrollHeight < 16_000_000, `Tall diff track was clamped: ${viewport.scrollHeight}px`);
  const stickyInset = () => viewport.firstElementChild?.firstElementChild?.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
  assert(Math.abs(stickyInset() - parseFloat(getComputedStyle(viewport).paddingTop)) < 1,
    `Compressed diff lost its top inset before scrolling: inset=${stickyInset()}`);
  viewport.scrollTop = viewport.scrollHeight;
  viewport.dispatchEvent(new Event("scroll"));
  await until(() => viewport.textContent.includes("TAIL MATCH"), "End reaches final line of tall diff");
  assert(Math.abs(stickyInset() - parseFloat(getComputedStyle(viewport).paddingTop)) < 1,
    `Compressed diff lost its top inset after scrolling: inset=${stickyInset()}`);
  assert(viewport.querySelectorAll("span").length < 200, "Tall diff mounted an unbounded line window");
  viewport.scrollTop = 0; viewport.dispatchEvent(new Event("scroll")); await settle();
  // Safari can report a negative physical position during top-edge bounce.
  // The virtual window must never turn that into a negative line index.
  Object.defineProperty(viewport, "scrollTop", { configurable: true, get: () => -14, set: () => {} });
  try {
    viewport.dispatchEvent(new Event("scroll"));
    await settle();
    assert(Number(viewport.dataset.firstLine) === 0 && Number(viewport.dataset.mountedStart) === 0
      && viewport.textContent.includes("+"), "Top-edge overscroll mounted a negative diff row");
  } finally { delete viewport.scrollTop; }
  viewport.dispatchEvent(new Event("scroll")); await settle();
  const input = host.querySelector('input[aria-label="Find in diff"]');
  setControlValue(input, "MIDDLE MATCH"); await settle();
  // Hold the physical scrollbar for one commit, as a browser can do while a
  // large track relayout settles. The mounted Find row must use the observed
  // viewport position even when the logical seek is already committed.
  const nativeScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  let holdPhysicalScroll = true;
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => nativeScrollTop.get.call(viewport),
    set: (value) => { if (!holdPhysicalScroll) nativeScrollTop.set.call(viewport, value); },
  });
  try {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => viewport.querySelector('[data-find-match="true"]')?.textContent.includes("MIDDLE MATCH"), "Find reaches the middle of compressed diff");
    const mark = viewport.querySelector('[data-find-match="true"]').getBoundingClientRect();
    const view = viewport.getBoundingClientRect();
    assert(mark.top < view.bottom && mark.bottom > view.top,
      `Pending compressed Find placed its row at an unobserved scroll position: mark=${mark.top}/${mark.bottom}, viewport=${view.top}/${view.bottom}, scroll=${viewport.scrollTop}, first=${viewport.dataset.firstLine}, mounted=${viewport.dataset.mountedStart}/${viewport.dataset.mountedEnd}, rowTop=${viewport.firstElementChild?.firstElementChild?.style.top}`);
  } finally {
    holdPhysicalScroll = false;
    delete viewport.scrollTop;
  }
  await awaitPhysicalCompressedMatch(viewport, "MIDDLE MATCH", "middle compressed diff alignment");
  let middleBounds = viewport.querySelector('[data-find-match="true"]').getBoundingClientRect();
  assert(middleBounds.top < viewport.getBoundingClientRect().bottom && middleBounds.bottom > viewport.getBoundingClientRect().top, "Middle compressed diff match was mounted outside the viewport");
  await assertFindKeepsOwnership(viewport, "MIDDLE MATCH", "compressed Find");
  root.render(<div style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", height: 420 }}><WindowedDiff diff={"+\n".repeat(10_000) + diff} label="Tall diff" /></div>);
  await until(() => viewport.querySelector('[data-find-match="true"]')?.textContent.includes("MIDDLE MATCH") && host.querySelector('.window-find [role="status"]')?.textContent === "Line 610001", "Refresh realigns a moved middle match");
  await awaitPhysicalCompressedMatch(viewport, "MIDDLE MATCH", "refreshed compressed diff alignment");
  middleBounds = viewport.querySelector('[data-find-match="true"]').getBoundingClientRect();
  assert(middleBounds.top < viewport.getBoundingClientRect().bottom && middleBounds.bottom > viewport.getBoundingClientRect().top, "Refreshed compressed diff match was outside the viewport");
  setControlValue(input, "TAIL MATCH"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => viewport.querySelector('[data-find-match="true"]')?.textContent.includes("TAIL MATCH"), "Find reaches final line of tall diff");
  await awaitPhysicalCompressedMatch(viewport, "TAIL MATCH", "compressed tail Find alignment");
  const bounds = viewport.querySelector('[data-find-match="true"]').getBoundingClientRect();
  assert(bounds.top < viewport.getBoundingClientRect().bottom && bounds.bottom > viewport.getBoundingClientRect().top, `Tall diff find mark is outside the viewport: mark=${bounds.top}/${bounds.bottom}, viewport=${viewport.getBoundingClientRect().top}/${viewport.getBoundingClientRect().bottom}, scroll=${viewport.scrollTop}/${viewport.scrollHeight}`);
  for (let tick = 0; tick < 16; tick += 1) await frame(); // NOSONAR S9382: waits for successive animation frames
  const compressedHeight = viewport.clientHeight;
  root.render(<div style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", height: 300 }}><WindowedDiff diff={"+\n".repeat(10_000) + diff} label="Tall diff" /></div>);
  await until(() => viewport.clientHeight < compressedHeight - 40 && viewport.querySelector('[data-find-match="true"]')?.textContent.includes("TAIL MATCH"), "tail Find survives compressed resize");
  for (let tick = 0; tick < 4; tick += 1) await frame();
  const resizedTail = viewport.querySelector('[data-find-match="true"]').getBoundingClientRect();
  const resizedTrack = viewport.getBoundingClientRect();
  assert(resizedTail.top < resizedTrack.bottom && resizedTail.bottom > resizedTrack.top,
    `Compressed tail Find lost physical alignment after resize: mark=${resizedTail.top}, viewport=${resizedTrack.top}/${resizedTrack.bottom}, scroll=${viewport.scrollTop}/${viewport.scrollHeight}, first=${viewport.dataset.firstLine}, mounted=${viewport.dataset.mountedStart}/${viewport.dataset.mountedEnd}`);
  viewport.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  viewport.scrollTop = 0;
  viewport.dispatchEvent(new Event("scroll"));
  await until(() => Number(viewport.dataset.firstLine) < 100, "scrollbar takes compressed diff ownership after Find");
  host.querySelector('[aria-label="Next diff match"]').click();
  await until(() => {
    const mark = viewport.querySelector('[data-find-match="true"]')?.getBoundingClientRect();
    const view = viewport.getBoundingClientRect();
    return mark && mark.top < view.bottom && mark.bottom > view.top;
  }, "Find returns to tail after scrollbar movement");
  root.render(<div style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", height: 300 }}><WindowedDiff diff={"+\n".repeat(1_250_000)} label="Tall diff" /></div>);
  await until(() => host.querySelector('.window-find [role="status"]')?.textContent === "No match", "removed match clears Find state");
  viewport.scrollTop = 0;
  viewport.dispatchEvent(new Event("scroll"));
  await until(() => Number(viewport.dataset.firstLine) < 100, "removed match releases the old virtual window");
  root.render(<div style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", height: 420 }}><WindowedDiff diff={null} label="Empty diff" /></div>);
  await until(() => host.querySelector(".diff-empty"), "nullable diff shows its empty state");
  await compressedDiffTailRegression();
  await nearLimitCompressedDiffRegression();
}

// Classic scrollbars take layout space. Long rows at the end of a compressed
// diff show a horizontal one there, and End, a wheel and Find must still show
// the final row whole above it.
async function compressedDiffTailRegression() {
  const style = document.createElement("style");
  style.textContent = ".diff-view::-webkit-scrollbar { width: 17px; height: 17px; } .diff-view::-webkit-scrollbar-thumb { background: #888; }";
  document.head.append(style);
  const diff = "+\n".repeat(600_000) + `+${"x".repeat(400)}\n`.repeat(60) + "+FINAL LINE\n";
  try {
    root.render(null); await settle();
    root.render(<div style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", height: 280 }}><WindowedDiff diff={diff} label="Tall diff with long tail rows" /></div>);
    await until(() => host.querySelector(".diff-view")?.scrollHeight > 1_000_000, "compressed diff with long tail rows");
    const viewport = host.querySelector(".diff-view");
    const finalShown = (label) => {
      const row = [...viewport.querySelectorAll("span")].find((item) => item.textContent.includes("FINAL LINE"))?.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      assert(viewport.clientHeight < viewport.offsetHeight, `${label}: no horizontal scrollbar showed at the tail (${viewport.clientHeight}/${viewport.offsetHeight})`);
      assert(row && row.top >= view.top && row.bottom <= view.top + viewport.clientHeight + 0.5,
        `${label}: the final row was not shown whole: row=${row?.top}/${row?.bottom}, viewport=${view.top}/${view.top + viewport.clientHeight}, first=${viewport.dataset.firstLine}, mounted=${viewport.dataset.mountedStart}/${viewport.dataset.mountedEnd}`);
    };
    const reachTail = async (act, label) => {
      pressKey(viewport, "Home");
      await until(() => Number(viewport.dataset.firstLine) === 0, `${label}: back at the start`); // NOSONAR S9382: each route starts at the top
      act();
      await until(() => viewport.textContent.includes("FINAL LINE"), `${label}: reaches the final line`); // NOSONAR S9382: each route is observed on its own
      await settle(); // NOSONAR S9382: the horizontal scrollbar shows after the tail rows mount
      finalShown(label);
    };
    viewport.focus();
    await reachTail(() => pressKey(viewport, "End"), "End");
    await reachTail(() => viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 14 * 1_000_000, bubbles: true, cancelable: true })), "A wheel to the end");
    const input = host.querySelector('input[aria-label="Find in diff"]');
    await reachTail(() => {
      setControlValue(input, "FINAL LINE");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, "Find of the final line");
  } finally { style.remove(); }
}

async function nearLimitCompressedDiffRegression() {
  const nearLimit = "+\n".repeat(2_900_000) + `+WHEEL A ${"x".repeat(1_000)}\n+WHEEL B\n` + "+\n".repeat(2_899_998) + "+NEAR LIMIT TAIL\n";
  const heapBefore = performance.memory?.usedJSHeapSize ?? null;
  root.render(<div style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", height: 420 }}><WindowedDiff diff={nearLimit} label="Near-limit diff" /></div>);
  await until(() => host.querySelector('.diff-view')?.scrollHeight > 1_000_000, "near-limit diff track mounted");
  const nearViewport = host.querySelector('.diff-view');
  assert(nearViewport.scrollHeight < 16_000_000, "near-limit diff exceeded browser scroll geometry");
  const compressedBeforeZoom = nearViewport.scrollTop;
  assert(nearViewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, ctrlKey: true, bubbles: true, cancelable: true })),
    "Compressed diff intercepted browser zoom");
  assert(nearViewport.scrollTop === compressedBeforeZoom, "Compressed diff scrolled during browser zoom");
  const nearInput = host.querySelector('input[aria-label="Find in diff"]');
  setControlValue(nearInput, "WHEEL A"); await settle();
  nearInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => nearViewport.querySelector('[data-find-match="true"]')?.textContent.includes("WHEEL A"), "near-limit middle marker visible");
  const nearHeight = nearViewport.clientHeight;
  root.render(<div style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", height: 360 }}><WindowedDiff diff={nearLimit} label="Near-limit diff" /></div>);
  await until(() => nearViewport.clientHeight < nearHeight - 20 && nearViewport.querySelector('[data-find-match="true"]')?.textContent.includes("WHEEL A"), "refreshed diff resized");
  for (let tick = 0; tick < 4; tick += 1) await frame();
  const resizedMark = nearViewport.querySelector('[data-find-match="true"]').getBoundingClientRect();
  const resizedViewport = nearViewport.getBoundingClientRect();
  assert(resizedMark.top < resizedViewport.bottom && resizedMark.bottom > resizedViewport.top, "resizing a refreshed compressed diff lost its matched line");
  await settle();
  const beforeWheel = nearViewport.querySelector('[data-find-match="true"]').getBoundingClientRect().top;
  nearViewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 14, bubbles: true, cancelable: true }));
  await until(() => nearViewport.querySelector('[data-find-match="true"]')?.getBoundingClientRect().top < beforeWheel - 5, "compressed wheel advanced one logical line");
  assert(Math.abs(nearViewport.querySelector('[data-find-match="true"]').getBoundingClientRect().top - beforeWheel + 14) < 5, "Compressed wheel skipped logical lines");
  const beforeBatch = nearViewport.querySelector('[data-find-match="true"]').getBoundingClientRect().top;
  const wheelTrace = [];
  for (let step = 0; step < 3; step += 1) {
    nearViewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 14, bubbles: true, cancelable: true }));
    wheelTrace.push({ top: nearViewport.scrollTop, first: nearViewport.dataset.firstLine,
      mounted: [nearViewport.dataset.mountedStart, nearViewport.dataset.mountedEnd] });
  }
  try {
    await until(() => nearViewport.querySelector('[data-find-match="true"]')?.getBoundingClientRect().top < beforeBatch - 35, "batched wheels advanced three logical lines");
  } catch (error) {
    throw new Error(`Batched diff wheel lost a logical line: ${JSON.stringify({ beforeBatch, after: nearViewport.querySelector('[data-find-match="true"]')?.getBoundingClientRect().top,
      physicalTop: nearViewport.scrollTop, first: nearViewport.dataset.firstLine, mounted: [nearViewport.dataset.mountedStart, nearViewport.dataset.mountedEnd], wheelTrace })}`, { cause: error });
  }
  assert(Math.abs(nearViewport.querySelector('[data-find-match="true"]').getBoundingClientRect().top - beforeBatch + 42) < 5, "Batched wheels skipped or doubled logical lines");
  // Model an asynchronous native default queued during capture. Record both
  // coordinate systems even if cancellation succeeds but row placement drifts.
  const beforeEarlyDefault = nearViewport.querySelector('[data-find-match="true"]').getBoundingClientRect().top;
  const beforeEarlyCoordinates = { physical: nearViewport.scrollTop, logical: nearViewport.dataset.firstLine,
    mounted: [nearViewport.dataset.mountedStart, nearViewport.dataset.mountedEnd], rowTop: nearViewport.firstElementChild?.firstElementChild?.getBoundingClientRect().top };
  let earlyDefaultQueued = false;
  const queueEarlyDefault = (event) => { if (!event.defaultPrevented) earlyDefaultQueued = true; };
  nearViewport.addEventListener("wheel", queueEarlyDefault, { capture: true });
  nearViewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 14, bubbles: true, cancelable: true }));
  nearViewport.removeEventListener("wheel", queueEarlyDefault, { capture: true });
  if (earlyDefaultQueued) nearViewport.scrollTop += 14;
  await settle();
  assert(!earlyDefaultQueued && Math.abs(nearViewport.querySelector('[data-find-match="true"]').getBoundingClientRect().top - beforeEarlyDefault + 14) < 5,
    `Compressed wheel displaced the Find mark: queued=${earlyDefaultQueued}, before=${beforeEarlyDefault}, after=${nearViewport.querySelector('[data-find-match="true"]').getBoundingClientRect().top}, beforeCoordinates=${JSON.stringify(beforeEarlyCoordinates)}, afterCoordinates=${JSON.stringify({ physical: nearViewport.scrollTop, logical: nearViewport.dataset.firstLine, mounted: [nearViewport.dataset.mountedStart, nearViewport.dataset.mountedEnd], rowTop: nearViewport.firstElementChild?.firstElementChild?.getBoundingClientRect().top })}`);
  if (window.__fixtureWheel) {
    nearViewport.scrollIntoView({ block: "center" });
    await frame();
    const area = nearViewport.getBoundingClientRect();
    const beforeNative = nearViewport.querySelector('[data-find-match="true"]').getBoundingClientRect().top;
    const delivery = await window.__fixtureWheel(area.left + area.width / 2, area.top + area.height / 2, 14, 80);
    assert(delivery.viewport === nearViewport && delivery.defaultPrevented,
      `Native compressed wheel was not canceled at its target: ${JSON.stringify({ target: delivery.viewport?.className, canceled: delivery.defaultPrevented })}`);
    await until(() => nearViewport.querySelector('[data-find-match="true"]')?.getBoundingClientRect().top < beforeNative - 5, "native compressed wheel advanced");
    await settle();
    assert(Math.abs(nearViewport.querySelector('[data-find-match="true"]').getBoundingClientRect().top - beforeNative + 14) < 5, "Native wheel also performed a passive default scroll");
    assert(nearViewport.scrollLeft > 0, "Combined horizontal wheel navigation was lost");
  }
  nearViewport.scrollTop = nearViewport.scrollHeight;
  nearViewport.dispatchEvent(new Event("scroll"));
  await until(() => nearViewport.textContent.includes("NEAR LIMIT TAIL"), "near-limit End reaches the final line");
  nearViewport.scrollTop = 0; nearViewport.dispatchEvent(new Event("scroll"));
  setControlValue(nearInput, "NEAR LIMIT TAIL"); await settle();
  nearInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => nearViewport.querySelector('[data-find-match="true"]')?.textContent.includes("NEAR LIMIT TAIL"), "near-limit Find reaches the final line");
  assert(nearViewport.querySelectorAll("span").length < 200, "near-limit diff mounted unbounded rows");
  window.__performanceEvidence = { ...(window.__performanceEvidence ?? {}), nearLimitDiff: { bytes: nearLimit.length, lines: 5_800_001, heapBefore, heapAfter: performance.memory?.usedJSHeapSize ?? null, mountedAtEnd: nearViewport.querySelectorAll("span").length } };
}

async function unicodeDiffFindRegression() {
  root.render(null); await settle();
  const diff = "+İstanbul\n" + Array.from({ length: 400 }, (_, index) => `+filler ${index}\n`).join("") + "+CAFÉ target\n+ΟΣ final\n+ΑΣΑ medial\n+I token\n+Straße token\n+ﬃ ligature\n";
  root.render(<div style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", height: 420 }}><WindowedDiff diff={diff} label="Unicode diff" /></div>);
  await until(() => host.querySelector('input[aria-label="Find in diff"]'), "Unicode diff find ready");
  const input = host.querySelector('input[aria-label="Find in diff"]');
  setControlValue(input, "café"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('.diff-view [data-find-match="true"]')?.textContent.includes("CAFÉ target"), "Unicode match on the correct diff line");
  await until(() => host.querySelector('.window-find [role="status"]')?.textContent === "Line 402", "Unicode find announcement settled");
  assert(host.querySelector('.window-find [role="status"]')?.textContent === "Line 402", "Unicode case folding shifted the diff line coordinate");
  setControlValue(input, "Σ"); await settle();
  host.querySelector('[aria-label="Next diff match"]').click();
  await until(() => host.querySelector('.diff-view [data-find-match="true"]')?.textContent.includes("ΟΣ final"), "diff Find matches final sigma");
  host.querySelector('[aria-label="Next diff match"]').click();
  await until(() => host.querySelector('.diff-view [data-find-match="true"]')?.textContent.includes("ΑΣΑ medial"), "diff Find matches medial sigma");
  host.querySelector('[aria-label="Next diff match"]').click();
  await until(() => host.querySelector('.diff-view [data-find-match="true"]')?.textContent.includes("ΟΣ final"), "diff Find wraps sigma forms");
  setControlValue(input, "STRASSE"); await settle();
  host.querySelector('[aria-label="Next diff match"]').click();
  await until(() => host.querySelector('.diff-view [data-find-match="true"]')?.textContent.includes("Straße token"), "diff Find matches expanding case fold");
  setControlValue(input, "FFI"); await settle();
  host.querySelector('[aria-label="Next diff match"]').click();
  await until(() => host.querySelector('.diff-view [data-find-match="true"]')?.textContent.includes("ﬃ ligature"), "diff Find matches a ligature fold");
  setControlValue(input, "i token"); await settle();
  host.querySelector('[aria-label="Next diff match"]').click();
  await until(() => host.querySelector('.diff-view [data-find-match="true"]')?.textContent.includes("I token"), "diff Find ignores host locale");
}

async function reverseDiffFindWrapRegression() {
  root.render(null); await settle();
  root.render(<div style={{ height: 420 }}><WindowedDiff diff={"needle first\nneedle middle\nneedle last\n"} label="Reverse Find diff" /></div>);
  await until(() => host.querySelector('input[aria-label="Find in diff"]'), "reverse Find ready");
  const input = host.querySelector('input[aria-label="Find in diff"]');
  setControlValue(input, "needle"); await settle();
  const next = host.querySelector('[aria-label="Next diff match"]');
  const previous = host.querySelector('[aria-label="Previous diff match"]');
  next.click();
  await until(() => host.querySelector('.diff-view [data-find-match="true"]')?.textContent.includes("first"), "first diff match");
  previous.click();
  await until(() => host.querySelector('.diff-view [data-find-match="true"]')?.textContent.includes("last"), "Previous wraps from offset zero to the final match");
  previous.click();
  await until(() => host.querySelector('.diff-view [data-find-match="true"]')?.textContent.includes("middle"), "Previous continues from the wrapped match");
}

async function manyWorktreeSessionRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-W0" : index === 1 ? "W0" : "A"));
  const worktrees = Array.from({ length: 200 }, (_, index) => ({ id: `W${index}`, name: `Tree ${index}`, path: `/fixture/A/W${index}`, branch: `branch-${index}`, changedCount: 0 }));
  const project = { ...projects[0], worktrees };
  const conversationFor = (id) => ({ id: `chat-${id}`, title: `Chat ${id}`, projectId: "A", worktreeId: id, worktreePath: `/fixture/A/${id}`, provider: "codex", messages: [{ id: `message-${id}`, role: "assistant", kind: "text", body: `Output for ${id}`, createdAt: "2026-09-26T00:00:00Z" }], runs: [] });
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [project], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [conversationFor(url.searchParams.get("worktreeId"))] });
    const id = url.pathname.match(/^\/api\/conversations\/chat-(W\d+)$/)?.[1];
    if (id) return response(conversationFor(id));
    return response({});
  };
  const started = performance.now();
  const heapBefore = performance.memory?.usedJSHeapSize ?? null;
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('#chat-tab-chat-W0[aria-selected="true"]'), "initial many-worktree chat");
  let heapAtHalf = null;
  let slowestSwitchMs = 0;
  for (let index = 0; index < 16; index += 1) {
    const id = index % 2 ? "W0" : "W199";
    const target = [...host.querySelectorAll(".worktree-row")].find((row) => row.textContent.includes(`Tree ${Number(id.slice(1))}`));
    assert(target, `Missing ${id} in worktree navigation`);
    const switchStarted = performance.now();
    target.click();
    await until(() => host.querySelector(`#chat-tab-chat-${id}[aria-selected="true"]`) && host.querySelector(`[data-message-id="message-${id}"]`), `selected ${id} chat`);
    slowestSwitchMs = Math.max(slowestSwitchMs, performance.now() - switchStarted);
    assert(host.querySelectorAll(".message-scroll").length === 1 && host.querySelectorAll("[data-message-id]").length === 1, "Worktree navigation accumulated hidden conversations");
    if (index === 7) heapAtHalf = performance.memory?.usedJSHeapSize ?? null;
  }
  const input = host.querySelector('textarea[aria-label="Message the agent"]');
  const inputStarted = performance.now();
  setControlValue(input, "Responsive after switching worktrees");
  await frame();
  const inputFrameMs = Math.round(performance.now() - inputStarted);
  assert(host.querySelectorAll(".worktree-row").length === 200, "Fixture did not exercise all worktree rows");
  const elapsedMs = Math.round(performance.now() - started);
  const heapAfter = performance.memory?.usedJSHeapSize ?? null;
  assert(slowestSwitchMs < 1500, `A 200-worktree navigation exceeded its 1.5s response budget: ${slowestSwitchMs.toFixed(0)}ms`);
  assert(inputFrameMs < 250, `Many-worktree input missed its frame budget after ${elapsedMs}ms of navigation: ${inputFrameMs}ms`);
  if (heapBefore !== null && heapAfter !== null) assert(heapAfter - heapBefore < 64 * 1024 * 1024, "Repeated worktree switches grew the heap without bound");
  window.__performanceEvidence = { ...window.__performanceEvidence, worktrees: { count: 200, switches: 16, elapsedMs, slowestSwitchMs, inputFrameMs, heapBefore, heapAtHalf, heapAfter } };
}

async function pagedTranscriptAnchorRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const message = (index) => ({ id: `message-${index}`, role: "assistant", kind: "text", body: `Historical message ${index}`, createdAt: new Date(index * 1_000).toISOString() });
  const initial = Array.from({ length: 1_000 }, (_, index) => message(index + 1_000));
  const older = Array.from({ length: 200 }, (_, index) => message(index + 800));
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A/messages") return response({ messages: older, messagePage: { hasMore: true, olderCount: 800, beforeId: "message-800", total: 2_000 } });
    if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, messages: initial, messagePage: { hasMore: true, olderCount: 1_000, beforeId: "message-1000", total: 2_000 } });
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('.history-loader')?.textContent.includes("1000"), "paged transcript loaded");
  await settle();
  const viewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
  try { await until(() => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 96, "latest messages on open"); }
  catch (error) { throw new Error(`${error.message}: scroll=${viewport.scrollTop}, height=${viewport.scrollHeight}, client=${viewport.clientHeight}`); }
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1000 }));
  viewport.scrollTop = 0;
  viewport.dispatchEvent(new Event("scroll"));
  await until(() => host.querySelector('[data-message-id="message-1000"]'), "first anchor visible");
  await settle();
  await until(() => host.querySelector('[data-message-id="message-1000"]')?.getBoundingClientRect().top < viewport.getBoundingClientRect().bottom,
    "first reading row remained visible");
  const before = host.querySelector('[data-message-id="message-1000"]').getBoundingClientRect().top;
  host.querySelector('.history-loader').click();
  try { await until(() => host.querySelector('.history-loader')?.textContent.includes("800") && host.querySelector('[data-message-id="message-1000"]'), "paged anchor restored"); }
  catch (error) { throw new Error(`${error.message}; loader=${host.querySelector('.history-loader')?.textContent}, scroll=${viewport.scrollTop}/${viewport.scrollHeight}, rows=${[...host.querySelectorAll('[data-message-id]')].map((item) => item.dataset.messageId).join(",")}`); }
  try { await until(() => Math.abs(host.querySelector('[data-message-id="message-1000"]')?.getBoundingClientRect().top - before) < 10, "paged reading anchor settled"); }
  catch (error) {
    const anchor = host.querySelector('[data-message-id="message-1000"]');
    throw new Error(`${error.message}; delta=${anchor ? Math.round(anchor.getBoundingClientRect().top - before) : "missing"}px`);
  }
  assert(host.querySelectorAll('[role="listitem"]').length < 40, "Paged transcript mounted too many messages");
  viewport.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  viewport.scrollTop = 1_500;
  viewport.dispatchEvent(new Event("scroll"));
  for (let frameIndex = 0; frameIndex < 9; frameIndex += 1) await frame();
  assert(Math.abs(viewport.scrollTop - 1_500) < 24, "Anchor restoration overrode pointer navigation");
}

async function pagedTranscriptFindRegression({ endOnly = false, measuredOnly = false } = {}) {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const message = (index) => ({ id: `message-${index}`, role: "assistant", kind: "text", body: index === 10 || index === 900 ? `Needle ${index}` : `Other ${index}`, createdAt: new Date(index * 1_000).toISOString() });
  const latest = Array.from({ length: 200 }, (_, index) => message(index + 800));
  const earliest = Array.from({ length: 200 }, (_, index) => message(index));
  const staleSearch = deferred();
  const lateSearch = deferred();
  const olderRequest = deferred();
  let staleRequested = false;
  let partialReads = 0;
  let contextReads = 0;
  let leftReads = 0;
  let archived = false;
  let archiveSignal;
  const archiveSearch = deferred();
  const draggedSearch = deferred();
  let draggedSignal;
  let lateRequested = false;
  let olderRequested = false;
  let olderRequests = 0;
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: archived ? [] : [chats.A] });
    if (url.pathname === "/api/conversations/chat-A" && options?.method === "PATCH") { archived = true; return response({ ...chats.A, archived: true }); }
    if (url.pathname.endsWith("/messages/find")) {
      if (url.searchParams.get("q") === "archive") { archiveSignal = options.signal; return archiveSearch.promise; }
      if (url.searchParams.get("q") === "drag") { draggedSignal = options.signal; return draggedSearch.promise; }
      if (url.searchParams.get("q") === "partial") {
        partialReads += 1;
        if (partialReads > 1) assert(url.searchParams.get("after") === "message-1"
          && Number(url.searchParams.get("byteOffset")) === (partialReads - 1) * 1024,
        "A continuation lost its byte offset inside the oversized row");
        return partialReads <= 8
          ? response({ partial: true, nextAfterId: "message-1", nextByteOffset: partialReads * 1024, originId: null, wrapped: false })
          : response({ matchId: "message-10", messages: earliest, messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 800, total: 1_000, beforeId: "message-0" } });
      }
      if (url.searchParams.get("q") === "context") {
        contextReads += 1;
        if (contextReads > 1) assert(url.searchParams.get("after") === "message-1"
          && Number(url.searchParams.get("contextOffset")) === (contextReads - 1) * 1024,
        "Unicode context continuation lost its same-row cursor");
        return contextReads <= 2
          ? response({ partial: true, nextAfterId: "message-1", nextByteOffset: 0, nextContextOffset: contextReads * 1024, originId: null, wrapped: false })
          : response({ matchId: "message-10", messages: earliest, messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 800, total: 1_000, beforeId: "message-0" } });
      }
      if (url.searchParams.get("q") === "left") {
        leftReads += 1;
        if (leftReads === 2) assert(url.searchParams.get("after") === "message-1"
          && Number(url.searchParams.get("leftContextOffset")) === 8192,
        "left Unicode context cursor did not resume");
        if (leftReads === 3) assert(Number(url.searchParams.get("leftContextOffset")) === 4096,
        "left Unicode context cursor did not advance backwards");
        if (leftReads === 4) assert(Number(url.searchParams.get("contextOffset")) === 1024
          && url.searchParams.get("leftContextCased") === "1",
        "right Unicode context lost resolved left state");
        if (leftReads <= 2) return response({ partial: true, nextAfterId: "message-1", nextByteOffset: 0,
          nextLeftContextOffset: leftReads === 1 ? 8192 : 4096, originId: null, wrapped: false });
        if (leftReads === 3) return response({ partial: true, nextAfterId: "message-1", nextByteOffset: 0,
          nextContextOffset: 1024, nextLeftContextCased: true, originId: null, wrapped: false });
        return response({ matchId: "message-10", messages: earliest,
          messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 800, total: 1_000, beforeId: "message-0" } });
      }
      if (url.searchParams.get("q") === "stale") { staleRequested = true; return staleSearch.promise; }
      if (url.searchParams.get("q") === "late") { lateRequested = true; return lateSearch.promise; }
      if (url.searchParams.get("q") === "none") return response({ matchId: null, messages: [], messagePage: null });
      if (url.searchParams.get("q") === "failure") return response({ error: "Search unavailable" }, 503);
      const older = !url.searchParams.get("after") || url.searchParams.get("after") === "message-900";
      return response({ matchId: older ? "message-10" : "message-900", messages: older ? earliest : latest, messagePage: { hasMore: !older, olderCount: older ? 0 : 800, hasLater: older, newerCount: older ? 800 : 0, total: 1_000, beforeId: older ? "message-0" : "message-800" } });
    }
    if (url.pathname === "/api/conversations/chat-A/messages") { olderRequested = true; olderRequests += 1; return olderRequests === 1 ? olderRequest.promise : response({ error: "Older page unavailable" }, 503); }
    if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, messages: latest, messagePage: { hasMore: true, olderCount: 800, total: 1_000, beforeId: "message-800" } });
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('.history-find input'), "paged find ready");
  const input = host.querySelector('.history-find input');
  setControlValue(input, "Needle"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  try { await until(() => host.querySelector('[data-find-match="true"] [data-message-id="message-10"]'), "old persisted match"); }
  catch (error) { throw new Error(`${error.message}; status=${host.querySelector('.history-find .history-find-status')?.textContent}, scroll=${host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]')?.scrollTop}, rows=${[...host.querySelectorAll('[data-message-id]')].map((item) => item.dataset.messageId).slice(0, 4).join(',')}`); }
  const foundViewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
  await until(() => {
    const row = host.querySelector('[data-find-match="true"]');
    return row && row.getBoundingClientRect().top < foundViewport.getBoundingClientRect().bottom
      && row.getBoundingClientRect().bottom > foundViewport.getBoundingClientRect().top;
  }, "initial found row visible");
  const foundRow = host.querySelector('[data-find-match="true"]');
  assert(host.querySelectorAll('[role="listitem"]').length < 40, "Old search match mounted all history");
  assert(host.querySelector('.history-find .history-find-status')?.textContent === "Message 11 of 1000", "Old match announced its page-local index");
  await until(() => host.querySelector('.history-find [role="status"]')?.textContent === "Message 11 of 1000", "settled found result announced");
  assert(foundRow.getAttribute("aria-posinset") === "11" && foundRow.getAttribute("aria-setsize") === "1000", "Old match advertised a page-local list size");
  assert(host.querySelector('.history-return'), "An older search page lost return-to-latest navigation");
  for (const type of ["run.completed", "run.failed", "run.stopped"]) {
    fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", conversationId: "chat-A", runId: `run-${type}`, payload: { type } }) }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle();
    assert(host.querySelector('.history-return') && host.querySelector('[data-find-match="true"] [data-message-id="message-10"]'), `${type} replaced the chosen history page or find highlight: return=${Boolean(host.querySelector('.history-return'))}, match=${host.querySelector('[data-find-match="true"] [data-message-id]')?.dataset.messageId}, status=${host.querySelector('.history-find .history-find-status')?.textContent}, scroll=${host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]')?.scrollTop}, rows=${[...host.querySelectorAll('[data-message-id]')].map((item) => item.dataset.messageId).slice(0, 3).join(',')}`);
  }
  host.querySelector('[aria-label="Next conversation match"]').click();
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="message-900"]'), "newer persisted match");
  assert(host.querySelector('.history-find .history-find-status')?.textContent === "Message 901 of 1000", "New match announced its page-local index");
  const viewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
  input.focus();
  const bounds = input.getBoundingClientRect();
  const visible = viewport.getBoundingClientRect();
  assert(document.activeElement === input && bounds.top >= visible.top && bounds.bottom <= visible.bottom, "Focused find control scrolled out of the transcript viewport");
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
  viewport.scrollTop = Math.max(0, viewport.scrollTop - 350);
  viewport.dispatchEvent(new Event("scroll"));
  await settle();
  // Let the virtual range commit after wheel navigation before recording its
  // reading anchor. A queued range change can alter scroll geometry by itself.
  await new Promise((resolve) => setTimeout(resolve, 80));
  const visibleReadingRow = () => [...viewport.querySelectorAll('[data-message-id]')].find((element) => {
    const row = element.getBoundingClientRect();
    const frame = viewport.getBoundingClientRect();
    return row.bottom > frame.top && row.top < frame.bottom;
  });
  await until(() => visibleReadingRow(), "visible reading row before live append");
  const readingId = visibleReadingRow().dataset.messageId;
  const readingTop = visibleReadingRow().getBoundingClientRect().top;
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(1_000) }) }));
  await settle();
  try { await until(() => {
    const row = [...viewport.querySelectorAll('[data-message-id]')].find((element) => element.dataset.messageId === readingId);
    return row && Math.abs(row.getBoundingClientRect().top - readingTop) < 12;
  }, "live append retained the visible reading anchor"); }
  catch (error) {
    const row = [...viewport.querySelectorAll('[data-message-id]')].find((element) => element.dataset.messageId === readingId);
    throw new Error(`${error.message}; id=${readingId}, before=${readingTop}, after=${row?.getBoundingClientRect().top}, scroll=${viewport.scrollTop}/${viewport.scrollHeight}`);
  }
  host.querySelector('[aria-label="Previous conversation match"]').click();
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="message-10"]'), "previous persisted match");
  assert(document.activeElement === input && input.getBoundingClientRect().top >= visible.top, "Find control disappeared during previous navigation");
  host.querySelector('[aria-label="Next conversation match"]').click();
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="message-900"]'), "next persisted match");
  setControlValue(input, "stale"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => staleRequested, "stale search request pending");
  assert(!host.querySelector('.history-find [role="status"]')?.textContent, "pending search announced a transient state");
  setControlValue(input, "Needle"); await settle();
  staleSearch.resolve(response({ matchId: "message-10", messages: earliest, messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 800, total: 1_000, beforeId: "message-0" } }));
  await settle();
  assert(host.querySelector('.history-loader')?.textContent.includes("800") && host.querySelector('.history-return')?.textContent.includes("1 new"), `A cancelled find lost the newer live message affordance: loader=${host.querySelector('.history-loader')?.textContent}, return=${host.querySelector('.history-return')?.textContent}`);
  host.querySelector('[aria-label="Previous conversation match"]').click();
  await until(() => host.querySelector('.history-return'), "older page before return race");
  setControlValue(input, "late"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => lateRequested, "late find started");
  host.querySelector('.history-return').click();
  await until(() => host.querySelector('.history-loader')?.textContent.includes("800")
    && !host.querySelector('.history-return'), "return to latest completed");
  assert(!host.querySelector('[data-find-match="true"]'), "Return to latest kept a stale match highlight");
  lateSearch.resolve(response({ matchId: "message-10", messages: earliest, messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 800, total: 1_000, beforeId: "message-0" } }));
  await settle();
  assert(!host.querySelector('.history-return'), "A late find replaced Return to latest");
  assert(host.querySelector('.history-find .history-find-status')?.textContent !== "No match", "A cancelled find announced a false miss");
  host.querySelector('.history-loader').click();
  await until(() => olderRequested, "older page request pending");
  setControlValue(input, "none"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('.history-find .history-find-status')?.textContent === "No match", "no-match search completed");
  await until(() => host.querySelector('.history-find [role="status"]')?.textContent === "No match", "settled no-match announced");
  olderRequest.resolve(response({ messages: earliest, messagePage: { hasMore: false, olderCount: 0, total: 1_000, beforeId: "message-0" } }));
  await settle();
  assert(host.querySelector('.history-loader')?.textContent.includes("800"), "Stale prepend replaced the selected page");
  setControlValue(input, "failure"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('.history-find .history-find-status')?.textContent === "Search failed; retry", "find failure reported");
  await until(() => host.querySelector('.history-find [role="status"]')?.textContent === "Search failed; retry", "settled failure announced");
  assert(host.querySelector('.history-loader')?.textContent.includes("800"), "Failed find replaced the current page");
  host.querySelector('.history-loader').click();
  await until(() => host.textContent.includes("Older page unavailable"), "failed prepend reported");
  if (endOnly) {
    viewport.focus();
    await window.__fixtureSendKey("End");
    await until(() => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 96, "End reached latest after failed prepend");
    fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(1_001) }) }));
    await until(() => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 96, "End kept following a live append");
    assert(!host.querySelector('.history-return'), "End on the latest page exposed a Return control");
    return;
  }
  if (measuredOnly) {
    viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -300 }));
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight - 300);
    viewport.dispatchEvent(new Event("scroll"));
    await until(() => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 200,
      "reader moved away before End reestablished latest intent");
    viewport.focus();
    await window.__fixtureSendKey("End");
    await until(() => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 96,
      "End established latest-page intent before the row grew");
    const row = viewport.querySelector('[data-window-id]');
    assert(row, "Measured-height fixture has no mounted row");
    const oldEnd = viewport.scrollHeight - viewport.clientHeight;
    row.style.minHeight = `${row.getBoundingClientRect().height + 900}px`;
    viewport.scrollTop = oldEnd;
    viewport.dispatchEvent(new Event("scroll"));
    try { await until(() => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 96,
      "latest page followed the newly measured row before the next message"); }
    catch (error) { throw new Error(`${error.message}; oldEnd=${oldEnd}, top=${viewport.scrollTop}, max=${viewport.scrollHeight - viewport.clientHeight}, rowHeight=${row.getBoundingClientRect().height}, return=${host.querySelector('.history-return')?.textContent}`); }
    fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(1_001) }) }));
    try { await until(() => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 96, "latest page followed a newly measured row and live append"); }
    catch (error) { throw new Error(`${error.message}; oldEnd=${oldEnd}, top=${viewport.scrollTop}, height=${viewport.scrollHeight}, client=${viewport.clientHeight}, rows=${[...viewport.querySelectorAll('[data-message-id]')].map((item) => item.dataset.messageId).join(',')}`); }
    assert(!host.querySelector('.history-return'), "A measured latest row exposed a Return control");
    return;
  }
  viewport.scrollTop = viewport.scrollHeight; viewport.dispatchEvent(new Event("scroll")); await settle();
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(1_001) }) }));
  await settle();
  const bottomDeadline = performance.now() + 250;
  while (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop >= 96 && performance.now() < bottomDeadline) await frame();
  assert(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 96, `Stale prepend disabled bottom following: top=${viewport.scrollTop}, height=${viewport.scrollHeight}, client=${viewport.clientHeight}, return=${host.querySelector('.history-return')?.textContent}, loader=${host.querySelector('.history-loader')?.textContent}`);
  setControlValue(input, "partial"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('.history-find .history-find-status')?.textContent === "Search paused; press Enter to continue", "bounded search offered an explicit continuation");
  await until(() => host.querySelector('.history-find [role="status"]')?.textContent === "Search paused; press Enter to continue", "settled continuation announced");
  assert(partialReads === 8, "one Find action exceeded its request budget");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="message-10"]'), "continued search found an older message");
  assert(partialReads === 9, "continuation restarted the search rather than resuming it");
  setControlValue(input, "context"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="message-10"]') && contextReads === 3,
    "bounded Unicode context continued within the same row");
  setControlValue(input, "left"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="message-10"]') && leftReads === 4,
    "both bounded Unicode contexts continued within the same row");
  setControlValue(input, "drag"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => draggedSignal, "drag search entered its server slot");
  viewport.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  await until(() => draggedSignal.aborted, "pointer navigation aborted its pending Find request");
  await until(() => !host.querySelector('.history-find [role="status"]')?.textContent, "canceled search cleared stale live announcement");
  draggedSearch.resolve(response({ matchId: "message-10", messages: earliest, messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 800, total: 1_000, beforeId: "message-0" } }));
  await settle();
  assert(!host.querySelector('.history-find .history-find-status')?.textContent.includes("Searching") && !host.querySelector('[data-find-match="true"]'), "A dragged Find response restored its stale match");
  setControlValue(input, "archive"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => archiveSignal, "archive search entered its server slot");
  host.querySelector(".chat-tab.is-active .tab-close").click();
  await until(() => archiveSignal.aborted, "archiving aborted its pending Find request");
  archiveSearch.resolve(response({ matchId: null, messages: [], messagePage: null }));
  await until(() => !host.querySelector('.chat-tab.is-active'), "archived chat released its visible owner");
}

async function fullFindMessageReaderRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const full = { id: "large-match", role: "assistant", kind: "text", body: "startneedle-end", createdAt: new Date().toISOString() };
  const excerpt = { ...full, body: "needle [Later text omitted from Find result]", findExcerpt: true };
  const later = { ...full, id: "later-message", body: "Later response" };
  let failedNext = false;
  let bodyRequests = 0;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname.endsWith("/messages/find")) return response({ matchId: full.id, messages: [excerpt], messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 1, total: 2, beforeId: full.id } });
    if (url.pathname.endsWith(`/messages/${full.id}/body`)) {
      bodyRequests += 1;
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (offset === 5 && !failedNext) { failedNext = true; return response({ error: "Section unavailable" }, 503); }
      return response(offset ? { id: full.id, body: "needle-end", offset: 5, nextOffset: 15, totalBytes: 15, hasMore: false }
        : { id: full.id, body: "start", offset: 0, nextOffset: 5, totalBytes: 15, hasMore: true });
    }
    if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, messages: [later], messagePage: { hasMore: true, olderCount: 1, total: 2, beforeId: later.id } });
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('.history-find input'), "Find reader ready");
  setControlValue(host.querySelector('.history-find input'), "needle"); await settle();
  host.querySelector('.history-find input').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('.message-full-reader button'), "excerpt offers full message");
  const open = host.querySelector('.message-full-reader button');
  open.focus();
  assert(document.activeElement === open, "full message action is keyboard reachable");
  if (window.__fixtureSendKey) await window.__fixtureSendKey("Enter"); else open.click();
  try { await until(() => host.querySelector('.message-full-reader pre')?.textContent === "start", "first body section loaded"); }
  catch (error) { throw new Error(`${error.message}; requests=${bodyRequests}, reader=${host.querySelector('.message-full-reader')?.textContent?.slice(0, 300)}, active=${document.activeElement?.outerHTML?.slice(0, 150)}`); }
  assert(host.querySelector('.message-full-reader p')?.textContent === "Bytes 1–5 of 15", "first section did not show its byte range");
  const next = [...host.querySelectorAll('.message-full-reader button')].find((button) => button.textContent === "Next section");
  next.click();
  await until(() => host.querySelector('.message-full-reader [role="alert"]')?.textContent.includes("Section unavailable"), "body section failure exposed retry");
  assert(host.querySelector('.message-full-reader pre')?.textContent === "start", "failed section did not discard the readable section");
  next.click();
  await until(() => host.querySelector('.message-full-reader pre')?.textContent === "needle-end", "next body section readable");
  assert(host.querySelector('.message-full-reader p')?.textContent === "Bytes 6–15 of 15", "next section did not show its byte range");
  assert(host.querySelector('.message-full-reader pre')?.textContent.length < 20, "reader did not accumulate old sections");
  const previous = [...host.querySelectorAll('.message-full-reader button')].find((button) => button.textContent === "Previous section");
  previous.click();
  await until(() => host.querySelector('.message-full-reader pre')?.textContent === "start", "previous body section readable");
  assert(host.querySelector('.message-full-reader p')?.textContent === "Bytes 1–5 of 15", "previous section did not restore its byte range");
  host.querySelector('.history-return')?.click();
  await until(() => !host.querySelector('.message-full-reader'), "full body reader cleared on return to latest");
}

async function backgroundLatestRefreshRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const first = { id: "fresh-1", role: "assistant", kind: "text", body: "First persisted output", createdAt: "2026-09-26T00:00:00Z" };
  let messages = [first];
  let countTotal = 1;
  let staleDetail;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A/messages/count") return response({ total: countTotal });
    if (url.pathname === "/api/conversations/chat-A") return staleDetail?.promise ?? response({ ...chats.A, messages, messagePage: { hasMore: false, olderCount: 0, total: messages.length, beforeId: messages[0].id } });
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('[data-message-id="fresh-1"]'), "initial latest page");
  staleDetail = deferred();
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "runtime.connected", payload: { replay: { missed: true } } }) }));
  await settle();
  const buffered = { ...first, id: "fresh-buffered", body: "Output between snapshot and replay", searchOrder: 2 };
  countTotal = 2;
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: buffered }) }));
  staleDetail.resolve(response({ ...chats.A, messages: [first], messagePage: { hasMore: false, olderCount: 0, total: 1, beforeId: first.id } }));
  staleDetail = null;
  await until(() => host.querySelector('[data-message-id="fresh-buffered"]')?.closest('[role="listitem"]')?.getAttribute("aria-setsize") === "2", "replayed insert reconciled a stale snapshot total");
  messages = [first, buffered];
  messages = [...messages, { ...first, id: "fresh-2", body: "Recovered missed output" }];
  countTotal = 3;
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "runtime.connected", payload: { replay: { missed: true } } }) }));
  await until(() => host.querySelector('[data-message-id="fresh-2"]'), "missed latest output recovered");
  assert(!host.querySelector('.history-return'), "Latest refresh incorrectly became an older history page");
}

async function forwardHistoryPagingRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const message = (index) => ({ id: `forward-${index}`, role: "assistant", kind: "text", body: `Read ${index}`, createdAt: new Date(index * 1000).toISOString() });
  const all = Array.from({ length: 1_001 }, (_, index) => message(index));
  const requested = [];
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A/messages/count") return response({ total: 1_001 });
    if (url.pathname === "/api/conversations/chat-A/messages") {
      const after = Number(url.searchParams.get("after")?.split("-")[1]);
      requested.push(after);
      const page = all.slice(after + 1, after + 201);
      return response({ messages: page, messagePage: { total: 1_001, olderCount: after + 1, newerCount: 1_001 - (after + 1) - page.length, hasMore: true, hasLater: after + 1 + page.length < 1_001, beforeId: page[0]?.id } });
    }
    if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, messages: all.slice(0, 200), messagePage: { total: 1_001, olderCount: 0, newerCount: 801, hasMore: false, hasLater: true, beforeId: "forward-0" } });
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector(".history-later")?.textContent.includes("801"), "old page has forward affordance");
  for (const [step, remaining] of [[0, 601], [1, 401], [2, 201], [3, 1]]) {
    await until(() => !host.querySelector(".history-later")?.disabled, `forward page ${step + 1} enabled`);
    host.querySelector(".history-later").click();
    await until(() => host.querySelector(".history-later")?.textContent.includes(`${remaining} remaining`) && !host.querySelector(".history-later")?.disabled, `forward page ${step + 1}`);
    try { await until(() => host.querySelectorAll('[role="listitem"]').length < 40,
      `forward page ${step + 1} settled to bounded rows`); }
    catch (error) {
      const rows = [...host.querySelectorAll('[role="listitem"]')];
      const frame = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
      const list = frame?.querySelector('[role="list"]');
      throw new Error(`${error.message}; count=${rows.length}, first=${rows[0]?.querySelector('[data-message-id]')?.dataset.messageId}, last=${rows.at(-1)?.querySelector('[data-message-id]')?.dataset.messageId}, scroll=${frame?.scrollTop}/${frame?.scrollHeight}, client=${frame?.clientHeight}, listTop=${list?.getBoundingClientRect().top}, frameTop=${frame?.getBoundingClientRect().top}, heights=${rows.slice(0, 5).map((row) => row.getBoundingClientRect().height)}`);
    }
  }
  assert(requested.join(",") === "199,399,599,799", `Forward cursors skipped or repeated a page: ${requested}`);
  const viewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
  for (let attempt = 0; attempt < 4 && !host.querySelector('[data-message-id="forward-999"]'); attempt += 1) {
    viewport.scrollTop = viewport.scrollHeight;
    viewport.dispatchEvent(new Event("scroll"));
    await settle();
  }
  await until(() => host.querySelector('[data-message-id="forward-999"]'), "forward page committed through 999");
  host.querySelector(".history-later").click();
  await until(() => !host.querySelector(".history-later"), "forward read to persisted end");
  assert(requested.at(-1) === 999, "Final forward cursor did not continue from the loaded page");
  assert(host.querySelector('[role="listitem"][aria-posinset="1001"]') || host.querySelector('.history-return') === null, "Final forward page lost the persisted end");
  assert(host.querySelectorAll('[role="listitem"]').length < 40, "Forward paging exceeded bounded mounted rows");
}

async function forwardPageEvictionAnchorRegression() {
  for (const evicted of [false, true]) {
    root.render(null); await settle();
    keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
    const message = (index) => ({ id: `eviction-${index}`, role: "assistant", kind: "text", body: `Read ${index}`, createdAt: new Date(index * 1000).toISOString() });
    const initial = Array.from({ length: 1000 }, (_, index) => message(index));
    const later = Array.from({ length: 200 }, (_, index) => message(index + 1000));
    route = async (url) => {
      if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
      if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
      if (url.pathname === "/api/conversations/chat-A/messages/count") return response({ total: 1200 });
      if (url.pathname === "/api/conversations/chat-A/messages") return response({ messages: later, messagePage: { total: 1200, olderCount: 1000, newerCount: 0, hasMore: true, hasLater: false, beforeId: "eviction-1000" } });
      if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, messages: initial, messagePage: { total: 1200, olderCount: 0, newerCount: 200, hasMore: false, hasLater: true, beforeId: "eviction-0" } });
      return response({});
    };
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelector(".history-later"), "full forward page ready");
    const viewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
    viewport.scrollTop = 0; viewport.dispatchEvent(new Event("scroll")); await settle();
    viewport.scrollTop = evicted ? 0 : viewport.scrollHeight / 2;
    viewport.dispatchEvent(new Event("scroll")); await settle();
    const visibleRow = () => [...viewport.querySelectorAll("[data-message-id]")].find((element) => {
      const row = element.getBoundingClientRect();
      const frame = viewport.getBoundingClientRect();
      return row.bottom > frame.top + 2 && row.top < frame.bottom - 2;
    });
    await until(() => (evicted || viewport.scrollTop > viewport.clientHeight) && visibleRow(),
      `a genuinely visible ${evicted ? "evicted" : "retained"} reading row; scroll=${viewport.scrollTop}/${viewport.scrollHeight}; frame=${viewport.getBoundingClientRect().top}/${viewport.getBoundingClientRect().bottom}`);
    const firstVisible = visibleRow();
    assert(firstVisible, "Forward page fixture has no visible reading row");
    const anchorId = firstVisible.dataset.messageId;
    const top = firstVisible.getBoundingClientRect().top;
    host.querySelector(".history-later").click();
    await until(() => !host.querySelector(".history-later"), "forward page crossed bounded window");
    await settle();
    if (evicted) {
      assert(!host.querySelector(`[data-message-id="${anchorId}"]`), "Eviction fixture did not evict the old row");
      assert(host.querySelector('.history-loader'), "Evicted rows cannot be reached through Load earlier");
      await until(() => host.querySelector('[data-message-id="eviction-200"]'), "first surviving row after forward eviction");
      assert(host.querySelector('[data-message-id="eviction-200"]').getBoundingClientRect().top < viewport.getBoundingClientRect().bottom,
        "The first surviving row was mounted outside the reading viewport");
    } else {
      await until(() => host.querySelector(`[data-message-id="${anchorId}"]`), `retained forward anchor ${anchorId}; scroll=${viewport.scrollTop}/${viewport.scrollHeight}; rows=${[...viewport.querySelectorAll('[data-message-id]')].map((element) => element.dataset.messageId).join(',')}`);
      try { await until(() => Math.abs(host.querySelector(`[data-message-id="${anchorId}"]`)?.getBoundingClientRect().top - top) < 12, "retained forward anchor settled"); }
      catch (error) {
        const rows = [...viewport.querySelectorAll('[data-message-id]')];
        const anchor = rows.find((element) => element.dataset.messageId === anchorId);
        throw new Error(`${error.message}; anchor=${anchorId} top=${top}/${anchor?.getBoundingClientRect().top}; scroll=${viewport.scrollTop}/${viewport.scrollHeight}; mounted=${rows[0]?.dataset.messageId}..${rows.at(-1)?.dataset.messageId}; heights=${rows.map((element) => Math.round(element.getBoundingClientRect().height)).join(',')}`);
      }
      const delta = Math.abs(host.querySelector(`[data-message-id="${anchorId}"]`).getBoundingClientRect().top - top);
      assert(delta < 12, `Forward page moved a retained reading anchor by ${Math.round(delta)}px`);
    }
    assert(host.querySelectorAll('[role="listitem"]').length < 40, "Forward page mounted unbounded rows");
  }
}

async function backgroundReadingRefreshRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const message = (index) => ({ id: `reading-${index}`, role: "assistant", kind: "text", body: `Persisted ${index}`, createdAt: new Date(index * 1000).toISOString() });
  let all = Array.from({ length: 200 }, (_, index) => message(index));
  let reads = 0;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") {
      reads += 1;
      return response({ ...chats.A, messages: all, messagePage: { hasMore: false, olderCount: 0, total: all.length, beforeId: all[0].id } });
    }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  try { await until(() => host.querySelector('[data-message-id="reading-199"]'), "reading page loaded"); }
  catch (error) {
    const viewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
    const rows = [...(viewport?.querySelectorAll('[data-message-id]') ?? [])];
    throw new Error(`${error.message}; scroll=${viewport?.scrollTop}/${viewport?.scrollHeight}, client=${viewport?.clientHeight}, rows=${rows[0]?.dataset.messageId}..${rows.at(-1)?.dataset.messageId}, count=${rows.length}`);
  }
  const viewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
  const scrollAway = async () => {
    viewport.scrollTop = viewport.scrollHeight;
    viewport.dispatchEvent(new Event("scroll"));
    await settle();
    viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1000 }));
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll"));
    await settle();
  };
  await scrollAway();
  all = [...all, message(200)];
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "runtime.connected", payload: { replay: { missed: true } } }) }));
  await until(() => reads === 2 && host.querySelector('.history-return'), "missed output offered return to latest");
  assert(!host.querySelector('[data-message-id="reading-200"]') && viewport.scrollTop < 50, "Reconnect replaced the reading anchor");
  const returnButton = host.querySelector('.history-return');
  const composerTop = host.querySelector('.composer').getBoundingClientRect().top;
  assert(returnButton.getBoundingClientRect().top >= viewport.getBoundingClientRect().bottom - 1
    && returnButton.getBoundingClientRect().bottom <= composerTop,
  `Return control is offscreen while reading history: button=${returnButton.getBoundingClientRect().top}/${returnButton.getBoundingClientRect().bottom}, viewport=${viewport.getBoundingClientRect().bottom}, composer=${composerTop}`);
  returnButton.click();
  await until(() => host.querySelector('[data-message-id="reading-200"]') && !host.querySelector('.history-return'), "explicit latest after reconnect");
  await scrollAway();
  all = [...all, message(201)];
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", conversationId: "chat-A", runId: "run-reading", payload: { type: "run.completed" } }) }));
  await until(() => reads === 4 && host.querySelector('.history-return')?.textContent.includes("1 new"), "completed run offered later output");
  assert(!host.querySelector('[data-message-id="reading-201"]') && viewport.scrollTop < 50, "Completion replaced the reading anchor");
}

async function fullPageLiveAnchorRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const message = (index) => ({ id: `full-${index}`, role: "assistant", kind: "text", body: `Output ${index}`, createdAt: new Date(index * 1000).toISOString(), searchOrder: index + 1 });
  let all = Array.from({ length: 1000 }, (_, index) => message(index));
  let detailReads = 0;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") {
      detailReads += 1;
      return response({ ...chats.A, messages: all.slice(-1000), messagePage: { hasMore: all.length > 1000, olderCount: Math.max(0, all.length - 1000), total: all.length, beforeId: all.at(-1000).id } });
    }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('.history-find input'), "full page ready");
  const viewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
  viewport.scrollTop = viewport.scrollHeight; viewport.dispatchEvent(new Event("scroll")); await settle();
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1000 }));
  viewport.scrollTop = 0; viewport.dispatchEvent(new Event("scroll"));
  await until(() => {
    const row = host.querySelector('[data-message-id="full-0"]');
    return row && row.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top
      && row.getBoundingClientRect().top < viewport.getBoundingClientRect().bottom && viewport.scrollTop < 50;
  }, "first row visibly read at the top of the full page");
  const anchorTop = host.querySelector('[data-message-id="full-0"]').getBoundingClientRect().top;
  all = [...all, message(1000)];
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(1000) }) }));
  await until(() => host.querySelector('.history-return')?.textContent.includes("1 new"), "new row offered after full-page append");
  await until(() => host.querySelector('[data-message-id="full-0"]')
    && Math.abs(host.querySelector('[data-message-id="full-0"]').getBoundingClientRect().top - anchorTop) < 24,
  "A full-page live append retained the visible reader anchor");
  host.querySelector('.history-return').click();
  await until(() => !host.querySelector('.history-return'), "explicit latest after full-page append");
  viewport.scrollTop = viewport.scrollHeight; viewport.dispatchEvent(new Event("scroll"));
  await until(() => host.querySelector('[data-message-id="full-1000"]'), "new durable row available at latest");
  const backdated = { ...message(1001), createdAt: new Date(0).toISOString() };
  all = [...all, backdated];
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: backdated }) }));
  try { await until(() => host.querySelector('[data-message-id="full-1001"]'), "backdated insertion remains at the durable latest end"); }
  catch (error) { throw new Error(`${error.message}; return=${host.querySelector('.history-return')?.textContent}; scroll=${viewport.scrollTop}/${viewport.scrollHeight - viewport.clientHeight}; mounted=${[...viewport.querySelectorAll('[data-message-id]')].map((element) => element.dataset.messageId).slice(-4).join(',')}`); }
  viewport.scrollTop = viewport.scrollHeight;
  viewport.dispatchEvent(new Event("scroll"));
  await until(() => viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 2, "latest follow settled before Find key");
  await settle();
  const findInput = host.querySelector('.history-find input');
  findInput.focus();
  findInput.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  all = [...all, message(1002)];
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(1002) }) }));
  try { await until(() => host.querySelector('[data-message-id="full-1002"]') && !host.querySelector('.history-return'),
    "Find control arrow key left latest following with the reader"); }
  catch (error) { throw new Error(`${error.message}; return=${host.querySelector('.history-return')?.textContent}, scroll=${viewport.scrollTop}/${viewport.scrollHeight - viewport.clientHeight}, row=${Boolean(host.querySelector('[data-message-id="full-1002"]'))}`); }
  viewport.scrollTop = viewport.scrollHeight; viewport.dispatchEvent(new Event("scroll")); await settle();
  const maximum = viewport.scrollHeight - viewport.clientHeight;
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -48 }));
  // A scroll event can arrive before native wheel movement. It must not
  // release upward ownership merely because the old position is near bottom.
  viewport.dispatchEvent(new Event("scroll"));
  const readerIntentDeadline = Date.now() + 1050;
  let readerIntentEvaluations = 0;
  while (Date.now() < readerIntentDeadline) {
    readerIntentEvaluations += 1;
    await settle(); // NOSONAR S9382: each scroll evaluation observes the previous settle
  }
  assert(readerIntentEvaluations >= 2, "upward reader intent was not observed over multiple updates");
  viewport.scrollTop = maximum - 48; viewport.dispatchEvent(new Event("scroll")); await settle();
  const visibleRow = () => {
    const frame = viewport.getBoundingClientRect();
    return [...viewport.querySelectorAll('[data-message-id]')].find((element) => {
      const row = element.getBoundingClientRect();
      return row.bottom > frame.top && row.top < frame.bottom;
    });
  };
  // Windows may commit the scroll event before React commits the measured
  // virtual range. Judge the settled viewport, not an intermediate spacer.
  try { await until(visibleRow, "near-bottom reader has a visible anchor"); }
  catch (error) {
    const rows = [...viewport.querySelectorAll('[data-message-id]')].map((element) => {
      const bounds = element.getBoundingClientRect();
      return `${element.dataset.messageId}:${Math.round(bounds.top)}..${Math.round(bounds.bottom)}`;
    });
    const list = viewport.querySelector('[aria-label="Conversation history"]');
    throw new Error(`${error.message}; scroll=${viewport.scrollTop}/${viewport.scrollHeight - viewport.clientHeight}, frame=${Math.round(viewport.getBoundingClientRect().top)}..${Math.round(viewport.getBoundingClientRect().bottom)}, range=${rows.slice(0, 3).join(',')}|${rows.slice(-3).join(',')}, spacers=${[...list.children].filter((element) => element.getAttribute('aria-hidden') === 'true').map((element) => element.style.height).join(',')}`);
  }
  const readingRow = visibleRow();
  const readerTop = viewport.scrollTop;
  const readingRowId = readingRow.dataset.messageId;
  const readingRowTop = readingRow.getBoundingClientRect().top;
  all = [...all, message(1003)];
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(1003) }) }));
  try { await until(() => host.querySelector('.history-return')?.textContent.includes("1 new"), "upward reader intent retained a later-message affordance"); }
  catch (error) { throw new Error(`${error.message}; before=${readerTop}, after=${viewport.scrollTop}/${viewport.scrollHeight - viewport.clientHeight}, return=${host.querySelector('.history-return')?.textContent}, newRow=${Boolean(host.querySelector('[data-message-id="full-1003"]'))}`); }
  const retainedRow = viewport.querySelector(`[data-message-id="${readingRowId}"]`);
  assert(retainedRow && Math.abs(retainedRow.getBoundingClientRect().top - readingRowTop) < 24,
    `an append moved the upward reader ${readingRowId}: top=${readingRowTop} -> ${retainedRow?.getBoundingClientRect().top}, scroll=${readerTop} -> ${viewport.scrollTop}, max=${viewport.scrollHeight - viewport.clientHeight}`);
  const readsBeforeReturn = detailReads;
  host.querySelector('.history-return').click();
  await until(() => detailReads > readsBeforeReturn, "explicit latest request after upward reading");
  await until(() => !host.querySelector('.history-return'), "explicit latest page after upward reading");
  try { await until(() => {
    const row = host.querySelector('[data-message-id="full-1003"]');
    const bounds = row?.getBoundingClientRect();
    const frame = viewport.getBoundingClientRect();
    return bounds && bounds.bottom > frame.top && bounds.top < frame.bottom;
  }, "explicit latest row after upward reading"); }
  catch (error) { throw new Error(`${error.message}; detailReads=${detailReads}, return=${host.querySelector('.history-return')?.textContent}, scroll=${viewport.scrollTop}/${viewport.scrollHeight - viewport.clientHeight}, mounted=${[...viewport.querySelectorAll('[data-message-id]')].map((row) => row.dataset.messageId).slice(-6).join(',')}`); }
  viewport.scrollTop = viewport.scrollHeight; viewport.dispatchEvent(new Event("scroll")); await settle();
  const resumeMaximum = viewport.scrollHeight - viewport.clientHeight;
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -48 }));
  viewport.scrollTop = resumeMaximum - 48; viewport.dispatchEvent(new Event("scroll")); await settle();
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 48 }));
  viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
  viewport.dispatchEvent(new Event("scroll")); await settle();
  all = [...all, message(1004)];
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(1004) }) }));
  try { await until(() => host.querySelector('[data-message-id="full-1004"]') && !host.querySelector('.history-return'),
    "downward return inside the bottom zone resumed latest following"); }
  catch (error) { throw new Error(`${error.message}; return=${host.querySelector('.history-return')?.textContent}, scroll=${viewport.scrollTop}/${viewport.scrollHeight - viewport.clientHeight}, row=${Boolean(host.querySelector('[data-message-id="full-1004"]'))}`); }
}

async function largeLiveMessageRetentionRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const initial = [{ id: "bounded-0", role: "assistant", kind: "text", body: "Before large output", createdAt: new Date(0).toISOString() }];
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, messages: initial, messagePage: { hasMore: false, olderCount: 0, total: 1, beforeId: initial[0].id } });
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('[data-message-id="bounded-0"]'), "initial bounded chat");
  const body = "🙂".repeat(270_000);
  const large = { id: "bounded-1", role: "assistant", kind: "text", body, createdAt: new Date(1000).toISOString(),
    payload: { runId: "large-run", provider: "codex", detail: "x".repeat(1024 * 1024) } };
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: large }) }));
  await until(() => host.querySelector('[data-message-id="bounded-1"]'), "large live message retained");
  const row = host.querySelector('[data-message-id="bounded-1"]');
  assert(row.querySelector('.message-text').textContent.length < 17_000, "live body bypassed the retained-row ceiling");
  assert(row.querySelector('.message-full-reader button')?.textContent === "Read full message", "large live body lost bounded full-reader access");
  assert(row.querySelector('.message-run')?.textContent.includes("large-ru"), "bounded payload lost run identity");
}

async function largePageMessageRetentionRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const middleMatch = "ΩΟΣ\0more";
  const messages = Array.from({ length: 3 }, (_, index) => ({
    id: `page-large-${index}`, role: "assistant", kind: "text",
    body: index === 0 ? "🙂".repeat(125_000) + middleMatch + "🙂".repeat(125_000)
      : `needle ${index} ` + "🙂".repeat(270_000), createdAt: new Date(index * 1000).toISOString(),
    payload: { runId: `page-run-${index}`, provider: "codex", detail: "x".repeat(1024 * 1024) },
  }));
  let beforeRequests = 0;
  const page = (rows, olderCount, newerCount) => ({ messages: rows,
    messagePage: { hasMore: olderCount > 0, olderCount, hasLater: newerCount > 0, newerCount, total: 3, beforeId: rows[0]?.id } });
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname.endsWith("/messages/find")) return response({ matchId: messages[0].id, ...page(messages.slice(0, 1), 0, 2) });
    if (url.pathname.endsWith("/messages")) {
      if (url.searchParams.has("before")) beforeRequests += 1;
      return response(url.searchParams.has("before")
      ? page(messages.slice(0, 2), 0, 1) : page(messages.slice(1), 1, 0));
    }
    if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, ...page(messages.slice(2), 2, 0) });
    return response({});
  };
  const assertBounded = (id) => {
    const row = host.querySelector(`[data-message-id="${id}"]`);
    assert(row, `missing ${id}`);
    assert(row.querySelector('.message-text')?.textContent.length < 17_000, `${id} retained an oversized body`);
    assert(row.querySelector('.message-full-reader button')?.textContent === "Read full message", `${id} lost full-body access`);
    assert(row.querySelector('.message-run')?.textContent.includes("page-ru"), `${id} lost run identity`);
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('[data-message-id="page-large-2"]'), "latest large page");
  assertBounded("page-large-2");
  host.querySelector('.history-loader').click();
  try { await until(() => host.querySelector('[data-message-id="page-large-0"]'), "older large page"); }
  catch (error) { throw new Error(`${error.message}; requests=${beforeRequests}, loader=${host.querySelector('.history-loader')?.textContent}, mounted=${[...host.querySelectorAll('[data-message-id]')].map((row) => row.dataset.messageId).join(',')}, alert=${host.querySelector('[role="alert"]')?.textContent}`); }
  assertBounded("page-large-0");
  assert(!host.querySelector('.history-loader'), "older page cursor did not reach the start");
  const input = host.querySelector('.history-find input');
  setControlValue(input, "Σ"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="page-large-0"]'), "large Find result");
  assertBounded("page-large-0");
  assert(host.querySelector('[data-message-id="page-large-0"] .message-text')?.textContent.includes(middleMatch),
    "a far-middle Unicode and NUL Find match was lost after bounded client retention");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created",
    conversationId: "chat-A", payload: { ...messages[0], body: messages[0].body + " updated" } }) }));
  await settle();
  assertBounded("page-large-0");
  assert(host.querySelector('[data-message-id="page-large-0"] .message-text')?.textContent.includes(middleMatch),
    "a live replacement erased the visible Find match context");
  host.querySelector('.history-later').click();
  await until(() => host.querySelector('[data-message-id="page-large-2"]'), "later large page");
  assertBounded("page-large-2");
  assert(!host.querySelector('.history-later'), "later page cursor did not reach the end");
}

async function transcriptObserverStabilityRegression() {
  root.render(null); await settle();
  const socketCount = fixtureSockets.length;
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const messages = Array.from({ length: 300 }, (_, index) => ({ id: `stable-${index}`, role: "assistant", kind: "text",
    body: `History ${index}`, createdAt: new Date(index * 1000).toISOString() }));
  const NativeResizeObserver = window.ResizeObserver;
  let rowObservations = 0;
  window.ResizeObserver = class extends NativeResizeObserver {
    observe(target, options) {
      if (target.dataset.windowId) rowObservations += 1;
      return super.observe(target, options);
    }
  };
  try {
    route = async (url) => {
      if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
      if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
      if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, runs: [{ id: "run-stable", status: "running" }], messages,
        messagePage: { hasMore: false, olderCount: 0, total: messages.length, beforeId: messages[0].id } });
      return response({});
    };
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelector('[data-message-id="stable-299"]'), "long transcript ready");
    await until(() => fixtureSockets.length > socketCount, "long transcript socket ready");
    await until(() => host.querySelector('[aria-label="Stop active agent run"]'), "long transcript run ready");
    await settle();
    const emit = (seq) => fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "run.event", conversationId: "chat-A", runId: "run-stable",
      payload: { type: "assistant.delta", seq, payload: { text: ` fragment ${seq}` } },
    }) }));
    const nativeSetTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay === 32 ? 6_000 : delay, ...args);
    try {
      emit(1);
      await until(() => host.querySelector('.message.is-streaming')?.textContent.includes("fragment 1"), "first stream paint without a stream timer");
    } catch (error) {
      throw new Error(`${error.message}; sockets=${fixtureSockets.slice(socketCount).map((socket) => socket.readyState).join(',')}, activeRun=${host.querySelector('[aria-label="Stop active agent run"]')?.outerHTML?.slice(0, 120)}, stream=${host.querySelector('.message.is-streaming')?.textContent?.slice(0, 120)}, selected=${localStorage.getItem(keys[2])}`);
    } finally { window.setTimeout = nativeSetTimeout; }
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const baseline = rowObservations;
    for (let seq = 2; seq <= 8; seq += 1) {
      emit(seq);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await until(() => host.querySelector('.message.is-streaming')?.textContent.includes("fragment 8"), "sustained stream paint");
    assert(rowObservations - baseline <= 40,
      `unchanged history rows were reobserved ${rowObservations - baseline} times during seven stream paints`);
    const viewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
    viewport.scrollTop = viewport.scrollHeight;
    viewport.dispatchEvent(new Event("scroll"));
    await settle();
    const nearBottomBaseline = rowObservations;
    for (let index = 0; index < 7; index += 1) {
      // Small reader movements across the old 96px boundary must retain the
      // same mounted tail and its row observers while output is streaming.
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight - (index % 2 ? 120 : 80));
      viewport.dispatchEvent(new Event("scroll"));
      await settle(); // NOSONAR S9382: each scroll evaluation observes the previous settle
    }
    assert(rowObservations - nearBottomBaseline <= 40,
      `near-bottom reader movement reobserved ${rowObservations - nearBottomBaseline} unchanged rows`);
  } finally {
    root.render(null); await settle();
    window.ResizeObserver = NativeResizeObserver;
  }
}

async function backgroundCompletionKeepsExplicitPageRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const makeMessage = (index) => ({ id: `pending-${index}`, role: "assistant", kind: "text", body: `Message ${index}`, createdAt: new Date(index * 1000).toISOString() });
  const latest = Array.from({ length: 200 }, (_, index) => makeMessage(index + 800));
  const older = Array.from({ length: 200 }, (_, index) => makeMessage(index));
  const pendingLatest = deferred();
  let holdLatest = false;
  let detailReads = 0;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname.endsWith("/messages/find")) return response({ matchId: "pending-10", messages: older, messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 800, total: 1000, beforeId: "pending-0" } });
    if (url.pathname === "/api/conversations/chat-A") {
      detailReads += 1;
      if (holdLatest) return pendingLatest.promise;
      return response({ ...chats.A, messages: latest, messagePage: { hasMore: true, olderCount: 800, total: 1000, beforeId: "pending-800" } });
    }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('.history-find input'), "explicit page fixture ready");
  const input = host.querySelector('.history-find input');
  setControlValue(input, "Message 10"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('.history-return'), "older page selected");
  holdLatest = true;
  host.querySelector('.history-return').click();
  await until(() => detailReads === 2, "explicit latest request pending");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", conversationId: "chat-A", runId: "run-1", payload: { type: "run.completed" } }) }));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert(detailReads === 2, "Background completion superseded the explicit page request");
  holdLatest = false;
  pendingLatest.resolve(response({ ...chats.A, messages: latest, messagePage: { hasMore: true, olderCount: 800, total: 1000, beforeId: "pending-800" } }));
  await until(() => !host.querySelector('.history-return') && host.querySelector('[data-message-id="pending-999"]'), "explicit latest page committed");
}

async function queuedRunAccountRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const queued = { id: "run-queued", conversationId: "chat-A", provider: "codex", status: "queued", createdAt: new Date(0).toISOString(), accountId: null, accountLabel: null, accountIdentity: null };
  const launched = { ...queued, accountId: "account-work", accountLabel: "Work", accountIdentity: "work@example.com" };
  let detail = { ...chats.A, runs: [queued] };
  let detailReads = 0;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") { detailReads += 1; return response(detail); }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  const summary = () => host.querySelector(".conversation-header .conversation-meta small:not(.conversation-account)")?.textContent ?? "";
  const account = () => host.querySelector(".conversation-header .conversation-account");
  await until(() => summary().startsWith("queued"), "the queued run is shown");
  assert(!account(), "a queued run has no account yet");
  const reads = detailReads;
  const send = (data) => fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
  send({ type: "run.event", conversationId: "chat-A", runId: "run-queued",
    payload: { type: "run.started", payload: { provider: "codex", account: { id: "account-work", label: "Work", identity: "work@example.com" } } } });
  await until(() => account()?.textContent === "codex · Work (work@example.com)", "the started run names its account before it ends");
  assert(detailReads === reads, "the account is applied without reloading the conversation");
  // The run summary is hidden at 920px and below; the latest run's account
  // stays visible and exposed while history is read and after a run that
  // gave no answer.
  const visible = (state) => {
    const bounds = account()?.getBoundingClientRect();
    assert(account()?.checkVisibility() && bounds.width > 0 && bounds.height > 0, `the run's account is not visible at 900px ${state}`);
    assert(account().textContent === "codex · Work (work@example.com)", `the header names another account ${state}: ${account()?.textContent}`);
  };
  if (window.__fixtureSetViewport) {
    try {
      await window.__fixtureSetViewport(900);
      await until(() => window.innerWidth === 900, "real 900px layout");
      window.dispatchEvent(new Event("resize"));
      await settle();
      // A pane marks its size tiers at a rendering update, as a user sees it.
      await until(() => !host.querySelector(".conversation-header .conversation-meta small:not(.conversation-account)")?.checkVisibility(), "the header run summary is hidden at 900px");
      visible("while it runs");
      const earlier = { id: "earlier-1", role: "assistant", kind: "text", body: "Earlier answer", payload: {}, createdAt: new Date(0).toISOString() };
      detail = { ...chats.A, runs: [{ ...launched, status: "running" }], messages: [earlier],
        messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 2, total: 3, beforeId: earlier.id } };
      send({ type: "runtime.connected", payload: { replay: { missed: true } } });
      await until(() => host.querySelector(".history-forward") && !host.querySelector(".message.is-streaming"), "earlier history is read during the run");
      visible("while earlier history is read");
      detail = { ...chats.A, runs: [{ ...launched, status: "completed" }], messages: [] };
      send({ type: "run.event", conversationId: "chat-A", runId: "run-queued", payload: { type: "run.completed", payload: {} } });
      await until(() => host.querySelector(".history-return"), "the reader can return to the latest messages");
      host.querySelector(".history-return").click();
      await until(() => !host.querySelector(".history-forward") && !host.querySelector(".message.is-streaming") && host.querySelector(".conversation-header .conversation-meta small:not(.conversation-account)")?.textContent.startsWith("completed"), "the run ends with no answer");
      visible("after a run with no answer");
    } finally { await window.__fixtureSetViewport(1280); }
  } else assert(account()?.textContent === "codex · Work (work@example.com)", "the running run names its account");
  root.render(null); await settle();
}

async function checkpointReadingPageRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const message = (index, body = `Output ${index}`, seq = 0) => ({ id: `checkpoint-${index}`, role: "assistant", kind: "text", body,
    payload: index === 999 ? { runId: "run-checkpoint", checkpointEventSeq: seq } : {}, createdAt: new Date(index * 1000).toISOString() });
  const older = Array.from({ length: 200 }, (_, index) => message(index));
  let latest = Array.from({ length: 200 }, (_, index) => message(index + 800));
  let persistedTotal = 1000;
  let reads = 0;
  let heldDetail = null;
  let runStatus = "running";
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A/messages/count") return response({ total: persistedTotal });
    if (url.pathname.endsWith("/messages/find")) return response({ matchId: "checkpoint-10", messages: older, messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 800, total: 1000, beforeId: "checkpoint-0" } });
    if (url.pathname === "/api/conversations/chat-A") { reads += 1; return heldDetail?.promise ?? response({ ...chats.A, runs: [{ id: "run-checkpoint", status: runStatus }], messages: latest, messagePage: { hasMore: true, olderCount: persistedTotal - latest.length, total: persistedTotal, beforeId: latest[0].id } }); }
    return response({});
  };
  const socketsBefore = fixtureSockets.length;
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => fixtureSockets.length > socketsBefore
    && host.querySelector('[data-message-id="checkpoint-999"]'), "checkpoint latest and socket loaded");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: { ...message(500), body: "Old checkpoint rewrite", payload: { runId: "run-old", checkpointEventSeq: 1 } } }) }));
  await settle();
  const viewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
  viewport.scrollTop = 0; viewport.dispatchEvent(new Event("scroll")); await settle();
  latest = latest.map((item) => item.id === "checkpoint-999" ? message(999, "Recovered checkpoint body", 5) : item);
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "runtime.connected", payload: { replay: { missed: true } } }) }));
  await until(() => reads >= 2, "checkpoint reconnect read");
  viewport.scrollTop = viewport.scrollHeight; viewport.dispatchEvent(new Event("scroll"));
  await until(() => host.querySelector('[data-message-id="checkpoint-999"]')?.textContent.includes("Recovered checkpoint body"), "overlapping checkpoint refreshed");
  const find = host.querySelector('.history-find input');
  setControlValue(find, "checkpoint 10"); await settle();
  find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-message-id="checkpoint-10"]'), "older checkpoint page");
  const loadedCheckpoint = { ...message(10, "Visible checkpoint refreshed"), payload: { runId: "run-loaded", checkpointEventSeq: 1 } };
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: loadedCheckpoint }) }));
  await until(() => host.querySelector('[data-message-id="checkpoint-10"]')?.textContent.includes("Visible checkpoint refreshed"), "loaded older checkpoint updated in place");
  const staleRefresh = deferred();
  heldDetail = staleRefresh;
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "runtime.connected", payload: { replay: { missed: true } } }) }));
  await until(() => reads >= 3, "stale detail response held after loaded checkpoint");
  heldDetail = null;
  staleRefresh.resolve(response({ ...chats.A, runs: [{ id: "run-checkpoint", status: "running" }], messages: latest,
    messagePage: { hasMore: true, olderCount: 800, total: 1000, beforeId: "checkpoint-800" } }));
  await settle();
  assert(host.querySelector('[data-message-id="checkpoint-10"]')?.textContent.includes("Visible checkpoint refreshed"), "stale HTTP detail rolled back a loaded checkpoint");
  assert(host.querySelector('.history-find .history-find-status')?.textContent === "Message 11 of 1000", "An old off-page checkpoint inflated the persisted count");
  for (let seq = 6; seq <= 8; seq += 1) {
    const updated = message(999, `Checkpoint ${seq}`, seq);
    latest = latest.map((item) => item.id === updated.id ? updated : item);
    fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: updated }) }));
  }
  // Deliver the delta in the same browser task as the checkpoint burst.
  // Run ownership must be committed before React flushes queued state.
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", runId: "run-checkpoint", conversationId: "chat-A", payload: { type: "assistant.delta", seq: 9, payload: { text: " after eight" } } }) }));
  try { await until(() => host.querySelector('.history-live-tail')?.textContent.includes("Checkpoint 8 after eight"), "older page shows checkpoint and following delta"); }
  catch (error) { throw new Error(`${error.message}; tail=${host.querySelector('.history-live-tail')?.textContent}, return=${host.querySelector('.history-return')?.textContent}, reads=${reads}, socket=${fixtureSockets.length - socketsBefore}`); }
  const nextCheckpoint = message(999, "Checkpoint 9", 9);
  latest = latest.map((item) => item.id === nextCheckpoint.id ? nextCheckpoint : item);
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: nextCheckpoint }) }));
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", runId: "run-checkpoint", conversationId: "chat-A", payload: { type: "assistant.delta", seq: 10, payload: { text: " after nine" } } }) }));
  await until(() => host.querySelector('.history-live-tail')?.textContent.includes("Checkpoint 9 after nine"), "older page keeps a coherent second live boundary");
  assert(host.querySelector('.history-return')?.textContent === "Return to latest · 800 new", `Off-page checkpoint rewrites inflated the new-message count: ${host.querySelector('.history-return')?.textContent}`);
  runStatus = "completed";
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", conversationId: "chat-A", runId: "run-checkpoint", payload: { type: "run.completed" } }) }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  await until(() => reads >= 4, "checkpoint completion read");
  assert(host.querySelector('.history-return')?.textContent === "Return to latest · 800 new", "Persisted total failed to reconcile after checkpoint completion");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.updated", conversationId: "chat-A" }) }));
  await until(() => reads >= 5, "list update detail read");
  assert(host.querySelector('[data-message-id="checkpoint-10"]') && host.querySelector('.history-return')?.textContent === "Return to latest · 800 new", "List update replaced the reader's older page");
  for (let index = 1000; index <= 1002; index += 1) {
    persistedTotal += 1;
    latest = [...latest, message(index)].slice(-200);
    fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(index) }) }));
  }
  await until(() => host.querySelector('.history-return')?.textContent === "Return to latest · 803 new", "three durable new ids counted after old page");
  latest = latest.map((item) => item.id === "checkpoint-999" ? message(999, "Repeated checkpoint", 11) : item);
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(999, "Repeated checkpoint", 11) }) }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(host.querySelector('.history-return')?.textContent === "Return to latest · 803 new", "Repeated off-page checkpoint inflated the live count");
  const oversized = message(999, `${"x".repeat(20_000)}Bounded end`, 12);
  latest = latest.map((item) => item.id === oversized.id ? oversized : item);
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: oversized }) }));
  await until(() => host.querySelector('.history-live-tail')?.textContent.includes("Bounded end"), "large checkpoint has a visible tail");
  assert(host.querySelector('.history-live-tail').textContent.length < 8300, "older page mounted an unbounded live checkpoint");
  heldDetail = deferred();
  const staleDetail = heldDetail;
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "runtime.connected", payload: { replay: { missed: true } } }) }));
  await until(() => reads >= 6, "preserved reading refresh pending before overflow");
  heldDetail = null;
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", conversationId: "chat-A", runId: "noise", payload: { type: "noop", padding: "x".repeat(1_100_000) } }) }));
  await until(() => reads >= 7, "overflow retried the detail read");
  staleDetail.resolve(response({ ...chats.A, messages: latest, messagePage: { hasMore: true, olderCount: persistedTotal - latest.length, total: persistedTotal, beforeId: latest[0].id } }));
  await settle();
  assert(host.querySelector('[data-message-id="checkpoint-10"]') && host.querySelector('.history-return'), "overflow retry replaced the chosen reading page");
  host.querySelector('.history-return').click();
  await until(() => !host.querySelector('.history-return') && host.querySelector('[data-message-id="checkpoint-999"]')?.textContent.includes("Bounded end"), "latest page after older live output");
  assert(!host.querySelector('.history-live-tail'), "Returning to latest retained a duplicate live tail");
}

async function consecutiveRunLivePreviewRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const older = [{ id: "old-0", role: "assistant", kind: "text", body: "Old reading row", createdAt: new Date(0).toISOString() }];
  const latest = [{ id: "latest-1", role: "assistant", kind: "text", body: "A checkpoint", payload: { runId: "run-A", checkpointEventSeq: 1 }, createdAt: new Date(1000).toISOString() }];
  let runBStarted = false;
  let runCActive = false;
  const runBResponse = deferred();
  let detailReads = 0;
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A/messages/find") return response({ matchId: "old-0", messages: older, messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 1, total: 2, beforeId: "old-0" } });
    if (url.pathname === "/api/conversations/chat-A/runs" && options?.method === "POST") { runBStarted = true; return runBResponse.promise; }
    if (url.pathname === "/api/conversations/chat-A") {
      detailReads += 1;
      return response({ ...chats.A, runs: runCActive ? [{ id: "run-C", status: "running" }, { id: "run-B", status: "completed" }]
        : runBStarted ? [{ id: "run-B", status: "running" }, { id: "run-A", status: "completed" }]
          : [{ id: "run-A", status: detailReads === 1 ? "running" : "completed" }],
        messages: runCActive ? [{ id: "latest-3", role: "assistant", kind: "text", body: "C checkpoint",
          payload: { runId: "run-C", checkpointEventSeq: 1 }, createdAt: new Date(3000).toISOString() }] : latest,
        messagePage: { hasMore: true, olderCount: 1, hasLater: false, newerCount: 0, total: 2,
          beforeId: runCActive ? "latest-3" : latest[0].id } });
    }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('[data-message-id="latest-1"]'), "first run loaded");
  const find = host.querySelector('.history-find input');
  setControlValue(find, "Old reading row"); await settle();
  find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-message-id="old-0"]') && host.querySelector('.history-return'), "older page selected");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: latest[0] }) }));
  await until(() => host.querySelector('.history-live-tail')?.textContent.includes("A checkpoint"), "first run preview visible");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", conversationId: "chat-A", runId: "run-A", payload: { type: "run.completed" } }) }));
  await until(() => detailReads >= 2, "completed run detail refreshed");
  await until(() => host.querySelector('.history-live-tail strong')?.textContent === "Recent output", "completed run preview relabeled");
  const input = host.querySelector('textarea[aria-label="Message the agent"]');
  setControlValue(input, "Start B");
  await until(() => host.querySelector('[aria-label="Send message"]')?.disabled === false, "second run send available");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => runBStarted, "second run POST pending");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", conversationId: "chat-A", runId: "run-B", payload: { type: "assistant.delta", seq: 1, payload: { text: "B first delta" } } }) }));
  await until(() => host.querySelector('.history-live-tail')?.textContent.includes("B first delta"), "second run early delta visible");
  assert(!host.querySelector('.history-live-tail').textContent.includes("A checkpoint"), "Previous run checkpoint was mixed with B's first delta");
  host.querySelector('.history-return').click();
  await until(() => !host.querySelector('.history-return'), "latest page loaded before B checkpoint");
  const beforeCheckpointFind = host.querySelector('.history-find input');
  setControlValue(beforeCheckpointFind, "Old reading row"); await settle();
  beforeCheckpointFind.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-message-id="old-0"]') && host.querySelector('.history-return'), "older page restored before B checkpoint");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", conversationId: "chat-A", runId: "run-B", payload: { type: "assistant.delta", seq: 2, payload: { text: " plus next delta" } } }) }));
  await until(() => host.querySelector('.history-live-tail')?.textContent.includes("B first delta plus next delta"), "reload retained pre-checkpoint run ownership and suffix");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: { id: "latest-2", role: "assistant", kind: "text", body: "B checkpoint", payload: { runId: "run-B", checkpointEventSeq: 2 }, createdAt: new Date(2000).toISOString() } }) }));
  await until(() => host.querySelector('.history-live-tail')?.textContent.includes("B checkpoint"), "second run checkpoint visible before POST response");
  runBResponse.resolve(response({ id: "run-B", conversationId: "chat-A", status: "running" }));
  await until(() => host.querySelector('[aria-label="Stop active agent run"]'), "second run accepted");
  assert(host.querySelector('.history-live-tail')?.textContent.includes("B checkpoint"), "Accepted run discarded its already visible checkpoint");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", conversationId: "chat-A", runId: "run-B", payload: { type: "assistant.delta", seq: 3, payload: { text: " after checkpoint" } } }) }));
  await until(() => host.querySelector('.history-live-tail')?.textContent.includes("B checkpoint after checkpoint"), "accepted run retains its checkpoint and later delta");
  assert(!host.querySelector('.history-live-tail').textContent.includes("A checkpoint"), "Previous run checkpoint returned after B checkpoint");
  if (window.__fixtureSetViewport) {
    await window.__fixtureSetViewport(390);
    await settle();
    const previewWidth = host.querySelector('.history-live-tail').getBoundingClientRect().width;
    const messageWidth = host.querySelector('.message-column').getBoundingClientRect().width;
    assert(Math.abs(previewWidth - messageWidth) < 2, `Narrow live preview width ${previewWidth} differs from message width ${messageWidth}`);
    await window.__fixtureSetViewport(1280);
  }
  host.querySelector('.history-return').click();
  await until(() => !host.querySelector('.history-return'), "second run latest page restored");
  const repeatFind = host.querySelector('.history-find input');
  setControlValue(repeatFind, "Old reading row"); await settle();
  repeatFind.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-message-id="old-0"]') && host.querySelector('.history-return'), "second run older page restored");
  const resumedCheckpoint = { id: "latest-2", role: "assistant", kind: "text", body: "B resumed checkpoint",
    payload: { runId: "run-B", checkpointEventSeq: 4 }, createdAt: new Date(2000).toISOString() };
  latest[0] = resumedCheckpoint;
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: resumedCheckpoint }) }));
  await until(() => host.querySelector('.history-live-tail')?.textContent.includes("B resumed checkpoint"), "accepted run checkpoint survives Return and Find");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", conversationId: "chat-A", runId: "run-B", payload: { type: "assistant.delta", seq: 5, payload: { text: " uncheckpointed" } } }) }));
  await until(() => host.querySelector('.history-live-tail')?.textContent.includes("B resumed checkpoint uncheckpointed"), "uncheckpointed suffix visible before refresh");
  const beforeRefresh = detailReads;
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "runtime.connected", payload: { replay: { missed: true } } }) }));
  await until(() => detailReads > beforeRefresh, "preserved detail refreshed after missed replay");
  await settle(); await settle();
  assert(host.querySelector('.history-live-tail')?.textContent.includes("B resumed checkpoint uncheckpointed"),
    `Preserved refresh lost pre-request deltas after the checkpoint: ${host.querySelector('.history-live-tail')?.textContent}`);
  host.querySelector('.history-return').click();
  await until(() => !host.querySelector('.history-return') && host.querySelector('[data-message-id="latest-2"]'), "Return restored B's durable checkpoint");
  assert(host.querySelector('.message.is-streaming')?.textContent.includes("uncheckpointed"), "Return to latest dropped the active run's suffix");
  const findAgain = host.querySelector('.history-find input');
  setControlValue(findAgain, "Old reading row"); await settle();
  findAgain.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-message-id="old-0"]') && host.querySelector('.history-return'), "older page restored before missed completion");
  runCActive = true;
  const beforeRunC = detailReads;
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "runtime.connected", payload: { replay: { missed: true } } }) }));
  await until(() => detailReads > beforeRunC && host.querySelector('.history-live-tail')?.textContent.includes("C checkpoint"),
    "missed completion reconciled preview to the newer active run");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", conversationId: "chat-A", runId: "run-C", payload: { type: "assistant.delta", seq: 2, payload: { text: " C tail" } } }) }));
  await until(() => host.querySelector('.history-live-tail')?.textContent.includes("C checkpoint C tail"), "newly accepted run retained live deltas");
  assert(!host.querySelector('.history-live-tail').textContent.includes("B resumed checkpoint"), "completed run leaked into C's preview");
}

async function replayKeepsLatestPageBoundaryRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const message = (index, seq = 0) => ({ id: `replay-${index}`, role: "assistant", kind: "text", body: `Replay ${index}`,
    searchOrder: index, createdAt: new Date(index * 1000).toISOString(), payload: { runId: `run-${index}`, checkpointEventSeq: seq } });
  const latest = Array.from({ length: 200 }, (_, index) => message(index + 800));
  const heldDetail = deferred();
  let detailStarted = false;
  let before = null;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") { detailStarted = true; return heldDetail.promise; }
    if (url.pathname === "/api/conversations/chat-A/messages") {
      before = url.searchParams.get("before");
      return response({ messages: Array.from({ length: 200 }, (_, index) => message(index + 600)), messagePage: { hasMore: true, olderCount: 600, total: 1000, beforeId: "replay-600" } });
    }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => detailStarted && fixtureSockets.at(-1) && host.querySelector('.message-scroll'), "held latest detail request started");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(10, 2) }) }));
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(1000, 1) }) }));
  heldDetail.resolve(response({ ...chats.A, messages: latest, messagePage: { hasMore: true, olderCount: 800, total: 1000, beforeId: "replay-800" } }));
  await until(() => host.querySelector('.history-loader')?.textContent.includes("800 remaining"), "latest page after buffered checkpoint");
  assert(host.querySelector('[role="listitem"]')?.getAttribute("aria-setsize") === "1001", "buffered latest message did not advance persisted total");
  assert(!host.querySelector('[data-message-id="replay-10"]'), "off-page checkpoint entered the latest page");
  host.querySelector('.history-loader').click();
  await until(() => before !== null, "earlier page request after replay");
  assert(before === "replay-800", `Buffered checkpoint changed the pagination boundary to ${before}`);
  await until(() => host.querySelector('.history-loader')?.textContent.includes("600 remaining"), "intervening page remains reachable");
}

async function deferredReloadSelectionOwnershipRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const sibling = { ...chats.B, projectId: "A", worktreeId: "A", worktreePath: projects[0].worktrees[0].path };
  let aReads = 0;
  let bReads = 0;
  let heldASignal;
  const heldA = deferred();
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A, sibling] });
    if (url.pathname === "/api/conversations/chat-A") {
      aReads += 1;
      if (aReads === 2) heldASignal = options.signal;
      return aReads === 2 ? heldA.promise : response({ ...chats.A, messages: [], messagePage: { total: 0 } });
    }
    if (url.pathname === "/api/conversations/chat-B") { bReads += 1; return response({ ...sibling, messages: [], messagePage: { total: 0 } }); }
    return response({});
  };
  const socketsBefore = fixtureSockets.length;
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => aReads === 1 && fixtureSockets.length > socketsBefore
    && host.querySelector('#chat-tab-chat-A[aria-selected="true"]')
    && host.querySelector('.conversation-header h1')?.textContent === chats.A.title
    && host.querySelector('textarea[aria-label="Message the agent"]:not(:disabled)'), "A detail and socket ready before deferred switch");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.resolved", conversationId: "chat-A", runId: "run-A" }) }));
  await until(() => aReads === 2, "A refresh held before deferred reload");
  // Overflow queues A's replacement detail read in a microtask. Switch
  // selection synchronously before that callback can claim the shared slot.
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", conversationId: "chat-A", runId: "noise", payload: { type: "noop", padding: "x".repeat(1_100_000) } }) }));
  assert(heldASignal?.aborted, "Overflow did not queue a deferred replacement for A");
  host.querySelector('#chat-tab-chat-B').click();
  await until(() => bReads >= 1 && host.querySelector('#chat-tab-chat-B[aria-selected="true"]'), "B detail after queued reload");
  heldA.resolve(response({ ...chats.A, messages: [], messagePage: { total: 0 } }));
  await until(() => host.querySelector('.conversation-header h1')?.textContent === sibling.title, "B selected detail committed");
  assert(aReads === 2, `A stale deferred callback made ${aReads} detail reads after selecting B`);
}

async function latestBeforeFindOwnershipRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const message = (index) => ({ id: `order-${index}`, role: "assistant", kind: "text", body: `Find ${index}`, createdAt: new Date(index * 1000).toISOString() });
  const latest = Array.from({ length: 200 }, (_, index) => message(index + 800));
  const oldest = Array.from({ length: 200 }, (_, index) => message(index));
  const delayedLatest = deferred();
  let holdLatest = false;
  let latestRequested = false;
  let findRequests = 0;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname.endsWith("/messages/find")) { findRequests += 1; return response({ matchId: "order-10", messages: oldest, messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 800, total: 1000, beforeId: "order-0" } }); }
    if (url.pathname === "/api/conversations/chat-A") {
      if (holdLatest) { latestRequested = true; return delayedLatest.promise; }
      return response({ ...chats.A, messages: latest, messagePage: { hasMore: true, olderCount: 800, total: 1000, beforeId: "order-800" } });
    }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector(".history-find input"), "latest/find ownership ready");
  const input = host.querySelector(".history-find input");
  setControlValue(input, "Find 10"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="order-10"]'), "initial old match");
  holdLatest = true;
  host.querySelector(".history-return").click();
  await until(() => latestRequested, "return to latest pending before find");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => findRequests === 2 && host.querySelector('[data-find-match="true"] [data-message-id="order-10"]') && host.querySelector(".history-return"), "new find owns old page");
  delayedLatest.resolve(response({ ...chats.A, messages: latest, messagePage: { hasMore: true, olderCount: 800, total: 1000, beforeId: "order-800" } }));
  await settle();
  assert(host.querySelector('[data-find-match="true"] [data-message-id="order-10"]') && host.querySelector(".history-return"), "Late Return to latest replaced a newer find page");
}

async function findWhileMetadataRefreshRegression() {
  for (const kind of ["completion", "reconnect", "list"]) {
    root.render(null); await settle();
    keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
    const message = (index) => ({ id: `metadata-${index}`, role: "assistant", kind: "text", body: `Match ${index}`, createdAt: new Date(index * 1000).toISOString() });
    const older = Array.from({ length: 20 }, (_, index) => message(index));
    const latest = Array.from({ length: 20 }, (_, index) => message(index + 80));
    const running = { ...chats.A, runs: [{ id: "run-metadata", status: "running", conversationId: "chat-A" }] };
    const completed = { ...running, runs: [{ id: "run-metadata", status: "completed", conversationId: "chat-A" }] };
    const held = deferred();
    let hold = false;
    let requested = false;
    route = async (url) => {
      if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
      if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
      if (url.pathname.endsWith("/messages/find")) return response({ matchId: "metadata-10", messages: older, messagePage: { total: 100, olderCount: 0, newerCount: 80, hasLater: true, beforeId: "metadata-0" } });
      if (url.pathname === "/api/conversations/chat-A/messages/count") return response({ total: 100 });
      if (url.pathname === "/api/conversations/chat-A") {
        if (hold) { requested = true; return held.promise; }
        return response({ ...running, messages: latest, messagePage: { total: 100, olderCount: 80, beforeId: "metadata-80" } });
      }
      return response({});
    };
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelector('[aria-label="Stop active agent run"]'), `${kind} initial active run`);
    hold = true;
    const event = kind === "completion" ? { type: "run.event", conversationId: "chat-A", runId: "run-metadata", payload: { type: "run.completed" } }
      : kind === "reconnect" ? { type: "runtime.connected", payload: { replay: { missed: true } } }
        : { type: "conversation.updated", conversationId: "chat-A" };
    fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    await until(() => requested, `${kind} metadata refresh pending`);
    const input = host.querySelector(".history-find input");
    setControlValue(input, "Match 10"); await settle();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => host.querySelector('[data-find-match="true"] [data-message-id="metadata-10"]'), `${kind} found old page`);
    held.resolve(response({ ...completed, messages: latest, messagePage: { total: 100, olderCount: 80, beforeId: "metadata-80" } }));
    await until(() => !host.querySelector('[aria-label="Stop active agent run"]') && host.querySelector('[aria-label="Send message"]'), `${kind} terminal metadata after find`);
    assert(host.querySelector('[data-message-id="metadata-10"]') && host.querySelector(".history-return"), `${kind} metadata refresh replaced the found page`);
  }
}

async function metadataBeforeFindResultRegression() {
  for (const kind of ["completion", "reconnect", "list", "no-match", "error"]) {
    root.render(null);
    await until(() => !host.querySelector('.app-shell'), `${kind} previous app unmounted`);
    keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
    const message = (index) => ({ id: `pending-${index}`, role: "assistant", kind: "text", body: `Match ${index}`, createdAt: new Date(index * 1000).toISOString() });
    const older = Array.from({ length: 20 }, (_, index) => message(index));
    const latest = Array.from({ length: 20 }, (_, index) => message(index + 80));
    const running = { ...chats.A, runs: [{ id: "run-pending", status: "running", conversationId: "chat-A" }] };
    const completed = { ...running, runs: [{ id: "run-pending", status: "completed", conversationId: "chat-A" }] };
    const pendingFind = deferred();
    let findRequested = false;
    let detailReads = 0;
    route = async (url) => {
      if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
      if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
      if (url.pathname.endsWith("/messages/find")) { findRequested = true; return pendingFind.promise; }
      if (url.pathname === "/api/conversations/chat-A/messages/count") return response({ total: 100 });
      if (url.pathname === "/api/conversations/chat-A") {
        detailReads += 1;
        return response({ ...(detailReads === 1 ? running : completed), messages: latest, messagePage: { total: 100, olderCount: 80, beforeId: "pending-80" } });
      }
      return response({});
    };
    const socketsBefore = fixtureSockets.length;
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => fixtureSockets.length > socketsBefore
      && host.querySelector('[aria-label="Stop active agent run"]'), `${kind} initial run and socket`);
    const input = host.querySelector(".history-find input");
    setControlValue(input, "Match 10"); await settle();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => findRequested, `${kind} find pending`);
    const event = kind === "completion" ? { type: "run.event", conversationId: "chat-A", runId: "run-pending", payload: { type: "run.completed" } }
      : kind === "reconnect" ? { type: "runtime.connected", payload: { replay: { missed: true } } }
        : { type: "conversation.updated", conversationId: "chat-A" };
    fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
    await until(() => detailReads > 1 && !host.querySelector('[aria-label="Stop active agent run"]'), `${kind} metadata before find`);
    assert(host.querySelector('.history-find .history-find-status')?.textContent === "Searching…", `${kind} metadata reset the pending search`);
    if (kind === "error") pendingFind.resolve(response({ error: "Search unavailable" }, 503));
    else pendingFind.resolve(response({ matchId: kind === "no-match" ? null : "pending-10", messages: older, messagePage: { total: 100, olderCount: 0, newerCount: 80, hasLater: true, beforeId: "pending-0" } }));
    if (kind === "no-match" || kind === "error") {
      await until(() => host.querySelector('.history-find .history-find-status')?.textContent === (kind === "error" ? "Search failed; retry" : "No match"), `${kind} status after metadata`);
      assert(host.querySelector('[data-message-id="pending-80"]') && !host.querySelector('.history-return') && host.querySelector('[aria-label="Send message"]'), `${kind} replaced the latest page or kept stale run metadata`);
      continue;
    }
    await until(() => host.querySelector('[data-find-match="true"] [data-message-id="pending-10"]'), `${kind} found old page after metadata`);
    const viewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
    await until(() => {
      const match = host.querySelector('[data-find-match="true"]');
      return match && match.getBoundingClientRect().bottom > viewport.getBoundingClientRect().top
        && match.getBoundingClientRect().top < viewport.getBoundingClientRect().bottom;
    }, `${kind} aligned the found row`);
    assert(host.querySelector('.history-return') && host.querySelector('[aria-label="Send message"]'), `${kind} lost the reading page or current run metadata`);
  }
}

async function findInFlightEventRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const message = (index) => ({ id: `race-${index}`, role: "assistant", kind: "text", body: `Match ${index}`, createdAt: new Date(index * 1000).toISOString() });
  const latest = Array.from({ length: 200 }, (_, index) => message(index));
  const pending = deferred();
  let requested = false;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname.endsWith("/messages/find")) { requested = true; return pending.promise; }
    if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, messages: latest, messagePage: { hasMore: false, olderCount: 0, total: 200, beforeId: "race-0" } });
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('.history-find input'), "find race ready");
  const input = host.querySelector('.history-find input');
  setControlValue(input, "Match 10"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => requested, "find race pending");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(200) }) }));
  pending.resolve(response({ matchId: "race-10", messages: latest, messagePage: { hasMore: false, olderCount: 0, hasLater: false, newerCount: 0, total: 200, beforeId: "race-0" } }));
  await until(() => host.querySelector('.history-return'), "in-flight event offers return to latest");
  await until(() => host.querySelector('[data-message-id="race-10"]'), "Find retains its match after a live event");
}

async function typingDuringPrependRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const message = (index) => ({ id: `prepend-${index}`, role: "assistant", kind: "text", body: `Row ${index}`, createdAt: new Date(index * 1000).toISOString() });
  const latest = Array.from({ length: 200 }, (_, index) => message(index + 100));
  const older = Array.from({ length: 100 }, (_, index) => message(index));
  const pending = deferred();
  let requested = false;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A/messages") { requested = true; return pending.promise; }
    if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, messages: latest, messagePage: { hasMore: true, olderCount: 100, total: 300, beforeId: "prepend-100" } });
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('.history-loader'), "prepend available");
  host.querySelector('.history-loader').click();
  await until(() => requested, "prepend pending");
  const input = host.querySelector('.history-find input');
  setControlValue(input, "draft query"); await settle();
  pending.resolve(response({ messages: older, messagePage: { hasMore: false, olderCount: 0, total: 300, beforeId: "prepend-0" } }));
  await until(() => !host.querySelector('.history-loader'), "prepend finished after typing");
  assert(host.querySelector('.history-find input').value === "draft query", "Typing while loading earlier lost the query");
}

async function providerBootstrapConvergenceRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const bootstrap = deferred();
  let providerReads = 0;
  const ready = (id, label) => ({ id, label, kind: "harness", available: true, compatible: true, checking: false, version: "9.9.9", capabilities: { permissionModes: ["read-only"], resume: true } });
  const converged = [ready("codex", "Codex"), ready("claude", "Claude Code")];
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return bootstrap.promise;
    if (url.pathname === "/api/providers") { providerReads += 1; return response({ providers: converged }); }
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    return response({});
  };
  const socketCount = fixtureSockets.length;
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => fixtureSockets.length > socketCount, "socket before bootstrap");
  // This event arrives before bootstrap and is lost; only the refresh can converge.
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "providers.changed", payload: { providers: converged } }) }));
  const checking = (id, label) => ({ id, label, kind: "harness", available: false, compatible: false, checking: true });
  bootstrap.resolve(response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [checking("codex", "Codex"), checking("claude", "Claude Code")], templates: [], trustedProjects: [] }));
  await until(() => host.querySelector('[aria-label="Settings"]'), "settings after checking bootstrap");
  host.querySelector('[aria-label="Settings"]').click();
  // The selected option is never disabled, so watch the status line and a
  // non-selected provider, which stay "checking" until the snapshot converges.
  await until(() => document.querySelector('[role="dialog"] option[value="claude"]')?.disabled === false
    && document.querySelector("#default-provider-status")?.textContent.startsWith("Codex 9.9.9"), "provider converged after missed event");
  assert(providerReads > 0, "Checking bootstrap did not refresh providers");
  document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click();
}

async function bootstrapMaintenanceRetryRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  let bootstrapReads = 0;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") {
      bootstrapReads += 1;
      if (bootstrapReads === 1) return response({ error: "Archive maintenance is running; retry shortly", code: "ARCHIVE_MAINTENANCE_TRANSIENT" }, 503);
      return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} },
        settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    }
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => bootstrapReads === 1 && host.querySelector('.loading-screen'), "maintenance blocks initial bootstrap");
  await until(() => bootstrapReads >= 2 && host.querySelector('[aria-label="Settings"]'), "bootstrap resumes after maintenance");
  assert(!host.querySelector('[role="alert"]'), "a transient maintenance response left a persistent error");
}

async function bootstrapHardFailureRegression() {
  for (const failure of [
    { status: 401, message: "Sign in required" },
    { status: 500, message: "Runtime failed" },
    { status: 503, message: "Archive maintenance recovery failed: corrupt retained marker", code: "ARCHIVE_MAINTENANCE_FAILED" },
    { message: "Network unavailable" },
  ]) {
    root.render(null); await settle();
    let bootstrapReads = 0;
    let fail = true;
    route = async (url) => {
      if (url.pathname === "/api/bootstrap") {
        bootstrapReads += 1;
        if (fail) {
          if (failure.status) return response({ error: failure.message, ...(failure.code ? { code: failure.code } : {}) }, failure.status);
          throw new Error(failure.message);
        }
        return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} },
          settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
      }
      return response({});
    };
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelector('.loading-screen [role="alert"]')?.textContent === failure.message, // NOSONAR S9382: bootstrap retry steps follow the previous failure
      `bootstrap ${failure.status ?? "network"} failure is surfaced`);
    await remainsTrue(() => bootstrapReads === 1, 1150, `bootstrap ${failure.status ?? "network"} failure was polled indefinitely`); // NOSONAR S9382: bootstrap retry steps follow the previous failure
    assert(host.querySelector('.loading-screen button')?.textContent.includes("Retry"), "hard failure has no explicit retry");
    if (failure.status === 401) {
      fail = false;
      host.querySelector('.loading-screen button').click();
      await until(() => host.querySelector('[aria-label="Settings"]'), "explicit retry loads after authorization recovers"); // NOSONAR S9382: bootstrap retry steps follow the previous failure
      assert(bootstrapReads === 2, "explicit retry made an unexpected number of bootstrap requests");
    }
  }
}

async function providerCheckingRateRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  let providerReads = 0;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: false, checking: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/providers") { providerReads += 1; return response({ providers: [{ id: "codex", available: false, checking: true }] }); }
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => providerReads > 0, "checking provider poll started");
  await remainsTrue(() => providerReads <= 2, 1150, "Checking provider polled more than twice in 1.15s");
  root.render(null); await settle();
}

async function sustainedOutputRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('#chat-tab-chat-A[aria-selected="true"]'), "stream fixture chat");
  await until(() => host.querySelector('textarea[aria-label="Message the agent"]:not(:disabled)'), "stream fixture ready");
  await settle();
  const socket = fixtureSockets.at(-1);
  const sendDelta = (seq) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", runId: "run-stream", conversationId: "chat-A", payload: { type: "assistant.delta", seq, payload: { text: "x".repeat(256) } } }) }));
  sendDelta(1);
  await until(() => host.querySelector('.is-streaming .message-text'), "streamed output visible");
  const text = host.querySelector('.is-streaming .message-text');
  let paints = 0;
  const observer = new MutationObserver(() => { paints += 1; });
  observer.observe(text, { subtree: true, characterData: true, childList: true });
  const started = performance.now();
  const priorHidden = Object.getOwnPropertyDescriptor(document, "hidden");
  try {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    for (let seq = 2; seq <= 201; seq += 1) {
      sendDelta(seq);
      // Exercise hidden-tab posted tasks while stream paints keep their own
      // 32 ms cadence. Every delta must still reach the eventual flush.
      if (seq % 2 === 1) await frame();
    }
    await until(() => text.textContent.length === 201 * 256, "sustained output complete");
  } finally {
    if (priorHidden) Object.defineProperty(document, "hidden", priorHidden);
    else delete document.hidden;
    document.dispatchEvent(new Event("visibilitychange"));
  }
  observer.disconnect();
  const input = host.querySelector('textarea[aria-label="Message the agent"]');
  const inputStarted = performance.now();
  setControlValue(input, "Type during output");
  await frame();
  const inputFrameMs = Math.round(performance.now() - inputStarted);
  const elapsedMs = Math.round(performance.now() - started);
  // Timer delivery slows under host load. Bound paints by actual elapsed
  // stream time, while still requiring substantial coalescing per delta.
  const paintBudget = Math.min(100, Math.ceil(elapsedMs / 24) + 8);
  assert(paints <= paintBudget, `Sustained output repainted ${paints} times over ${elapsedMs}ms (budget ${paintBudget})`);
  assert(inputFrameMs < 250, `Typing after sustained output missed its 250ms fixture budget: ${inputFrameMs}ms`);
  window.__performanceEvidence = { ...(window.__performanceEvidence ?? {}), output: { deltas: 200, elapsedMs, paints, paintBudget, inputFrameMs } };
}

async function expectResponsiveFocus(label, target) {
  try {
    await until(() => visibleFocus(target()), label);
  } catch (error) {
    const active = document.activeElement;
    throw new Error(`${error.message}; active=${active?.outerHTML?.slice(0, 250)}; target=${target()?.outerHTML?.slice(0, 250)}`);
  }
}

async function responsiveSidebarBreakpointCycles(setWidth) {
  const trace = [];
  const describe = (element) => element?.getAttribute?.("aria-label") ?? element?.id ?? element?.tagName;
  const record = (event) => trace.push({ type: event.type, target: describe(event.target),
    active: describe(document.activeElement), width: window.innerWidth,
    sidebarHidden: host.querySelector("#project-sidebar")?.getAttribute("aria-hidden") });
  document.addEventListener("focusin", record, true);
  document.addEventListener("focusout", record, true);
  window.addEventListener("resize", record);
  try {
    for (let round = 0; round < 3; round += 1) {
      const desktopSidebarControl = host.querySelector('[aria-label="Close projects sidebar"]');
      await until(() => { // NOSONAR S9382: each sidebar round observes the previous focus transition
        desktopSidebarControl?.focus({ preventScroll: true });
        return visibleFocus(desktopSidebarControl);
      }, `focused desktop sidebar precondition ${round + 1}`);
      await setWidth(640);
      await until(() => host.querySelector('[aria-label="Open projects sidebar"]'), `sidebar closed from focused desktop control ${round + 1}`);
      await expectResponsiveFocus(`visible focus restored after hiding desktop sidebar ${round + 1}`, // NOSONAR S9382: each sidebar round observes the previous focus transition
        () => host.querySelector('[aria-label="Open projects sidebar"]'));
      assert(visibleFocus(host.querySelector('[aria-label="Open projects sidebar"]')),
        "narrow opener was not focused before the wide transition");
      if (round === 0) {
        // A busy main thread can deliver a blur timer after the old three-second
        // wall-clock retry window. The visible opener must regain ownership.
        document.activeElement.blur();
        const pauseUntil = performance.now() + 3_100;
        while (performance.now() < pauseUntil) { /* Hold browser task delivery. */ }
        await expectResponsiveFocus("sidebar opener focus after a delayed browser task", // NOSONAR S9382: each sidebar round observes the previous focus transition
          () => host.querySelector('[aria-label="Open projects sidebar"]'));
      }
      if (round === 1) {
        // Some engines blur a disappearing control before dispatching the media
        // change. Preserve the last owner even if activeElement is now BODY.
        document.activeElement.blur();
        assert(document.activeElement === document.body, "Blur did not simulate focus loss before breakpoint change");
      }
      await setWidth(1280);
      await until(() => host.querySelector("#project-sidebar").getAttribute("aria-hidden") === "false", `sidebar reopened after wide transition ${round + 1}`);
      if (round === 0) {
        // Chromium can remove focus after focus() succeeds during the sidebar
        // layout transition. The owner must restore it without a new resize.
        const focused = document.activeElement;
        if (host.querySelector("#project-sidebar").contains(focused)) focused.blur();
      }
      await expectResponsiveFocus(`visible sidebar focus after wide transition ${round + 1}`, // NOSONAR S9382: each sidebar round observes the previous focus transition
        () => host.querySelector("#project-sidebar").contains(document.activeElement) ? document.activeElement : null);
    }
    await setWidth(640);
    const opener = host.querySelector('[aria-label="Open projects sidebar"]');
    await expectResponsiveFocus("opener before intentional blank click", () => opener);
    host.querySelector("#main-workspace").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    opener.blur();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert(document.activeElement === document.body, "sidebar watcher reclaimed focus after an intentional blank click");
    await setWidth(1280);
    await until(() => host.querySelector("#project-sidebar").getAttribute("aria-hidden") === "false", "wide sidebar after intentional blank click");
    await remainsTrue(() => document.activeElement === document.body, 600,
      "sidebar reclaimed intentional BODY focus on a later breakpoint change");
  } catch (error) {
    // Bounded diagnosis for an intermittent macOS CI failure that has not
    // reproduced locally: whether the visible sidebar control could take focus
    // (the app's transfer gave up) or the browser refused it.
    const candidate = host.querySelector("#project-sidebar")?.querySelector("button:not(:disabled)");
    const rect = candidate?.getBoundingClientRect();
    const layout = { candidate: describe(candidate), rect: rect && [rect.left, rect.width, rect.height].map(Math.round), visibility: candidate && getComputedStyle(candidate).visibility,
      inert: Boolean(candidate?.closest("[inert]")), documentFocused: document.hasFocus(), visibilityState: document.visibilityState };
    candidate?.focus({ preventScroll: true });
    layout.probeFocused = document.activeElement === candidate;
    throw new Error(`${error.message}; layout=${JSON.stringify(layout)}; focusTrace=${JSON.stringify(trace.slice(-35))}`);
  } finally {
    document.removeEventListener("focusin", record, true);
    document.removeEventListener("focusout", record, true);
    window.removeEventListener("resize", record);
  }
}

async function spaceSidebarRegression() {
  const sidebarCopy = () => {
    const sidebar = host.querySelector("#project-sidebar");
    return [sidebar.textContent, ...[...sidebar.querySelectorAll("[aria-label]")].map((element) => element.getAttribute("aria-label"))].join("\n");
  };
  const assertNoGroupCopy = (copy, surface) => assert(!/group/i.test(copy.replaceAll("Ungrouped", "")), `${surface} still shows group copy: ${copy}`);
  const headings = () => [...host.querySelectorAll(".space-heading")].map((heading) => `${heading.querySelector("span").textContent}:${heading.querySelector("small").textContent}`);
  const base = { projects, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] };
  const fixtureRoute = (bootstrap, extra = async () => null) => async (url, options = {}) => {
    const handled = await extra(url, options);
    if (handled) return handled;
    if (url.pathname === "/api/bootstrap") return response({ ...base, ...bootstrap });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats[url.searchParams.get("projectId")]] });
    const match = url.pathname.match(/^\/api\/conversations\/chat-([AB])$/);
    if (match) return response(chats[match[1]]);
    return response({});
  };

  const moveTo = async (projectName, target) => {
    host.querySelector(`[aria-label="Project options for ${projectName}"]`).click();
    await until(() => [...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === target), `${target} menu item`);
    const menu = document.querySelector('[role="menu"]');
    [...menu.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === target).click();
    return menu;
  };

  // A bootstrap from an older runtime carries only the projectGroups alias,
  // and that runtime serves only the group routes and payloads.
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  let legacy = { groups: [{ id: "legacy", name: "Legacy space", position: 0 }], memberships: { A: "legacy" } };
  const legacyRequests = [];
  route = fixtureRoute({ projectGroups: legacy }, async (url, options) => {
    if (/^\/api\/(?:spaces|space-memberships)/.test(url.pathname)) return response({ error: "Unknown API route" }, 404);
    if (url.pathname === "/api/groups" && options.method === "POST") {
      const body = JSON.parse(options.body);
      legacyRequests.push(["create", body]);
      const created = { id: "legacy-2", name: body.name.trim(), position: 1 };
      legacy = { ...legacy, groups: [...legacy.groups, created] };
      return response(created, 201);
    }
    if (url.pathname === "/api/groups") return response(legacy);
    if (url.pathname === "/api/project-memberships" && options.method === "PUT") {
      const body = JSON.parse(options.body);
      legacyRequests.push(["move", body]);
      const { [body.projectId]: _previous, ...memberships } = legacy.memberships;
      legacy = { ...legacy, memberships: body.groupId ? { ...memberships, [body.projectId]: body.groupId } : memberships };
      return response(legacy);
    }
    return null;
  });
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => headings().length === 2, "legacy alias sidebar");
  assert(headings().join() === "Legacy space:1,Ungrouped:1", `Legacy alias sidebar: ${headings()}`);
  host.querySelector('[aria-label="New space"]').click();
  await until(() => document.querySelector("#space-name"), "legacy new space dialog");
  setControlValue(document.querySelector("#space-name"), "Legacy launches");
  await settle();
  [...document.querySelector('[role="dialog"]').querySelectorAll("button")].find((button) => button.textContent === "Create space").click();
  await until(() => headings().join() === "Legacy space:1,Legacy launches:0,Ungrouped:1", "legacy created space");
  await until(() => host.querySelector(".toast")?.textContent === "Space created", "legacy create toast");
  await moveTo("Review B", "Legacy launches");
  await until(() => headings().join() === "Legacy space:1,Legacy launches:1", "legacy moved project");
  await moveTo("Review A", "Ungrouped");
  await until(() => headings().join() === "Legacy space:0,Legacy launches:1,Ungrouped:1", "legacy unassigned project");
  assert(JSON.stringify(legacyRequests) === JSON.stringify([["create", { name: "Legacy launches" }], ["move", { projectId: "B", groupId: "legacy-2" }], ["move", { projectId: "A", groupId: null }]]),
    `Legacy requests: ${JSON.stringify(legacyRequests)}`);
  assert(!host.querySelector(".error-toast"), `Legacy sidebar showed an error: ${host.querySelector(".error-toast")?.textContent}`);

  root.render(null);
  await until(() => !host.querySelector(".space-heading"), "legacy alias sidebar unmounted");
  let state = { spaces: [{ id: "space-1", name: "Fixture space", position: 0 }], memberships: { A: "space-1" } };
  const requests = [];
  route = fixtureRoute({ spaces: state, projectGroups: { groups: [{ id: "stale", name: "Stale alias" }], memberships: {} } }, async (url, options) => {
    if (/^\/api\/(?:groups|project-memberships)/.test(url.pathname)) throw new Error(`UI used a compatibility alias: ${url.pathname}`);
    if (url.pathname === "/api/spaces" && options.method === "POST") {
      const body = JSON.parse(options.body);
      requests.push(["create", body]);
      const created = { id: "space-2", name: body.name.trim(), position: 1 };
      state = { ...state, spaces: [...state.spaces, created] };
      return response(created, 201);
    }
    if (url.pathname === "/api/spaces") return response(state);
    if (url.pathname === "/api/space-memberships" && options.method === "PUT") {
      const body = JSON.parse(options.body);
      requests.push(["move", body]);
      state = { ...state, memberships: { ...state.memberships, [body.projectId]: body.spaceId } };
      return response(state);
    }
    return null;
  });
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => headings().length === 2, "space sidebar");
  assert(headings().join() === "Fixture space:1,Ungrouped:1", `Sidebar did not prefer spaces over the alias: ${headings()}`);
  const tree = host.querySelector('[aria-label="Spaces, projects, and worktrees"]');
  assert(tree, "Sidebar tree lost its spaces label");
  assertNoGroupCopy(sidebarCopy(), "Sidebar");

  // OUT-31 keyboard traversal still walks space, project, worktree and action buttons.
  const buttons = [...tree.querySelectorAll("button:not(:disabled)")];
  buttons[0].focus();
  for (const [key, expected] of [["ArrowDown", buttons[1]], ["End", buttons.at(-1)], ["Home", buttons[0]], ["ArrowUp", buttons.at(-1)]]) {
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    assert(document.activeElement === expected, `${key} did not move sidebar focus`);
  }

  host.querySelector('[aria-label="New space"]').click();
  await until(() => document.querySelector("#space-name"), "new space dialog");
  const dialog = document.querySelector('[role="dialog"]');
  assert(dialog.querySelector("h2")?.textContent === "Create space", "Dialog title is not Create space");
  assert(dialog.querySelector('label[for="space-name"]').textContent === "Space name", "Dialog label is not Space name");
  assertNoGroupCopy(dialog.textContent, "Dialog");
  setControlValue(document.querySelector("#space-name"), "  Launches  ");
  await settle();
  [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Create space").click();
  await until(() => headings().length === 3, "created space heading");
  assert(JSON.stringify(requests[0]) === JSON.stringify(["create", { name: "  Launches  " }]), `Create request: ${JSON.stringify(requests)}`);
  assert(host.querySelector(".toast")?.textContent === "Space created", "Create toast is not Space created");

  const menu = await moveTo("Review B", "Launches");
  assert(menu.textContent.includes("Move to space"), "Project menu is not labeled Move to space");
  assertNoGroupCopy(menu.textContent, "Project menu");
  await until(() => headings().join() === "Fixture space:1,Launches:1", "moved project into its space");
  assert(JSON.stringify(requests[1]) === JSON.stringify(["move", { projectId: "B", spaceId: "space-2" }]), `Move request: ${JSON.stringify(requests)}`);
  await until(() => host.querySelector(".toast")?.textContent === "Space updated", "move toast");
  assertNoGroupCopy(sidebarCopy(), "Updated sidebar");
}

function paneRect(view) { return host.querySelector(`#pane-${view}`)?.getBoundingClientRect(); }
// What decides how many panes show, for a failing pane assertion: the
// layout's own props and measured stage, each pane's concealment, the
// viewport, focus and the page's visibility.
function describePaneState() {
  const element = host.querySelector(".pane-layout");
  const fiberKey = element && Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
  // The node keeps the fiber that last updated it; its alternate may be the
  // committed one. The committed host fiber's props match the DOM.
  let fiber = fiberKey ? element[fiberKey] : null;
  if (fiber?.alternate?.memoizedProps?.className === element.className) fiber = fiber.alternate;
  while (fiber && fiber.type?.name !== "PaneLayout") fiber = fiber.return;
  const props = fiber?.memoizedProps;
  const stage = element?.getBoundingClientRect();
  const active = document.activeElement;
  return JSON.stringify({
    compactPreferred: props?.compactPreferred, focused: props?.layout.focused, root: props?.layout.root,
    stage: stage && [stage.width, stage.height], fits: props && stage ? computePaneRects(props.layout.root, Math.floor(stage.width), Math.floor(stage.height)).fits : null,
    compactClass: element?.classList.contains("is-compact"), layouts: document.querySelectorAll(".pane-layout").length,
    tabs: [...host.querySelectorAll('[role="tab"][data-pane-view]')].map((tab) => `${tab.dataset.paneView}:${tab.getAttribute("aria-selected")}`),
    panes: [...host.querySelectorAll(".pane-stage > .pane")].map((pane) => ({ id: pane.id, inert: pane.inert, className: pane.className, visibility: getComputedStyle(pane).visibility, rect: pane.getBoundingClientRect().toJSON() })),
    conversationPanes: document.querySelectorAll("#pane-conversation").length,
    innerWidth: window.innerWidth, innerHeight: window.innerHeight, narrow: window.matchMedia("(max-width: 760px)").matches, page: document.visibilityState,
    active: active === document.body ? "body" : `${active?.tagName.toLowerCase()}#${active?.id}.${active?.className}`,
  });
}
// A control is usable when it lies inside its pane and is what a click at its centre reaches.
function assertReachableInPane(element, view, label) {
  const rect = element?.getBoundingClientRect();
  const pane = paneRect(view);
  assert(rect && rect.width > 0 && rect.height > 0 && rect.left >= pane.left - 1 && rect.right <= pane.right + 1 && rect.top >= pane.top - 1 && rect.bottom <= pane.bottom + 1,
    `${label} is clipped by its ${view} pane: ${JSON.stringify([rect?.toJSON(), pane.toJSON()])}`);
  assert(element.scrollWidth <= element.clientWidth + 1, `${label} clips its text: ${element.scrollWidth} > ${element.clientWidth}`);
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  if (element.contains(hit)) return;
  const style = getComputedStyle(element);
  const stack = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2).slice(0, 4).map((item) => `${item.tagName.toLowerCase()}.${item.className}`);
  throw new Error(`${label} is covered by ${hit?.outerHTML.slice(0, 120)}; at its centre: ${stack.join(" > ")}; rect=${JSON.stringify(rect.toJSON())}; visibility=${style.visibility}; pointer-events=${style.pointerEvents}; opacity=${style.opacity}; transform=${style.transform}; panes=${describePaneState()}`);
}
// Split panes tile the stage: no two overlap and none leaves it, on the
// settled commit and on each of the next frames.
async function assertPanesTile(label) {
  await settle();
  const describe = () => JSON.stringify({ visibility: document.visibilityState,
    stage: host.querySelector(".pane-stage")?.getBoundingClientRect().toJSON(),
    panes: [...host.querySelectorAll(".pane-stage > .pane")].map((pane) => ({ view: pane.dataset.paneView, style: pane.getAttribute("style"), rect: pane.getBoundingClientRect().toJSON() })) });
  for (let tick = 0; tick < 4; tick += 1) { // NOSONAR S9382: one sample per frame
    const stage = host.querySelector(".pane-stage").getBoundingClientRect();
    const rects = [...host.querySelectorAll(".pane-stage > .pane")].map((pane) => pane.getBoundingClientRect());
    for (const [index, rect] of rects.entries()) {
      assert(rect.left >= stage.left - 1 && rect.top >= stage.top - 1 && rect.right <= stage.right + 1 && rect.bottom <= stage.bottom + 1, `${label}: a pane leaves the stage: ${describe()}`);
      for (const other of rects.slice(index + 1)) {
        const overlap = Math.min(rect.right, other.right) - Math.max(rect.left, other.left) > 1 && Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top) > 1;
        assert(!overlap, `${label}: panes overlap: ${describe()}`);
      }
    }
    await frame();
  }
}
function paneOrder() { return [...host.querySelectorAll(".pane-stage > .pane")].map((element) => element.dataset.paneView).join(","); }
async function choosePaneMenuItem(view, label) {
  host.querySelector(`[aria-label="${view} pane options"]`).click();
  let item;
  await until(() => (item = [...document.querySelectorAll('[role="menuitem"]')].find((entry) => entry.textContent === label || entry.getAttribute("aria-label") === label)), `${view} pane menu item ${label}`);
  item.click();
}
function pressKey(target, key, options = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

// A conversation beside a terminal and a diff: nested splits with minimum
// sizes, keyboard resizing, moves that keep each view's mounted session,
// F6 focus cycling, restore after reload, and repair of a damaged layout.
async function splitPaneLayoutRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const requests = [];
  route = async (url, options = {}) => {
    requests.push(`${options.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats[url.searchParams.get("projectId")] ?? chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    if (url.pathname === "/api/conversations/chat-B") return response(chats.B);
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A"), terminal("B")] });
    if (url.pathname.startsWith("/api/terminals/")) return response({ buffer: "Split pane fixture\r\n" });
    if (url.pathname === "/api/git/status") return response({ branch: "main", files: [], stagedCount: 0 });
    if (url.pathname === "/api/context") return response({ instructionFiles: [], skills: [], pullRequest: null });
    return response({});
  };
  const terminalRequests = () => requests.filter((request) => request.includes("/api/terminals")).length;
  try {
    if (window.__fixtureSetViewport) {
      await window.__fixtureSetViewport(1280);
      await until(() => window.innerWidth === 1280, "wide split viewport");
      window.dispatchEvent(new Event("resize"));
    }
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelector('textarea[aria-label="Message the agent"]'), "split fixture");
    assert(!host.querySelector(".pane-header") && !host.querySelector('.pane-separator'), "A lone conversation showed split chrome");
    const composer = host.querySelector('textarea[aria-label="Message the agent"]');
    setControlValue(composer, "Draft kept across pane moves");

    host.querySelector('[aria-label="Terminal"]').click();
    await until(() => terminalReady("Terminal A") && document.activeElement === host.querySelector("#pane-terminal"), "terminal pane beside the conversation");
    await assertPanesTile("Terminal beside the conversation");
    assert(paneRect("terminal").left >= paneRect("conversation").right && Math.abs(paneRect("terminal").top - paneRect("conversation").top) < 1,
      "The terminal did not open beside the conversation");
    // The focused terminal is taller than its split share is wide: Changes nests below it.
    host.querySelector('[aria-label="Changes"]').click();
    await until(() => host.querySelector("#pane-changes .changes-pane"), "changes pane");
    await assertPanesTile("Changes below the terminal");
    assert(Math.abs(paneRect("terminal").left - paneRect("changes").left) < 1 && paneRect("changes").top >= paneRect("terminal").bottom,
      `Changes did not nest below the terminal: ${JSON.stringify([paneRect("terminal"), paneRect("changes")])}`);
    assert(paneOrder() === "conversation,terminal,changes", `Panes are not in reading order: ${paneOrder()}`);
    const xterm = host.querySelector(".terminal-host .xterm");
    const listedTerminals = terminalRequests();

    const outer = host.querySelector('.pane-separator[role="separator"][aria-label="Resize Conversation and Terminal and Changes"]');
    assert(outer?.getAttribute("aria-orientation") === "vertical" && outer.getAttribute("aria-controls") === "pane-conversation pane-terminal pane-changes", "The outer split has no labelled vertical separator");
    const before = paneRect("conversation").width;
    const valueBefore = Number(outer.getAttribute("aria-valuenow"));
    outer.focus();
    assert(pressKey(outer, "ArrowRight").defaultPrevented, "ArrowRight on a separator was not handled");
    await until(() => paneRect("conversation").width > before, "ArrowRight widens the conversation");
    assert(Number(outer.getAttribute("aria-valuenow")) > valueBefore, "The separator value did not follow the resize");
    pressKey(outer, "End");
    await until(() => Math.abs(paneRect("changes").width - 280) <= 1, "End stops at the right column's minimum width");
    pressKey(outer, "Home");
    await until(() => Math.abs(paneRect("conversation").width - 320) <= 1, "Home stops at the conversation's minimum width");
    assert(pressKey(outer, "ArrowUp").defaultPrevented === false, "A vertical separator handled ArrowUp");
    // A pointer drag follows the pointer and saves the layout once, on release.
    const layoutWrites = [];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function recordLayoutWrite(key, value) {
      if (key === LAYOUT_KEY) layoutWrites.push(value);
      return setItem.call(this, key, value);
    };
    try {
      const start = outer.getBoundingClientRect();
      const pointer = (type, dx) => outer.dispatchEvent(new PointerEvent(type, { pointerId: 7, button: 0, clientX: start.left + start.width / 2 + dx, clientY: start.top + 100, bubbles: true, cancelable: true }));
      pointer("pointerdown", 0);
      for (const dx of [20, 40, 60]) { pointer("pointermove", dx); await frame(); }
      await until(() => Math.abs(paneRect("conversation").width - 380) <= 1, "the conversation follows the dragged separator");
      assert(layoutWrites.length === 0, `A separator drag saved the layout ${layoutWrites.length} times before release`);
      pointer("pointerup", 60);
      await until(() => layoutWrites.length === 1, "releasing the separator saves the layout");
      await settle();
      assert(layoutWrites.length === 1 && Math.abs(paneRect("conversation").width - 380) <= 1, `Release saved ${layoutWrites.length} times or moved the separator`);
    } finally {
      Storage.prototype.setItem = setItem;
    }
    const inner = host.querySelector('.pane-separator[role="separator"][aria-label="Resize Terminal and Changes"]');
    inner.focus();
    pressKey(inner, "End");
    await until(() => Math.abs(paneRect("changes").height - 340) <= 1, "End stops at the diff's minimum height");
    pressKey(inner, "Home");
    await until(() => Math.abs(paneRect("terminal").height - 200) <= 1, "Home stops at the terminal's minimum height");
    pressKey(inner, "ArrowDown");
    await until(() => paneRect("terminal").height > 201, "ArrowDown grows the terminal");

    await choosePaneMenuItem("Terminal", "Move left");
    await until(() => paneRect("terminal").right <= paneRect("conversation").left + 1, "Move left swaps the terminal with the conversation");
    await until(() => document.activeElement === host.querySelector("#pane-terminal"), "the moved pane keeps focus");
    assert(paneOrder() === "terminal,conversation,changes", `Moved panes are not in reading order: ${paneOrder()}`);
    assert(host.querySelector(".terminal-host .xterm") === xterm && xterm.isConnected, "Moving the terminal remounted its view");
    assert(host.querySelector('textarea[aria-label="Message the agent"]') === composer && composer.value === "Draft kept across pane moves", "Moving panes lost the conversation draft");
    assert(terminalRequests() === listedTerminals, `Moving the terminal reloaded its session: ${requests.slice(-4).join(", ")}`);

    // F6 and Shift+F6 cycle panes in reading order, even from terminal input.
    pressKey(document.activeElement, "F6");
    await until(() => document.activeElement === host.querySelector("#pane-conversation"), "F6 reaches the conversation pane");
    pressKey(document.activeElement, "F6");
    await until(() => document.activeElement === host.querySelector("#pane-changes"), "F6 reaches the changes pane");
    pressKey(document.activeElement, "F6");
    await until(() => document.activeElement === host.querySelector("#pane-terminal"), "F6 wraps to the first pane");
    pressKey(document.activeElement, "F6", { shiftKey: true });
    await until(() => document.activeElement === host.querySelector("#pane-changes"), "Shift+F6 moves backwards");
    const terminalInput = host.querySelector(".terminal-host .xterm-helper-textarea");
    terminalInput.focus();
    assert(pressKey(terminalInput, "F6").defaultPrevented, "F6 from terminal input was not handled");
    await until(() => document.activeElement === host.querySelector("#pane-conversation"), "F6 leaves terminal input for the next pane");

    // Dragging a pane header onto another pane's edge docks it there.
    const dataTransfer = new DataTransfer();
    const handle = host.querySelector("#pane-changes .pane-title");
    handle.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
    const target = host.querySelector("#pane-terminal");
    const targetRect = target.getBoundingClientRect();
    const point = { clientX: targetRect.left + 6, clientY: targetRect.top + targetRect.height / 2 };
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer, ...point }));
    await until(() => host.querySelector("#pane-terminal .pane-drop-indicator.is-left"), "left-edge drop indicator");
    target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, ...point }));
    handle.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
    await until(() => paneOrder() === "changes,terminal,conversation" && paneRect("changes").right <= paneRect("terminal").left + 1, "drop docks Changes left of the terminal");
    assert(!host.querySelector(".pane-drop-indicator"), "The drop indicator remained after the drop");
    assert(host.querySelector(".terminal-host .xterm") === xterm && terminalRequests() === listedTerminals, "Docking another pane restarted the terminal view");
    for (const [view, width, height] of [["changes", 280, 340], ["terminal", 260, 200], ["conversation", 320, 300]]) {
      const rect = paneRect(view);
      assert(rect.width >= width - 1 && rect.height >= height - 1, `${view} is below its minimum size: ${JSON.stringify(rect.toJSON())}`);
    }

    // A title drag belongs to the tree it started in. When another action
    // replaces that tree before dragend, the abandoned drag cannot dock.
    const abandonedDrag = async (replace, label) => {
      const transfer = new DataTransfer();
      const edge = () => { const rect = host.querySelector("#pane-terminal").getBoundingClientRect(); return { clientX: rect.left + 6, clientY: rect.top + rect.height / 2 }; };
      const send = (type) => { const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer, ...edge() }); host.querySelector("#pane-terminal").dispatchEvent(event); return event; };
      host.querySelector("#pane-changes .pane-title").dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      send("dragover");
      await until(() => host.querySelector("#pane-terminal .pane-drop-indicator"), `${label}: drop indicator before the tree changes`);
      await replace();
      await until(() => !host.querySelector(".pane-drop-indicator"), `${label}: the abandoned drag's drop indicator was cleared`);
      const before = paneOrder();
      assert(!send("dragover").defaultPrevented, `${label}: the replaced tree accepted the abandoned drag`);
      send("drop");
      await settle();
      assert(paneOrder() === before && !host.querySelector(".pane-drop-indicator"), `${label}: the abandoned drag moved panes: ${before} -> ${paneOrder()}`);
    };
    await abandonedDrag(() => choosePaneMenuItem("Terminal", "Move right"), "a pane move during a title drag");
    await choosePaneMenuItem("Terminal", "Move left");
    await until(() => paneOrder() === "changes,terminal,conversation", `moving the terminal back restores the arrangement, not ${paneOrder()}`);

    if (window.__fixtureSetViewport) {
      // A title drag does not survive one-at-a-time panes either.
      await abandonedDrag(async () => {
        await window.__fixtureSetViewport(900);
        await until(() => window.innerWidth === 900, "900px viewport during a title drag");
        window.dispatchEvent(new Event("resize"));
        await until(() => host.querySelector('[role="tablist"][aria-label="Panes"]'), "one-at-a-time panes during a title drag");
        await window.__fixtureSetViewport(1280);
        await until(() => window.innerWidth === 1280, "wide viewport after a title drag");
        window.dispatchEvent(new Event("resize"));
        await until(() => host.querySelectorAll('.pane-separator[role="separator"]').length === 2, "split panes after a title drag");
      }, "a compact transition during a title drag");
      // Too narrow for every minimum: one pane at a time, same mounted views.
      await window.__fixtureSetViewport(900);
      await until(() => window.innerWidth === 900, "900px viewport");
      window.dispatchEvent(new Event("resize"));
      await until(() => host.querySelector('[role="tablist"][aria-label="Panes"]'), "panes that no longer fit are shown one at a time");
      assert(host.querySelectorAll(".pane-stage > .pane:not([inert])").length === 1 && !host.querySelector('.pane-separator'), "A layout below its minimum stayed split");
      assert(host.querySelector(".terminal-host .xterm") === xterm, "Entering one-at-a-time panes remounted the terminal");
      await window.__fixtureSetViewport(1280);
      await until(() => window.innerWidth === 1280, "wide viewport again");
      window.dispatchEvent(new Event("resize"));
      await until(() => !host.querySelector('[role="tablist"][aria-label="Panes"]') && host.querySelectorAll('.pane-separator[role="separator"]').length === 2, "a wide window splits panes again");
      assert(host.querySelector(".terminal-host .xterm") === xterm, "Leaving one-at-a-time panes remounted the terminal");
    }

    // A reload restores the worktree's arrangement and sizes.
    // The sidebar's width transition and the layout's next measurement settle
    // before sizes are compared: the same pane sizes across several frames.
    let previousSizes = "";
    let stableFrames = 0;
    await until(() => {
      const sizes = JSON.stringify(["changes", "terminal", "conversation"].map((view) => paneRect(view).toJSON()));
      stableFrames = sizes === previousSizes && !document.getAnimations().some((animation) => animation.playState === "running") ? stableFrames + 1 : 0;
      previousSizes = sizes;
      return stableFrames >= 3;
    }, "settled pane sizes");
    const arranged = Object.fromEntries(["changes", "terminal", "conversation"].map((view) => [view, paneRect(view).toJSON()]));
    root.render(null);
    await settle();
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => terminalReady("Terminal A") && host.querySelector("#pane-changes .changes-pane"), "restored split layout");
    assert(paneOrder() === "changes,terminal,conversation", `Reload restored another arrangement: ${paneOrder()}`);
    for (const [view, rect] of Object.entries(arranged)) {
      const restored = paneRect(view);
      assert(Math.abs(restored.left - rect.left) <= 1 && Math.abs(restored.width - rect.width) <= 1 && Math.abs(restored.height - rect.height) <= 1,
        `Reload restored ${view} at another size: ${JSON.stringify([rect, restored.toJSON()])}`);
    }

    // Another worktree keeps its own layout; returning restores this one.
    const restoredXterm = host.querySelector(".terminal-host .xterm");
    host.querySelector('[aria-label="Expand Review B"]')?.click();
    await until(() => [...host.querySelectorAll(".worktree-row")].some((row) => row.textContent.includes("B")), "worktree B row");
    [...host.querySelectorAll(".worktree-row")].find((row) => row.querySelector("strong")?.textContent === "B").click();
    await until(() => host.querySelector('textarea[placeholder*="in B"]') && !host.querySelector("#pane-terminal") && !host.querySelector(".pane-header"), "worktree B opens its own default layout");
    [...host.querySelectorAll(".worktree-row")].find((row) => row.querySelector("strong")?.textContent === "A").click();
    await until(() => terminalReady("Terminal A") && paneOrder() === "changes,terminal,conversation", "worktree A's layout returns");
    assert(restoredXterm !== host.querySelector(".terminal-host .xterm"), "The worktree switch reused another worktree's terminal view");

    // Closing a pane unmounts its view but leaves the shell running.
    const closeFrom = terminalRequests();
    host.querySelector("#pane-terminal").focus();
    await choosePaneMenuItem("Terminal", "Close Terminal pane");
    await until(() => !host.querySelector("#pane-terminal"), "terminal pane closed");
    await until(() => document.activeElement === host.querySelector("#pane-changes") || document.activeElement === host.querySelector("#pane-conversation"), "focus moves to the pane that took the closed pane's place");
    assert(!host.querySelector(".terminal-host") && !requests.slice(closeFrom).some((request) => request.startsWith("DELETE")), `Closing the pane ended the shell: ${requests.slice(closeFrom).join(", ")}`);

    // A saved layout with an unknown view, a duplicate and a bad size is repaired.
    root.render(null);
    await settle();
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ version: 1, worktrees: { "/fixture/A": { savedAt: 1, layout: { version: 1, focused: "browser", root: {
      type: "split", axis: "row", ratio: "wide", first: { type: "pane", view: "terminal" },
      second: { type: "split", axis: "column", ratio: 0.5, first: { type: "pane", view: "browser" }, second: { type: "pane", view: "terminal" } },
    } } } } }));
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => terminalReady("Terminal A"), "repaired layout");
    assert(paneOrder() === "conversation,terminal", `Repair kept invalid panes: ${paneOrder()}`);
    await until(() => host.querySelector(".toast")?.textContent.includes("panes that could not be restored were left out"), "repair notice");
    assert(JSON.parse(localStorage.getItem(LAYOUT_KEY)).worktrees["/fixture/A"].layout.root.first.view === "terminal", "Restoring rewrote the saved layout before a change");

    root.render(null);
    await settle();
    localStorage.setItem(LAYOUT_KEY, "{unreadable");
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelector(".toast")?.textContent.includes("could not be read; showing the default layout"), "unreadable layout notice");
    assert(paneOrder() === "conversation" && !host.querySelector(".pane-header"), "An unreadable layout did not fall back to the default");
    // The damaged store is announced once, not again for each worktree.
    await until(() => !host.querySelector(".toast"), "unreadable layout notice dismissed");
    host.querySelector('[aria-label="Expand Review B"]')?.click();
    await until(() => [...host.querySelectorAll(".worktree-row")].some((row) => row.textContent.includes("B")), "worktree B row after unreadable store");
    [...host.querySelectorAll(".worktree-row")].find((row) => row.querySelector("strong")?.textContent === "B").click();
    await until(() => host.querySelector('textarea[placeholder*="in B"]'), "worktree B after unreadable store");
    for (let index = 0; index < 4; index += 1) await frame(); // NOSONAR S9382: a repeated notice would render within these frames
    assert(!host.querySelector(".toast")?.textContent.includes("could not be read"), "The unreadable layout store was announced again for another worktree");
  } finally {
    root.render(null);
    await settle();
  }
  return true;
}

// Every view stays usable at its minimum pane size: message lines beside the
// composer, changed files and diff lines with the commit bar, terminal rows
// and context content, also when a saved layout restores those minimums.
async function paneMinimumContentRegression() {
  if (!window.__fixtureSetViewport) return false;
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const messages = Array.from({ length: 8 }, (_, index) => ({ id: `minimum-${index}`, role: index % 2 ? "assistant" : "user", kind: "text", body: `Minimum size message ${index}`, createdAt: "2026-10-24T00:00:00Z" }));
  const chat = { ...chats.A, messages };
  const files = Array.from({ length: 6 }, (_, index) => ({ path: `src/file-${index}.js`, status: "M" }));
  const diff = Array.from({ length: 60 }, (_, index) => `${index % 3 ? "+" : "-"}minimum diff line ${index}`).join("\n");
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chat] });
    if (url.pathname === "/api/conversations/chat-A") return response(chat);
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A")] });
    if (url.pathname.startsWith("/api/terminals/")) return response({ buffer: "Minimum pane fixture\r\n" });
    if (url.pathname === "/api/git/status") return response({ branch: "main", files, stagedCount: 0 });
    if (url.pathname === "/api/git/diff") return response({ diff });
    if (url.pathname === "/api/context") return response({ instructionFiles: [], skills: [], pullRequest: null });
    return response({});
  };
  const saved = (focused, layout) => localStorage.setItem(LAYOUT_KEY, JSON.stringify({ version: 1, worktrees: { "/fixture/A": { savedAt: 1, layout: { version: 1, focused, root: layout } } } }));
  const leaf = (view) => ({ type: "pane", view });
  const inside = (element, view, label) => {
    const rect = element?.getBoundingClientRect();
    const pane = paneRect(view);
    assert(rect && rect.width > 0 && rect.height > 0 && rect.left >= pane.left - 1 && rect.right <= pane.right + 1 && rect.top >= pane.top - 1 && rect.bottom <= pane.bottom + 1,
      `${label} is clipped by its ${view} pane: ${JSON.stringify([rect?.toJSON(), pane.toJSON()])}`);
  };
  const usable = {
    conversation: () => {
      const viewport = host.querySelector('#pane-conversation [aria-label="Conversation messages"]');
      assert(viewport.clientHeight >= 90, `The conversation at ${JSON.stringify(paneRect("conversation").toJSON())} shows ${viewport.clientHeight}px of messages`);
      inside(viewport, "conversation", "The message list");
      inside(host.querySelector('#pane-conversation textarea[aria-label="Message the agent"]'), "conversation", "The composer");
      inside(host.querySelector('#pane-conversation [aria-label="Send message"]'), "conversation", "The send button");
    },
    changes: () => {
      const list = host.querySelector("#pane-changes .changed-files");
      const lines = host.querySelector("#pane-changes .diff-view");
      assert(list.clientHeight >= 60, `The changed file list is ${list.clientHeight}px high`);
      assert(lines.clientHeight >= 70, `The diff at ${JSON.stringify(paneRect("changes").toJSON())} shows ${lines.clientHeight}px of lines`);
      inside(lines, "changes", "The diff");
      inside(host.querySelector('#pane-changes [aria-label="Commit message"]'), "changes", "The commit message");
      inside([...host.querySelectorAll("#pane-changes .commit-bar button")].find((button) => button.textContent.includes("Commit")), "changes", "The commit button");
    },
    terminal: () => {
      const screen = host.querySelector("#pane-terminal .xterm-screen");
      assert(screen.getBoundingClientRect().height >= 60, `The terminal shows ${screen.getBoundingClientRect().height}px of rows`);
      inside(host.querySelector("#pane-terminal .terminal-host"), "terminal", "The terminal");
    },
    context: () => {
      const content = host.querySelector("#pane-context .context-pane-content");
      assert(content.clientHeight >= 100 && content.clientWidth >= 200, `The context content is ${content.clientWidth}x${content.clientHeight}`);
    },
  };
  const near = (value, expected, label) => assert(Math.abs(value - expected) <= 1, `${label}: ${value} instead of ${expected}`);
  try {
    await window.__fixtureSetViewport(1280);
    await until(() => window.innerWidth === 1280, "wide minimum viewport");
    window.dispatchEvent(new Event("resize"));

    // Restored at the narrowest conversation and the shortest diff.
    saved("conversation", { type: "split", axis: "row", ratio: 0.05, first: leaf("conversation"),
      second: { type: "split", axis: "column", ratio: 0.95, first: leaf("terminal"), second: leaf("changes") } });
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => terminalReady("Terminal A") && host.querySelector("#pane-changes .diff-view span:not(.diff-empty)")
      && host.querySelector("#pane-conversation .message-text"), "restored minimum layout");
    await settle();
    near(paneRect("conversation").width, 320, "The restored conversation width");
    near(paneRect("changes").height, 340, "The restored changes height");
    usable.conversation();
    usable.changes();
    const inner = host.querySelector('.pane-separator[role="separator"][aria-label="Resize Terminal and Changes"]');
    inner.focus();
    pressKey(inner, "Home");
    await until(() => Math.abs(paneRect("terminal").height - 200) <= 1, "terminal at its minimum height");
    await settle();
    usable.terminal();

    // Restored at the shortest conversation and the narrowest context.
    root.render(null);
    await settle();
    saved("conversation", { type: "split", axis: "column", ratio: 0.05, first: leaf("conversation"),
      second: { type: "split", axis: "row", ratio: 0.95, first: leaf("changes"), second: leaf("context") } });
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelector("#pane-context .context-pane-content") && host.querySelector("#pane-changes .diff-view span:not(.diff-empty)")
      && host.querySelector("#pane-conversation .message-text"), "restored short conversation layout");
    await settle();
    near(paneRect("conversation").height, 400, "The restored conversation height");
    near(paneRect("context").width, 240, "The restored context width");
    usable.conversation();
    usable.context();
    usable.changes();
  } finally {
    root.render(null);
    await settle();
  }
  return true;
}

// Notices and controls inside a pane follow the pane's width, not the
// window's: on a wide window a conversation at its minimum width keeps the
// recovery explanation and every decision readable and clickable, the unsent
// first-prompt notice keeps its buttons, and the commit bar fits Changes at
// its minimum width.
async function paneNoticeMinimumRegression() {
  if (!window.__fixtureSetViewport) return false;
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const interrupted = { id: "run-interrupted", conversationId: "chat-A", status: "interrupted", recoveryClass: "exited", provider: "codex", providerSessionId: "session-A" };
  const recoveryChat = { ...chats.A, providerSessionId: "session-A", runs: [interrupted] };
  const created = { ...chats.A, id: "chat-unsent", title: "Unsent first prompt" };
  let conversations = [recoveryChat];
  route = async (url, options = {}) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations" && options.method === "POST") { conversations = [created]; return response(created, 201); }
    if (url.pathname === "/api/conversations") return response({ conversations });
    if (url.pathname === "/api/conversations/chat-A") return response(recoveryChat);
    if (url.pathname === "/api/conversations/chat-unsent") return response({ error: "Chat details unavailable" }, 503);
    if (url.pathname === "/api/git/status") return response({ branch: "main", files: [{ path: "src/notice.js", status: "M" }], stagedCount: 12 });
    if (url.pathname === "/api/git/diff") return response({ diff: "+notice line" });
    if (url.pathname === "/api/context") return response({ instructionFiles: [], skills: [], pullRequest: null });
    return response({});
  };
  const leaf = (view) => ({ type: "pane", view });
  const saveMinimumLayout = () => localStorage.setItem(LAYOUT_KEY, JSON.stringify({ version: 1, worktrees: { "/fixture/A": { savedAt: 1, layout: { version: 1, focused: "conversation", root: {
    type: "split", axis: "row", ratio: 0.05, first: leaf("conversation"), second: { type: "split", axis: "row", ratio: 0.95, first: leaf("context"), second: leaf("changes") },
  } } } } }));
  // Each switch between split and one-at-a-time panes, with the stage size,
  // so a failing reachability check shows whether a pane was concealed.
  const modes = [];
  const recordModes = new MutationObserver((records) => {
    for (const { target } of records) {
      if (!target.classList.contains("pane-layout")) continue;
      const stage = target.getBoundingClientRect();
      modes.push(`${target.classList.contains("is-compact") ? "compact" : "split"} ${stage.width}x${stage.height} at ${Math.round(performance.now())}ms`);
    }
  });
  recordModes.observe(host, { attributes: true, subtree: true, attributeFilter: ["class"] });
  const reachable = (element, view, label) => {
    try { assertReachableInPane(element, view, label); }
    catch (error) { throw new Error(`${error.message}; layout modes: ${modes.join(", ") || "none"}; now ${Math.round(performance.now())}ms`, { cause: error }); }
  };
  try {
    await window.__fixtureSetViewport(1280);
    await until(() => window.innerWidth === 1280, "wide notice viewport");
    window.dispatchEvent(new Event("resize"));

    saveMinimumLayout();
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelectorAll("#pane-conversation .recovery-actions button").length === 3
      && host.querySelector('#pane-changes .commit-bar [aria-label="Commit message"]'), "recovery notice beside Changes at their minimum widths");
    await settle();
    assert(Math.abs(paneRect("conversation").width - 320) <= 1 && Math.abs(paneRect("changes").width - 280) <= 1,
      `The panes are not at their minimum widths: ${JSON.stringify([paneRect("conversation").toJSON(), paneRect("changes").toJSON()])}`);
    const copy = host.querySelector("#pane-conversation .recovery-copy");
    assert(copy.getBoundingClientRect().width >= 200, `The recovery explanation is ${copy.getBoundingClientRect().width}px wide in a 320px conversation pane`);
    reachable(copy, "conversation", "The recovery explanation");
    for (const button of host.querySelectorAll("#pane-conversation .recovery-actions button")) reachable(button, "conversation", button.textContent.trim());
    const commitMessage = host.querySelector('#pane-changes .commit-bar [aria-label="Commit message"]');
    assert(commitMessage.getBoundingClientRect().width >= 200, `The commit message field is ${commitMessage.getBoundingClientRect().width}px wide in a 280px Changes pane`);
    reachable(commitMessage, "changes", "The commit message");
    setControlValue(commitMessage, "Commit from a narrow pane");
    await until(() => [...host.querySelectorAll("#pane-changes .commit-bar button")].some((button) => button.textContent.includes("Commit") && !button.disabled), "commit enabled");
    const commitButton = [...host.querySelectorAll("#pane-changes .commit-bar button")].find((button) => button.textContent.includes("Commit"));
    // The layout's first commit shows one pane at a time until it measures
    // its stage, so the button's transitions start from its concealed and
    // disabled style. Before an animation frame they still report that start,
    // hidden, so hit testing waits for them to finish.
    await until(() => commitButton.getAnimations().every((animation) => animation.playState === "finished"), "commit button transitions finished");
    reachable(commitButton, "changes", "The commit button");

    // A first prompt whose chat was created but not sent, in the same pane.
    root.render(null);
    await settle();
    conversations = [];
    localStorage.removeItem(keys[2]);
    saveMinimumLayout();
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelector('#pane-conversation textarea[aria-label="Message the agent"]:not(:disabled)'), "empty worktree composer");
    setControlValue(host.querySelector('textarea[aria-label="Message the agent"]'), "First prompt in a narrow pane");
    await until(() => host.querySelector('[aria-label="Send message"]:not(:disabled)'), "first prompt enabled");
    host.querySelector('[aria-label="Send message"]').click();
    await until(() => host.querySelector("#pane-conversation .first-prompt-notice button"), "unsent first-prompt notice");
    await until(() => !host.querySelector(".toast"), "notices settle");
    await settle();
    const notice = host.querySelector("#pane-conversation .first-prompt-notice");
    assert(notice.getBoundingClientRect().width >= 260, `The unsent prompt notice is ${notice.getBoundingClientRect().width}px wide`);
    for (const button of notice.querySelectorAll("button")) reachable(button, "conversation", button.textContent.trim());
  } finally {
    recordModes.disconnect();
    root.render(null);
    await settle();
  }
  return true;
}

// At the conversation's minimum height its notices share one bounded region
// between the transcript and the composer: the transcript keeps several
// message lines, recovery and first-prompt actions stay pinned in view, and
// every other notice control is reachable by scrolling that region alone.
async function paneNoticeShortRegression() {
  if (!window.__fixtureSetViewport) return false;
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const messages = Array.from({ length: 8 }, (_, index) => ({ id: `short-${index}`, role: index % 2 ? "assistant" : "user", kind: "text", body: `Short pane message ${index}`, createdAt: "2026-10-24T00:00:00Z" }));
  const interrupted = { id: "run-interrupted", conversationId: "chat-A", status: "interrupted", recoveryClass: "exited", provider: "codex", providerSessionId: "session-A" };
  const pendingRun = { id: "run-pending", conversationId: "chat-A", status: "running", outcomePending: true, provider: "codex" };
  const checkpoint = { id: "short-checkpoint", role: "assistant", kind: "text", body: Array.from({ length: 12 }, (_, index) => `Live checkpoint line ${index}`).join("\n"), payload: { runId: "run-pending", checkpointEventSeq: 1 }, createdAt: "2026-10-24T00:00:01Z" };
  const details = {
    interrupted: { ...chats.A, providerSessionId: "session-A", runs: [interrupted], messages },
    pending: { ...chats.A, runs: [pendingRun], messages: [...messages, checkpoint], messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 4, total: 13, beforeId: "short-0" } },
  };
  const created = { ...chats.A, id: "chat-unsent", title: "Unsent first prompt" };
  let mode = "interrupted";
  let conversations = [details.interrupted];
  route = async (url, options = {}) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations" && options.method === "POST") { conversations = [created]; return response(created, 201); }
    if (url.pathname === "/api/conversations") return response({ conversations });
    if (url.pathname === "/api/conversations/chat-A") return response(details[mode]);
    if (url.pathname === "/api/conversations/chat-unsent") return response({ error: "Chat details unavailable" }, 503);
    if (url.pathname === "/api/git/status") return response({ branch: "main", files: [], stagedCount: 0 });
    if (url.pathname === "/api/context") return response({ instructionFiles: [], skills: [], pullRequest: null });
    return response({});
  };
  const leaf = (view) => ({ type: "pane", view });
  const render = async () => {
    root.render(null);
    await settle();
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ version: 1, worktrees: { "/fixture/A": { savedAt: 1, layout: { version: 1, focused: "conversation", root: {
      type: "split", axis: "row", ratio: 0.05, first: { type: "split", axis: "column", ratio: 0.05, first: leaf("conversation"), second: leaf("context") }, second: leaf("changes"),
    } } } } }));
    root.render(<TooltipProvider><App /></TooltipProvider>);
  };
  const query = (selector) => host.querySelector(`#pane-conversation ${selector}`);
  const notices = () => query(".conversation-notices");
  const transcriptKept = (label) => {
    const viewport = query('[aria-label="Conversation messages"]');
    assert(viewport.clientHeight >= 60, `${label}: the transcript of a ${JSON.stringify(paneRect("conversation").toJSON())} conversation shows ${viewport.clientHeight}px`);
    assertReachableInPane(viewport, "conversation", `${label}: the message list`);
    assertReachableInPane(query('textarea[aria-label="Message the agent"]'), "conversation", `${label}: the composer`);
  };
  // Shows a control by scrolling the notices region, never the pane around it.
  const reveal = (element) => {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    for (const outer of [host.querySelector("#pane-conversation"), query(".pane-body") ?? host.querySelector("#pane-conversation .pane-body"), query(".conversation-pane")]) {
      assert(!outer?.scrollTop, `Revealing ${element.textContent.trim().slice(0, 40)} scrolled ${outer?.className} instead of the notices`);
    }
    return element;
  };
  // How much of an element shows in the notices region, above any actions pinned over it.
  const visibleHeight = (element, pinned = null) => {
    const rect = element.getBoundingClientRect();
    const region = notices().getBoundingClientRect();
    const bottom = Math.min(rect.bottom, region.bottom, pinned ? pinned.getBoundingClientRect().top : Infinity);
    return Math.max(0, bottom - Math.max(rect.top, region.top));
  };
  try {
    await window.__fixtureSetViewport(1280);
    await until(() => window.innerWidth === 1280, "wide short-pane viewport");
    window.dispatchEvent(new Event("resize"));

    // An interrupted run: the explanation and every decision beside the transcript.
    await render();
    await until(() => query(".recovery-actions button") && query('[data-message-id="short-7"]'), "interrupted run at the minimum height");
    await settle();
    const minimum = paneRect("conversation");
    assert(Math.abs(minimum.width - 320) <= 1 && !host.querySelector(".pane-switcher"), `The conversation is not a split pane at its minimum width: ${JSON.stringify(minimum.toJSON())}`);
    assert(Math.abs(paneRect("context").top - minimum.bottom - 6) <= 1, "The conversation is not at its minimum height above Context");
    transcriptKept("Interrupted run");
    const copy = query(".recovery-copy");
    assert(copy.getBoundingClientRect().width >= 200 && visibleHeight(copy, query(".recovery-actions")) >= 48,
      `Only ${visibleHeight(copy, query(".recovery-actions"))}px of the recovery explanation shows above its actions in ${notices().clientHeight}px of notices`);
    const actions = [...host.querySelectorAll("#pane-conversation .recovery-actions button")];
    assert(actions.length === 3, "The recovery decisions are missing");
    for (const button of actions) assertReachableInPane(button, "conversation", button.textContent.trim());
    notices().scrollTop = notices().scrollHeight;
    await settle();
    for (const button of actions) assertReachableInPane(button, "conversation", `${button.textContent.trim()} after scrolling the notices`);
    assert(reveal(copy.querySelector("p")).getBoundingClientRect().top >= notices().getBoundingClientRect().top - 1, "The start of the recovery explanation cannot be scrolled into view");

    // A pending outcome while reading history with a live tail: three notices at once.
    mode = "pending";
    conversations = [details.pending];
    await render();
    await until(() => query(".history-live-tail")?.textContent.includes("Live checkpoint line 11") && query(".history-forward .history-return")
      && query(".recovery-notice")?.textContent.includes("Run outcome waiting for storage"), "pending outcome, history and live tail together");
    await settle();
    transcriptKept("Pending outcome");
    for (const control of [query(".history-live-tail"), query(".history-later"), query(".history-return")]) {
      assertReachableInPane(reveal(control), "conversation", control.getAttribute("aria-label") ?? control.textContent.trim());
    }
    const pending = query(".recovery-notice .recovery-copy");
    reveal(pending);
    assert(visibleHeight(pending) >= Math.min(60, pending.getBoundingClientRect().height - 1), `Only ${visibleHeight(pending)}px of the pending outcome notice shows`);
    transcriptKept("Pending outcome after scrolling the notices");

    // A first prompt whose chat was created but not sent.
    mode = "interrupted";
    conversations = [];
    localStorage.removeItem(keys[2]);
    await render();
    await until(() => query('textarea[aria-label="Message the agent"]:not(:disabled)'), "empty worktree composer at the minimum height");
    setControlValue(query('textarea[aria-label="Message the agent"]'), "First prompt in a short pane");
    await until(() => query('[aria-label="Send message"]:not(:disabled)'), "first prompt enabled");
    query('[aria-label="Send message"]').click();
    await until(() => query(".first-prompt-notice button"), "unsent first-prompt notice at the minimum height");
    await until(() => !host.querySelector(".toast"), "short notices settle");
    await settle();
    transcriptKept("Unsent first prompt");
    const unsent = query(".first-prompt-notice");
    const unsentActions = unsent.querySelector(".first-prompt-actions");
    assert(visibleHeight(unsent.firstElementChild, unsentActions) >= 30, `Only ${visibleHeight(unsent.firstElementChild, unsentActions)}px of the unsent prompt explanation shows above its actions`);
    for (const button of unsent.querySelectorAll("button")) assertReachableInPane(button, "conversation", button.textContent.trim());
  } finally {
    root.render(null);
    await settle();
  }
  return true;
}

// A separator drag belongs to the layout it started on. Switching worktree or
// opening a pane while the pointer is down cancels it without saving. Focus
// on a separator or pane tab that a responsive change removes moves to the
// shown pane, and the layout menu's F6 hint is a description, not menu content.
// Four pane tabs overflow a phone-width strip. Keyboard selection reveals the
// chosen tab by scrolling the strip only, never the workspace around it.
async function compactPaneTabVisibilityRegression() {
  root.render(null);
  await settle();
  const pane = (view) => ({ type: "pane", view });
  const four = { version: 1, focused: "conversation", root: { type: "split", axis: "row", ratio: 0.5, first: pane("conversation"),
    second: { type: "split", axis: "row", ratio: 0.5, first: pane("changes"), second: { type: "split", axis: "row", ratio: 0.5, first: pane("terminal"), second: pane("context") } } } };
  const views = Object.fromEntries(["conversation", "changes", "terminal", "context"].map((view) => [view, <div>{view}</div>]));
  function Harness({ width }) {
    const [layout, setLayout] = React.useState(four);
    return <div className="fixture-workspace" style={{ width, height: 480, overflow: "hidden" }}><div style={{ width, height: 480, display: "grid" }}><PaneLayout layout={layout} onChange={setLayout} compactPreferred views={views} /></div></div>;
  }
  for (const width of [320, 360]) {
    root.render(<Harness width={width} />);
    await until(() => host.querySelectorAll('.pane-switcher [role="tab"]').length === 4, `four pane tabs at ${width}px`);
    const workspace = host.querySelector(".fixture-workspace");
    const list = host.querySelector('.pane-switcher [role="tablist"]');
    assert(list.scrollWidth > list.clientWidth, `The pane tabs fit at ${width}px, so nothing is clipped`);
    const expectShown = async (view, label) => {
      const tab = host.querySelector(`#pane-tab-${view}`);
      await until(() => document.activeElement === tab && tab.getAttribute("aria-selected") === "true", `${label} selects ${view} at ${width}px`);
      await settle();
      const strip = list.getBoundingClientRect();
      const shown = tab.getBoundingClientRect();
      assert(shown.left >= strip.left - 1 && shown.right <= strip.right + 1, `${label} left the ${view} tab clipped at ${width}px: ${shown.left}-${shown.right} in ${strip.left}-${strip.right}`);
      assert(workspace.scrollLeft === 0 && workspace.scrollTop === 0 && window.scrollX === 0, `${label} scrolled the workspace at ${width}px`);
    };
    host.querySelector("#pane-tab-conversation").focus();
    pressKey(document.activeElement, "End");
    await expectShown("context", "End");
    pressKey(document.activeElement, "Home");
    await expectShown("conversation", "Home");
    pressKey(document.activeElement, "ArrowLeft");
    await expectShown("context", "ArrowLeft wrapping");
    pressKey(document.activeElement, "ArrowRight");
    await expectShown("conversation", "ArrowRight wrapping");
    for (const view of ["changes", "terminal", "context"]) {
      pressKey(document.activeElement, "ArrowRight");
      await expectShown(view, "ArrowRight");
    }
    list.scrollLeft = 0;
    pressKey(document.activeElement, "ArrowLeft");
    await expectShown("terminal", "ArrowLeft from a scrolled strip");
    list.scrollLeft = list.scrollWidth;
    pressKey(document.activeElement, "Home");
    await expectShown("conversation", "Home from a scrolled strip");
  }
  root.render(null);
  await settle();
}

// Worktree ids are lossy slugs of their paths, so two worktrees can share
// one. Each keeps its own pane layout, saved under its path.
async function paneLayoutOwnerRegression() {
  root.render(null);
  await settle();
  const shared = projects.map((project) => ({ ...project, worktrees: [{ ...project.worktrees[0], id: "shared" }] }));
  const sharedChats = Object.fromEntries(Object.entries(chats).map(([id, chat]) => [id, { ...chat, worktreeId: "shared" }]));
  keys.forEach((key, index) => localStorage.setItem(key, ["A", "shared", "chat-A"][index]));
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: shared, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [sharedChats[url.searchParams.get("projectId")] ?? sharedChats.A] });
    const match = url.pathname.match(/^\/api\/conversations\/chat-([AB])$/);
    if (match) return response(sharedChats[match[1]]);
    if (url.pathname === "/api/git/status") return response({ branch: "main", files: [], stagedCount: 0 });
    if (url.pathname === "/api/context") return response({ instructionFiles: [], skills: [], pullRequest: null });
    return response({});
  };
  const split = { version: 1, focused: "conversation", root: { type: "split", axis: "row", ratio: 0.5, first: { type: "pane", view: "conversation" }, second: { type: "pane", view: "changes" } } };
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ version: 1, worktrees: { "/fixture/A": { savedAt: 1, layout: split } } }));
  const saved = () => JSON.parse(localStorage.getItem(LAYOUT_KEY)).worktrees;
  const choose = async (name) => {
    host.querySelector(`[aria-label="Expand Review ${name}"]`)?.click();
    await until(() => [...host.querySelectorAll(".worktree-row")].some((row) => row.querySelector("strong")?.textContent === name), `worktree ${name} row`);
    [...host.querySelectorAll(".worktree-row")].find((row) => row.querySelector("strong")?.textContent === name).click();
    await until(() => host.querySelector(`textarea[placeholder*="in ${name}"]`), `worktree ${name} selected`);
    await settle();
  };
  try {
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelector('textarea[placeholder*="in A"]') && host.querySelector("#pane-changes"), "worktree A restores its split");
    await choose("B");
    assert(!host.querySelector("#pane-changes") && !host.querySelector(".pane-header"), "Worktree B, which shares A's id, showed A's layout");
    host.querySelector('[aria-label="Project context"]').click();
    await until(() => host.querySelector("#pane-context") && saved()["/fixture/B"], "worktree B saves its own layout");
    assert(JSON.stringify(saved()["/fixture/A"].layout) === JSON.stringify(split), "Saving B's layout overwrote A's");
    assert(!saved().shared, "A layout was saved under the shared worktree id");
    await choose("A");
    await until(() => host.querySelector("#pane-changes") && !host.querySelector("#pane-context"), "worktree A keeps its own split after B changed");
    root.render(null);
    await settle();
    localStorage.setItem(keys[0], "B");
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelector('textarea[placeholder*="in B"]') && host.querySelector("#pane-context"), "worktree B restores its own layout after a reload");
    assert(!host.querySelector("#pane-changes"), "A reload gave worktree B the layout of A");
  } finally {
    root.render(null);
    await settle();
  }
}

async function paneLayoutReplacementRegression() {
  if (!window.__fixtureSetViewport) return false;
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats[url.searchParams.get("projectId")] ?? chats.A] });
    const match = url.pathname.match(/^\/api\/conversations\/chat-([AB])$/);
    if (match) return response(chats[match[1]]);
    if (url.pathname === "/api/git/status") return response({ branch: "main", files: [], stagedCount: 0 });
    if (url.pathname === "/api/context") return response({ instructionFiles: [], skills: [], pullRequest: null });
    return response({});
  };
  const split = (ratio) => ({ version: 1, focused: "conversation", root: { type: "split", axis: "row", ratio, first: { type: "pane", view: "conversation" }, second: { type: "pane", view: "changes" } } });
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ version: 1, worktrees: { "/fixture/A": { savedAt: 2, layout: split(0.5) }, "/fixture/B": { savedAt: 1, layout: split(0.6) } } }));
  const savedLayout = (id) => JSON.parse(localStorage.getItem(LAYOUT_KEY)).worktrees[`/fixture/${id}`].layout;
  const setWidth = async (width) => {
    await window.__fixtureSetViewport(width);
    await until(() => window.innerWidth === width, `real ${width}px layout`);
    window.dispatchEvent(new Event("resize"));
    await settle();
  };
  const separator = () => host.querySelector('.pane-separator[role="separator"]');
  const pointer = (target, type, x) => target.dispatchEvent(new PointerEvent(type, { pointerId: 9, button: 0, clientX: x, clientY: target.getBoundingClientRect().top + 100, bubbles: true, cancelable: true }));
  const layoutWrites = [];
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function recordLayoutWrite(key, value) {
    if (key === LAYOUT_KEY) layoutWrites.push(value);
    return setItem.call(this, key, value);
  };
  try {
    await setWidth(1280);
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelector('textarea[placeholder*="in A"]') && host.querySelector("#pane-changes .changes-pane"), "worktree A split");
    const savedA = JSON.stringify(savedLayout("A"));
    const savedB = JSON.stringify(savedLayout("B"));

    // Drag in A, switch to B mid-drag, release: B keeps its own split.
    const dragged = separator();
    const startX = dragged.getBoundingClientRect().left + 3;
    const widthA = paneRect("conversation").width;
    pointer(dragged, "pointerdown", startX);
    pointer(dragged, "pointermove", startX + 80);
    await until(() => paneRect("conversation").width > widthA + 40, "the drag widens A's conversation");
    host.querySelector('[aria-label="Expand Review B"]')?.click();
    await until(() => [...host.querySelectorAll(".worktree-row")].some((row) => row.textContent.includes("B")), "worktree B row");
    [...host.querySelectorAll(".worktree-row")].find((row) => row.querySelector("strong")?.textContent === "B").click();
    await until(() => host.querySelector('textarea[placeholder*="in B"]') && host.querySelector("#pane-changes .changes-pane"), "worktree B split");
    await settle();
    const widthB = paneRect("conversation").width;
    pointer(dragged.isConnected ? dragged : separator(), "pointermove", startX + 160);
    await settle();
    assert(Math.abs(paneRect("conversation").width - widthB) <= 1, "A drag started in worktree A resized worktree B");
    pointer(dragged.isConnected ? dragged : separator(), "pointerup", startX + 160);
    await settle();
    assert(layoutWrites.length === 0, `Releasing a drag from another worktree saved ${layoutWrites.length} layouts`);
    assert(Math.abs(paneRect("conversation").width - widthB) <= 1, "Releasing a drag from another worktree resized worktree B");
    assert(JSON.stringify(savedLayout("A")) === savedA && JSON.stringify(savedLayout("B")) === savedB, "A cancelled drag changed a saved layout");

    // Drag in B, open a pane mid-drag, release: only the open is saved.
    const before = separator();
    const beforeX = before.getBoundingClientRect().left + 3;
    pointer(before, "pointerdown", beforeX);
    pointer(before, "pointermove", beforeX - 80);
    await until(() => paneRect("conversation").width < widthB - 40, "the drag narrows B's conversation");
    host.querySelector('[aria-label="Project context"]').click();
    await until(() => host.querySelector("#pane-context") && layoutWrites.length === 1, "context opened and saved during the drag");
    await settle();
    const opened = layoutWrites[0];
    const rects = ["conversation", "context", "changes"].map((view) => JSON.stringify(paneRect(view).toJSON()));
    pointer(before.isConnected ? before : separator(), "pointerup", beforeX - 160);
    await settle();
    assert(layoutWrites.length === 1 && JSON.stringify(savedLayout("B")) === JSON.stringify(JSON.parse(opened).worktrees["/fixture/B"].layout),
      `Releasing a drag after a pane opened changed the new layout: ${layoutWrites.slice(1).join(" | ")}`);
    assert(["conversation", "context", "changes"].every((view, index) => JSON.stringify(paneRect(view).toJSON()) === rects[index]), "Releasing a drag after a pane opened resized the new layout");

    // The F6 hint describes the layout menu instead of sitting in it.
    const layoutMenu = host.querySelector('[aria-label="Pane layout"]');
    assert(document.getElementById(layoutMenu.getAttribute("aria-describedby"))?.textContent === "F6 moves focus between panes", "The pane layout button does not describe F6");
    layoutMenu.click();
    let menu;
    await until(() => (menu = document.querySelector('[role="menu"]')) && menu.querySelector('[role="menuitem"]'), "pane layout menu");
    const exposed = [...menu.querySelectorAll("p, span")].filter((node) => node.textContent.includes("F6") && !node.closest('[aria-hidden="true"]'));
    assert(!exposed.length && menu.getAttribute("aria-describedby") === "pane-layout-hint", "The F6 hint is exposed as content inside the menu");
    pressKey(document.activeElement, "Escape");
    await until(() => !document.querySelector('[role="menu"]'), "pane layout menu closed");

    // Focus on chrome removed by a responsive change moves to the shown pane.
    const focusedView = () => host.querySelector(".pane.is-focused")?.dataset.paneView;
    separator().focus();
    const viewBefore = focusedView();
    await setWidth(640);
    await until(() => host.querySelector(".pane-switcher"), "panes one at a time");
    await until(() => document.activeElement === host.querySelector(`#pane-${viewBefore}`), `focus on a removed separator moves to the ${viewBefore} pane instead of ${document.activeElement?.outerHTML.slice(0, 80)}`);
    host.querySelector(`#pane-tab-${viewBefore}`).focus();
    await setWidth(1280);
    await until(() => !host.querySelector(".pane-switcher") && separator(), "split panes again");
    await until(() => document.activeElement === host.querySelector(`#pane-${viewBefore}`), `focus on a removed pane tab moves to the ${viewBefore} pane instead of ${document.activeElement?.outerHTML.slice(0, 80)}`);
    // Pane options buttons in split headers and in the pane tab strip as well.
    host.querySelector(`#pane-${viewBefore} .pane-header [aria-label$=" pane options"]`).focus();
    await setWidth(640);
    await until(() => host.querySelector(".pane-switcher"), "panes one at a time from an options button");
    await until(() => document.activeElement === host.querySelector(`#pane-${viewBefore}`), `focus on a removed split options button moves to the ${viewBefore} pane instead of ${document.activeElement?.outerHTML.slice(0, 80)}`);
    host.querySelector('.pane-switcher [aria-label$=" pane options"]').focus();
    await setWidth(1280);
    await until(() => !host.querySelector(".pane-switcher") && separator(), "split panes again from an options button");
    await until(() => document.activeElement === host.querySelector(`#pane-${viewBefore}`), `focus on a removed pane tab options button moves to the ${viewBefore} pane instead of ${document.activeElement?.outerHTML.slice(0, 80)}`);
    // An item in an open options menu is layout chrome too, though the menu
    // is portaled outside the layout.
    const focusMenuItem = async (trigger, label) => {
      trigger.click();
      const menuItem = () => document.querySelector('[role="menu"] [role="menuitem"]:not([data-disabled])');
      await until(menuItem, `${label} menu open`);
      const item = menuItem();
      item.focus();
      assert(document.activeElement === item, `The ${label} menu item did not take focus`);
    };
    await focusMenuItem(host.querySelector(`#pane-${viewBefore} .pane-header [aria-label$=" pane options"]`), "split options");
    await setWidth(640);
    await until(() => host.querySelector(".pane-switcher") && !document.querySelector('[role="menu"]'), "panes one at a time from an open menu");
    await until(() => document.activeElement === host.querySelector(`#pane-${viewBefore}`), `focus in a removed split options menu moves to the ${viewBefore} pane instead of ${document.activeElement?.outerHTML.slice(0, 80)}`);
    await focusMenuItem(host.querySelector('.pane-switcher [aria-label$=" pane options"]'), "pane tab options");
    await setWidth(1280);
    await until(() => !host.querySelector(".pane-switcher") && !document.querySelector('[role="menu"]'), "split panes again from an open menu");
    await until(() => document.activeElement === host.querySelector(`#pane-${viewBefore}`), `focus in a removed pane tab options menu moves to the ${viewBefore} pane instead of ${document.activeElement?.outerHTML.slice(0, 80)}`);
    for (let index = 0; index < 10; index += 1) await frame();
    assert(document.activeElement === host.querySelector(`#pane-${viewBefore}`), `A closing options menu took focus back from the ${viewBefore} pane: ${document.activeElement?.outerHTML.slice(0, 80)}`);
  } finally {
    Storage.prototype.setItem = setItem;
    root.render(null);
    await settle();
  }
  return true;
}

// Pane titles and chat tabs are both draggable and sit next to each other:
// only a chat tab dragged in the tab strip reorders chats.
async function paneDragChatTabRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const second = { ...chats.A, id: "chat-A2", title: "Conversation A2" };
  const patches = [];
  // The server keeps each tab's last saved position; listed chats follow it.
  const positions = { "chat-A": 0, "chat-A2": 1 };
  let failing = new Set();
  route = async (url, options = {}) => {
    if (options.method === "PATCH") {
      patches.push(url.pathname);
      const id = url.pathname.split("/").at(-1);
      if (failing.has(id)) return response({ error: `Tab order for ${id} offline` }, 500);
      positions[id] = JSON.parse(options.body).tabPosition;
      return response({});
    }
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A, second].sort((a, b) => positions[a.id] - positions[b.id]).map((item) => ({ ...item, tabPosition: positions[item.id] })) });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    if (url.pathname === "/api/conversations/chat-A2") return response(second);
    if (url.pathname === "/api/git/status") return response({ branch: "main", files: [], stagedCount: 0 });
    return response({});
  };
  const tab = (id) => host.querySelector(`#chat-tab-${id}`).closest(".chat-tab");
  const tabOrder = () => [...host.querySelectorAll('[role="tab"][id^="chat-tab-"]')].map((item) => item.dataset.tabId).join(",");
  const drag = (type, target, dataTransfer) => {
    const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
    target.dispatchEvent(event);
    return event;
  };
  try {
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => tabOrder() === "chat-A,chat-A2", "two chat tabs");
    host.querySelector('[aria-label="Changes"]').click();
    await until(() => host.querySelector("#pane-changes .pane-title"), "pane title beside the chat tabs");

    // A chat tab dragged onto another tab still reorders and saves the order.
    const tabTransfer = new DataTransfer();
    drag("dragstart", tab("chat-A2"), tabTransfer);
    assert(drag("dragover", tab("chat-A"), tabTransfer).defaultPrevented, "A chat tab did not accept a chat tab drag");
    drag("drop", tab("chat-A"), tabTransfer);
    drag("dragend", tab("chat-A2"), tabTransfer);
    await until(() => tabOrder() === "chat-A2,chat-A" && patches.length === 2, "chat tab drag reorders chats");

    // A tab drag that never ends here (its source left mid-drag) is followed
    // by a pane title dropped on a tab: chats keep their order and no request.
    drag("dragstart", tab("chat-A"), new DataTransfer());
    const paneTransfer = new DataTransfer();
    const title = host.querySelector("#pane-changes .pane-title");
    drag("dragstart", title, paneTransfer);
    assert(!drag("dragover", tab("chat-A2"), paneTransfer).defaultPrevented, "A chat tab accepted a pane title drag");
    drag("drop", tab("chat-A2"), paneTransfer);
    drag("dragend", title, paneTransfer);
    await settle();
    assert(tabOrder() === "chat-A2,chat-A" && patches.length === 2, `A pane title drop reordered chats: ${tabOrder()} after ${JSON.stringify(patches)}`);
    assert(paneOrder() === "conversation,changes", `A pane title dropped on a chat tab moved panes: ${paneOrder()}`);

    // A rejected reorder is reported and the tabs return to the saved order.
    const reorder = async (source, target) => {
      const transfer = new DataTransfer();
      drag("dragstart", tab(source), transfer);
      drag("dragover", tab(target), transfer);
      drag("drop", tab(target), transfer);
      drag("dragend", tab(source), transfer);
    };
    const rejected = [];
    const recordRejection = (event) => rejected.push(String(event.reason?.message ?? event.reason));
    window.addEventListener("unhandledrejection", recordRejection);
    try {
      failing = new Set(["chat-A", "chat-A2"]);
      await reorder("chat-A", "chat-A2");
      await until(() => host.querySelector(".error-toast")?.textContent.includes("offline"), "rejected chat reorder reported");
      await until(() => tabOrder() === "chat-A2,chat-A", `rejected chat reorder returns to the saved order instead of ${tabOrder()}`);
      host.querySelector('[aria-label="Dismiss error"]').click();
      // One position saved and one refused: the tabs show what the server kept.
      failing = new Set(["chat-A2"]);
      await reorder("chat-A", "chat-A2");
      await until(() => host.querySelector(".error-toast")?.textContent.includes("chat-A2 offline"), "partly saved chat reorder reported");
      await until(() => positions["chat-A"] === 0 && tabOrder() === "chat-A,chat-A2", `partly saved chat reorder shows the server order instead of ${tabOrder()}`);
      await settle();
      assert(!rejected.length, `A chat reorder left an unhandled rejection: ${rejected.join("; ")}`);
    } finally {
      window.removeEventListener("unhandledrejection", recordRejection);
      failing = new Set();
    }
  } finally {
    root.render(null);
    await settle();
  }
  return true;
}

async function responsiveFocusRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  // Change the actual CSS viewport: mocking matchMedia alone can report desktop
  // while the real 390px layout hides the control under test.
  const setWidth = async (width) => {
    await window.__fixtureSetViewport(width);
    await until(() => window.innerWidth === width && window.matchMedia("(max-width: 760px)").matches === (width <= 760), `real ${width}px layout`);
    // CDP can acknowledge a hidden tab's new metrics before delivering its
    // resize event. Exercise the same event a visible window resize emits.
    window.dispatchEvent(new Event("resize"));
    await settle();
  };
  if (!window.__fixtureSetViewport) return false; // Manual preview still runs width-independent cases.
  await setWidth(1280);
  let createdChat = null;
  route = async (url, options = {}) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations" && options.method === "POST") {
      const body = JSON.parse(options.body);
      createdChat = { ...chats.A, id: "chat-narrow", title: body.title, projectId: body.projectId, worktreeId: body.worktreeId, worktreePath: body.worktreePath };
      return response(createdChat, 201);
    }
    if (url.pathname === "/api/conversations") {
      const owner = url.searchParams.get("projectId");
      return response({ conversations: [chats[owner], ...(createdChat?.projectId === owner ? [createdChat] : [])] });
    }
    if (url.pathname === "/api/conversations/chat-narrow") return response(createdChat);
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A")] });
    if (url.pathname.startsWith("/api/terminals/")) return response({ buffer: "Responsive focus fixture\r\n" });
    const match = url.pathname.match(/^\/api\/conversations\/chat-([AB])$/);
    if (match) return response(chats[match[1]]);
    return response({});
  };

  try {
    root.render(<TooltipProvider><App /></TooltipProvider>);
    await until(() => host.querySelector('textarea[aria-label="Message the agent"]'), "responsive fixture");
    host.querySelector('[aria-label="Close projects sidebar"]').click();
    await until(() => host.querySelector('[aria-label="Open projects sidebar"]'), "closed desktop sidebar");
    await setWidth(1200);
    assert(host.querySelector("#project-sidebar").getAttribute("aria-hidden") === "true", "A same-breakpoint desktop resize reopened the project sidebar");
    host.querySelector('[aria-label="Open projects sidebar"]').click();
    await until(() => host.querySelector("#project-sidebar").getAttribute("aria-hidden") === "false", "reopened desktop sidebar");
    await setWidth(1280);

    await responsiveSidebarBreakpointCycles(setWidth);

    const composer = host.querySelector('textarea[aria-label="Message the agent"]');
    composer.focus();
    await setWidth(640);
    await until(() => host.querySelector('[aria-label="Open projects sidebar"]'), "sidebar closed after narrow transition");
    assert(document.activeElement === composer, "Entering the narrow layout moved focus away from the composer");
    assert(host.querySelector("#project-sidebar").getAttribute("aria-hidden") === "true", "Entering the narrow layout left the project drawer exposed");

    const opener = host.querySelector('[aria-label="Open projects sidebar"]');
    opener.click();
    await until(() => host.querySelector("#main-workspace")?.hasAttribute("inert"), "modal project drawer");
    const sidebar = host.querySelector("#project-sidebar");
    const workspace = host.querySelector("#main-workspace");
    const scrim = host.querySelector(".mobile-scrim");
    try {
      await until(() => sidebar.contains(document.activeElement) && document.activeElement.matches('button:not(:disabled)'), "actionable project drawer focus");
    } catch (error) {
      const first = sidebar.querySelector('button:not(:disabled)');
      throw new Error(`${error.message}; active=${document.activeElement?.outerHTML?.slice(0, 300)}; sidebar=${sidebar.getAttribute("aria-hidden")}/${sidebar.getAttribute("role")}; first=${first?.outerHTML?.slice(0, 200)}; firstRect=${JSON.stringify(first?.getBoundingClientRect().toJSON())}; firstVisibility=${first && getComputedStyle(first).visibility}; inert=${workspace.hasAttribute("inert")}`);
    }
    assert(sidebar.getAttribute("role") === "dialog" && sidebar.getAttribute("aria-modal") === "true", "Project drawer is not exposed as a modal dialog");
    assert(workspace.getAttribute("aria-hidden") === "true", "Project drawer did not hide the workspace from assistive technology");
    assert(scrim?.tagName === "DIV" && scrim.tabIndex === -1, "Project drawer backdrop entered the tab order");
    const closeButton = document.activeElement;
    await setWidth(620);
    assert(sidebar.getAttribute("aria-hidden") === "false", "A same-breakpoint narrow resize closed the project drawer");
    assert(workspace.hasAttribute("inert") && sidebar.contains(document.activeElement), "A same-breakpoint narrow resize lost drawer focus containment");
    composer.focus();
    assert(document.activeElement === closeButton, "Inert workspace accepted focus while the project drawer was open");
    const focusable = visibleFocusable(sidebar);
    focusable[0].focus();
    focusable[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    assert(document.activeElement === focusable.at(-1), "Shift+Tab escaped the project drawer");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await until(() => !host.querySelector("#main-workspace")?.hasAttribute("inert"), "project drawer close");
    await until(() => document.activeElement === host.querySelector('[aria-label="Open projects sidebar"]'), "project drawer opener focus restoration");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
    await until(() => document.querySelector('[role="combobox"]'), "narrow command palette");
    const paletteInput = document.querySelector('[role="combobox"]');
    setControlValue(paletteInput, "Review B");
    await until(() => [...document.querySelectorAll('[role="option"]')].some((option) => option.textContent.includes("Review B")), "narrow project search result");
    [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent.includes("Review B")).click();
    await until(() => host.querySelector('textarea[placeholder*="in B"]'), "project selected while drawer closed");
    await until(() => !document.querySelector('[role="dialog"][data-open]:not(#project-sidebar)'), "project search dialog dismissed");
    const composerB = host.querySelector('textarea[aria-label="Message the agent"]');
    composerB.focus();
    await setWidth(1280);
    await until(() => host.querySelector("#project-sidebar").getAttribute("aria-hidden") === "false", "wide sidebar after closed selection");
    await setWidth(390);
    await until(() => host.querySelector("#project-sidebar").getAttribute("aria-hidden") === "true", "narrow sidebar after closed selection");
    assert(document.activeElement === composerB, "Selecting a project while the drawer was closed left stale focus restoration state");

    const terminalTrigger = host.querySelector('[aria-label="Terminal"]');
    terminalTrigger.click();
    await until(() => host.querySelector('#pane-tab-terminal[aria-selected="true"]'), "narrow terminal pane tab");
    await until(() => document.activeElement === host.querySelector("#pane-terminal"), "narrow terminal pane focus");
    const conversationPane = host.querySelector("#pane-conversation");
    const terminalPane = host.querySelector("#pane-terminal");
    assert(conversationPane.inert && getComputedStyle(conversationPane).visibility === "hidden", `The narrow layout showed two panes at once: ${describePaneState()}`);
    const terminalRect = terminalPane.getBoundingClientRect();
    assert(terminalRect.left >= -1 && terminalRect.right <= window.innerWidth + 1 && terminalRect.width >= window.innerWidth - 2,
      `The narrow terminal pane does not use the viewport width: ${JSON.stringify(terminalRect.toJSON())}`);
    const terminalInput = host.querySelector(".terminal-host .xterm-helper-textarea");
    assert(terminalInput, "Terminal input did not mount");
    await until(() => host.querySelector('.terminal-tabs [role="tab"][aria-selected="true"]'), "active terminal for Escape input");
    const keyEvents = [];
    const observeKey = (event) => keyEvents.push({ key: event.key, target: event.target, trusted: event.isTrusted });
    document.addEventListener("keydown", observeKey, true);
    terminalInput.focus();
    await window.__fixtureSendKey("Escape");
    await settle();
    document.removeEventListener("keydown", observeKey, true);
    assert(host.querySelector("#pane-terminal") && !terminalPane.inert, "Escape from terminal input changed the pane layout");
    assert(keyEvents.some((event) => event.key === "Escape" && event.target === terminalInput && event.trusted), "Trusted Escape did not reach the terminal input");
    const xterm = host.querySelector(".terminal-host .xterm");
    const paneTab = host.querySelector("#pane-tab-terminal");
    paneTab.focus();
    paneTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    await until(() => host.querySelector('#pane-tab-conversation[aria-selected="true"]') && document.activeElement?.id === "pane-tab-conversation", "arrow key selects the conversation pane");
    assert(!conversationPane.inert && terminalPane.inert && getComputedStyle(terminalPane).visibility === "hidden", "Pane tabs did not switch the visible pane");
    assert(host.querySelector(".terminal-host .xterm") === xterm && xterm.isConnected, "Switching narrow panes remounted the terminal");
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    await until(() => host.querySelector('#pane-tab-terminal[aria-selected="true"]') && document.activeElement?.id === "pane-tab-terminal", "End selects the last pane");
    host.querySelector('[role="tab"][id^="chat-tab-"][aria-selected="true"]').click();
    await until(() => host.querySelector('#pane-tab-conversation[aria-selected="true"]') && !conversationPane.inert, "choosing a chat shows its conversation pane");
    host.querySelector("#pane-tab-terminal").click();
    await until(() => !terminalPane.inert && conversationPane.inert, "pane tab click shows the terminal again");
    // A chat created from the + tab takes the front from the terminal.
    host.querySelector('[aria-label="New chat tab"]').click();
    await until(() => document.querySelector('[role="dialog"] input#chat-title'), "narrow new chat dialog");
    setControlValue(document.querySelector("input#chat-title"), "Narrow chat");
    [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Create chat").click();
    await until(() => host.querySelector('#chat-tab-chat-narrow[aria-selected="true"]') && host.querySelector('#pane-tab-conversation[aria-selected="true"]')
      && !conversationPane.inert && terminalPane.inert, "a new chat shows its conversation pane");
    assert(host.querySelector(".terminal-host .xterm") === xterm && xterm.isConnected, "Creating a chat remounted the terminal");
    host.querySelector("#pane-tab-terminal").click();
    await until(() => !terminalPane.inert && conversationPane.inert, "pane tab click shows the terminal after the new chat");

    terminalTrigger.focus();
    terminalTrigger.click();
    await until(() => !host.querySelector("#pane-terminal") && !host.querySelector('[role="tablist"][aria-label="Panes"]'), "toolbar closes the narrow terminal pane");
    assert(document.activeElement === terminalTrigger, "Closing from the toolbar moved focus away from its toggle");
    assert(!host.querySelector("#pane-conversation").inert, "The remaining conversation pane stayed inert");
  } finally {
    root.render(null);
    await settle();
  }
  return true;
}

function visibleFocus(element) {
  if (!element || document.activeElement !== element || !element.isConnected || element.closest("[inert]")) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility === "visible"
    && rect.left < window.innerWidth && rect.right > 0;
}

async function recoveryActionsRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const interrupted = { id: "run-interrupted", conversationId: "chat-A", status: "interrupted", recoveryClass: "exited", provider: "codex", providerSessionId: "session-A" };
  const recoveryChat = { ...chats.A, providerSessionId: "session-A", runs: [interrupted] };
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [recoveryChat] });
    if (url.pathname === "/api/conversations/chat-A") return response(recoveryChat);
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelectorAll(".recovery-actions button").length === 3, "owner recovery actions");
  if (!window.__fixtureSetViewport) return false;
  for (const width of [390, 640, 760]) {
    await window.__fixtureSetViewport(width);
    await until(() => window.innerWidth === width, `recovery viewport ${width}`);
    await settle(); // NOSONAR S9382: each viewport width settles before the next
    const noticeRect = host.querySelector(".recovery-notice").getBoundingClientRect();
    const buttons = [...host.querySelectorAll(".recovery-actions button")];
    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      assert(rect.left >= noticeRect.left - 1 && rect.right <= noticeRect.right + 1, `${button.textContent.trim()} overflowed recovery notice at ${width}px`);
      assert(rect.right <= window.innerWidth + 1, `${button.textContent.trim()} was outside ${width}px viewport`);
      button.focus();
      assert(document.activeElement === button, `${button.textContent.trim()} was not keyboard reachable at ${width}px`);
    }
  }
  root.render(null);
  await settle();
  interrupted.recoveryClass = "outcome-unreadable-queued";
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector(".recovery-notice")?.textContent.includes("final result is temporarily unreadable"), "unreadable outcome recovery guidance");
  return true;
}

async function acceptedFirstPromptOwnerSwitchRegression(sameWorktree = false) {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "" : "A"));
  const created = { ...chats.A, id: "chat-new", title: "First prompt", provider: "codex" };
  const sibling = { ...chats.A, id: "chat-C", title: "Conversation C" };
  const heldRun = deferred();
  let aLists = 0;
  const runs = [];
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }, { id: "claude", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations" && options.method === "POST") return response(created, 201);
    if (url.pathname === "/api/conversations") {
      if (url.searchParams.get("projectId") === "B") return response({ conversations: [chats.B] });
      aLists++;
      if (aLists === 1) return response({ conversations: [] });
      if (aLists === 2) return response({ error: "List unavailable" }, 503);
      return response({ conversations: sameWorktree ? [created, sibling] : [created] });
    }
    if (url.pathname === "/api/conversations/chat-new") return response({ ...created, provider: "claude", model: "fresh-model" });
    if (url.pathname === "/api/conversations/chat-C") return response(sibling);
    if (url.pathname === "/api/conversations/chat-B") return response(chats.B);
    if (url.pathname === "/api/conversations/chat-new/runs") { runs.push(JSON.parse(options.body)); return heldRun.promise; }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('textarea[aria-label="Message the agent"]:not(:disabled)'), "empty first-prompt composer");
  setControlValue(host.querySelector('textarea[aria-label="Message the agent"]'), "Prompt accepted once");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => host.querySelector('.history-loader')?.textContent === "Retry chat list" && host.querySelector('.first-prompt-notice'), "failed creation list keeps first prompt");
  host.querySelector('.history-loader').click();
  await until(() => host.querySelector('#chat-tab-chat-new[aria-selected="true"]') && !host.querySelector('[aria-label="Send message"]')?.disabled, "first prompt retry ready");
  host.querySelector('[aria-label="Send message"]').click();
  await until(() => runs.length === 1, "held retry POST");
  assert(runs[0].prompt === "Prompt accepted once" && runs[0].provider === "claude" && runs[0].model === "fresh-model", "Retry did not use fresh detail payload");
  if (sameWorktree) host.querySelector('#chat-tab-chat-C').click();
  else [...host.querySelectorAll("button")].find((button) => button.textContent.includes("Review B")).click();
  await until(() => host.querySelector(sameWorktree ? '#chat-tab-chat-C[aria-selected="true"]' : '#chat-tab-chat-B[aria-selected="true"]'), "other selection while POST held");
  const newerDraft = sameWorktree ? "Newer sibling C draft" : "Newer owner B draft";
  if (sameWorktree) setControlValue(host.querySelector('textarea[aria-label="Message the agent"]'), "");
  setControlValue(host.querySelector('textarea[aria-label="Message the agent"]'), newerDraft);
  heldRun.resolve(response({ id: "run-new", conversationId: "chat-new", status: "queued" }, 202));
  // The held POST settling and React's state commit are separate turns.
  await until(() => !host.querySelector('.first-prompt-notice')
    && host.querySelector('textarea[aria-label="Message the agent"]')?.value === newerDraft,
  "accepted first prompt visibly settled after owner switch");
  assert(runs.length === 1, "Accepted retry duplicated while settling");
  assert(!host.querySelector(".first-prompt-notice"), "Accepted retry left a false unsent first-prompt marker after owner switch");
  assert(host.querySelector('textarea[aria-label="Message the agent"]')?.value === newerDraft, "Accepted retry erased a newer draft");
  if (sameWorktree) host.querySelector('#chat-tab-chat-new').click();
  else [...host.querySelectorAll("button")].find((button) => button.textContent.includes("Review A")).click();
  await until(() => host.querySelector('#chat-tab-chat-new[aria-selected="true"]'), "return to accepted first-prompt chat");
  assert(!host.querySelector('.first-prompt-notice') && runs.length === 1, "Returning to accepted chat offered duplicate first-prompt retry");
}

async function dialogCreateSuccessorRegression(failSuccessor = false, failPrivate = false) {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "" : "A"));
  const created = { ...chats.A, id: "chat-dialog", title: "Dialog chat" };
  const heldList = deferred();
  let lists = 0;
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations" && options.method === "POST") return response(created, 201);
    if (url.pathname === "/api/conversations") {
      lists++;
      if (lists === 1) return response({ conversations: [] });
      if (lists === 2) return failPrivate ? response({ error: "List unavailable" }, 503) : heldList.promise;
      if (lists === 3 && failSuccessor) return response({ error: "List unavailable" }, 503);
      return response({ conversations: [created] });
    }
    if (url.pathname === "/api/conversations/chat-dialog") return response(created);
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('textarea[aria-label="Message the agent"]:not(:disabled)'), "dialog fixture ready");
  host.querySelector('[aria-label="New chat tab"]').click();
  await until(() => document.querySelector('[role="dialog"] input#chat-title'), "new chat dialog");
  setControlValue(document.querySelector('input#chat-title'), "Dialog chat");
  [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Create chat").click();
  if (failPrivate) {
    await until(() => host.querySelector('.history-loader')?.textContent === "Retry chat list", "failed private dialog list");
    assert(!host.textContent.includes("Chat created, but its details could not be loaded"), "Dialog duplicated a failed-list error as a detail failure");
    host.querySelector('.history-loader').click();
    await until(() => host.querySelector('#chat-tab-chat-dialog[aria-selected="true"]') && host.querySelector('textarea[aria-label="Message the agent"]:not(:disabled)'), "private dialog list retry");
    return;
  }
  await until(() => lists === 2, "held dialog post-create list");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.created", conversationId: created.id }) }));
  await until(() => lists === 3, "socket successor list");
  if (failSuccessor) await until(() => host.querySelector('.history-loader')?.textContent === "Retry chat list", "failed dialog successor");
  else await until(() => host.querySelector('#chat-tab-chat-dialog[aria-selected="true"]') && host.querySelector('textarea[aria-label="Message the agent"]:not(:disabled)'), "successful dialog successor");
  heldList.resolve(response({ conversations: [created] }));
  await settle();
  assert(!host.textContent.includes("Chat created, but its details could not be loaded"), "Dialog creation reported false detail failure after successor load");
  if (failSuccessor) {
    host.querySelector('.history-loader').click();
    await until(() => host.querySelector('#chat-tab-chat-dialog[aria-selected="true"]') && host.querySelector('textarea[aria-label="Message the agent"]:not(:disabled)'), "dialog successor retry");
  }
}

async function archivePagingLoadingRegression() {
  for (const direction of ["earlier", "later"]) {
    for (const failed of [false, true]) {
      root.render(null); await settle(); // NOSONAR S9382: each page response settles before the next render
      keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
      const sibling = { ...chats.B, projectId: "A", worktreeId: "A", worktreePath: projects[0].worktrees[0].path };
      const page = { hasMore: true, olderCount: 50, hasLater: true, newerCount: 50, total: 101, beforeId: "page-50" };
      const messages = [{ id: "page-50", role: "assistant", kind: "text", body: "Reading page", createdAt: new Date(0).toISOString() }];
      const held = deferred();
      let pageStarted = false;
      let archived = false;
      route = async (url, options) => {
        if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
        if (url.pathname === "/api/conversations") return response({ conversations: archived ? [sibling] : [chats.A, sibling] });
        if (url.pathname === "/api/conversations/chat-A" && options?.method === "PATCH") { archived = true; return response({ ...chats.A, archived: true }); }
        if (url.pathname === "/api/conversations/chat-A/messages") { pageStarted = true; return held.promise; }
        if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, messages, messagePage: page });
        if (url.pathname === "/api/conversations/chat-B") return response({ ...sibling, messages, messagePage: page });
        return response({});
      };
      root.render(<TooltipProvider><App /></TooltipProvider>);
      await until(() => host.querySelector('.chat-tab.is-active')?.textContent.includes("Conversation A") && host.querySelector('.history-later'), "archive page owner ready");
      host.querySelector(direction === "earlier" ? '.history-loader' : '.history-later').click();
      await until(() => pageStarted, "old page request pending");
      host.querySelector('.chat-tab.is-active .tab-close').click();
      await until(() => host.querySelector('.chat-tab.is-active')?.textContent.includes("Conversation B") && host.querySelector('.history-later'), "sibling selected after archive");
      assert(archived && !host.querySelector('#chat-tab-chat-A'), "Archived A reappeared after the post-PATCH list refresh");
      assert(!host.querySelector('.history-loader').disabled && !host.querySelector('.history-later').disabled,
        `Archiving during ${direction} left sibling paging disabled`);
      held.resolve(failed ? response({ error: "Old page failed" }, 503) : response({ messages, messagePage: page }));
      await settle(); // NOSONAR S9382: each page response settles before the next render
      assert(!host.querySelector('.history-loader').disabled && !host.querySelector('.history-later').disabled,
        `Stale ${direction} ${failed ? "failure" : "success"} disabled sibling paging`);
    }
  }
}

async function inlineArchiveFocusRegression(last = false, newerFocus = false, nonselected = false) {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const sibling = { ...chats.A, id: "chat-C", title: "Conversation C" };
  const patch = deferred();
  let patched = false;
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === `/api/conversations/${nonselected ? "chat-C" : "chat-A"}` && options.method === "PATCH") { patched = true; return patch.promise; }
    if (url.pathname === "/api/conversations") return response({ conversations: patched ? (last ? [] : nonselected ? [chats.A] : [sibling]) : last ? [chats.A] : [chats.A, sibling] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    if (url.pathname === "/api/conversations/chat-C") return response(sibling);
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('#chat-tab-chat-A[aria-selected="true"]') && host.querySelector('[aria-label="Archive Conversation A"]'), "archive fixture ready");
  const archived = nonselected ? sibling : chats.A;
  const archive = host.querySelector(`[aria-label="Archive ${archived.title}"]`);
  archive.focus();
  archive.click();
  await until(() => patched, "held archive PATCH");
  const newer = host.querySelector('[aria-label="Settings"]');
  if (newerFocus) newer.focus();
  patch.resolve(response({ ...archived, archived: true }));
  await until(() => !host.querySelector(`#chat-tab-${archived.id}`), "archived tab removed");
  await settle();
  const expected = newerFocus ? newer : last ? host.querySelector('[aria-label="New chat tab"]') : host.querySelector(nonselected ? '#chat-tab-chat-A' : '#chat-tab-chat-C');
  assert(document.activeElement === expected, `Inline archive focus was not restored to ${newerFocus ? "newer choice" : last ? "new chat" : "selected sibling"}; active=${document.activeElement?.outerHTML?.slice(0, 240)}, expected=${expected?.outerHTML?.slice(0, 240)}`);
  if (!newerFocus && !last) {
    assert(expected?.tabIndex === 0 && expected.getAttribute('aria-selected') === 'true'
      && host.querySelector('#conversation-panel')?.getAttribute('aria-labelledby') === expected.id,
    "Archived sibling focus, roving tab and panel owner diverged");
  }
}


async function pendingRunOutcomeRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  let status = "running";
  let pendingSnapshot = false;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, runs: [{ id: "run-A", status, outcomePending: pendingSnapshot }] });
    return response({});
  };
  const socketsBefore = fixtureSockets.length;
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => fixtureSockets.length > socketsBefore && host.querySelector('[aria-label="Stop active agent run"]'), "running outcome fixture");
  assert(host.querySelector('.run-announcement[role="status"]')?.textContent.includes("Run running")
    && host.querySelector('.message.is-streaming[aria-busy="true"]:not([role="status"])'),
  "running activity must report its busy state while its status is announced");
  const statusRegion = host.querySelector('.run-announcement');
  const statusMutations = [];
  const statusObserver = new MutationObserver((records) => statusMutations.push(...records));
  statusObserver.observe(statusRegion, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
  try {
  const socket = fixtureSockets.at(-1);
  const announce = (runId, conversationId) => socket.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ type: "run.outcome_pending", runId, conversationId, reason: "storage-unavailable" }),
  }));
  announce("run-B", "chat-B");
  await settle();
  assert(statusMutations.length === 0, "another chat re-announced this run");
  assert(!host.querySelector(".recovery-notice") && !host.querySelector(".run-state")?.textContent.includes("outcome pending"), "another chat's pending result appeared here");
  announce("run-A", "chat-A");
  await until(() => host.querySelector(".recovery-notice")?.textContent.includes("Run outcome waiting for storage"), "pending result announced");
  assert(host.querySelector('.message.is-streaming[aria-busy="false"]'),
    "the displayed run stops claiming active streaming when only outcome storage is pending");
  assert(host.querySelector(".recovery-notice")?.tagName === "DIV"
    && !host.querySelector(".recovery-notice")?.hasAttribute("aria-live")
    && host.querySelector('.run-announcement[role="status"]')?.textContent.includes("Saving final run outcome"),
  "Changing run IDs must not re-announce the verbose recovery notice; the stable status announces the transition");
  assert(host.querySelector(".run-state")?.textContent.includes("outcome pending"), "run badge still claimed to be running");
  await settle();
  assert(statusMutations.length === 1, "outcome pending must produce one material announcement");
  assert(host.querySelector(".conversation-meta")?.textContent.includes("outcome pending"), "conversation summary still claimed to be running");
  assert(host.querySelector('[aria-label="Final run outcome pending"]')?.disabled, "stop remained actionable after the provider exited");
  assert(!host.querySelector(".thinking-copy")?.textContent.includes("Working in this worktree"), "streaming placeholder still claimed active work");
  status = "completed";
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", runId: "run-A", conversationId: "chat-A", payload: { type: "run.completed" } }) }));
  await until(() => !host.querySelector(".recovery-notice") && host.querySelector(".run-state")?.textContent.includes("completed"), "durable result clears pending notice");
  assert(!host.querySelector('.message.is-streaming[aria-busy="true"]'),
    "settled output must no longer expose an active busy message");
  await settle();
  assert(statusRegion.textContent === "Run completed", "completion announcement did not settle");
  assert(statusMutations.length === 2, `completion must produce one further announcement; mutations=${statusMutations.length}, details=${JSON.stringify(statusMutations.map((record) => ({ type: record.type, oldValue: record.oldValue, target: record.target?.textContent })))}`);
  } finally { statusObserver.disconnect(); }
  root.render(null); await settle();
  status = "running";
  pendingSnapshot = true;
  const nextSocketsBefore = fixtureSockets.length;
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => fixtureSockets.length > nextSocketsBefore
    && host.querySelector(".recovery-notice")?.textContent.includes("Run outcome waiting for storage"), "fresh client sees pending snapshot");
  status = "completed";
  pendingSnapshot = false;
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "runtime.connected", payload: { replay: { missed: true } } }) }));
  await until(() => !host.querySelector(".recovery-notice") && host.querySelector(".run-state")?.textContent.includes("completed"), "settled snapshot clears pending notice");
}

async function pendingRunWithQueuedSiblingRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  let olderStatus = "running";
  let olderPending = false;
  let siblingStatus = "queued";
  const stopped = [];
  route = async (url, options) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, runs: [
      { id: "run-queued-sibling", status: siblingStatus },
      { id: "run-older-exited", status: olderStatus, outcomePending: olderPending },
    ] });
    if (url.pathname === "/api/runs/run-queued-sibling/stop" && options.method === "POST") {
      stopped.push("run-queued-sibling");
      siblingStatus = "stopped";
      return response({ id: "run-queued-sibling", status: "stopped" });
    }
    if (url.pathname.startsWith("/api/runs/") && options.method === "POST") stopped.push(url.pathname);
    return response({});
  };
  const socketsBefore = fixtureSockets.length;
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => fixtureSockets.length > socketsBefore && host.querySelector('[aria-label="Stop active agent run"]'), "queued sibling fixture");
  const socket = fixtureSockets.at(-1);
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.outcome_pending", runId: "run-older-exited", conversationId: "chat-A", reason: "storage-unavailable" }) }));
  await until(() => host.querySelector(".recovery-notice")?.textContent.includes("run-older-exited"), "older pending run identified after live event");
  assert(host.querySelector(".run-state")?.textContent.includes("outcome pending"), "newer queued run hid the older pending status");
  assert(host.querySelector(".conversation-meta")?.textContent.includes("queued") && host.querySelector(".conversation-meta")?.textContent.includes("outcome pending"), "chat header did not show both run states");
  assert(host.querySelector(".send-hint")?.textContent.includes("Agent is queued"), "composer mislabeled the queued sibling as exited");
  assert(!host.querySelector('[aria-label="Stop active agent run"]')?.disabled, "older pending result disabled queued sibling cancellation");
  host.querySelector('[aria-label="Stop active agent run"]').click();
  await until(() => stopped.length, "queued sibling stop requested");
  assert(stopped.length === 1 && stopped[0] === "run-queued-sibling", "Stop targeted the exited run instead of the queued sibling");
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", runId: "run-queued-sibling", conversationId: "chat-A", payload: { type: "run.stopped" } }) }));
  await until(() => host.querySelector('[aria-label="Final run outcome pending"]')?.disabled, "queued sibling stopped while older result remains pending");
  assert(host.querySelector(".recovery-notice")?.textContent.includes("run-older-exited"), "sibling cancellation cleared the older result notice");
  olderStatus = "completed";
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", runId: "run-older-exited", conversationId: "chat-A", payload: { type: "run.completed" } }) }));
  await until(() => !host.querySelector(".recovery-notice") && host.querySelector(".run-state")?.textContent.includes("stopped"), "older durable result clears only its notice");

  root.render(null); await settle();
  olderStatus = "running";
  olderPending = true;
  siblingStatus = "queued";
  const nextSocketsBefore = fixtureSockets.length;
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => fixtureSockets.length > nextSocketsBefore
    && host.querySelector(".recovery-notice")?.textContent.includes("run-older-exited"), "fresh snapshot identifies older pending result");
  assert(host.querySelector(".run-state")?.textContent.includes("outcome pending") && host.querySelector('[aria-label="Stop active agent run"]'), "fresh snapshot did not retain pending and queued sibling states");
  olderStatus = "completed";
  olderPending = false;
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "runtime.connected", payload: { replay: { missed: true } } }) }));
  await until(() => !host.querySelector(".recovery-notice") && host.querySelector(".run-state")?.textContent.includes("queued"), "durable snapshot clears only the older pending result");
}

// A restore is sent only against the exact preview shown, with the paths
// chosen (a file/directory swap together) and only once open terminals are
// confirmed. A worktree that changed, or a terminal opened, after the
// preview gets a new preview instead of a restore, and an interrupted
// restore offers finish or keep. Each step that removes the focused control
// moves focus to a defined place.
async function worktreeCheckpointsRegression() {
  root.render(null); await settle();
  const project = projects[0];
  const worktree = project.worktrees[0];
  const checkpoint = { id: "lx1abc-0123abcd", commit: "c".repeat(40), label: "Before agent", reason: "manual", createdAt: "2026-10-31T00:00:00.000Z",
    head: "a".repeat(40), branch: "main", counts: { staged: 1, unstaged: 0, untracked: 2 } };
  let detail = { worktreePath: worktree.path, checkpoints: [checkpoint], restore: null, busy: null, limits: { perWorktree: 20 } };
  const entries = [
    { path: "a.txt", index: { action: "update", mode: "100644", oid: "b".repeat(40) }, file: { action: "update" } },
    { path: "cache", index: null, file: { action: "create" }, blocked: "An ignored file or directory is in the way" },
    { path: "dir", index: null, file: { action: "delete" }, group: "dir", groupSize: 2 },
    { path: "dir/inner.txt", index: null, file: { action: "create" }, group: "dir", groupSize: 2 },
  ];
  let previews = 0;
  const preview = (resume = false) => ({ checkpoint, planDigest: String(++previews).padStart(64, "0"), currentTree: "d".repeat(40), currentIndexTree: "e".repeat(40),
    head: { current: checkpoint.head, checkpoint: checkpoint.head, moved: false }, entries: resume ? entries.slice(0, 1) : entries, blockers: [],
    terminals: [{ id: "t1", name: "zsh" }], resume });
  const posts = [];
  const diffs = [];
  let restoreAnswer = null;
  // A runtime without checkpoint routes answers like any unknown route.
  let listUnavailable = true;
  let previewGate = null;
  // When set, answers the list reads in place of the fixture's checkpoints.
  let listAnswer = null;
  let diffGate = null;
  route = async (url, options) => {
    if (url.pathname === "/api/worktrees/checkpoints" && (options.method ?? "GET") === "GET") {
      if (listAnswer) return listAnswer();
      return listUnavailable ? response({ error: "API route not found" }, 404) : response(detail);
    }
    if (url.pathname.endsWith("/inspect")) return response({ checkpoint, entries: [{ path: "a.txt", state: "staged", status: "M" }], truncated: false });
    if (url.pathname.endsWith("/diff")) {
      diffs.push(Object.fromEntries(url.searchParams));
      if (diffGate) await diffGate;
      return response({ diff: `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-now ${url.searchParams.get("side")}\n+then ${url.searchParams.get("side")}\n` });
    }
    posts.push({ path: url.pathname, body: options.body ? JSON.parse(options.body) : null });
    if (url.pathname.endsWith("/preview") && previewGate) await previewGate;
    if (url.pathname.endsWith("/preview")) return response(preview(JSON.parse(options.body).resume === true));
    if (url.pathname.endsWith("/restore")) return restoreAnswer();
    if (url.pathname.endsWith("/recover")) { detail = { ...detail, restore: null }; return response({ restored: 3 }); }
    return response({});
  };
  const events = new EventTarget();
  const errors = [];
  const show = (open) => root.render(<TooltipProvider><WorktreeCheckpointsDialog open={open} onOpenChange={() => {}} project={project} worktree={worktree} events={events} onError={(error) => errors.push(error)} /></TooltipProvider>);
  show(true);
  const dialog = () => document.querySelector(".checkpoint-dialog");
  const button = (name) => [...(dialog()?.querySelectorAll("button") ?? [])].find((item) => item.textContent.trim() === name || item.getAttribute("aria-label") === name);
  const restoreButton = () => [...dialog().querySelectorAll("button")].find((item) => /^(?:Restore|Finish restoring) \d/.test(item.textContent));
  const box = (path) => [...(dialog()?.querySelectorAll(".checkpoint-paths li") ?? [])].find((item) => item.querySelector("code")?.textContent === path)?.querySelector('input[type="checkbox"]');
  const confirmTerminals = () => dialog().querySelector(".checkpoint-preview .lifecycle-acknowledge input").click();
  await until(() => button("Retry"), "a list read the runtime does not serve did not offer Retry");
  assert(/not available in this version/.test(dialog().querySelector('[role="alert"]')?.textContent ?? ""), "an unavailable runtime was not reported in an alert");
  assert(!/Reading checkpoints/.test(dialog().textContent) && !errors.length, "a failed list read kept reading or was reported elsewhere");
  listUnavailable = false;
  button("Retry").focus();
  button("Retry").click();
  await until(() => button("Restore Before agent"), "the checkpoint was not listed with a restore control");
  await until(() => !button("Retry") && document.activeElement === dialog().querySelector(".checkpoint-create input"), "a successful retry did not clear the alert and focus the label field");
  assert(/1 staged · 2 untracked/.test(dialog().textContent), "the checkpoint did not say what it holds");
  const focused = (control, label) => assert(document.activeElement === control, `focus was not on ${label} but on ${document.activeElement?.outerHTML.slice(0, 120)}`);
  const heading = () => dialog().querySelector(".checkpoint-view-heading");
  button("Inspect Before agent").focus();
  button("Inspect Before agent").click();
  await until(() => heading(), "inspect did not open");
  focused(heading(), "the inspected checkpoint's heading");
  button("Back").click();
  await until(() => button("Inspect Before agent"), "Back did not return to the list");
  focused(button("Inspect Before agent"), "the Inspect control that opened the view");
  button("Delete Before agent").click();
  await until(() => button("Keep"), "delete did not ask for confirmation");
  focused(button("Keep"), "the Keep choice of a pending delete");
  button("Keep").click();
  await until(() => button("Delete Before agent"), "Keep did not cancel the delete");
  focused(button("Delete Before agent"), "the Delete control");
  button("Restore Before agent").click();
  await until(() => box("a.txt"), "the restore preview did not open");
  focused(heading(), "the preview's heading");
  assert(box("cache").disabled && !box("cache").checked, "a blocked path was offered");
  // A path whose index entry changes offers its staged difference apart from its file's.
  button("Show staged difference for a.txt").click();
  await until(() => /then index/.test(dialog().querySelector(".checkpoint-diff")?.textContent ?? ""), "the staged difference was not shown");
  assert(diffs.at(-1).side === "index" && diffs.at(-1).tree === "e".repeat(40), "the staged difference did not compare the previewed index");
  assert(!button("Show staged difference for dir"), "a path whose index does not change offered a staged difference");
  button("Show file difference for a.txt").click();
  await until(() => /then files/.test(dialog().querySelector(".checkpoint-diff")?.textContent ?? ""), "the file difference was not shown");
  assert(diffs.at(-1).side === "files" && diffs.at(-1).tree === "d".repeat(40), "the file difference did not compare the previewed files");
  assert(restoreButton().disabled, "restore was possible before the open terminal was confirmed");
  box("dir/inner.txt").click();
  await until(() => !box("dir").checked && !box("dir/inner.txt").checked, "a file/directory swap was not cleared together");
  confirmTerminals();
  await until(() => !restoreButton().disabled, "confirming the terminal did not enable restore");
  assert(restoreButton().textContent === "Restore 1 path", `the restore named ${restoreButton().textContent}`);

  restoreAnswer = () => response({ error: "The worktree changed after the preview", code: "CHECKPOINT_PLAN_CHANGED" }, 409);
  restoreButton().click();
  await until(() => previews === 2 && /changed after the preview/.test(dialog().querySelector(".lifecycle-summary")?.textContent ?? ""), "a changed worktree did not replace the preview");
  assert(JSON.stringify(posts.find((post) => post.path.endsWith("/restore")).body) === JSON.stringify({ projectId: project.id, worktreePath: worktree.path,
    id: checkpoint.id, planDigest: "1".padStart(64, "0"), paths: ["a.txt"], acknowledgeTerminals: ["t1"] }), "the restore did not confirm the preview shown");
  await until(() => box("dir")?.checked, "the new preview did not load");
  assert(restoreButton().disabled, "the new preview kept the old terminal confirmation");
  confirmTerminals();
  // A terminal opened after the preview is listed in a new one to confirm.
  restoreAnswer = () => response({ error: "Confirm the terminals open in this worktree before restoring", code: "CHECKPOINT_TERMINALS_UNACKNOWLEDGED" }, 409);
  await until(() => !restoreButton().disabled, "the new preview could not be confirmed");
  restoreButton().click();
  await until(() => previews === 3 && /terminal was opened/.test(dialog().querySelector(".lifecycle-summary")?.textContent ?? ""), "a terminal refusal did not reopen the preview");
  focused(heading(), "the reopened preview's heading");
  assert(restoreButton().disabled, "the reopened preview kept the old terminal confirmation");
  confirmTerminals();
  restoreAnswer = () => response({ restored: 3, safetyCheckpoint: { ...checkpoint, id: "lx1abd-0123abce", label: "Before restoring Before agent", reason: "before-restore" } });
  await until(() => !restoreButton().disabled, "the reopened preview could not be confirmed");
  restoreButton().click();
  await until(() => /Restored 3 paths/.test(dialog().querySelector(".lifecycle-summary")?.textContent ?? ""), "the restore outcome was not announced");
  focused(dialog().querySelector(".checkpoint-create input"), "the label field after the restore");
  const sent = posts.filter((post) => post.path.endsWith("/restore")).at(-1).body;
  assert(sent.planDigest === "3".padStart(64, "0") && [...sent.paths].sort().join() === "a.txt,dir,dir/inner.txt", "the restore did not confirm the new preview");

  // A restarted runtime reports an interrupted restore without an event.
  detail = { ...detail, restore: { status: "interrupted", checkpointId: checkpoint.id, safetyCheckpointId: "lx1abd-0123abce", paths: 3 } };
  events.dispatchEvent(new CustomEvent("reconnect"));
  await until(() => button("Finish restore…") && button("Keep files as they are"), "an interrupted restore did not offer finish and keep");
  assert(button("Restore Before agent").disabled, "a new restore was offered over an interrupted one");
  // Finishing is previewed and confirmed like any restore, against the state now.
  button("Finish restore…").click();
  await until(() => box("a.txt") && /Finish restoring/.test(dialog().querySelector(".checkpoint-preview h3")?.textContent ?? ""), "finishing the restore did not open its preview");
  assert(posts.at(-1).path.endsWith("/preview") && posts.at(-1).body.resume === true, "the finish preview did not ask for the unfinished restore");
  // A finish that stops part way again leaves the preview for finish or keep.
  confirmTerminals();
  restoreAnswer = () => response({ error: "Restore stopped before finishing", code: "CHECKPOINT_RESTORE_INTERRUPTED" }, 409);
  await until(() => restoreButton() && !restoreButton().disabled, "the finish preview could not be confirmed");
  restoreButton().click();
  await until(() => !heading() && button("Finish restore…"), "an interrupted restore kept its stale preview over finish and keep");
  await until(() => document.activeElement === button("Finish restore…"), "focus did not move to Finish restore…");
  errors.length = 0;
  button("Finish restore…").click();
  await until(() => box("a.txt"), "finishing did not open its preview again");
  confirmTerminals();
  restoreAnswer = () => { detail = { ...detail, restore: null }; return response({ restored: 1, safetyCheckpoint: { ...checkpoint, id: "lx1abe-0123abcf", label: "Before finishing", reason: "before-restore" } }); };
  await until(() => restoreButton() && !restoreButton().disabled, "the finish preview could not be confirmed");
  restoreButton().click();
  await until(() => /Finished the restore of 1 path/.test(dialog().querySelector(".lifecycle-summary")?.textContent ?? "") && !button("Finish restore…"), "finishing the restore left it reported as interrupted");
  const finished = posts.at(-1);
  assert(finished.path.endsWith("/restore") && finished.body.resume === true && finished.body.planDigest === String(previews).padStart(64, "0")
    && finished.body.paths.join() === "a.txt", "finishing did not confirm its own preview");
  detail = { ...detail, restore: { status: "interrupted", checkpointId: checkpoint.id, safetyCheckpointId: "lx1abd-0123abce", paths: 1 } };
  events.dispatchEvent(new CustomEvent("reconnect"));
  await until(() => button("Keep files as they are"), "an interrupted restore did not offer keep");
  button("Keep files as they are").click();
  await until(() => !button("Keep files as they are") && document.activeElement === dialog().querySelector(".checkpoint-create input"), "keeping the files did not move focus to the label field");

  // Git processes the restore lost track of keep both choices closed.
  detail = { ...detail, restore: { status: "interrupted", checkpointId: checkpoint.id, safetyCheckpointId: "lx1abd-0123abce", paths: 1, ownerUnconfirmed: true } };
  events.dispatchEvent(new CustomEvent("reconnect"));
  await until(() => button("Finish restore…")?.disabled && button("Keep files as they are")?.disabled, "unconfirmed Git processes left finish or keep open");
  assert(/not confirmed stopped/.test(dialog().textContent), "the dialog did not say why the restore cannot be finished");

  // A preview answered after the dialog closed does not reach it when reopened.
  detail = { ...detail, restore: null };
  events.dispatchEvent(new CustomEvent("reconnect"));
  await until(() => button("Restore Before agent") && !button("Restore Before agent").disabled, "the restore control did not return");
  let releasePreview;
  previewGate = new Promise((resolve) => { releasePreview = resolve; });
  const asked = previews;
  button("Restore Before agent").click();
  await until(() => posts.at(-1)?.path.endsWith("/preview"), "the delayed preview was not requested");
  show(false); await settle();
  previewGate = null; releasePreview(); await until(() => previews === asked + 1, "the delayed preview did not answer");
  await settle();
  show(true);
  await until(() => button("Restore Before agent"), "the reopened dialog did not list the checkpoints");
  await settle();
  assert(!heading() && !dialog().querySelector(".checkpoint-preview"), "a preview answered after close was shown in the reopened dialog");

  // An older read answering after a newer one failed replaces neither the
  // failure nor, when it fails too, the newer message.
  const alertText = () => dialog().querySelector('[role="alert"]')?.textContent ?? "";
  for (const older of [() => response(detail), () => response({ error: "API route not found" }, 404)]) {
    let releaseOlder;
    const held = new Promise((resolve) => { releaseOlder = resolve; });
    const answers = [() => held.then(older), () => response({ error: "The runtime is busy" }, 503)];
    listAnswer = () => answers.shift()();
    events.dispatchEvent(new CustomEvent("reconnect"));
    await until(() => answers.length === 1, "the older list read was not issued");
    events.dispatchEvent(new CustomEvent("reconnect"));
    await until(() => button("Retry") && /The runtime is busy/.test(alertText()), "the newer failed read was not reported");
    releaseOlder(); await held; await settle();
    assert(button("Retry") && /could not be read: The runtime is busy/.test(alertText()), `an older read replaced the newer failure: ${alertText() || "no alert"}`);
    listAnswer = null;
    button("Retry").click();
    await until(() => !button("Retry") && button("Restore Before agent"), "Retry did not list the checkpoints again");
  }

  // A restore answered after the dialog closed reads nothing into it.
  button("Restore Before agent").click();
  await until(() => box("a.txt"), "the restore preview did not open");
  confirmTerminals();
  let releaseRestore;
  const restoreHeld = new Promise((resolve) => { releaseRestore = resolve; });
  restoreAnswer = () => restoreHeld.then(() => response({ restored: 1, safetyCheckpoint: { ...checkpoint, id: "lx1abf-0123abd0", label: "Before late", reason: "before-restore" } }));
  await until(() => restoreButton() && !restoreButton().disabled, "the preview could not be confirmed");
  restoreButton().click();
  await until(() => posts.at(-1)?.path.endsWith("/restore"), "the delayed restore was not requested");
  show(false); await settle();
  listAnswer = () => response({ error: "Read while closed" }, 500);
  releaseRestore(); await restoreHeld; await settle(); await settle();
  let releaseList;
  const listHeld = new Promise((resolve) => { releaseList = resolve; });
  listAnswer = () => listHeld.then(() => response(detail));
  show(true);
  await until(() => dialog(), "the dialog did not reopen");
  await settle();
  assert(/Reading checkpoints/.test(dialog().textContent) && !alertText() && !button("Restore Before agent"),
    `the reopened dialog showed a read from the closed session: ${alertText() || dialog().textContent.slice(0, 160)}`);
  releaseList(); listAnswer = null;
  await until(() => button("Restore Before agent"), "the reopened dialog did not list the checkpoints");

  // Focus a step asks for never lands on a disabled control: Finish restore
  // while Git processes are unconfirmed, or a list control while busy.
  const labelField = () => dialog().querySelector(".checkpoint-create input");
  button("Restore Before agent").click();
  await until(() => box("a.txt"), "the restore preview did not open");
  confirmTerminals();
  restoreAnswer = () => { detail = { ...detail, restore: { status: "interrupted", checkpointId: checkpoint.id, safetyCheckpointId: "lx1abd-0123abce", paths: 1, ownerUnconfirmed: true } };
    return response({ error: "Restore stopped before finishing", code: "CHECKPOINT_RESTORE_INTERRUPTED" }, 409); };
  await until(() => restoreButton() && !restoreButton().disabled, "the preview could not be confirmed");
  restoreButton().click();
  await until(() => !heading() && button("Finish restore…")?.disabled, "an interrupted restore with unconfirmed Git processes left finish open");
  await settle();
  focused(labelField(), "the label field when Finish restore… was disabled");
  errors.length = 0;
  detail = { ...detail, restore: null };
  events.dispatchEvent(new CustomEvent("reconnect"));
  await until(() => button("Restore Before agent") && !button("Restore Before agent").disabled, "the restore control did not return");
  button("Restore Before agent").click();
  await until(() => box("a.txt"), "the restore preview did not open");
  let releaseDiff;
  diffGate = new Promise((resolve) => { releaseDiff = resolve; });
  button("Show file difference for a.txt").click();
  await until(() => button("Show file difference for a.txt")?.disabled, "the difference did not start loading");
  button("Back").click();
  await until(() => button("Restore Before agent")?.disabled, "Back did not return to the list while a difference loaded");
  await settle();
  focused(labelField(), "the label field when the Restore control was busy");
  diffGate = null; releaseDiff();
  await until(() => !button("Restore Before agent").disabled, "the difference did not finish loading");
  focused(labelField(), "the label field after the difference loaded");

  // An unbroken label wraps at 390px in the list, both headings and the notice.
  if (window.__fixtureSetViewport) {
    const fits = (element, label) => assert(element && element.scrollWidth <= element.clientWidth + 1 && element.getBoundingClientRect().right <= dialog().getBoundingClientRect().right + 1,
      `${label} overflowed the dialog: ${element?.scrollWidth} > ${element?.clientWidth}, right ${element?.getBoundingClientRect().right} > ${dialog().getBoundingClientRect().right}`);
    const action = (name) => dialog().querySelector(`[data-checkpoint-action="${name}:${checkpoint.id}"]`);
    try {
      await window.__fixtureSetViewport(390);
      await until(() => window.innerWidth === 390, "real 390px layout");
      checkpoint.label = "x".repeat(120);
      events.dispatchEvent(new CustomEvent("reconnect"));
      await until(() => dialog().querySelector(".checkpoint-copy strong")?.textContent === checkpoint.label, "the long label was not listed");
      await settle();
      fits(dialog().querySelector(".checkpoint-copy strong"), "the listed label");
      action("inspect").click();
      await until(() => heading(), "inspect did not open");
      fits(heading(), "the inspect heading");
      button("Back").click();
      await until(() => action("restore") && !action("restore").disabled, "Back did not return to the list");
      action("restore").click();
      await until(() => box("a.txt"), "the restore preview did not open");
      fits(heading(), "the preview heading");
      button("Back").click();
      await until(() => action("delete") && !action("delete").disabled, "Back did not return to the list");
      action("delete").click();
      await until(() => button("Confirm delete"), "delete did not ask for confirmation");
      button("Confirm delete").click();
      await until(() => /Deleted/.test(dialog().querySelector(".lifecycle-summary")?.textContent ?? ""), "the delete was not announced");
      fits(dialog().querySelector(".lifecycle-summary"), "the notice");
    } finally { await window.__fixtureSetViewport(1280); }
  }
  assert(!errors.length, `unexpected errors: ${errors.map((error) => error.message).join("; ")}`);
}

const MOTION_STEPS = ["diff Find ownership", "diff scrollbar feedback", "diff Find resize", "split pane layout", "pane notices at minimum", "responsive focus"];

try {
  const steps = [
    ["current conversation send", () => chatRace(false, false), "sending in the current conversation shows its run"],
    ["delayed send", () => chatRace(false), "delayed send cannot attach A's run to B"],
    ["delayed trust response", () => chatRace(true), "delayed trust response cannot target another conversation"],
    ["same-worktree chat selection", sameWorktreeChatSelectionRegression, "click, keyboard and created-chat selection load only the selected detail and fence sends"],
    ["space sidebar", spaceSidebarRegression, "sidebar shows spaces and Ungrouped, creates a space and moves a project with space copy and routes"],
    ["chat tab controls", chatTabControlRegression, "chat tab navigation ignores nested archive controls"],
    ["settings chat archive", chatSettingsArchiveRegression, "settings archive retains a selected, keyboard-reachable sibling chat"],
    ["chat settings session edit", chatSettingsSessionEditRegression, "conversation settings send the session only when the user edits it"],
    ["provider switch choices", providerSwitchChoicesRegression, "a provider switch keeps every other choice and blocks Save until unsupported ones are replaced"],
    ["provider readiness selection", providerReadinessSelectionRegression, "a dialog switches only to a ready provider and keeps its opened provider saveable"],
    ["recovery model correction", recoveryModelCorrectionRegression, "a legacy model is replaced with the provider default only after an explicit confirmation"],
    ["settings retention draft", settingsRetentionDraftRegression, "missing archived data stays safe and cancel, cleanup and save use the persisted retention age"],
    ["settings save session fence", settingsSaveSessionFenceRegression, "delayed GET and PATCH save completions cannot change a reopened Settings dialog"],
    ["settings shared refresh order", settingsSharedRefreshOrderRegression, "a settings save preserves an in-flight template refresh without reverting the new quota"],
    ["bootstrap error ownership", bootstrapRefreshErrorOwnershipRegression, "a background bootstrap cannot dismiss an unrelated operation error"],
    ["settings migration completion", settingsMigrationCompletionRegression, "an open Settings dialog refreshes capacity when migration finishes"],
    ["worktree removal retarget", worktreeRemovalRetargetRegression, "a refresh that drops a removed worktree never retargets its remove or setup dialog, and another worktree's dialog is left alone"],
    // Checkpoints run within the lifecycle step until the expected step count
    // in tests/ui-races.test.mjs moves with the checkpoint runtime.
    ["worktree lifecycle", async () => { await worktreeLifecycleRegression(); await worktreeCheckpointsRegression(); }, "an open setup dialog reconciles an interrupted run on reconnect, and teardown choices are explicit and bound to their worktree; a checkpoint restore is confirmed against the exact preview shown, with chosen paths and open terminals, and an interrupted one can be finished"],
    ["settings live capacity", settingsCapacityWithoutEventRegression, "an open Settings dialog reads another client's quota changes without a capacity event"],
    ["provider accounts window aging", providerAccountsWindowAgingRegression, "an open account list drops a run that leaves the 5-hour window without any event"],
    ["provider accounts failed reload", providerAccountsFailedReloadRegression, "a failed reload marks an expired measured total out of date, and account changes reload without the runtime event"],
    ["provider accounts add keeps newer draft", providerAccountsAddKeepsNewerDraftRegression, "a successful add clears only the draft it submitted"],
    ["provider accounts response order", providerAccountsResponseOrderRegression, "a delayed account action response never replaces a listing computed after it"],
    ["provider accounts switch focus", providerAccountsSwitchFocusRegression, "a switch moves focus only from its own Use button"],
    ["queued run account", queuedRunAccountRegression, "a run queued without an account names the account its launch reports before it ends, at every width, while history is read and with no answer"],
    ["settings capacity and deletion order", settingsCapacityAndDeletionOrderRegression, "new capacity wins reordered responses and deletion owns its confirmation"],
    ["settings template completion", settingsTemplateCompletionRegression, "a successful template POST clears its submitted draft after reopening"],
    ["notification permission rejection", rejectedNotificationPermissionRegression, "a rejected permission request does not disrupt Settings save or escape as an unhandled rejection"],
    ["archived settings paging focus", archivedSettingsPagingFocusRegression, "the oldest archive can be paged to and cancel and delete keep keyboard focus in Settings"],
    ["archived settings session fence", archivedSettingsSessionFenceRegression, "delayed cleanup and deletion cannot change a reopened Settings selection, status or focus"],
    ["archived chat ownership", archivedChatOwnershipRegression, "an archived chat cannot keep a pane or accept runs during held or failed refresh"],
    ["same-owner archive refresh", sameOwnerArchiveRefreshRegression, "a held archive cannot overwrite a newer same-worktree list after refresh failure"],
    ["chat detail refresh ownership", chatDetailRefreshOwnershipRegression, "failed and pending same-chat detail blocks submission and trust until fresh detail loads"],
    ["chat list submission fence", chatListSubmissionFenceRegression, "a pending list refresh cannot submit with stale chat metadata"],
    ["initial chat list failure submission", initialChatListFailureSubmissionRegression, "initial list failure disables submission until retry"],
    ["trust pending list refresh", trustPendingListRefreshRegression, "trust continuation survives a held list refresh and uses fresh detail"],
    ["new chat failed successor list", () => newChatSupersededListRegression(true), "a failed successor list preserves the first prompt across retry"],
    ["new chat superseded list", () => newChatSupersededListRegression(false), "a superseded successful list leaves the first prompt visibly retryable"],
    ["new chat ordinary first send", newChatOrdinaryRegression, "a normal first prompt submits once with fresh detail metadata"],
    ["new chat owner switch", newChatOwnerSwitchRegression, "a worktree switch during creation never submits to the new owner and preserves retry on return"],
    ["accepted retry owner switch", acceptedFirstPromptOwnerSwitchRegression, "an accepted retry settles its first prompt after an owner switch"],
    ["accepted retry chat switch", () => acceptedFirstPromptOwnerSwitchRegression(true), "an accepted retry settles its first prompt after a chat switch"],
    ["dialog successor success", () => dialogCreateSuccessorRegression(false), "dialog creation follows a successful socket successor"],
    ["dialog successor failure", () => dialogCreateSuccessorRegression(true), "dialog creation uses list retry after a failed socket successor"],
    ["dialog private list failure", () => dialogCreateSuccessorRegression(false, true), "dialog creation reports a current list failure once and retains retry"],
    ["inline archive sibling focus", () => inlineArchiveFocusRegression(false, false), "inline archive focuses the selected sibling tab"],
    ["archive paging ownership", archivePagingLoadingRegression, "archiving releases pending earlier and later loading through stale success and failure"],
    ["consecutive run live preview", consecutiveRunLivePreviewRegression, "a new run owns off-page deltas and checkpoints after completion"],
    ["inline archive nonselected focus", () => inlineArchiveFocusRegression(false, false, true), "inline archive of an inactive tab focuses the still-selected tab"],
    ["inline archive last-tab focus", () => inlineArchiveFocusRegression(true, false), "inline archive focuses New chat after the final tab"],
    ["inline archive newer focus", () => inlineArchiveFocusRegression(false, true), "inline archive preserves a newer focus choice"],
    ["terminal exit during create", terminalExitWhileCreatingRegression, "an exit received while create is held remains exited in the tablist"],
    ["terminal exit during close", terminalExitWhileClosingRegression, "a held delete retains another terminal's exit"],
    ["late archive after owner switch", () => staleArchiveWorktreeRegression(false), "late A archive does not discard B's list response"],
    ["late archive and B retry", () => staleArchiveWorktreeRegression(true), "late A archive preserves B's retry after a failed list"],
    ["worktree chat list failure", chatFailedWorktreeListRegression, "a rejected list cannot expose old-owner chat tabs and a retry restores the new owner"],
    ["worktree terminal switch", terminalRace, "worktree switch removes old terminal tabs and rejects stale buffer responses"],
    ["terminal keyboard", terminalKeyboardRegression, "terminal keyboard switching retains focus and ignores non-tab controls"],
    ["terminal unknown", terminalUnknownRegression, "unverified terminal ownership blocks interaction and survives restart"],
    ["terminal unknown during activation", terminalUnknownDuringActivationRegression, "a newer unknown event wins over an in-flight running detail"],
    ["terminal scrollback find", terminalScrollbackFindRegression, "Find counts and steps through large, Unicode and reset scrollback by keyboard without taking the process's keys"],
    ["terminal find highlight", terminalFindHighlightRegression, "Find keeps its highlight on the current match as output and reflow move it, leaves user selections alone and paces output announcements"],
    ["terminal saved session", terminalSavedSessionRegression, "saved output stays read-only, relaunches as a marked new shell and dismisses"],
    ["terminal reservation restored", terminalReservationRestoredRegression, "a reservation that becomes saved output updates in place and storage warnings announce once"],
    ["terminal saved session sync", terminalSavedSessionSyncRegression, "coalesced restores, eviction, expiry and dismissing an expired session converge with the server"],
    ["terminal exited becomes saved", terminalExitedBecomesSavedRegression, "an open exited terminal the server lists as saved shows saved output in place"],
    ["terminal listing adds sessions", terminalListingAddsSessionsRegression, "a re-list adds new live sessions and late reservations without a remount"],
    ["terminal saved paging", terminalSavedPagingRegression, "all saved output beyond one view is reachable a page at a time, earliest first line shown"],
    ["terminal reservation paging", () => terminalSavedPagingRegression(true), "a reservation's saved output is paged read-only to its first and last lines"],
    ["terminal saved modes", terminalSavedModesRegression, "saved output that sets terminal modes renders as the terminal showed it, whole and paged"],
    ["terminal saved budget", terminalSavedBudgetRegression, "saved output past the row budget activates responsively, discloses left-out output and stops when superseded"],
    ["terminal history event slot", terminalHistoryEventSlotRegression, "a storage status change never replaces terminal output or an exit delivered in the same task"],
    ["terminal close history failure", terminalCloseHistoryFailureRegression, "a close whose saved output cannot be deleted shows it ended and read-only"],
    ["terminal fenced saved session", terminalFencedSavedSessionRegression, "a saved status from the server wins over the page audit fence"],
    ["terminal reattach lifts fence", terminalReattachLiftsFenceRegression, "a later runtime's verified live reattach lifts the audit fence; a same-runtime reconnect does not"],
    ["terminal reattach after connect", terminalReattachAfterConnectRegression, "a reattach verified after the page connected lifts the audit fence without a reconnect"],
    ["terminal reattach listed before release", terminalReattachListedBeforeReleaseRegression, "a tab listed as reattached while fenced follows the server once the fence lifts"],
    ["terminal selection during reconnect", terminalSelectionReconnectRegression, "selected terminal and output survive a reconnect while its buffer is pending"],
    ["terminal activation ownership", terminalActivationOwnershipRegression, "terminal activation commits output and current PTY size together"],
    ["rejected terminal switch", terminalRejectedSwitchRegression, "rejected terminal switch restores the selected tab focus"],
    ["terminal exit during activation", terminalExitDuringActivationRegression, "terminal exit during activation is announced and cannot accept input"],
    ["terminal exit rejection", terminalExitRejectionRegression, "candidate and active exits survive failed activation and fresh running reacquisition"],
    ["repeated terminal exit and close", terminalRepeatedExitCloseRegression, "repeated terminal exits and closes retain only live tabs"],
    ["terminal reconnect during mutation", terminalReconnectMutationRegression, "reconnect refreshes authoritative terminals after pending create and delete"],
    ["same-pane terminal metadata", terminalSamePaneRestartRegression, "same-pane restart drains reconnect after pending mutation"],
    ["terminal reconnect ownership", terminalReconnectOwnershipRegression, "overlapping reconnects coalesce and unmount discards queued work"],
    ["background terminal activation", terminalBackgroundActivationRegression, "background activation settles and fits when visible"],
    ["initial terminal failure", terminalInitialFailureRegression, "failed initial terminal activation retains a keyboard-reachable tab"],
    ["terminal mutation failure", terminalMutationFailureRegression, "create, close and reconnect failures preserve terminal tab ownership"],
    ["terminal delete focus ownership", terminalDeleteFocusOwnershipRegression, "delete restores the committed successor tab without stealing a newer focus choice"],
    ["command search", commandPaletteRegression, "command search keeps asynchronous results current and selectable"],
    ["changes loading", changesLoadingRegression, "changes pane waits for status before announcing a clean tree"],
    ["changes discarded render", changesDiscardedRenderRegression, "a suspended worktree render cannot steal a committed status request"],
    ["stale diff selection", staleDiffSelectionRegression, "a slow prior diff cannot replace the selected file"],
    ["changes refresh selection", changesSelectionRefreshRegression, "pending refreshes preserve current file and mode and retained events refresh once"],
    ["changes diff failure ownership", changesDiffFailureOwnershipRegression, "pending and failed file or mode requests never display a previous diff"],
    ["diff refresh anchor", diffRefreshAnchorRegression, "same-selection refresh keeps the visible diff line and find through success and failure"],
    ["diff Find ownership", diffFindOwnershipRegression, "a late queued scroll at any viewport height cannot take a Find match out of view"],
    ["diff scrollbar feedback", diffScrollbarFeedbackRegression, "a horizontal scrollbar from a long row at the diff window edge settles Find instead of looping"],
    ["diff Find resize", diffFindResizeRegression, "Find, Next and Previous land aligned and a resize realigns the match before paint"],
    ["changes mutation owner success", () => changesMutationOwnerRegression(false), "late stage completion cannot refresh another worktree"],
    ["changes mutation owner failure", () => changesMutationOwnerRegression(true), "late stage failure cannot report in another worktree"],
    ["changes unstage owner failure", () => changesMutationOwnerRegression(true, "unstage"), "late unstage failure cannot report in another worktree"],
    ["changes commit owner success", () => changesCommitOwnerRegression(false), "late commit completion cannot update another worktree"],
    ["changes commit owner failure", () => changesCommitOwnerRegression(true), "late commit failure cannot report in another worktree"],
    ["long transcript window", longTranscriptWindowRegression, "a thousand messages keep a bounded DOM and remain scrollable"],
    ["sustained output", sustainedOutputRegression, "small deltas coalesce without losing output or input responsiveness"],
    ["many worktree sessions", manyWorktreeSessionRegression, "two repeated switch cycles across two hundred worktrees keep one conversation mounted"],
    ["initial Previous find", previousFindStartRegression, "Previous begins at the final matching message"],
    ["variable-height find anchor", variableHeightFindAnchorRegression, "measured tall messages keep a found row visible through resize and live append"],
    ["large diff window", largeDiffWindowRegression, "fifty thousand diff lines keep a bounded DOM and preserve the last line"],
    ["extreme diff height", extremeDiffHeightRegression, "a clamped-height diff still reaches its final line with End and Find"],
    ["Unicode diff find", unicodeDiffFindRegression, "length-changing case folding keeps the correct diff line"],
    ["reverse diff Find wrap", reverseDiffFindWrapRegression, "Previous wraps left of offset zero and continues through earlier matches"],
    ["production diff viewport", productionDiffViewportRegression, "staged and unstaged large diffs stay bounded in a pane"],
    ["paged transcript anchor", pagedTranscriptAnchorRegression, "loading earlier history preserves its visible reading anchor"],
    ["stale page measured follow", () => pagedTranscriptFindRegression({ measuredOnly: true }), "a newly measured row cannot erase latest-page bottom intent before a live append"],
    ["paged transcript find", pagedTranscriptFindRegression, "find navigates older persisted messages with bounded mounted rows"],
    ["full Find message reader", fullFindMessageReaderRegression, "an excerpted match opens bounded full-body sections with keyboard, retry and navigation"],
    ["stale page End follow", () => pagedTranscriptFindRegression({ endOnly: true }), "End reaches the latest row after stale and failed page loads and follows new output"],
    ["forward history paging", forwardHistoryPagingRegression, "an old page can be read continuously through the persisted end within the 1000-row cap"],
    ["forward page eviction anchor", forwardPageEvictionAnchorRegression, "a full-window forward page retains surviving reading rows and hands evicted rows to Load earlier"],
    ["background latest refresh", backgroundLatestRefreshRegression, "a missed event refreshes the latest page without keeping a stale snapshot"],
    ["background reading refresh", backgroundReadingRefreshRegression, "missed replay and completion expose later output without moving a reader"],
    ["full-page live anchor", fullPageLiveAnchorRegression, "a new row at the 1000-message cap keeps the reader's oldest visible anchor"],
    ["large live message retention", largeLiveMessageRetentionRegression, "large live messages retain bounded excerpts and full-reader identity"],
    ["large page message retention", largePageMessageRetentionRegression, "initial, earlier, Find and later pages retain bounded rows, IDs and full-body access"],
    ["transcript observer stability", transcriptObserverStabilityRegression, "stream paints do not restart row observation for an unchanged long transcript"],
    ["background completion page ownership", backgroundCompletionKeepsExplicitPageRegression, "run completion cannot supersede an explicit Return to latest request"],
    ["replay latest page boundary", replayKeepsLatestPageBoundaryRegression, "a buffered older checkpoint cannot make intervening history unreachable"],
    ["deferred reload selection", deferredReloadSelectionOwnershipRegression, "a queued old selection reload cannot claim the new chat's detail slot"],
    ["latest before find ownership", latestBeforeFindOwnershipRegression, "an older Return to latest response cannot supersede a newer find"],
    ["find during metadata refresh", findWhileMetadataRefreshRegression, "completion, reconnect and list metadata survive a concurrent Find without replacing its page"],
    ["metadata before find result", metadataBeforeFindResultRegression, "completion, reconnect and list metadata may settle before Find without clearing a match, miss, or error"],
    ["checkpoint reading page", checkpointReadingPageRegression, "reconnect, completion and list updates retain a reading page and unique checkpoint counts"],
    ["find in-flight event", findInFlightEventRegression, "an event during find remains reachable when the returned page claims to be latest"],
    ["typing during prepend", typingDuringPrependRegression, "editing a find query does not silently cancel an earlier-page request"],
    ["pending run outcome", pendingRunOutcomeRegression, "a storage-pending final outcome is announced only in its chat and clears on terminal commit"],
    ["pending run with queued sibling", pendingRunWithQueuedSiblingRegression, "an older exited run stays identifiable while its queued sibling can be canceled"],
    ["provider bootstrap convergence", providerBootstrapConvergenceRegression, "a checking bootstrap converges after an earlier provider event"],
    ["bootstrap maintenance retry", bootstrapMaintenanceRetryRegression, "a transient archive cutover resumes initial loading"],
    ["bootstrap hard failures", bootstrapHardFailureRegression, "authorization, server, and network failures surface once"],
    ["provider checking rate", providerCheckingRateRegression, "repeated checking snapshots keep a bounded poll cadence"],
    ["conversation settings keyboard", conversationSettingsKeyboardRegression, "conversation settings stay keyboard reachable at 360, 760 and 900px", "keyboard and width checks require the CDP bridges"],
    ["split pane layout", splitPaneLayoutRegression, "nested panes resize, move, cycle focus, restore and repair without restarting their views"],
    ["pane minimum content", paneMinimumContentRegression, "every view keeps usable content at its minimum pane size, including restored layouts", "minimum pane geometry requires the CDP viewport bridge"],
    ["pane notices at minimum", paneNoticeMinimumRegression, "recovery, unsent-prompt and commit controls stay readable and clickable at the pane minimums on a wide window", "minimum pane geometry requires the CDP viewport bridge"],
    ["pane notices at minimum height", paneNoticeShortRegression, "at the conversation's minimum height the transcript keeps message lines while recovery, history, live and unsent-prompt notices stay readable and reachable", "minimum pane geometry requires the CDP viewport bridge"],
    ["compact pane tab visibility", compactPaneTabVisibilityRegression, "keyboard selection reveals each of four pane tabs in a 320px and 360px strip without scrolling the workspace"],
    ["pane layout owner", paneLayoutOwnerRegression, "worktrees whose ids collide keep their own pane layouts across switches and a reload"],
    ["pane layout replacement", paneLayoutReplacementRegression, "a separator drag on a replaced layout is discarded unsaved and focus on any removed pane chrome moves to the shown pane", "responsive transition requires the CDP viewport bridge"],
    ["pane drag isolation", paneDragChatTabRegression, "pane title drags never reorder chat tabs, even after an unfinished tab drag"],
    ["responsive focus", responsiveFocusRegression, "narrow drawer and one-at-a-time panes contain and restore focus", "responsive transition requires the CDP viewport bridge"],
    ["recovery actions", recoveryActionsRegression, "phone-width recovery decisions remain inside the viewport", "phone geometry requires a narrow viewport"],
  ];
  // The harness runs every step with reduced motion, as hosted macOS and
  // Windows runners report it. Pane and diff geometry must be final at commit
  // in either mode, so those steps run again without it.
  for (const [step, run, success, skipped] of steps.filter(([name]) => MOTION_STEPS.includes(name))) {
    steps.push([`${step} without reduced motion`, async () => {
      if (!window.__fixtureSetMotion) return false;
      await window.__fixtureSetMotion("no-preference");
      try { return await run(); } finally { await window.__fixtureSetMotion("reduce"); }
    }, `${success}, without reduced motion`, skipped ?? "reduced-motion emulation requires the CDP motion bridge"]);
  }
  const selectedStep = new URLSearchParams(location.search).get("only");
  const selectedSteps = selectedStep ? steps.filter(([name]) => selectedStep.split(",").includes(name)) : steps;
  if (!selectedSteps.length) throw new Error(`Unknown interaction fixture: ${selectedStep}`);
  const startedAt = performance.now();
  window.__fixtureStartedAt = startedAt;
  window.__fixtureTimings = [];
  let passed = 0;
  for (const [index, [step, run, success, skipped]] of selectedSteps.entries()) {
    const stepStartedAt = performance.now();
    window.__fixtureProgress = { step, completed: index, total: selectedSteps.length, stepStartedAt };
    // A browser page opened by an earlier step's native key hides this one
    // until the harness restores it. No step starts without painted frames.
    if (document.visibilityState === "hidden" && window.__requestFixtureForeground) {
      window.__requestFixtureForeground(window.__fixtureForegroundReason());
      await until(() => document.visibilityState === "visible", `foreground before ${step}`); // NOSONAR S9382: each step starts visible
    }
    localStorage.removeItem(LAYOUT_KEY);
    const ran = await run();
    window.__fixtureTimings.push({ step, ms: Math.round(performance.now() - stepStartedAt) });
    results.textContent += `${ran === false && skipped ? `SKIP: ${skipped}` : `PASS: ${success}`}\n`;
    if (ran !== false) passed += 1;
  }
  window.__fixtureProgress = { step: "complete", completed: selectedSteps.length, total: selectedSteps.length, stepStartedAt: performance.now() };
  results.textContent += `Performance fixture: ${JSON.stringify(window.__performanceEvidence)}\n`;
  results.textContent += `${passed} interaction regressions passed`;
  document.title = "PASS — Outright interaction regressions";
} catch (error) {
  results.textContent += `\nFAIL: ${error.stack}`;
  document.title = "FAIL — Outright interaction regressions";
} finally {
  root.unmount();
  window.fetch = originalFetch;
  window.WebSocket = OriginalSocket;
  keys.forEach((key, index) => saved[index] === null ? localStorage.removeItem(key) : localStorage.setItem(key, saved[index]));
  if (savedLayouts === null) localStorage.removeItem(LAYOUT_KEY);
  else localStorage.setItem(LAYOUT_KEY, savedLayouts);
}
