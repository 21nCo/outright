# OUT-31 Accessibility and Narrow-Screen QA

Date: 2026-09-23

## Automated coverage

- `npm test`: 47 tests passed, including keyboard tab navigation, safe DOM IDs, semantic roles, terminal screen-reader mode, live regions, and responsive fallback guards.
- `npm run build`: production client/server/Sites artifacts built successfully.
- `npm run test:sites`: 4 Sites packaging and routing tests passed.
- Browser interaction harness: 4 race-condition and terminal reconciliation checks passed.

## Manual keyboard and accessibility-tree checks

Tested against the live local runtime with the browser accessibility tree.

- 390 × 844 narrow viewport: sidebar starts closed, opens as an overlay, moves focus into the drawer, closes with Escape or the backdrop, and returns focus to the opener.
- Project navigation: Up/Down/Home/End move focus through the visible group, project, worktree, and project-action controls.
- Chat tabs: expose `tablist`/`tab`/`tabpanel` relationships with roving focus and Arrow/Home/End navigation.
- Inspector: becomes a full-width narrow-screen surface; Changes, Terminal, and Context expose tabs and support arrow-key switching.
- Terminal: exposes a labeled panel, screen-reader buffer, session tabs, loading status, and keyboard session switching.
- Command palette: exposes a combobox/listbox relationship, result count announcements, active-descendant state, and Arrow/Home/End/Enter navigation.
- Dialogs: retain labeled fields and reachable actions at 390px, including the full settings form without horizontal clipping.
- Errors, success notices, connection state, run state, loading state, and streaming activity expose alert/status live regions.
- 640 × 800 viewport (1280px page at 200% zoom equivalent): no horizontal page overflow; project/worktree hierarchy and conversation tabs remain intact.
- Reduced-motion preference disables nonessential animation and transition duration.

## Scope note

The current application does not yet expose the future workflow/loop authoring surfaces tracked in OUT-8 and OUT-40. The shared keyboard, focus, status, dialog, tab, and responsive patterns implemented here are the acceptance baseline those surfaces should reuse.
