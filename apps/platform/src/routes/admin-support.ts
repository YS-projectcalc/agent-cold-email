import { Hono } from "hono";
import { SupportTriageInput } from "../admin/schemas.js";
import { countSupportTicketsByStatus, insertSupportTicket, listOpenAndEscalatedSupportTickets } from "../admin/db.js";
import { triageSupportMessage } from "../admin/support-kb.js";
import { RealClock } from "../clock.js";
import type { Env } from "../env.js";
import { newId } from "../schema.js";
import { parseJsonBody } from "../validate.js";

// D1 (brief) — AI support triage lane. POST /admin/support/triage classifies
// + drafts/escalates + logs; GET /admin/support/digest is the owner's pull
// view. Real inbound email (Cloudflare Email Routing -> this endpoint) is an
// ACTIVATION step (admin/README.md) — this route is the triage LOGIC,
// exercisable now with any {from, subject, body} payload.
export const adminSupportRoute = new Hono<{ Bindings: Env }>()
  .post("/admin/support/triage", async (c) => {
    const parsed = await parseJsonBody(c, SupportTriageInput);
    if (!parsed.ok) return parsed.response;

    const { category, draft, status } = triageSupportMessage(parsed.data.subject, parsed.data.body);
    const id = newId("tkt");
    await insertSupportTicket(c.env, {
      id,
      fromEmail: parsed.data.from,
      subject: parsed.data.subject,
      body: parsed.data.body,
      tenantId: parsed.data.tenantId ?? null,
      category,
      draft,
      status,
      createdAt: new RealClock().now(),
    });

    return c.json({ ticketId: id, category, draft, status }, 201);
  })
  .get("/admin/support/digest", async (c) => {
    const [tickets, counts] = await Promise.all([
      listOpenAndEscalatedSupportTickets(c.env),
      countSupportTicketsByStatus(c.env),
    ]);
    return c.json({ counts, tickets });
  });
