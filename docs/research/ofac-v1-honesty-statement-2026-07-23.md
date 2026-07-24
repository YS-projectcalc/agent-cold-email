# What OFAC v1 screening does — and does NOT catch (2026-07-23)

Adversary round 1 finding N4 (`docs/adversarial/ga-gates-design-review-2026-07-23.md`)
requires an explicit, honest statement of this build's limits before any
external claim is made about it. This is that statement. The site info pass
(`site/`) consumes this document later — it is not itself edited by the G1
build lane.

## The one claim this platform may ever make

**"SDN-screened"** — every paying tenant's brand (and, when available,
contact-email domain and Stripe billing name) is checked against the US
Treasury OFAC Specially Designated Nationals (SDN) list at checkout and again
whenever the operative sending brand changes.

## The one claim this platform must NEVER make

**"OFAC compliant"** or **"sanctions compliant."** A v1 SDN-only, review-not-
reject, free-text-name screen is not a compliance certification, and no
customer-facing, marketing, or legal copy may imply one. If Legal or a
customer asks, the honest answer is: "we screen against the public SDN list
at checkout and on brand changes; we are not a compliance product and do not
warrant sanctions compliance."

## What v1 genuinely catches

- An **exact** normalized-name match between a screened field (brand /
  contact-email domain / Stripe billing name) and an SDN entry's name.
- A **conservative subset-token** match: every token of an SDN name (2+
  tokens) is present in the tenant's brand — deliberately narrow to hold down
  false positives (adversary NB-3).
- A brand-name **change** at `setup_infrastructure` (the point the operative
  sending identity is actually finalized) — not just the signup/checkout-time
  brand (adversary NB-1).

## What v1 does NOT catch (documented gaps, not silent ones)

- **Transliteration / phonetic / spelling variants.** "Khaled" vs "Kaled",
  Cyrillic/Arabic-script transliteration variants of the same name, or any
  other near-miss spelling — v1 has no edit-distance or phonetic matching.
  Confirmed by `test/ofac-match.test.ts`'s explicit "documented v1 limitation"
  case.
- **Single-token subset matches.** A one-word SDN name only ever matches via
  an *exact* normalized match, never a subset — a single shared word (e.g. a
  common surname) against a multi-word brand is not treated as a hit. This
  bounds false positives but also means a single-token alias is not
  fuzzy-caught.
- **OFAC's `ALT.CSV` aliases.** v1 screens `SDN.CSV` primary names only — a
  sanctioned entity's alias/AKA name (kept in a separate OFAC file) is not
  loaded or checked. Deferred, not silently dropped: flagged here and in the
  design doc as a real gap, candidate for a later increment.
- **Non-SDN sanctions programs.** Per Founder Q2 (ADOPTED), v1 screens the SDN
  list only — OFAC's broader Consolidated Sanctions List (non-SDN programs)
  is out of scope for v1 and may be added later.
- **Personal identifiers on the contact email.** Only the email **domain** is
  screened (an organization/brand signal) — the mailbox local-part (a
  personal identifier) is deliberately never fingerprinted in v1.
- **Any field a Stripe checkout session doesn't carry.** Under the pilot's
  100%-off + `payment_method_collection:"if_required"` posture, Stripe
  typically collects no billing name at all — screening degrades honestly
  (records `screened_fields.billingName: null`), it never fabricates a check
  that didn't happen.

## Fail-closed, not fail-open, when no list is loaded yet (adversary N-OF-1, 2026-07-23)

**Updated posture — this is the one behavior change from the original build.**
The very first version of this screen persisted `'clear'` (with a `null` list
version) whenever no SDN list had been built yet — e.g. the post-deploy
window before the first 5-minute refresh succeeds. The adversary correctly
flagged this as fail-**open**, the wrong direction for a sanctions gate: it
meant a checkout completing in that window activated a paying stranger
genuinely unscreened, distinguishable only via a `null` `screening_list_version`
in the audit trail.

