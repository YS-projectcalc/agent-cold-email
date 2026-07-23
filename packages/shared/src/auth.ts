// Magic-link login (design docs/research/human-signup-magic-link-design-
// 2026-07-22.md §1.3/§1.4) — request bodies shared by the HTTP facade, same
// house style as intents.ts/dashboard.ts.

import { z } from "zod";

// POST /login — email-possession login request. `turnstileToken` is optional
// and unused until increment C wires TURNSTILE_SECRET verification (§2.3);
// present now so the request/response contract doesn't change shape later.
export const LoginRequestInput = z.object({
  email: z.string().email(),
  turnstileToken: z.string().min(1).max(2000).optional(),
});
export type LoginRequestInput = z.infer<typeof LoginRequestInput>;

// POST /login/consume — `tenantId` is present only on the picker's second
// call (§1.5), after the first call returned a `tenants` list instead of
// consuming the token.
export const LoginConsumeInput = z.object({
  token: z.string().min(1).max(500),
  tenantId: z.string().min(1).max(200).optional(),
});
export type LoginConsumeInput = z.infer<typeof LoginConsumeInput>;
