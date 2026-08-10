import { describe, expect, it } from "vitest";
import { MCP_TOOLS } from "../src/mcp/tools.js";

// Claim-surface tool-count guard. This class has burned buyer-agent
// evaluations twice before (19→21, then 21→24) — a public page/manifest kept
// saying the OLD count after the registry grew (see docs/adversarial/
// fully-live-reframe-2026-07-19.md and wave-integration-review-2026-07-22.md
// for the prior incidents). The quantity-billing migration added a 25th tool
// (`remove_mailboxes`); the msgchannel increment 3 build (list_messages/
// ack_message) added a 26th and 27th. This guard makes the NEXT tool
// addition fail loudly here instead of shipping a stale count to a
// buyer-agent's tools/list cross-check.
//
// Raw-text imports (Vite `?raw`, resolved at bundle time) — the workers-pool
// test runtime has no general filesystem access, so a runtime readFileSync
// against a source path 404s (see brand-copy-guard.test.ts). `?raw` bakes
// each file's text in as a string; cross-package reads up to the repo root
// work the same way (verified: apps/platform/test -> ../../../<path>).
import rootReadme from "../../../README.md?raw";
import agentsMd from "../../../AGENTS.md?raw";
import serverJson from "../../../server.json?raw";
import llmsInstall from "../../../llms-install.md?raw";
import handoffMd from "../../../HANDOFF.md?raw";
import pluginJson from "../../../.claude-plugin/plugin.json?raw";
import dashboardSetupPage from "../../dashboard/src/pages/SetupPage.tsx?raw";

import siteIndex from "../../../site/index.html?raw";
import ogImageSvg from "../../../site/assets/og-image.svg?raw";
import serverCardJson from "../../../site/.well-known/mcp/server-card.json?raw";
import siteLlmsTxt from "../../../site/llms.txt?raw";
import forAgents from "../../../site/for-agents.html?raw";
import agentEvaluation from "../../../site/agent-evaluation.md?raw";
import guideMcpToolCount from "../../../site/guide-mcp-tool-count.html?raw";
import guideClaudeCode from "../../../site/guide-cold-email-operation-claude-code.html?raw";
import guideCursor from "../../../site/guide-cold-email-operation-cursor.html?raw";
import guideCodex from "../../../site/guide-cold-email-operation-codex.html?raw";
import guideMcpColdEmail from "../../../site/guide-mcp-cold-email.html?raw";
import connectHtml from "../../../site/connect.html?raw";
import guideWithAiAgent from "../../../site/guide-cold-email-with-ai-agent.html?raw";
import compareSalesforge from "../../../site/compare-vs-salesforge.html?raw";
import securityHtml from "../../../site/security.html?raw";
import compareSmartleadInstantly from "../../../site/compare-vs-smartlead-instantly.html?raw";
import docsHtml from "../../../site/docs.html?raw";
import compareAgentmail from "../../../site/compare-vs-agentmail.html?raw";
import openapiYaml from "../../../site/openapi.yaml?raw";
import guideInfraVsSending from "../../../site/guide-infrastructure-vs-sending-platform.html?raw";
import siteReadme from "../../../site/README.md?raw";

const CLAIM_SURFACES: ReadonlyArray<readonly [string, string]> = [
  ["README.md", rootReadme],
  ["AGENTS.md", agentsMd],
  ["server.json", serverJson],
  ["llms-install.md", llmsInstall],
  ["HANDOFF.md", handoffMd],
  [".claude-plugin/plugin.json", pluginJson],
  ["apps/dashboard/src/pages/SetupPage.tsx", dashboardSetupPage],
  ["site/index.html", siteIndex],
  ["site/assets/og-image.svg", ogImageSvg],
  ["site/.well-known/mcp/server-card.json", serverCardJson],
  ["site/llms.txt", siteLlmsTxt],
  ["site/for-agents.html", forAgents],
  ["site/agent-evaluation.md", agentEvaluation],
  ["site/guide-mcp-tool-count.html", guideMcpToolCount],
  ["site/guide-cold-email-operation-claude-code.html", guideClaudeCode],
  ["site/guide-cold-email-operation-cursor.html", guideCursor],
  ["site/guide-cold-email-operation-codex.html", guideCodex],
  ["site/guide-mcp-cold-email.html", guideMcpColdEmail],
  ["site/connect.html", connectHtml],
  ["site/guide-cold-email-with-ai-agent.html", guideWithAiAgent],
  ["site/compare-vs-salesforge.html", compareSalesforge],
  ["site/security.html", securityHtml],
  ["site/compare-vs-smartlead-instantly.html", compareSmartleadInstantly],
  ["site/docs.html", docsHtml],
  ["site/compare-vs-agentmail.html", compareAgentmail],
  ["site/openapi.yaml", openapiYaml],
  ["site/guide-infrastructure-vs-sending-platform.html", guideInfraVsSending],
  ["site/README.md", siteReadme],
];

