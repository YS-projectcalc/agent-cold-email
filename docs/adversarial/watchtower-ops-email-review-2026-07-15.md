# Adversarial review — watchtower + ops-email increment (2026-07-15)

Frozen record. Reviewer: `adversary` (fresh context). Ground: `git rev-parse HEAD`
= **`686e506825c5fbf0296b418cd34c1ac7622fc85c`** (uncommitted diff in the live
shared worktree; git read-only). Scope: every modified/untracked file except
ROADMAP.md and `.claude/` / agent-memory paths.

## VERDICT: **SHIP** (no BLOCKING defect survives self-refutation)

Zero blocking findings. Several NON-BLOCKING residuals and two UNVERIFIED items
(one requires a real deploy, one requires Cloudflare's server-side header
composer). The increment ships DARK correctly: the `send_email` binding IS
declared in prod, so `createOpsMailer` returns the **real** mailer, and darkness
rests entirely on the binding throwing `E_SENDER_NOT_VERIFIED` at `.send()` time
being caught by every caller — which I verified holds at all three call sites.

Verification re-run (not trusting the builder's green):
- `npm run typecheck -w @coldstart/platform` → exit 0.
- 5 new test files (`watchtower`, `support-inbound`, `x-api-key`,
  `admin-dunning-email`, `ops-mailer`) → **23/23 pass**.
- `wrangler deploy --dry-run` → OK; shows `env.OPS_EMAIL (unrestricted) Send
  Email` + the `*/5 * * * *` cron.
- Full suite → **341 passed / 4 failed** — the 4 failures are all in
  `test/waitlist.test.ts` (429≠200) and are **pre-existing, diff-independent**
  flake (see NB-1). `waitlist.test.ts` passes 11/11 in isolation.

---

## Per-attack findings

### Attack 1 — Alert state machine (storm/flap/cooldown/crash-window)
Cooldown boundary math is correct (`>=` at exactly `T0+COOLDOWN` re-alerts once;
`-1` suppresses; test asserts both). `since_ts` preserved across re-alert,
`last_alert_ts` advances. Recovery re-arms for a fresh flap. Multi-check
independence holds. `evaluateHealthChecks` cannot throw (every probe + the
per-tenant scan is individually try/caught). `trySend` never throws.

- **NB-2 (design residual, non-blocking): a transient send failure at the exact
  healthy→unhealthy transition loses that alert for up to 6h.** In
  `reconcileAlerts` the alert branch (`watchtower.ts:181-183`) advances
  `last_alert_ts = nowMs` **even when `trySend` returned `false`** (send threw).
  Next tick sees `unhealthy` within cooldown → `suppressed` → no re-attempt until
  `WATCHTOWER_COOLDOWN_MS` (6h). This is *intended* for the dark channel
  (documented: "state is STILL advanced so a dark channel does not retry-storm").
  Once armed, a one-tick transient email blip coinciding with a real transition
  → founder blind for 6h on that check. Bounded: self-heals at cooldown; the
  external prober backstops total-platform-down; the whole feature is dark and
  arming is gated behind ACTIVATION verification. **Self-refuted down from
  blocking:** not reachable in normal armed operation (requires send failure
  *on the transition tick*), self-healing, backstopped. Recommend: on `trySend`
  failure in the alert branch, do not treat the alert as delivered — but note the
  `prev.last_alert_ts ?? prev.since_ts` fallback means a naive `last_alert_ts=null`
  still suppresses; a real fix keeps the check re-alertable. Worth an ACTIVATION
  residual line, not a commit blocker.
- Concurrent-cron overlap (two ticks) → at worst a duplicate alert email, no
  corruption; CF cron does not overlap same-schedule invocations by default.
  NON-BLOCKING.

### Attack 2 — Dark degradation (no uncaught throw breaks a path)
**REFUTED.** All three outbound legs are wrapped: `watchtower.ts:252` (inside
`trySend`), `ops-sweep.ts:126` (inside `trySendNotice`), `support-inbound.ts:72`
(`message.forward`, try/caught). `OpsMailNotConfiguredError` and
`E_SENDER_NOT_VERIFIED` both flow into these catches. The `email()` handler's
parse/persist can throw but only out of the *separate* `email()` entry point
(Email Routing retries) — never the `fetch()` request path or the sweep. In
`runScheduledOpsSweep` the watchtower runs LAST and inside `ctx.waitUntil`, so a
D1 error there cannot abort the earlier sweeps or any request.

### Attack 3 — X-API-Key lane
**REFUTED (clean).** `resolveRequestToken`: valid `Authorization: Bearer` wins;
a present-but-non-bearer/invalid Authorization returns `null` (fail closed, does
NOT fall through to X-API-Key); only a fully absent/empty Authorization consults
`X-API-Key`. The resolved token flows into the identical
`hashApiToken`→`lookupTenantByTokenHash` D1-index path as bearer — no plaintext
compare, no timing regression, value never logged. Tests assert all four
precedence cases + MCP transport. No check the Bearer path enforces is bypassed.

### Attack 4 — Inbound `email()` handler
`message.raw` is buffered exactly once (`support-inbound.ts:33`) before any
parse — no double-read. Envelope `message.from` (trustworthy) is used, not the
spoofable header From. The founder forward is a **raw passthrough**
(`message.forward`), not a re-rendered email, so there is no HTML/header
injection surface on the forward leg. Stored body is capped at 16k with a
truncation marker. No forward loop (destination is a different domain, never
routed back to the Worker; `reply` is never called).
- **NB-3 (carried, documented flag #3): tenant_id-NULL dedupe residual.**
  `insertSupportTicket` dedupes on `(tenant_id, message_id)`; SQLite NULLs are
  distinct, so inbound (NULL-tenant) tickets never dedupe. Blast radius: two
  distinct inbound emails sharing a Message-ID → duplicate ticket + duplicate
  founder forward. Post-insert there is no throw path (forward is caught), so
  Email-Routing redelivery does not double-insert. Pathological + low-harm.
  NON-BLOCKING, accepted.

### Attack 5 — Dunning + contact email
`runDunningSweep`'s suspend notice is gated on `if (applied && action ===
"suspend")` where `applied = insertDunningEventIfNew` (idempotent per
`(tenant, cycle)`), so it emails **once per cycle transition, not every sweep** —
no re-email storm. `contactEmail` is `z.string().email()` at the boundary
(CRLF-free), persisted via bound param (no injection into the `to` field). Null
contact email is FLAGGED (founder copy says so), not faked. HTML bodies escape
`brand`/`tenantId`/`declineCode`. Migration 0007 nullable, no default trap.
- **NB-4 / UNVERIFIED-A: `brand` (`z.string().min(1).max(200)`, no charset
  filter → CRLF-capable) is interpolated RAW into the dunning email `subject`**
  (`ops-sweep.ts` tenant notice + founder copy). The RealOpsMailer uses the
  structured `SendEmail.send(builder)` API (discrete `{to,from,subject,...}`),
  which composes MIME server-side and (for any well-behaved builder) encodes
  header values — so CRLF-in-subject most likely does NOT inject headers, unlike
  raw-MIME concatenation. Cannot be proven here (needs CF's composer). Recommend
  stripping CR/LF from `brand` at the signup boundary regardless (CLAUDE.md rule
  h; cheap defense-in-depth). NON-BLOCKING + UNVERIFIED.

### Attack 6 — Migrations 0007/0008
Valid D1 SQL. `0008` uses `CREATE TABLE IF NOT EXISTS` (idempotent). `0007`'s
`ALTER TABLE ADD COLUMN` is not idempotent but D1's migration tracker runs each
migration once — same pattern as existing ALTER migrations; only a manual
double-apply breaks. `watchtower_state` PK on `check_name` + single-row
`watchtower_cursor` need no extra index (readWatchtowerState reads all 4 rows).
The per-tenant failure-signal query `SUM(...) FROM events WHERE tenant_id=? AND
ts>=?` runs against a pre-existing DO table; a supporting `events(tenant_id,ts)`
index is a scale-path item (README acknowledges it) — NON-BLOCKING at test scale.

### Attack 7 — `.mcp.json`
Correct Claude Code http-server shape (`type:"http"`, `url`, `headers` with
`Authorization: Bearer ${AGENT_COLD_EMAIL_API_KEY}`). `${VAR}` expansion is
valid. No secret in the file (env var reference only). Well-formed JSON — will
not break `claude` startup.

### Attack 8 — Test honesty
Spot-checked 3 tests, all assert behavior:
- watchtower "SUPPRESSES within cooldown": drives 10 ticks, asserts each
  `suppressed`/`emailSent:false` and total `sent.length===1` — would fail if the
  cooldown gate broke.
- watchtower "dark mailer never throws + still advances state": injects a
  throwing mailer, asserts `alerted`/`emailSent:false` then next tick
  `suppressed` — pins the graceful-degradation contract.
- x-api-key "Authorization present-but-INVALID does not fall back": asserts 401
  with a valid X-API-Key alongside a bad bearer — would fail on a precedence
  regression.
`test/setup.ts` only appends migrations 7+8 to the existing apply loop — does not
mask failures.

### Attack 9 — CLAUDE.md project law
`ops-mail/` has a README. No god files (watchtower.ts ≈ 308 lines, single
responsibility — acceptable). No secrets in code (binding-is-credential; email
is public). `unsubscribe.ts` de-dupe (attack: regression on the compliance
surface) is a **strict superset** — the local 4-char escaper (`&<>"`) was
replaced by the shared 5-char `escapeHtml` (adds `'`→`&#39;`); values are now
MORE escaped, not less. No regression.

---

## Blocking vs carried

- **Blocking: none.**
- **Carried residuals (NON-BLOCKING):** NB-1 (pre-existing waitlist flake),
  NB-2 (transient-failure 6h alert gap — add an ACTIVATION residual line),
  NB-3 (tenant_id-NULL dedupe, documented), NB-4 (unsanitized `brand` in
  subject — strip CRLF at boundary), failure_signals over-sensitivity (below),
  events index scale-path.

### NB-1 — pre-existing waitlist test flake (NOT diff-caused)
The full suite is **not deterministically green**: 4 `test/waitlist.test.ts`
cases 429 under the full run. Root cause is `waitlist.ts`'s KV rate limiter
(`rl:${ip}:${windowBucket}`, wall-clock window, state not reset between tests) —
under a 166s full run the waitlist requests from the single test IP exhaust the
window budget. The diff touches NONE of `waitlist.ts` / the KV limiter / the rate
constants; the file passes 11/11 in isolation. This is pre-existing test-harness
fragility, exposed (not caused) by the longer run. Does not block THIS commit;
worth a test-isolation ticket. **Correction to task #35's "tests pass" claim: the
diff's own surfaces pass, but the full suite is red on unrelated pre-existing
flake.**

### Alerting quality — failure_signals threshold is `total === 0`
ANY single terminal-'failed' send or complaint in a 5-min window flips
failure_signals unhealthy → founder alert; the next empty window → RECOVERED.
Isolated per-lead failures (incl. routine CAN-SPAM compliance refusals, which
mark a row 'failed') produce alert/recovery churn and page the founder for
non-infra events. Behaves as specified; this is alert-quality feedback, not a
correctness bug. NON-BLOCKING.

---

## UNVERIFIED (cannot resolve in this environment)

- **UNVERIFIED-WITHOUT-DEPLOY — real-deploy safety of the un-onboarded
  `send_email` binding.** `wrangler deploy --dry-run` validates config LOCALLY
  only; it does not exercise Cloudflare's server-side deploy validation. I cannot
  prove from here that a real `wrangler deploy` accepts an `[[send_email]]`
  binding whose domain is not yet onboarded to Email Sending. (Strong prior:
  send_email bindings deploy regardless of domain onboarding — onboarding gates
  send-time, not deploy-time — but per brief this is marked UNVERIFIED, not
  accepted.) Resolves with: the owner's actual deploy, or a Cloudflare doc
  stating binding-deploy is independent of domain onboarding.
- **UNVERIFIED-A — CF Email Service header-composer sanitization** (see NB-4):
  whether the `send(builder)` API strips CRLF from `subject`. Resolves with a
  live send of a CRLF-bearing brand against the onboarded domain.

## Attacks that failed (survived — why the SHIP is meaningful)
- Dark degradation: every send/forward wrapped → traced all 3 sites.
- X-API-Key precedence + timing + logging: identical hash path, fail-closed.
- Dunning re-email storm: `applied`-gated, once per cycle.
- unsubscribe de-dupe regression: strict superset escaper.
- Event-type spec-trace: `type='failed'`/`'complaint'` match real writes in
  `tick.ts` + `reply-processor.ts`.
- RealOpsMailer shape: matches `SendEmail.send(builder)` overload exactly
  (typecheck 0); `messageId` return is real.
- DO probes: `RateLimiterDO.ping` uses `this.ctx.storage` like `hit()`; canary
  name never collides with a real bucket.
