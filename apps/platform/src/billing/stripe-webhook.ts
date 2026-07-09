// Inbound Stripe webhook transport concerns: the event shape, signature
// verification, and tenant-id resolution. Business logic (what an event
// DOES to a tenant) lives in ../engine/billing.ts — this file only gets the
// event safely off the wire and figures out which TenantDO it belongs to.

import { z } from "zod";
import { timingSafeEqual } from "../timing-safe-equal.js";

// Deliberately loose (Stripe's real event payloads carry far more fields) —
// we only need enough structure to route + dedupe + read metadata. Anything
// else stays as unknown, untouched.
export const StripeEventInput = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});
export type StripeEventInput = z.infer<typeof StripeEventInput>;

/**
 * Verifies Stripe's `Stripe-Signature` header (`t=<timestamp>,v1=<hmac>`)
 * against the RAW request body — must run BEFORE any JSON.parse, since the
 * signature is computed over the exact bytes Stripe sent. Timing-safe
 * compare against a forged signature guess.
 */
export async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<boolean> {
  const parts = new Map(
    header
      .split(",")
      .map((kv) => kv.split("="))
      .filter((kv): kv is [string, string] => kv.length === 2 && kv[0] !== undefined && kv[1] !== undefined)
      .map(([k, v]) => [k, v] as [string, string]),
  );
  const timestamp = parts.get("t");
  const v1 = parts.get("v1");
  if (!timestamp || !v1) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${payload}`));
  const expected = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, v1);
}

/**
 * Resolves which tenant an event belongs to, without a separate
 * customer->tenant D1 index: `checkout.session.completed` carries
 * `client_reference_id` (set at session creation); every other event type we
 * handle reads `metadata.tenantId`, which `subscription_data.metadata` at
 * checkout-creation time copies onto the subscription (and, per Stripe's
 * invoice-metadata-inheritance behavior, onto invoices raised from it — the
 * exact inheritance shape is verified against real Stripe at activation).
 */
export function extractStripeTenantId(event: StripeEventInput): string | null {
  const obj = event.data.object;
  const metadata = obj.metadata;
  if (metadata && typeof metadata === "object" && "tenantId" in metadata) {
    const tenantId = (metadata as Record<string, unknown>).tenantId;
    if (typeof tenantId === "string" && tenantId.length > 0) return tenantId;
  }
  const clientRef = obj.client_reference_id;
  if (typeof clientRef === "string" && clientRef.length > 0) return clientRef;
  return null;
}
