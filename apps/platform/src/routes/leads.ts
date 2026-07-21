import { Hono } from "hono";
import { ListLeadsQueryInput, SuppressLeadInput, UpdateLeadInput, type Provenance } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";
import { parseBoolQueryParam, parseJsonBody } from "../validate.js";

// SPEC.md §22 — warm-lead thin layer (increments #1-#3, founder-gated
// 2026-07-21). REST facade for the SAME TenantDO methods the MCP tools
// suppress_lead/update_lead/list_leads call (parity law, matching
// webhook-subscriptions.ts/byo-domains.ts). Body-keyed (not URL-keyed) on
// `email` for the two mutating routes — an email contains characters
// (@, .) that add no value URL-encoded when the body already carries it,
// matching how POST /webhook-subscriptions/configure-style routes here
// take their target in the body rather than minting an id-in-path shape
// for every facade.
export const leadsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
  .get("/leads", async (c) => {
    const rawLimit = c.req.query("limit");
    const parsed = ListLeadsQueryInput.safeParse({
      limit: rawLimit !== undefined ? Number(rawLimit) : undefined,
      cursor: c.req.query("cursor"),
      campaign: c.req.query("campaign"),
      interestStatus: c.req.query("interestStatus"),
      suppressed: parseBoolQueryParam(c.req.query("suppressed")),
      replied: parseBoolQueryParam(c.req.query("replied")),
    });
    if (!parsed.success) {
      return c.json({ error: "validation failed", issues: parsed.error.issues }, 400);
    }
    const result = await c.get("tenantStub").listLeads(parsed.data);
    return c.json(result);
  })
  .post("/leads/suppress", async (c) => {
    const parsed = await parseJsonBody(c, SuppressLeadInput);
    if (!parsed.ok) return parsed.response;
    const result = await c.get("tenantStub").suppressLead(parsed.data);
    return c.json(result, 200);
  })
  .post("/leads/disposition", async (c) => {
    const parsed = await parseJsonBody(c, UpdateLeadInput);
    if (!parsed.ok) return parsed.response;
    // Provenance server-derived from transport (§19.4 discipline), never a
    // client-supplied actor claim — same derivation routes/inbox.ts uses for
    // label_thread's `source`.
    const source: Provenance = c.get("authVia") === "cookie" ? "dashboard" : "api";
    const result = await c.get("tenantStub").updateLead(parsed.data, source);
    return c.json(result, 200);
  });
