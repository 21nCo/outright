# Hermes Linear delivery loop

This setup serializes the Outright Linear backlog through two independent Hermes profiles:

1. A deterministic coordinator reads the Outright team through Composio CLI and creates one Hermes card for the highest-priority Backlog issue. Equal priorities run in issue-number order.
2. `outright-implementer` works in a dedicated Git worktree, validates the change, pushes a branch, opens a PR, and requests review.
3. `outright-reviewer` checks the implementation, issue completeness, PR head, and required CI. Findings return the same card to implementation.
4. A clean review marks the Linear issue Done and completes the card. The next coordinator tick can then import the next issue.

Linear access must go through Composio CLI. The coordinator never uses a direct connector or MCP server.

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
