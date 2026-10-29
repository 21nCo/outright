# Outright

Outright is a local-first workspace for running coding agents across Git projects and worktrees. Projects and worktrees are discovered automatically, spaces (groups of projects) live in SQLite, and agent conversations appear as tabs for the selected worktree.

## What works

- Durable Codex and Claude Code conversations, messages, provider session IDs, runs, usage, and run events
- Live run status over WebSockets, run cancellation, a concurrency queue, and interrupted-run recovery
- SQLite state in `~/.outright/outright.db` (override with `OUTRIGHT_DATA_DIR`)
- Project trust, sandbox/approval choices, exact-path guards, same-origin runtime access, and an audit log
- Real PTY terminals with multiple tabs, resize/input/output streaming, reconnectable scrollback, and Find in the retained scrollback
- Git status, diffs, stage/unstage, commits, guarded worktree creation/removal, and editor launching
- Project spaces, searchable conversations/messages, draggable/pinnable/renamable/archivable tabs, cross-worktree conversation moves, prompt templates, notifications, and keyboard shortcuts
- Repository context for AGENTS/Claude/Copilot instructions, local skills, and the current GitHub pull request
- Split panes: place the conversation beside the terminal, changes, and context views; resize, move, and close panes; each worktree restores its own arrangement
- Light, dark, and system themes using DM Sans, Tailwind, shadcn/Base UI, and Phosphor icons

## Requirements

- Node.js 20 or newer
- Git
- A C11 compiler (`cc`, `clang`, or `gcc`) on Linux; the development, build,
  and production-start scripts compile the child-subreaper agent supervisor
- At least one supported provider CLI on `PATH`: `codex` or `claude`
- Optional editor CLI: `zed`, `code`, or `cursor`
- Optional GitHub CLI (`gh`) for pull-request context
- Google Chrome or Chromium for `npm test` browser interaction regressions (not
  required to run the app); set `CHROME_PATH` to its executable if it is not
  installed in a standard macOS, Linux, or Windows location

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

## Split panes

The main view is a pane layout for the selected worktree. The conversation, controlled by the chat tabs above it, is always present; the Changes, Terminal, and Context toolbar buttons open or close their panes, and each pane's options menu splits it right or down, moves it, or closes it. Drag a pane's title onto an edge of another pane to dock it there. Each view appears at most once, so a layout has at most four panes, and moving a pane keeps its view mounted: a terminal keeps its session and output, and the conversation keeps its draft. Closing a pane leaves its shell running; reopening the Terminal pane reattaches to it.

Separators resize with the pointer or, when focused, with the arrow keys, `Home`, and `End`; every pane keeps a minimum usable size that fits its view's own controls plus several message, diff, or terminal lines, and each view compacts its chrome to the size of its pane rather than the window. A conversation's notices (a recovery decision, an unsent first prompt, history navigation, live output) share one bounded, scrollable region above the composer with their actions kept in view, so the transcript always keeps several lines. When the window is too small for every pane's minimum, or narrower than 760px, panes are shown one at a time with tabs, and their views stay mounted; focus on a separator, pane tab, pane options button, or open pane options menu that this switch removes moves to the shown pane, and keyboard selection scrolls a clipped pane tab into view within the tab strip. Layouts are saved under each worktree's path, so worktrees whose names collide keep their own.

Layouts are saved in the browser's local storage per worktree, for the 64 most recently arranged worktrees. A saved layout with an unknown or duplicate view or an invalid size is repaired on restore, and an unreadable one falls back to the conversation alone; Outright names the repair it made, and says only once per session when the saved layouts cannot be read at all.

## Keyboard shortcuts

- `Cmd/Ctrl K`: project, worktree, and conversation search
- `Cmd/Ctrl N`: new conversation
- `Cmd/Ctrl Shift T`: open or focus the terminal pane
- `Cmd F` on macOS, `Ctrl Shift F` elsewhere, with focus in the terminal pane: find in its scrollback; `Enter` / `Shift Enter` move to the next (newer) or previous (older) match and `Escape` closes Find and returns to the terminal
- `F6` / `Shift F6`: move focus to the next or previous pane
- `Enter`: send a prompt
- `Shift Enter`: newline in the prompt

## Verification

```bash
npm test
npm run build
npm run test:sites
```

The suite covers provider command construction and event normalization, SQLite recovery, PTY input/output, Git review/staging/commits, guarded worktree lifecycle, scanner parsing, and browser interaction regressions. Install Chrome or Chromium before running `npm test`; the browser suite fails explicitly rather than skipping coverage if it cannot find an executable. GitHub CI runners include Chrome, and `CHROME_PATH` overrides the detected location.

## Terminal Find

