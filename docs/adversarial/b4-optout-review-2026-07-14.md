# B4 opt-out — adversarial gate (2026-07-14)

- **Ground:** repo `~/dev/coldstart`, HEAD `f74687df55616d60fde7af54a8cf0832e29d11cd`, on `main`, diff UNCOMMITTED (matches the brief; read-only git only).
- **Reviewer:** adversary (fresh context). Verdict decides commit.
- **Evidence:** root typecheck exit 0; platform suite **316/316** (53 files, 90s); `wrangler deploy --dry-run` OK (`PUBLIC_BASE_URL` bound). All independently re-run this session. Matcher probed as a pure function in a scratch sandbox.

## VERDICT: NO-SHIP

One BLOCKING finding. The B4 **mechanics** (token, endpoint, matcher, headers, footer, suppression extraction, tests) are ship-ready and survived every attack. The blocker is a surviving, legally-material CAN-SPAM **copy overclaim** on lines this diff edits — the exact "overclaim that survives = NO-SHIP" standard the repo committed to.

---

## Findings

### 1 — BLOCKING · lens 5/6 (copy-vs-code) · "physical postal address + verified sender identity are injected into every message footer" is false, and ships on this diff's edited lines

**Failure scenario.** The deployed site tells customers CAN-SPAM is handled "structurally": `site/faq.html` (both the JSON-LD `acceptedAnswer` and the visible `<details>`) and `site/guide-domains-inboxes-warmup-compliance.html` (JSON-LD, the `.lede`, and the `#compliance` section) all assert, on lines this diff modifies, *"a required physical postal address and verified sender identity are injected into every message footer."* The code injects **neither**:

- `physical_address` / `sender_identity` are **written only** to `tenant_profile` (`apps/platform/src/engine/provisioning.ts:131`) and are **never read anywhere in the send path** (grep across `apps/platform/src` + `packages/`: schema + provisioning write only; zero reads). 
- The only thing `engine/tick.ts`'s `appendUnsubscribeFooter` (tick.ts:96) adds to the body is the **unsubscribe link** — no address, no identity.
- The visible `From` is the bare mailbox email `picked.email` (tick.ts:307 / smtp.ts:49), **not** the `sender_identity` display form.
- The builder's own comment concedes it: tick.ts:91-93 — *"the tenant's physical address, collected at setup, is not yet injected anywhere either — a pre-existing, separate gap this task does not close."*

CAN-SPAM (15 U.S.C. §7704(a)(5)) makes a valid physical postal address **mandatory in every commercial email**. The copy asserts this as a done, structural feature while the code omits it entirely — a material, legally-exposing overclaim.

**Nuance (stated honestly).** This falseness is **pre-existing** — before this diff the send path appended no footer at all, so the address claim was already false; this diff did not introduce it and was scoped to the RFC 8058 clause. BUT the diff **edits and ships these exact sentences** (the whole sentence is one line; the `+` lines carry the false clause), in the very diff whose purpose is accurate compliance copy. Under the standard the brief itself restated — *"An overclaim that survives = NO-SHIP"* — and item 6's explicit instruction to rule on this, it blocks. `site/pricing.html` and `site/guide-cold-email-with-ai-agent.html`'s changed lines do **not** make the footer claim (clean).

**Remedy (cheap either way).** (a) Soften/remove the "physical postal address and verified sender identity are injected into every message footer" clause on the two files, OR (b) actually wire address+identity into `appendUnsubscribeFooter` (the values are already collected at setup). The team lead owns the scope call (ship B4 mechanics + track copy as separate pre-existing debt is a defensible alternative), but per the stated standard the verdict on the diff as-presented is NO-SHIP.

**Verification method:** grep (no reads in send path) + read of the changed HTML `+` lines + read of `appendUnsubscribeFooter` + builder's tick.ts:91-93 comment.

---

## Attacks that FAILED (the B4 mechanics held)

