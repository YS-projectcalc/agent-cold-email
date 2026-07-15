# Adversarial review — Directory-shopfront refresh (uncommitted diff)

- **Date:** 2026-07-15
- **Reviewer:** adversary (fresh context)
- **Frozen against:** worktree HEAD `efc3d74cedcfd8c200bb32936d419fef0a4d31ec` + 4 uncommitted working-tree modifications
- **Scope (exactly 4 files):** `README.md`, `packages/cli/README.md`, `server.json`, `site/.well-known/mcp/server-card.json`
- **Gate:** verdict gates commit + push (push re-renders every GitHub-fed directory listing)

## VERDICT: **SHIP** (0 blocking; 1 non-blocking recommendation)

No affirmatively false clause on any changed line. Every version number, tool count, URL, and pricing figure verified against source and the live site. The one judgment call the brief delegated (server.json's disclaimer-free 100-char description) is borderline but defensible — recommend a cheap tightening before push, not a blocker.

---

## Per-attack findings

### #1 Overclaim classes — HELD, with one non-blocking recommendation
- **real-sending-live implication:** No surface claims real sending is live. README top banner (`:9`, pre-existing, preserved) "not yet available for real sending"; new README Status section "real sending isn't armed yet"; cli/README "no real domains, mailboxes, or sends yet"; server-card `statusNote` "Real sending is not active." Strong, redundant disclosure.
- **webhooks:** No webhook overclaim. The only "webhook" token (server-card `:51`, pre-existing activity-tool desc) is an honest *negative*: "Push webhook subscriptions are not in the current public API."
- **AI support:** None claimed. server-card keeps the pre-existing honest framing "The customer's own agent remains the strategy and content layer."
- **deliverability guarantees:** None. README banner explicitly "no inbox-placement or deliverability guarantees"; the ≈3,300 number is hedged "conservative planning capacity … bounded by warmup stage, mailbox health, and provider policy … never a purchased allowance."

**NON-BLOCKING — server.json description, the builder's deliberate 100-char tradeoff.**
New value (96 chars, cap is 100): `Agent-native cold-email infra: 17 tools, free sandbox demo now. Pricing: $99/mo for 5 mailboxes.`
Every clause is individually TRUE (17 tools ✓, sandbox demo is live ✓, $99/5-mbx pricing ✓). The weakness is an *omission*: this is the only refreshed surface with no explicit "early-access / real-sending-not-live" marker, and server.json has no `status` field, so on a strict registry-entry-only read (the exact failure mode that killed the prior listing) the disclosure reduces to the word "sandbox." A skeptical buyer agent could parse "free sandbox demo now. Pricing: $99/mo" as "free tier = sandbox; paid $99 tier = the real, live product," which would misrepresent real sending as purchasable now.
- **Why non-blocking:** no false clause; "sandbox demo" is an industry-standard non-production signal; the sibling `.well-known/server-card.json` (which directories also render) carries the explicit "Real sending is not active" statusNote; a stated pricing model is not a transactability-now claim.
- **Recommended ≤100-char reword (restores the global early-access signal, keeps pricing+sandbox):**
  `Agent-native cold-email infra: 17 tools, free sandbox now. Early access; $99/mo for 5 mailboxes.` (96 chars)
  "Early access;" sits before the price as a whole-product qualifier, closing the free-vs-paid misread.

### #2 Factual accuracy — ALL VERIFIED
- **npm version:** `npm view agent-cold-email version` = `0.2.0`; versions `['0.1.0','0.2.0']`, dist-tag latest `0.2.0`. README, cli/README, server.json `packages[].version`, server.json `version`, and server-card `version` all say `0.2.0`. No stale `0.1.0` remains in any of the 4 files.
- **CLI actually works:** published 0.2.0 tarball ships `package/dist/index.js` with `bin: {"agent-cold-email":"dist/index.js"}` → `npx agent-cold-email demo` resolves and executes.
- **Tool count = 17:** `apps/platform/src/mcp/tools.ts` `MCP_TOOLS` has exactly 17 entries; live `POST /mcp {tools/list}` on the worker returns 17, names match source exactly.
- **URLs:** all 8 added/referenced links return 200 (pricing, compare, guide-cold-email-operation-claude-code, for-agents, agent-evaluation.md, faq, docs, root).
- **Pricing figures vs live coldrig.dev/pricing:** $99/mo for 5 mailboxes ✓, $10/mo per additional ✓, "$49 platform fee + $10/mailbox, five-mailbox minimum" ✓, ladder "5–60 mailboxes" ✓, "≈3,300 sends/mo" planning capacity ✓. All four files internally consistent with each other and the live page.
- **"vs Salesforge" (README Learn-more):** not a phantom — `/compare` hub links it and `compare-vs-salesforge.html` exists live + locally; all 7 named comparisons (DIY, Smartlead, Salesforge, AgentMail, Skyp, FoxReach, Maildoso) exist.
- **server.json description length:** 96 ≤ 100 (live schema cap, see #3).

### #3 server.json publish-safety — VERIFIED
- Identity fields unchanged vs HEAD: `name` = `io.github.YS-projectcalc/agent-cold-email` (matches pattern `^[a-zA-Z0-9.-]+/[a-zA-Z0-9._-]+$`, ≤200). `packages[].version` = `0.2.0`, unchanged, matches npm. Only the `description` string changed.
- Live schema (`.../2025-12-11/server.schema.json`, `ServerDetail`): `description` maxLength=100/minLength=1 → 96 is valid.
- Full `jsonschema` validation of current server.json against the live schema: **VALID** (passes; no errors). `mcp-publisher publish` schema validation will not fail.

### #4 server-card.json new `pricing` object — VERIFIED
- `pricing.model` / `freeTier` / `url` are sane and consistent with prose and site pricing ($99/5-mbx, $10 add'l, $49+$10 5-min, no send quota; freeTier "no signup, no card, no waitlist"; url → coldrig.dev/pricing).
- **`statusNote` survived byte-identical** to HEAD (diffed): "…Real sending is not active. Demo tenants are structurally unable to reach vendor adapters and incur no real spend."
- Schema safety: the card's `$schema` (`modelcontextprotocol.io/schemas/server-card.json`) is a pre-existing 404 (unchanged by this diff), and the file is served statically from `.well-known` — nothing schema-validates it, so the added `pricing` key cannot be rejected. (Pre-existing dangling `$schema` noted under NEW, out of scope.)

### #5 Cross-file / live-site consistency — VERIFIED
No contradictions among the 4 files or vs the live site on: pricing ($99/$10/$49/5-min/5–60), tool count (17), CLI version (0.2.0), sandbox framing (free, no card, no waitlist), and real-sending-not-live posture. "unlimited" appears nowhere (send-framing ruling honored); the ≈3,300 number is demoted below the no-send-quota framing and hedged, per the ROADMAP ## Open ruling.

### #6 Regression — VERIFIED
Only the stale waitlist framing was removed ("Want to be notified when real sending goes live? Join the waitlist…" → "Try it now — free sandbox, no card, no waitlist" + Learn-more block; cli/README "Not yet published to npm" → "Early access. Published on npm as 0.2.0"). Every early-access disclosure preserved or strengthened:
- README `:9` banner (pre-existing): "not yet available for real sending … no … deliverability guarantees."
- README Status section: "Stripe cannot take money … real send/receive engine … not yet armed or deployed."
- cli/README: "Early access. … no real domains, mailboxes, or sends yet"; demo still ends "this ran in a sandbox, no real emails were sent, real sending is early-access."
- server-card `statusNote`: byte-identical (see #4).

---

## Attacks that failed (what held)
- **Overclaim sweep on every changed line** → tried real-sending-live, webhooks, AI-support, deliverability-guarantee reads; every affirmative clause is true and every surface except the capped server.json description carries an explicit early-access marker.
- **Schema-rejection of the publish** → validated full server.json against the live 2025-12-11 schema with `jsonschema`: VALID; description 96 ≤ 100 cap I read from the resolved `ServerDetail` definition myself.
- **npx-would-404** → unpacked the published 0.2.0 tarball; bin target `dist/index.js` is present.
- **Phantom comparison ("vs Salesforge")** → hub links it and the page exists live + on disk.
- **statusNote silently dropped** → diffed HEAD vs working; identical.
- **Pricing drift between files / vs live** → extracted figures from the live pricing page and every file; all agree.
- **Stale version residue** → grepped all 4 files for `0.1.0`: none.

## UNVERIFIABLE
- **Whether a specific directory (Glama/PulseMCP) renders server.json `description` in isolation vs the fuller ServerDetail** — depends on each directory's template; I confirmed the MCP-Registry ServerDetail carries more disclosure (env-var descriptions "free, no card") but could not drive each third-party listing's live rendering. This is the residual risk behind the #1 recommendation; resolving it = adopt the 96-char reword as cheap insurance.

---

## ADDENDUM (post-dispatch) — scope +1 file `glama.json` + mid-review commit

**Baseline moved during review: `efc3d74` → `ebd1a12`** ("feat(shopfront): directory-source refresh…"). The 4 reviewed files + `glama.json` + `ROADMAP.md` + this verdict doc were committed mid-review (shared-worktree mutation class). Re-verified the committed bytes:
- Committed content == the working-tree bytes I reviewed. `git diff --numstat efc3d74 ebd1a12` for README (14/3), cli/README (18/6), server-card (7/2), ROADMAP (2/2) are byte-identical to the working-tree diff I reviewed; server-card `statusNote` decoded-compares UNCHANGED; no unreviewed content slipped into any file.
- **server.json (the one delta beyond my review):** description was replaced with my recommended NB reword — committed value `"Agent-native cold-email infra: 17 tools, free sandbox now. Early access; $99/mo for 5 mailboxes."` (96 chars, re-validated VALID against the live schema). Plus two no-ops: em-dash `—`→`—` (same char, JSON escape) in an env-var description, and a trailing newline added. **→ My single NON-BLOCKING finding (#1) is RESOLVED in the committed bytes.**

### Attack #7 — repo-root `glama.json` (scope add) — VERIFIED / HELD
On-disk + committed bytes (identical): `{"$schema":"https://glama.ai/mcp/schemas/server.json","maintainers":["YS-projectcalc"]}`.
- **Schema fetched myself** (`https://glama.ai/mcp/schemas/server.json`, HTTP 200, draft-07): `type:object`, `required:["maintainers"]`, sole declared property `maintainers` = array of unique strings (GitHub usernames). Builder's claim confirmed exactly.
- **`jsonschema` validation: VALID.** Zero undeclared data fields (only `maintainers` + the `$schema` meta-pointer). (`additionalProperties` is unset → defaults true, so even extras wouldn't fail; none present.)
- **Maintainer handle matches repo owner:** `server.json` repository URL `github.com/YS-projectcalc/agent-cold-email` → owner `YS-projectcalc` == `maintainers[0]`. ✓
- Location correct: repo root (`git rev-parse --show-toplevel` = the dir holding glama.json), which is where Glama reads it.

### Updated verdict
**SHIP — 0 blocking, 0 outstanding non-blocking** (the one NB was adopted into `ebd1a12`). glama.json is valid, minimal, and correctly attributed. Note per brief: a founder ruling on early-access framing is PENDING and may trigger a reframe round — this verdict judges the current committed bytes as-is.

## NEW (out-of-scope, no verdict weight)
- `site/.well-known/mcp/server-card.json` `$schema` → `modelcontextprotocol.io/schemas/server-card.json` returns 404 (pre-existing; not touched by this diff).
- `ROADMAP.md` residual (i): `SPEC.md:102` header still reads "~8–12 tools" — same staleness class the Glama shopper hit; already logged in ROADMAP as out of the builder's scope.