// Surfaces that positively claim the total count in prose (used for the
// "the CURRENT count actually appears" half of the guard — absence-of-stale
// alone doesn't prove the fix landed, it could just mean the number was
// deleted entirely).
const SURFACES_THAT_STATE_THE_COUNT = new Set([
  "README.md",
  "AGENTS.md",
  "server.json",
  "llms-install.md",
  "HANDOFF.md",
  ".claude-plugin/plugin.json",
  "apps/dashboard/src/pages/SetupPage.tsx",
  "site/index.html",
  "site/assets/og-image.svg",
  "site/.well-known/mcp/server-card.json",
  "site/llms.txt",
  "site/for-agents.html",
  "site/agent-evaluation.md",
  "site/guide-mcp-tool-count.html",
  "site/guide-cold-email-operation-claude-code.html",
  "site/guide-cold-email-operation-cursor.html",
  "site/guide-cold-email-operation-codex.html",
  "site/guide-mcp-cold-email.html",
  "site/connect.html",
  "site/compare-vs-salesforge.html",
  "site/security.html",
  "site/compare-vs-agentmail.html",
  "site/guide-cold-email-with-ai-agent.html",
  "site/compare-vs-smartlead-instantly.html",
  "site/docs.html",
  "site/openapi.yaml",
  "site/guide-infrastructure-vs-sending-platform.html",
  "site/README.md",
]);

/**
 * Does `text` claim the tool count is exactly `n`? A claim is `n` (word-
 * boundaried, so "24" never matches inside "2024" or "$249") sitting within
 * ~30 characters BEFORE "tool"/"intent" (the shape of every claim in this
 * class: "24 tools", "24-tool surface", "all 24 tools", "24 intent-level
 * tools", "the 24 intents", "24 curated\n    intents" — YAML-wrapped prose is
 * whitespace-normalized first so a mid-sentence line break can't hide a
 * match).
 *
 * Deliberately targets SPECIFIC numbers (the historically-retired counts
 * 17/19/21/24, and the current 25) rather than flagging "any number near the
 * word tool" — this site is prose-dense with legitimate unrelated numbers
 * beside "tool" (competitor counts like "116+ tools"/"31-38 tools", HTTP
 * status codes, dates, prices), and a generic parser false-positives on all
 * of them. This mirrors how the repo's own prior adversary reviews checked
 * this class (docs/adversarial/wave-integration-review-2026-07-22.md:35:
 * "still claims 21/19/17" — a fixed list of retired numbers, not a generic
 * any-number scan).
 *
 * Two known layouts put the number AFTER "tool"/"intent" instead, which a
 * generic reverse-direction window would false-positive on elsewhere in this
 * prose (e.g. HANDOFF.md's "...intent log before real GA sending volume
 * (07-19 ruling..." reads as a false "19" claim under a wide reverse window
 * — the word "intent" and the date "07-19" are unrelated but sit within a
 * generic window of each other in a long bullet). Both are matched as exact
 * literal phrases instead of a generic reverse scan:
 *   - "<tool surface> ... kept to N" (guide-mcp-tool-count.html)
 *   - a bare count in its own `<td>` with the "Reported tool count" header a
 *     few rows above (compare-vs-smartlead-instantly.html)
 */
function claimsToolCountOf(text: string, n: number): boolean {
  const flat = text.replace(/\s+/g, " ");
  // (?<!-) excludes a date suffix like "2026-07-21" or "07-21" — this corpus
  // never hyphenates a number ONTO a tool-count claim from the left (only
  // "24-tool" style, hyphen on the right, which still matches fine).
  const forwardRe = new RegExp(`(?<!-)\\b${n}\\b.{0,30}?\\b(tool|tools|intent|intents)\\b`, "i");
  if (forwardRe.test(flat)) return true;

  const keptToRe = new RegExp(`kept to ${n}\\b`, "i");
  if (keptToRe.test(flat)) return true;

  const lines = text.split("\n");
  const bareCountCellRe = new RegExp(`^\\s*<td>${n},`);
  for (let i = 0; i < lines.length; i++) {
    if (bareCountCellRe.test(lines[i]!)) {
      const precedingWindow = lines.slice(Math.max(0, i - 5), i).join("\n").toLowerCase();
      if (/tool count/.test(precedingWindow)) return true;
    }
  }
  return false;
}

