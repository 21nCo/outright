# Outright

Outright is a local-first workspace for running coding agents across Git projects and worktrees. Projects and worktrees are discovered automatically, spaces (groups of projects) live in SQLite, and agent conversations appear as tabs for the selected worktree.

## What works

- Durable Codex and Claude Code conversations, messages, provider session IDs, runs, usage, and run events
- Live run status over WebSockets, run cancellation, a concurrency queue, and interrupted-run recovery
- SQLite state in `~/.outright/outright.db` (override with `OUTRIGHT_DATA_DIR`)
- Project trust, sandbox/approval choices, exact-path guards, same-origin runtime access, and an audit log
- Real PTY terminals with multiple tabs, resize/input/output streaming, reconnectable scrollback, and Find in the retained scrollback
- Git status, diffs, stage/unstage, commits, guarded worktree creation/removal, and editor launching
- Trusted repository setup and teardown commands for worktrees, with live progress, cancellation, and resumable retry
- Worktree checkpoints that keep staged, unstaged and untracked work, with an exact restore preview, selective restore and a checkpoint of what a restore replaces
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

The main view is a pane layout for the selected worktree. The conversation, controlled by the chat tabs above it, is always present; the Changes, Terminal, Context, and Files toolbar buttons open or close their panes (at 520px or narrower they share one Panes menu), and each pane's options menu splits it right or down, moves it, or closes it. Drag a pane's title onto an edge of another pane to dock it there. Each view appears at most once, so a layout has at most five panes, and moving a pane keeps its view mounted: a terminal keeps its session and output, and the conversation keeps its draft. Closing a pane leaves its shell running; reopening the Terminal pane reattaches to it.

Separators resize with the pointer or, when focused, with the arrow keys, `Home`, and `End`; every pane keeps a minimum usable size that fits its view's own controls plus several message, diff, or terminal lines, and each view compacts its chrome to the size of its pane rather than the window. A conversation's notices (a recovery decision, an unsent first prompt, history navigation, live output) share one bounded, scrollable region above the composer with their actions kept in view, so the transcript always keeps several lines. When the window is too small for every pane's minimum, or narrower than 760px, panes are shown one at a time with tabs, and their views stay mounted; focus on a separator, pane tab, pane options button, or open pane options menu that this switch removes moves to the shown pane, and keyboard selection scrolls a clipped pane tab into view within the tab strip. Layouts are saved under each worktree's path, so worktrees whose names collide keep their own.

Layouts are saved in the browser's local storage per worktree, for the 64 most recently arranged worktrees. A saved layout with an unknown or duplicate view or an invalid size is repaired on restore, and an unreadable one falls back to the conversation alone; Outright names the repair it made, and says only once per session when the saved layouts cannot be read at all.

## Files

The Files pane browses the selected worktree as a tree, previews the chosen file, and opens a typed path with Go to file (`Cmd P` on macOS, `Ctrl P` elsewhere, where the terminal passes that key to Files rather than the shell); it refreshes when a run in that worktree's chats ends and after a reconnect that missed events or found a restarted runtime. Hiding dotfiles ends a Go to file of a hidden path. The Files API it uses reads one discovered worktree without leaving it. `GET /api/files` lists one folder per request, 200 entries at a time (at most 500) with a cursor; a folder with more than 10,000 entries lists only the first 10,000 and says so. Dotfiles are listed only when asked for, and `.git` is never listed or previewed. A name that is not UTF-8 is listed, kept distinct from names that read the same, but cannot be opened. Symbolic links are listed as pointing inside the worktree, outside it, or nowhere; Files never follows a link out of the worktree and never opens a FIFO or other special file.

