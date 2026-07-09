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
});
export type SupportTriageInput = z.infer<typeof SupportTriageInput>;
