import { Hono } from "hono";
import type { Env } from "../env.js";
import { RealClock } from "../clock.js";
import { SDN_INGEST_MAX_BYTES } from "../validate.js";
import { ingestSdnCsv, type SdnIngestOutcome } from "../ofac/sdn-ingest.js";

// G1a droplet-relay (design: droplet-relay-2026-07-24) — Treasury's TLS
// front-end 525s every Worker-origin fetch to sanctionslistservice.ofac.
// treas.gov (proven live by two persistent cron alerts, both the legacy AND
// direct URLs; curl from a Mac/droplet gets the file fine — Treasury's front
// end specifically rejects Cloudflare egress). A droplet that already does
// IMAP for the same "Workers can't reach this host" reason (ACTIVATION.md's
// go-engine host) curls the real feed and relays it here.
//
// This is the ARRIVING path only — maybeRefreshSdnList (sdn-refresh.ts) stays
// the PRIMARY direct-fetch attempt every 5-min cron tick and self-heals if
// Treasury ever unblocks Cloudflare egress. Both share parseSdnCsv/
// swapInSdnList (CLAUDE.md rule c: no duplicated logic).
//
// Gated by requireAdminAuth's SDN_INGEST_TOKEN carve-out
// (require-admin-auth.ts) — a NARROW dedicated secret, never ADMIN_TOKEN: the
// droplet must never hold cross-tenant admin power. That token's blast
// radius is exactly "can submit a candidate SDN CSV", bounded further by the
// MIN_SDN_ENTRIES floor guard in sdn-ingest.ts (a forged tiny-but-valid CSV
// can't neuter screening).
const STATUS_BY_REASON: Record<SdnIngestOutcome["reason"], 200 | 400 | 422 | 500> = {
  ingested: 200,
  malformed: 400, // structurally broken CSV (wrong column count / zero rows)
  "below-floor": 422, // syntactically valid CSV, semantically too few entries
  stale: 422, // syntactically valid CSV, but a replay/regression vs the active list (monotonicity guard)
  "write-failed": 500, // our own D1 write failed — not the caller's fault
};

export const adminSdnIngestRoute = new Hono<{ Bindings: Env }>().post("/admin/sdn/ingest", async (c) => {
  // Body-size cap BEFORE materializing the body — same class of guard every
  // other body-reading route in this codebase applies (validate.ts,
  // webhooks.ts, lifecycle.ts, mcp.ts).
  const declaredLength = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > SDN_INGEST_MAX_BYTES) {
    return c.json({ error: "request body too large" }, 413);
  }

  const csvText = await c.req.text();
  const now = new RealClock().now();
  const outcome = await ingestSdnCsv(c.env, csvText, now);
  return c.json(outcome, STATUS_BY_REASON[outcome.reason]);
});
