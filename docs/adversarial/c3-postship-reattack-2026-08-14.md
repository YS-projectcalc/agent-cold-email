# C3 post-ship adversarial re-attack — coldrig — 2026-08-14

**Verdict: HOLDS-WITH-FINDINGS.** Fresh-context adversarial review (founder-ordered) of the 2026-08-13 session tail: the ungated post-gate execution (merges, deploys, doc claims) plus a one-layer-up attack on the C3 gate's SHIP-dark reasoning. All legs executed; live checkouts untouched (read-only git; all execution in a scratchpad clone at HEAD `6b96ae9`, `git status --porcelain` empty before and after).

Every bookkeeping, deploy, and dark-flag claim survived attack (legs A, B, D, F, G all REFUTED-the-attack / claims hold). But the one change that is LIVE and ARMED — C3 part (b) — fails the exact criterion its own gate passed it on, and the (d) arm-gate ledger was incomplete.

---

## FINDING 1 — BLOCKING — CONFIRMED-DEFECT (LIVE, ARMED)
**A permanently-dead vendor registration is reported to the customer as "provisioning in progress", forever.**

Claim attacked: `docs/adversarial/c3-gate-2026-08-13.md:13-14` — "a genuine failure never reads as 'in progress'."

The success-pending predicate (`apps/platform/src/engine/domain-dns.ts:257`):

```ts
if (failure.notPropagated && connectionType === "purchased" && readDomainStatus(ctx, domainId) === "active") {
  throw new DomainPropagationPendingError(dnsFailureMessage(domain, failure), failure.step);
}
```

The third conjunct reads the WRONG side: `readDomainStatus` (`domain-dns.ts:87`) reads OUR `domains.status` lifecycle column (`active`/`burning`/`released`…), whose only writers are our own burn/release/retire/pause transitions (`clock-migration.ts:181`, `lifecycle.ts:335`, `deliverability-actions.ts:127`, `:264`). Nothing ever syncs it to the vendor's registration verdict — it stays `'active'` no matter what the registrar says.

Meanwhile `polledDomainIsReady` (`vendors/real/inboxkit-domain-port.ts:466`) returns `false` for ANY non-`active` vendor status (its own docstring at `:409`: "an expired or suspended registration can never carry mail"). That `false` → all-false `DnsRecordSet` → `notPropagated: true` (the benign shape) → predicate satisfied → `DomainPropagationPendingError` → HTTP 202 `provisioning:"pending"`. C3's second change (`inboxkit-domain-port.ts:263`, not-yet-listed now RETURNS all-false instead of throwing) widened the same door.

**Failure scenario:** a purchased domain hits a terminal registrar state (expired / suspended / failed-after-accept / removed). Local row stays `status='active'`, `dns_status='pending'`. Every subsequent `setup_infrastructure` call returns 202 success-pending, zero mailboxes, `info`-severity messages. Paid domain; no mailbox will ever come up; nothing escalates.

**Executed proof (9/9 green)** — scratch clone at `6b96ae9`, `npx vitest run --no-file-parallelism test/zz-adversary-c3b-attack.test.ts`:

```
✓ ATTACK C-1 > vendor lists purchased domain status='expired'        -> setDns RETURNS all-false (no throw)
✓ ATTACK C-1 > … 'suspended' / 'pending_deletion' / 'failed' / 'cancelled' — same (4 more)
✓ ATTACK C-1 > CONTROL — genuinely active purchased domain answers all-TRUE
✓ ATTACK C-1 > CONTROL — a real /domains/list API error still THROWS (the split the gate proved)
✓ ATTACK C-2 > 10 consecutive setup calls on a permanently-dead registration all return 202 success-pending
✓ ATTACK C-2 > local domains row stays status='active' + dns_status='pending' — nothing syncs the vendor verdict
 Tests  9 passed (9)
```

C-1 drove the REAL `RealInboxKitDomainPort` with stubbed fetch; C-2 drove the REAL `runSetupInfrastructure` ten times (1 domain bought, 0 mailboxes, all `retry_setup` messages severity `info`). Both controls held — the boundary is not fail-open everywhere; it just isn't the whole space.

**This is a REGRESSION, not a pre-existing gap:** before part (b) this condition produced a thrown retryable `VendorError` — mis-graded but VISIBLE. Part (b) converted it into a success. The gate's part-(b) attack list (`c3-gate-2026-08-13.md:84-104`) tested permanent THROWS, transient THROWS, connected domains, non-terminal ordinals — never a permanent condition arriving through the benign RETURN. Its own UNVERIFIABLE section (`:171-175`) flagged live vendor semantics as unexercised; this lives exactly there.

**Reachability is real:** `REGISTRAR_PROVIDER` / `INBOXKIT_API_KEY` / `INBOXKIT_WORKSPACE_ID` are live prod secrets and `buildAdapters()` (`tenant-do.ts:638-658`) flips the bundle real for an activated tenant — the same path the $30 double-buy rode.

## FINDING 2 — SHOULD-FIX (arm-gate; cannot fire while dark) — CONFIRMED-DEFECT
**The (d) reconcile provisions for lifecycle-FROZEN tenants; the arm-gate ledger did not mention it.**

`runSetupInfrastructure` opens with `assertNotLifecycleFrozen` (`provisioning.ts:406`; incident docstring `billing-state.ts:45-50`). `provisioning-reconcile.ts:159` calls `provisionDomainWithMailboxes` directly and never performs that check; `listAllTenantIds` (`admin/db.ts:212`) is unfiltered. Neither `assertNotLifecycleFrozen` nor `assertWithinProvisioningCap` appears in `provisioning-reconcile.ts`.

