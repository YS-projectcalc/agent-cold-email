# Security Policy

## Current state

This project is **live in production**: real sending is live for activated tenants (Gmail API, HTTPS/443), alongside a sandbox vendor layer for un-activated and demo tenants. Billing still runs on Stripe test keys (no real vendor spend yet), and there is no real customer data yet. There is no bug bounty program at this stage.

That does not mean security reports are unwelcome — the control-plane, auth, tenancy-isolation, and billing-ledger code is real and is where a report is most valuable before real customers exist.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security report.** Instead, email:

**security@epiphanymade.com**

Include:

- A description of the issue and its potential impact.
- Steps to reproduce (a minimal repro against this repo, ideally).
- Whether you believe it affects tenant isolation, auth/token handling, the money ledger, or vendor-credential handling — these are the highest-severity classes here (see `CLAUDE.md` rule h: per-tenant isolation is mandatory in every query/DO access).

We aim to acknowledge reports within 5 business days. As a pre-launch project, response time may vary; a report affecting tenant isolation or token/auth handling will be prioritized above all else.

## Scope

In scope:

- The public API facade (`apps/platform`) and shared package (`packages/shared`).
- The marketing/docs site (`site/`) — e.g. XSS in the waitlist form, header misconfiguration.
- Anything that could break per-tenant isolation, forge or replay a bearer token, or corrupt the money ledger.

Out of scope (nothing to find yet, but reports acknowledged):

- Real vendor adapters (`src/vendors/real/*`) for un-activated tenants — these throw `NotActivatedError` and are unreachable without a live vendor credential. Real sending (Gmail API, HTTPS/443) is live for activated tenants, but new-account activation still runs through a short concierge step, not automatic self-serve, and there is no established multi-year production track record yet.
- Anything requiring physical access, social engineering of EpiphanyMade staff, or denial-of-service against infrastructure we don't yet operate at scale.

## Secrets handling

Per `CLAUDE.md` rule g: secrets are never committed to this repository. Local dev secrets live in `.dev.vars` (gitignored); production secrets are Cloudflare Worker secrets. If you find a committed secret anywhere in this repo's history, please report it immediately via the address above — that alone is a valid, high-priority report.
