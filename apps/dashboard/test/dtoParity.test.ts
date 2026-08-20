import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// C-M1 (docs/adversarial/sweep-completeness-pass-2026-08-17.md) — this app's
// api/types.ts is a NINTH hand-written copy of the platform's tool/endpoint
// contract, and the only one that is machine-consumed (this app compiles
// against it) rather than merely read. types.ts's own header says "Keep in
// sync by hand; moving them into packages/shared ... is outside this
// build's scope" — that migration stays deferred (YAGNI, CLAUDE.md rule i:
// no speculative abstraction beyond the current phase), but nothing
// mechanically checked the hand-copy against the platform interfaces it
// mirrors. This is that check: a per-interface field-set diff against the
// REAL apps/platform/src/engine/*.ts source, extending the class sweep's G1
// (apps/platform/test/tool-claim-binding.test.ts) to this file, which G1's
// toolName -> [platformSourceFile, interfaceName] map cannot see (it only
// walks MCP_TOOLS).
const here = dirname(fileURLToPath(import.meta.url));
const platformEngineDir = join(here, "..", "..", "platform", "src", "engine");

/** Same balanced-block + depth-1-line extraction as tool-claim-binding.test.ts's
 * declaredProps, scoped to plain `export interface` (every mirrored type here
 * is a plain interface, no unions to support). */
