import { describe, expect, it } from "vitest";
import { MCP_TOOLS } from "../src/mcp/tools.js";
import { WEBHOOK_EVENT_TYPES } from "@coldstart/shared";

// Class sweep (docs/adversarial/class-sweep-claim-drift-2026-08-17.md §4) — the
// systemic guard behind the "unbound claim" class: every tool/endpoint prose
// copy is hand-written and NOTHING mechanically checks it against the TS
// result type / zod enum / registry it describes. Four rules (G1-G4), each
// mechanically decidable. This extends site-tool-count-claims.test.ts's `?raw`
// pattern from COUNTS to FIELDS, ENUMS, and COVERAGE.
//
// Raw-text imports (Vite `?raw`) — same rationale as site-tool-count-
// claims.test.ts: the workers-pool test runtime has no general filesystem
// access.
import billingSrc from "../src/engine/billing.ts?raw";
import infraStatusSrc from "../src/engine/infrastructure-status.ts?raw";
import provisioningSrc from "../src/engine/provisioning.ts?raw";
import reportingSrc from "../src/engine/reporting.ts?raw";
import inboxSrc from "../src/engine/inbox.ts?raw";
import threadsSrc from "../src/engine/threads.ts?raw";
import campaignsSrc from "../src/engine/campaigns.ts?raw";
import activitySrc from "../src/engine/activity.ts?raw";
import dashboardViewsSrc from "../src/engine/dashboard-views.ts?raw";
import webhooksSrc from "../src/engine/webhooks.ts?raw";
import byoIntakeSrc from "../src/engine/byo-intake.ts?raw";
import listLeadsSrc from "../src/engine/list-leads.ts?raw";
import tenantMessagesSrc from "../src/engine/tenant-messages.ts?raw";
import contactOperatorSrc from "../src/engine/contact-operator.ts?raw";
import supportKbSrc from "../src/admin/support-kb.ts?raw";
import openapiYaml from "../../../site/openapi.yaml?raw";
import schemasSrc from "../src/mcp/schemas.ts?raw";
import llmsTxt from "../../../site/llms.txt?raw";
import claudeCodeGuide from "../../../site/guide-cold-email-operation-claude-code.html?raw";
import forAgentsHtml from "../../../site/for-agents.html?raw";
import cursorGuide from "../../../site/guide-cold-email-operation-cursor.html?raw";
import salesforgeCompare from "../../../site/compare-vs-salesforge.html?raw";
import docsHtml from "../../../site/docs.html?raw";
import mcpColdEmailGuide from "../../../site/guide-mcp-cold-email.html?raw";
import faqHtml from "../../../site/faq.html?raw";
import codexGuide from "../../../site/guide-cold-email-operation-codex.html?raw";
import serverCardJson from "../../../site/.well-known/mcp/server-card.json?raw";
import rootReadme from "../../../README.md?raw";
import agentsMd from "../../../AGENTS.md?raw";

// --- G1 — response-field binding -------------------------------------------

/**
 * Walks `src` from just after `{` (inclusive) to its matching `}`, tracking
 * brace depth so nested object literals don't terminate the scan early.
 */
function findBalancedBlock(src: string, openBraceIdx: number): string {
  let depth = 0;
  for (let i = openBraceIdx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(openBraceIdx, i + 1);
    }
  }
  throw new Error(`findBalancedBlock: unbalanced braces from index ${openBraceIdx}`);
}

/**
 * Declared top-level property names of an `export interface Name { ... }` or
 * `export type Name = { ... } | { ... }` in `src`. For an interface, only
 * DEPTH-1 lines count (a nested inline object's own fields are not claimed to
 * exist on the OUTER interface). For a type-alias union of object literals,
 * every member across every arm is unioned (permissive by design — a claim
 * naming a field that exists on ONE arm of the union is a real field of that
 * result, just not present on every outcome).
 */
