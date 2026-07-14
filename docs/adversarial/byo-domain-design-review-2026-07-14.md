# BYO-Domain Flow — Adversarial Design Review (round 1, frozen record)

Fresh-context adversary pass, 2026-07-14, pre-build (no BYO code existed). Grounded @ `edf79828`. Inputs: SPEC §7/§8/§9/§10/§12/§17, `engine/brand-guard.ts`, `engine/provisioning.ts`, ROADMAP BYO ruling line, frozen vendor/pricing research. Scope: the founder-ruled "allow any domain incl. primary" flow as sketched in ROADMAP (delegation-first ladder). Round 2 (re-review of the drafted SPEC §20) recorded separately when it lands.

## VERDICT: NEEDS-CHANGES (3 blocking)

**B1 — Primary-domain sending inverts the containment model; the control loop has no remedy.** §7/§10 rest on domains being disposable lookalikes ("detect burning domain → auto-buy + warm a REPLACEMENT", `provisioning.ts:31`). A primary domain cannot be burn-replaced — it IS the customer's website + company email. Spec must define the substitute remedy (hard-pause-all + human alert + runbook). Consent covers the customer's risk, not this gap in our loop.

**B2 — Apex NS delegation on a live domain breaks their business; the risk ladder was inverted.** Delegating apex NS makes us authoritative for ALL their DNS: imperfect zone copy kills existing MX/website/SPF; DNSSEC stale-DS → SERVFAIL (domain dark on validating resolvers); SPF 10-lookup PermError (RFC 7208 §4.6.4); org-wide apex DMARC enforcement rejects existing unaligned legit streams. NS delegation is safe ONLY for a fresh domain or a subdomain. Required: mandatory pre-flight live-infra scan (MX / A-AAAA / SPF includes / DMARC / DNSSEC DS) that HARD-REFUSES apex delegation when live infra found. "Send from apex primary" and "safe automated DNS" are mutually exclusive on live domains.

**B3 — BYO removes the brand-guard backstop; TXT proves control, not legitimacy.** `assertBrandOwnership` runs only on the lookalike path; gate (b) brand↔domain consistency is vacuous without derivation; the denylist misses homoglyphs (`paypa1.com`) and generic-phish (`secure-billing-inc.com`). A phisher who genuinely controls an impersonation domain passes TXT. Required: anti-impersonation check ON the BYO domain (denylist + registrable-lookalike/homoglyph detection) + human-review/KYC escalation for TXT-verified-but-suspicious. Reputation intake (age/blocklists) is a deliverability control, NOT the abuse control.

## Non-blocking
- "Agent-applied records" is not a distinct automation tier — most customer agents lack registrar creds; it is a delivery mechanism of records-to-apply that must degrade to copy-paste + poll-verify (authoritative-NS queries, timeout/abandon UX).
- Consent checkbox does not protect the business (chargebacks/churn/reputation survive any waiver; ROSCA/consumer-protection doubts on bundled checkboxes). Technical safeguards lead; consent = separate-screen acknowledgment logging domain + timestamp + scan result.
- Single-CF-account zone concentration extends §7's master-account risk to DNS; Cloudflare-for-SaaS custom hostnames is the standard multi-tenant primitive and independently reinforces subdomain-over-apex.
- Warmup machine has no "starting reputation" input: established-good domains shouldn't ramp at 5/day; blocklisted shouldn't be admitted. Intake reputation must branch the ramp.

## The 5 decisions the SPEC § must nail
1. Apex-vs-subdomain default + the live-infra gate (detection set + branch outcomes).
2. Primary-domain guardrails: lower caps, circuit breaker well below Gmail's 0.30%, DMARC p=none observation window, pause-all fallback + runbook.
3. The BYO abuse gate (brand-guard extension, homoglyph check, KYC escalation; reputation-intake ≠ abuse control).
4. Consent mechanics (separate screen, exact wording, logging; waiver ≠ business protection).
5. DNS model: Cloudflare-for-SaaS custom hostnames vs zones-per-tenant; DNSSEC DS handling; concentration posture; poll-verify timeout UX.

## Attacks that failed
- Delegate-a-victim's-domain griefing: blocked by TXT-ownership-verified-at-CURRENT-NS before any delegation (ordering is correct).
- Grounding drift in frozen research: source↔figure traces cleanly; no fabricated numbers feed the flow.

## Unverifiable at review time (since resolved)
- Competitor BYO norms + Cloudflare-for-SaaS limits — resolved same day by live-doc verification: `docs/research/byo-domain-verification-2026-07-14.md` (Smartlead/Instantly never ask NS delegation; OAuth/SMTP + single-CNAME norm; CF custom hostnames 100 free / $0.10 to 50k; zones-per-account cap unconfirmed in official docs).

