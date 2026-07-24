# Coldrig (working name ColdStart) — ARCHITECTURE

> **Status: SETTLED** (amended by adversarial panel #1, 2026-07-09). `ARCHITECTURE.md` is the living architecture record; `SPEC.md` is the canonical *design* record (§4 holds the facade-spine diagram — referenced, not duplicated). Panel amendments traced in `docs/adversarial/panel-01/SYNTHESIS.md`.

## Topology — HYBRID (Cloudflare control plane + external engine)

The panel killed the "pure Cloudflare-first" proposal: a cold-email product's core act is long-lived IMAP/SMTP, which serverless cannot host. Settled split:

```
                 customer's Claude Code / Codex
                          │  one MCP line + token   |   npx agent-cold-email ...
                          ▼
   ┌─────────────────── CLOUDFLARE (control plane, sagas, surfaces) ───────────────────┐
   │  Pages          public sites + AEO content + docs (crawlable, authority-accruing)  │
   │  Worker (Hono)  Plane C facade: ~12 curated intents, guardrails, metering, audit   │
   │  McpAgent       hosted MCP (Agents SDK, streamable HTTP, per-token scoped)         │
   │  TenantDO       per-tenant state + MONEY LEDGER (SQLite, integer cents, txns)       │
   │  ProvisioningDO resumable saga: buy domain→DNS→mailbox→warmup ramp (alarm-driven)   │
   │  Queues         fan-out (send batches, provisioning steps) — at-least-once          │
   │  D1             control-plane index + read-model for cross-tenant reporting         │
   │                 AND the abuse-aggregation loop (master-account protection)          │
   │  Cron           ops loops: deliverability monitor, digests, dunning sweeps          │
   └───────────────────────────────────┬───────────────────────────────────────────────┘
                                        │  Worker↔engine boundary contract (designed now)
                                        ▼
   ┌──────────── EXTERNAL ENGINE (activation-hosted; sandbox = native in-Worker) ────────┐
   │  Node daemon (apps/engine — nodemailer/imapflow): 24/7 SMTP send + IMAP poll,        │
   │  bounce/reply/thread detection, HTTP boundary (/health, /v1/send, /v1/poll).         │
   │  Host: single droplet per ACTIVATION Gate-2 runbook; real-adapter only.              │
   └─────────────────────────────────────────────────────────────────────────────────────┘
                                        │
                    registrar API (Porkbun) · mailbox vendor API (Inboxkit primary)
                    · Stripe (source of truth for billing) · Claude (ops AI)
```

## Load-bearing decisions (settled)

1. **Vendor adapter layer (`VendorPort`).** Every external dependency (domains, mailboxes, warmup, metrics, email-send/read, payments) sits behind a typed port with two implementations: `sandbox` (active in test mode) and `real` (coded to vendor docs, unactivated). **One contract-test suite runs against both** — the real-adapter swap must be a provable no-op. Ports are frozen only after the local-mailserver engine spike.

2. **Sandbox = fault-injecting, clock-aware simulator**, never a happy-path mock. It injects rate limits, 5xx, timeouts, async bounces, provisioning failures, partial batches, and duplicate deliveries. This is a first-class product surface (free tier + no-signup demo), not scaffolding.

3. **Money ledger in TenantDO SQLite** (integer cents, real transactions). Stripe is the source of truth; per-tenant webhook handling is idempotent. D1 is NOT the ledger — it is the control-plane index + a Queues-fed read-model for cross-tenant reporting and abuse aggregation (which has no home in a pure per-tenant-DO design). Keeps the eventual D1→Postgres swap trivial.

4. **Single injected Clock.** No direct wall-clock reads anywhere (CI lint gate). Warmup ramp + send scheduling run on a DO-alarm scheduler driven by the injected clock — so weeks-long warmup is testable in minutes AND stays honest. NOT Cloudflare Workflows (can't be virtual-clocked).

5. **Idempotency keys on every side-effecting `VendorPort` op.** At-least-once Queues + retried DO alarms on money/provisioning ops is a correctness trap otherwise. The sandbox simulates duplicate delivery + mid-step crash so idempotency is exercised in test mode.

6. **Engine is out of Worker scope.** IMAP/SMTP long-lived connections belong to an external daemon. Built as **Node** (`apps/engine/`, committed `eb8ee42` after re-attack #3 SHIP) on the A5-validated nodemailer/imapflow/mailparser stack — Node-over-Go ratified 2026-07-14 (buildable-today; the original plan was a Go cold-cli fork, MIT-verified 2026-07-09, kept as fallback). Host = single droplet per ACTIVATION Gate-2 runbook; scale-out swaps the in-memory in-flight claim for a shared store (documented in `apps/engine/src/store.ts`).

7. **MCP via Agents SDK `McpAgent`** (streamable HTTP, per-token auth). The paste-one-token remote-MCP config must be verified to actually connect in both Claude Code and Codex (distribution-critical; screenshot gate in Phase C).

8. **Compliance is enforced in code, not documented.** Per-tenant physical address + sender identity (captured at setup) injected into every footer (sandbox exercises the real render path so a gap fails a test); the lookalike third-party-brand hard-reject validator lives in the engine (`engine/brand-guard.ts`, called at the `setup_infrastructure` boundary before any domain purchase): a well-known-brand denylist plus a brand↔primaryDomain ownership-consistency check, with a test that fails on a third-party brand (full cryptographic domain-ownership verification is an activation step); subject-line honesty; full CAN-SPAM opt-out flow; OFAC screen + onboarding friction ladder before uncapped real sends; free/demo tenants structurally incapable of a real adapter (type guard + failing-if-violated test).

## Facade spine / 3 planes (summary — full diagram SPEC.md §4)
Customer's agent → **Surface** (~12-tool MCP + CLI twin + discovery skill) → **Plane C** (facade: intents, guardrails, metering, audit) → **Plane B** (provisioning sagas) → **Plane A** (identity & billing) → vendors. Design rule: few high-level intents that hide vendor complexity — the simplicity wedge and negligible MCP token cost.
