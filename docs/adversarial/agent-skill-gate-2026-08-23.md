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
