# Adversarial ship-gate — P0 intent-key-orphan fix (2026-08-13)

**Target:** `fix/intent-key-orphan-2026-08-13` @ `300d6350788e6b543c497a914c6ae68252a3d149`
(worktree `~/dev/coldstart-wt-intentfix`, `apps/platform`). Commits `54ca78a..300d635`.
**Reviewer:** adversary (fresh context, read-only git). **Stake:** a live paying customer's
provisioning path with real vendor spend ($15/retry). Refute-by-default; execution-verified.

## VERDICT: SHIP

Zero blocking findings survived self-refutation. This is an affirmative clean pass, not a
green-suite pass: every money-critical claim was RED-proven against the un-fixed code, and the
collision/idempotency/status edges were driven through the real DO constructor against the
stateful vendor fake, not read.

---

## Battery (attack #8)

| Check | Result |
|---|---|
| Full platform suite (`npx vitest run`, apps/platform) | **171 files / 1601 tests passed, exit 0** (matches expected; no `send-pipeline-driver` flake despite load avg 21) |
| `npm run typecheck` ×5 | exit 0 all five, zero output |
| `npm run build` (`wrangler deploy --dry-run`) | exit 0, bundles clean; `dist`/`.wrangler` gitignored, worktree stayed clean |
| Two new fix suites (legacy + persisted-key) | 11/11 |
| Adversary fault-injection suite (7 collision/idempotency/status edges) | 7/7 |

---

## Findings (per attack surface)

All graded against the brief's checklist. No BLOCKING findings.

**1 · Spend-neutrality (money invariant) — HOLDS (RED-proven).**
The rebind `UPDATE`s the OLD key to a target `domainIntentKey(tenant, ordinal)` where `ordinal ∉ occupied`
(`occupied` = every current-derivation row, committed *or not* — so an in-flight `intent` row also blocks
its slot). It never overwrites or deletes a current-key intent, so any slot resumable before the rebind
stays resumable — it can only convert buy→resume, never the reverse. Double-count (one live domain
satisfying two ordinals) is blocked by `claimedDomains`, seeded from current committed rows and extended per
rebind. RED-proof: neutralizing `reconcileLegacyDomainIntentKeys` to `return []` in a scratch copy →
"THE MINT, REPRODUCED" goes RED (`/domains/register` count 1 = the $15 mint); restore → green.
`legacy-domain-intent-keys.ts:147,159-180`.

**2 · Second-writer exclusion — HOLDS.**
`if (row.key.startsWith(replace:${tenantId}:)) continue` (`legacy-domain-intent-keys.ts:104`) positively
excludes the deliverability burn-replacement writer; `domainIntentOrdinal` independently returns `undefined`
for a replace key (pinned, `persisted-key-derivations.test.ts:113`). A live `replace:` key cannot be seen as
an orphan and cannot be rebound onto a setup ordinal. Verified by the shipped "burn-replacement is NOT legacy"
test and by tracing both writers (`recordDomainIntent` is the sole INSERT; its only two key sources are
`domainIntentKey` and `replacementDomainIntentKey`).

