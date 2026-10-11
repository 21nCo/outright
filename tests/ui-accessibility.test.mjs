import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { domId, nextTabIndex } from "../src/lib/accessibility.js";
import { modelMismatch, providerOptionLabel, providerStatusText, providerSwitchProblem, supportsPolicy, unsupportedChoices } from "../src/lib/providers.js";

const root = new URL("../", import.meta.url);

test("tab navigation wraps and supports Home and End", () => {
  assert.equal(nextTabIndex(0, 3, "ArrowRight"), 1);
  assert.equal(nextTabIndex(2, 3, "ArrowRight"), 0);
  assert.equal(nextTabIndex(0, 3, "ArrowLeft"), 2);
  assert.equal(nextTabIndex(1, 3, "Home"), 0);
  assert.equal(nextTabIndex(1, 3, "End"), 2);
  assert.equal(nextTabIndex(1, 3, "Enter"), 1);
  assert.equal(nextTabIndex(0, 0, "ArrowRight"), -1);
});

test("DOM ids remain valid for provider and runtime identifiers", () => {
  assert.equal(domId("chat-tab", "abc/123:next"), "chat-tab-abc-123-next");
});

test("core surfaces retain their semantic wiring and narrow-screen fallbacks", async () => {
  const [app, terminal, palette, settings, context, changes, styles] = await Promise.all([
    readFile(new URL("src/App.jsx", root), "utf8"),
    readFile(new URL("src/components/TerminalPane.jsx", root), "utf8"),
    readFile(new URL("src/components/CommandPalette.jsx", root), "utf8"),
    readFile(new URL("src/components/SettingsDialog.jsx", root), "utf8"),
    readFile(new URL("src/components/ContextPane.jsx", root), "utf8"),
    readFile(new URL("src/components/ChangesPane.jsx", root), "utf8"),
    readFile(new URL("src/styles.css", root), "utf8"),
  ]);

  assert.match(app, /id="project-sidebar" role=\{isNarrow && sidebarOpen \? "dialog"/);
  assert.match(app, /aria-modal=\{isNarrow && sidebarOpen \? true/);
  assert.match(app, /id="main-workspace"[^\n]+inert=\{isNarrow && sidebarOpen \? true/);
  assert.match(app, /className="mobile-scrim"[^\n]+aria-hidden="true"/);
  assert.match(app, /worktree\.isLinked && <>/);
  assert.match(app, /function StreamingMessage[^\n]+aria-busy=\{busy\}/);
  assert.doesNotMatch(app.match(/function StreamingMessage[^\n]+/)?.[0] ?? "", /role="status"|aria-live/);
  assert.match(terminal, /screenReaderMode: true/);
  assert.match(terminal, /aria-describedby="terminal-help"/);
  assert.match(terminal, /aria-disabled=\{loading \|\| undefined\}/);
  assert.match(palette, /role="combobox"/);
  assert.match(palette, /className="command-options" id="command-results" role="listbox"/);
  assert.match(settings, /type="checkbox" aria-label="Notify when runs finish"/);
  assert.match(context, /tabIndex=\{0\} aria-label=\{`Preview of \$\{file\.name\}`\}/);
  assert.match(changes, /status && !status\.files\.length/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /\.command-dialog \{[^}]+padding: 0;[^}]+overflow: hidden;/);
  assert.match(styles, /\.setting-row > input:not\(\[type="checkbox"\]\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
});

test("provider controls explain readiness and only offer supported choices", async () => {
  const direct = { id: "anthropic-api", label: "Anthropic API", kind: "direct-provider", available: true, compatible: true, version: "1.0.0",
    authority: { source: "env", variable: "OUTRIGHT_ANTHROPIC_API_KEY" }, capabilities: { permissionModes: ["read-only"], reasoningEfforts: ["medium"], resume: false } };
  const oldCodex = { id: "codex", label: "Codex", available: true, compatible: false, reason: "Codex 0.20.0 is not supported" };
  assert.equal(providerOptionLabel(oldCodex), "Codex (unsupported version)");
  assert.equal(providerStatusText(oldCodex), "Codex 0.20.0 is not supported");
  assert.match(providerStatusText(direct), /Outright-managed via OUTRIGHT_ANTHROPIC_API_KEY · Read only · no session resume/);
  assert.equal(supportsPolicy(direct, "workspace-write"), false);
  // Before, switching to a read-only provider rewrote the global policy and effort.
  const draft = { provider: "anthropic-api", approvalPolicy: "workspace-write", reasoningEffort: "high" };
  assert.equal(unsupportedChoices(direct, draft), "Anthropic API does not support the Workspace write approval policy or high reasoning effort; choose a supported value before saving.");
  assert.equal(unsupportedChoices(direct, { ...draft, approvalPolicy: "read-only", reasoningEffort: "medium" }), "");
  const codex = { id: "codex", label: "Codex", modelProvider: "openai", models: ["gpt-5.4"] };
  const claude = { id: "claude", label: "Claude Code", modelProvider: "anthropic", models: ["sonnet", "opus", "haiku"] };
  const anthropic = { ...direct, modelProvider: "anthropic", models: ["claude-opus-5-5"] };
  const providers = [codex, claude, anthropic];
  // The third argument is the provider selected when the model was opened or last edited.
  assert.match(modelMismatch(providers, { provider: "claude", model: "gpt-5.4" }, "codex"), /“gpt-5\.4” was chosen for Codex; choose a Claude Code model or clear it/);
  // A shared vendor does not make Claude Code's aliases or another adapter's names valid for the target,
  // even when the alias was entered in this dialog after an earlier switch.
  for (const model of ["sonnet", "opus", "haiku"]) {
    assert.match(modelMismatch(providers, { provider: "anthropic-api", model }, "claude"), new RegExp(`“${model}” was chosen for Claude Code; choose a Anthropic API model`));
  }
  assert.notEqual(modelMismatch(providers, { provider: "claude", model: "claude-opus-5-5" }, "anthropic-api"), "");
  // A model entered under the selected provider, a cleared field or a model the target lists is a deliberate choice.
  for (const [next, chosenFor] of [[{ provider: "claude", model: "haiku" }, "claude"], [{ provider: "anthropic-api", model: "claude-custom" }, "anthropic-api"],
    [{ provider: "claude", model: "" }, "codex"], [{ provider: "claude", model: "opus" }, "codex"], [{ provider: "anthropic-api", model: "claude-opus-5-5" }, "claude"],
    [{ provider: "codex", model: "gpt-5.4" }, "codex"]]) {
    assert.equal(modelMismatch(providers, next, chosenFor), "", JSON.stringify(next));
  }
  // A dialog switches only to a ready provider; the one it opened on stays saveable in any state.
  const states = [{ ...codex, available: true, compatible: true }, { ...claude, available: false, compatible: false },
    { ...anthropic, compatible: false }, { id: "hermes", label: "Hermes", available: false, compatible: false, checking: true }];
  for (const opened of states) assert.equal(providerSwitchProblem(states, { provider: opened.id }, opened.id), "", opened.id);
  assert.equal(providerSwitchProblem(states, { provider: "codex" }, "claude"), "");
  for (const [target, reason] of [["claude", "Claude Code is unavailable"], ["anthropic-api", "Anthropic API is an unsupported version"],
    ["hermes", "Hermes is still being checked"], ["gone", "gone is not supported by this Outright runtime"]]) {
    assert.equal(providerSwitchProblem(states, { provider: target, model: "" }, "codex"), `${reason}; choose a ready provider before saving.`);
  }
  const [app, settings] = await Promise.all([readFile(new URL("src/App.jsx", root), "utf8"), readFile(new URL("src/components/SettingsDialog.jsx", root), "utf8")]);
  assert.match(settings, /aria-describedby="default-provider-status"/);
  assert.match(settings, /id="default-provider-status" className="provider-status" role="status" aria-live="polite"/);
  assert.match(app, /aria-describedby="chat-settings-provider-status"/);
});
