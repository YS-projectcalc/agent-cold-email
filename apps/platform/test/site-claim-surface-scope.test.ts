import { describe, expect, it } from "vitest";

// Claim-surface scope guard (2026-07-27 founder-ordered pass — three changes:
// all-in price-math rubric, purchase-path clarity, concierge-caveat
// scoping). This guard covers the SECOND and THIRD of those changes: it
// makes any future reintroduction of the retired "concierge activation"
// framing, or a stale "waitlist"/"early access" gating claim, fail loudly on
// the exact surfaces a buyer-agent reads (mirrors the sibling
// site-tool-count-claims.test.ts pattern — whole-file `?raw` text imports,
// since the workers-pool test runtime has no general filesystem access).
//
// Raw-text imports (Vite `?raw`, resolved at bundle time).
import rootReadme from "../../../README.md?raw";
import agentsMd from "../../../AGENTS.md?raw";
import serverJson from "../../../server.json?raw";
import serverCardJson from "../../../site/.well-known/mcp/server-card.json?raw";
import siteIndex from "../../../site/index.html?raw";
import siteReadme from "../../../site/README.md?raw";
import forAgents from "../../../site/for-agents.html?raw";
import agentEvaluation from "../../../site/agent-evaluation.md?raw";
import pricingHtml from "../../../site/pricing.html?raw";
import docsHtml from "../../../site/docs.html?raw";
import faqHtml from "../../../site/faq.html?raw";
import llmsTxt from "../../../site/llms.txt?raw";
import compareHtml from "../../../site/compare.html?raw";
import compareSalesforge from "../../../site/compare-vs-salesforge.html?raw";
import compareAgentmail from "../../../site/compare-vs-agentmail.html?raw";
import compareFoxreach from "../../../site/compare-vs-foxreach.html?raw";
import compareMaildoso from "../../../site/compare-vs-maildoso.html?raw";
import compareSkyp from "../../../site/compare-vs-skyp.html?raw";
import compareSmartlead from "../../../site/compare-vs-smartlead.html?raw";
import compareSmartleadInstantly from "../../../site/compare-vs-smartlead-instantly.html?raw";
import byoDomain from "../../../site/byo-domain.html?raw";
import connectHtml from "../../../site/connect.html?raw";
import securityHtml from "../../../site/security.html?raw";
import statusHtml from "../../../site/status.html?raw";
import termsHtml from "../../../site/terms.html?raw";
import whyEmailHtml from "../../../site/why-email.html?raw";
import privacyHtml from "../../../site/privacy.html?raw";
import guideMcpColdEmail from "../../../site/guide-mcp-cold-email.html?raw";
import guideClaudeCode from "../../../site/guide-cold-email-operation-claude-code.html?raw";
import guideCursor from "../../../site/guide-cold-email-operation-cursor.html?raw";
import guideCodex from "../../../site/guide-cold-email-operation-codex.html?raw";
import guideWithAiAgent from "../../../site/guide-cold-email-with-ai-agent.html?raw";
import openapiYaml from "../../../site/openapi.yaml?raw";
import llmsInstallMd from "../../../llms-install.md?raw";
import pluginJson from "../../../.claude-plugin/plugin.json?raw";
import cliReadme from "../../../packages/cli/README.md?raw";

