# Adversarial gate — Claude Code Agent Skill / plugin marketplace lane

- **Date:** 2026-08-23
- **Worktree:** `/Users/yaakovscher/dev/coldstart-wt-skill`
- **Branch:** `feat/agent-skill-2026-08-23`
- **Ground ref (verified at review start, `git rev-parse HEAD`):** `fa1e04ba75864121423d1609ee670dcde59e4c9b` (`fa1e04b`), on `6af3941`, base `main` = `d2e7755`
- **Diff under review:** `git diff main...HEAD` — 11 files, +264/-3
- **Reviewer:** adversary (fresh context, read-only git, no fixes written)

## VERDICT: SHIP-AFTER-FIX — 5 BLOCKING, 5 NON-BLOCKING

Every blocking finding survived a self-refutation pass. Four of the five were
proven by execution (a real plugin install under a throwaway `HOME`, a planted-defect
guard grade, a live API probe, a live-surface browser drive), not by reading.

---

## BLOCKING

### B1 — Installing the plugin writes 413 MB to the user's plugin cache

**Lens:** 4 (deploy/arm-time plumbing) + 2 (run it).

`.claude-plugin/marketplace.json:11` sets `"source": "./"`, so the plugin root **is the
monorepo root**. Per `plugins-reference.md` ("Node.js package dependencies"), Claude Code
runs `npm ci --ignore-scripts` in the cached copy whenever the plugin root holds both a
`package.json` and a lockfile — both are at the repo root.

Measured, not inferred. Real install under a throwaway `HOME`:

```
$ HOME=/tmp/fakehome.1YhSGb claude plugin install coldrig@coldrig
✔ Successfully installed plugin: coldrig@coldrig (scope: user)     [45s]
$ du -sh $HOME/.claude/plugins/cache/coldrig
413M
$ find $HOME/.claude/plugins/cache -name node_modules -type d
.../cache/coldrig/coldrig/0.3.0/node_modules
```

Cold-npm-cache timing of the same `npm ci`: **39 s, 133 MB downloaded, 397 MB written** —
against Claude Code's documented **60-second cap**, past which the install is abandoned
with a partial `node_modules`. The docs also give each version its own cache directory, so
0.3.0 → 0.4.0 doubles it.

The payload that is actually a plugin is `skills/coldrig/SKILL.md` (8.6 KB) + `.mcp.json`
(10 lines). Nothing in the plugin uses a single one of those 352 packages (0 hooks,
0 stdio servers — confirmed by `claude plugin details coldrig`).

**Fix:** give the plugin its own small root instead of the repo root. Create
`plugins/coldrig/` containing `.claude-plugin/plugin.json`, `.mcp.json`, and
`skills/coldrig` as a symlink to the repo-root skill (documented and supported —
`plugin-marketplaces.md`: a symlink resolving elsewhere within the same marketplace is
dereferenced and its content copied). Then set `.claude-plugin/marketplace.json:11` to
`"source": "./plugins/coldrig"`. Root `skills/coldrig/` stays where it is so
`npx skills add` keeps working.

### B2 — The plugin's bundled MCP config uses a different host and a different env var than every published instruction; the result is a false green

**Lens:** 1 (claim truth) + 3 (live surface) + 4.

`site/connect.html:21` (new sentence) tells users:

> Or install the packaged plugin, which **bundles the same MCP config** plus an agent skill Claude loads automatically

It is not the same config. Three ways:

| | connect.html / SKILL.md `claude mcp add` | plugin's bundled `.mcp.json:1-11` |
|---|---|---|
| server name | `coldrig` | `agent-cold-email` (registers as `plugin:coldrig:agent-cold-email`) |
| URL | `https://api.coldrig.dev/mcp` | `https://agent-cold-email-api.yaakovscher.workers.dev/mcp` |
| credential | `$COLDRIG_TOKEN` | `${AGENT_COLD_EMAIL_API_KEY}` |

The sentence renders directly under step 1 "Export `COLDRIG_TOKEN`" and step 3 "Verify with
`claude mcp get coldrig`" (browser drive at 1440 px and 390 px; panel visible, 0 px overflow,
screenshot `connect-desktop.png`). A user who does exactly that and then installs the plugin
gets:

```
$ COLDRIG_TOKEN=cr_live_… claude mcp get coldrig
No MCP server named "coldrig". Configured servers: plugin:coldrig:agent-cold-email

$ claude mcp list
plugin:coldrig:agent-cold-email: https://agent-cold-email-api.yaakovscher.workers.dev/mcp (HTTP) - ✔ Connected
```

`✔ Connected` is a **false green**: the endpoint permits unauthenticated `initialize`, so the
health check passes while every `tools/call` fails. Proven against production:

```
$ curl -X POST https://api.coldrig.dev/mcp -H 'Authorization: Bearer ${AGENT_COLD_EMAIL_API_KEY}' \
    -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"account","arguments":{}}}'
{"jsonrpc":"2.0","id":3,"error":{"code":-32001,"message":"invalid or inactive token"}}   [401]
```

`mcp.md:596` confirms an unset variable is left as literal `${VAR}` text with no prompt.
No `userConfig` block is declared, which is the documented mechanism for prompting
("Use this instead of requiring users to hand-edit `settings.json`", `plugins-reference.md:547`).

**Fix (three parts):**
1. `.mcp.json` — point at `https://api.coldrig.dev/mcp`, rename the server key to `coldrig`.
2. Add a `userConfig` block to `.claude-plugin/plugin.json` with a `sensitive: true` token
   field and reference it as `${user_config.token}` in the header, so enabling the plugin
   prompts. (If the env-var form is kept, it must be `COLDRIG_TOKEN` to match every other surface.)
3. `site/connect.html:21` — replace "bundles the same MCP config" with what is true after (1),
   and say the plugin prompts for the token rather than implying the `COLDRIG_TOKEN` export covers it.

### B3 — "campaign sends are refused, never silently dropped" is false; proven against the live API

**Lens:** 1 (claim truth) + 2 (run it).

Three new surfaces assert it:

