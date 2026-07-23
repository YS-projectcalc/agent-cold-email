import { z } from "zod";

// POST /admin/support/triage body — an inbound support message. `tenantId`
// is optional: the sender may not be identifiable as an existing tenant
// (prospect email, or the real Cloudflare Email Routing wiring — armed at
// activation, see ../admin/README.md — may not always resolve one).
export const SupportTriageInput = z.object({
  from: z.string().email().max(320),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20_000),
  tenantId: z.string().min(1).max(200).optional(),
  // B4 (CLASS B) — the source RFC 5322 Message-ID, when this message came from
  // real inbound email. Optional: operator/console-created tickets have none.
  // Deduped on (a redelivered inbound email won't create a second ticket).
  messageId: z.string().min(1).max(998).optional(),
});
export type SupportTriageInput = z.infer<typeof SupportTriageInput>;

// G1b — POST /admin/tenants/:id/screening body (ga-gates-design-2026-07-22.md
// §G1). `clear` un-blocks activation on the tenant's own DO; `reject` chains
// into the existing D5 terminate path (design line 59: "reject can chain into
// the existing terminate path") — see routes/admin-screening.ts. NEVER a
// third "leave pending" decision here: the admin route IS the resolution —
// listing (`GET /admin/screening/reviews`) is the separate read path for
// deciding which way to go.
export const AdminScreeningDecisionInput = z.object({
  decision: z.enum(["clear", "reject"]),
  note: z.string().max(2000).default(""),
});
export type AdminScreeningDecisionInput = z.infer<typeof AdminScreeningDecisionInput>;