function declaredProps(src: string, name: string): string[] {
  const ifaceRe = new RegExp(`export interface ${name}\\b[^{]*\\{`);
  const match = ifaceRe.exec(src);
  if (!match) throw new Error(`declaredProps: no 'export interface ${name}' found`);
  const openIdx = match.index + match[0].length - 1;
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) throw new Error(`declaredProps: unbalanced braces for ${name}`);
  const inner = src.slice(openIdx + 1, closeIdx);
  const props = new Set<string>();
  let lineDepth = 0;
  for (const rawLine of inner.split("\n")) {
    const line = rawLine.trim();
    if (lineDepth === 0 && !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/**")) {
      const m = /^(\w+)\??:/.exec(line);
      if (m) props.add(m[1]!);
    }
    lineDepth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
  }
  return [...props];
}

interface ParityCase {
  dashboardName: string;
  platformFile: string;
  platformName: string;
}

// The class sweep's OUT column ("12 of 18 mirrored interfaces are clean")
// plus MailboxHealthReport (was 1 of the 2 DRIFTED — now fixed, C-M2) — the
// interfaces this file's own header claims are a faithful hand-mirror of a
// same-named platform interface. `InfrastructureStatus` is DELIBERATELY
// EXCLUDED: it is a narrower client VIEW by design (this app's SetupPage
// checklist only ever needed domains/mailboxes/mailboxHealth/sendReady), not
// a claimed full mirror — W-M5's fix routes tenant_messages rendering
// through the dedicated GET /messages endpoint instead of this field, so
// requiring full parity here would be inventing scope this build doesn't use
// (CLAUDE.md rule i). The four "no same-named server interface" mirrors
// (SignupResult, LoginRequestResult, LoginConsumeResult, RotateTokenResult,
// ReplyResult, RevConflictBody, CheckoutResult) are wire shapes with no
// platform-side named counterpart to diff against — out of this guard's
// reach by construction, same as G1's `extra` literal-field tools.
const PARITY_CASES: ParityCase[] = [
  { dashboardName: "AccountSummary", platformFile: "reporting.ts", platformName: "AccountSummary" },
  { dashboardName: "EventCounts", platformFile: "reporting.ts", platformName: "EventCounts" },
  { dashboardName: "DeliverabilityAudit", platformFile: "reporting.ts", platformName: "DeliverabilityAudit" },
  { dashboardName: "DeliverabilitySummary", platformFile: "reporting.ts", platformName: "DeliverabilitySummary" },
  { dashboardName: "InboxRow", platformFile: "inbox.ts", platformName: "InboxRow" },
  { dashboardName: "InboxPage", platformFile: "inbox.ts", platformName: "InboxPage" },
  { dashboardName: "ActivityItem", platformFile: "activity.ts", platformName: "ActivityItem" },
  { dashboardName: "ActivityPage", platformFile: "activity.ts", platformName: "ActivityPage" },
  { dashboardName: "DashboardViewSummary", platformFile: "dashboard-views.ts", platformName: "DashboardViewSummary" },
  { dashboardName: "DashboardViewDetail", platformFile: "dashboard-views.ts", platformName: "DashboardViewDetail" },
  { dashboardName: "CampaignListItem", platformFile: "campaigns.ts", platformName: "CampaignListItem" },
  { dashboardName: "ThreadDetail", platformFile: "threads.ts", platformName: "ThreadDetail" },
  { dashboardName: "ThreadMessage", platformFile: "threads.ts", platformName: "ThreadMessage" },
  { dashboardName: "MailboxHealthReport", platformFile: "infrastructure-status.ts", platformName: "MailboxHealthReport" },
  { dashboardName: "TenantMessage", platformFile: "tenant-messages.ts", platformName: "TenantMessage" },
  { dashboardName: "MessageListPage", platformFile: "tenant-messages.ts", platformName: "MessageListPage" },
  { dashboardName: "AckMessageResult", platformFile: "tenant-messages.ts", platformName: "AckMessageResult" },
];

/**
 * Types in `api/types.ts` that are deliberately NOT diffed, each with the reason
 * it is out of this guard's reach. NB2 (docs/adversarial/wave-a-trains-3-4-gate-
 * 2026-08-20.md): the companion assertion below forces every export to be either
 * a PARITY_CASE or a named member here, so an 18th hand-mirrored DTO cannot land
 * unguarded — which is exactly the drift C-M1 was opened for.
 */
const NOT_MIRRORED: Readonly<Record<string, string>> = {
  // A narrower client VIEW by design, not a claimed full mirror: SetupPage only
  // needs domains/mailboxes/mailboxHealth/sendReady, and W-M5 routes message
  // rendering through GET /messages rather than widening this (CLAUDE.md rule i).
  InfrastructureStatus: "deliberate narrower client view",
  // Wire shapes with no same-named platform interface to diff against — the same
  // reach limit as G1's literal-field `extra` tools.
  SignupResult: "no same-named server interface",
  LoginRequestResult: "no same-named server interface",
  LoginConsumeResult: "no same-named server interface",
  RotateTokenResult: "no same-named server interface",
  ReplyResult: "no same-named server interface",
  RevConflictBody: "no same-named server interface",
  CheckoutResult: "no same-named server interface",
  // A string-literal union, not a mirrored object shape.
  ActivationSurfaceState: "string-literal union, not a mirror",
};

describe("dashboard DTO <-> platform interface field parity (C-M1)", () => {
  // THE ADDITIVE HALF (NB2). Without this, PARITY_CASES is a hand-maintained
  // list and a newly hand-mirrored DTO simply never gets diffed — the guard
  // stays green while the exact drift it exists to catch walks in. Mirrors its
  // sibling G1's "tool 29 can't land without a map entry"
  // (apps/platform/test/tool-claim-binding.test.ts).
  //
  // When this reddens: either add a PARITY_CASE (if the new type mirrors a
  // platform interface) or add it to NOT_MIRRORED WITH THE REASON. Do not
  // delete the assertion.
  it("every exported type in api/types.ts is either diffed or a NAMED exclusion (an 18th DTO can't land unguarded)", async () => {
    const dashboardSrc = await readFile(join(here, "..", "src", "api", "types.ts"), "utf8");
    const exported = [...dashboardSrc.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]!);
    expect(exported.length, "types.ts exports nothing — the regex or the file moved").toBeGreaterThan(0);

    const covered = new Set(PARITY_CASES.map((c) => c.dashboardName));
    const unaccounted = exported.filter((name) => !covered.has(name) && !(name in NOT_MIRRORED));
    expect(
      unaccounted,
      `add a PARITY_CASE for these, or name them in NOT_MIRRORED with a reason: ${unaccounted.join(", ")}`,
    ).toEqual([]);

    // The exclusion list must not rot either: a name that no longer exists is a
    // stale excuse that would silently cover a future type of the same name.
    const stale = Object.keys(NOT_MIRRORED).filter((name) => !exported.includes(name));
    expect(stale, `NOT_MIRRORED names types that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });

  it.each(PARITY_CASES)("api/types.ts's $dashboardName has the SAME fields as engine/$platformFile's $platformName", async ({ dashboardName, platformFile, platformName }) => {
    const dashboardSrc = await readFile(join(here, "..", "src", "api", "types.ts"), "utf8");
    const platformSrc = await readFile(join(platformEngineDir, platformFile), "utf8");
    const dashboardFields = declaredProps(dashboardSrc, dashboardName).sort();
    const platformFields = declaredProps(platformSrc, platformName).sort();
    expect(dashboardFields, `${dashboardName} field mismatch vs platform ${platformName}`).toEqual(platformFields);
  });
});