## New scope gap (feeds §20.6)
BYO-mailbox is a second axis the domain flow was silent on — and the first pilot (Mordy: BYO domain + BYO Google Workspace mailboxes) needs it: OAuth/SMTP+IMAP connect bypasses vendor provisioning; GWS DKIM published as a record, never delegation.

---

# Round 2 — re-review of drafted SPEC §20 (same day, grounded @ bb979a64)

## VERDICT: NO-SHIP (narrow) — R1 blockers B1/B2/B3 all substantively CLOSED; two NEW blocking defects in the drafted text:

**R2-B1 — §20.2 ↔ §20.5 contradiction:** "no schedule compression for primaries" collides with §20.5's 7–10-day shortened ramp for established-good domains — an established-good PRIMARY satisfies both, and the incentive is inverted (more existing reputation = more to lose = ramp SLOWER). Fix: §20.5 shortened ramp explicitly EXCLUDES primary domains.

**R2-B2 — 0.10% complaint breaker unimplementable as a bare rate:** at §20.2's own caps (~100 sends/day/tenant) ONE complaint = 1.0% → hard-pause; hair-trigger false-pauses + a one-click griefing vector. Fix: define minimum-volume denominator + rolling window + absolute-complaint floor.

**Non-blocking to fold in the same pass:** age≥2y is not sending reputation (aged-dormant/marketplace-aged domains game the shortened ramp — require evidence of active legitimate sending); subdomain-of-primary ≠ lookalike risk profile (organizational-domain reputation bleeds — don't frame as risk-free); burned-primary alert must reach the CUSTOMER (dashboard + email), not only the §D6 platform-owner digest; §20.3 residual named (non-famous-third-party impersonation + generic-phish auto-admit — name the backstop); live-infra scan false-positives on registrar parking A-records; Mordy-seam: classify authorpitchdesk.com (dedicated-outreach vs primary-with-live-infra — guardrail tier + consent + p=none window hang on it) and acknowledge hard-pause is weaker for BYO mailboxes (pauses OUR sends only); p=none-window rationale = anti-breakage not reputation; DNSSEC DS hard-block scoped to apex/whole-domain delegation only.

**Held under re-attack:** apex-records-only + DNSSEC block (SERVFAIL vector closed); SPF merge-never-clobber; reputation-vs-abuse line; research grounding traces to primary sources; TXT-before-delegation griefing defense.

**Unverifiable:** CF zones/custom-hostnames per-account caps (official docs silent — flagged in research record); §20 should state the we-manage-zone concentration posture explicitly.

---

# Rounds 3-4 — convergence to SHIP (same day)

**Round 3 (@ 6152b478): NO-SHIP narrow.** Both R2 blockers CONFIRMED closed (primary-axis-first ramp gating; joint breaker ≥100 sends/7d + ≥3 complaints + ≥0.10% with soft-response below floor — arithmetic verified: 3-complaint floor binds below ~3,000 trailing sends; volume floor reachable by one mailbox in 5 days; domain-aggregate, rotation-proof). ONE new blocker: §20.6 pilot cell classified authorpitchdesk.com "zero live infra → we-manage-zone" while the same section says Mordy's live Google Workspace boxes run on it (live GWS = live MX/SPF/DKIM = live infra by §20.1's own scan). Residuals: passive-DNS ≠ sending evidence; lingering lookalike-equivalence claim; "primary-adjacent" label toothless; ramp-endpoint vs ≤20 cap clamp unstated.

**Round 4 (@ 355926c0): SHIP.** §20.6 rewritten — dedicated-outreach/not-primary kept, zero-infra premise dropped, records-to-apply DNS mode (likely no DNS management beyond optional tracking CNAME; OAuth connect bypasses provisioning), ramp defers to intake ladder. All four residuals landed: DMARC aggregate volume = the qualifying established-good evidence; lookalike-equivalence scoped to fresh-standalone only; subdomain-of-primary inherits the §20.2 operationalized breaker; min(§9 day-N, 20/mbx/day) clamp explicit both directions. No new contradiction (cross-section sweep). Non-gating leftovers: 2×2 row label doesn't enumerate dedicated-standalone-with-live-infra (prose authoritative, cosmetic); light-KYC scope (BYO-primary only vs all first-time BYO — cheap dedicated phish domains face only the downstream breaker) = FOUNDER DECISION, tracked in ROADMAP.

Verdicts re-derived independently each round (breaker arithmetic, cross-section tracing, ROADMAP ground truth) — not taken from builder reports. R1:3 → R2:2 → R3:1 → R4:0 blockers.
