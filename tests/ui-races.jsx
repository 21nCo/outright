// Open /tests/ui-races.html on the local Vite server. All API and socket traffic
// is replaced in this page; no real project, conversation or terminal is changed.
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.jsx";
import { ChangesPane } from "../src/components/ChangesPane.jsx";
import { WindowedMessages } from "../src/components/WindowedMessages.jsx";
import { WindowedDiff } from "../src/components/WindowedDiff.jsx";
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
  await settle();
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
  const pane = (event) => <div className="inspector-body" style={{ width: 448, height: 600 }}><ChangesPane worktree={tree} runtimeEvent={event} settings={{ editor: "code" }} onError={(error) => { throw error; }} onToast={() => {}} /></div>;
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
  root.render(pane(event)); await settle();
  const statusCount = requests.filter((item) => item.startsWith("/api/git/status")).length;
  root.render(pane(event)); await settle();
  assert(requests.filter((item) => item.startsWith("/api/git/status")).length === statusCount, "Retained completion event retriggered status on selection rerender");
  host.querySelector('[aria-label="Unstage b.txt"]').click();
  await until(() => requests.some((item) => item.startsWith("/api/git/unstage")), "same-worktree mutation pending");
  [...host.querySelectorAll('.change-file-select')].find((button) => button.textContent.includes("a.txt")).click();
  host.querySelector('.diff-mode button').click();
  pendingMutation.resolve(response({ ok: true }));
  await settle();
  assert(host.querySelector('.change-file.is-active')?.textContent.includes("a.txt") && host.querySelector('.diff-view')?.textContent.includes("a.txt:false"), "Mutation follow-up restored the previous file or mode");
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
  root.render(<div className="inspector-body" style={{ width: 448, height: 600 }}><ChangesPane worktree={projects[0].worktrees[0]} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => errors.push(error.message)} onToast={() => {}} /></div>);
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
  const pane = (event) => <div className="inspector-body" style={{ width: 448, height: 600 }}><ChangesPane worktree={tree} runtimeEvent={event} settings={{ editor: "code" }} onError={(error) => errors.push(error.message)} onToast={() => {}} /></div>;
  root.render(pane(null));
  await until(() => host.querySelector(".diff-view")?.textContent.includes("line 0"), "large diff ready");
  const viewport = host.querySelector(".diff-view");
  const find = host.querySelector('input[aria-label="Find in diff"]');
  setControlValue(find, "line 2500");
  find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => viewport.querySelector('[data-find-match="true"]')?.textContent.includes("2500"), "large diff find");
  const anchor = viewport.scrollTop;
  hold = true;
  root.render(pane({ type: "projects.changed" }));
  await until(() => pending.length === 1, "background diff refresh pending");
  assert(viewport.textContent.includes("line 2500") && viewport.querySelector('[data-find-match="true"]'), "Background refresh erased the reader's diff or find");
  assert(Math.abs(viewport.scrollTop - anchor) < 24, "Background refresh moved the diff anchor before its response");
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
  const pane = (tree) => <div className="inspector-body" style={{ width: 448, height: 600 }}><ChangesPane worktree={tree} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => errors.push(error.message)} onToast={() => {}} /></div>;
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
  const pane = (tree) => <div className="inspector-body" style={{ width: 448, height: 600 }}><ChangesPane worktree={tree} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => errors.push(error.message)} onToast={(message) => toasts.push(message)} /></div>;
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
  root.render(<div className="inspector-body" style={{ width: 448, height: 600 }}><ChangesPane worktree={projects[0].worktrees[0]} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => { throw error; }} onToast={() => {}} /></div>);
  await until(() => host.querySelector('.diff-view')?.textContent.includes("-unstaged 0"), "initial production diff");
  host.querySelector('[aria-label="Diff view"] button[aria-pressed="false"]').click();
  await until(() => host.querySelector('.diff-view')?.textContent.includes("+staged 0"), "staged production diff");
  let viewport = host.querySelector('.diff-view');
  assert(viewport.clientHeight > 0 && viewport.clientHeight < 600, `Production diff viewport grew to ${viewport.clientHeight}px`);
  assert(viewport.querySelectorAll("span").length < 200, "Production diff mounted all staged lines");
  if (window.__fixtureWheel) {
    viewport.scrollIntoView({ block: "center" });
    await frame();
    const bounds = viewport.getBoundingClientRect();
    for (let step = 0; step < 8 && viewport.scrollTop < viewport.scrollHeight - viewport.clientHeight; step += 1) {
      await window.__fixtureWheel(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2, 120_000);
      await frame();
    }
  } else { viewport.scrollTop = viewport.scrollHeight; viewport.dispatchEvent(new Event("scroll")); }
  try { await until(() => viewport.textContent.includes("staged 49999"), "staged final line"); }
  catch (error) { throw new Error(`${error.message}; scroll=${viewport.scrollTop}/${viewport.scrollHeight - viewport.clientHeight}`); }
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
  await until(() => viewport.textContent.includes("unstaged 25000"), "offscreen diff match");
  assert(viewport.querySelector('[data-find-match="true"]')?.textContent.includes("unstaged 25000"), "Found diff line was not marked");
  assert(viewport.querySelectorAll("span").length < 200, "Finding a diff match mounted all lines");
  root.render(<div className="inspector-body" style={{ width: 320, height: 480 }}><ChangesPane worktree={projects[0].worktrees[0]} runtimeEvent={null} settings={{ editor: "code" }} onError={(error) => { throw error; }} onToast={() => {}} /></div>);
  await settle();
  assert(host.querySelector('.diff-view').clientHeight > 0 && host.querySelector('.diff-view').clientHeight < 480, "Narrow inspector lost its bounded diff viewport");
  assert(host.querySelector('.diff-view').querySelectorAll("span").length < 200, "Narrow inspector mounted all diff lines");
}

