# ColdStart — ARCHITECTURE

> **Status: PROPOSAL** — adversarial panel #1 running against this proposal; this doc becomes the settled record once amended. `ARCHITECTURE.md` is the living doc; `SPEC.md` is the canonical design record (§4 holds the full facade-spine diagram — referenced, not duplicated, below).

## Current proposal (A2.5, from ROADMAP.md — pending adversarial panel #1)

Cloudflare-first (wrangler already authed; deployable with zero new accounts): Workers + Hono facade, Durable Objects for tenant state + provisioning jobs (DO alarms natively model weeks-long resumable warmup), D1 for the control-plane ledger, Queues where fan-out needs it, Pages for the sites, Workers Cron for ops loops. The forked Go engine (cold-cli) needs long-lived IMAP/SMTP — that cannot run on Workers; proposal: design the engine contract-first with a native sandbox implementation in the Worker, and treat the Go fork + container host as a real-adapter concern at activation. Panel #1 attacks this before it's final.

## Facade spine / 3 planes (summary — full diagram in SPEC.md §4)

Customer's agent → **Surface** (curated ~8–12 tool MCP + CLI twin + discovery skill) → **Plane C** (Facade/Orchestration API: intents, guardrails, metering, audit) → **Plane B** (Provisioning service: async resumable jobs — domains, DNS, mailboxes, warmup) → **Plane A** (Identity & Billing: signup, Stripe, quotas, tenant↔vendor mapping) → underneath: registrar API, mailbox-vendor API, forked cold-cli, Claude ops AI.

Design rule: few, high-level intents that hide vendor complexity — the simplicity wedge and what keeps MCP token cost negligible.