- **Token forgery (lens 1, 8).** `unsubscribe-token.ts`: HMAC-SHA256 over `tenantId:email`, key domain-separated from `auth.ts`'s pepper use via a labelled HMAC derivation, constant-time compare (`timing-safe-equal.ts`: length gate then per-char XOR-accumulate). Bit-flip / truncation / wrong-tenant / wrong-email / empty / unrelated-well-formed-sig / different-pepper all reject — ran `unsubscribe-token.test.ts` (8/8) + `unsubscribe.test.ts` forgery block. **Delimiter-injection disproven:** signing side's `tenantId` is a server-minted `ten_...` id (schema `newId`, colon-free) and verify concatenates `tenant:email` literally, so the string has exactly one colon and no two distinct `(tenant,email)` query pairs reconstruct it; even an exotic colon-in-email re-split routes to a fresh empty non-existent DO (harmless). Uppercase-hex / normalization games fail-closed (charCode mismatch), no case-fold or Unicode normalization anywhere between sign and verify — the raw bytes round-trip through `URLSearchParams` exactly.
- **GET side-effects (lens 2, 3).** `routes/unsubscribe.ts` GET only parses → verifies → renders `confirmPage`; **no `c.env.TENANT.get`, no write.** Mail-scanner / SafeLinks GET-prefetch cannot suppress. Proven by code read + test (`GET valid` leaves `suppressionRow` undefined; `unsubscribe.test.ts:172-186`).
- **One-click POST.** Requires a valid signed token **before** the DO stub is resolved (route verifies, then `stub.unsubscribeByEmail`). Route is genuinely unauthenticated (not in `AUTHED_PATH_PATTERNS`, mounted on outer `app` before the `authed` sub-app). Body is never read (only `content-length` cap-checked → 413), so no parse-amplification.
- **Matcher false positives (lens 5).** Ran the exact `isUnsubscribeIntentReply` source against 12 adversarial FP candidates in a scratch sandbox — **zero false positives**; every match is a genuine opt-out phrase (trailing `.!?,` stripping and single leading/trailing "please" are the only normalizers). Quote-stripping handles `>`-prefixed lines, `On … wrote:`, and `-----Original Message-----`; the outbound footer / a quoted original can't trigger (long strings vs exact whole-body match). Inbound body is **plaintext** (`classify.ts:109` `parsed.text ?? ""`), not HTML. Conservative false-negatives (mobile "Sent from my iPhone" signatures, "please please unsubscribe", zero-width chars) accepted per the design's stated bias.
- **Footer injection (lens 4).** Body sent as `text:` (smtp.ts:52) → plaintext append is safe, no HTML corruption. Appended **after** template render (URL carries no `{{}}`). Token embeds **this row's** `lead_email` → per-recipient scoped, no cross-lead token leak. No double-append on retry (`renderedBody` re-derived fresh each tick). Send body and recorded `'sent'` metadata **both** use `sentBody` → [NEW-3] fidelity preserved; the subject-fidelity loosening to `toContain` does **not** mask a regression (greeting substring + `not.toContain("{{")` still asserted, and send==record still holds because both read the same `sentBody`).
- **Suppression extraction / regression ring (lens 7).** `suppress`/`cancelPendingSteps` moved to `engine/suppression.ts` byte-for-byte (bounce/complaint logic unchanged — diffed). Reply event recorded **before** the unsubscribe branch; typed-unsub correctly overrides `stopOnReply` (sets `'suppressed'`, cancels regardless of the flag) and is idempotent (`alreadySuppressed` gates the per-lead event insert; repeat click → no second `unsubscribe` event). Proven by the two e2e typed-unsub tests + the idempotency test.

## Rulings on the builder's flagged residuals

