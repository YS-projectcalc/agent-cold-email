# Anthropic Connectors Directory — listing draft (coldrig / agent-cold-email)

Status: DRAFT for founder review. Revised after `anthropic-mechanics` grounded
the real submission-form structure (wizard at
https://claude.com/docs/connectors/building/submission) and the review-policy
substance (https://claude.com/docs/connectors/building/review-criteria,
https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy).
Everything below is grounded in the live repo/site (paths cited inline) or in
those two docs; anything neither agent could ground is marked UNVERIFIED.

Source facts, so a reviewer can re-check without re-deriving:
- Repo: `~/dev/coldstart` (GitHub `github.com/YS-projectcalc/agent-cold-email`)
- Server card: `site/.well-known/mcp/server-card.json`
- Server (npm/registry) name: `io.github.YS-projectcalc/agent-cold-email` (`server.json`)
- Public brand: **Coldrig** (site, connect flows); package/repo/registry handle stays `agent-cold-email` permanently (`AGENTS.md:3`)
- Remote MCP endpoint: `https://agent-cold-email-api.yaakovscher.workers.dev/mcp` (streamable HTTP, JSON-RPC 2.0), same URL for every user (multi-tenant via per-user bearer token, not per-user URL)
- Tool count: 17, each carries `title` + `readOnlyHint`/`destructiveHint` annotations as of this session (`apps/platform/src/mcp/tools.ts`) — the "Tools" wizard step auto-syncs from `tools/list` and blocks submission on missing annotations, so this was a hard prerequisite, now closed.
- Auth: `static_headers` (beta) — confirmed by anthropic-mechanics as the correct mode: a fixed API key/Bearer token entered once by an org admin, sent as a request header on every call. `Authorization: Bearer <token>` OR `X-API-Key: <token>` (Authorization wins if both present; `apps/platform/src/auth.ts:32-53`). Never query-string — confirmed no tool/route accepts the token as a URL param.
- Privacy policy (LIVE, verified `curl -I https://coldrig.dev/privacy` → 200): https://coldrig.dev/privacy
- Terms: https://coldrig.dev/terms · DPA: https://coldrig.dev/dpa · Security: https://coldrig.dev/security · AUP: https://coldrig.dev/aup (all 200, curl-verified this session)
- Tool-description prompt-injection sweep (this session): grepped `tools.ts` for injection-pattern language (instructing Claude to call unrelated external tools, hidden/encoded instructions, "ignore"/"override"/"system prompt" language) — zero matches. Cross-references between coldrig's OWN tools ("poll infrastructure_status for progress", "use metrics for account-wide totals") are workflow guidance among the server's own 17 tools, not the prohibited pattern (external/unrelated tools the user didn't request) — this is the standard, accepted MCP description idiom.
- Read/write split: confirmed no tool mixes GET and POST/PUT/DELETE. `get_dashboard` (read) and `configure_dashboard` (write: create/update/promote/delete via one `action` enum) are already two separate tools, matching SPEC.md §19.5's deliberate split. `configure_dashboard` bundling 4 write sub-actions into one tool is NOT the prohibited pattern (that rule is specifically about mixing read+write, not multiple write actions) but flag it to the founder as the closest borderline case worth a human sanity check.
- Tool name length: longest is `infrastructure_status` at 21 chars, well under the 64-char cap.
- No tool calls `ui/open-link` or opens URLs in the user's browser — the "Allowed link URIs" wizard section can be skipped.
- No tool reads Claude's memory, chat history, or user files — every tool operates strictly on the caller's own tenant data via the bearer token.

---

## Wizard field-by-field (per https://claude.com/docs/connectors/building/submission)

### Introduction
No input — informational screen confirming this is a REMOTE MCP server submission (correct path for coldrig; local/desktop-extension and plugin forms are separate and don't apply here).

### Connection
- **Server URL:** `https://agent-cold-email-api.yaakovscher.workers.dev/mcp` (HTTPS, confirmed)
- **Transport:** Streamable HTTP
- **Same URL for every user:** Yes — one fixed URL; per-user isolation happens via each user's own bearer token, not a per-user URL.

### Tools
Auto-synced from live `tools/list` — 17 tools, each with `title` + `readOnlyHint`/`destructiveHint` annotations (blocking prerequisite, now satisfied). No action needed here beyond re-confirming the sync picks up all 17 after this session's changes deploy.

### Listing (public-facing card — has hard character limits)
- **Server name (≤100 chars):** `Coldrig` (7 chars)
- **Tagline (≤55 chars):** `Agent-run cold email: 17 tools, one bearer token.` (49 chars) — alt if a different tone is wanted: `Cold outbound infra, run by your own coding agent.` (50 chars)
- **Description (≤2,000 chars):** see "Long description" below (1,575 chars as drafted, room to spare)
- **Categories (1-5):** UNVERIFIED against the live dropdown — no category enum was available to either of us. Best guesses to try: Sales & Marketing, Productivity, Developer Tools. Confirm against the actual dropdown at submission time.
- **Documentation URL:** https://coldrig.dev/docs (human-facing); mention `AGENTS.md` (https://github.com/YS-projectcalc/agent-cold-email/blob/main/AGENTS.md) in the description as the agent-facing operational contract if the form allows a second link.
- **Privacy policy URL:** https://coldrig.dev/privacy
- **Support contact:** security@coldrig.dev (vuln reports) or a support@ alias if one exists — confirm which the form wants (general support vs. security-specific); `SECURITY.md` only documents the security address.
- **Icon:** two square candidates already exist — `site/apple-touch-icon.png` (180×180 PNG) and `site/assets/logo-mark.svg` (64×64 square "Coldrig mark," three ascending rig columns on blue). Confirm Anthropic's exact size/format spec against the live form, but there's no need to design a new asset from scratch.
- **URL slug:** recommend `coldrig` for consistency with the plugin name and every client config already shipped (`site/connect.html`) — **this is permanent once published**, so confirm this choice deliberately, not by default.

### Use cases
- **Primary use cases:** (1) an agent asked to run a cold outbound campaign end-to-end without hand-rolling registrar + mailbox-vendor + SMTP/IMAP integrations; (2) agencies/founders who want their coding agent to own the full outbound motion while a human retains dashboard visibility; (3) risk-free evaluation via the sandbox demo.
- **What users need before connecting:** nothing paid — free signup (`POST /signup`, no card) mints a bearer token immediately.
- **Reads data, writes data, or both:** Both (9 tools are pure reads, 8 mutate — see the `readOnlyHint`/`destructiveHint` annotations for the exact split).

### Company
- **Company name:** EpiphanyMade
- **Website:** https://coldrig.dev/ (or an EpiphanyMade corporate site if the form wants the legal entity's own site specifically — confirm which)
- **Primary review contact:** founder's name/email, pre-filled from the Anthropic account used to submit — no repo-derivable answer here.

### Authentication
- **Mode:** `static_headers` (beta) — confirmed correct by anthropic-mechanics' research.
- **Nuance to state explicitly:** `initialize` and `tools/list` require NO auth (public protocol discovery — `apps/platform/src/mcp/README.md`'s "Auth model" section); only `tools/call` requires the bearer/API-key header. If the form's "starts unauthenticated, tools prompt on demand" flag applies to this shape, check it.

### Data handling
- **Underlying API ownership:** First-party — coldrig's own Cloudflare Workers-hosted API. The agent never talks directly to the domain registrar, mailbox/warmup vendor, or Stripe; those are subprocessors behind coldrig's own API surface (`privacy.html` §6), so this satisfies compliance item #2 (must call your own first-party API) cleanly with no proxy disclosure needed.
- **Personal health data:** No.
- **Sponsored content:** No.

### Test & launch
See the "Reviewer test-credentials" section below — this is the section the anthropic-mechanics finding changes the most.

### Compliance
See "The 7 compliance acknowledgments" below.

### Review
Read-through step — no repo-derivable content, just make sure nothing above trips the form's own auto-flagged quality warnings (e.g. don't leave any answer too short/generic).

---

## Reviewer test-credentials — REVISED per anthropic-mechanics' finding

**Correction from the prior draft:** the pre-submission checklist requires test-account credentials for **"a fully populated account"** — a bare, just-signed-up demo tenant with zero data does NOT satisfy this. Most read tools (`inbox`, `thread`, `campaign_results`, `metrics`, `list_campaigns`, `activity`, `infrastructure_status`) would return empty/404 against an empty tenant, which is exactly what an automated policy scan (and any human reviewer) would flag as broken or untestable.

**Two ways to satisfy this, in order of reliability:**

1. **Recommended — founder pre-populates ONE fixture tenant and hands over its exact token.** Run `npx agent-cold-email demo` (or the manual sequence: `POST /signup` → `setup_infrastructure` → `launch_campaign` → let the sandbox tick/poll-inbox run) ONE time, capture the resulting bearer token, and paste it directly into the "Test & launch" form field along with: "Bearer token: `<token>`. Auth header: `Authorization: Bearer <token>`. This tenant has 1+ domains, 2+ mailboxes (post-warmup), 1+ active/completed campaign, and sample reply/bounce threads, so every read tool (`inbox`, `thread`, `campaign_results`, `metrics`, `list_campaigns`, `activity`, `infrastructure_status`, `account`, `get_dashboard`) returns real, non-empty data." This is the literal "every link, credential, and step" the checklist asks for, and is the safer bet if the automated scan calls tools directly (not via a spawned CLI).
   - **Do not commit this token to the repo** (CLAUDE.md rule g) — hand it to Anthropic only through the submission form / private review channel, never in a public draft or git history.
   - Token longevity: confirm the demo/test tenant's token doesn't expire or get garbage-collected before review completes (check for any TTL on demo-plan tenants — `ROADMAP.md`/`SPEC.md` didn't surface one in this session's reading, but worth a direct check before submitting).
2. **Fallback — self-serve instructions.** If the founder prefers not to pre-mint a fixture, document that `npx agent-cold-email demo` self-mints AND self-populates a tenant (provision → warm → send → reply → bounce) in one command with no signup step, so a reviewer with Node available could run it themselves. This is weaker for the "fully populated account" literal requirement (a fresh demo run's data is minimal by design — accelerated but still sparse compared to a hand-built fixture) and assumes the reviewer/scanner can execute a local command, which an automated API-only scan likely cannot. Use option 1 as primary; keep this as a documented alternative only.

---

## Long description (2,000-char field — 1,575 chars as drafted)

Coldrig is a multi-tenant cold-email infrastructure platform built to be operated by the customer's own coding agent, not clicked through as a SaaS dashboard. A customer signs up (free, no card), hands their agent one bearer token, and the agent drives the full lifecycle through 17 focused MCP tools: buy branded lookalike domains, provision and warm mailboxes, launch multi-step sequences, triage a unified reply inbox, and pull deliverability metrics. The platform does not generate outreach copy or run an opaque "AI SDR" — content and strategy stay the customer agent's job; Coldrig owns infrastructure, isolation, sequencing, and server-enforced guardrails (per-mailbox send caps, suppression, CAN-SPAM one-click unsubscribe, complaint-rate auto-pause). Every tenant gets isolated domains and mailboxes, never shared with other customers.

**Status honesty (required — do not soften this in review copy):** the platform is in public early access. The hosted API and MCP endpoint are live and fully functional today, but run against a fault-injecting **sandbox** vendor layer — no real domains, mailboxes, or sends yet, and the platform makes no inbox-placement or deliverability guarantees. A free, no-signup sandbox demo (`npx agent-cold-email demo` or `POST /signup`) lets a reviewer or user exercise the entire pipeline safely before any real spend is possible — real vendor adapters are structurally unreachable from a demo/sandbox tenant (a type-level guard plus a test that fails if bypassed, not just a policy — `README.md`'s "First use: the free demo" section).

---

## The 7 compliance acknowledgments (substance grounded by anthropic-mechanics; literal checkbox wording still UNVERIFIED against the live form)

1. **Directory guidelines** — general compliance with the review-criteria page (tool design, no prompt injection, functional quality). Swept this session: clean (see source facts above).
2. **First-party API usage** — quoted: *"Your server must call your own first-party APIs, or APIs you legitimately proxy. The MCP server domain should match your service."* Coldrig's own Workers-hosted API (`agent-cold-email-api.yaakovscher.workers.dev`) satisfies this directly — no proxy disclosure needed.
3. **Financial transactions** — prohibited category is software that *"transfers money, cryptocurrency, or other financial assets, or executes financial transactions on behalf of users."* Not applicable — coldrig's Stripe integration is the CUSTOMER paying COLDRIG for the service (standard SaaS billing), not the MCP tools moving money on a user's behalf; none of the 17 tools touch payments. Safe to attest no.
4. **AI media generation** — restricted category is *"software that uses AI models to generate images, video, or audio content."* Not applicable — coldrig never generates outreach copy or media; that's explicitly the customer agent's job (`README.md`: "Your agent writes the content").
5. **Prompt injection** — swept this session, zero hits on injection-pattern language; all cross-tool references are the standard "use tool X for Y" idiom among coldrig's own 17 tools.
6. **Conversation data collection** — quoted: *"Software must only collect data from the user's context that is necessary to perform their function... must not collect extraneous conversation data, even for logging purposes,"* and must not query Claude's memory/chat history/user files. Confirmed: every tool's inputs are structured domain arguments (campaign/lead/thread data) resolved against the tenant's own token-scoped state — nothing reads Claude's session.
7. **Public documentation** — quoted: *"Developers must document how their Software works, its intended purpose, and how users can troubleshoot issues"* by publish date ("a blog post or help-center article is sufficient," privately shareable with Anthropic if not public yet). Coldrig already has `README.md`, `AGENTS.md`, `site/docs.html`, `site/for-agents.html`, and `site/faq.html` live — this is comfortably satisfied.

**Functional-quality bars (same source, not checkboxes but will gate the automated scan):**
- Read/write split — confirmed clean (see source facts).
- Tool names ≤64 chars — confirmed clean (longest is 21).
- No generic errors — spot-checked this session's test runs: errors surfaced are specific (`"plan 'demo' allows at most 5 domains (have 0, this request adds 10)..."`, `"cannot delete the default view (agent-view) — promote another view to default first"`, `"campaign camp_does_not_exist not found"`), never a bare "Internal Server Error." Looks compliant but wasn't exhaustively swept across every error path in this session — worth a dedicated pass before submitting if time allows.
- Freeform-endpoint-description rule — not applicable, no tool takes a freeform URL/endpoint argument.
- Allowed link URIs — not applicable, no tool opens links via `ui/open-link`.

If Anthropic's actual checkbox list differs from this mapping, re-derive from the live form at submission time rather than trusting this draft's numbering — the substance above is grounded in named source docs, but the literal UI copy was not directly observed by either agent working this bundle.