`GET /api/files/preview` never runs a file's content. Markdown and plain text up to 1 MB come back as text when they are valid UTF-8 without NUL bytes. PNG, JPEG, WebP, BMP and ICO images up to 20 MB, GIF and SVG images up to 1 MB, and PDFs up to 50 MB, are described only when their bytes match their type. A raster image is also bounded by what it decodes to: its width and height are read from the headers a decoder sizes it by (every frame of a GIF, which is read whole and whose blocks must follow the strict GIF grammar so no browser reads one differently, and the largest ICO entry count), and one over 40 million pixels, or whose size cannot be read, is oversized or unsupported and is not served. AVIF images are not previewed, because a decoder sizes one by its AV1 frame, which only its coded image data states. An SVG is drawn at the size it is shown, but a raster it embeds would decode at its own, so an SVG is served only when read whole with no `data:` URL and nothing that could spell one (a character or declared entity reference, a CSS escape, a control byte). Larger files, binary files and other types are described as oversized or unsupported. `GET /api/files/raw` serves only verified images and PDFs, sandboxed and same-origin. Given the `version` a preview returned, it serves only that version (`FILE_CHANGED` otherwise); without one, or with an empty one (as a Markdown image asks), it serves the version it verifies for that request, with the same type and size checks. Either way its body is the version that was checked: each chunk is sent only once it was read and the file still has that version, so a file read while it changes is `FILE_CHANGED`, and if a write changes or truncates the file while it streams, the response ends short before any byte of the new version. Shutting Outright down ends any file still streaming. Every response from the Files routes, once the server's own checks (host and origin, shutdown, recovery, archive maintenance) admit the request, names, in `X-Outright-Operation`, the record Outright keeps of it (for the last 256 requests: the worktree, path, operation, elapsed time, outcome and error code, never contents); with `OUTRIGHT_DEBUG=1` each record is also logged. Starting Outright with `OUTRIGHT_FILES=off` turns the Files routes off: each answers 503 `FILES_DISABLED` and is recorded like any other refusal. Files only reads, so turning it off, or rolling it back, leaves worktrees, their files and Outright's other records as they were.

Every Files request opens one handle on the worktree root, checks that it is the directory the root's path named when the request began, and resolves every path from it one name at a time: each name is looked up only inside the handle of the folder before it (`/proc/self/fd/<folder>` on Linux, `/.vol/<volume>/<folder>` on macOS 11 and later), and each folder on the way is opened from there without following a link (`O_NOFOLLOW_ANY` on macOS; 10.15 ignores that flag, so there nothing is proven). Folders that are only passed through, the worktree root included, need permission to enter, not to list. A folder stays trusted only while it is where the walk found it: after its entries, a link in it, or a file in it is read, it is proved still at that place inside the worktree (the kernel's path for its descriptor on Linux; on macOS each walked name looked up again from the root's identity), and a folder moved away in between, even within the worktree, is reported as changed, to retry. A preview proves the file's folder again after reading its bytes, and a raw image or PDF before sending its headers. Each proof is one observation: the root and every folder on the way are read before and after its checks, by identity on macOS and on Linux each by its one walked name inside the handle of the folder above it, never through a link, and must be the folders walked with unchanged change times (renaming a folder, or adding or removing a name in one, changes them), so a proof cannot be pieced together from moments between which a folder was outside. Linux sets change times from a clock that moves once a timer tick, so a change time less than 25 ms old is waited out first; a folder written to during a proof is proved again, at most three times. This needs change times kept to the nanosecond from this machine's clock: APFS on macOS; on Linux ext4, XFS, Btrfs, tmpfs, overlay, F2FS, ZFS or bcachefs, with sub-second times (not ext2, ext3 or ext4 with small inodes), and every folder and file whose change time a check uses must have a fraction of a second itself, so an inode of an older format is not read. A worktree, or a folder or file mounted inside one, on any other kind of volume (HFS+, FAT, exFAT, SMB, NFS, FUSE) is treated like an unsupported platform below. Not told apart: a folder moved away and back before a proof, and a file hard-linked into the worktree. Each needs someone who can already write outside the worktree as the same user; the checks keep crafted links and races from reading outside, and are not a sandbox. A link's destination is read as bytes and resolved by name against the folder it is in (one that is not UTF-8 is unreadable, as decoding it would name another file), and one ending in `/` or `/.` must lead to a folder, as it must for the kernel; if it leaves the worktree it is reported as outside before anything there is looked at, so Files never reveals whether a path outside exists. An absolute link counts as inside only when it spells the worktree's own canonical path. So renaming or replacing the worktree, a folder above it or a folder inside it, with or without links, cannot lead a read anywhere else; a change the request sees is reported as changed, to retry. A hard link to a file is the same file wherever it is named, so a file hard-linked into the worktree is shown like any other. On Windows, macOS 10.15, Linux without `/proc`, and a volume without nanosecond change times or (on macOS) without `/.vol`, a read cannot descend from the root's handle, so nothing below the root is looked at and listing and previews say they are unavailable for every name. Files on those platforms is deferred to OUT-144.

## Worktree setup and teardown

