// SPEC.md §22 — warm-lead thin layer, ratified 2026-07-16, founder-ruled
// (Q1-Q6) 2026-07-21. Shared by BOTH transports (HTTP facade + MCP tools),
// exactly like intents.ts/dashboard.ts/webhooks.ts back their own features.

import { z } from "zod";

// Q2 (docs/research/warm-lead-q1-q6-recommendations-2026-07-21.md) — the
// dive's base six (none|interested|meeting_booked|not_now|not_interested|
// bad_fit) widened by two founder-ratified ACTION-DRIVING members:
// out_of_office (reschedule the follow-up past the return date, instead of
// treating silence as disinterest) and wrong_person (drives a referral ask,
// not a nurture follow-up). "do_not_contact" is DELIBERATELY not a member —
// that intent routes to suppress_lead (a tenant-wide suppressions row), never
// a cosmetic status (SPEC.md §22).
export const LEAD_INTEREST_STATUSES = [
  "none",
  "interested",
  "meeting_booked",
  "not_now",
  "not_interested",
  "bad_fit",
  "out_of_office",
  "wrong_person",
] as const;
export type LeadInterestStatus = (typeof LEAD_INTEREST_STATUSES)[number];

// suppress_lead — SPEC.md §22 tool 20. `reason` is pinned to the literal
// "manual" (not the full SuppressionReason union): "bounce" | "soft_bounce" |
// "complaint" | "unsubscribe" are exclusively system-derived elsewhere
// (engine/reply-processor.ts / engine/suppression.ts's own internal callers)
// — never a client-supplied claim, the same discipline as thread_labels.source/
// dashboard_views.edited_by being server-derived from transport. `note` is
// accepted for schema symmetry with the ratified `{email, reason?='manual',
// note?}` shape but not persisted — see engine/suppression.ts's suppressLead
// doc comment for why (mirrors ConfigureWebhookInput's own ignored `note`).
export const SuppressLeadInput = z.object({
  email: z.string().email(),
  reason: z.literal("manual").optional().default("manual"),
  note: z.string().max(2000).optional(),
});
export type SuppressLeadInput = z.infer<typeof SuppressLeadInput>;

// update_lead — SPEC.md §22 tool 21. Upserts the contact-level
// lead_dispositions row. At least one of the three patch fields must be
// present (mirrors WebhookUpdateInput/ConfigureWebhookInput's own "at least
// one changed field" refine) — an empty call has nothing to persist.
export const UpdateLeadInput = z
  .object({
    email: z.string().email(),
    interestStatus: z.enum(LEAD_INTEREST_STATUSES).optional(),
    notes: z.string().max(5000).optional(),
    tags: z.array(z.string().min(1).max(100)).max(50).optional(),
  })
  .refine((v) => v.interestStatus !== undefined || v.notes !== undefined || v.tags !== undefined, {
    message: "update_lead requires at least one of: interestStatus, notes, tags",
  });
export type UpdateLeadInput = z.infer<typeof UpdateLeadInput>;

// list_leads — SPEC.md §22 tool 22 (read-only; also the export surface — Q6,
// paginated JSON, no separate CSV endpoint). NATIVE types (number/boolean),
// exactly like InboxQueryInput/ActivityQueryInput: the HTTP route layer parses
// raw query STRINGS into these; MCP tool arguments arrive already-typed.
export const ListLeadsQueryInput = z.object({
  campaign: z.string().min(1).max(200).optional(),
  interestStatus: z.enum(LEAD_INTEREST_STATUSES).optional(),
  suppressed: z.boolean().optional(),
  replied: z.boolean().optional(),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type ListLeadsQueryInput = z.infer<typeof ListLeadsQueryInput>;
