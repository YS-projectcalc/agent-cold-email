import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { adminApi, api, TEST_ADMIN_TOKEN, TEST_SDN_INGEST_TOKEN } from "./helpers.js";
import { getSdnListMeta } from "../src/ofac/sdn-list.js";
import { SDN_INGEST_MAX_BYTES } from "../src/validate.js";
import sdnMalformedCsv from "./fixtures/ofac/sdn-malformed.csv?raw";
import sdnValidCsv from "./fixtures/ofac/sdn-valid.csv?raw"; // 4 entries — below the floor
import sdnValidLargeCsv from "./fixtures/ofac/sdn-valid-large.csv?raw"; // 5001 entries — floor-satisfying

interface IngestResponse {
  ok: boolean;
  reason: string;
  entryCount?: number;
  listVersion?: string;
  error?: string;
}

/** Full control over the Authorization header — `token === undefined` sends
 * NO Authorization header at all (unlike adminApi()'s `?? TEST_ADMIN_TOKEN`
 * fallback, which can't express "absent"). */
async function postCsv(csv: string, token?: string) {
  const headers: Record<string, string> = { "content-type": "text/csv" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return api<IngestResponse>("/admin/sdn/ingest", { method: "POST", headers, body: csv });
}

describe("POST /admin/sdn/ingest — G1a droplet-relay ingest endpoint", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM sdn_entries`).run();
    await env.DB.prepare(`DELETE FROM sdn_list_meta`).run();
    await env.DB.prepare(`DELETE FROM sdn_alert_state`).run();
  });

  describe("auth — the SDN_INGEST_TOKEN carve-out (require-admin-auth.ts)", () => {
    it("401s with no Authorization header", async () => {
      const res = await postCsv(sdnValidLargeCsv);
      expect(res.status).toBe(401);
    });

    it("401s with a wrong/garbage token", async () => {
      const res = await postCsv(sdnValidLargeCsv, "not-the-ingest-token");
      expect(res.status).toBe(401);
    });

    it("200s with the correct SDN_INGEST_TOKEN", async () => {
      const res = await postCsv(sdnValidLargeCsv, TEST_SDN_INGEST_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.entryCount).toBe(5001);
    });

    it("ALSO 200s with the regular ADMIN_TOKEN (additive, not a replacement)", async () => {
      const res = await postCsv(sdnValidLargeCsv, TEST_ADMIN_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    // REGRESSION guard for the Hono wildcard-collision class (agent memory
    // hono-subapp-wildcard-middleware-gotcha): "/admin/*" matches every path
    // under this prefix in ONE composed router regardless of which route file
    // registers it — proving the NEW route's own credential doesn't leak
    // power onto a SIBLING /admin/* route is exactly the check that class of
    // bug would otherwise miss (a green test file for the new route ALONE
    // would not catch this).
    it("the narrow SDN_INGEST_TOKEN does NOT work on a DIFFERENT /admin/* route", async () => {
      const res = await adminApi("/admin/screening/reviews", { adminToken: TEST_SDN_INGEST_TOKEN });
      expect(res.status).toBe(401);
    });

    // Adversary "method over-grant" note (docs/adversarial/
    // sdn-relay-review-2026-07-24.md) — the carve-out is pinned to POST, so
    // the SDN token is rejected at the AUTH layer for any other verb on this
    // SAME path, not merely 404'd by route absence (Hono's `.use()` matches
    // by path only, not method, so without the pin this would have passed
    // the carve-out and only failed later for lack of a GET handler).
    it("the SDN_INGEST_TOKEN is rejected (401) for a non-POST method on this SAME path — the carve-out is pinned to POST", async () => {
      const res = await api("/admin/sdn/ingest", { method: "GET", headers: { authorization: `Bearer ${TEST_SDN_INGEST_TOKEN}` } });
      expect(res.status).toBe(401);
    });

    it("the regular ADMIN_TOKEN still gates every OTHER /admin/* route exactly as before (no regression)", async () => {
      const res = await adminApi("/admin/screening/reviews");
      expect(res.status).toBe(200);
    });
  });

  describe("body-size cap (413) before the CSV is parsed", () => {
    it("rejects an over-cap body with 413", async () => {
      const oversized = "x".repeat(SDN_INGEST_MAX_BYTES + 1024);
      const res = await postCsv(oversized, TEST_SDN_INGEST_TOKEN);
      expect(res.status).toBe(413);
    }, 30_000);
  });

  describe("end-to-end: parse/floor/swap outcomes surface as the right HTTP status", () => {
    it("200s + swaps in a floor-satisfying valid CSV", async () => {
      const res = await postCsv(sdnValidLargeCsv, TEST_SDN_INGEST_TOKEN);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, reason: "ingested", entryCount: 5001 });
      const meta = await getSdnListMeta(env);
      expect(meta?.entryCount).toBe(5001);
      expect(meta?.activeVersion).toBe(res.body.listVersion);
    });

    it("400s on a malformed CSV, keeps the prior good list", async () => {
      await postCsv(sdnValidLargeCsv, TEST_SDN_INGEST_TOKEN);
      const before = await getSdnListMeta(env);

      const res = await postCsv(sdnMalformedCsv, TEST_SDN_INGEST_TOKEN);
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("malformed");
      const after = await getSdnListMeta(env);
      expect(after?.activeVersion).toBe(before?.activeVersion);
    });

    it("422s on a below-floor CSV (well-formed, too few entries), keeps the prior good list", async () => {
      await postCsv(sdnValidLargeCsv, TEST_SDN_INGEST_TOKEN);
      const before = await getSdnListMeta(env);

      const res = await postCsv(sdnValidCsv, TEST_SDN_INGEST_TOKEN);
      expect(res.status).toBe(422);
      expect(res.body.reason).toBe("below-floor");
      const after = await getSdnListMeta(env);
      expect(after?.activeVersion).toBe(before?.activeVersion);
    });
  });
});