- `skills/coldrig/SKILL.md:111`
- `integrations/cursor/coldrig.mdc:19`
- `integrations/codex/AGENTS-snippet.md:21`

The phrase's real source is `apps/platform/src/mcp/tools.ts:133`, where it is scoped to the
**`reply` tool only**. The lane widened it to campaigns. It does not hold there.

`apps/platform/src/engine/campaigns.ts:129-151` counts suppressions per lead, writes the lead
row with `global_status='suppressed'`, then `continue`s — no `scheduled_sends` rows, no error.
`campaigns.ts:172` returns `{ campaignId, nextSteps }` with no skipped/suppressed count.

Live probe against production (demo-plan tenant, no card, no real sends):

```
POST /leads/suppress {"email":"b@example.com"}            → 200 {"suppressed":true}
POST /campaigns  leads=[a@example.com, b@example.com]     → 201
  {"campaignId":"camp_2c1f6918-…","nextSteps":{"status":"none_owed","steps":[]}}
GET  /leads → b@example.com globalStatus:"suppressed", suppressed:true
```

Half the list was dropped and the launch response said nothing. An agent that trusts this
sentence will report "campaign launched to 2 leads" when 1 was contacted.

(The `reply` half of the claim IS true — `engine/guarded-send.ts:54-100` throws
`SendBlockedError` on suppressed / `mailbox_paused` / cap. Only the campaign half is false.)

**Fix:** scope the sentence to `reply`, and state the campaign behaviour accurately, e.g.
"`reply` is refused, never silently dropped, when the recipient is suppressed, the mailbox is
deliverability-paused, or the daily cap is used up. A campaign launch **silently skips**
suppressed leads — the launch response does not report them; call `list_leads` to see which."

### B4 — Every new claim surface is outside every claim-surface guard (graded with planted defects)

**Lens:** 5 (guard coverage) + the repo's own bug-response law.

All five guards use hard-coded file lists, and **none** names any new file:

| guard | list | new surfaces present? |
|---|---|---|
| `apps/platform/test/site-tool-count-claims.test.ts:50-76` | 28 entries incl. `.claude-plugin/plugin.json` | no |
| `apps/platform/test/site-claim-surface-scope.test.ts:50-79` | 36 entries incl. `.claude-plugin/plugin.json` | no |
| `apps/platform/test/tool-claim-binding.test.ts` | — | no |
| `apps/platform/test/next-steps-doc-lockstep.test.ts` | — | no |
| `packages/cli/test/claim-surface.test.mjs` | `dist/` + `packages/cli/README.md` | no |

Graded, not asserted. In a sandbox copy of HEAD I planted three defects across
`skills/coldrig/SKILL.md`, `integrations/cursor/coldrig.mdc`,
`integrations/codex/AGENTS-snippet.md`, `.claude-plugin/marketplace.json`:
tool count `28 → 31`, price `$99/mo → $59/mo`, and the retired framing
"Join the waitlist for early access".

```
Test Files  4 passed (4)
     Tests  344 passed (344)
```

Control — the identical plant on the **already-listed twin in the same directory**,
`.claude-plugin/plugin.json`:

```
× .claude-plugin/plugin.json states the CURRENT tool count somewhere
AssertionError: .claude-plugin/plugin.json should mention 28 near "tool"/"intent" but doesn't
Tests  1 failed | 279 passed
```

The guard works; the file list is one entry short in each of two places. This is the exact
class `site-claim-surface-scope.test.ts:81-89` was created to close — its own comment names
"the Claude Code plugin marketplace" as the reason `plugin.json` was added. The lane then
added the marketplace manifest itself, unlisted. Repo history: stale tool counts (19→21,
21→24) burned buyer-agent evaluations twice.

Nothing ships wrong today — all four claims are currently true. This is blocking because
CLAUDE.md's bug-response contract requires the systemic guard, and the fix is one commit.

**Fix — add to both platform guards' import block and `CLAIM_SURFACES` array:**

```ts
import coldrigSkill      from "../../../skills/coldrig/SKILL.md?raw";
import cursorRule        from "../../../integrations/cursor/coldrig.mdc?raw";
import codexSnippet      from "../../../integrations/codex/AGENTS-snippet.md?raw";
import marketplaceJson   from "../../../.claude-plugin/marketplace.json?raw";
// …
["skills/coldrig/SKILL.md", coldrigSkill],
["integrations/cursor/coldrig.mdc", cursorRule],
["integrations/codex/AGENTS-snippet.md", codexSnippet],
[".claude-plugin/marketplace.json", marketplaceJson],
```

Revert-fail proof is already in hand: the plants above go RED once these four lines land.

### B5 — "First run" walks an agent from checkout to real sends with no human-confirmation step and omits the platform's own spend-consent primitives

**Lens:** 6 (attack the design) + 1.

`grep -in "quoteonly|registerDomains|confirm|consent|ask the user|approve|permission"
skills/coldrig/SKILL.md` → **zero hits.**

What survives well: step 1 is `demo` first ("Do this first, before recommending anything"),
and step 3 correctly routes checkout to a human ("open it and pay"). The gaps are steps 4 and 6.

- **`SKILL.md:97` step 4** — "`agent-cold-email setup` — provisions domains/mailboxes and starts
  warmup." Billing tracks the provisioned mailbox count, and `tools.ts:74` documents the
  consent primitive the skill never mentions: *"pass `quoteOnly:true` first to preview the new
  count + projected monthly price before committing (no silent capacity addition)."* An agent
  on an activated tenant that calls `setup` with `domains:5, inboxesEach:5` moves the bill from
  $99 to $299/mo with no quote and no ask. `registerDomains` (the registrar opt-in that fails
  closed with `400 registrar_optin_missing`) is likewise never named.
- **`SKILL.md:99` step 6** — "launches a sequence against a lead list **the agent supplies,
  offer and copy included**." That is an instruction for the agent to author cold-email copy
  and send it. Real mail leaves on an activated tenant; the only server-side gate is the
  60-second duplicate-launch window.

