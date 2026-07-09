# ColdStart — CLAUDE.md (project law)

## What this is
Multi-tenant cold-email infra platform, operated by the customer's own coding agent. See `README.md` (state), `SPEC.md` (canonical design), `ROADMAP.md` (build order/status).

## Canonical docs — no sprawl
The ONLY living docs: `README.md` (per level), `SPEC.md`, `ROADMAP.md`, `ARCHITECTURE.md`, `HANDOFF.md`, `MEMORY.md`, and `ACTIVATION.md` (once created). NEVER create new status/audit/critique/handoff-vN docs — fold conclusions into these and delete temp working files. Adversarial panel verdicts are the one exception: frozen records under `docs/adversarial/panel-NN/`, allowed as they're not living docs.

## README at every level
Every new directory that holds code or content gets a `README.md` at creation time: what it is, how to run/test it, what depends on it. A PR/commit adding a directory without one is incomplete.

## Anti-slop development rules (hard rules)
a. No dead code, no commented-out blocks, no unused exports — delete, git remembers.
b. No god files — a file that grows past ~300 lines or two responsibilities gets split.
c. No duplicated logic — search for an existing implementation before writing a new one.
d. No hallucinated deps — every import must exist in package.json/lockfile; run install and build before claiming done.
e. Tests must assert behavior, not existence — no coverage theater; every bugfix ships with a test that FAILS on the old code.
f. No patches-on-patches — root-cause fixes only; if wrapping a workaround around a workaround, stop and fix the underlying defect.
g. Secrets NEVER in code or git — env/wrangler secrets only; `.dev.vars` and `.env` in `.gitignore` from day one.
h. Validate ALL tenant input at the boundary; per-tenant isolation is mandatory in every query/DO access (tenant_id scoping).
i. No speculative abstraction — YAGNI; build for the current phase of `ROADMAP.md` only.

## Verification before done
Nothing is "done/working/deployed" without a concrete command's output quoted as evidence (typecheck, test, build, curl, screenshot). Test-mode ONLY: Stripe test keys, sandbox vendor adapters; NEVER wire real vendor spend — that's gated behind `ACTIVATION.md` (owner-hands).

## Update discipline
Every session that touches the project updates `ROADMAP.md` (status + session log) and `HANDOFF.md` (resume-here) before ending; milestone events also update `MEMORY.md`.

## Model tiering
Subagents are opus/sonnet only, models always explicit (matches the user-level CLAUDE.md; never inherit silently).
