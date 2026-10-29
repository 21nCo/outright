// Client view of worktree setup and teardown states from the runtime.
// Mirrors the server's retained output bound.
export const LIFECYCLE_OUTPUT_CHARACTERS = 32 * 1024;

const PHASE_NAMES = { setup: "Setup", teardown: "Teardown" };

function stepText(state) {
  const count = state.steps?.length ?? 0;
  if (!count || state.stepIndex >= count) return "";
  return ` at step ${state.stepIndex + 1} of ${count}, ${state.steps[state.stepIndex]}`;
}

// What the toolbar and sidebar say about a state. `quiet` states need no
// attention and show no chip, but their change is still announced.
export function lifecycleSummary(state) {
  if (!state?.status) return null;
  const phase = PHASE_NAMES[state.phase] ?? "Setup";
  const count = state.steps?.length ?? 0;
  switch (state.status) {
    case "running": {
      const index = Math.min(state.stepIndex, Math.max(count - 1, 0));
      return { tone: "running", short: `${phase} ${index + 1}/${count}`,
        label: `${state.phase === "teardown" ? "Tearing down" : "Setting up"}: step ${index + 1} of ${count}, ${state.steps?.[index] ?? ""}` };
    }
    case "ready": return { tone: "ready", quiet: true, short: "Ready", label: "Setup finished; the worktree is ready" };
    case "complete": return { tone: "ready", quiet: true, short: "Torn down", label: "Teardown finished" };
    case "needs-trust": return { tone: "trust", short: `Review ${state.phase}`, label: `${phase} commands need your review before they run` };
    case "invalid": return { tone: "attention", short: `${phase} invalid`, label: `${phase} configuration is invalid` };
    case "failed":
      if (state.phase === "teardown" && count && state.stepIndex >= count) {
        return { tone: "attention", short: "Removal failed", label: "Teardown finished, but the worktree was not removed" };
      }
      return { tone: "attention", short: `${phase} failed`, label: `${phase} failed${stepText(state)}` };
    case "cancelled": return { tone: "attention", short: `${phase} cancelled`, label: `${phase} cancelled${stepText(state)}` };
    case "interrupted": return { tone: "attention", short: `${phase} interrupted`, label: `${phase} interrupted${stepText(state)}` };
    default: return null;
  }
}

// Applies one streamed output event to a loaded state. Returns the next
// state, null when the event adds nothing, or "reload" when the event is from
// a run or position the client does not have.
export function lifecycleOutputUpdate(state, payload) {
  if (!state || !payload || payload.worktreePath !== state.worktreePath || typeof payload.text !== "string") return null;
  if (payload.runId !== state.runId) return "reload";
  const end = state.outputEnd ?? state.output?.length ?? 0;
  const stop = payload.start + payload.text.length;
  if (stop <= end) return null;
  if (payload.start > end) return "reload";
  let output = (state.output ?? "") + payload.text.slice(end - payload.start);
  let outputTruncated = Boolean(state.outputTruncated);
  if (output.length > LIFECYCLE_OUTPUT_CHARACTERS) {
    output = output.slice(-LIFECYCLE_OUTPUT_CHARACTERS);
    outputTruncated = true;
  }
  return { ...state, output, outputEnd: stop, outputTruncated };
}

export function upsertLifecycleState(states, payload) {
  const others = (states ?? []).filter((state) => state.worktreePath !== payload.worktreePath);
  return payload.removed ? others : [payload, ...others];
}

// States are matched by path: scanner ids are path slugs that two worktrees
// can share.
export function lifecycleFor(states, project, worktree) {
  if (!project || !worktree?.path) return null;
  return (states ?? []).find((state) => state.projectId === project.id
    && (state.discoveredPath ?? state.worktreePath) === worktree.path) ?? null;
}

// Removal refusals that keep the worktree and leave the user a choice.
export const TEARDOWN_PROBLEMS = ["WORKTREE_TEARDOWN_FAILED", "LIFECYCLE_TRUST_REQUIRED", "LIFECYCLE_CONFIG_INVALID",
  "LIFECYCLE_OUTCOME_UNKNOWN", "WORKTREE_AGENT_ACTIVE"];

// What the user may do next about a teardown problem. Processes that could
// not be confirmed stopped must be acknowledged before teardown runs again.
export function teardownProblem(error, worktreePath) {
  const code = error?.payload?.code;
  if (!TEARDOWN_PROBLEMS.includes(code)) return null;
  const outcomeUnknown = code === "LIFECYCLE_OUTCOME_UNKNOWN" || Boolean(error.payload?.lifecycle?.outcomeUnknown);
  const choices = code === "WORKTREE_AGENT_ACTIVE" ? [] : [outcomeUnknown ? "acknowledge" : "retry", "skip"];
  return { code, message: error.message, worktreePath, choices, choice: outcomeUnknown ? "" : choices[0] ?? "" };
}

// The removal request. A skip or an acknowledgement applies only to the
// worktree whose problem the user saw, and only as one of its choices.
export function removalRequest({ projectId, worktreePath, confirmation }, problem) {
  const body = { projectId, worktreePath, confirmation };
  if (problem?.worktreePath !== worktreePath || !problem.choices.includes(problem.choice)) return body;
  if (problem.choice === "skip") body.skipTeardown = true;
  if (problem.choice === "acknowledge") body.acknowledgeUnconfirmed = true;
  return body;
}