The platform does fail closed on demo/free tenants and on a never-consented registrar, so this
is not an unguarded money hole — it is the skill instructing the agent past the guards the
platform documents.

**Fix:** in "First run", (a) step 4: instruct `quoteOnly: true` first, show the user
`projectedMonthlyCents`, and require their go-ahead before the committing call; name
`registerDomains` as the user's explicit opt-in to real domain purchases; (b) step 6: require
the user's own approval of the lead list and of the offer/sequence copy before
`launch_campaign`, and state that a launch sends real mail to real people.

---

## NON-BLOCKING

- **NB1 — trigger description.** `SKILL.md:2` is 731 chars (cap 1,536; measured always-on cost
  ~184 tok, fine) but leads with a product blurb rather than the use case, which
  `skills.md:323` advises against, and ends with an *instruction*
  ("Always verify claims…") that belongs in the body, not the matcher text. It carries no
  negative scoping. **Should trigger** (all covered): "set up cold email for our agency" /
  "provision sending domains and mailboxes for outbound" / "warm up these new mailboxes" /
  "launch a cold email sequence to this lead list" / "what's an Instantly alternative I can
  drive over MCP". **Should not trigger:** "send my mom an email" (safe — no overlap),
  "wire up transactional email for password resets" (safe), "set up our monthly newsletter"
  (safe), "help me triage my Gmail inbox" (**weak risk** — "manage replies"),
  "debug why our SMTP relay is timing out" (**weak risk** — "mailboxes"). Minimal rewrite:
  lead with "Use when the user asks to set up cold email…", move the verify instruction to the
  body, and append "Not for transactional email, newsletters, personal email, or triaging an
  existing inbox."
- **NB2 — README-at-every-level.** `skills/`, `integrations/cursor/`, `integrations/codex/`
  have no `README.md`. `skills/coldrig/README.md` and `integrations/README.md` exist. Precedent
  is mixed (`apps/`, `packages/`, `docs/`, `tools/` have none either; leaves like
  `apps/platform/` do), and `integrations/README.md` documents both leaf files, so the two
  `integrations/*` leaves are arguably covered. Cheapest closure: one line in
  `skills/README.md`.
- **NB3 — update discipline.** The lane touches no `ROADMAP.md`, `HANDOFF.md`, or `MEMORY.md`
  (`git diff --name-only main...HEAD`), which CLAUDE.md "Update discipline" requires of every
  session. The 2026-08-23 founder ORDER "skill publish" item needs its checkbox + evidence
  pointer, and this file is the artifact to cite.
- **NB4 — renamed public anchor.** `llms-install.md` renames "Option C — CLI, no-signup sandbox
  demo" to Option D. GitHub's live slug for it today is
  `#option-c--cli-no-signup-sandbox-demo` (confirmed by fetching the rendered page:
  `id="user-content-option-c--cli-no-signup-sandbox-demo"`). No in-repo referrer
  (grepped), but any external link breaks. Free fix: number the new section Option D and leave
  the CLI section as Option C.
- **NB5 — duplication drift risk.** The 28-tool list, the pricing sentence, the ramp-cap
  sentence and the guardrail block now exist verbatim in 4–6 places. B4's guard closes the
  count and the price; the ramp-cap and guardrail prose stay hand-synced.

---

## Attacks that FAILED (why the PASS on these is meaningful)

| lens | attack | why it held |
|---|---|---|
| 1 | Tool count/names vs reality | `tools/list` on the live endpoint returns 28; `SKILL.md:103-110`'s 28 verbatim names are an exact set match with the live card and the live endpoint — 0 extra, 0 missing, 0 duplicates. |
| 1 | Pricing | `curl https://coldrig.dev/pricing` — "$99/month for 5 … $10/month each additional … $49 platform fee plus $10 per mailbox … five-mailbox minimum … $0 per-send fees". Every new surface matches word for word. |
| 1 | Ramp caps narrated but not enforced (`narrated-security-control-absent` class) | `engine/warmup.ts:21-27`: `day<=7 → 5`, `day>28 → 40`. "5/day in week 1, rising to 40/day after 4 weeks" is enforced, not just documented. |
| 1 | Brand-guard claim | `engine/brand-guard.ts:88-89` — gate (a) well-known-brand denylist, gate (b) brand↔primaryDomain. Matches `SKILL.md:114`. |
| 1 | Demo-isolation claim | `vendors/factory.ts:132` + `tenant-do.ts:745` route demo/free to sandbox ports; `test/demo-adapter-guard.test.ts` asserts `kind === "sandbox"` four ways. The exact wording is copied from `README.md:108` / `AGENTS.md:38` — pre-existing published copy, not a new claim (see NEW below). |
| 1 | "no un-suppress tool" | Absent from the live 28-tool list and from `AGENTS.md:68`. True. |
| 1 | CLI commands | `node packages/cli/dist/index.js --help` — `demo`, `signup`, `setup`, `status`, `campaign launch --file <f>`, `inbox`/`thread`/`reply` all real; `signup --brand/--email` matches `commands/signup.ts:6-13`; no lead-disposition subcommand, exactly as `SKILL.md:100` says. |
| 1 | `POST /checkout {mailboxes}` | `CheckoutInput` (`packages/shared/src/intents.ts:238-241`) — `interval` has a default, so `{ mailboxes }` alone validates. |
| 1 | Demo pipeline claim | `packages/cli/src/commands/demo.ts:1-60` — mints a tenant, provisions, runs `/demo/run`, prints a summary. Provision→warm→send→reply→report, no card. |
| 1 | Every asserted URL | 11/11 return 200 (`coldrig.dev/for-agents`, `/agent-evaluation.md`, `/openapi.yaml`, `/.well-known/mcp/server-card.json`, the GitHub repo and `AGENTS.md` blob, …). `POST /signup` is live (400 validation on an empty body, not 404). |
| 1 | Honest-limits list | Every "does not claim" bullet traces to existing published copy (`site/for-agents.html:143`, `site/agent-evaluation.md:92`, `site/status.html`). No invented modesty, no invented capability. |
| 1 | Connect snippets | All four (Claude Code / Cursor / Codex / Cline) and the stdio fallback are faithful copies of `site/connect.html` and `llms-install.md`. |
| 2 | `claude mcp add` flag form | `claude mcp add --help` (v2.1.241): `--transport`, `--header`, `--scope` all real, `--header "Authorization: Bearer …"` is the documented example form. |
| 2 | Live MCP endpoint | `initialize` POST to `https://api.coldrig.dev/mcp` → 200, protocol `2025-06-18`. |
| 2 | `npx skills add` syntax | `npx -y skills --help` — `add <package>` with `owner/repo` is valid; run against the tree it reports "Found 1 skill: coldrig" with the correct description. |
| 2 | Marketplace/plugin manifests | `claude plugin validate` → "Validation passed"; `marketplace add` → "Successfully added marketplace: coldrig"; `install coldrig@coldrig` → success; `plugin list` → v0.3.0 enabled. `"source": "./"` at the marketplace root is explicitly documented (`plugin-marketplaces.md:628`), the default `skills/` scan applies (`plugins-reference.md:640`), `coldrig@coldrig` is the right `plugin@marketplace` id, `coldrig` is not a reserved name, and `plugin.json` 0.3.0 agrees with the marketplace entry's 0.3.0. `claude plugin details` confirms Skills(1) + MCP servers(1) load. |
| 3 | `site/connect.html` regression | `html.parser` clean — 0 unclosed, 0 mismatches, 4 tabs ↔ 4 panels aligned. Browser drive at 1440/390: new sentence inside the `claude` panel, 0 px horizontal overflow both viewports. |
| 6 | `site/llms.txt` relative-link 404 (specifically probed) | The new bullet uses an absolute GitHub URL, not a repo-relative path, so it does not resolve against `coldrig.dev`. The fragment is also correct: GitHub's live slug algorithm on this very file yields `option-c--cli-no-signup-sandbox-demo` for "Option C — CLI, no-signup sandbox demo", so "Option C — Claude Code plugin / skill" → `option-c--claude-code-plugin--skill`, exactly what the bullet uses. |
| 7 | Anti-slop rules | No dead code, no new deps, no god files, no secrets. The lane is docs + manifests only. |