function declaredProps(src: string, name: string): string[] {
  const ifaceRe = new RegExp(`export interface ${name}\\b[^{]*\\{`);
  const ifaceMatch = ifaceRe.exec(src);
  if (ifaceMatch) {
    const block = findBalancedBlock(src, ifaceMatch.index + ifaceMatch[0].length - 1);
    const inner = block.slice(1, -1);
    const props = new Set<string>();
    let depth = 0;
    for (const rawLine of inner.split("\n")) {
      const line = rawLine.trim();
      if (depth === 0 && !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/**")) {
        const m = /^(\w+)\??:/.exec(line);
        if (m) props.add(m[1]!);
      }
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    }
    return [...props];
  }

  const typeRe = new RegExp(`export type ${name}\\s*=`);
  const typeMatch = typeRe.exec(src);
  if (typeMatch) {
    let i = typeMatch.index + typeMatch[0].length;
    let depth = 0;
    let end = src.length;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{" || ch === "(" || ch === "<") depth++;
      else if (ch === "}" || ch === ")" || ch === ">") depth--;
      else if (ch === ";" && depth === 0) {
        end = i;
        break;
      }
    }
    const block = src.slice(typeMatch.index + typeMatch[0].length, end);
    const props = new Set<string>();
    for (const m of block.matchAll(/(\w+)\??:/g)) props.add(m[1]!);
    return [...props];
  }

  throw new Error(`declaredProps: no 'export interface ${name}' or 'export type ${name}' found`);
}

/**
 * Fields a tool description CLAIMS its result carries — extracted from the
 * three shapes this corpus actually uses: `returns { a, b }` (case-
 * insensitive "return(s)" immediately before a brace), `[{ a, b }]` (a bare
 * array-of-object claim, e.g. "list all: [{ id, name }]"), and `→ { a, b }`
 * (an arrow directly onto a brace, e.g. "With id → { subscription, ... }").
 * Each is a SINGLE (non-nested) brace group by construction of this corpus's
 * prose style — a claim containing a nested object (e.g. list_campaigns'
 * `counts{...}`) is deliberately NOT matched here (documented residual, see
 * report) rather than risk mis-parsing nested fields as top-level ones.
 */
function extractReturnsFields(description: string): string[] {
  const fields = new Set<string>();
  const patterns = [/returns?\s*\{([^{}]*)\}/gi, /\[\{([^{}]*)\}\]/g, /→\s*\{([^{}]*)\}/g];
  for (const re of patterns) {
    for (const m of description.matchAll(re)) {
      for (const segment of m[1]!.split(",")) {
        const idMatch = /^\s*`?(\w+)/.exec(segment);
        if (idMatch) fields.add(idMatch[1]!);
      }
    }
  }
  return [...fields];
}

interface ResultTypeEntry {
  /** [rawSourceText, exportedInterfaceOrTypeName] pairs — unioned. */
  sources?: ReadonlyArray<readonly [string, string]>;
  /** Literal field names for a tool whose handler returns an inline object
   * literal with no named interface (e.g. `{ marked: true }`) — unioned with
   * `sources` when both are present. */
  extra?: readonly string[];
}

// One entry per MCP_TOOLS member (28) — the companion assertion below fails
// if any tool lacks one, so tool 29 cannot land without declaring its result
// type here. Sourced from the REAL engine interfaces wherever one exists;
// `extra` covers the handful of tools whose handler returns an inline
// literal with no named type (mark/pause/pause_all/reply/launch_campaign).
const RESULT_TYPES: Record<string, ResultTypeEntry> = {
  setup_infrastructure: { sources: [[provisioningSrc, "SetupInfrastructureRunResult"]] },
  infrastructure_status: { sources: [[infraStatusSrc, "InfrastructureStatus"]] },
  launch_campaign: { extra: ["campaignId"] },
  campaign_results: { sources: [[reportingSrc, "EventCounts"]], extra: ["campaignId"] },
  metrics: { sources: [[reportingSrc, "EventCounts"]] },
  inbox: { sources: [[inboxSrc, "InboxPage"]] },
  thread: { sources: [[threadsSrc, "ThreadDetail"]] },
  // Two DISTINCT claimed shapes in one description: the success body
  // ({messageId, deduplicated}) and the refusal body (error-response.ts's
  // send_blocked shape, verified honest by the class sweep's OUT column).
  // `deduplicated` is `extra`, not sourced, for the same reason it is on
  // remove_mailboxes/contact_operator below.
  reply: { extra: ["messageId", "deduplicated", "error", "code", "reason", "retryable"] },
  mark: { extra: ["marked"] },
  pause: { extra: ["paused"] },
  pause_all: { extra: ["pausedAll"] },
  account: { sources: [[reportingSrc, "AccountSummary"]] },
  // `deduplicated` is `extra`, not part of `sources`: it's added via
  // `Collapsed<T> = T & { deduplicated: boolean }` (packages/shared/src/
  // provenance.ts) at the FUNCTION's return type, not inside the
  // `RemoveMailboxesResult` interface body itself — declaredProps only
  // parses named interfaces/type-alias unions, not a generic intersection
  // applied at a call site, so the real field is declared here by hand
  // instead. IN-19/IN-20 dedup-semantics claim fixes, train 4 integration.
  remove_mailboxes: { sources: [[billingSrc, "RemoveMailboxesResult"]], extra: ["deduplicated"] },
  get_dashboard: {
    sources: [
      [dashboardViewsSrc, "DashboardViewSummary"],
      [dashboardViewsSrc, "DashboardViewDetail"],
    ],
  },
  configure_dashboard: { sources: [[dashboardViewsSrc, "DashboardViewDetail"]], extra: ["currentRev", "currentLayout"] },
  label_thread: { extra: [] },
  list_campaigns: { sources: [[campaignsSrc, "CampaignListItem"]] },
  activity: { sources: [[activitySrc, "ActivityPage"]] },
  get_webhooks: {
    sources: [
      [webhooksSrc, "WebhookSummary"],
      [webhooksSrc, "WebhookDetail"],
    ],
  },
  configure_webhook: { sources: [[webhooksSrc, "WebhookDetail"]] },
  get_byo_domains: { sources: [[byoIntakeSrc, "ByoDomainSummary"]] },
  configure_byo_domain: { extra: ["provisionedAfter", "projectedMonthlyCents", "formula"] },
  suppress_lead: { extra: [] },
  update_lead: { extra: [] },
  list_leads: { sources: [[listLeadsSrc, "LeadListPage"], [listLeadsSrc, "LeadListRow"]] },
  list_messages: {
    sources: [
      [tenantMessagesSrc, "MessageListPage"],
      [tenantMessagesSrc, "TenantMessage"],
    ],
  },
  ack_message: { sources: [[tenantMessagesSrc, "AckMessageResult"]] },
  // `deduplicated` is `extra` — same Collapsed<T> reason as remove_mailboxes above.
  contact_operator: { sources: [[contactOperatorSrc, "ContactOperatorResult"]], extra: ["deduplicated"] },
};

function declaredFieldsFor(entry: ResultTypeEntry): string[] {
  const fromSources = (entry.sources ?? []).flatMap(([src, name]) => declaredProps(src, name));
  return [...new Set([...fromSources, ...(entry.extra ?? [])])];
}

describe("tool-claim-binding — G1 response-field binding", () => {
  it("every MCP_TOOLS entry has a RESULT_TYPES map entry (tool 29 can't land without one)", () => {
    const missing = MCP_TOOLS.map((t) => t.name).filter((n) => !(n in RESULT_TYPES));
    expect(missing).toEqual([]);
  });

  it.each(MCP_TOOLS.map((t) => [t.name, t.description] as const))("%s's Returns{}/[{}] claim only names fields its result type actually declares", (name, description) => {
    const entry = RESULT_TYPES[name];
    if (!entry) return; // covered by the companion assertion above
    const claimed = extractReturnsFields(description);
    const declared = declaredFieldsFor(entry);
    const unknown = claimed.filter((f) => !declared.includes(f));
    expect(unknown, `${name} claims field(s) not on its declared result type: ${unknown.join(", ")}`).toEqual([]);
  });
});

// --- G2 — enumeration binding (highest yield per the sweep) -----------------

/**
 * G2 — every claim surface that enumerates the webhook event-type chain
 * ("reply...bounce...soft_bounce...complaint", the same order as
 * WEBHOOK_EVENT_TYPES itself, comma/pipe/backtick-separated) must carry
 * `unsubscribe` immediately after it too.
 *
 * ORDER-ANCHORED rather than generic word-proximity — tried first, and
 * false-positived twice live while building this guard: (1) a member word
 * split across a fixed-size slice boundary read as absent from every slice
 * even though fully present; (2) several of these words are ALSO ordinary
 * product vocabulary that coincidentally co-occurs elsewhere in the SAME
 * documents outside the webhook context — an EventCounts field list (a
 * DIFFERENT order: reply, bounce, complaint, unsubscribe, failed,
 * soft_bounce — no "soft_bounce" third) and a suppress_lead note listing
 * "bounce/complaint/unsubscribe" as auto-recorded reasons. Anchoring on the
 * literal 4-in-a-row chain this corpus's real enumerations always use
 * (verified against all ~20 real sites while fixing them) eliminates both:
 * neither false-positive site contains "soft_bounce" immediately after
 * "reply...bounce" in order. Scope: this catches every future edit that
 * touches an EXISTING chain (this class's actual defect shape — the sweep's
 * own framing: "every surface below enumerates four") — it does not
 * generalize to a differently-ordered or differently-worded future
 * enumeration, which would need its own anchor.
 */
function missingWebhookMember(text: string): boolean {
  // Gaps allow ANY short span (not just punctuation) — a real English list's
  // last-pre-fix item is "..., and complaint" (the connector word "and"
  // sits in the soft_bounce->complaint gap on the OLD 4-item phrasing this
  // guard exists to catch); the STRICT four-in-a-row ORDER requirement is
  // what keeps this precise, not the gap's character class.
  const CHAIN_RE = /reply.{1,20}?bounce.{1,20}?soft_bounce.{1,20}?complaint/gis;
  for (const match of text.matchAll(CHAIN_RE)) {
    const tailStart = match.index + match[0].length;
    const tail = text.slice(tailStart, tailStart + 40);
    if (!/unsubscribe/i.test(tail)) return true; // core 4-chain found, no 5th member nearby
  }
  return false;
}

const WEBHOOK_CLAIM_SURFACES: ReadonlyArray<readonly [string, string]> = [
  ["mcp/tools.ts configure_webhook description", MCP_TOOLS.find((t) => t.name === "configure_webhook")!.description],
  ["mcp/schemas.ts (raw)", schemasSrc],
  ["site/llms.txt", llmsTxt],
  ["site/guide-cold-email-operation-claude-code.html", claudeCodeGuide],
  ["site/for-agents.html", forAgentsHtml],
  ["site/guide-cold-email-operation-cursor.html", cursorGuide],
  ["site/compare-vs-salesforge.html", salesforgeCompare],
  ["site/docs.html", docsHtml],
  ["site/guide-mcp-cold-email.html", mcpColdEmailGuide],
  ["site/faq.html", faqHtml],
  ["site/guide-cold-email-operation-codex.html", codexGuide],
  ["site/.well-known/mcp/server-card.json", serverCardJson],
  ["README.md", rootReadme],
  ["AGENTS.md", agentsMd],
  ["site/openapi.yaml", openapiYaml],
];

describe("tool-claim-binding — G2 enumeration binding (webhook event types)", () => {
  it("the live registry currently has 5 webhook event types (sanity anchor)", () => {
    expect(WEBHOOK_EVENT_TYPES).toEqual(["reply", "bounce", "soft_bounce", "complaint", "unsubscribe"]);
  });

  it.each(WEBHOOK_CLAIM_SURFACES)("%s never enumerates the core reply/bounce/soft_bounce/complaint chain without unsubscribe", (label, text) => {
    expect(missingWebhookMember(text), `${label} enumerates reply...bounce...soft_bounce...complaint without unsubscribe following`).toBe(false);
  });
});

// --- G3 — surface registration (support-kb.ts closed the specific gap) -----

describe("tool-claim-binding — G3 surface registration (support-kb.ts)", () => {
  it("the drafted support 'how-to' answer states the CURRENT tool count", () => {
    // Regex mirrors site-tool-count-claims.test.ts's claimsToolCountOf shape
    // (N within ~30 chars of "tool"/"tools") — this surface previously said
    // "~12 tools" and was invisible to that guard because support-kb.ts was
    // never in its CLAIM_SURFACES array (docs/adversarial/class-sweep-claim-
    // drift-2026-08-17.md §3, "double scope gap").
    const n = MCP_TOOLS.length;
    const re = new RegExp(`\\b${n}\\b.{0,30}?\\btools?\\b`, "i");
    expect(re.test(supportKbSrc), `support-kb.ts's how-to draft should state ${n} tools`).toBe(true);
  });

  it("the drafted support 'how-to' answer never states a retired tool count", () => {
    for (const retired of [12, 17, 19, 21, 24, 25, 27]) {
      const re = new RegExp(`\\b${retired}\\b.{0,30}?\\btools?\\b`, "i");
      expect(re.test(supportKbSrc), `support-kb.ts still claims the retired count ${retired}`).toBe(false);
    }
  });
});

// --- G4 — openapi <-> registry coverage -------------------------------------

// Fan-out tools whose single MCP action maps to several REST operationIds
// with no shared name prefix (configure_byo_domain's sub-actions are named
// by VERB, not by `configure_byo_domain_<action>`) — every listed op must be
// present for the tool to count as covered.
const FAN_OUT: Record<string, readonly string[]> = {
  configure_dashboard: ["configure_dashboard_create", "configure_dashboard_update", "configure_dashboard_promote", "configure_dashboard_delete"],
  configure_webhook: ["configure_webhook_create", "configure_webhook_update", "configure_webhook_delete"],
  configure_byo_domain: ["register_byo_domain", "poll_byo_domain_dns", "acknowledge_byo_consent", "request_managed_byo_mailboxes", "connect_byo_mailbox"],
};

function coveredBy(ops: ReadonlySet<string>, toolName: string): boolean {
  if (ops.has(toolName)) return true;
  const fanOut = FAN_OUT[toolName];
  return fanOut ? fanOut.every((op) => ops.has(op)) : false;
}

describe("tool-claim-binding — G4 openapi <-> registry coverage", () => {
  it("openapi.yaml declares an operation covering every MCP_TOOLS entry", () => {
    const ops = new Set([...openapiYaml.matchAll(/operationId:\s*(\S+)/g)].map((m) => m[1]!));
    const uncovered = MCP_TOOLS.map((t) => t.name).filter((n) => !coveredBy(ops, n));
    expect(uncovered, `openapi.yaml has no operation for: ${uncovered.join(", ")}`).toEqual([]);
  });
});

// --- IN-19 / IN-20 (docs/adversarial/class-sweep-dedup-semantics-2026-08-17.md)
// — claim-surface members of the dedup/collapse class, not new guard rules.
// IN-19: infrastructure_status's messages[] claimed an unconditional
// completeness guarantee ("so you never miss one") over what is, by
// construction, a LIMIT-5 view — the operator-first sort protects ONE
// eviction scenario (system churn displacing a human reply), not the
// general case (a 6th genuinely distinct unacked message of either kind can
// still fall off this preview). IN-20: contact_operator's dedup-retry prose
// framed the (body,urgency) collapse as unconditionally "safe" — the code
// DOES guarantee identical text within the window returns the same ticketId
// with no second ticket/alert, but that is a TEXT match, not an intent
// match: a genuinely NEW message with coincidentally-identical wording
// collapses the same way, silently, which "is safe" does not disclose.
// Deliberately prose-only — no `deduplicated` field is asserted anywhere
// here; that lands with its type change from the sibling lane.
describe("tool-claim-binding — IN-19/IN-20 dedup-semantics claim fixes", () => {
  it("infrastructure_status never claims unconditional completeness over its capped messages[] preview", () => {
    const desc = MCP_TOOLS.find((t) => t.name === "infrastructure_status")!.description;
    expect(desc, "infrastructure_status still claims 'you never miss one' over a LIMIT-5 view").not.toMatch(/you never miss one/i);
  });

  it("contact_operator's dedup-retry prose never frames the (body,urgency) collapse as unconditionally 'safe'", () => {
    const toolsDesc = MCP_TOOLS.find((t) => t.name === "contact_operator")!.description;
    expect(toolsDesc, "mcp/tools.ts's contact_operator still says 'is safe'").not.toMatch(/within an hour is safe/i);
    expect(openapiYaml, "openapi.yaml's contact_operator still says 'is safe'").not.toMatch(/within an hour is safe/i);
  });

  it("contact_operator's dedup-retry prose discloses it is a TEXT match, not an intent match (a same-wording NEW message also collapses)", () => {
    const toolsDesc = MCP_TOOLS.find((t) => t.name === "contact_operator")!.description;
    expect(toolsDesc, "mcp/tools.ts's contact_operator doesn't disclose the text-vs-intent limitation").toMatch(/text match, not an intent match/i);
  });
});
