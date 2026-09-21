# Outright Design QA — Option 1 Revision

## Evidence

- Source visual truth: `design/reference-option-1.png`
- Browser implementation: `design/implementation-option-1-1440x1024@2x.png`
- Side-by-side comparison page: `design/qa-compare-option-1.html`
- Side-by-side proof: `/Users/serro/.synara/codex-home-overlay/generated_images/browser-proof/ba1984b3ccf7c57d29ead3ef/efd30631-1eec-4dfc-b499-57796749877e.png`
- Final dark-theme proof: `/Users/serro/.synara/codex-home-overlay/generated_images/browser-proof/ba1984b3ccf7c57d29ead3ef/b480eae1-926a-4b21-8a52-ea2655c71b27.png`
- Light-theme proof: `/Users/serro/.synara/codex-home-overlay/generated_images/browser-proof/ba1984b3ccf7c57d29ead3ef/5db522d1-48ba-47f6-b409-1e43c0a038e9.png`
- Viewport: 1440 × 1024 CSS pixels at deviceScaleFactor 2

## Findings

No actionable P0, P1, or P2 visual differences remain.

- Layout and hierarchy: the implementation follows option 1's single expanded sidebar plus one broad conversation workspace. The explicit product change is preserved: chats are tabs above the main area instead of rows beneath worktrees.
- Sidebar anatomy: group → project → worktree nesting is legible, compact, and uses real scanned Git state. Chats never appear in the sidebar.
- Typography and iconography: the exact `bIkfpWS` preset is installed with Vega style, neutral tokens, DM Sans, and Phosphor icons.
- Color and themes: the neutral preset is used instead of the reference's coral accent as explicitly requested. System, Light, and Dark modes were all exercised in the browser.
- Density and rhythm: the 344px sidebar, compact rows, thin separators, restrained radii, tab strip, centered message column, and persistent composer retain the selected IDE-like density.
- Assets: the reference contains no custom raster product assets. Interface symbols come from Phosphor; no emoji or handcrafted SVG substitutes are used.
- Accessibility: icon-only controls have labels, chat selection uses tab semantics, dialogs are labeled, and menu composition follows the generated Base UI/shadcn primitives.

## Interaction Verification

- Created a `Launches` project group and moved the real `outright` project into it; the membership persisted.
- Switched among existing chat tabs, created `Trace worktree lifecycle`, sent a message, and closed the tab.
- Collapsed and restored the sidebar.
- Selected System, Light, and Dark theme modes and verified local persistence.
- Confirmed the live Git scanner API and real worktree state remain connected.
- Corrected a Base UI menu-group composition error found during browser QA; the grouping and theme menus then passed.

## Comparison History

### Iteration 1

- Replaced the earlier option-2 four-region shell with the option-1-style expanded sidebar and single main workspace.
- Removed all nested chat rows and the right inspector; added the main-area tab strip.
- Added persistent project groups, group creation, and project reassignment.
- Installed and applied the exact shadcn preset and its required Tailwind foundation.

### Iteration 2

- Browser QA exposed a missing Base UI `Menu.Group` wrapper in generated menu composition.
- Wrapped menu labels correctly, reran grouping and theme flows, and removed nested interactive chat-tab markup.
- Final normalized side-by-side comparison found no remaining P0/P1/P2 issues.

## Follow-up Polish

- P3: the live sidebar is longer than the reference because it intentionally renders the actual discovered repository inventory.
- P3: live branch names and dirty counts replace the mock's illustrative Git state.

## Implementation Checklist

- [x] Match the selected option-1 composition.
- [x] Nest worktrees under projects and projects under user-created groups.
- [x] Keep chats out of the sidebar and render them as main-area tabs.
- [x] Use shadcn preset `bIkfpWS`, Tailwind, Phosphor, and DM Sans.
- [x] Support System, Light, and Dark themes.
- [x] Preserve live read-only Git discovery and persistent preview hosting.
- [x] Pass build, unit, Sites packaging, interaction, and visual QA.

final result: passed
