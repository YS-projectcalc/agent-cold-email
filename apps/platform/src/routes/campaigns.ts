import { Hono } from "hono";
import { LaunchCampaignInput } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";
import { parseJsonBody } from "../validate.js";

export const campaignsRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
  .post("/campaigns", async (c) => {
    const parsed = await parseJsonBody(c, LaunchCampaignInput);
    if (!parsed.ok) return parsed.response;
    const result = await c.get("tenantStub").launchCampaign(parsed.data);
    return c.json(result, 201);
  })
  .get("/campaigns/:id/results", async (c) => {
    const result = await c.get("tenantStub").campaignResults(c.req.param("id"));
    return c.json(result);
  })
  .post("/campaigns/:id/pause", async (c) => {
    await c.get("tenantStub").pause(c.req.param("id"));
    return c.json({ paused: true });
  })
  .post("/campaigns/pause-all", async (c) => {
    await c.get("tenantStub").pauseAll();
    return c.json({ pausedAll: true });
  })
  .get("/metrics", async (c) => {
    const result = await c.get("tenantStub").metrics();
    return c.json(result);
  });