- **No rate limiting** → acceptable; the crypto boundary is the gate (no valid token = no effect; a token-holder is the recipient). NON-BLOCKING.
- **Token never expires + pepper rotation invalidates all outstanding links** → acceptable residual (opt-outs don't expire; rotation is a deliberate operator action). ACTIVATION note, NON-BLOCKING.
- **Matcher body-only (no subject)** → acceptable; `PolledReply` has no subject and the matcher is conservative. NON-BLOCKING.
- **CAN-SPAM physical-address footer not wired** → this is the BLOCKER, but **only because the copy claims it is done** (Finding 1). Absent the claim it would be a NON-BLOCKING pre-existing gap.
- **Accepting any POST body (no RFC 8058 `One-Click` marker required)** → NON-BLOCKING; only token-holders can trigger and suppression is the fail-safe direction.

## UNVERIFIABLE

None material to this diff. The real SMTP/IMAP wire adapters (`apps/engine`) have no default-CI run coverage, but this diff doesn't touch them; the sandbox round-trips `listUnsubscribe`/`listUnsubscribePost` and the header test asserts both forms + the Post header + the in-body link end-to-end.

## NEW (out-of-scope) observations — no verdict weight

- The visible `From` is the bare mailbox email, not the `sender_identity` display name (pre-existing; no friendly From display on outbound). Separate from B4.
- Mobile-signature and multi-sentence false-negatives will miss many real typed opt-outs; the hosted one-click link mitigates. Product-effectiveness, not correctness.

VERDICT: NO-SHIP

---

## Fix-round addendum (2026-07-14, same-day delta re-attack)

Delta = tick.ts footer now injects address+identity+opt-out (one `profile` read), a post-claim CAN-SPAM fail-safe, +3 tests, and a copy pass removing "verified" from 5 sentences in the two blocked files + 2 orchestrator-fixed siblings. Ground: HEAD `f74687d`, same uncommitted worktree; nothing outside the delta changed.

**Original blocker (Finding 1) — CORE RESOLVED.** `physical_address`/`sender_identity` are now READ (tick.ts:143-150, folded into the existing single-row lifecycle SELECT) and injected into the sequence-send footer via `appendComplianceFooter` (tick.ts:88-107, call site :319-321). The footer test asserts the sent body contains both the identity (`Sender <s@...>`) and address (`1 Test St`), and that the recorded `'sent'` metadata is byte-identical to the sent body ([NEW-3] fidelity). The 7 originally-fixed sentences now read true of the code (identity+address are injected for the primary commercial send path).

**Fail-safe — HELD under attack.** Blank address/identity ⇒ row `'failed'` + a `type='failed'` compliance event, no send. The post-claim placement is correct: the due-row SELECT (tick.ts:229) picks only `status='pending'` and the reclaim (tick.ts:182) touches only `'sending'`, so a fail-safe `'failed'` row is TERMINAL and never re-processed; the atomic claim (:295 `WHERE id=? AND status='pending'`) serializes concurrent ticks so exactly one reaches the fail-safe — the NULL-message_id/distinct-under-dedupe reasoning is sound BECAUSE the claim, not the INSERT-OR-IGNORE, is the race boundary. Visible in both `campaign_results` (reporting.ts:16/25 counts `failed` events) and ops-summary (ops-summary.ts:95 counts `status='failed'` rows) — same taxonomy as existing send failures. Both fail-safe tests are non-vacuous (direct DO-storage blank → assert not-sent + status + event stage/reason).

### NEW BLOCKING (fix-round) — the "verified" class sweep was INCOMPLETE

- **BLOCKING · lens 7 (regression/class-completeness) · a third live-site "verified sender identity" instance survives the sweep.** The builder's grep found 2 siblings (guide-cold-email-with-ai-agent.html:89, openapi.yaml:828); it MISSED `site/guide-mcp-cold-email.html:84` — a published guide page (linked from `site/llms.txt:25`), entirely outside the original diff — which still annotates `senderIdentity: string (1-200 chars) // verified legal sender identity`. Same class: the field is customer-supplied free text, validated only `min(1)/max(200)` (intents.ts), never verified. Per this brief's explicit rule ("a survivor is a blocker"), this blocks. `README.md:82` ("...+ verified sender identity injected into every message footer") is the same class in a canonical doc (the brief scoped the sweep "sitewide + docs"). Remedy: identical to openapi:828 — drop "verified" (→ "captured at setup") on both. **NOT class survivors (correctly left):** docs/adversarial/* frozen records (incl. this file) quote the old text as a finding; ROADMAP/HANDOFF "verified" refer to legal-doc/DO-identity verification, a different subject. Verification: `grep -rni verified site/ README.md` + read of guide-mcp-cold-email.html:78-92.

### NON-BLOCKING (fix-round)

- **Manual-reply path ships footerless.** `threads.ts:147` (`replyToThread`, the inbox `reply` tool) sends with no `appendComplianceFooter` and no List-Unsubscribe header. Pre-existing, untouched by B4; a 1:1 conversational reply is defensibly a relationship/transactional message outside CAN-SPAM's commercial-footer requirement, and the copy's "every applicable message" framing covers it. Flagged so it's a conscious ruling, not blocking. The copy's unqualified "every message footer" phrasing is mildly over-broad against this path but was not the round-1 blocker (that was "never injected ANYWHERE") and isn't newly escalated here.
- subject-fidelity.test.ts:66 comment still names `appendUnsubscribeFooter` (renamed to `appendComplianceFooter`) — cosmetic.

### Suite evidence (independently re-run this round)
Root typecheck exit 0 · platform suite **319/319** (53 files) · `wrangler deploy --dry-run` OK (PUBLIC_BASE_URL bound). Fail-safe/footer tests confirmed behavior-asserting.

FINAL VERDICT (fix-round): NO-SHIP — one BLOCKING survivor (`site/guide-mcp-cold-email.html:84` + `README.md:82` still say "verified sender identity"). Everything else in the delta is clean; this is a one-word-per-site sweep completion, then SHIP.

---

## Round-3 addendum (2026-07-14, sweep-completion re-attack)

Round-3 delta: (1) guide-mcp-cold-email.html:84 → "// legal sender identity, captured at setup"; (2) README.md:82 → "sender identity (captured at setup)"; (3) subject-fidelity.test.ts:66 comment → describes the compliance footer. All three read true. Suite re-run: **319/319** (53 files) — the test-comment change broke nothing.

**ONE MORE SURVIVOR — and now the COMPLETE inventory.** I ran an exhaustive `git grep -niE "verif" -- ':!docs/adversarial'` filtered to lines mentioning sender/identity/address/footer, and classified all 18 hits. Exactly ONE is the class:

- **BLOCKING · lens 7 · `ARCHITECTURE.md:52`** — a CLAUDE.md-canonical living doc — still reads "Per-tenant physical address + **verified sender identity** injected into every footer." Same overclaim (the field is never verified). It was outside the orchestrator's round-3 grep scope (site/, README.md, AGENTS.md), and my OWN round-2 sweep suppressed it: my exclusion filter `grep -v "domain.*verif"` dropped this line because the same long sentence also mentions "cryptographic domain-ownership verification" — a filter false-negative. Remedy: drop "verified" (→ "sender identity (captured at setup)"), identical to the README:82 fix. Verification: exhaustive git grep + read.

**All 17 other "verif" hits are NON-class (do not touch):** domain-OWNERSHIP verification (README:84, SPEC:131/191/485 — an activation step, a different thing), the DO's runtime **verified identity** (tenant-do.ts:225, vendors/README.md:29, factory.ts:65 — auth, not a footer claim), legal-doc "verified" (HANDOFF:10, ROADMAP:26), brand-name availability "verified-available" (FINAL-REPORT:24), dogfood "verified entries" (ROADMAP:39), GDPR "lawful-basis verification" (guide-domains:94), deliverability "verifiable part" (deliverability guide:77), CCPA "verify your identity" (privacy.html:75), archive/ + research/ + spike files. None is the sender-identity-in-footer class.

So after ARCHITECTURE.md:52 is fixed, the "verified" class is genuinely closed sitewide + docs — this is the last member; there is no further survivor to find.

FINAL VERDICT (round 3): NO-SHIP — one remaining BLOCKING survivor, `ARCHITECTURE.md:52`. It is the complete remaining inventory (exhaustive git grep, all hits classified). Fix that one line → SHIP; nothing else outstanding, mechanics + fail-safe + tests all clean, suite 319/319 / typecheck 0 / dry-run OK.

---

## Round-4 close (2026-07-14) — SHIP

`ARCHITECTURE.md:52` now reads "physical address + **sender identity (captured at setup)** injected into every footer" — "verified" removed. Re-ran my airtight class sweep with per-hit classification (no line-exclusion filter, per the round-2 lesson) across all tracked files excluding frozen adversarial records: **zero class survivors**; the belt-and-suspenders `git grep -niE "verified (legal )?sender"` returns ZERO. All four class members (site/guide-mcp:84, README:82, ARCHITECTURE:52, + the openapi/guide-cold-email siblings) and the 5 original blocked-file sentences now read true of the code. Fresh evidence: root typecheck exit 0 · platform suite **319/319** (53 files). Mechanics (HMAC token, GET side-effect-free, conservative matcher, plaintext footer, send==metadata fidelity, byte-identical bounce/complaint extraction) and the CAN-SPAM fail-safe (terminal-'failed' placement, claim-serialized, ops-visible) held across all rounds. Sole standing NON-BLOCKING note: threads.ts manual-reply ships footerless (pre-existing, defensible relationship/transactional message under "every applicable message").

VERDICT: SHIP