**3 · Ordinal-collision correctness — HOLDS (Mordy's shape + 7 edges driven).**
Mordy's exact shape (ord 0 = new-key `theauthorpitchdesk.com`, old-key `goauthorpitchdesk.com` orphan) →
orphan rebinds to `firstFreeAtOrAboveMax` = ordinal 1, ordinal 0 untouched, zero buys (shipped "HIS LIVE
STATE"). My driven edges, all through the real DO constructor + evict: two distinct-domain orphans at the
same original ordinal → land on 0,1 (no key collision); colliding orphan with a non-contiguous occupied set
`{0,2}` → lands at 3, the gap at 1 preserved; an orphan whose home ordinal is a free gap → goes home;
same-domain already committed at a current key → orphan NOT rebound (claimedDomains skip); a `burning`-status
domain → rebinds (verbatim parity with `liveDomainForIntent`); a `released`-status domain → left alone; a
no-live-domain orphan → left alone (shipped).

**4 · Idempotency + partial-failure — HOLDS.**
After a rebind the row matches the current derivation, so a second construction never re-enters the `legacy`
branch — driven attack G (double-evict) leaves state byte-stable and throws nothing. All-or-nothing:
`storage.transactionSync` (same rollback-on-throw precedent as `clock-migration.ts`), no `await` inside the
scan+transaction (constructor input-gate turn), and `domain_intents.key` is a bare `TEXT PRIMARY KEY` with no
other UNIQUE (`schema.ts:874`) — since every target key avoids `occupied`, no constraint throw is reachable,
so there is no partial-apply to roll back in practice; if one ever threw, the `tenant-do.ts:232` catch logs
loudly and carries on without bricking the DO.

**5 · C1 guard actually guards — HOLDS (RED-proven), scoping honest.**
Revert-proof in scratch: flip `domainIntentKey` shape → 3 tests RED; flip `replacementDomainIntentKey` → 1
RED; flip `mailboxIntentKey` → 1 RED; restore → 6 green. Covers all three money-bearing derivations. The
test comment honestly states it pins SHAPE only and will NOT catch a changed ARGUMENT (the `replace:` key's
`COUNT(*)`-derived `domainIndex`, `deliverability-actions.ts:177-179`) — that instability is pre-existing and
this fix left it byte-identical (inline string → `replacementDomainIntentKey(...)` helper, same output), so it
is genuinely out-of-scope, not a hole hidden by the guard.

**6 · C4 fixture is real, not paper — HOLDS (RED-proven).**
Drives the real `POST /setup-infrastructure` through the real adapters against `fakeInboxKit`, a stateful fake
that refuses what the live vendor refuses (`/domains/available`→false for an owned domain, `/domains/nameservers`
→404 for a purchased one) — not a sandbox-always-succeed shim. Seeds a LITERAL old key
(`apd-setup-a-2mbx#0`, copied from the incident transcript, not derived), so both sides do not move together.
RED-proven above (neutralize → mint fires).

**7 · Blast radius on the shared path — HOLDS.**
`provisionDomainWithMailboxes` is shared with REPLACE_DOMAIN, but the reconcile excludes `replace:` keys, so a
rebound setup orphan only affects setup `planProvisioning`; the deliverability capacity path keys off
`replace:` and provisions a fresh domain, never reading setup ordinals. The rebind's live predicate
(`status != 'released'`) is verbatim `liveDomainForIntent`'s and the newly-filtered `infrastructure_status`
count — a deliberate single definition of "live" (the P0's root cause was three disagreeing ones). No new
cross-path leak; `domainCount` feeds only the status-readback DTO (`tenant-do.ts:770`), never a spend/plan gate.

---

## Attacks that FAILED (this is what makes the PASS meaningful)

- **Force a `transactionSync` throw** (constraint violation mid-rebind) — impossible: only PK is `key`, and every
  target key is chosen `∉ occupied` (which contains every current key, since `domainIntentOrdinal` is the exact
  inverse of `domainIntentKey`). No reachable collision.
- **Resume→buy inversion** — impossible: the UPDATE targets the OLD key and writes an empty ordinal; it removes no
  current intent, so it strips resumability from nothing.
- **Double-count one domain into two ordinals** — blocked by `claimedDomains`; driven (attack E) with a shared
  domain committed at a current key, orphan left un-rebound.
- **Misclassify a live `replace:` key as orphan** — blocked by the prefix guard; the ordinal inverse also rejects it.
- **Clobber an in-flight ordinal** — an in-flight `intent` (non-committed) current row still marks its ordinal
  `occupied`, so a colliding orphan is pushed above max, never onto it.
- **Non-idempotent second run / DO brick on a bad row** — double-evict is a no-op; the constructor catch isolates a throw.
- **`no such table domain_intents` at construct time** — schema (`CREATE TABLE IF NOT EXISTS`) is applied at
  `tenant-do.ts:196`, before the reconcile's SELECT.
- **Frozen-clock contamination** — the rebind stamps `updated_at` with `clock.now()` (the tenant's own base,
  settled after the clock migration), not a `RealClock`.

## OUT-OF-SCOPE (honestly ledgered founder/follow-up, confirmed NOT gate blockers)

- `replace:`-key `COUNT(*)` `domainIndex` instability (sibling #1) — pre-existing, byte-identical after this fix.
- `burning`/`retired`/`dangling`/legacy-`intent` domain rows counting as "live" — the fix's predicate is verbatim
  the existing resume reader; whether that predicate is itself too loose is a pre-existing question across all readers.
- direction-1 / C3 — ledgered follow-ups; not touched here.

## NEW (out-of-scope, no verdict weight)

- **Gap-non-compaction capacity nicety.** In an exotic mixed-ordinal state (current-key rows at low ordinals +
  a legacy orphan whose `originalOrdinal` sits above a *free* gap), the orphan lands at `firstFreeAtOrAboveMax`
  rather than compacting into the gap, so a mid-range `domains=N` ask could buy a fresh domain while an owned
  one sits unused at a higher ordinal. This is a capacity-utilization inefficiency, **not** a double-spend or a
  resume→buy inversion (the orphan was never resumable pre-fix), and is unreachable for the live customer
  (single orphan at #0). The builder's comment documents the deliberate "leave gaps for in-flight calls" choice.

## Method notes

- Read-only git throughout (`rev-parse`/`log`/`diff`/`show`/`status`). All revert-proofs ran in a nested
  monorepo skeleton under the scratchpad (symlinked root `node_modules`/`packages`, copied `tsconfig.base.json`),
  never mutating the shared worktree. Worktree ended diff-clean except this doc.
