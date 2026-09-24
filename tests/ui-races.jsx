// Open /tests/ui-races.html on the local Vite server. All API and socket traffic
// is replaced in this page; no real project, conversation or terminal is changed.
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.jsx";
import { ChangesPane } from "../src/components/ChangesPane.jsx";
import { CommandPalette } from "../src/components/CommandPalette.jsx";
import { TerminalPane } from "../src/components/TerminalPane.jsx";
import { TooltipProvider } from "../src/components/ui/tooltip.jsx";
import "../src/styles.css";

const host = document.getElementById("root");
const results = document.getElementById("results");
const root = createRoot(host);
const originalFetch = window.fetch;
const OriginalSocket = window.WebSocket;
const keys = ["outright.selected-project", "outright.selected-worktree", "outright.selected-conversation"];
const saved = keys.map((key) => localStorage.getItem(key));
const projects = ["A", "B"].map((id) => ({ id, name: `Review ${id}`, path: `/fixture/${id}`, worktrees: [{ id, name: id, path: `/fixture/${id}`, branch: "main", changedCount: 0 }] }));
const chats = Object.fromEntries(projects.map(({ id }) => [id, { id: `chat-${id}`, title: `Conversation ${id}`, projectId: id, worktreeId: id, worktreePath: `/fixture/${id}`, provider: "codex", messages: [], runs: [] }]));
const terminal = (id) => ({ id: `term-${id}`, name: `Terminal ${id}`, cwd: `/fixture/${id[0]}`, status: "running" });
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const frame = () => new Promise((resolve) => document.hidden ? setTimeout(resolve, 16) : requestAnimationFrame(resolve));
async function settle() { await frame(); await frame(); }
function terminalReady(name) { return host.querySelector('.terminal-tabs[aria-busy="false"] [role="tab"][aria-selected="true"]')?.textContent === name; }
async function until(check, label) {
  const deadline = performance.now() + 5000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await frame();
  }
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
  assert(!host.querySelector("#workspace-inspector"), "Inspector was already open before Changes click");
  changes.click();
  await settle();
  assert(host.querySelector('#workspace-inspector'), `Inspector did not open: changes=${changes.outerHTML.slice(0, 400)}, connected=${changes.isConnected}, active=${document.activeElement?.outerHTML.slice(0, 250)}`);
  assert(host.querySelector('#inspector-tab-changes[aria-selected="true"]'),
    `Changes did not select the inspector tab: ${host.querySelector('#workspace-inspector')?.outerHTML.slice(0, 600)}`);
  const inspectorTab = host.querySelector("#inspector-tab-changes");
  await assertVerticalKeysIgnored(inspectorTab, inspectorTab, "Inspector");
  inspectorTab.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
  await until(() => host.querySelector('#inspector-tab-context[aria-selected="true"]'), "End selects final inspector tab");
  host.querySelector("#inspector-tab-context").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
  await until(() => host.querySelector('#inspector-tab-terminal[aria-selected="true"]'), "left arrow selects terminal inspector tab");
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
  host.style.width = "320px";
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
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event} onError={onError} sendRuntime={sendRuntime} />);
  show();
  await until(() => terminalReady("Terminal A"), "ownership fixture initial terminal ready");
  const initialSize = sent.findLast((message) => message.type === "terminal.resize");
  const initialHostWidth = host.querySelector(".terminal-host").getBoundingClientRect().width;
  assert(initialSize?.terminalId === "term-A", "Initial activation did not synchronize the selected PTY size");
  host.querySelector('[data-tab-id="term-A2"]').click();
  await until(() => host.querySelector('.terminal-tabs[aria-busy="true"]'), "pending terminal activation");
  assert(host.querySelector('[role="tab"][aria-selected="true"]')?.dataset.tabId === "term-A", "Pending candidate was selected before its buffer was installed");
  await until(() => host.querySelector(".xterm-rows")?.textContent.includes("Old A output"), "committed terminal output");
  host.style.width = "540px";
  await until(() => host.querySelector(".terminal-host")?.getBoundingClientRect().width > initialHostWidth + 100, "terminal host expanded during activation");
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
  host.style.width = "";
}

