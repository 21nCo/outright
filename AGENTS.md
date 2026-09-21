# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Durable product direction: use the expanded option-1-style sidebar with project groups, projects, and worktrees nested in that order. Keep chats out of the sidebar and show them as tabs above the main conversation. Use shadcn preset `bIkfpWS` (Vega/neutral), Tailwind, Phosphor icons, DM Sans, and System/Light/Dark theme choices.

Production direction: incrementally bring Outright to daily-driver ADE parity with Orca, Superset, and Synara. Treat security boundaries, durable recovery, bounded resource use, responsive and accessible interaction, and long-session performance as launch gates rather than follow-up polish.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
