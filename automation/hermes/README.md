# Hermes Linear delivery loop

This setup serializes the Outright Linear backlog through two independent Hermes profiles:

1. A deterministic coordinator reads the Outright team through Composio CLI and creates one Hermes card according to the configured implementation sequence.
2. `outright-implementer` uses Kimi K3 to implement and commit locally in a dedicated Git worktree.
3. `outright-reviewer` uses GPT Sol with high reasoning through the Hermes `openai-codex` OAuth provider. It reviews the local branch before any PR exists; findings return to implementation.
4. After the local gate passes, the implementer pushes and opens a PR. Automatic review agents run on that PR and on later fix commits.
5. Each remediation round waits 30 minutes after PR creation or the latest pushed commit, retrieves pinned hosted Skillplane workflow `21n/pr-refetch-fix@1.2.0` through Composio CLI, and executes exactly one bounded fetch/fix/test/push pass. Addressed review threads may be replied to and resolved using the captured snapshot IDs.
6. GPT Sol independently checks the resulting PR head. It requests another bounded round while current findings or review activity remain.
7. A clean PR is blocked at `READY_FOR_MERGE_APPROVAL` with Linear still In Review. Only the user's explicit go authorizes merge, Linear Done, and card completion.
8. The next coordinator tick can then import the next Linear issue.

The issue sequence is `29 → 31 → 32 → 30 → 3 → 12 → 10 → 11 → 1 → 2 → 18 → 17 → 13 → 15 → 16 → 4 → 5 → 23 → 6 → 14 → 8 → 24 → 25 → 28 → 21 → 22 → 7 → 9 → 19 → 20 → 26 → 27`. OUT-31 accessibility and OUT-32 performance are also persistent acceptance criteria for every later issue.

Linear and Skillplane access must go through Composio CLI. The coordinator and agents never use direct Linear or Skillplane connectors or MCP servers.

The installed cron job is intentionally created **paused**. Review the setup before starting it:

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
