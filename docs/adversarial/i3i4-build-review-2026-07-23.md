# I3 + I4 credential-path build — adversarial review (2026-07-23)

- **Reviewed ref:** worktree HEAD `a38fae3` on branch `worktree-agent-a8f87cd1437a20f72`
  (commits `8595ce7` engine, `e6f710f` platform, `a38fae3` agent-memory notes).
- **Merge-base with main:** `c7658f3` (main's later commits are docs-only, ignored).
- **Method:** fresh-context re-derivation. Both suites RUN in the worktree; the primary
  finding RUN as a standalone proof against the real engine store.

## VERDICT: SHIP-AFTER-FIXES

Suites green (engine 95 pass / 3 skip / 13 files; platform 625 pass / 90 files — both match
the builder's claims). The deployed build is byte-identical inert: the credential-push path
requires all four of `INBOXKIT_API_KEY`/`INBOXKIT_WORKSPACE_ID`/`ENGINE_BASE_URL`/`ENGINE_AUTH_SECRET`,
none set by default, so nothing wrong ships today. But one BLOCKING-BEFORE-ARM defect defeats
the F4/F6 idempotency guarantee the brief asked me to verify is "correctly built" — it is not,
in a reachable scenario. Fix before this merges (one-line change) or the arming checklist owns it.

---

## Findings

### 1. BLOCKING (before arm) — the credential-push caller's deterministic idempotency key defeats the store's F4 rotation/re-mint safety; retries of differing content are permanently rejected

`pushRecordedMailbox` always stamps every push with a deterministic key
`credpush:${ctx.tenantId}:${mailbox.email}` (`apps/platform/src/engine/mailbox-credential-push.ts:104`),
passed on the initial push AND every reconcile retry. The engine store's keyed mode is designed to
**reject a reused key carrying different content** (`apps/engine/src/mailbox-store.ts:119-131`) — that
is correct store behavior, and both branches are individually tested (`apps/engine/test/mailbox-store.test.ts:67`
rotation-without-key → "replaced"; `:76` rotation-with-key → rejected). The defect is the **wiring**:
the caller supplies exactly the key that forces the rejection path, so the store's advertised rotation
support (`mailbox-store.ts:28-34`, "OAuth refresh tokens rotate ... must be allowed to overwrite") is
unreachable from the only production caller.

**Failure scenario (reachable on the armed path):** a first push commits engine-side but the HTTP
response is lost (a timeout after the engine's `renameSync` — the exact at-least-once boundary F6 exists
for). Row stays `'pending'`. Reconcile retries, re-assembling credentials fresh via
`assembleEngineCredentials` → `deps.fetchCredentials()` + `deps.mintGrant()`
(`mailbox-credential-push.ts:87-95`). If the re-assembled content differs — guaranteed on the
programmatic `InboxKitOAuthMinter` path (every `mintGmailGrant` runs a fresh consent → a new refresh
token, `oauth-mint.ts:94-114`), possible on the manual path if InboxKit rotated the IMAP app-password —
the retry pushes different content under the same key → engine throws `BadRequestError` → row stuck
`'pending'` forever, reconcile fails on every sweep. The design's stated premise "the engine's write is
idempotent (F4), so a retry is safe" (`mailbox-credential-push.ts:20-21`) is **false** for any retry
whose re-minted payload differs. `MailboxCredentialStore.remove()` (`mailbox-store.ts:163-168`) does not
clear the idempotency record, so a teardown+re-provision cannot recover either.

**Verification (RAN, against the real engine source):**
```
initial push  -> created
rotation push -> THROWS: BadRequestError - idempotency key credpush:t_abc:mordy@authorpitchdesk.com
                 was already used for a different mailbox push (...) — a key must map to one request
engine still resolves refreshToken: refresh-token-v1 (stale if it did not rotate)
```

**Root-cause fix:** stop passing a key from `pushRecordedMailbox` — the store's content-hash replay-safety
already makes a same-content retry a no-op (`'unchanged'`) AND makes a differing-content retry a first-class
`'replaced'`. The deterministic key adds no safety this caller lacks and one reachable hard-fail. (`file:line`:
`apps/platform/src/engine/mailbox-credential-push.ts:104,107`.)

### 2. NON-BLOCKING — the DELETE/revoke path is coded and tested but has ZERO production callers; canceled tenants' OAuth refresh tokens linger on the engine indefinitely

`EngineMailboxClient.removeMailbox` (`engine-mailbox-client.ts:65`), the engine `DELETE /v1/mailboxes`
route (`router.ts:64-69`), `engine.removeMailbox` (`engine.ts:237-240`), and `store.remove`
(`mailbox-store.ts:163-168`) are fully built and tested, but `.removeMailbox(` has **no non-test caller**
(grep: only `engine-mailbox-client.test.ts:27,55`). The comments assert this fires on "cancel/teardown"
(`engine-mailbox-client.ts:64`, `engine.ts:232-233` "a released vendor slot's tokens stop resolving here")
— but nothing in the cancel/lifecycle path invokes it. **Failure scenario:** a tenant cancels; the vendor
mailbox is released (`RealMailboxPort.release`) but its pushed credentials — including the gmail_api refresh
token — remain in `pushed-mailboxes.json` on the daemon forever. Not exploitable in the deployed build (dark),
but it is an unshipped half of the I3 credential lifecycle and a credential-retention gap once armed. Either
wire it into cancel/teardown or the "stop resolving here" comment is false. Compounds finding 1: even wired,
`remove()` leaving the idempotency record means a later same-email re-push is still rejected.

### 3. NON-BLOCKING — `parseGrants` silently coerces a malformed `GMAIL_OAUTH_GRANTS` secret to empty

`parseGrants` (`mailbox-credential-push.ts:175-193`) catches a JSON parse error and returns `{}`. An operator
who sets `GMAIL_OAUTH_GRANTS` but mistypes the JSON gets it silently treated as "no grants" — every mailbox
then fails loud per-mailbox at `ManualOAuthMinter.mintGmailGrant` ("no manually-minted grant supplied"), so
it fails closed with a clear downstream error, but the root cause (bad secret shape) is swallowed at parse.
Log the parse failure. Dark until arming.

---

## Attacks that failed (why the PASS is meaningful)

- **Ledger #1 — simulate-route becomes spend-authorizing (my prior coldstart blind-spot).** The new InboxKit
  leg in `isRealSpendArmed` (`billing.ts:38-44`) only makes the simulate guard *stricter* (fail-closed on more
  signals). Diff adds **no new `billing_state` writer** (grep clean) and does not touch `factory.ts` /
  `activation` / `lifecycle`. The guard is enforced at both the route (`checkout.ts:44`) and defense-in-depth in
  `completeSimulatedCheckout` (`billing.ts:114`). No dormant writer re-armed. Held.
- **R3-1 failing-by-construction guard.** Traced three evasion shapes against `parseEnvFields`
  (`spend-armed-env-coverage.test.ts`): a new `// spend-arming` field not wired into `isRealSpendArmed` → trips
  the "every spend-arming referenced" assertion RED; a new untagged field → trips the "every field categorized"
  assertion RED; a `// spend-arming` comment on a separate line from the field → field lands uncategorized →
  RED. The "non-vacuous" test pins the exact set incl. both `INBOXKIT_*`. RAN standalone: 4/4 pass, not skipped.
  Held.
- **F5 corrupt-store fail-loud.** `loadJsonStateFile` (`store.ts:154-181`) distinguishes ENOENT (empty first
  boot) from corrupt (throw) and rejects non-object/array; a 0-byte file → `JSON.parse("")` → throws. Both the
  engine state and the pushed-credential store route through it, and `index.ts:41-42` constructs both at boot so
  a corrupt file aborts start rather than overwriting the only copy of the refresh tokens. Held.
- **Gate (b) exact-email-before-cancel.** `resolveMailboxUid` (`mailbox-port.ts:155-171`) reconstructs
  `username@domain_name` and requires case-insensitive equality before returning the uid, so a fuzzy keyword
  near-match fails loud rather than cancelling the wrong paid mailbox; enforced for every uid consumer
  (release/health/warmup/creds), not just cancel. Safety direction correct (fail-closed). Held.
- **Gate (c) provision idempotency + claim-then-execute race.** `withRequestIdempotency` (`idempotency.ts`)
  INSERTs the `'pending'` claim synchronously before the first await (one input-gate turn), reclaims a stale
  claim in-place synchronously, and DELETEs on throw (failures not cached). `PENDING_CLAIM_TTL` (10 min) is
  sized above the longest wrapped fn and ~4300x below the row-eviction TTL. The RED-proof
  (`provision-idempotency.test.ts`) counts vendor buys and asserts exactly 1 across two identical runs, 2 for
  two distinct mailboxes. Genuine behavioral proof. Held.
- **Engine double-send race.** `claimSend`/`releaseSend` (`store.ts:77-86`) unchanged; `send` claims before the
  SMTP await with no intervening await (`engine.ts:85-100`). Not touched by this diff, still intact. Held.
- **Tenant isolation on new state.** Every `mailbox_cred_pushes` access is `WHERE tenant_id = ?`
  (`mailbox-credential-push.ts:74-84,108-124,160-161`) and the table lives in the per-tenant DO; the reconcile
  is dispatched on the tenant's own context (`tenant-do.ts:628`). Held.
- **Secrets in code/logs.** No secret literal in the diff. `pushRecordedMailbox` records `err.message` to
  `last_error`, but the engine's error messages carry the idempotency key/email/status — never the bearer token
  (header only) and never the credential values (zod issues don't echo values). Held.
- **Gate (d) display honesty rename fan-out.** `reputationScore`/`placementRate` survive only as the shared
  `MailboxHealth` port contract, mapped to `vendor*`-prefixed display fields at `getInfrastructureStatus`
  (`provisioning.ts:239,285-286`) and in `apps/dashboard/src/api/types.ts`. No consumer reads the old display
  names. Held.

## UNVERIFIABLE (no live vendor calls permitted; resolve at first live mailbox)

- All InboxKit/engine wire behavior. The vendor request paths and response field names in `mailbox-port.ts`
  (`showMailboxCredentials`, `/mailboxes/list` shape) and `oauth-mint.ts` (`InboxKitOAuthMinter`) are
  self-labelled DOCUMENTED-SHAPE GUESSES / UNVERIFIED. The programmatic OAuth-mint path is dark. Resolvable only
  at the first live mailbox.
- Gate (b) `limit: 1` interaction: whether InboxKit's keyword search always ranks the exact mailbox #1. If it
  does not, `resolveMailboxUid` fails loud (safe) but a legitimately-existing mailbox becomes unresolvable
  (fail-closed). Vendor-dependent; verify at first live mailbox.

## NEW (out of scope, no verdict weight)

- The R3-1 env parser's interface-body break condition is `/^ {4}\}/`. A future env field whose *type* is a
  multi-line object literal containing a 4-space-indented `}` would break the parser early and could let a later
  field escape categorization. No such field exists today; noted for the next env.ts editor.
- The engine `MailboxCredentialStore` idempotency map has no eviction (bounded by distinct mailbox count —
  fine for the single-daemon pilot).