async function terminalRejectedSwitchRegression() {
  root.render(null);
  await settle();
  const pending = deferred();
  const errors = [];
  route = async (url) => {
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A"), terminal("A2")] });
    if (url.pathname === "/api/terminals/term-A2") return pending.promise;
    return response({ buffer: "Terminal A output\r\n" });
  };
  root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={null} onError={(error) => errors.push(error)} sendRuntime={() => {}} />);
  await until(() => terminalReady("Terminal A"), "rejection fixture terminal A ready");
  const first = [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Terminal A");
  first.focus();
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await until(() => document.activeElement?.textContent === "Terminal A2", "pending rejected terminal");
  pending.reject(new Error("Buffer failed"));
  await until(() => errors.length === 1 && host.querySelector('.terminal-tabs[aria-busy="false"]'), "rejected terminal response");
  assert(host.querySelector('[role="tab"][aria-selected="true"]') === first && first.tabIndex === 0, "Failed terminal switch changed selection");
  assert(document.activeElement === first, "Failed terminal switch left focus on an unselected tab");
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
  const onError = (error) => errors.push(error);
  const sendRuntime = (message) => sent.push(message);
  route = async (url) => {
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A"), terminal("A2")] });
    if (url.pathname === "/api/terminals/term-A2" && hold) return pending.promise;
    return response({ buffer: "Running output\r\n", status: "running" });
  };
  const show = (event = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={event} onError={onError} sendRuntime={sendRuntime} />);
  show();
  await until(() => terminalReady("Terminal A"), "running A before rejected exit");
  host.querySelector('[data-tab-id="term-A2"]').click();
  await until(() => host.querySelector('.terminal-tabs[aria-busy="true"]'), "pending candidate before rejection");
  show({ type: "terminal.exit", terminalId: "term-A2", payload: { exitCode: 7 } });
  await settle();
  assert(host.querySelector('[data-tab-id="term-A2"]').getAttribute("aria-label").includes("process exited 7"), "Candidate exit disappeared before activation failed");
  show({ type: "terminal.exit", terminalId: "term-A", payload: { exitCode: 8 } });
  await settle();
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
  const reconnect = () => ({ type: "runtime.connected", payload: { replay: { requestedAfter: 1 }, terminals: [{ ...terminal("A"), status: "exited" }] } });
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
  currentResults.resolve(response({ conversations: [{ id: "current", title: "Current result", provider: "codex", worktreePath: "/current" }], messages: [] }));
  await until(() => document.querySelector('[role="option"]')?.textContent.includes("Current result"), "current command result");
  await until(() => input.getAttribute("aria-activedescendant") === "command-result-0", "active remote command result");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert(selected?.id === "current", "Enter did not select the asynchronously loaded command result");
  assert([...document.querySelector('[role="listbox"]').children].every((element) => element.getAttribute("role") === "option"), "Command listbox contains non-option children");

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

async function responsiveFocusRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  // Change the actual CSS viewport: mocking matchMedia alone can report desktop
  // while the real 390px layout hides the control under test.
  const setWidth = async (width) => {
    await window.__fixtureSetViewport(width);
    await until(() => window.innerWidth === width && window.matchMedia("(max-width: 760px)").matches === (width <= 760), `real ${width}px layout`);
    await settle();
  };
  if (!window.__fixtureSetViewport) return false; // Manual preview still runs width-independent cases.
  await setWidth(1280);
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [{ id: "group", name: "Regression fixture" }], memberships: { A: "group", B: "group" } }, settings: { provider: "codex", approvalPolicy: "read-only", reasoningEffort: "medium" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats[url.searchParams.get("projectId")]] });
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

    for (let round = 0; round < 3; round += 1) {
      const desktopSidebarControl = host.querySelector('[aria-label="Close projects sidebar"]');
      desktopSidebarControl.focus();
      await setWidth(640);
      await until(() => host.querySelector('[aria-label="Open projects sidebar"]'), `sidebar closed from focused desktop control ${round + 1}`);
      try {
        await until(() => visibleFocus(host.querySelector('[aria-label="Open projects sidebar"]')), `visible focus restored after hiding desktop sidebar ${round + 1}`);
      } catch (error) {
        const active = document.activeElement;
        const opener = host.querySelector('[aria-label="Open projects sidebar"]');
        throw new Error(`${error.message}; active=${active?.outerHTML?.slice(0, 250)}; openerRect=${JSON.stringify(opener?.getBoundingClientRect().toJSON())}; openerVisibility=${opener && getComputedStyle(opener).visibility}`);
      }
      if (round === 1) {
        // Some engines blur a disappearing control before dispatching the media
        // change. Preserve the last owner even if activeElement is now BODY.
        document.activeElement.blur();
        assert(document.activeElement === document.body, "Blur did not simulate focus loss before breakpoint change");
      }
      await setWidth(1280);
      await until(() => host.querySelector("#project-sidebar").getAttribute("aria-hidden") === "false", `sidebar reopened after wide transition ${round + 1}`);
      try {
        await until(() => host.querySelector("#project-sidebar").contains(document.activeElement) && visibleFocus(document.activeElement), `visible sidebar focus after wide transition ${round + 1}`);
      } catch (error) {
        const active = document.activeElement;
        const rect = active?.getBoundingClientRect();
        throw new Error(`${error.message}; active=${active?.outerHTML?.slice(0, 250)}; sidebar=${host.querySelector("#project-sidebar")?.getAttribute("aria-hidden")}; activeRect=${rect && JSON.stringify({ x: rect.x, width: rect.width })}`);
      }
    }

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
    assert(document.activeElement.matches('button:not(:disabled)'), "Drawer entry focused an aside sentinel instead of an actionable button");
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
    const composerB = host.querySelector('textarea[aria-label="Message the agent"]');
    composerB.focus();
    await setWidth(1280);
    await until(() => host.querySelector("#project-sidebar").getAttribute("aria-hidden") === "false", "wide sidebar after closed selection");
    await setWidth(390);
    await until(() => host.querySelector("#project-sidebar").getAttribute("aria-hidden") === "true", "narrow sidebar after closed selection");
    assert(document.activeElement === composerB, "Selecting a project while the drawer was closed left stale focus restoration state");

    const terminalTrigger = host.querySelector('[aria-label="Terminal"]');
    terminalTrigger.click();
    await until(() => host.querySelector("#workspace-inspector"), "narrow inspector");
    await until(() => document.activeElement?.id === "inspector-tab-terminal", "inspector tab focus");
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
    assert(host.querySelector("#workspace-inspector"), "Escape from terminal input dismissed the inspector");
    assert(keyEvents.some((event) => event.key === "Escape" && event.target === terminalInput && event.trusted), "Trusted Escape did not reach the terminal input");
    const terminalTab = host.querySelector("#inspector-tab-terminal");
    terminalTab.focus();
    terminalTab.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await until(() => !host.querySelector("#workspace-inspector"), "inspector escape close");
    assert(document.activeElement === terminalTrigger, "Escape did not restore focus to the inspector invoker");

    terminalTrigger.click();
    await until(() => host.querySelector("#workspace-inspector"), "inspector reopened for composer Escape");
    host.querySelector('textarea[aria-label="Message the agent"]').focus();
    host.querySelector('textarea[aria-label="Message the agent"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await until(() => !host.querySelector("#workspace-inspector"), "composer Escape closes inspector");
    assert(document.activeElement === terminalTrigger, "Composer Escape did not restore inspector invoker focus");

    terminalTrigger.click();
    await until(() => host.querySelector('[aria-label="Close inspector"]'), "inspector close control");
    host.querySelector('[aria-label="Close inspector"]').click();
    await until(() => !host.querySelector("#workspace-inspector"), "inspector button close");
    assert(document.activeElement === terminalTrigger, "Inspector close control did not restore invoker focus");
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
    await settle();
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
  return true;
}