// Every total-tool-count this claim class has shipped historically (see
// docs/adversarial/claim-surface-round2-2026-07-20.md, fully-live-reframe-
// 2026-07-19.md, wave-integration-review-2026-07-22.md, toolcount-25-sweep-
// review-2026-07-27.md) plus the current count — msgchannel increment 3's
// list_messages/ack_message brought the registry to 27.
const RETIRED_TOOL_COUNTS = [17, 19, 21, 24, 25] as const;

describe("claim-surface tool-count guard", () => {
  const currentCount = MCP_TOOLS.length;

  it("the live MCP registry currently reports 27 tools (sanity anchor for this guard)", () => {
    // If this ever fails, every assertion below needs re-grounding against
    // the new count before trusting it — see apps/platform/test/mcp.test.ts
    // for the live-endpoint equivalent of this same assertion.
    expect(currentCount).toBe(27);
  });

  it.each(CLAIM_SURFACES)("%s never claims a retired tool count (17/19/21/24)", (label, text) => {
    const stale = RETIRED_TOOL_COUNTS.filter((n) => claimsToolCountOf(text, n));
    expect(stale, `${label} still claims retired tool count(s): ${stale.join(", ")}`).toEqual([]);
  });

  it.each(CLAIM_SURFACES)("%s never uses a spelled-out stale cardinal (e.g. 'Twenty-four')", (label, text) => {
    // Digit-based claims are covered by claimsToolCountOf above; this repo
    // has twice shipped a spelled-out straggler after a numeric sweep (see
    // docs/adversarial/fully-live-reframe-2026-07-19.md) because a plain "24"
    // grep doesn't catch "Twenty-four".
    expect(text, `${label} contains a stale spelled-out cardinal`).not.toMatch(/twenty-?four/i);
  });

  it.each([...SURFACES_THAT_STATE_THE_COUNT])("%s states the CURRENT tool count somewhere", (label) => {
    const text = CLAIM_SURFACES.find(([l]) => l === label)![1];
    expect(claimsToolCountOf(text, currentCount), `${label} should mention ${currentCount} near "tool"/"intent" but doesn't`).toBe(true);
  });

  it("server-card.json's enumerated tools[] includes remove_mailboxes", () => {
    expect(serverCardJson).toContain('"name": "remove_mailboxes"');
  });

  it("README.md's tool table includes remove_mailboxes", () => {
    expect(rootReadme).toContain("`remove_mailboxes`");
  });

  it("AGENTS.md's tool table includes remove_mailboxes", () => {
    expect(agentsMd).toContain("`remove_mailboxes`");
  });

  it("guide-mcp-cold-email.html's full schema reference includes remove_mailboxes", () => {
    expect(guideMcpColdEmail).toContain("<code>remove_mailboxes</code>");
  });

  // msgchannel increment 3 (list_messages/ack_message) — the same per-tool
  // doc-surface checks the quantity-billing migration's remove_mailboxes got
  // above, so a count-only bump can never ship without the tool ALSO landing
  // in the docs that enumerate it.
  it("server-card.json's enumerated tools[] includes list_messages and ack_message", () => {
    expect(serverCardJson).toContain('"name": "list_messages"');
    expect(serverCardJson).toContain('"name": "ack_message"');
  });

  it("README.md's tool table includes list_messages and ack_message", () => {
    expect(rootReadme).toContain("`list_messages`");
    expect(rootReadme).toContain("`ack_message`");
  });

  it("AGENTS.md's tool table includes list_messages and ack_message", () => {
    expect(agentsMd).toContain("`list_messages`");
    expect(agentsMd).toContain("`ack_message`");
  });

  it("guide-mcp-cold-email.html's full schema reference includes list_messages and ack_message", () => {
    expect(guideMcpColdEmail).toContain("<code>list_messages</code>");
    expect(guideMcpColdEmail).toContain("<code>ack_message</code>");
  });
});
