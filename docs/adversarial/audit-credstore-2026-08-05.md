# Adversarial audit — I3 mailbox credential-push store (2026-08-05)

**Grounding.** main HEAD `0fe24713`, read-only; target files clean. Fresh dist built from CURRENT source in an isolated sandbox; every attack RAN against the real compiled `MailboxCredentialStore` + `assertAuthorized` (execution, not static reading). Part of the founder-ordered full boundary audit; the boundary-map flagged this as the one genuine `apps/engine` gap — `selfserve-activation-design-review-2026-07-21` named the design risk before I3 was built; the build was never adversarially attacked as built until now.

## VERDICT: PASS

No BLOCKING finding survives self-refutation. Endpoint surface is SOUND — auth, atomicity, durability, error-echo, key-discipline all held under execution. Three NON-BLOCKING findings, chiefly one regression-ring (the i3i4 round-2 fix that unblocked programmatic minting silently reopened the design-named token-revert risk). **None blocks Mordy's send** — his path is the deterministic manual mint, immune to all three (see F1 reachability).

## F1 — NON-BLOCKING (revisit before programmatic-minter arm) · regression ring · content-hash is dedup, NOT ordering: a stale keyless push REVERTS a rotation
`mailbox-store.ts:134-148`: upsert hashes new creds; identical hash → "unchanged" no-op; else → "replaced" blind overwrite, no version/updatedAt/monotonicity check. An OLDER-but-different push landing after a NEWER one reverts the stored token.
- **PROVEN (ran):** push v1 → rotate v2 → replay stale v1 (keyless) ⇒ FINAL=refresh-token-v1, outcome "replaced", REVERTED_TO_STALE=true.
- **Mitigation was removed.** Design review F4 (`selfserve-activation-design-review-2026-07-21:34`) prescribed "content-hash + idempotency key"; the keyed path IS the anti-revert guard (keyed replay returns "replayed" without writing, `mailbox-store.ts:119-131`). i3i4-build-review finding #1 dropped the key from the sole caller (`mailbox-credential-push.ts:118`, now keyless) to fix an over-strict rotation rejection. Net: prod path has ONLY content-hash; nothing replaced the key's anti-revert property. Two fixes in tension.
- **Reachability / Mordy: NOT reachable.** `ManualOAuthMinter` reads a static `GMAIL_OAUTH_GRANTS` secret → deterministic content → one content at a time → content-hash no-op → no revert. Per-mailbox pushes serialize on the single-threaded tenant DO. Bites only the DARK programmatic-minter path (fresh token per mint) under a >30s server-slow push landing after a reconcile push — and even then both Gmail tokens stay valid. **Fix: add a monotonic guard (updatedAt/version) or restore keyed replay-safety before swapping in the programmatic minter.**

## F2 — NON-BLOCKING (armed-only, vendor-guarded) · teardown leaves cred-push rows live → a post-cancel reconcile can RESURRECT a revoked credential
- **PROVEN (ran):** push v1 → remove() → push v1 ⇒ outcome "created", RESURRECTED=true. No tombstone.
- **Platform gates all absent (traced):** `teardownTenant` (`lifecycle.ts:194+`) revokes each mailbox but never terminates its `mailbox_cred_pushes` row; `reconcileMailboxCredentialPushes` selects `WHERE tenant_id=? AND status='pending'` with no lifecycle gate (`mailbox-credential-push.ts:166-180`); `runDeliverabilitySweepAllTenants` dispatches with no status filter (`ops-sweep.ts:138-152`). So a 'pending' mailbox at cancel time is eligible for re-push after teardown revoked it.
- **Sole backstop:** the UNVERIFIED vendor assumption that `showMailboxCredentials` refuses a released mailbox. **Fix: mark cred-push rows terminal on teardown; don't lean on the vendor.** ('pushed' rows safe — reconcile only touches 'pending'.)

## F3 — NON-BLOCKING (known/accepted design) · no per-tenant scoping at the credstore boundary
Push wire is `{email, credentials, idempotencyKey?}`, store keyed by email, auth one global `ENGINE_AUTH_SECRET`. Zero tenant_id anywhere in the credstore boundary (`wire.ts:48-52`, `mailbox-store.ts`, `engine-mailbox-client.ts:64`). Cross-tenant isolation rests 100% on: (a) secret secrecy, (b) Worker-side tenant_id scoping in its own DO queries, (c) global mailbox-email uniqueness + upstream domain-ownership verification. NOT a live tenant→tenant path (tenants never hold the secret). IS a blast-radius concern — a leaked secret exposes ALL tenants' write/delete surface, no rotation story, no dual-secret support. No READ-creds endpoint exists → a leaked secret can WRITE/DELETE (send-as-setup / DoS-revoke) but not read a token back. Founder-known (design F4).

## Attacks that FAILED (why PASS is meaningful)
- **Concurrent upsert torn-write:** synchronous RMW, no await between read and write, atomic under single thread. Ran 20× `Promise.all([upsert v1, upsert v2])` — durable == memory every time, valid JSON, no torn write. Atomic write-temp+rename holds.
- **Crash mid-flush:** atomic rename → old-or-new, never torn; `loadJsonStateFile` fails loud on corrupt.
- **Auth constant-time / unauth:** `assertAuthorized` — valid PASS; wrong-same-length / wrong-short / no-Bearer / empty / trailing-space / lowercase-bearer all 401. `timingSafeEqual` confirmed (length pre-check acknowledged low-value leak). All 6 mutating routes auth; only `/health` unauth, touches no creds.
- **Error-body token echo:** bait refresh-token in bad-shape push (missing field; wrong-type numeric) — error names the field, token value NOT echoed. zod messages carry field names, not values.
- **Key-reuse different payload:** BadRequestError fires, good creds untouched (latent-only — prod caller is keyless).
- **Keyed replay anti-revert:** keyed stale replay returns "replayed" without writing → proves the dropped key WAS the anti-revert guard.

## UNVERIFIABLE
- Whether `showMailboxCredentials` returns creds for a just-RELEASED mailbox (decides F2 real-world reachability) — no live InboxKit; resolve at first live teardown.
- Programmatic `InboxKitOAuthMinter` fresh-token-per-mint behavior (F1 trigger) — dark/unbuilt-wired; verify at minter-arming.

## NEW (out of scope, no verdict weight)
- Fixture blind spot that hid F1: `mailbox-store.test.ts:67` rotation test only pushes v1→v2 and asserts "replaced" — never the reverse (v2→stale v1), which also returns "replaced" and reverts. A test asserting a stale push does NOT clobber would fail on today's code.
- `remove()` doesn't clear the idempotency record → keyed teardown+re-provision still throws (moot while prod keyless).

_Frozen by the orchestrator from audit-credstore's verbatim report (read-only lane); sandbox + probes at scratchpad `engine-sbx`._
