import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { insertEnforcementActionIfNew } from "../src/admin/db.js";
import { newId } from "../src/schema.js";

// IN-15, docs/adversarial/class-sweep-dedup-semantics-2026-08-17.md.
//
// `enforcement_actions` is keyed `UNIQUE(tenant_id, action)` and written with
// INSERT OR IGNORE, so a tenant terminated, reinstated, then re-terminated for a
// DIFFERENT AUP reason recorded only the FIRST reason/evidence. The second one —
// the abuse that actually got them terminated the second time — left no trace
// anywhere. This is the platform's abuse audit trail.
//
// SCOPED TO THE DATA LOSS, not the key. The `UNIQUE(tenant_id, action)`
// constraint stays: `countTerminatedTenants` (admin/ops-sweep.ts's digest) reads
// one-row-per-terminated-tenant off it, and dropping a constraint in SQLite
// needs a full table rebuild — which none of this repo's 18 migrations has ever
// done, so making one the precedent for this is a bigger decision than the bug.
// Accumulating into the existing row closes the loss with no migration at all.
//
// `enforcementLogged` KEEPS ITS EXACT MEANING — "a new row was created" — so the
// admin-terminate idempotency test's `false` on a repeat still holds and the
// audit table still cannot be grown by an admin double-clicking terminate.

async function terminateOnce(tenantId: string, reason: string, ts: number): Promise<boolean> {
  return insertEnforcementActionIfNew(env, {
    id: newId("enf"),
    tenantId,
    action: "TERMINATE",
    reason,
    evidence: { note: reason },
    ts,
  });
}

async function enforcementRow(tenantId: string) {
  return env.DB.prepare(`SELECT reason, evidence_json, ts FROM enforcement_actions WHERE tenant_id = ?`)
    .bind(tenantId)
    .first<{ reason: string; evidence_json: string; ts: number }>();
}

async function rowCount(tenantId: string): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) as n FROM enforcement_actions WHERE tenant_id = ?`)
    .bind(tenantId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

describe("IN-15 — a re-termination for a DIFFERENT reason must not vanish", () => {
  it("keeps the original row and records the later reason on it", async () => {
    const tenantId = `ten_enf_${crypto.randomUUID()}`;

    expect(await terminateOnce(tenantId, "spam complaints", 1000)).toBe(true);
    expect(await terminateOnce(tenantId, "phishing content", 2000)).toBe(false);

    // Still ONE row — the digest count and the constraint are untouched.
    expect(await rowCount(tenantId)).toBe(1);

    const row = await enforcementRow(tenantId);
    // The ORIGINAL enforcement stays canonical...
    expect(row?.reason).toBe("spam complaints");
    expect(row?.ts).toBe(1000);
    // ...and the later one is now recoverable instead of destroyed.
    const evidence = JSON.parse(row!.evidence_json) as { subsequentActions?: { reason: string; ts: number }[] };
    expect(evidence.subsequentActions).toHaveLength(1);
    expect(evidence.subsequentActions![0]!.reason).toBe("phishing content");
    expect(evidence.subsequentActions![0]!.ts).toBe(2000);
  });

  it("does not grow on a repeat of the SAME reason (an admin double-click)", async () => {
    const tenantId = `ten_enf_${crypto.randomUUID()}`;

    await terminateOnce(tenantId, "spam complaints", 1000);
    await terminateOnce(tenantId, "spam complaints", 2000);
    await terminateOnce(tenantId, "spam complaints", 3000);

    const row = await enforcementRow(tenantId);
    const evidence = JSON.parse(row!.evidence_json) as { subsequentActions?: unknown[] };
    expect(evidence.subsequentActions ?? []).toHaveLength(0);
  });

  it("records each DISTINCT later reason once, in order", async () => {
    const tenantId = `ten_enf_${crypto.randomUUID()}`;

    await terminateOnce(tenantId, "spam complaints", 1000);
    await terminateOnce(tenantId, "phishing content", 2000);
    await terminateOnce(tenantId, "phishing content", 2500); // repeat of the latest — no growth
    await terminateOnce(tenantId, "malware links", 3000);

    const row = await enforcementRow(tenantId);
    const evidence = JSON.parse(row!.evidence_json) as { subsequentActions?: { reason: string }[] };
    expect(evidence.subsequentActions?.map((a) => a.reason)).toEqual(["phishing content", "malware links"]);
  });

  it("leaves a first-ever enforcement's evidence exactly as passed", async () => {
    const tenantId = `ten_enf_${crypto.randomUUID()}`;
    await terminateOnce(tenantId, "spam complaints", 1000);

    const row = await enforcementRow(tenantId);
    expect(JSON.parse(row!.evidence_json)).toEqual({ note: "spam complaints" });
  });
});
