import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  customerProgressAgentCheckName,
  customerProgressOperatorCheckName,
} from "../src/admin/watchtower-alerts.js";
import { reconcileAlerts, readReportedCheckNames, sendPipelineChecks } from "../src/admin/watchtower.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import type { TenantOpsSummary } from "../src/engine/ops-summary.js";

// I14 — the two `customer_progress_*` checks (design §7.11), riding the SAME
// opsSummary fan-out via `owedSignals` (§7.10.3's minimized payload) +
// `lastAgentActivityAgeMs` (§7.10.2). `watchtower-policy.test.ts`'s
// completeness map is the OTHER half of this increment's proof — it fails
// until both names are classified there.

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

const TENANT_ID = "ten_progress_x";
const OPERATOR_NAME = customerProgressOperatorCheckName(TENANT_ID);
const AGENT_NAME = customerProgressAgentCheckName(TENANT_ID);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM watchtower_state").run();
  await env.DB.prepare("DELETE FROM watchtower_cursor").run();
});

/** A summary carrying only what `sendPipelineChecks` reads. `owedReasons` is
 *  loosened to `string[]` — fixtures name reasons as plain strings, and the
 *  full literal union adds nothing a test here needs to enforce. */
function summaryWith(
  overrides: Partial<Omit<TenantOpsSummary["sendPipeline"], "owedReasons">> & { owedReasons?: string[] },
  topLevel: Partial<TenantOpsSummary> = {},
): TenantOpsSummary {
  return {
    brand: "Progress Co",
    plan: "managed",
    status: "active",
    billingState: "active",
    sendPipeline: {
      activated: true,
      dueNonDemoPendingSends: 0,
      eligibleMailboxes: 1,
      agingPendingPushes: [],
      agingPendingDomains: [],
      provisionedDomains: [],
      credentialPushes: [],
      owedReasons: [],
      owedCount: 0,
      oldestOwedSinceMs: null,
      anyOwedWaitingOnOperator: false,
      lastAgentActivityAgeMs: null,
      ...overrides,
    },
    ...topLevel,
  } as unknown as TenantOpsSummary;
}

function checks(summary: TenantOpsSummary, reported: ReadonlySet<string> = new Set()) {
  return sendPipelineChecks(TENANT_ID, summary, reported, { stallMs: 24 * HOUR, owedMaxMs: 48 * HOUR });
}

describe("I14 — the unhealthy predicate", () => {
  it("owed but neither disjunct crossed -> healthy (no result at all)", async () => {
    const summary = summaryWith({
      owedReasons: ["domain_dns_incomplete"],
      owedCount: 1,
      oldestOwedSinceMs: 1 * HOUR,
      lastAgentActivityAgeMs: 1 * HOUR,
    });
    expect(checks(summary)).toEqual([]);
  });

  it("owedCount === 0 -> never unhealthy, whatever the ages read", async () => {
    const summary = summaryWith({ owedCount: 0, oldestOwedSinceMs: 999 * HOUR, lastAgentActivityAgeMs: 999 * HOUR });
    expect(checks(summary)).toEqual([]);
  });

  it("agent silent past the stall bound -> unhealthy", async () => {
    const summary = summaryWith({
      owedReasons: ["domain_dns_incomplete"],
      owedCount: 1,
      oldestOwedSinceMs: 1 * HOUR,
      lastAgentActivityAgeMs: 25 * HOUR,
    });
    expect(checks(summary).map((c) => c.name)).toEqual([AGENT_NAME]);
  });

  it("oldest owed step past the owed-max bound -> unhealthy, even with recent agent activity", async () => {
    const summary = summaryWith({
      owedReasons: ["domain_dns_incomplete"],
      owedCount: 1,
      oldestOwedSinceMs: 49 * HOUR,
      lastAgentActivityAgeMs: 1 * HOUR,
    });
    expect(checks(summary).map((c) => c.name)).toEqual([AGENT_NAME]);
  });

  it("a NULL lastAgentActivityAgeMs is skipped, not treated as infinitely stale — the owed-age disjunct alone must carry it", async () => {
    const summary = summaryWith({
      owedReasons: ["domain_dns_incomplete"],
      owedCount: 1,
      oldestOwedSinceMs: 1 * HOUR,
      lastAgentActivityAgeMs: null,
    });
    expect(checks(summary)).toEqual([]);
  });
});

