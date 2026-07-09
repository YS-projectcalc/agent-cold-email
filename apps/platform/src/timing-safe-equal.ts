// Constant-time string compare — shared by every credential check that must
// not leak timing information about how much of a guess was correct
// (Stripe-Signature verification in billing/stripe-webhook.ts; the
// ADMIN_TOKEN bearer check in require-admin-auth.ts). CLAUDE.md rule c: one
// implementation, not duplicated per caller.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
