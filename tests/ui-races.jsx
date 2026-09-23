// Open /tests/ui-races.html on the local Vite server. All API and socket traffic
// is replaced in this page; no real project, conversation or terminal is changed.
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.jsx";
import { TerminalPane } from "../src/components/TerminalPane.jsx";
import { TooltipProvider } from "../src/components/ui/tooltip.jsx";
import "../src/styles.css";

const host = document.getElementById("root");
const results = document.getElementById("results");
const root = createRoot(host);
const originalFetch = window.fetch;
const OriginalSocket = window.WebSocket;
const originalMatchMedia = window.matchMedia.bind(window);
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
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
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
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, "Delayed response regression");
  input.dispatchEvent(new Event("input", { bubbles: true }));
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

async function responsiveFocusRegression() {
  root.render(null);
  await settle();
  keys.forEach((key, index) => localStorage.setItem(key, index === 2 ? "chat-A" : "A"));
  const listeners = new Set();
  let narrow = false;
  const responsiveQuery = {
    media: "(max-width: 760px)",
    get matches() { return narrow; },
    onchange: null,
    addEventListener(type, listener) { if (type === "change") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "change") listeners.delete(listener); },
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    dispatchEvent(event) { listeners.forEach((listener) => listener(event)); return true; },
  };
  const setNarrow = (matches) => {
    narrow = matches;
    const event = { matches, media: responsiveQuery.media };
    responsiveQuery.onchange?.(event);
    responsiveQuery.dispatchEvent(event);
  };
  window.matchMedia = (query) => query === responsiveQuery.media ? responsiveQuery : originalMatchMedia(query);
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
    window.dispatchEvent(new Event("resize"));
    await settle();
    assert(host.querySelector("#project-sidebar").getAttribute("aria-hidden") === "true", "A same-breakpoint desktop resize reopened the project sidebar");
    host.querySelector('[aria-label="Open projects sidebar"]').click();
    await until(() => host.querySelector("#project-sidebar").getAttribute("aria-hidden") === "false", "reopened desktop sidebar");

    const composer = host.querySelector('textarea[aria-label="Message the agent"]');
    composer.focus();
    setNarrow(true);
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
    assert(sidebar.getAttribute("role") === "dialog" && sidebar.getAttribute("aria-modal") === "true", "Project drawer is not exposed as a modal dialog");
    assert(workspace.getAttribute("aria-hidden") === "true", "Project drawer did not hide the workspace from assistive technology");
    assert(scrim?.tagName === "DIV" && scrim.tabIndex === -1, "Project drawer backdrop entered the tab order");
    const closeButton = document.activeElement;
    window.dispatchEvent(new Event("resize"));
    await settle();
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

    const terminalTrigger = host.querySelector('[aria-label="Terminal"]');
    terminalTrigger.click();
    await until(() => host.querySelector("#workspace-inspector"), "narrow inspector");
    await until(() => document.activeElement?.id === "inspector-tab-terminal", "inspector tab focus");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await until(() => !host.querySelector("#workspace-inspector"), "inspector escape close");
    assert(document.activeElement === terminalTrigger, "Escape did not restore focus to the inspector invoker");

    terminalTrigger.click();
    await until(() => host.querySelector('[aria-label="Close inspector"]'), "inspector close control");
    host.querySelector('[aria-label="Close inspector"]').click();
    await until(() => !host.querySelector("#workspace-inspector"), "inspector button close");
    assert(document.activeElement === terminalTrigger, "Inspector close control did not restore invoker focus");
  } finally {
    root.render(null);
    await settle();
    window.matchMedia = originalMatchMedia;
  }
}

try {
  await chatRace(false, false);
  results.textContent = "PASS: sending in the current conversation shows its run\n";
  await chatRace(false);
  results.textContent += "PASS: delayed send cannot attach A's run to B\n";
  await chatRace(true);
  results.textContent += "PASS: delayed trust response cannot target another conversation\n";
  await terminalRace();
  results.textContent += "PASS: worktree switch removes old terminal tabs and rejects stale buffer responses\n";
  await responsiveFocusRegression();
  results.textContent += "PASS: narrow drawer and inspector contain and restore focus\n5 interaction regressions passed";
  document.title = "PASS — Outright interaction regressions";
} catch (error) {
  results.textContent += `\nFAIL: ${error.stack}`;
  document.title = "FAIL — Outright interaction regressions";
} finally {
  root.unmount();
  window.fetch = originalFetch;
  window.WebSocket = OriginalSocket;
  window.matchMedia = originalMatchMedia;
  keys.forEach((key, index) => saved[index] === null ? localStorage.removeItem(key) : localStorage.setItem(key, saved[index]));
}