A repository can describe commands that prepare a new worktree and clean one up before removal, in `outright.worktree.json` at the worktree root:

```json
{
  "version": 1,
  "setup": [
    { "name": "Install dependencies", "command": ["npm", "ci"], "timeoutSeconds": 900 },
    { "name": "Copy local settings", "command": ["sh", "-c", "cp \"$OUTRIGHT_ROOT_PATH/.env\" .env"] }
  ],
  "teardown": [
    { "name": "Stop services", "command": ["docker", "compose", "down"] }
  ]
}
```

Each step is a program and its arguments, run without a shell unless you name one, in the worktree, with your environment plus `OUTRIGHT_WORKTREE_PATH`, `OUTRIGHT_ROOT_PATH` (the project's primary checkout) and `OUTRIGHT_LIFECYCLE_PHASE`. Like Outright's other utility processes, steps do not receive the credentials of direct-provider agents (`OUTRIGHT_ANTHROPIC_API_KEY` and `OUTRIGHT_ANTHROPIC_BASE_URL`). Steps run without a terminal, so a command that waits for input waits until it times out. A step's `timeoutSeconds` defaults to 600 and may be at most 3600. The file may hold at most 16 setup and 16 teardown steps and 64 KiB; any other field, or any invalid value, makes the whole file invalid, and nothing in it runs. On Windows, name `cmd` (`["cmd", "/c", "npm ci"]`) for commands that are batch files.

Nothing runs until you trust the file. Creating a worktree selects it and, when its file is not yet trusted or is invalid, opens **Worktree setup** (also in the worktree options menu) to show every command. Trust covers that project and the exact bytes you reviewed; a changed file asks again, and removing the project's trust through the runtime API (`DELETE /api/trust`) removes it; the app has no control for that yet. Trust covers only the command lines in the file: scripts and package hooks those commands run (`npm ci` install scripts, `sh scripts/setup.sh`) are not reviewed and can change, by a branch or an agent, without a new review. Names and arguments may not contain characters that render invisibly or reorder text, such as bidirectional controls and zero-width characters, so the commands you review look exactly like the ones that run. A project keeps its 16 most recently trusted versions, so branches with different files do not ask each time. Trusting a file runs setup only in the worktree you trusted it from, and **Trust without running setup** runs nothing, so a teardown that a removal refused for review runs before setup provisions again; other worktrees waiting on that file show **Run setup** until their setup runs.

Setup starts when the worktree is created and runs its steps in order. The toolbar shows the current step, and Worktree setup shows the output; new agent runs in the worktree are refused until setup or teardown finishes, and a queued, recovered or resumed run there waits and starts when it does. Setup and teardown do not start while an agent run in that worktree is queued or running. At most four setup or teardown steps run at once across all worktrees, on their own process budget, so Git, project scans and removal keep theirs; a step that finds that budget full fails with that reason and can be retried. A step that exits with a non-zero status, times out, or is cancelled stops the run, and the worktree is reported as failed, cancelled or interrupted, never as ready. A retry resumes at the step that did not finish, so finished steps do not run again; a step starts only after the progress before it is saved, and a run whose outcome cannot be saved is reported as failed, never as ready, while a cancel accepted while it is saved is reported as cancelled and a retry only records it; trust removed during a run stops it before the next step; a changed file starts from the first step, and Worktree setup marks steps only for the file version that ran them. Setup and teardown keep separate resume points: a teardown attempt keeps setup's, while starting setup discards teardown's, because setup provisions again and teardown must then start over. An untrusted or invalid file refuses the run but keeps them. A setup that finishes clears both; a teardown that finishes leaves only removal. Progress belongs to one worktree: a worktree created again at the same path, by Outright or outside it, starts setup from the first step. Cancelling, a timeout, or quitting Outright ends the step's whole process tree, including programs it started in the background. If Outright cannot confirm that tree ended, or it quit without stopping a step, the state says so: agent runs in that worktree wait, new ones are refused, and setup or teardown runs again, and the worktree can be removed, only after you acknowledge that attempt in Worktree setup or the removal dialog. An acknowledgement covers only the attempt you were shown, and each one is recorded in the audit log. The hold also ends when Outright proves the tree gone, which it checks when it starts and after an operator releases the step's process owner through the runtime's owner-release API (`POST /api/capacity/utility-owners/<id>/release`); Settings shows unconfirmed owners but has no release control. Setup and teardown also wait while an interrupted agent run in the worktree is unresolved. Steps should still be safe to run again: an interrupted step may have done part of its work.

Removing a worktree runs its teardown steps first, after the usual checks and a fresh Git status: a worktree with uncommitted or untracked changes, including ones made after the last scan, is refused before any teardown step runs, as is one whose status Git cannot report. If a step fails or is cancelled, or the file is untrusted or invalid, the worktree is kept and the removal dialog says why and asks what to do next: run teardown again from the failed step, or **Remove without running teardown**, which removes it without cleanup. When processes from the last setup or teardown could not be confirmed stopped, the worktree is removed, with or without teardown, only after you acknowledge that in the removal dialog. While a removal runs, **Cancel removal** in the removal dialog stops it before Git starts removing and keeps the worktree; once Git starts, cancelling is refused. Closing the dialog does not stop the removal. If teardown finishes but the worktree is kept, by a cancel or by Git, a retry goes straight to removal, also after a restart.

Output is kept as plain text, with terminal colors and control characters removed: the newest 32 KiB of each run while Outright runs, and with a failed, cancelled or interrupted state across restarts. The output of a run that finished is not stored. Outright keeps the setup and teardown state of 512 worktrees; past that, only finished states give way, while a failure, a resume point or a teardown waiting for removal is kept until its worktree is removed or no longer exists. Before output is shown, kept or saved, Outright masks credentials in it, and in a step's error, which is masked whole before it is shortened. Each step's output starts with its program and how many arguments follow, never the arguments, which can hold credentials in forms no mask recognizes; the trust review shows each command exactly as it runs. Outright masks: the values (8 characters or longer, also as they read escaped in JSON) of environment variables whose names contain token, secret, password, credential, auth (not in author names or `SSH_AUTH_SOCK`) or key as a separate word (`SIGNING_KEY`, `API_KEY`), common token formats, `name=value` and `name: value` assignments whose names contain those words, `Authorization` headers (a quoted value masked through its closing quote, or to the end of the line if it never closes), `Bearer` and `Basic` credentials, passwords in URLs and private key blocks. Masking works on whole lines, so a line appears once it ends; a line still unfinished past 4096 characters is not shown, kept or saved, and appears as `[output line longer than 4096 characters withheld]`. A secret in a format Outright does not recognize still shows. Output stays on this computer and out of the audit log, which records only each run's step names, file digest and committed outcome.

## Worktree checkpoints

Checkpoints need runtime support that is still landing: until the runtime serves them, the dialog reports that checkpoints are not available in this version of the runtime and offers Retry, and the behavior below does not apply yet. A list that cannot be read for another reason is reported the same way, with Retry.

**Checkpoints** in the worktree options menu records the worktree as it is now, for example before a risky agent run: the index (staged changes), the files on disk (unstaged changes) and untracked files, kept apart. Taking one changes nothing in the worktree, its index, its branch or the stash. Files Git ignores (`.gitignore`, `.git/info/exclude`, `core.excludesFile`) are never recorded, and a restore never changes them. Submodules and nested repositories are recorded only as commit pointers; their contents are not captured. A path added with `git add -N` comes back as an untracked file. Untracked files can hold secrets: they are stored as Git objects in the repository's own `.git` directory under the per-worktree ref namespace `refs/worktree/outright/checkpoints/`, which `git push` does not send unless you push that namespace or mirror the repository. Removing the worktree removes its checkpoints.

Changed and untracked files are recorded byte for byte, as the type they are on disk (file or symbolic link), with no line-ending conversion (`core.autocrlf`, `text`/`eol` attributes), clean filter or encoding applied, and a restore writes them back exactly; a tracked file Git reports unchanged keeps its index entry and is checked out by Git when restored. Taking a checkpoint never runs a clean filter, so a failing or slow one cannot stop it.

A checkpoint is refused when one staged, changed or untracked file is over 64 MiB, when they total over 256 MiB, or when more than 10,000 paths differ from HEAD (deletions included); staged content counts even when the file on disk matches it. A restore first takes a checkpoint of the worktree as it is, so it is refused, saying so, while the worktree is over these limits; on the commit a checkpoint was taken on, a restore is never too large, while across a moved HEAD one that would change more than 20,000 paths is refused. Each worktree keeps its newest 20 checkpoints, while their recorded content stays within 1 GiB; older ones are removed when a new one is taken, and Git reclaims their space in its next garbage collection. A checkpoint can also be deleted.

Inspect lists what a checkpoint holds, by state, with staged renames. A restore always starts with a preview of every path it changes: whether the file is created, replaced or deleted, and whether the index entry is staged, restaged or unstaged, with the difference for each file and, apart from it, for each staged change. You choose the paths; a path whose file and directory forms both change is restored together with the others. A path is not offered when something Git ignores, or a nested repository, is where the checkpoint's file would go, including inside a directory the file replaces. On a filesystem that ignores case (the macOS and Windows default), a file renamed only by case is restored together with the file it replaces. The preview names a HEAD that moved since the checkpoint; the branch and its commits never change. The restore is confirmed against that exact preview: if anything in the worktree changed since, it is refused and a new preview is shown. Before it changes anything, Outright takes a checkpoint of the current state, so every restore can be undone.

A restore is refused while an agent run in the worktree is queued or running, while setup or teardown runs or its processes are unconfirmed, while an interrupted agent run there is unresolved, while Outright is staging, unstaging or committing there or one of those lost track of its Git process (until Outright proves it gone, across restarts too), while a terminal is starting there, while another Git command holds the index lock, and during a merge, rebase, cherry-pick or revert. Terminals open in the worktree must be confirmed first, because Outright cannot tell whether a shell is writing. While a restore runs, new agent runs, setup and teardown, new terminals, and stages, unstages and commits there are refused, and queued agent runs wait. A restore records what it restores in the worktree's Git directory before it changes anything; if it stops part way, by an error or by Outright quitting, that record keeps holding the worktree the same way, across restarts, and the dialog offers **Finish restore…** or **Keep files as they are**. Finishing is previewed and confirmed like a restore, from the worktree as it is then, so changes made since it stopped are shown and kept in a new checkpoint first. When a Git process the restore started could not be confirmed stopped, neither is possible until Outright proves it gone. Each capture, restore, recovery and deletion is recorded in the audit log, without file contents.

## Keyboard shortcuts

- `Cmd/Ctrl K`: project, worktree, and conversation search
- `Cmd/Ctrl N`: new conversation
- `Cmd/Ctrl Shift T`: open or focus the terminal pane
- `Cmd P` on macOS, `Ctrl P` elsewhere: open the Files pane and focus Go to file
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

The suite covers provider command construction and event normalization, SQLite recovery, PTY input/output, Git review/staging/commits, guarded worktree lifecycle including trusted setup and teardown, worktree checkpoints, scanner parsing, and browser interaction regressions. Install Chrome or Chromium before running `npm test`; the browser suite fails explicitly rather than skipping coverage if it cannot find an executable. GitHub CI runners include Chrome, and `CHROME_PATH` overrides the detected location.

## Terminal Find

Find searches the output the terminal still holds: the last 5,000 lines of a live terminal, or the shown part of saved output. The query is literal, not a regular expression, and ignores case using Unicode case folding, so `STRASSE` finds `Straße`; a match may span a wrapped line. The bar shows the current match and the total, such as `3 of 12`, and screen readers hear the same when you search or move between matches; a count that only new output changed is announced at most every 5 seconds. When there are more than 1,000 matches, only the newest 1,000 are counted and navigable, shown as `1000+`; a match inside one character that case folding expands, such as `s` in `ß`, counts that character once. A new query selects the newest match at or above the bottom of the view. Output that arrives while Find is open updates the count without moving the view; the current match stays current, and highlighted where lines inserted or deleted above it or a resize moved it, until its line leaves the scrollback, newer output pushes it out of the newest 1,000 matches, or the terminal is reset. A width change that rewraps the current match within its own line drops it. Find highlights only its current match in amber; once you start a selection in the terminal, type or paste there, Find leaves that selection alone, even while you are still dragging it or right after a resize, and a press that selects nothing, such as one on the scrollbar, a right-click on the highlight or a click a program tracking the mouse receives, leaves Find's highlight in place. Find keys never reach the process: the shortcut is withheld, typing goes to the query, `Escape` from any Find control closes it, and `Escape` in the terminal itself still goes to the program. The bar overlays the right of the top rows, so opening it does not resize the terminal. A match left of the bar stays where it is; one under it, or one that wraps below the view, is scrolled into the open, whole when it fits, and near the top of the output, where the view cannot scroll, the bar moves to the bottom instead.

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
