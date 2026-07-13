# ColdStart — MEMORY (durable project facts)

- Program start date: 2026-07-09.
- Owner interview answers are in SPEC.md §0 and are FINAL (no further questions until the final report).
- Auth landscape (verified 2026-07-09): GitHub CLI authed as `YS-projectcalc`; wrangler authed as `yaakovscher@gmail.com`; npm NOT authed on this machine.
- Name candidates verified available 2026-07-09: `coldrig` / `coldpipe` — GitHub + npm + .dev/.sh/.io all free; `coldloop` — GitHub + npm + .dev free.
- Prior-art archive: `~/.claude/priorart-archive/ai-agent-controllable-cold-email-platform-2026-06-25.md`; dashboard/inbox lane: `~/.claude/priorart-archive/agent-controlled-dashboard-unified-inbox-coldrig-2026-07-12.md`.
- Test-suite lesson (2026-07-13): `@cloudflare/vitest-pool-workers` runs ALL test files against ONE shared per-project Miniflare; vitest's default `fileParallelism` at ~40+ files causes intermittent ECONNRESET/timeout flakes that vanish in isolation. Fix is `test.fileParallelism: false` in `apps/platform/vitest.config.ts` — do not remove it, and do not chase such flakes as test-logic bugs first.
- Render-at-action-time lesson (2026-07-13): any templated value shown later (email subjects/bodies) must be substituted AND STORED RENDERED at the action (send) time — the send path originally never substituted `{{vars}}`, so every stored artifact carried literal templates and no read path could repair it (`engine/template.ts` + rendered `sent`-event metadata is the fix; inbox v2 prefers the sent event's rendered subject).
- Workers static-assets lesson (2026-07-12, detail in `apps/platform/public/README.md`): `not_found_handling = "single-page-application"` serves the assets-dir ROOT `index.html` (not per-directory walk-up) — hence the deliberate duplicate `public/index.html` ↔ `public/app/index.html`, synced by the dashboard build's postbuild copy.