## UNVERIFIABLE

1. **GitHub-source install.** `/plugin marketplace add YS-projectcalc/agent-cold-email` and
   `npx skills add YS-projectcalc/agent-cold-email` can only be exercised after merge —
   the default branch has no `skills/`, `integrations/`, or `marketplace.json` today
   (GitHub contents API, checked at review time). Proven by proxy: the identical manifests
   installed end-to-end from a `git archive HEAD` tree. *Resolves:* re-run both commands
   against the repo once merged.
2. **Whether the skill actually fires on the NB1 prompts.** No model access under a throwaway
   `HOME`, and no eval cases in the repo for `claude plugin eval`. NB1 is an analytic judgement
   of the description text, not a measurement. *Resolves:* add 3–4 cases under
   `skills/coldrig/evals/` (positive + a "send my mom an email" negative) and run
   `claude plugin eval coldrig`.
3. **Whether the 60-second dependency-install cap is actually exceeded in the field.** Measured
   39 s here on a fast connection with a cold npm cache. Under the cap on this machine, over it
   on a slower one. B1 does not depend on this — the 413 MB and the wasted install stand either way.

## NEW (out of scope, no verdict weight)

- **"type-level guard" is a runtime plan check.** `README.md:108`, `AGENTS.md:38`,
  `site/faq.html:50,108,140`, `site/docs.html:105` all say a demo tenant is "structurally
  incapable of reaching a real vendor adapter … enforced at the type level".
  `vendors/factory.ts:132` is `const isDemoOrFree = plan === "demo" || plan === "free"` — a
  runtime branch returning a `kind: "sandbox" | "real"` discriminated union, backed by
  `test/demo-adapter-guard.test.ts`. The behaviour is real and tested; "type level" is a loose
  characterisation of a runtime guard with a typed return. Pre-existing published copy on
  ~6 surfaces, not introduced by this lane. Worth a separate wording pass, not a gate item.
- **Review side effects on production.** The B3 probe created one demo-plan tenant
  (`Adversary Gate Probe`, contact `adversary-probe+20260823@example.com`) and campaign
  `camp_2c1f6918-2270-4183-8ebb-a86ebc522a3b`, plus one suppression row for
  `b@example.com`. Sandbox plan — no spend, no real sends, no vendor contact. Purge if
  demo-tenant hygiene matters.

---

# Round 2 — combined diff (integration branch)

- **Date:** 2026-08-23
- **Worktree:** `/Users/yaakovscher/dev/coldstart-wt-integ`
- **Branch:** `integ/visibility-2026-08-23`
- **Ground ref (verified, `git rev-parse HEAD`):** `d37e018d862c38bc730a85f6f73b91f38ea02e20`
- **Scope:** `git diff main...HEAD` — the whole wave: skill lane (`6af3941`, `fa1e04b`, fix round `1052ab4`), site AEO lane (`25dd796`, `60a727b`), main's roadmap/outreach docs commits. 26 files, +767/-17.
- **Reviewer:** adversary (fresh re-attack, read-only git, no fixes written)

## VERDICT: SHIP-AFTER-FIX — 1 BLOCKING, 6 NON-BLOCKING

Round-1 checklist: **B1–B5 all CLOSED, each re-verified by execution.** The single blocking
item is a **new regression from the site lane's `style.css` change**, isolated to two CSS
declarations and proven with a before/after/fixed measurement.

---

## Round-1 checklist — re-verified by execution

