# OUT-31 Accessibility and Narrow-Screen QA

Updated: 2026-09-24

## Automated coverage

The required `npm test` browser regression suite needs Google Chrome or Chromium;
set `CHROME_PATH` to the executable on machines without a standard installation.
Missing Chrome fails the suite rather than silently dropping the interaction checks.

- `SHELL=/bin/bash npm test`: 160 passed, 1 platform skip on macOS, including keyboard tab navigation, safe DOM IDs, semantic roles, terminal screen-reader mode, live regions, responsive fallbacks, and headless browser interactions. The local zsh startup update prompt corrupted the unrelated PTY sentinel in a plain `npm test` run; the configured bash shell passed the same full suite.
- `npm run build`: production client/server/Sites artifacts built successfully.
- `npm run test:sites`: 4 Sites packaging and routing tests passed.
- Browser interaction harness: 20 checks passed, including breakpoint synchronization, modal drawer isolation/focus containment, inspector focus restoration, horizontal chat/inspector tab keys, terminal reconnect ownership, and a same-pane metadata change during pending creation and deletion. Node tests check escaped private-profile helper cleanup with file-backed output, bounded CDP requests and handshake, and cleanup after an injected browser failure. The previously reported intermittent macOS full-suite browser timeout did not reproduce in this round; the new phase/deadline diagnostics and exact-head cross-OS run still need independent review.

## Keyboard and accessibility-tree checks (not a screen-reader session)

Tested against the live local runtime with the browser accessibility tree.

- 390 × 844 narrow viewport: sidebar starts closed, opens as a modal overlay, makes the workspace inert and hidden from assistive technology, contains keyboard focus, closes with Escape or the backdrop, and returns focus to the opener.
- Project navigation: Up/Down/Home/End move focus through the visible group, project, worktree, and project-action controls.
- Chat tabs: expose `tablist`/`tab`/`tabpanel` relationships with roving focus and Arrow/Home/End navigation.
- Inspector: becomes a full-width narrow-screen surface; Changes, Terminal, and Context expose tabs, support arrow-key switching, and restore focus to the toolbar invoker after Escape or close-button dismissal.
- Terminal: exposes a labeled panel, screen-reader buffer, session tabs, loading status, and keyboard session switching.
- Command palette: exposes a combobox/listbox relationship, result count announcements, active-descendant state, and Arrow/Home/End/Enter navigation.
- Dialogs: retain labeled fields and reachable actions at 390px, including the full settings form without horizontal clipping.
- Errors, success notices, connection state, run state, loading state, and streaming activity expose alert/status live regions.
- 640 × 800 viewport (1280px page at 200% zoom equivalent): crossing the breakpoint closes the desktop sidebar without displacing composer focus; no horizontal page overflow; project/worktree hierarchy and conversation tabs remain intact.
- Reduced-motion preference disables nonessential animation and transition duration.

## Manual assistive-technology acceptance still required

The keyboard and browser accessibility-tree checks above are not manual assistive-technology testing. A human session with VoiceOver/Safari on macOS or NVDA/Chrome on Windows remains necessary to record actual spoken names, announcements, and navigation for the narrow project drawer (open, contained navigation, Escape/close), project/worktree hierarchy, conversation and inspector tabs, settings/dialog validation and status, and terminal input/output, session switching, loading and exit. Record the platform, browser, AT version, viewport/zoom, observed speech, and any defects before declaring OUT-31 accepted. This headless run did not activate a screen reader; the macOS display was asleep and VoiceOver was not running. Do not treat the AX-tree observations above as AT evidence.

## Scope note

The current application does not yet expose the future workflow/loop authoring surfaces tracked in OUT-8 and OUT-40. The shared keyboard, focus, status, dialog, tab, and responsive patterns implemented here are the acceptance baseline those surfaces should reuse.
