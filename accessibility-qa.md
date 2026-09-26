# OUT-31 Accessibility and Narrow-Screen QA

Updated: 2026-09-24

## Automated coverage

The required `npm test` browser regression suite needs Google Chrome or Chromium;
set `CHROME_PATH` to the executable on machines without a standard installation.
Missing Chrome fails the suite rather than silently dropping the interaction checks.

- `npm test`: 164 passed, 1 platform skip on macOS, including keyboard tab navigation, safe DOM IDs, semantic roles, terminal screen-reader mode, live regions, responsive fallbacks, and headless browser interactions.
- `npm run build`: production client/server/Sites artifacts built successfully.
- `npm run test:sites`: 4 Sites packaging and routing tests passed.
- Browser interaction harness: 23 checks passed, including settings archive of a selected chat with a sibling: the remaining tab is selected, reachable with a native Tab key, labels its panel, and retains arrow navigation; inline archive of the last chat leaves no stale selected tab. A held tab-buffer/reconnect interleaving retains the selected terminal tab, focus, output, and authoritative refetch; repeated exit/close cycles use stable xterm callbacks and retain the exit banner. The 95-second pre-cleanup deadline retains 25 seconds for child cleanup; the nested parent's 135-second exit window exceeds the child's 120-second total allowance and reserves another 25 seconds for parent cleanup. Polling preserves last-step diagnostics across missing/exceptional evaluation results. The focused browser run, `npm test` (including an injected-failure browser run), build, and Sites checks passed locally. An earlier *concurrent* standalone run alongside `npm test` timed out and left one Vite server, which was terminated and verified gone. This is not a green cross-OS or concurrent-execution proof; fresh exact-head CI and independent review remain required.

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

## Manual assistive-technology session deferred to OUT-45

The keyboard and browser accessibility-tree checks above are not manual assistive-technology testing. On 2026-09-25 the owner deferred the spoken-flow session until after the current implementation backlog, tracked by [OUT-45](https://linear.app/21n/issue/OUT-45/run-post-backlog-screen-reader-acceptance-across-outright-workflows). A missing VoiceOver/Safari or NVDA/Chrome session alone is therefore not an OUT-31 PR or merge-readiness blocker. OUT-31 still requires its keyboard, semantics, responsive, automated, and independent code-review gates; this deferral does not claim full-product screen-reader acceptance.

OUT-45 will record actual spoken names, announcements, and navigation for the integrated drawer, project/worktree hierarchy, conversation and inspector tabs, command palette, settings/dialog validation and status, terminal input/output/loading/exit, and the workflows implemented by then. It will capture platform, browser, AT version, viewport/zoom, observed speech, and defects. The current headless run did not activate a screen reader; do not treat its AX-tree observations as AT evidence. The command-palette result-announcement cadence flagged in PR review is part of OUT-45's spoken-flow check.

## Scope note

The current application does not yet expose the future workflow/loop authoring surfaces tracked in OUT-8 and OUT-40. The shared keyboard, focus, status, dialog, tab, and responsive patterns implemented here are the acceptance baseline those surfaces should reuse.
