import { Hono } from "hono";
import { ContactOperatorInput, ListMessagesQueryInput, UnsubscribeQuery } from "@coldstart/shared";
import type { Env } from "../env.js";
import type { AuthedVariables } from "../require-auth.js";
import { escapeHtml } from "../html-escape.js";
import { verifyUnsubscribeToken } from "../unsubscribe-token.js";
import { declaresOverCap, parseJsonBody, SMALL_BODY_MAX_BYTES } from "../validate.js";

// msgchannel increment 3 (2026-08-06) — REST facade for the SAME TenantDO
// methods the MCP tools list_messages/ack_message call (parity law, matching
// leads.ts/webhook-subscriptions.ts/byo-domains.ts). `GET /messages` mirrors
// list_messages exactly (cursor-paginated, unacked-first). `POST
// /messages/:id/ack` is id-in-URL (not body-keyed — a message id, unlike an
// email, has no reason to live in the body) mirroring
// `POST /threads/:id/mark`.
export const messagesRoute = new Hono<{ Bindings: Env; Variables: AuthedVariables }>()
  .get("/messages", async (c) => {
    const rawLimit = c.req.query("limit");
    const parsed = ListMessagesQueryInput.safeParse({
      limit: rawLimit !== undefined ? Number(rawLimit) : undefined,
      cursor: c.req.query("cursor"),
    });
    if (!parsed.success) {
      return c.json({ error: "validation failed", issues: parsed.error.issues }, 400);
    }
    const result = await c.get("tenantStub").listMessages(parsed.data);
    return c.json(result);
  })
  .post("/messages/:id/ack", async (c) => {
    const id = c.req.param("id");
    const result = await c.get("tenantStub").ackMessage(id);
    return c.json(result);
  })
  // msgchannel Inc5 (founder-ratified 2026-08-11) — REST parity for the MCP
  // `contact_operator` tool (mcp/tools.ts), the SAME TenantDO RPC (parity
  // law). Body-keyed (mirrors leads.ts's suppress/disposition routes) — there
  // is no id to put in the URL, this call MINTS a new ticket id.
  .post("/messages/contact-operator", async (c) => {
    const parsed = await parseJsonBody(c, ContactOperatorInput);
    if (!parsed.ok) return parsed.response;
    const result = await c.get("tenantStub").contactOperator(parsed.data);
    return c.json(result, 201);
  });

// msgchannel Inc4 (design §6) — the mirror's recipient-facing opt-out.
// UNAUTHENTICATED, mounted OUTSIDE the tenant-authed group in index.ts (a
// mail client presents no bearer token): the signed (tenant, email, sig)
// triplet IS the credential, the exact `routes/unsubscribe.ts` shape reused
// (same `verifyUnsubscribeToken`, same two-step GET-confirm/POST-perform
// split, for the same reason — a GET that mutates is fired by every mail-
// scanner prefetch).
const OPTOUT_PAGE_STYLE =
  "font-family: -apple-system, system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; line-height: 1.5; color: #1a1a1a;";

function invalidOptOutLinkPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Link invalid</title></head>
<body style="${OPTOUT_PAGE_STYLE}">
<h1>This link isn't valid</h1>
<p>It may have been altered or copied incorrectly.</p>
</body></html>`;
}

function optOutConfirmPage(email: string, actionUrl: string): string {
  const safeEmail = escapeHtml(email);
  const safeAction = escapeHtml(actionUrl);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Turn off email updates</title></head>
<body style="${OPTOUT_PAGE_STYLE}">
<h1>Turn off email updates to ${safeEmail}?</h1>
<p>This mirrors your account's own message channel by email. Turning it off does not affect your account's own messages, or any other email from this platform.</p>
<form method="POST" action="${safeAction}">
  <button type="submit" style="font-size: 1rem; padding: 0.6rem 1.2rem; cursor: pointer;">Turn off</button>
</form>
</body></html>`;
}

function optOutSuccessPage(email: string): string {
  const safeEmail = escapeHtml(email);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Turned off</title></head>
<body style="${OPTOUT_PAGE_STYLE}">
<h1>Email updates are off</h1>
<p>${safeEmail} will not receive further mirrored update emails.</p>
</body></html>`;
}

function parseMirrorOptOutQuery(tenant: string | undefined, email: string | undefined, sig: string | undefined) {
  return UnsubscribeQuery.safeParse({ tenant, email, sig });
}

export const mirrorOptOutRoute = new Hono<{ Bindings: Env }>()
  .get("/messages/mirror/optout", async (c) => {
    const parsed = parseMirrorOptOutQuery(c.req.query("tenant"), c.req.query("email"), c.req.query("sig"));
    if (!parsed.success) return c.html(invalidOptOutLinkPage(), 400);
    const { tenant, email, sig } = parsed.data;

    const valid = await verifyUnsubscribeToken(c.env.TOKEN_HASH_PEPPER, tenant, email, sig);
    if (!valid) return c.html(invalidOptOutLinkPage(), 400);

    const actionUrl = `/messages/mirror/optout?${new URLSearchParams({ tenant, email, sig }).toString()}`;
    return c.html(optOutConfirmPage(email, actionUrl), 200);
  })
  .post("/messages/mirror/optout", async (c) => {
    // The query string's signed token is the credential; the body carries
    // nothing this route needs — never read (routes/unsubscribe.ts's same
    // reasoning for its own POST).
    if (declaresOverCap(c, SMALL_BODY_MAX_BYTES)) {
      return c.text("request body too large", 413);
    }

    const parsed = parseMirrorOptOutQuery(c.req.query("tenant"), c.req.query("email"), c.req.query("sig"));
    if (!parsed.success) return c.html(invalidOptOutLinkPage(), 400);
    const { tenant, email, sig } = parsed.data;

    const valid = await verifyUnsubscribeToken(c.env.TOKEN_HASH_PEPPER, tenant, email, sig);
    if (!valid) return c.html(invalidOptOutLinkPage(), 400);

    // Idempotent, like /unsubscribe: a repeat POST always 200s.
    const stub = c.env.TENANT.get(c.env.TENANT.idFromName(tenant));
    await stub.setMirrorEmailOptOut(true);
    return c.html(optOutSuccessPage(email), 200);
  });
