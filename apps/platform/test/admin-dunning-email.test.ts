import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { runDunningSweep } from "../src/admin/ops-sweep.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import { failPayment, mintTenant, signup } from "./helpers.js";

// D2 (brief) — the suspend path now emails the tenant a plain honest notice +
// the founder a copy. On OLD code the suspend sent nothing at all, so every
// assertion here that a notice was sent fails on the pre-change code.

async function driveToSuspend(tenantId: string): Promise<void> {
  await failPayment(tenantId); // cycle 1 -> retry
  await failPayment(tenantId); // cycle 2 -> escalate
  await failPayment(tenantId); // cycle 3
  await failPayment(tenantId); // cycle 4 -> suspend
}

describe("dunning suspend notices", () => {
  it("persists the signup contact email and notifies BOTH the tenant and the founder on suspend", async () => {
    const contactEmail = "founder-notify@example.com";
    const { tenantId } = await signup("Dunning Notify Co", contactEmail);

    // The contact email captured at /signup is actually stored (migrations/0007).
    const stored = await env.DB.prepare(`SELECT contact_email FROM tenants_index WHERE id = ?`)
      .bind(tenantId)
      .first<{ contact_email: string | null }>();
    expect(stored?.contact_email).toBe(contactEmail);

    await driveToSuspend(tenantId);

    const mailer = new SandboxOpsMailer();
    await runDunningSweep(env, Date.now(), mailer);

    const tenantNotice = mailer.sent.find((m) => m.to === contactEmail);
    const founderCopy = mailer.sent.find((m) => m.to === env.OPS_ALERT_EMAIL);

    expect(tenantNotice).toBeDefined();
    expect(tenantNotice?.subject).toContain("suspended for non-payment");
    expect(tenantNotice?.text).toContain("Dunning Notify Co");
    expect(tenantNotice?.html.length).toBeGreaterThan(0);

    expect(founderCopy).toBeDefined();
    expect(founderCopy?.subject).toContain("suspended (dunning)");
    expect(founderCopy?.text).toContain(`tenant notified at ${contactEmail}`);
  });

  it("flags (does not invent) a missing contact email — founder copy only", async () => {
    // mintTenant bypasses /signup, so it has NO contact email on file.
    const { tenantId } = await mintTenant("No Contact Co", "growth");
    await driveToSuspend(tenantId);

    const mailer = new SandboxOpsMailer();
    await runDunningSweep(env, Date.now(), mailer);

    // Exactly one email — the founder copy. No fabricated tenant address.
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.to).toBe(env.OPS_ALERT_EMAIL);
    expect(mailer.sent[0]!.text).toContain("NO contact email on file");
    expect(mailer.sent[0]!.text).toContain("tenant NOT notified");
  });

  it("does not notify on a non-suspend action (retry/escalate)", async () => {
    const { tenantId } = await signup("Retry Only Co", "retry-only@example.com");
    await failPayment(tenantId); // cycle 1 -> retry, not suspend

    const mailer = new SandboxOpsMailer();
    await runDunningSweep(env, Date.now(), mailer);

    expect(mailer.sent).toHaveLength(0);
  });
});
