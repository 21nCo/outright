# Outright

Outright is a local-first workspace for running coding agents across Git projects and worktrees. Projects and worktrees are discovered automatically, project groups live in SQLite, and agent conversations appear as tabs for the selected worktree.

## What works

- Durable Codex and Claude Code conversations, messages, provider session IDs, runs, usage, and run events
- Live run status over WebSockets, run cancellation, a concurrency queue, and interrupted-run recovery
- SQLite state in `~/.outright/outright.db` (override with `OUTRIGHT_DATA_DIR`)
- Project trust, sandbox/approval choices, exact-path guards, same-origin runtime access, and an audit log
- Real PTY terminals with multiple tabs, resize/input/output streaming, and reconnectable scrollback
- Git status, diffs, stage/unstage, commits, guarded worktree creation/removal, and editor launching
- Project grouping, searchable conversations/messages, draggable/pinnable/renamable/archivable tabs, cross-worktree conversation moves, prompt templates, notifications, and keyboard shortcuts
- Repository context for AGENTS/Claude/Copilot instructions, local skills, and the current GitHub pull request
- Light, dark, and system themes using DM Sans, Tailwind, shadcn/Base UI, and Phosphor icons

## Requirements

- Node.js 20 or newer
- Git
- A C11 compiler (`cc`, `clang`, or `gcc`) on Linux; the development, build,
  and production-start scripts compile the child-subreaper agent supervisor
- At least one supported provider CLI on `PATH`: `codex` or `claude`
- Optional editor CLI: `zed`, `code`, or `cursor`
- Optional GitHub CLI (`gh`) for pull-request context

## Run for development

```bash
npm install
npm run dev
```

Open <http://localhost:4173>. The postinstall step repairs the executable permission on `node-pty`'s macOS helper when npm does not preserve it. On Linux, `npm run dev`, `npm run build`, and `npm start` also compile the native agent supervisor before launching.

## Run the local production build

```bash
npm run build
npm start
```

The production server binds to `127.0.0.1:4173` by default. Use `PORT` or `HOST` to change that behavior.

## Configure discovery

Edit `outright.config.json`, or provide scan roots as a platform-delimited environment variable:

```bash
OUTRIGHT_SCAN_ROOTS="/path/one:/path/two" npm start
```

Outright only accepts Git and terminal operations for worktrees found by this scanner. New worktrees must remain inside a configured scan root.

## Keyboard shortcuts

- `Cmd/Ctrl K`: project, worktree, and conversation search
- `Cmd/Ctrl N`: new conversation
- `Cmd/Ctrl Shift T`: terminal drawer
- `Enter`: send a prompt
- `Shift Enter`: newline in the prompt

## Verification

```bash
npm test
npm run build
npm run test:sites
```

The suite covers provider command construction and event normalization, SQLite recovery, PTY input/output, Git review/staging/commits, guarded worktree lifecycle, and scanner parsing.

## Linear delivery automation

The project includes a paused Hermes workflow for processing the Outright Linear backlog one issue at a time through implementation, pull-request creation, and independent review. Linear access is routed through Composio CLI. See [`automation/hermes/README.md`](automation/hermes/README.md) for the workflow and activation commands.

## Architecture

- React 19 and Vite render the interface.
- A Node runtime serves the API and WebSocket channel in development and production.
- `better-sqlite3` stores durable application state.
- `node-pty` and xterm.js provide interactive terminals.
- Codex and Claude Code run as local subprocesses in the selected worktree.
- Chokidar refreshes project/worktree metadata after filesystem changes.
- The optional Sites output is a static UI artifact only; hosted static deployment cannot access local repositories, provider CLIs, terminals, or the SQLite runtime.

## Local security model

Outright starts production on loopback, rejects browser requests whose `Origin` does not match the runtime host, requires explicit trust for each project path before the first agent run, and records material agent/Git/terminal actions in its audit log. `danger-full-access` is intentionally available but must be selected explicitly.