async function longTranscriptWindowRegression() {
  root.render(null);
  await settle();
  const messages = Array.from({ length: 1_000 }, (_, index) => ({ id: `message-${index}`, body: `Message ${index}` }));
  const viewport = React.createRef();
  const started = performance.now();
  root.render(<div ref={viewport} style={{ height: 420, overflowY: "auto" }} tabIndex={0} aria-label="Long conversation fixture"><WindowedMessages messages={messages} viewportRef={viewport} renderMessage={(message) => <article data-message-id={message.id} style={{ minHeight: 80, marginBottom: 30 }}>{message.body}</article>} /></div>);
  await until(() => host.querySelectorAll('[role="listitem"]').length > 0 && host.querySelectorAll('[role="listitem"]').length < 40, "bounded initial transcript DOM");
  const initialCount = host.querySelectorAll('[role="listitem"]').length;
  viewport.current.scrollTop = viewport.current.scrollHeight;
  viewport.current.dispatchEvent(new Event("scroll"));
  try { await until(() => host.querySelector('[data-message-id="message-999"]'), "last message after long scroll"); }
  catch (error) { throw new Error(`${error.message}; scroll=${viewport.current.scrollTop}/${viewport.current.scrollHeight}, rows=${[...host.querySelectorAll('[data-message-id]')].map((row) => row.dataset.messageId).join(",")}`); }
  assert(host.querySelectorAll('[role="listitem"]').length < 40, "Long scroll mounted the whole transcript");
  viewport.current.scrollTop = 0;
  viewport.current.dispatchEvent(new Event("scroll"));
  await until(() => host.querySelector('[data-message-id="message-0"]'), "first message after return scroll");
  const find = host.querySelector('input[aria-label="Find in conversation"]');
  setControlValue(find, "Message 999");
  await settle();
  find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  try { await until(() => host.querySelector('[data-find-match="true"] [data-message-id="message-999"]'), "last offscreen message found"); }
  catch (error) { throw new Error(`${error.message}; status=${host.querySelector('.history-find [role="status"]')?.textContent}; scroll=${viewport.current.scrollTop}/${viewport.current.scrollHeight}; rows=${[...host.querySelectorAll('[data-message-id]')].map((row) => row.dataset.messageId).join(",")}`); }
  setControlValue(find, "Message 0");
  await settle();
  find.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="message-0"]'), "first offscreen message found");
  assert(host.querySelectorAll('[role="listitem"]').length < 40, "Finding offscreen messages mounted the full transcript");
  assert(document.activeElement !== viewport.current || viewport.current.tabIndex === 0, "Transcript lost keyboard scroll access");
  const elapsedMs = Math.round(performance.now() - started);
  assert(elapsedMs < 1_000, `Long transcript navigation exceeded its 1s fixture budget: ${elapsedMs}ms`);
  window.__performanceEvidence = { ...(window.__performanceEvidence ?? {}), transcript: { elapsedMs, mountedAtStart: initialCount, heapBytes: performance.memory?.usedJSHeapSize ?? null } };
}

