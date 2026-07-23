---
name: coldstart-miniflare-send-email-binding-truthy-in-tests
description: In ColdStart's apps/platform vitest-pool-workers harness, env.OPS_EMAIL (the `[[send_email]]` binding) is TRUTHY under test — Miniflare auto-simulates it locally (writes to temp files) — contradicting env.ts's own doc comment ("Never bound in tests/dev, the sandbox mailer records instead"). createOpsMailer(env) therefore returns RealOpsMailer, not SandboxOpsMailer, for any route that calls it directly (not via DI).
metadata:
  type: project
---

Hit 2026-07-23 building magic-link login (`routes/login.ts`), which calls
`createOpsMailer(c.env)` directly inside an HTTP route (no injectable mailer
param, unlike every existing sweep/dunning/watchtower function). A test that
monkey-patched `SandboxOpsMailer.prototype.send` to prove the `ctx.waitUntil`
fix (adversary NB2 — response must not block on the send) passed for the
WRONG reason: it never touched the actual code path, because
`env.OPS_EMAIL` is truthy in this harness (confirmed via a probe test —
`type=object`), so `createOpsMailer` picked `RealOpsMailer`. The console
showed `[send_email binding called with MessageBuilder]` writing to a
Miniflare temp dir on every send in EVERY test file that exercises signup —
this is Miniflare's real local-dev simulation of the Cloudflare Email Service
binding, not a mock the test wrote.

**Why:** `env.OPS_EMAIL` is a declarative `[[send_email]]` binding in
`wrangler.toml`, not a `.dev.vars`-sourced key — `hermetic-env.ts`'s
neutralization sweep only touches keys parsed out of `.dev.vars`/
`.dev.vars.example`, so a wrangler.toml-declared binding is completely
outside its scope and reaches the test `env` exactly as Miniflare
provisions it (present + working, matching production's shape).

**How to apply:** before writing any test that needs to distinguish
Real-vs-Sandbox mailer behavior (timing, content) through the actual HTTP
route (not by directly injecting a mailer instance into a function param),
first probe `env.OPS_EMAIL` truthiness in this exact harness — don't trust
the `// Never bound in tests/dev` comment in `env.ts`. If truthy, patch
`RealOpsMailer.prototype.send` (restore in `finally`), not
`SandboxOpsMailer.prototype.send`. Always do a deliberate RED/GREEN check
(temporarily break the fix, confirm the test fails for the right reason)
rather than trusting a first green run — this exact mistake produced a
vacuously-passing test on the first try.