try {
  const steps = [
    ["current conversation send", () => chatRace(false, false), "sending in the current conversation shows its run"],
    ["delayed send", () => chatRace(false), "delayed send cannot attach A's run to B"],
    ["delayed trust response", () => chatRace(true), "delayed trust response cannot target another conversation"],
    ["chat tab controls", chatTabControlRegression, "chat tab navigation ignores nested archive controls"],
    ["settings chat archive", chatSettingsArchiveRegression, "settings archive retains a selected, keyboard-reachable sibling chat"],
    ["archived chat ownership", archivedChatOwnershipRegression, "an archived chat cannot keep a pane or accept runs during held or failed refresh"],
    ["same-owner archive refresh", sameOwnerArchiveRefreshRegression, "a held archive cannot overwrite a newer same-worktree list after refresh failure"],
    ["terminal exit during create", terminalExitWhileCreatingRegression, "an exit received while create is held remains exited in the tablist"],
    ["terminal exit during close", terminalExitWhileClosingRegression, "a held delete retains another terminal's exit"],
    ["late archive after owner switch", () => staleArchiveWorktreeRegression(false), "late A archive does not discard B's list response"],
    ["late archive and B retry", () => staleArchiveWorktreeRegression(true), "late A archive preserves B's retry after a failed list"],
    ["worktree chat list failure", chatFailedWorktreeListRegression, "a rejected list cannot expose old-owner chat tabs and a retry restores the new owner"],
    ["worktree terminal switch", terminalRace, "worktree switch removes old terminal tabs and rejects stale buffer responses"],
    ["terminal keyboard", terminalKeyboardRegression, "terminal keyboard switching retains focus and ignores non-tab controls"],
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
    ["command search", commandPaletteRegression, "command search keeps asynchronous results current and selectable"],
    ["changes loading", changesLoadingRegression, "changes pane waits for status before announcing a clean tree"],
    ["responsive focus", responsiveFocusRegression, "narrow drawer and inspector contain and restore focus", "responsive transition requires the CDP viewport bridge"],
    ["initial terminal failure", terminalInitialFailureRegression, "failed initial terminal activation retains a keyboard-reachable tab"],
    ["terminal mutation failure", terminalMutationFailureRegression, "create, close and reconnect failures preserve terminal tab ownership"],
    ["recovery actions", recoveryActionsRegression, "phone-width recovery decisions remain inside the viewport", "phone geometry requires a narrow viewport"],
  ];
  const startedAt = performance.now();
  window.__fixtureStartedAt = startedAt;
  let passed = 0;
  for (const [index, [step, run, success, skipped]] of steps.entries()) {
    const stepStartedAt = performance.now();
    window.__fixtureProgress = { step, completed: index, total: steps.length, stepStartedAt };
    const ran = await run();
    results.textContent += `${ran === false && skipped ? `SKIP: ${skipped}` : `PASS: ${success}`}\n`;
    if (ran !== false) passed += 1;
  }
  window.__fixtureProgress = { step: "complete", completed: steps.length, total: steps.length, stepStartedAt: performance.now() };
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
}
