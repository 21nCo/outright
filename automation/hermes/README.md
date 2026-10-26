# Hermes Linear delivery loop

**Legacy OUT-31 compatibility only.** Future Outright cards use the shared automation at `/Users/serro/Documents/dev/n/agent/automation/linear-loop` with `projects/outright.json`, hosted role skills, and the shared coordinator/settle gate. This directory remains available to the active `t_8f88360e` card and its existing in-repository PR ledger and hosted `pr-refetch-fix@1.2.0` pin until that PR closes. Do not start a second coordinator from this directory or silently migrate that ledger while the card is active.

This setup serializes the Outright Linear backlog through implementation, review, PR fixing, and convergence-evaluation Hermes profiles:

1. A deterministic coordinator reads the Outright team through Composio CLI and creates one Hermes card according to the configured implementation sequence.
2. `outright-implementer` uses GPT-6 Sol with high reasoning through the Hermes `openai-codex` OAuth provider to implement and commit locally in a dedicated Git worktree.
3. At each committed local head, `local-parallel-review.mjs` runs Codex/GPT-6 Sol High, Hermes/GLM 5.3 High, and Factory Droid/Opus 5.5 High concurrently in isolated worktree snapshots. The reviewer verifies and consolidates all three exact-head reports by root-cause family before returning findings to implementation. GLM uses OpenRouter with DigitalOcean and Cloudflare listed in that order.
4. After the local gate passes, the implementer pushes and opens a PR, initializes the persistent convergence ledger, and hands the card to `outright-pr-fixer`.
5. `outright-pr-fixer` uses a separate GPT-6 Sol High profile. Each remediation round waits 30 minutes after PR creation or the latest pushed commit. Before hosted skill retrieval, a read-only GPT-6 Sol High evaluator takes a fully paginated, exact-head GitHub snapshot and compares deduplicated root-cause families with prior heads. The progress trend counts blocking/major code root causes, deduplicates a failed CI check already represented by a family, and tracks external manual assistive-technology acceptance separately; all findings remain visible and a clean candidate still requires none. A flat count may still be progress when an old stable family clears and one new family appears without increasing the total. If no family clears, one bounded architecture repair requires a complete old-head reproduction and coordinated assessment bound to the current head and next round. Incomplete evidence, an unassessed reset, and the round cap still stop retrieval. A clean candidate returns to the reviewer. If the gate allows work, the fixer retrieves the pinned hosted Skillplane workflow through Composio CLI and executes exactly one bounded fetch/fix/test/push pass.
6. GPT-6 Sol independently checks the resulting PR head. Stable family IDs and the existing ledger gate also switch a family that fails twice into architecture-reset mode.
7. A clean PR is blocked at `READY_FOR_MERGE_APPROVAL` with Linear still In Review. Only the user's explicit go authorizes merge, Linear Done, and card completion.
8. The next coordinator tick can then import the next Linear issue.

## Implementation sequence

The configured order below covers all 42 executable OUT issues in the 2026-09-22 live backlog snapshot. Read each row left to right, then continue to the next row. These are priority phases, not new Linear states.

| Phase | OUT issue order |
| --- | --- |
| Runtime foundations | 29 → 31 → 32 → 30 → 3 → 28 |
| Workspace lifecycle and terminals | 12 → 10 → 11 → 1 → 2 |
| Editing, review and context | 18 → 17 → 13 → 15 → 16 → 4 → 5 → 23 → 6 → 14 |
| Native workflow foundations | 33 → 34 → 38 → 37 → 8 |
| Hosted integrations | 21 → 22 |
| Native review and automation | 35 → 39 → 40 → 9 → 41 → 24 → 25 → 44 |
| Browser, remote and optional cloud | 19 → 20 → 26 → 42 → 43 → 27 |

OUT-29 is already In Review: finish its existing review/merge gate rather than create another implementation. OUT-7 is retired. OUT-36 is the umbrella and is excluded from automatic implementation intake; assess its completion after its children and integration acceptance are complete. OUT-31 accessibility and OUT-32 performance remain acceptance criteria for every later issue.

External prerequisite: [DIFF-1](https://linear.app/21n/issue/DIFF-1) must complete before OUT-35. It is currently Backlog and belongs to Diffpanel, so this Outright coordinator does not import it. OUT-35 also gates OUT-39 and OUT-44.

`workflow.json` is retained only for the existing OUT-31 compatibility path; its active PR fix pin is in the assigned worktree and ledger. The shared `projects/outright.json` is the source of truth for future issue order, dependencies, profiles and limits. The shared coordinator checks external prerequisites through the configured Linear account and refuses active cards or retained worktrees.

All Linear calls use Composio `--account 21n`; this avoids the separate Serro connection. Updating these files does not resume the cron job or alter existing cards.

Linear and Skillplane access must go through Composio CLI. The coordinator and agents never use direct Linear or Skillplane connectors or MCP servers.

The Outright five-minute coordinator job (`cb1ab79ed91f`) and PR settle job (`d6d3c6facbc3`) now run the shared `coordinator.mjs` and `pr-settle-gate.mjs` with `projects/outright.json`. Both were verified active after migration. The settle job resumes only typed `PR_SETTLE_GATE:` waits once 30 minutes have elapsed and visible checks are terminal. Inspect current state before using the operational commands below:

```bash
hermes cron list --all
hermes gateway install --start-now
hermes cron resume <job-id>
```

Pause intake without disturbing a card already in progress:

```bash
hermes cron pause <job-id>
```

Inspect the board and execution history:

```bash
hermes kanban boards switch outright
hermes kanban list
hermes cron runs <job-id>
```