| # | round-1 finding | status | evidence |
|---|---|---|---|
| B1 | plugin install writes 413 MB | **CLOSED** | Real install under a throwaway `HOME` from a `git archive HEAD` tree: `du -sh` cache = **28K** (was 413M), install **1 s** (was 45 s), `find … -name node_modules` = **nothing**. Cache holds exactly `.claude-plugin/plugin.json`, `.mcp.json`, `README.md`, `skills/coldrig/`. The `plugins/coldrig/skills/coldrig` symlink is **dereferenced into a real directory** in the cache (`SKILL.md`, 9797 bytes), as `plugin-marketplaces.md` promises. `claude plugin details` → Skills(1) coldrig, MCP servers(1) coldrig, ~180 tok always-on. |
| B2 | `.mcp.json` host/name/credential mismatch + false green | **CLOSED** | Cached `.mcp.json` = `coldrig` / `https://api.coldrig.dev/mcp` / `Bearer ${user_config.token}`. With the required token **unset**, `claude mcp list` reports **"No MCP servers configured"** — the server does not register at all, so the round-1 false `✔ Connected` is gone. Install prints the remediation: *"1 userConfig option not yet set (1 required) — run /plugin configure coldrig@coldrig, or pass --config KEY=VALUE."* **Substitution proven end to end:** a sandbox copy pointed at a local capture server logged the real header — `Bearer cr_live_acf1d2424f1f…` — i.e. `${user_config.token}` resolves in a plugin `.mcp.json` `headers` field. `site/connect.html`'s replacement sentence ("connects to the same `coldrig` MCP server and prompts you for the bearer token when you enable it") is true on both halves. |
| B3 | "campaign sends are refused, never silently dropped" | **CLOSED** | `grep -c "silently skips"` = 1 on each of `skills/coldrig/SKILL.md`, `integrations/cursor/coldrig.mdc`, `integrations/codex/AGENTS-snippet.md`; `grep -rn "campaign sends are refused" skills/ integrations/ .claude-plugin/ plugins/` = **zero hits**. The replacement text now splits the two paths correctly and points the reader at `list_leads`. |
| B4 | new claim surfaces outside every guard | **CLOSED** | Both platform guards now import and list `.claude-plugin/marketplace.json`, `skills/coldrig/SKILL.md`, `integrations/cursor/coldrig.mdc`, `integrations/codex/AGENTS-snippet.md`, and the **moved** `plugins/coldrig/.claude-plugin/plugin.json`, in `CLAIM_SURFACES`, `BUYER_FACING_SURFACES` and `SURFACES_THAT_STATE_THE_COUNT`. **Graded with plants:** a realistic drift (one of SKILL.md's four count mentions reverting to the retired `24`, same in the `.mdc`) → `× skills/coldrig/SKILL.md never claims a retired tool count` + `× integrations/cursor/coldrig.mdc …`, 2 failed / 113 passed. Sole-mention plants on the other three → `× …marketplace.json`, `× …plugin.json`, `× …AGENTS-snippet.md`. **Revert → 377/377 GREEN**, matching the builder's number on the real tree. |
| B5 | First run had no human gate before spend/send | **CLOSED** | `SKILL.md:97` is now "**Ask before you spend.**" with `quoteOnly: true`, `projectedMonthlyCents`, explicit user confirmation, and `registerDomains: true` as separate opt-in; `SKILL.md:99` is "**Ask before you send.**" requiring approval of the exact lead list and copy. Both primitives verified real: `quoteOnly` at `packages/shared/src/intents.ts:57`, `projectedMonthlyCents` at `apps/platform/src/engine/billing.ts:992`. |
| NB1 | trigger description | closed — now leads with "Use when the user asks to…" and carries explicit negative scoping ("Not for Gmail/Outlook inbox triage, transactional or newsletter email, SMTP/DNS debugging, or copy-only writing tasks"). |
| NB2 | missing READMEs | closed — `skills/README.md`, `plugins/README.md`, `plugins/coldrig/README.md`, `integrations/cursor/README.md`, `integrations/codex/README.md` all present. |
| NB4 | renamed Option C anchor | closed — headings are now A/B/C(CLI demo)/D(plugin); `site/llms.txt` points at `#option-d--claude-code-plugin--skill`, which matches GitHub's slug rule verified against this file's rendered anchors in round 1. |

**Builder's UNVERIFIED leg — ruled ACCEPTABLE TO SHIP.** Setting the `sensitive: true` userConfig
value fails under a throwaway `$HOME` (`⚠ Installed, but --config not applied: Failed to save
sensitive plugin options … to secure storage`) because the macOS Keychain is bound to the login
session, not to `$HOME` — an environment limit, not a plugin defect. Proven by re-running the
identical plugin with `sensitive: false` in a sandbox copy: `--config token=…` stored the value
(`pluginConfigs["coldrig@coldrig-nonsens"].options.token`), the server registered as
`plugin:coldrig:coldrig` at `https://api.coldrig.dev/mcp`, and the capture server received
`Bearer cr_live_acf1d242…`. The only leg that stays unexercised here is Keychain *persistence*,
which is the same code path every other `sensitive` plugin option uses, and its failure mode is
fail-closed (no server registers, and the CLI names the fix).

---

## BLOCKING

### B6 — the `style.css` table fix causes horizontal page overflow on 10 pages between 621 px and 1023 px

**Lens:** 7 (regression ring) + 3 (live surface). New in round 2, from the site lane.

`site/assets/style.css:75-76` makes two global changes:

```css
th, td { … overflow-wrap: break-word; }          /* was: overflow-wrap: anywhere */
th:first-child, td:first-child { white-space: nowrap; }   /* new, GLOBAL */
```

The narrow-viewport safety net (`table{display:block;overflow-x:auto}`) only exists inside
`@media (max-width: 620px)`. Between **621 px and 1023 px** a table is a normal table with a
`nowrap` first column and no min-content shrink — so it pushes past `main.wrap`.

Measured with Playwright on the real pages, `main` vs `HEAD`, same script, same widths
(`document.documentElement.scrollWidth - window.innerWidth`):

```
===== MAIN (before) =====
  621px  index.html:+4px          768px  none      1024px  none
  700px  index.html:+4px          820px  none

===== HEAD (after) =====
  621px  index.html:+4px  docs.html:+329px  guide-mcp-tool-count.html:+232px
         compare-vs-maildoso.html:+187px  compare-vs-agentmail.html:+384px
         compare-vs-diy.html:+50px  compare-vs-smartlead-instantly.html:+19px
         compare-vs-foxreach.html:+33px  compare-vs-smartlead.html:+98px
         compare-vs-skyp.html:+103px  compare-vs-salesforge.html:+53px
  700px  docs:+253  guide-mcp-tool-count:+156  maildoso:+111  agentmail:+308  smartlead:+22  skyp:+27
  768px  docs:+188  guide-mcp-tool-count:+91   maildoso:+46   agentmail:+243
  820px  docs:+138  guide-mcp-tool-count:+41   agentmail:+193
  1024px none
```

`index.html:+4px` is present on **both** main and HEAD — pre-existing, not part of this finding.
Everything else is new. 1440 px and 390 px are both clean, which is why the lane's own check
missed it: 1440 has room, and ≤620 already scrolls inside the table.

**Two independent causes, both required to fix** — isolated by patching a sandbox copy of the
site and re-measuring:

1. *Global `nowrap`.* Scoping it into the `@media (max-width:620px)` block fixed 8 of the 11 pages
   (`621px` residue: `docs.html:+329`, `compare-vs-maildoso.html:+56`).
2. *`overflow-wrap: break-word`.* `anywhere` participates in min-content sizing; `break-word` does
   not, so an unbreakable token can no longer let its column shrink. `docs.html`'s API table
   holds `?campaign&interestStatus&suppressed&replied&cursor&limit` (55 chars),
   `/byo-domains/{id}/managed-mailboxes,` and `?limit&cursor&kind=event|deliverability`.

**Both applied → exact parity with `main`** (only the pre-existing `index.html:+4px` remains):

```
===== V2-FIX (nowrap scoped to <=620px + overflow-wrap:anywhere restored) =====
  621px  index.html:+4px   768px  none   820px  none   1024px  none
  700px  index.html:+4px
```

**Fix (`site/assets/style.css`):**

1. Line 75 — restore `overflow-wrap: anywhere;` (revert that half of the change).
2. Line 76 — delete the global `th:first-child, td:first-child { white-space: nowrap; }` and move
   it into the existing `@media (max-width: 620px)` block, immediately before the `min-width:11rem`
   rule the fix round already added there:
   `table th:first-child,table td:first-child{white-space:nowrap}`

Re-run the same 5-width sweep across the compare/guide/docs pages as the acceptance check.

---

## NON-BLOCKING

- **NB6 — `agent-cold-email setup` cannot express the consent primitives step 4 tells the agent
  to use.** `SKILL.md:97` instructs `quoteOnly: true` and `registerDomains: true`, then says
  "`agent-cold-email setup` is the CLI form of `setup_infrastructure` / `POST
  /setup-infrastructure`". `packages/cli/src/commands/infra.ts:4-20` builds a fixed body of
  `{brand, primaryDomain, domains, inboxesEach, persona, physicalAddress, senderIdentity}` — no
  `quoteOnly`, no `registerDomains` flag anywhere in the CLI (`grep -n "quote\|projected"
  packages/cli/src/commands/*.ts` = zero). It also silently substitutes placeholders when flags
  are omitted: `brand="Sample Brand"`, `primaryDomain="sample-brand.com"`,
  `physicalAddress="123 Main St, Springfield, USA"` — the last of which is the CAN-SPAM footer
  address (`engine/tick.ts:111`). The MCP/HTTP path named in the same sentence works correctly, so
  the human gate exists; it just isn't reachable on the CLI surface the sentence equates to it.
  *Fix:* one clause in step 4 — "the CLI's `setup` cannot pass `quoteOnly` or `registerDomains`;
  use the `setup_infrastructure` tool or `POST /setup-infrastructure` for the quote and the
  opt-in, and always pass explicit `--brand/--primary-domain/--physical-address` if you do use the
  CLI." (Or add the flags to `infra.ts`.)
- **NB7 — `compare-vs-maildoso.html:74` says "No published refund policy" while `terms.html:75`
  publishes one.** Terms states "we do not prorate or refund the unused portion of a billing
  period already paid for, except where applicable law requires it." Against a competitor's
  "30-day money-back guarantee", "no published policy" reads as undecided rather than as an
  explicit no-refund term — the favourable-ambiguity direction. The lane rewrote this exact cell
  and left the clause. *Fix:* "No refunds on the unused portion of a paid period (see
  [Terms](/terms)) — month-to-month, cancel anytime; paid activation is live in production today."
- **NB8 — the homepage table's "Sending platform + API" column blends two different vendors.**
  Every cell traces to a cited source page (checked 6, read 4 in full context), but
  `compare-vs-smartlead-instantly.html` reports **Smartlead 116+** and **Instantly 31-38** in the
  same table, and the homepage takes Instantly's `31-38` for the tool-count row while taking
  Smartlead's category list (`Campaigns, leads, email accounts, warmup, smart delivery, smart
  senders, webhooks, sequences, analytics`) for the campaign row and Instantly's `6 categories`
  for the replies row. Nothing is invented, but showing the smaller of the two competitor counts
  next to Coldrig's 28 while omitting 116+ is a selection effect on a buyer-facing comparison.
  *Fix:* name the vendor inline — "31-38 (Instantly) to 116+ (Smartlead) reported tools".
- **NB9 — `README.md:70` still names the MCP server `agent-cold-email`** in the first Install JSON
  block, three lines above the new sentence "The plugin connects to the same `coldrig` MCP
  server". Everything else in the wave (root `.mcp.json`, the plugin, connect.html, the Codex
  block) now says `coldrig`. *Fix:* rename the key in that block.
- **NB10 — `.table-source-note` has no CSS rule** (`grep -c table-source-note
  site/assets/style.css` = 0), so the new sourcing line renders as a plain paragraph. Also the new
  `<section id="compare">` is not linked from anywhere (`href="#compare"` count = 0). Cosmetic.
- **NB11 — `claude mcp get coldrig` does not resolve for a plugin-only user.** Verified: with the
  token configured, `claude mcp get coldrig` → *"No MCP server named 'coldrig'. Configured
  servers: plugin:coldrig:coldrig"*. `connect.html`'s step 3 belongs to the manual `claude mcp
  add` list and the plugin sentence is a separate paragraph, so this is a fair reading as written
  — but `/mcp` is the verification that works for both paths.

---

## Attacks that FAILED

| lens | attack | why it held |
|---|---|---|
| 2 | Symlinked skill won't survive the plugin copy | It does — `plugins/coldrig/skills/coldrig` is preserved by `git archive` as mode 120000 and **dereferenced into a real directory** in the install cache. `claude plugin details` loads Skills(1). |
| 2 | Moving `plugin.json` breaks the guards' `?raw` imports | Both guards updated the path to `plugins/coldrig/.claude-plugin/plugin.json` and kept the surface listed; the moved file still fails RED under a plant. |
| 1 | Homepage table invents claims | 6 distinctive strings (`31-38`, `30 mailbox accounts`, `6 categories`, `Infraforge`, `footer address injection`, `Two separate API keys`) all trace to a cited source page; all three cited pages exist. |
| 1 | "footer address injection" is narrated, not built | Real: `engine/tick.ts:111` `appendComplianceFooter` injects `senderIdentity` + `physicalAddress` + unsubscribe URL; called at `tick.ts:429`. |
| 1 | "DNS verified automatically before a mailbox is provisioned" | Real and ordered: `engine/provisioning.ts:139` "buy → DNS → insert domain row → …", `:208` "RE-DRIVE DNS BEFORE PROVISIONING ANYTHING", `:224-225` blocks unless `dns_status === "ready"`. |
| 1 | The "30 mailboxes went to spam" anecdote is mis-attributed to sending platforms | It isn't — the homepage's "Sending platform + API" column is explicitly defined in row 1 as "most often paired with a separate domain/mailbox infrastructure vendor … two different purchases", which is the same two-layer stitch the source page's anecdote is about. |
| 1 | `support.html` rewrite is false | `status.html` records "Support email routing — public aliases route to a verified worker; support@ inbound delivery is live", so dropping "must be owner-verified before paid activation" is correct. |
| 1 | `sameAs` targets contradict our own tool count | Glama's live page now reads "The 28 tools" / "your agent calls 28 intents" — the stale "~12 tools" blurb the ROADMAP flags is gone. Smithery states no count. |
| 3 | Homepage JSON-LD broken by the `sameAs` edit | Single `application/ld+json` block parses; `sameAs` = 4 entries. |
| 3 | The homepage table's inline `style="overflow-x:auto"` is CSP-blocked | `site/_headers:9` sets `style-src 'self' 'unsafe-inline'` — inline styles are allowed. |
| 3 | `connect.html` structure | 4 tab-panels ↔ 4 `data-tab` values, unchanged. |
| 3 | The CSS change breaks 1440 px or 390 px | Clean at both: 0 px page overflow and 0 clipped first-column cells across 9 table pages. At 390 px tables scroll inside themselves, which is the intended pre-existing behaviour. |
| 1 | README's `agent-cold-email@0.2.1` is stale | npm registry `dist-tags.latest` = `0.2.1`. Matches. |

## UNVERIFIABLE

1. **`https://www.npmjs.com/package/agent-cold-email` returns 403** to plain curl, to curl with a
   full browser header set, and to real headless Chromium (page title "Just a moment…" =
   Cloudflare interstitial). Existence is confirmed authoritatively via
   `https://registry.npmjs.org/agent-cold-email` → 200, `latest: 0.2.1`, and the URL is npm's
   canonical package-page form, so the `sameAs` entry is valid. *Resolves:* open it in a normal
   browser session. The other three `sameAs` URLs return 200 with a browser UA.
2. **The GitHub-source install** (`/plugin marketplace add YS-projectcalc/agent-cold-email`) still
   can't be exercised until merge; proven by proxy from a `git archive HEAD` tree.
3. **Keychain persistence of the `sensitive` userConfig value** — see the ruling above.
4. **Whether the skill fires on the intended prompts** — still no eval cases in the repo.

## NEW (out of scope, report only)

- **The tool-count guard's per-file predicate is "at least one correct mention".** A plant of a
  *never-retired* number (`31`) in `SKILL.md` and `coldrig.mdc` stayed GREEN, because both files
  keep other correct "28 … tool" mentions and `31` is not in `RETIRED_TOOL_COUNTS`. The guard's two
  real legs — "must not claim a retired count" and "must claim the current count somewhere" — do
  catch the actual drift mode (registry grows, a surface keeps the old number), *provided the
  outgoing count is added to `RETIRED_TOOL_COUNTS = [17,19,21,24,25,27]` at bump time, which has
  been the practice*. This is a pre-existing property shared by all 32 listed surfaces, not a
  regression from this lane. Hardening idea: assert that *every* `\bN\b.{0,30}(tool|intent)` match
  in a listed file equals `currentCount`.
- **ROADMAP counts disagree with the file they live in.** `ROADMAP.md:19` [NOTE] says "112 kept";
  commit `688150c` says "123 kept"; commit `2dac5a7` says "234 → 116 open"; the file actually has
  **116** `- [ ]` items. Report only.
- **Founder ORDER 2026-08-23 items 1 and 5 are still unchecked** (`ROADMAP.md:142`). This wave
  delivers item (1) in full and item (5) partially — the homepage comparison table and `sameAs`
  expansion are done, but "server.json npm pin / CLI 0.2.3 publish" is not (npm latest is still
  0.2.1). Neither `ROADMAP.md`, `HANDOFF.md` nor `MEMORY.md` is touched by the wave diff, so the
  CLAUDE.md update-discipline and self-draining-checkbox obligations are still owed at wave close.

## Review side effects on production (round 2)

One additional demo-plan tenant (`Adversary R2 Probe`,
`adversary-r2+20260823@example.com`) was minted to supply a real bearer token for the
header-capture test. Sandbox plan, no spend, no sends, no campaigns. Purge alongside the round-1
probe tenant if demo-tenant hygiene matters.

---

# Round 3 — ship gate (execution re-check)

- **Date:** 2026-08-23 · **Worktree:** `/Users/yaakovscher/dev/coldstart-wt-integ` · **Branch:** `integ/visibility-2026-08-23`
- **Ground ref (`git rev-parse HEAD`):** `2ed222154d7482b24cd1eaa926c532beb69bdc8f`
- Since r2: `bc16a28` (NB6, NB9), `443e859` (B6 via a global table scroll container + NB7 + NB10), `987b0bc` (`.hero-stage{overflow:hidden}`).

## VERDICT: NO-SHIP — 1 BLOCKING (B7), one CSS line, fix proven

B6 is genuinely closed and the four NBs are in. But the **mechanism chosen for B6 introduced a new
desktop regression**: two comparison tables now hide content behind an in-table scroll at 1440 px
that `main` displayed in full. Fix is one declaration moved; measured below.

## B7 (BLOCKING) — the unconditional `min-width: 11rem` clips the last column of two comparison tables at desktop

`site/assets/style.css:77` moved `th:not(:first-child), td:not(:first-child) { min-width: 11rem }`
out of the `@media (max-width:620px)` block and made it global, while `table` became
`display:block; overflow-x:auto` at all widths. On a 960 px content column, five non-first columns
at 176 px each no longer fit.

Measured at 1440 px, `main` vs HEAD (`table.scrollWidth` vs `clientWidth`, and each first-row cell's
`getBoundingClientRect().right` vs the table's):

```
compare-vs-maildoso.html table#1 (6 col)
  MAIN  client=960 scroll=960   nothing past the right edge
  HEAD  client=960 scroll=1114  CLIPPED col5 "Cost per 100 sends/day" — 154px of its 176px hidden
compare-vs-agentmail.html table#0 (3 col)
  MAIN  client=960 scroll=960   nothing past the right edge
  HEAD  client=960 scroll=991   CLIPPED col2 "Coldrig" — 31px of its 197px hidden
```

`table.offsetHeight - table.clientHeight = 0`, i.e. macOS overlay scrollbars — **no visible
affordance**. The element screenshot confirms it: the maildoso header row ends in a clipped
"C / S" and each row's final value shows only a `$` sliver. It is the payoff column of a
price-comparison table, and on the agentmail page it is our own "Coldrig" column.

Full sweep of all 37 pages, tables that scroll on HEAD but did not on `main`:

```
1440px  compare-vs-agentmail#0:+31   compare-vs-maildoso#1:+154
1280px  compare-vs-agentmail#0:+31   compare-vs-maildoso#1:+154
1024px  compare-vs-agentmail#0:+49   compare-vs-maildoso#1:+172  compare-vs-smartlead#1:+16
 820px  agentmail+237  foxreach+36  maildoso+360  skyp+137  smartlead+204  docs+171  guide-mcp-tool-count+123
```

**Fix — move that one declaration back inside `@media (max-width: 620px)`,** keeping
`display:block; overflow-x:auto` global (that is what actually closed B6):

```css
/* delete from the global block: */
th:not(:first-child), td:not(:first-child) { min-width: 11rem; }
/* add inside @media (max-width: 620px): */
table th:not(:first-child),table td:not(:first-child){min-width:11rem}
```

**Proven on a patched copy of the HEAD site — strictly dominates HEAD:**

```
new-desktop-scroll sweep, 37 pages:   1440 none · 1280 none · 1024 none · 820 none
page overflow, 37 pages × 8 widths:   390/621/700/768/820/1024/1280/1440 → none
```

## Verified PASS

1. **B6 page overflow — CLOSED.** `main` had `index.html:+4px` at 621/700; HEAD is `none` at
   621/700/768/820 across all 10 previously-flagged pages, and `none` at 390/1024/1440 on
   index/docs/compare-vs-maildoso. Extended to the full site: **37 pages × 8 widths → 0 overflow
   anywhere**, which exceeds the builder's 19×7 matrix.
2. **Desktop no-op claim — PARTIALLY TRUE.** Table box geometry is unchanged: every table still
   reports `getBoundingClientRect().width = 960 = parent`, i.e. `display:block` did **not** cost the
   `width:100%` stretch. Column widths redistribute as intended by the first-column `nowrap`
   (`compare-vs-diy` `[112,404,444] → [222,365,373]`; `docs` `[104,514,342] → [205,286,469]`;
   `compare-vs-maildoso#0` `[127,393,440] → [375,284,300]`) — a deliberate visual change, not a
   defect. The claim fails only on the two tables in B7.
3. **Hero — PASS.** At 621/700/768/1440 the `.hero-stage` card geometry is **byte-identical between
   `main` and HEAD**: `agent-card` overhangs 5 px left and `health-card` 4 px right / 4 px top on
   both. `overflow:hidden` clips exactly that pre-existing 4–5 px of card edge, converting `main`'s
   `pageOv=4` into `pageOv=0`. Screenshot at 700 px: all three cards present, "0 paused",
   "8 healthy", "Guardrail applied — Daily volume held at 24/mailbox" and the full tool-call list
   all fully legible. No text clipped.
4. **NB6/NB7/NB9/NB10 — all in.** `SKILL.md:91` now states the CLI "cannot pass `quoteOnly` or
   `registerDomains`, and it silently substitutes a placeholder CAN-SPAM physical address … so do
   not use the CLI form for this consent step". `README.md` MCP block key is `coldrig` (the two
   remaining `"agent-cold-email"` keys, `SKILL.md:75` and `llms-install.md:36`, are the **stdio
   fallback** blocks launching `npx -y agent-cold-email mcp` — correctly named after the package,
   not a residual). `compare-vs-maildoso` now reads "No refunds on the unused portion of a paid
   period (see Terms)". `.table-source-note` styled at `style.css:79`.
5. **Plugin install on HEAD — unchanged.** Throwaway `HOME`, `git archive HEAD` tree:
   cache **28K**, **0** `node_modules`, `Skills (1) coldrig`, `MCP servers (1) coldrig`,
   ~180 tok always-on, and the userConfig prompt hint still printed.
