import { Hono } from "hono";
import { UnsubscribeQuery } from "@coldstart/shared";
import type { Env } from "../env.js";
import { verifyUnsubscribeToken } from "../unsubscribe-token.js";
import { SMALL_BODY_MAX_BYTES } from "../validate.js";

// B4 opt-out — the hosted RFC 8058 one-click unsubscribe endpoint. Public and
// UNAUTHENTICATED (a mail client POSTs here with no bearer token to present,
// exactly like /webhooks/stripe and /checkout/simulate); the signed
// (tenant, email, sig) triplet in the query string IS the credential
// (unsubscribe-token.ts) — verified here BEFORE the target tenant's DO stub
// is ever resolved, so a tampered/forged link can't reach a tenant at all.
//
// GET renders a minimal human confirm page (for the IN-BODY link a person
// clicks in their own browser); POST performs the actual suppression and is
// idempotent (a repeat call, or a mail client's automatic RFC 8058 one-click
// POST straight to the URL in `List-Unsubscribe`, always 200s). Both methods
// share the exact same URL/token — the https form in the header and the
// in-body link are the same link, differing only in which HTTP method the
// caller happens to use.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const PAGE_STYLE =
  "font-family: -apple-system, system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5; color: #1a1a1a;";

function invalidLinkPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribe link invalid</title></head>
<body style="${PAGE_STYLE}">
<h1>This unsubscribe link isn't valid</h1>
<p>It may have been altered or copied incorrectly. If you'd still like to stop receiving these emails, reply to the message directly and say so.</p>
</body></html>`;
}

function confirmPage(email: string, actionUrl: string): string {
  const safeEmail = escapeHtml(email);
  const safeAction = escapeHtml(actionUrl);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Confirm unsubscribe</title></head>
<body style="${PAGE_STYLE}">
<h1>Unsubscribe ${safeEmail}?</h1>
<p>You'll stop receiving further emails from this sender immediately.</p>
<form method="POST" action="${safeAction}">
  <button type="submit" style="font-size: 1rem; padding: 0.6rem 1.2rem; cursor: pointer;">Confirm unsubscribe</button>
</form>
</body></html>`;
}

function successPage(email: string): string {
  const safeEmail = escapeHtml(email);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed</title></head>
<body style="${PAGE_STYLE}">
<h1>You're unsubscribed</h1>
<p>${safeEmail} will not receive further emails from this sender.</p>
</body></html>`;
}

function parseTokenQuery(tenant: string | undefined, email: string | undefined, sig: string | undefined) {
  return UnsubscribeQuery.safeParse({ tenant, email, sig });
}

export const unsubscribeRoute = new Hono<{ Bindings: Env }>()
  .get("/unsubscribe", async (c) => {
    const parsed = parseTokenQuery(c.req.query("tenant"), c.req.query("email"), c.req.query("sig"));
    if (!parsed.success) return c.html(invalidLinkPage(), 400);
    const { tenant, email, sig } = parsed.data;

    const valid = await verifyUnsubscribeToken(c.env.TOKEN_HASH_PEPPER, tenant, email, sig);
    if (!valid) return c.html(invalidLinkPage(), 400);

    const actionUrl = `/unsubscribe?${new URLSearchParams({ tenant, email, sig }).toString()}`;
    return c.html(confirmPage(email, actionUrl), 200);
  })
  .post("/unsubscribe", async (c) => {
    // RFC 8058's client-sent `List-Unsubscribe=One-Click` marker in the POST
    // body carries no information THIS route needs (the query string's
    // signed token is the actual credential) — so the body is never read,
    // only cap-checked before anything else, mirroring webhooks.ts's same
    // parse-cost-amplifier discipline on an unauthenticated route.
    const declaredLength = Number(c.req.header("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > SMALL_BODY_MAX_BYTES) {
      return c.text("request body too large", 413);
    }

    const parsed = parseTokenQuery(c.req.query("tenant"), c.req.query("email"), c.req.query("sig"));
    if (!parsed.success) return c.html(invalidLinkPage(), 400);
    const { tenant, email, sig } = parsed.data;

    const valid = await verifyUnsubscribeToken(c.env.TOKEN_HASH_PEPPER, tenant, email, sig);
    if (!valid) return c.html(invalidLinkPage(), 400);

    // Idempotent (engine/suppression.ts's unsubscribeEmail): a repeat POST —
    // whether a genuine retry, a re-click, or the mail client re-sending its
    // own one-click POST — always 200s, never errors.
    const stub = c.env.TENANT.get(c.env.TENANT.idFromName(tenant));
    await stub.unsubscribeByEmail(email);
    return c.html(successPage(email), 200);
  });