const CLAIM_SURFACES: ReadonlyArray<readonly [string, string]> = [
  ["README.md", rootReadme],
  ["AGENTS.md", agentsMd],
  ["server.json", serverJson],
  ["site/.well-known/mcp/server-card.json", serverCardJson],
  ["site/index.html", siteIndex],
  ["site/README.md", siteReadme],
  ["site/for-agents.html", forAgents],
  ["site/agent-evaluation.md", agentEvaluation],
  ["site/pricing.html", pricingHtml],
  ["site/docs.html", docsHtml],
  ["site/faq.html", faqHtml],
  ["site/llms.txt", llmsTxt],
  ["site/compare.html", compareHtml],
  ["site/compare-vs-salesforge.html", compareSalesforge],
  ["site/compare-vs-agentmail.html", compareAgentmail],
  ["site/compare-vs-foxreach.html", compareFoxreach],
  ["site/compare-vs-maildoso.html", compareMaildoso],
  ["site/compare-vs-skyp.html", compareSkyp],
  ["site/compare-vs-smartlead.html", compareSmartlead],
  ["site/compare-vs-smartlead-instantly.html", compareSmartleadInstantly],
  ["site/byo-domain.html", byoDomain],
  ["site/connect.html", connectHtml],
  ["site/security.html", securityHtml],
  ["site/status.html", statusHtml],
  ["site/terms.html", termsHtml],
  ["site/why-email.html", whyEmailHtml],
  ["site/privacy.html", privacyHtml],
  ["site/guide-mcp-cold-email.html", guideMcpColdEmail],
  ["site/guide-cold-email-operation-claude-code.html", guideClaudeCode],
  ["site/guide-cold-email-operation-cursor.html", guideCursor],
  ["site/guide-cold-email-operation-codex.html", guideCodex],
  ["site/guide-cold-email-with-ai-agent.html", guideWithAiAgent],
  ["site/openapi.yaml", openapiYaml],
  // Directory/npm-facing surfaces (2026-07-27 adversarial review, BLOCKING
  // #2 — docs/adversarial/claims-truth-pass-review-2026-07-27.md finding 2):
  // llms-install.md, .claude-plugin/plugin.json, and packages/cli/README.md
  // are exactly the copy an MCP directory (Glama et al.) or the Claude Code
  // plugin marketplace renders as install/status text — canonical buyer-facing
  // surfaces even though they live outside site/. The original sweep missed
  // them because the guard below only ever scanned SITE_SURFACES; adding them
  // here closes that scope gap for good.
  ["llms-install.md", llmsInstallMd],
  [".claude-plugin/plugin.json", pluginJson],
  ["packages/cli/README.md", cliReadme],
];

// Buyer/directory-facing surfaces the marketing-only checks below apply to:
// every site/ page, PLUS the three root-level directory surfaces added above
// (llms-install.md, plugin.json, packages/cli/README.md) — excludes only
// README.md/AGENTS.md/server.json, which are repo docs rather than
// buyer-facing copy (still covered by the concierge check, which applies to
// every CLAIM_SURFACE).
const BUYER_FACING_SURFACES = CLAIM_SURFACES.filter(
  ([label]) => label.startsWith("site/") || label === "llms-install.md" || label === ".claude-plugin/plugin.json" || label === "packages/cli/README.md",
);

// site/README.md is a repo-internal build doc describing the site's own
// asset files (e.g. "assets/waitlist.js — waitlist form submission logic"
// for a general product-updates opt-in) — not a marketing claim a buyer-agent
// evaluates, so it is exempt from the marketing-only waitlist/early-access/
// request-activation checks below (it still must pass the concierge check,
// which applies to every CLAIM_SURFACE).
const MARKETING_SITE_SURFACES = BUYER_FACING_SURFACES.filter(([label]) => label !== "site/README.md");

// "waitlist" appears legitimately in three shapes that are NOT the stale
// claim being swept here:
//   1. A true negation ("no card, no waitlist") — asserts the ABSENCE of a
//      waitlist, which is exactly the truth this pass establishes.
//   2. Implementation plumbing: the real `/api/waitlist` lead-capture
//      endpoint, `assets/waitlist.js`, and the `form.waitlist` CSS/JS
//      selector hook still legitimately exist (a general "get product
//      updates" opt-in, unrelated to gating real-sending activation) — this
//      guard targets the CLAIM (a customer must wait to get real sending),
//      not the plumbing behind an unrelated mailing-list feature.
// Strip both known-safe shapes before asserting the word is gone, mirroring
// how site-tool-count-claims.test.ts matches specific claim phrasings rather
// than a blind generic scan (documented reasoning there applies here too).
const SAFE_WAITLIST_PATTERNS = [
  /no[\s,]*card,?\s*no\s*waitlist/gi,
  /\/api\/waitlist/gi,
  /waitlist\.js/gi,
  /form\.waitlist/gi,
  /class="waitlist"/gi,
];

function stripSafeWaitlistMentions(text: string): string {
  let stripped = text;
  for (const pattern of SAFE_WAITLIST_PATTERNS) stripped = stripped.replace(pattern, "");
  return stripped;
}