describe("I14 — blame in the name", () => {
  it("any operator-blamed owed step names the OPERATOR check (email channel)", async () => {
    const summary = summaryWith({
      owedReasons: ["billed_quantity_drift"],
      owedCount: 1,
      oldestOwedSinceMs: 49 * HOUR,
      anyOwedWaitingOnOperator: true,
    });
    const result = checks(summary);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe(OPERATOR_NAME);
    expect(result[0]!.healthy).toBe(false);
  });

  it("no operator-blamed step names the AGENT check (digest channel)", async () => {
    const summary = summaryWith({
      owedReasons: ["domain_dns_incomplete"],
      owedCount: 1,
      oldestOwedSinceMs: 49 * HOUR,
      anyOwedWaitingOnOperator: false,
    });
    const result = checks(summary);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe(AGENT_NAME);
  });
});

describe("I14 — scope", () => {
  const stalledOverrides = { owedReasons: ["domain_dns_incomplete"], owedCount: 1, oldestOwedSinceMs: 49 * HOUR };

  it("an UNACTIVATED tenant is out of scope", async () => {
    expect(checks(summaryWith({ ...stalledOverrides, activated: false }))).toEqual([]);
  });

  it("a non-paid plan is out of scope", async () => {
    expect(checks(summaryWith(stalledOverrides, { plan: "demo" }))).toEqual([]);
  });

  it("a lifecycle-frozen tenant (status=suspended) is out of scope", async () => {
    expect(checks(summaryWith(stalledOverrides, { status: "suspended" }))).toEqual([]);
  });

  it("a lifecycle-frozen tenant (billing_state=canceled) is out of scope", async () => {
    expect(checks(summaryWith(stalledOverrides, { billingState: "canceled" }))).toEqual([]);
  });

  it("a tenant leaving scope while previously reported clears via no_longer_applicable", async () => {
    const reported = new Set([OPERATOR_NAME]);
    const result = checks(summaryWith({ ...stalledOverrides, anyOwedWaitingOnOperator: true }, { status: "suspended" }), reported);
    expect(result).toEqual([
      { name: OPERATOR_NAME, healthy: true, basis: "no_longer_applicable", detail: expect.any(String) },
    ]);
  });
});

describe("I14 — end-to-end: watchtower-policy.test.ts's completeness map is closed by this increment", () => {
  it("a stalled tenant alerts on the email channel through the real derivation + reconcileAlerts", async () => {
    const mailer = new SandboxOpsMailer();
    const summary = summaryWith({
      owedReasons: ["billed_quantity_drift"],
      owedCount: 1,
      oldestOwedSinceMs: 49 * HOUR,
      anyOwedWaitingOnOperator: true,
    });

    await reconcileAlerts(env, mailer, checks(summary, await readReportedCheckNames(env)), T0);
    const outcomes = await reconcileAlerts(env, mailer, checks(summary, await readReportedCheckNames(env)), T0 + 300_000);

    expect(outcomes).toEqual([{ name: OPERATOR_NAME, action: "alerted", emailSent: true, why: "sent" }]);
    expect(mailer.sent[0]!.subject).toContain("Customer progress (operator-blocked)");
  });

  it("the sibling stall (no operator blame) never emails through the real derivation", async () => {
    const mailer = new SandboxOpsMailer();
    const summary = summaryWith({
      owedReasons: ["domain_dns_incomplete"],
      owedCount: 1,
      oldestOwedSinceMs: 49 * HOUR,
      anyOwedWaitingOnOperator: false,
    });

    await reconcileAlerts(env, mailer, checks(summary, await readReportedCheckNames(env)), T0);
    const outcomes = await reconcileAlerts(env, mailer, checks(summary, await readReportedCheckNames(env)), T0 + 300_000);

    expect(outcomes).toEqual([{ name: AGENT_NAME, action: "alerted", emailSent: false, why: "digest_only" }]);
    expect(mailer.sent).toEqual([]);
  });
});
