# src/ops-mail

The platform's **outbound ops-email channel** — founder alerts from the
watchtower, dunning-suspend notices to tenants + a founder copy, and any other
operator email. Modeled on the `VendorPort` house style (`src/vendors/`): one
`OpsMailer` interface, a real impl, a sandbox impl, and a factory choke point.

- `ops-mailer.ts` — the `OpsMailer` interface, `OpsEmailMessage` shape, the
  fixed sender identity (`ops@coldrig.dev` / "coldrig ops"), the typed
  `OpsMailNotConfiguredError`, and `createOpsMailer(env)` (the single real-vs-
  sandbox decision, mirroring `vendors/factory.ts`).
- `real-ops-mailer.ts` — `RealOpsMailer` over the Cloudflare Email Service
  `send_email` binding (`env.OPS_EMAIL`, wrangler.toml `[[send_email]]`). No
  API keys. Structured builder-API send (`{to, from, subject, html, text}`),
  always html+text.
- `sandbox-ops-mailer.ts` — `SandboxOpsMailer`, records sends in `.sent` for
  tests. No network.

## Dark by design

This ships **dark**. The `send_email` binding is optional in `env.ts`; the
domain is onboarded later by the owner (`wrangler email sending enable
coldrig.dev`, ACTIVATION.md — needs an `email_sending`-scoped token). Until
then:

- Binding absent → `RealOpsMailer.send()` throws `OpsMailNotConfiguredError`.
- Binding present but domain un-onboarded → the underlying `.send()` throws the
  Email Service's own `E_SENDER_NOT_VERIFIED`.

**Every caller must catch both** and degrade to log-only. An ops alert that
cannot be sent must NEVER take down a request path or the ops sweep. See
`src/admin/watchtower.ts` and `src/admin/ops-sweep.ts` for the catch-and-log
call sites.

## How to run / test

Part of `apps/platform`; no standalone build. Tests inject a `SandboxOpsMailer`
into the sweep/dunning/watchtower functions and assert `sent` — see
`test/watchtower.test.ts` and `test/admin-dunning-email.test.ts`. No real email
is ever attempted in tests or dev.

## Depended on by

`src/scheduled.ts` (constructs `createOpsMailer(env)` once per sweep),
`src/admin/ops-sweep.ts` (dunning notices), `src/admin/watchtower.ts` (alerts).