describe("claim-surface scope guard (concierge / waitlist / promo-code)", () => {
  it.each(CLAIM_SURFACES)("%s never says \"concierge\"", (label, text) => {
    // The 2026-07-27 pass (plus the same-day adversarial-review follow-up)
    // eliminated the "concierge activation step" framing everywhere it
    // appeared — compare pages, guides, README/AGENTS/server manifests,
    // agent-evaluation.md, and (closing the round-1 scope gap) the
    // directory/npm-facing surfaces llms-install.md, plugin.json, and
    // packages/cli/README.md — in favor of the scoped, non-temporal truth:
    // signup, billing, screening, and real mailbox provisioning are
    // self-serve and automatic; the only remaining step is mailbox
    // send-authorization completing on our side after provisioning — no
    // empirical turnaround claim (e.g. "typically same-day") until a real
    // self-serve activation has actually completed end to end. No surface
    // keeps the word "concierge" at all, so this is a strict ban across
    // every CLAIM_SURFACE, not a phrasing allowlist.
    expect(text.toLowerCase(), `${label} still says "concierge"`).not.toContain("concierge");
  });

  it.each(MARKETING_SITE_SURFACES)("%s never claims a waitlist gates real sending", (label, text) => {
    const stripped = stripSafeWaitlistMentions(text);
    expect(stripped.toLowerCase(), `${label} still has an unaccounted-for "waitlist" mention`).not.toContain("waitlist");
  });

  it.each(MARKETING_SITE_SURFACES)("%s never claims \"early access\"", (label, text) => {
    expect(text.toLowerCase(), `${label} claims "early access"`).not.toContain("early access");
  });

  it.each(MARKETING_SITE_SURFACES)("%s never uses \"request activation\" as a gating CTA", (label, text) => {
    // The old flow told a buyer to "request activation" and wait for a human
    // follow-up. Going live is now self-serve (POST /checkout); this phrase
    // should never appear as a call to action again.
    expect(text.toLowerCase(), `${label} still says "request activation"`).not.toContain("request activation");
  });

  it.each(CLAIM_SURFACES)("%s never claims an empirical send-authorization turnaround (NB#3, 2026-07-27 adversarial review)", (label, text) => {
    // "typically same-day" (and equivalent phrasings like "takes up to a
    // day") asserts an OBSERVED distribution of real self-serve activations
    // that does not exist yet — zero real customers have completed
    // provisioning + send-authorization end to end (docs/adversarial/
    // claims-truth-pass-review-2026-07-27.md finding 3). Until a completed
    // activation exists to measure, the truthful claim is non-temporal:
    // mailbox send-authorization completes on our side after provisioning —
    // no queue, no customer action, but no duration promise either.
    const lower = text.toLowerCase();
    expect(lower, `${label} claims an empirical "same-day" turnaround`).not.toContain("typically same-day");
    expect(lower, `${label} claims an empirical "same day" turnaround`).not.toContain("typically the same day");
    expect(lower, `${label} claims an empirical "up to a day" turnaround`).not.toContain("takes up to a day");
  });

  // NB#4 (2026-07-27 adversarial review, finding 4): any surface that shows
  // the `{ mailboxes }` checkout body next to the per-mailbox price ladder
  // must also disclose that the field only SEEDS the quote — the actual
  // Stripe subscription quantity follows the tenant's live provisioned
  // mailbox count (billing.ts `checkoutMailboxQuantity`), not the number
  // passed at checkout time. Only surfaces that literally show the request
  // body are checked — a page that merely mentions "POST /checkout" without
  // showing `{ mailboxes }` isn't making the specific claim this guards.
  const CHECKOUT_BODY_SURFACES = CLAIM_SURFACES.filter(([, text]) => /\{\s*mailboxes\s*\}|"mailboxes"\s*:\s*\d/.test(text));

  it("at least one surface actually shows the { mailboxes } checkout body (sanity anchor for the NB#4 guard below)", () => {
    expect(CHECKOUT_BODY_SURFACES.length).toBeGreaterThan(0);
  });

  it.each(CHECKOUT_BODY_SURFACES)("%s explains the checkout body only seeds the quote (NB#4, 2026-07-27 adversarial review)", (label, text) => {
    expect(
      text.toLowerCase(),
      `${label} shows the { mailboxes } checkout body but never clarifies the charge tracks the PROVISIONED mailbox count, not that field`,
    ).toMatch(/seeds? the (initial )?quote|provisioned mailbox count/);
  });

  it("docs.html states the Stripe promotion-code line", () => {
    expect(docsHtml).toMatch(/add promotion code/i);
  });

  it("faq.html states the Stripe promotion-code line", () => {
    expect(faqHtml).toMatch(/add promotion code/i);
  });
});
