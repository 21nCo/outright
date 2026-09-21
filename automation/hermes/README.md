# Hermes Linear delivery loop

This setup serializes the Outright Linear backlog through two independent Hermes profiles:

1. A deterministic coordinator reads the Outright team through Composio CLI and creates one Hermes card for the highest-priority Backlog issue. Equal priorities run in issue-number order.
2. `outright-implementer` uses Kimi K3 to implement and commit locally in a dedicated Git worktree.
3. `outright-reviewer` uses GPT Sol with high reasoning through the Hermes `openai-codex` OAuth provider. It reviews the local branch before any PR exists; findings return to implementation.
4. After the local gate passes, the implementer pushes and opens a PR. Automatic review agents run on that PR and on later fix commits.
5. Each remediation round waits for the current head's review activity, retrieves pinned hosted Skillplane workflow `21n/pr-refetch-fix@1.2.0` through Composio CLI, and executes exactly one bounded fetch/fix/test/push pass.
6. GPT Sol independently checks the resulting PR head. It requests another bounded round while current findings or review activity remain, and completes the card only when checks are green and no actionable finding remains.
7. The next coordinator tick can import the next Linear issue.

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