async function variableHeightFindAnchorRegression() {
  root.render(null); await settle();
  const viewport = React.createRef();
  const messages = Array.from({ length: 200 }, (_, index) => ({ id: `variable-${index}`, body: `Variable ${index}`, height: index % 3 === 0 ? 360 : 54 }));
  const render = (rows) => <div><div ref={viewport} style={{ height: 420, overflowY: "auto" }} tabIndex={0}><WindowedMessages messages={rows} viewportRef={viewport} onFind={(query) => `variable-${Number(query)}`} renderMessage={(message) => <article data-message-id={message.id} style={{ height: message.height }}>{message.body}</article>} /></div><div data-slot="scroll-area-scrollbar" /></div>;
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
  viewport.current.style.height = "720px";
  await settle(); await settle();
  assert(visible(), "Growing the viewport lost the found message beyond the old overscan");
  viewport.current.style.height = "300px";
  await settle(); await settle();
  assert(visible(), "Viewport resize lost the found message");
  viewport.current.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
  viewport.current.scrollTop = 0; viewport.current.dispatchEvent(new Event("scroll"));
  await settle();
  root.render(render([...messages, { id: "variable-200", body: "new", height: 360 }]));
  await settle();
  assert(viewport.current.scrollTop < 50, "Live append snapped back to an old find target after user scrolling");
  for (const index of [0, 200]) {
    setControlValue(input, String(index)); await settle();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await until(() => host.querySelector(`[data-find-match="true"] [data-message-id="variable-${index}"]`), `edge match ${index}`);
    for (let frameIndex = 0; frameIndex < 20; frameIndex += 1) await frame();
    viewport.current.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    viewport.current.scrollTop = index === 0 ? 700 : 0;
    viewport.current.dispatchEvent(new Event("scroll"));
    await settle(); await settle();
    assert(index === 0 ? viewport.current.scrollTop > 500 : viewport.current.scrollTop < 50, `Edge match ${index} kept snapping the reader back`);
  }
  setControlValue(input, "100"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="variable-100"]'), "thumb cancellation target");
  host.querySelector('[data-slot="scroll-area-scrollbar"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  viewport.current.scrollTop = 0; viewport.current.dispatchEvent(new Event("scroll"));
  await settle(); await settle();
  assert(viewport.current.scrollTop < 50, "Scrollbar thumb interaction lost the reader's scroll position");
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
  assert(elapsedMs < 1_000, `Large diff navigation exceeded its 1s fixture budget: ${elapsedMs}ms`);
  window.__performanceEvidence = { ...(window.__performanceEvidence ?? {}), diff: { elapsedMs, mountedAtEnd: viewport.querySelectorAll("span").length, heapBytes: performance.memory?.usedJSHeapSize ?? null } };
}

async function unicodeDiffFindRegression() {
  root.render(null); await settle();
  const diff = "+İstanbul\n" + Array.from({ length: 400 }, (_, index) => `+filler ${index}\n`).join("") + "+CAFÉ target\n";
  root.render(<div style={{ display: "grid", gridTemplateRows: "minmax(0, 1fr)", height: 420 }}><WindowedDiff diff={diff} label="Unicode diff" /></div>);
  await until(() => host.querySelector('input[aria-label="Find in diff"]'), "Unicode diff find ready");
  const input = host.querySelector('input[aria-label="Find in diff"]');
  setControlValue(input, "café"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('.diff-view [data-find-match="true"]')?.textContent.includes("CAFÉ target"), "Unicode match on the correct diff line");
  assert(host.querySelector('.window-find [role="status"]')?.textContent === "Line 402", "Unicode case folding shifted the diff line coordinate");
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
  for (let index = 0; index < 16; index += 1) {
    const id = index % 2 ? "W0" : "W199";
    const target = [...host.querySelectorAll(".worktree-row")].find((row) => row.textContent.includes(`Tree ${Number(id.slice(1))}`));
    assert(target, `Missing ${id} in worktree navigation`);
    target.click();
    await until(() => host.querySelector(`#chat-tab-chat-${id}[aria-selected="true"]`) && host.querySelector(`[data-message-id="message-${id}"]`), `selected ${id} chat`);
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
  assert(elapsedMs < 6_000 && inputFrameMs < 250, `Many-worktree interaction exceeded its fixture budget: navigation ${elapsedMs}ms, input ${inputFrameMs}ms`);
  if (heapBefore !== null && heapAfter !== null) assert(heapAfter - heapBefore < 64 * 1024 * 1024, "Repeated worktree switches grew the heap without bound");
  window.__performanceEvidence = { ...(window.__performanceEvidence ?? {}), worktrees: { count: 200, switches: 16, elapsedMs, inputFrameMs, heapBefore, heapAtHalf, heapAfter } };
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
  viewport.scrollTop = 0;
  viewport.dispatchEvent(new Event("scroll"));
  await until(() => host.querySelector('[data-message-id="message-1000"]'), "first anchor visible");
  await settle();
  const before = host.querySelector('[data-message-id="message-1000"]').getBoundingClientRect().top;
  host.querySelector('.history-loader').click();
  try { await until(() => host.querySelector('.history-loader')?.textContent.includes("800") && host.querySelector('[data-message-id="message-1000"]'), "paged anchor restored"); }
  catch (error) { throw new Error(`${error.message}; loader=${host.querySelector('.history-loader')?.textContent}, scroll=${viewport.scrollTop}/${viewport.scrollHeight}, rows=${[...host.querySelectorAll('[data-message-id]')].map((item) => item.dataset.messageId).join(",")}`); }
  await settle();
  const anchor = host.querySelector('[data-message-id="message-1000"]');
  assert(anchor && Math.abs(anchor.getBoundingClientRect().top - before) < 10, `Loading earlier messages moved the reading anchor by ${anchor ? Math.round(anchor.getBoundingClientRect().top - before) : "missing"}px`);
  assert(host.querySelectorAll('[role="listitem"]').length < 40, "Paged transcript mounted too many messages");
}

async function pagedTranscriptFindRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const message = (index) => ({ id: `message-${index}`, role: "assistant", kind: "text", body: index === 10 || index === 900 ? `Needle ${index}` : `Other ${index}`, createdAt: new Date(index * 1_000).toISOString() });
  const latest = Array.from({ length: 200 }, (_, index) => message(index + 800));
  const earliest = Array.from({ length: 200 }, (_, index) => message(index));
  const staleSearch = deferred();
  const lateSearch = deferred();
  const olderRequest = deferred();
  let staleRequested = false;
  let lateRequested = false;
  let olderRequested = false;
  let olderRequests = 0;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname.endsWith("/messages/find")) {
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
  catch (error) { throw new Error(`${error.message}; status=${host.querySelector('.history-find [role="status"]')?.textContent}, scroll=${host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]')?.scrollTop}, rows=${[...host.querySelectorAll('[data-message-id]')].map((item) => item.dataset.messageId).slice(0, 4).join(',')}`); }
  await settle();
  const foundRow = host.querySelector('[data-find-match="true"]');
  const foundViewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
  assert(foundRow && foundRow.getBoundingClientRect().top < foundViewport.getBoundingClientRect().bottom && foundRow.getBoundingClientRect().bottom > foundViewport.getBoundingClientRect().top, `Initial found row was mounted but not visible: scroll=${foundViewport.scrollTop}, row=${foundRow?.getBoundingClientRect().top}`);
  assert(host.querySelectorAll('[role="listitem"]').length < 40, "Old search match mounted all history");
  assert(host.querySelector('.history-find [role="status"]')?.textContent === "Message 11 of 1000", "Old match announced its page-local index");
  assert(foundRow.getAttribute("aria-posinset") === "11" && foundRow.getAttribute("aria-setsize") === "1000", "Old match advertised a page-local list size");
  assert(host.querySelector('.history-return'), "An older search page lost return-to-latest navigation");
  for (const type of ["run.completed", "run.failed", "run.stopped"]) {
    fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", conversationId: "chat-A", runId: `run-${type}`, payload: { type } }) }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await settle();
    assert(host.querySelector('.history-return') && host.querySelector('[data-find-match="true"] [data-message-id="message-10"]'), `${type} replaced the chosen history page or find highlight: return=${Boolean(host.querySelector('.history-return'))}, match=${host.querySelector('[data-find-match="true"] [data-message-id]')?.dataset.messageId}, status=${host.querySelector('.history-find [role="status"]')?.textContent}, scroll=${host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]')?.scrollTop}, rows=${[...host.querySelectorAll('[data-message-id]')].map((item) => item.dataset.messageId).slice(0, 3).join(',')}`);
  }
  host.querySelector('[aria-label="Next conversation match"]').click();
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="message-900"]'), "newer persisted match");
  assert(host.querySelector('.history-find [role="status"]')?.textContent === "Message 901 of 1000", "New match announced its page-local index");
  const viewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
  input.focus();
  const bounds = input.getBoundingClientRect();
  const visible = viewport.getBoundingClientRect();
  assert(document.activeElement === input && bounds.top >= visible.top && bounds.bottom <= visible.bottom, "Focused find control scrolled out of the transcript viewport");
  viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
  viewport.scrollTop = Math.max(0, viewport.scrollTop - 350);
  viewport.dispatchEvent(new Event("scroll"));
  await settle();
  const readingTop = viewport.scrollTop;
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(1_000) }) }));
  await settle();
  assert(Math.abs(viewport.scrollTop - readingTop) < 24, `A live append moved the reading position: before=${readingTop}, after=${viewport.scrollTop}, height=${viewport.scrollHeight}, sticky=${host.querySelector('.history-find [role="status"]')?.textContent}`);
  host.querySelector('[aria-label="Previous conversation match"]').click();
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="message-10"]'), "previous persisted match");
  assert(document.activeElement === input && input.getBoundingClientRect().top >= visible.top, "Find control disappeared during previous navigation");
  host.querySelector('[aria-label="Next conversation match"]').click();
  await until(() => host.querySelector('[data-find-match="true"] [data-message-id="message-900"]'), "next persisted match");
  setControlValue(input, "stale"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => staleRequested, "stale search request pending");
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
  await until(() => host.querySelector('.history-loader')?.textContent.includes("800"), "return to latest completed");
  assert(!host.querySelector('[data-find-match="true"]'), "Return to latest kept a stale match highlight");
  lateSearch.resolve(response({ matchId: "message-10", messages: earliest, messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 800, total: 1_000, beforeId: "message-0" } }));
  await settle();
  assert(!host.querySelector('.history-return'), "A late find replaced Return to latest");
  assert(host.querySelector('.history-find [role="status"]')?.textContent !== "No match", "A cancelled find announced a false miss");
  host.querySelector('.history-loader').click();
  await until(() => olderRequested, "older page request pending");
  setControlValue(input, "none"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('.history-find [role="status"]')?.textContent === "No match", "no-match search completed");
  olderRequest.resolve(response({ messages: earliest, messagePage: { hasMore: false, olderCount: 0, total: 1_000, beforeId: "message-0" } }));
  await settle();
  assert(host.querySelector('.history-loader')?.textContent.includes("800"), "Stale prepend replaced the selected page");
  setControlValue(input, "failure"); await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => host.querySelector('.history-find [role="status"]')?.textContent === "Search failed; retry", "find failure reported");
  assert(host.querySelector('.history-loader')?.textContent.includes("800"), "Failed find replaced the current page");
  host.querySelector('.history-loader').click();
  await until(() => host.textContent.includes("Older page unavailable"), "failed prepend reported");
  viewport.scrollTop = viewport.scrollHeight; viewport.dispatchEvent(new Event("scroll")); await settle();
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(1_001) }) }));
  await settle();
  const bottomDeadline = performance.now() + 250;
  while (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop >= 96 && performance.now() < bottomDeadline) await frame();
  assert(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 96, `Stale prepend disabled bottom following: top=${viewport.scrollTop}, height=${viewport.scrollHeight}, client=${viewport.clientHeight}, return=${host.querySelector('.history-return')?.textContent}, loader=${host.querySelector('.history-loader')?.textContent}`);
}