**Executed proof (3/3 green,** `test/zz-adversary-c3d-freeze.test.ts`): for suspended/past_due, active/disputed, canceled/canceled — the direct path THROWS `/frozen/` with 0 mailboxes; `runProvisioningReconcile` on the identical tenant returns `{scanned:1, reconciled:1, completed:1, errors:0}`, flips `dns_status='ready'`, creates 2 mailboxes.

**Honest scope (adversary's own self-refutation):** NO real vendor spend — `buildAdapters()` re-reads activation per call and frozen tenants get the SANDBOX bundle (`isTenantActivated` requires `billingState === "active"`, strictly stronger than `!isLifecycleFrozen`). Residual: phantom local `mailboxes` rows + false `dns_status='ready'` on a frozen account — and `syncMailboxQuantity` is set-to-N against live provisioned count, so the phantom rows become BILLABLE the moment the tenant reactivates.

**The class:** the reconcile inherits only the guards INSIDE the shared primitive, never the ones the on-demand caller WRAPS around it. When a finding says "the reconcile lacks guard X", the finding is the whole wrapper-guard set, not X.

## FINDING 3 — NOTE — CONFIRMED (the amplifier)
**Nothing bounds or escalates a provisioned domain stuck at `dns_status='pending'`.** Watchtower's check set (`admin/watchtower.ts:28-32`) has nothing keyed on domains/DNS; `DOMAIN_DNS_PENDING` (`domain-dns.ts:231`) has zero readers in `src`; `dns_check_count`/`dns_first_checked_at` are wired only into BYO intake; ops-summary reports burning/replaced, never pending. No timer, no attempt ceiling, no abandonment state. **Before part (b) the customer's retry loop WAS the escalation; part (b) deleted it.** This turns Finding 1 from a bad error message into an indefinite silent stall.

---

## Attacks that FAILED (claims hold)
- **A · Ship-what-was-gated:** gated SHAs from the frozen docs — intentfix `300d635`, c3 `43ad313`. `git diff … -- apps/platform/src` EMPTY for gated-vs-merge (both) and merge-vs-HEAD; merge parents match the gate docs; every commit between gate and deploy is docs-only. Deployed tree byte-identical in `src/` to both gated trees.
- **B · Deploy truth:** `wrangler deployments status` → current `52a65306-d08d-4f4a-bcd2-0e7933a959e2` (100%). `wrangler versions view` binding manifest: 3 env vars + 10 secrets, `PROVISIONING_RECONCILE_ENABLED` in NEITHER (corroborated by wrangler.toml grep + `secret list`). Live: both hosts /status 200; unauthed → 401.
- **D · Dark-means-dark:** exactly one production call site (`index.ts:173` → `scheduled.ts:109`); flag read PER INVOCATION (`admin/ops-sweep.ts:280`) returning `{disabled:true}` before any tenant enumeration; `provisioningReconcileSweep` has one caller inside the armed branch; no dynamic method dispatch; the module has no side-effecting top-level code.
- **F · Doc-claims audit:** `8a66976`/`6c5140b`/`6806357`/`6b96ae9` all as stated; push confirmed (`origin/main..main` empty, origin at `6b96ae9`); P0 worker `d8055e22-…` in versions list ~90s after the P0 merge; both gate docs in HEAD's tree; the P0 `replace:`-writer exclusion is real (`legacy-domain-intent-keys.ts:89,:104`).
- **G · Mailbox spot-check:** current version `0322e6c1-…` (100%); unauth POST /mcp → 401 sealed body; non-/mcp → 404; spike host → CF 1042 (deleted). No Keychain reads, no tokens, no authed calls.
- **E siblings refuted:** vendor-mailbox-vs-billing drift self-heals via `deliverabilitySweep`'s set-to-N `syncMailboxQuantity` (`tenant-do.ts:1231`); tenant scoping / ordinal derivation / `replace:` exclusion correct and double-guarded; pagination cannot read as absence (`MAX_DOMAIN_PAGES` overflow throws non-retryable, `inboxkit-domain-port.ts:179`).

## UNVERIFIABLE (not folded into the verdict)
1. Live InboxKit `/domains/list` status vocabulary — needs one authed read-only list call. Finding 1 does NOT depend on it (async registration failure produces the same not-listed benign return regardless).
2. Whether Mordy's tenant currently sits in fake-pending — needs an `ADMIN_TOKEN`-authed read (founder-owned).
3. Full-suite regression totals — only the 12 additive attack tests were run, per brief.

## NEW (out-of-scope notes)
- `DomainPropagationPendingError` sets `this.name = "VendorError"` (`domain-dns.ts:53`); safe today (sole consumer narrows by `instanceof`) but the codebase also discriminates by `name` (`namedErrorClass`, `domain-dns.ts:170`) — a future name-based consumer cannot see this class.
- `slugify(persona)` can yield `""` (not NULL) — the reconcile would not skip it. Pre-existing, noted by the C3 gate, still open.

## Disposition
Same-day fix wave launched for Finding 1 (+ its Finding-3 amplifier) under the standing autonomy grant; Finding 2 folded into the (d) arm-gate ledger entry in `ROADMAP.md`. The adversary's executable attacks (RED tests for the fix) originated at the session scratchpad: `scratchpad/cs/apps/platform/test/zz-adversary-c3b-attack.test.ts` and `…/zz-adversary-c3d-freeze.test.ts` (disposable — adapt into the repo suite as part of the fix).
