import { describe, expect, it } from "vitest";
import { ONE_DAY_MS, WARMUP_RAMP_DAYS } from "../src/engine/warmup.js";
import { api, cookieApi, createDashboardSession, signup, tenantStub } from "./helpers.js";

async function setupThread(brand: string, primaryDomain: string): Promise<{ tenantId: string; token: string; threadId: string }> {
  const { tenantId, token } = await signup(brand, `founder@${primaryDomain}`);
  await api("/setup-infrastructure", {
    method: "POST",
    token,
    body: JSON.stringify({
      brand,
      primaryDomain,
      domains: 1,
      inboxesEach: 1,
      persona: "Sender",
      physicalAddress: "1 Test St",
      senderIdentity: `Sender <s@${primaryDomain}>`,
    }),
  });
  await tenantStub(tenantId).advanceClock((WARMUP_RAMP_DAYS + 1) * ONE_DAY_MS);
  await api("/campaigns", {
    method: "POST",
    token,
    body: JSON.stringify({
      name: "c",
      offer: "x",
      leads: [{ email: `lead@${primaryDomain.replace(".com", "")}-leads.com`, firstName: "L", company: "Co" }],
      sequence: [{ step: 1, subject: "Hi", body: "Hi", delayDays: 0 }],
    }),
  });
  await tenantStub(tenantId).tick();
  const inbox = await api<{ threads: { threadId: string }[] }>("/inbox", { token });
  return { tenantId, token, threadId: inbox.body.threads[0]!.threadId };
}

describe("POST /threads/:id/label", () => {
  it("sets a label, stamped source='api' for a bearer-authed request", async () => {
    const { token, threadId } = await setupThread("Label Co", "labelco.com");
    const res = await api<{ threadId: string; label: string; source: string }>(`/threads/${threadId}/label`, {
      method: "POST",
      token,
      body: JSON.stringify({ label: "interested" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe("interested");
    expect(res.body.source).toBe("api");

    const inbox = await api<{ threads: { threadId: string; label: string | null; labelSource: string | null }[] }>("/inbox", { token });
    const row = inbox.body.threads.find((t) => t.threadId === threadId)!;
    expect(row.label).toBe("interested");
    expect(row.labelSource).toBe("api");
  });

  it("stamps source='dashboard' for a cookie-authed request", async () => {
    const { token, threadId } = await setupThread("Label Cookie Co", "labelcookieco.com");
    const session = await createDashboardSession(token);
    const res = await cookieApi<{ source: string }>(`/threads/${threadId}/label`, session, {
      method: "POST",
      csrf: true,
      body: JSON.stringify({ label: "meeting_booked" }),
    });
    expect(res.body.source).toBe("dashboard");
  });

  it("label: null clears an existing label", async () => {
    const { token, threadId } = await setupThread("Label Clear Co", "labelclearco.com");
    await api(`/threads/${threadId}/label`, { method: "POST", token, body: JSON.stringify({ label: "interested" }) });
    const cleared = await api<{ label: string | null; source: string | null }>(`/threads/${threadId}/label`, {
      method: "POST",
      token,
      body: JSON.stringify({ label: null }),
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.label).toBeNull();

    const inbox = await api<{ threads: { threadId: string; label: string | null }[] }>("/inbox", { token });
    expect(inbox.body.threads.find((t) => t.threadId === threadId)!.label).toBeNull();
  });

  it("404s on an unknown thread id", async () => {
    const { token } = await signup("Label 404 Co", "label404@labeltest.example");
    const res = await api(`/threads/not_a_real_thread/label`, { method: "POST", token, body: JSON.stringify({ label: "interested" }) });
    expect(res.status).toBe(404);
  });

  // SPEC.md §19.7 item 6 — a label containing HTML/script markers is stored
  // and returned VERBATIM as data. The backend must never mangle it; the
  // rendering guard (textContent-only, no HTML path) is an M2/M3 SPA concern.
  it("an XSS-shaped label string round-trips intact as plain data (no HTML mangling in storage)", async () => {
    const { token, threadId } = await setupThread("Label XSS Co", "labelxssco.com");
    const hostile = `<script>alert(1)</script>`;
    const res = await api<{ label: string }>(`/threads/${threadId}/label`, {
      method: "POST",
      token,
      body: JSON.stringify({ label: hostile }),
    });
    expect(res.status).toBe(200);
    expect(res.body.label).toBe(hostile);

    const inbox = await api<{ threads: { threadId: string; label: string | null }[] }>("/inbox", { token });
    expect(inbox.body.threads.find((t) => t.threadId === threadId)!.label).toBe(hostile);
  });
});