async function backgroundLatestRefreshRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const first = { id: "fresh-1", role: "assistant", kind: "text", body: "First persisted output", createdAt: "2026-09-26T00:00:00Z" };
  let messages = [first];
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects, projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex", approvalPolicy: "read-only" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, messages, messagePage: { hasMore: false, olderCount: 0, total: messages.length, beforeId: messages[0].id } });
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('[data-message-id="fresh-1"]'), "initial latest page");
  messages = [...messages, { ...first, id: "fresh-2", body: "Recovered missed output" }];
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
    assert(host.querySelectorAll('[role="listitem"]').length < 40, "Forward paging mounted the full transcript");
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
  await until(() => host.querySelector('[data-message-id="reading-199"]'), "reading page loaded");
  const viewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
  const scrollAway = async () => {
    viewport.scrollTop = viewport.scrollHeight;
    viewport.dispatchEvent(new Event("scroll"));
    await settle();
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
  const message = (index) => ({ id: `full-${index}`, role: "assistant", kind: "text", body: `Output ${index}`, createdAt: new Date(index * 1000).toISOString() });
  let all = Array.from({ length: 1000 }, (_, index) => message(index));
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response({ ...chats.A, messages: all.slice(-1000), messagePage: { hasMore: all.length > 1000, olderCount: Math.max(0, all.length - 1000), total: all.length, beforeId: all.at(-1000).id } });
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('.history-find input'), "full page ready");
  const viewport = host.querySelector('.message-scroll [data-slot="scroll-area-viewport"]');
  viewport.scrollTop = viewport.scrollHeight; viewport.dispatchEvent(new Event("scroll")); await settle();
  viewport.scrollTop = 0; viewport.dispatchEvent(new Event("scroll"));
  await until(() => host.querySelector('[data-message-id="full-0"]'), "first row while reading full page");
  const anchorTop = host.querySelector('[data-message-id="full-0"]').getBoundingClientRect().top;
  all = [...all, message(1000)];
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(1000) }) }));
  await until(() => host.querySelector('.history-return')?.textContent.includes("1 new"), "new row offered after full-page append");
  assert(host.querySelector('[data-message-id="full-0"]') && Math.abs(host.querySelector('[data-message-id="full-0"]').getBoundingClientRect().top - anchorTop) < 24, "A full-page live append evicted the reader's anchor");
  host.querySelector('.history-return').click();
  await until(() => !host.querySelector('.history-return'), "explicit latest after full-page append");
  viewport.scrollTop = viewport.scrollHeight; viewport.dispatchEvent(new Event("scroll"));
  await until(() => host.querySelector('[data-message-id="full-1000"]'), "new durable row available at latest");
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