**Fixed:** when no active SDN list exists at screening time, the tenant is now
held `'review'` (fail-**closed** — blocks activation exactly like a real
match) with a distinct sentinel list version (`list-unavailable`), a
`screening_reviews` row explaining why (`reason: "sdn_list_unavailable"` — not
a name match), and the same founder ops alert path as a real hit (worded
honestly: "no SDN list loaded yet," never "Matches:"). This self-heals once a
real list loads — the ops-sweep cron's recovery pass (`src/ofac/
screening-recovery.ts`) re-screens every tenant still holding the sentinel: a
genuinely clean tenant is cleared automatically (no manual admin step needed
for the common case), and a genuine match is upgraded to a real,
list-versioned hold. A manual admin clear also works at any time in the
meantime. So: **"checked against the SDN list at checkout"** is now true
without caveat for every activated tenant — a tenant is never activated
without either a real screen or an explicit admin override of a held review.

## Operational honesty commitments

- A screening **hit never auto-rejects.** It holds the tenant on `'review'`
  (blocks real activation, never customer data loss) and a human — the
  founder — clears or rejects it. No SLA/refund promise is made to a held
  tenant while pending (adversary N3): the review queue is designed to be
  cleared fast (match context included), but no timing guarantee is a
  customer-facing claim yet.
- Customer-facing copy for a held tenant says **"account review"** — never
  "sanctions match" or "OFAC hit." False-positive dignity: a tenant who is
  cleared should never have been shown language implying they were suspected
  of anything specific.
- Already-active pilot tenants at the moment this ships are **grandfathered**
  `'clear'` with an explicit `screening_list_version = 'grandfathered-2026-07-23'`
  sentinel — turning screening on can never retroactively strand the live
  pilot, and the sentinel keeps that fact auditable (distinguishable from a
  tenant that was actually checked against a real SDN list build).

## Arming-time unknowns this document does NOT resolve

These are verified once, live, at the arming session — not before (per the
build brief's hard rule: no live vendor/gov calls during this build):

1. **The real SDN.CSV wire shape.** This build's parser assumes the
   documented public format (12 columns, no header row, `"-0-"` as the
   no-value placeholder). Verify against a real fetch before the daily cron
   refresh is relied upon in production.
2. **Worker cron CPU budget for ~17k rows.** The batched-insert shadow-swap is
   designed to stay well under typical Worker cron limits, but this was never
   provable without running it against the real file size (design's own
   flagged unknown, `ga-gates-design-2026-07-22.md` §G1a).

## The droplet-relay's trust model (added 2026-07-24)

Treasury's TLS front-end blocks every Cloudflare-Worker-origin fetch to the
SDN.CSV host, so a droplet relays the feed to the Worker via
`POST /admin/sdn/ingest` (`apps/platform/src/ofac/sdn-ingest.ts`,
`tools/sdn-relay/`). This ingest path introduces a threat model the direct
Worker fetch doesn't have: a leaked/stolen `SDN_INGEST_TOKEN` lets an
attacker submit an arbitrary candidate list, not just observe a fixed
Treasury URL. Two defenses narrow this, and one residual is fundamentally
NOT closeable by this code:

- **`MIN_SDN_ENTRIES` (≥5000 entries)** closes the TINY-forgery case — a
  stolen token cannot neuter screening by pushing a near-empty "clean" list.
- **The monotonicity guard** (content-hash + entry-count sanity — SDN.CSV
  carries no publication-date column, so this is the cheapest honest signal
  available) narrows naive REPLAY of an old genuine list.
- **What is NOT closed, and cannot be**: a large, plausibly-sized (≥5000,
  entry-count-similar) list with SPECIFIC names surgically removed passes
  both guards above and would silently drop those names from screening.
  Treasury does not cryptographically sign the SDN.CSV feed, so there is no
  check this code can perform to prove a candidate list is unmodified. Token
  secrecy — the droplet-local env file (`/root/sdn-relay.env`, never in this
  repo, `chmod 600`), the token's narrow scope (this one endpoint only, never
  `ADMIN_TOKEN`) — is therefore the PRIMARY control for this residual, not a
  fallback behind a code-level defense that doesn't fully exist.
