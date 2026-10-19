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
  // Claude Code runs Sonnet for the haiku alias in plan mode, so Settings refuses that pair.
  const readyClaude = { id: "claude", label: "Claude Code", capabilities: { permissionModes: ["read-only", "workspace-write"], reasoningEfforts: ["medium"], unhonoredModels: { "read-only": ["haiku"] } } };
  const haiku = { provider: "claude", model: "haiku", approvalPolicy: "read-only", reasoningEffort: "medium" };
  assert.equal(unsupportedChoices(readyClaude, haiku), "Claude Code does not support the haiku model with the Read only approval policy; choose a supported value before saving.");
  for (const allowed of [{ approvalPolicy: "workspace-write" }, { model: "claude-haiku-5-5" }, { model: "" }]) assert.equal(unsupportedChoices(readyClaude, { ...haiku, ...allowed }), "", JSON.stringify(allowed));
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

test("account usage keeps measured, reported, stale and unknown values distinct", async () => {
  const { ageLimit, answerAccountText, limitText, limitWindowLabel, listingTime, loginText, measuredText, nextListingChange, runAccountText } = await import("../src/lib/provider-accounts.js");
  const time = (value) => value.slice(11, 16);
  const window = { window: "five_hour", utilization: 0.86, status: "allowed", resetsAt: "2026-10-19T15:00:00.000Z", observedAt: "2026-10-19T10:00:00.000Z" };
  assert.equal(limitText({ ...window, state: "current" }, time), "86% used · resets 15:00");
  assert.equal(limitText({ ...window, state: "stale" }, time), "86% used as of 10:00 (stale) · resets 15:00");
  assert.equal(limitText({ ...window, utilization: null, status: null, state: "reset" }, time), "Reset 15:00; no report since");
  assert.equal(limitText({ ...window, utilization: null, resetsAt: null, status: "rejected", state: "current" }, time), "limit reached · usage not reported · reset time not reported");
  assert.equal(limitWindowLabel("seven_day_opus"), "7-day Opus limit");
  assert.equal(limitWindowLabel("monthly_spend"), "monthly spend limit");
  assert.equal(measuredText({ runs: 0, costUsd: null }), "No runs");
  assert.equal(measuredText({ runs: 2, inputTokens: 1000, outputTokens: 234, runsWithoutTokens: 0, costUsd: 0.5, runsWithoutCost: 1 }), "2 runs · 1,234 tokens · $0.500 reported (1 without reported cost)");
  assert.equal(measuredText({ runs: 1, inputTokens: 1, outputTokens: 1, runsWithoutTokens: 0, costUsd: null, runsWithoutCost: 1 }), "1 run · 2 tokens · cost not reported");
  // Unreported tokens are never shown as zero, and a partial sum says so.
  assert.equal(measuredText({ runs: 1, inputTokens: null, outputTokens: null, runsWithoutTokens: 1, costUsd: null, runsWithoutCost: 1 }), "1 run · tokens not reported · cost not reported");
  assert.equal(measuredText({ runs: 3, inputTokens: 100, outputTokens: 20, runsWithoutTokens: 1, costUsd: null, runsWithoutCost: 3 }), "3 runs · at least 120 tokens (1 without reported tokens) · cost not reported");
  // Runs that reported only input tokens keep them, as a lower bound.
  assert.equal(measuredText({ runs: 2, inputTokens: 500, outputTokens: null, runsWithoutTokens: 0, runsWithPartialTokens: 2, costUsd: null, runsWithoutCost: 2 }), "2 runs · at least 500 tokens (2 with partial token counts) · cost not reported");
  assert.equal(measuredText({ runs: 3, inputTokens: 500, outputTokens: 9, runsWithoutTokens: 1, runsWithPartialTokens: 1, costUsd: null, runsWithoutCost: 3 }), "3 runs · at least 509 tokens (1 without reported tokens, 1 with partial token counts) · cost not reported");

  // An open dialog ages a listing as time passes: past its reset a window's
  // usage is withheld, and an old report turns stale.
  const staleAfterMs = 30 * 60_000;
  const observed = Date.parse(window.observedAt);
  const current = { ...window, state: "current" };
  assert.equal(ageLimit(current, observed + 60_000, staleAfterMs).state, "current");
  assert.deepEqual([ageLimit(current, observed + staleAfterMs + 1, staleAfterMs).state, ageLimit(current, observed + staleAfterMs + 1, staleAfterMs).utilization], ["stale", 0.86]);
  const reset = ageLimit(current, Date.parse(window.resetsAt), staleAfterMs);
  assert.deepEqual([reset.state, reset.utilization, reset.status], ["reset", null, null]);
  const listing = { limitStaleAfterMs: staleAfterMs, providers: [{ accounts: [{ limits: [current], measured: [] }, { limits: null, measured: [{ changesAt: null }] }] }] };
  assert.equal(nextListingChange(listing, observed), observed + staleAfterMs + 1);
  assert.equal(nextListingChange(listing, observed + staleAfterMs + 1), Date.parse(window.resetsAt));
  assert.equal(nextListingChange(listing, Date.parse(window.resetsAt)), null);
  // A run leaving a measured window is a change too, and can come first.
  const leaves = observed + 60_000;
  listing.providers[0].accounts[1].measured.push({ changesAt: new Date(leaves).toISOString() });
  assert.equal(nextListingChange(listing, observed), leaves);
  assert.equal(nextListingChange(listing, leaves), observed + staleAfterMs + 1);
  // Aging follows the runtime's clock, not a skewed client clock.
  assert.equal(listingTime({ generatedAt: window.observedAt }, 5_000, 6_000), observed + 1_000);
  assert.equal(listingTime({ providers: [] }, 5_000, 6_000), 6_000);
  assert.equal(loginText({ status: "signed-in", identity: { email: "a@example.com", plan: "max" } }), "Signed in · a@example.com · max");
  assert.equal(loginText({ status: "unknown", error: "Codex login status could not be checked" }), "Codex login status could not be checked");
  assert.equal(loginText(undefined), "Checking login…");
  assert.equal(runAccountText({ accountLabel: "Work", accountIdentity: "a@example.com" }), "Work (a@example.com)");
  assert.equal(runAccountText({ accountLabel: null }), null);
  // An answer names its own account even when its run is not loaded.
  assert.equal(answerAccountText({ payload: { runId: "old", account: { label: "Work", identity: "a@example.com" } } }, new Map()), "Work (a@example.com)");
  assert.equal(answerAccountText({ payload: { runId: "loaded" } }, new Map([["loaded", "Default login"]])), "Default login");
  assert.equal(answerAccountText({ payload: { runId: "legacy" } }, new Map()), null);

  const [accounts, settings] = await Promise.all([
    readFile(new URL("src/components/ProviderAccounts.jsx", root), "utf8"),
    readFile(new URL("src/components/SettingsDialog.jsx", root), "utf8"),
  ]);
  assert.match(settings, /<ProviderAccounts open=\{open\}/);
  assert.match(accounts, /aria-labelledby="provider-accounts-heading"/);
  assert.match(accounts, /role="alert">\{message\.alert\}/);
  assert.match(accounts, /role="status" aria-live="polite">\{message\.status\}/);
  assert.match(accounts, /aria-describedby="provider-account-help"/);
  assert.match(accounts, /<legend className="sr-only">Confirm account removal<\/legend>/);
  assert.match(accounts, /nextListingChange\(listing, runtimeNow\)/);
  assert.match(accounts, /addEventListener\("visibilitychange"/);
  assert.match(accounts, /ageLimit\(limit, now, staleAfterMs\)/);
});