async function checkpointReadingPageRegression() {
  root.render(null); await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const message = (index, body = `Output ${index}`, seq = 0) => ({ id: `checkpoint-${index}`, role: "assistant", kind: "text", body,
    payload: index === 999 ? { runId: "run-checkpoint", checkpointEventSeq: seq } : {}, createdAt: new Date(index * 1000).toISOString() });
  const older = Array.from({ length: 200 }, (_, index) => message(index));
  let latest = Array.from({ length: 200 }, (_, index) => message(index + 800));
  let persistedTotal = 1000;
  let reads = 0;
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", available: true }], templates: [], trustedProjects: [] });
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A/messages/count") return response({ total: persistedTotal });
    if (url.pathname.endsWith("/messages/find")) return response({ matchId: "checkpoint-10", messages: older, messagePage: { hasMore: false, olderCount: 0, hasLater: true, newerCount: 800, total: 1000, beforeId: "checkpoint-0" } });
    if (url.pathname === "/api/conversations/chat-A") { reads += 1; return response({ ...chats.A, messages: latest, messagePage: { hasMore: true, olderCount: persistedTotal - latest.length, total: persistedTotal, beforeId: latest[0].id } }); }
    return response({});
  };
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => host.querySelector('[data-message-id="checkpoint-999"]'), "checkpoint latest loaded");
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
  assert(host.querySelector('.history-find [role="status"]')?.textContent === "Message 11 of 1000", "An old off-page checkpoint inflated the persisted count");
  for (let seq = 6; seq <= 8; seq += 1) {
    const updated = message(999, `Checkpoint ${seq}`, seq);
    latest = latest.map((item) => item.id === updated.id ? updated : item);
    fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: updated }) }));
  }
  await settle();
  assert(host.querySelector('.history-return')?.textContent === "Return to latest · 800 new", `Off-page checkpoint rewrites inflated the new-message count: ${host.querySelector('.history-return')?.textContent}`);
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "run.event", conversationId: "chat-A", runId: "run-checkpoint", payload: { type: "run.completed" } }) }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  await until(() => reads >= 3, "checkpoint completion read");
  assert(host.querySelector('.history-return')?.textContent === "Return to latest · 800 new", "Persisted total failed to reconcile after checkpoint completion");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.updated", conversationId: "chat-A" }) }));
  await until(() => reads >= 4, "list update detail read");
  assert(host.querySelector('[data-message-id="checkpoint-10"]') && host.querySelector('.history-return')?.textContent === "Return to latest · 800 new", "List update replaced the reader's older page");
  for (let index = 1000; index <= 1002; index += 1) {
    persistedTotal += 1;
    latest = [...latest, message(index)].slice(-200);
    fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(index) }) }));
  }
  await until(() => host.querySelector('.history-return')?.textContent === "Return to latest · 803 new", "three durable new ids counted after old page");
  latest = latest.map((item) => item.id === "checkpoint-999" ? message(999, "Repeated checkpoint", 9) : item);
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "message.created", conversationId: "chat-A", payload: message(999, "Repeated checkpoint", 9) }) }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(host.querySelector('.history-return')?.textContent === "Return to latest · 803 new", "Repeated off-page checkpoint inflated the live count");
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
  assert(host.querySelector('[data-message-id="race-10"]'), "Find lost its match after a live event");
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
  route = async (url) => {
    if (url.pathname === "/api/bootstrap") return bootstrap.promise;
    if (url.pathname === "/api/providers") { providerReads += 1; return response({ providers: [{ id: "codex", label: "Codex", available: true, checking: false }] }); }
    if (url.pathname === "/api/conversations") return response({ conversations: [chats.A] });
    if (url.pathname === "/api/conversations/chat-A") return response(chats.A);
    return response({});
  };
  const socketCount = fixtureSockets.length;
  root.render(<TooltipProvider><App /></TooltipProvider>);
  await until(() => fixtureSockets.length > socketCount, "socket before bootstrap");
  fixtureSockets.at(-1).dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "providers.changed", payload: { providers: [{ id: "codex", available: true, checking: false }] } }) }));
  bootstrap.resolve(response({ projects: [projects[0]], projectGroups: { groups: [], memberships: {} }, settings: { provider: "codex" }, providers: [{ id: "codex", label: "Codex", available: false, checking: true }], templates: [], trustedProjects: [] }));
  await until(() => host.querySelector('[aria-label="Settings"]'), "settings after checking bootstrap");
  host.querySelector('[aria-label="Settings"]').click();
  await until(() => document.querySelector('[role="dialog"] option[value="codex"]')?.disabled === false, "provider converged after missed event");
  assert(providerReads > 0, "Checking bootstrap did not refresh providers");
  document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click();
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
  await new Promise((resolve) => setTimeout(resolve, 1150));
  assert(providerReads <= 2, `Checking provider polled ${providerReads} times in 1.15s`);
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
  for (let seq = 2; seq <= 201; seq += 1) {
    sendDelta(seq);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await until(() => text.textContent.length === 201 * 256, "sustained output complete");
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
  await settle();
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


try {
  const steps = [
    ["current conversation send", () => chatRace(false, false), "sending in the current conversation shows its run"],
    ["delayed send", () => chatRace(false), "delayed send cannot attach A's run to B"],
    ["delayed trust response", () => chatRace(true), "delayed trust response cannot target another conversation"],
    ["same-worktree chat selection", sameWorktreeChatSelectionRegression, "click, keyboard and created-chat selection load only the selected detail and fence sends"],
    ["chat tab controls", chatTabControlRegression, "chat tab navigation ignores nested archive controls"],
    ["settings chat archive", chatSettingsArchiveRegression, "settings archive retains a selected, keyboard-reachable sibling chat"],
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
    ["stale diff selection", staleDiffSelectionRegression, "a slow prior diff cannot replace the selected file"],
    ["changes refresh selection", changesSelectionRefreshRegression, "pending refreshes preserve current file and mode and retained events refresh once"],
    ["changes diff failure ownership", changesDiffFailureOwnershipRegression, "pending and failed file or mode requests never display a previous diff"],
    ["diff refresh anchor", diffRefreshAnchorRegression, "same-selection refresh keeps the visible diff line and find through success and failure"],
    ["changes mutation owner success", () => changesMutationOwnerRegression(false), "late stage completion cannot refresh another worktree"],
    ["changes mutation owner failure", () => changesMutationOwnerRegression(true), "late stage failure cannot report in another worktree"],
    ["changes unstage owner failure", () => changesMutationOwnerRegression(true, "unstage"), "late unstage failure cannot report in another worktree"],
    ["changes commit owner success", () => changesCommitOwnerRegression(false), "late commit completion cannot update another worktree"],
    ["changes commit owner failure", () => changesCommitOwnerRegression(true), "late commit failure cannot report in another worktree"],
    ["long transcript window", longTranscriptWindowRegression, "a thousand messages keep a bounded DOM and remain scrollable"],
    ["variable-height find anchor", variableHeightFindAnchorRegression, "measured tall messages keep a found row visible through resize and live append"],
    ["large diff window", largeDiffWindowRegression, "fifty thousand diff lines keep a bounded DOM and preserve the last line"],
    ["Unicode diff find", unicodeDiffFindRegression, "length-changing case folding keeps the correct diff line"],
    ["production diff viewport", productionDiffViewportRegression, "staged and unstaged large diffs stay bounded in the inspector"],
    ["paged transcript anchor", pagedTranscriptAnchorRegression, "loading earlier history preserves its visible reading anchor"],
    ["paged transcript find", pagedTranscriptFindRegression, "find navigates older persisted messages with bounded mounted rows"],
    ["forward history paging", forwardHistoryPagingRegression, "an old page can be read continuously through the persisted end within the 1000-row cap"],
    ["background latest refresh", backgroundLatestRefreshRegression, "a missed event refreshes the latest page without keeping a stale snapshot"],
    ["background reading refresh", backgroundReadingRefreshRegression, "missed replay and completion expose later output without moving a reader"],
    ["full-page live anchor", fullPageLiveAnchorRegression, "a new row at the 1000-message cap keeps the reader's oldest visible anchor"],
    ["background completion page ownership", backgroundCompletionKeepsExplicitPageRegression, "run completion cannot supersede an explicit Return to latest request"],
    ["latest before find ownership", latestBeforeFindOwnershipRegression, "an older Return to latest response cannot supersede a newer find"],
    ["checkpoint reading page", checkpointReadingPageRegression, "reconnect, completion and list updates retain a reading page and unique checkpoint counts"],
    ["find in-flight event", findInFlightEventRegression, "an event during find remains reachable when the returned page claims to be latest"],
    ["typing during prepend", typingDuringPrependRegression, "editing a find query does not silently cancel an earlier-page request"],
    ["provider bootstrap convergence", providerBootstrapConvergenceRegression, "a checking bootstrap converges after an earlier provider event"],
    ["provider checking rate", providerCheckingRateRegression, "repeated checking snapshots keep a bounded poll cadence"],
    ["sustained output", sustainedOutputRegression, "small deltas coalesce without losing output or input responsiveness"],
    ["many worktree sessions", manyWorktreeSessionRegression, "two repeated switch cycles across two hundred worktrees keep one conversation mounted"],
    ["responsive focus", responsiveFocusRegression, "narrow drawer and inspector contain and restore focus", "responsive transition requires the CDP viewport bridge"],
    ["initial terminal failure", terminalInitialFailureRegression, "failed initial terminal activation retains a keyboard-reachable tab"],
    ["terminal mutation failure", terminalMutationFailureRegression, "create, close and reconnect failures preserve terminal tab ownership"],
    ["recovery actions", recoveryActionsRegression, "phone-width recovery decisions remain inside the viewport", "phone geometry requires a narrow viewport"],
  ];
  const selectedStep = new URLSearchParams(location.search).get("only");
  const selectedSteps = selectedStep ? steps.filter(([name]) => name === selectedStep) : steps;
  if (!selectedSteps.length) throw new Error(`Unknown interaction fixture: ${selectedStep}`);
  const startedAt = performance.now();
  window.__fixtureStartedAt = startedAt;
  let passed = 0;
  for (const [index, [step, run, success, skipped]] of selectedSteps.entries()) {
    const stepStartedAt = performance.now();
    window.__fixtureProgress = { step, completed: index, total: selectedSteps.length, stepStartedAt };
    const ran = await run();
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
}
