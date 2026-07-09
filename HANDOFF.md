# ColdStart — HANDOFF (resume here)

## Where we are
Phase A: foundation done (A1 complete — repo, SPEC, ROADMAP, README). Adversarial panel #1 in flight against the plan (SPEC + ROADMAP + architecture proposal A2.5) — workflow run `wf_b38a550e-3b8`.

## What's next
1. Synthesize panel #1 verdicts.
2. Amend ROADMAP.md / ARCHITECTURE.md per verdicts (A2 → A2.5 finalized → A3 cold-cli license check).
3. Phase B build begins (monorepo scaffold, control plane, provisioning service, vendor adapters).

## Locked constraints (see SPEC.md §0 for full text)
- Sandbox-first: every vendor behind an adapter interface, sandbox impl active, real impl coded-but-unactivated.
- Test-mode go-live: Stripe test keys, sandbox vendors, ONE final ACTIVATION.md checklist gates real spend/live keys.
- No further questions to the owner until the final report — autonomous to the finish line; open items go on the held-for-owner list below.
- Full adversarial regime authorized (multi-lens opus panels, parallel Workflow lanes) — per SPEC §0.7.

## Held for owner (accumulate here; resolved at final report / ACTIVATION.md)
- Name pick: coldrig / coldpipe / coldloop.
- npm login (npm NOT currently authed on this machine).
- Stripe live KYC.
- Vendor account creation (Inboxkit, Porkbun, etc.).
- GitHub org creation/transfer (repo currently under YS-projectcalc).
- Domain purchase.
