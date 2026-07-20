# Adversarial review — InboxKit vendor-adapter lane (2026-07-20)

Fresh-context adversary re-attack of the uncommitted InboxKit adapter lane (RealMailboxPort rewrite, RealInboxKitDomainPort, InboxKitClient, error mapping, factory dark-wiring, 40 tests). Ground: HEAD `53effa9`, live worktree. Reviewer ran the full suite (574/574, 80 files) and typecheck (exit 0) independently; live verification GET-only per spend-safety.

## VERDICT: SHIP (merge-safe; findings are REQUIRED-BEFORE-ARMING)

**Dark claim HOLDS, re-derived:** (1) sole call site `tenant-do.ts:287` passes literal `false` for `realAdaptersActivated` → real branch `factory.ts:136-151` unreachable; (2) `inboxKitConfig` supplied by no call site and populated by no env/wrangler wiring; even if reached, `NotActivatedError` at `inboxkit-client.ts:54-55`. No default-param/import-time activation leak. Dark-gating test carries negative + positive controls on distinct classes (non-vacuous).

## REQUIRED-BEFORE-ARMING findings (all non-blocking for the dark merge)

1. **Domain port welded to mailbox config** — `factory.ts:142` arms the DOMAIN slot on the same `inboxKitConfig` credential as the mailbox port, contradicting the adjacent comment + vendors README ("dedicated InboxKit domain config"). An armer supplying the mailbox credential silently co-arms InboxKit as registrar (ACTIVATION.md:9 ruling is mailbox-scoped; ACTIVATION.md:25 still names Namecheap/Porkbun). Mis-arm fails LOUD (both domain paths throw without further config) — hence non-blocking. Fix: separate explicit domain flag + correct comment/README.
2. **`resolveMailboxUid` trusts `mailboxes[0]` from a keyword search** with no exact-email verification before `/mailboxes/cancel` (destructive, paid slot). Exploitability hinges on InboxKit keyword semantics (exact vs fuzzy) — UNVERIFIABLE without a POST (spend-safety); resolve at arming with a throwaway mailbox. Fix: assert `username@domain_name === requested email` before cancel.
3. **provision() double-charge window** (no vendor idempotency key; timeout-after-vendor-success → retry → possible second paid mailbox) + fragile `/already exists/i` message-substring detection. Builder-acknowledged; below the repo's own `withRequestIdempotency` standard at the vendor seam.
4. **Fabricated health fields reach DISPLAY, not decisions** — traced: `complaintRate:0` is discarded by `provisioning.ts:251` (local signal used); deliverability burn/pause loop reads local counts only; `setDns()`'s one-boolean-onto-5-flags result is discarded. Residual: vendor `reputationScore` + bounce-complement `placementRate` flow to the customer-facing `infrastructure` tool + dashboard as if real. Display-honesty fix at arming.

## Attacks that failed
Env/config activation leak (none exists) · default-param arming (pure optionals) · import-time side effects (none) · test theater (tests pin exact URL/method/body; error matrix asserts grading both envelopes) · transient-4xx mis-grading (429 retryable; 409-on-buy caught as idempotent success; 408 edge noted low-risk) · secret leakage (JWT only in auth header, never logged; X-Workspace-Id on every call) · fixture realism (live GET probes byte-match fixtures incl. 401 shapes).

## UNVERIFIABLE
`/mailboxes/list` keyword exact-vs-fuzzy semantics (gates finding 2) · app-level `{error:true}` envelope on live 4xx (doc-derived; mapper handles both via shared `message`).

## Out-of-scope observations
Porkbun `RealDomainPort` is a pure NotActivatedError stub — no functional Porkbun path exists; README's "default registrar" framing is aspirational. `searchLookalikes` caps at 5 fixed `.com` prefixes regardless of `count`.
