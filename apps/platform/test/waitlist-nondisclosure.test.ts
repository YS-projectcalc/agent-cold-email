import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";

// IN-18, docs/adversarial/class-sweep-dedup-semantics-2026-08-17.md — and the
// one member of that sweep where the class's OWN remedy is the wrong move.
//
// The sweep listed `insertWaitlistEmail`'s discarded boolean as "the exact
// undisclosed-collapse shape the guard should make unwritable": INSERT OR IGNORE
// on the email PK, and the route answers `{ok:true}` identically for a new lead
// and a silent no-op. Structurally that is the class.
//
// But `POST /api/waitlist` is UNAUTHENTICATED BY DESIGN (routes/waitlist.ts's
// header: there is no bearer token for someone who has not signed up yet).
// Surfacing `deduplicated` there would turn a marketing form into an EMAIL
// ENUMERATION ORACLE — anyone could probe whether a given address is on the
// waitlist, one request at a time. The CORS allowlist does not prevent that;
// it constrains browsers, not curl.
//
// So the silence is CORRECT here, and this test exists to keep it that way: the
// response must stay byte-identical whether or not the email was already known,
// so a future pass applying the sweep's G1 disclosure guard uniformly cannot
// quietly open the oracle.

async function submit(email: string) {
  const res = await SELF.fetch("https://coldrig.dev/api/waitlist", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://coldrig.dev" },
    body: JSON.stringify({ email }),
  });
  return { status: res.status, body: await res.text() };
}

describe("IN-18 — the public waitlist must not disclose whether an email is already known", () => {
  it("answers a repeat submission byte-identically to a first one", async () => {
    const email = `lead-${crypto.randomUUID()}@example.com`;

    const first = await submit(email);
    const repeat = await submit(email);

    expect(first.status).toBe(200);
    expect(repeat.status).toBe(first.status);
    expect(repeat.body).toBe(first.body);
    // Nothing in the payload may hint at the collapse.
    expect(repeat.body).not.toMatch(/dedup|duplicate|already|exists/i);
  });

  it("stores the lead exactly once", async () => {
    const email = `lead-${crypto.randomUUID()}@example.com`;
    await submit(email);
    await submit(email);

    const { env } = await import("cloudflare:test");
    const row = await env.DB.prepare(`SELECT COUNT(*) as n FROM waitlist WHERE email = ?`)
      .bind(email)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});
