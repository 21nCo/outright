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
window.fetch = async (input, options = {}) => {
  const url = new URL(input, location.origin);
  if (!url.pathname.startsWith("/api/")) throw new Error(`Unexpected test request: ${url}`);
  return route(url, options);
};
window.WebSocket = class extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
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
  await until(() => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Terminal A", "terminal A");
  [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Terminal A2").click();
  await until(() => bufferRequested, "pending second terminal buffer");
  holdLists = true;
  show(projects[1]);
  await settle();
  assert(!host.querySelector('[role="tab"]'), "Old worktree tabs remained selectable");
  assert(host.querySelector('[aria-label="New terminal"]').disabled, "Terminal controls enabled before reconciliation");
  delayedList.resolve(response({ terminals: [terminal("A"), terminal("B")] }));
  await until(() => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Terminal B", "terminal B");
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
  await until(() => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Terminal A", "keyboard terminal A");
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
  await until(() => second.getAttribute("aria-selected") === "true", "keyboard terminal A2 activation");
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
  await until(() => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Terminal A", "rejection fixture terminal A");
  const first = [...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === "Terminal A");
  first.focus();
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
  await until(() => document.activeElement?.textContent === "Terminal A2", "pending rejected terminal");
  pending.reject(new Error("Buffer failed"));
  await until(() => errors.length === 1 && host.querySelector('.terminal-tabs[aria-busy="false"]'), "rejected terminal response");
  assert(host.querySelector('[role="tab"][aria-selected="true"]') === first && first.tabIndex === 0, "Failed terminal switch changed selection");
  assert(document.activeElement === first, "Failed terminal switch left focus on an unselected tab");
}

async function terminalInitialFailureRegression() {
  root.render(null);
  await settle();
  const errors = [];
  route = async (url) => {
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A"), terminal("A2")] });
    if (url.pathname === "/api/terminals/term-A") return response({ error: "Buffer failed" }, 500);
    return response({ buffer: "" });
  };
  root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={null} onError={(error) => errors.push(error)} sendRuntime={() => {}} />);
  await until(() => errors.length === 1 && host.querySelector('.terminal-tabs[aria-busy="false"]'), "initial terminal buffer rejection");
  assert(host.querySelectorAll('[role="tab"]').length === 2, "Fixture lost existing terminal tabs");
  assert(host.querySelectorAll('[role="tab"][tabindex="0"]').length === 1, "Buffer failure left no keyboard-reachable terminal tab");
}

async function terminalMutationFailureRegression() {
  root.render(null);
  await settle();
  const errors = [];
  const onError = (error) => errors.push(error);
  let failure = "";
  route = async (url, options) => {
    if (url.pathname === "/api/terminals" && options.method === "POST" && failure === "create") return response({ error: "Create failed" }, 500);
    if (url.pathname === "/api/terminals" && options.method === "POST") return response(terminal("A3"));
    if (url.pathname === "/api/terminals") return response({ terminals: [terminal("A"), terminal("A2")] });
    if (url.pathname === "/api/terminals/term-A" && options.method === "DELETE" && failure === "delete") return response({ error: "Delete failed" }, 500);
    if (url.pathname === "/api/terminals/term-A2" && failure === "replacement-buffer") return response({ error: "Buffer failed" }, 500);
    if (url.pathname === "/api/terminals/term-A" && failure === "reconnect-buffer") return response({ error: "Reconnect failed" }, 500);
    return response({ buffer: "" });
  };
  const show = (runtimeEvent = null) => root.render(<TerminalPane worktree={projects[0].worktrees[0]} runtimeEvent={runtimeEvent} onError={onError} sendRuntime={() => {}} />);
  show();
  await until(() => host.querySelector('[role="tab"][aria-selected="true"]')?.textContent === "Terminal A", "mutation fixture terminal A");
  const selected = () => host.querySelector('[role="tab"][aria-selected="true"][tabindex="0"]');
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
    await until(() => sidebar.contains(document.activeElement), "project drawer focus");
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
  await chatRace(false, false);
  results.textContent = "PASS: sending in the current conversation shows its run\n";
  await chatRace(false);
  results.textContent += "PASS: delayed send cannot attach A's run to B\n";
  await chatRace(true);
  results.textContent += "PASS: delayed trust response cannot target another conversation\n";
  await chatTabControlRegression();
  results.textContent += "PASS: chat tab navigation ignores nested archive controls\n";
  await terminalRace();
  results.textContent += "PASS: worktree switch removes old terminal tabs and rejects stale buffer responses\n";
  await terminalKeyboardRegression();
  results.textContent += "PASS: terminal keyboard switching retains focus and ignores non-tab controls\n";
  await terminalRejectedSwitchRegression();
  results.textContent += "PASS: rejected terminal switch restores the selected tab focus\n";
  await commandPaletteRegression();
  results.textContent += "PASS: command search keeps asynchronous results current and selectable\n";
  await changesLoadingRegression();
  results.textContent += "PASS: changes pane waits for status before announcing a clean tree\n";
  const responsiveRan = await responsiveFocusRegression();
  results.textContent += responsiveRan ? "PASS: narrow drawer and inspector contain and restore focus\n" : "SKIP: responsive transition requires the CDP viewport bridge\n";
  await terminalInitialFailureRegression();
  results.textContent += "PASS: failed initial terminal activation retains a keyboard-reachable tab\n";
  await terminalMutationFailureRegression();
  results.textContent += "PASS: create, close and reconnect failures preserve terminal tab ownership\n";
  const phoneRan = await recoveryActionsRegression();
  results.textContent += phoneRan ? "PASS: phone-width recovery decisions remain inside the viewport\n" : "SKIP: phone geometry requires a narrow viewport\n";
  results.textContent += `${11 + Number(responsiveRan) + Number(phoneRan)} interaction regressions passed`;
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