Find searches the output the terminal still holds: the last 5,000 lines of a live terminal, or the shown part of saved output. The query is literal, not a regular expression, and ignores case using Unicode case folding, so `STRASSE` finds `Straße`; a match may span a wrapped line. The bar shows the current match and the total, such as `3 of 12`, and screen readers hear the same when you search or move between matches; a count that only new output changed is announced at most every 5 seconds. When there are more than 1,000 matches, only the newest 1,000 are counted and navigable, shown as `1000+`; a match inside one character that case folding expands, such as `s` in `ß`, counts that character once. A new query selects the newest match at or above the bottom of the view. Output that arrives while Find is open updates the count without moving the view; the current match stays current, and highlighted where lines inserted or deleted above it or a resize moved it, until its line leaves the scrollback, newer output pushes it out of the newest 1,000 matches, or the terminal is reset. A width change that rewraps the current match within its own line drops it. Find highlights only its current match in amber; once you start a selection in the terminal or type there, Find leaves that selection alone, even while you are still dragging it, and a press that selects nothing, such as one on the scrollbar, a right-click on the highlight or a click a program tracking the mouse receives, leaves Find's highlight in place. Find keys never reach the process: the shortcut is withheld, typing goes to the query, `Escape` from any Find control closes it, and `Escape` in the terminal itself still goes to the program. The bar overlays the right of the top rows, so opening it does not resize the terminal. A match left of the bar stays where it is; one under it is scrolled into the open, and near the top of the output, where the view cannot scroll, the bar moves to the bottom instead.

## Terminals across restarts

Outright saves terminal output in its data directory, at most 2 MiB per terminal and 64 MiB in total, and keeps a session's output for 7 days after it ends. After a restart, a terminal that did not keep running opens as read-only saved output, labelled with how it ended: its exit status, or "ended when Outright restarted".

With **Keep shells running when Outright restarts** on (Settings → Terminals, the default), live shells survive a graceful restart:

- **Graceful restart.** A Vite dev server restart (a config change or the `r` shortcut) that Vite completes, or a launcher that forks `server/standalone.mjs` with an IPC channel and sends it `{ "type": "outright.shutdown", "intent": "restart" }`. (`npm start` opens no IPC channel, so it cannot be restarted this way.) Each live shell keeps running in its native supervisor. The next Outright reattaches it after proving its private single-use token and the broker's identity, shows the output it printed meanwhile, and labels it "live process reattached".
- **Quit.** `Ctrl-C` (`SIGINT`) or `SIGTERM` to `npm run dev` or `npm start`, closing the Vite server, or the IPC intent `"quit"`. A config reload that Vite reports as "server restart failed", because a plugin threw while Vite created the new server, keeps the old server and is not a restart, so closing that server later is still a quit. (With Vite in middleware mode, which `npm run dev` does not use, a reload that fails later, in a plugin's `buildStart`, still counts as a restart.) A quit first removes every shell's reattach record in the data directory, so from then on no later start reattaches any shell, however the process exits. It then closes every shell, including any a previous run left for reattach that this run has not reattached, and its output is restored as saved output. A quit always wins over a restart: one that arrives while a restarting Outright hands its shells back, including `Ctrl-C` or `SIGTERM` during a Vite restart, ends those shells too, and the process exits only after every Outright in it has stopped; one that arrives after the shells were handed back leaves them to the next start, which ends them. A quit soon after start waits up to 10 seconds for Outright to learn which shells a previous run left; if it still cannot tell, the quit reports an error and the next start ends those shells. With the setting off, a quit waits only if a previous run left a shell to reattach, or if the data directory cannot be read to tell. A quit while Outright is still starting (recovering its database) ends no shell itself; the next start ends them. One `Ctrl-C` can reach Outright twice at once (`npm run` forwards the terminal's signal), which counts as one quit; a second `Ctrl-C` a second or more later exits at once, and the next start ends the shells still running.
- **Crash.** Shells keep running, and the next start reattaches only those it can verify the same way. It ends the rest through native recovery and shows their saved output.

Limits: a shell that is not reattached within 10 minutes is ended. While no Outright is attached, a shell's newest 1 MiB of output is kept, and a notice marks any output dropped before it. A command that exited before the restart is shown with its exit status and never as resumed. A shell that exits or does not answer while Outright stops is closed instead of kept. Turning the setting off ends every shell with its Outright process, as a quit does. Shells a quit leaves running end when their 10-minute window closes if Outright does not start again first. Quitting a second Outright started on the same data directory also removes the running one's reattach records, so its shells end, rather than reattach, at its next restart.

## Unverified terminal capacity

Terminals run inside a native process ownership boundary. If Outright cannot verify that a boundary is empty after a crash or failed helper call, Settings keeps its slot charged. Stop Outright and inspect the unresolved owner before releasing it:

```bash
node scripts/reconcile-terminal-capacity.mjs --list
node scripts/reconcile-terminal-capacity.mjs --target TERMINAL_ID --verified-empty --evidence "How the native process tree was verified empty"
```

The second command releases one reservation and records the operator's evidence in the audit log. It refuses to run while another runtime holds the database lease. Use `--database /path/to/outright.db` with both commands when `OUTRIGHT_DATA_DIR` or a custom database path is in use. Do not release a reservation while its owner or descendants remain active.

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
