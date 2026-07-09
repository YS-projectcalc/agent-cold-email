// `agent-cold-email demo` — the hero, no-signup command. Mints a demo
// tenant, provisions realistic sample infrastructure, and runs the
// accelerated sandbox pipeline (POST /demo/run) so a prospective user sees
// the whole provision -> warm -> send -> reply/bounce loop in one command,
// with no card and no real emails sent.

import { pollUntil, request } from "../client.js";
import { flagString, type ParsedArgs } from "../flags.js";

const SAMPLE_SETUP = {
  primaryDomain: "northwind-robotics.com",
  domains: 2,
  inboxesEach: 2,
  persona: "Alex Rivera, Sales",
  physicalAddress: "500 Market St, Suite 12, Springfield, USA",
  senderIdentity: "Alex Rivera <alex@northwind-robotics.com>",
};

interface InfraStatus {
  domains: number;
  mailboxes: number;
  sendReady: boolean;
}

interface DemoRunSummary {
  sent: number;
  replies: number;
  bounces: number;
  complaints: number;
  stopOnReplyProof: { leadEmail: string; remainingStepsCancelled: boolean } | null;
  sampleThread: { threadId: string; leadEmail: string; messages: { type: string }[] } | null;
}

export async function runDemo(args: ParsedArgs): Promise<void> {
  const brand = flagString(args.flags, "brand") ?? "Northwind Robotics";
  console.log(`agent-cold-email demo — sandbox run for "${brand}"\n`);

  console.log("1/4  Minting a demo tenant (POST /signup, no card, no real vendor account)...");
  const { tenantId, token } = await request<{ tenantId: string; token: string }>("/signup", {
    method: "POST",
    body: { brand, contactEmail: `demo+${Date.now()}@example.com` },
  });
  console.log(`     tenant ${tenantId}\n`);

  console.log("2/4  Provisioning branded lookalike domains + mailboxes, starting warmup (POST /setup-infrastructure)...");
  await request("/setup-infrastructure", { method: "POST", token, body: { brand, ...SAMPLE_SETUP } });
  const status = await pollUntil(
    () => request<InfraStatus>("/infrastructure-status", { token }),
    (s) => s.mailboxes > 0,
  );
  console.log(`     ${status.domains} domain(s), ${status.mailboxes} mailbox(es) provisioned, warmup started\n`);

  console.log("3/4  Running the accelerated sandbox pipeline (POST /demo/run)...");
  console.log("     advances warmup on a virtual clock past the ramp, sends respecting per-mailbox caps,");
  console.log("     polls the sandbox inbox for replies/bounces...\n");
  const run = await request<DemoRunSummary>("/demo/run", { method: "POST", token });

  console.log("4/4  Run summary:\n");
  console.log(`     Sent:       ${run.sent}`);
  console.log(`     Replies:    ${run.replies}`);
  console.log(`     Bounces:    ${run.bounces}`);
  console.log(`     Complaints: ${run.complaints}`);
  if (run.stopOnReplyProof) {
    console.log(
      `     Stop-on-reply proof: ${run.stopOnReplyProof.leadEmail} replied -> remaining sequence steps cancelled: ${run.stopOnReplyProof.remainingStepsCancelled}`,
    );
  }
  if (run.sampleThread) {
    console.log(`     Sample thread ${run.sampleThread.threadId} (${run.sampleThread.leadEmail}): ${run.sampleThread.messages.map((m) => m.type).join(" -> ")}`);
  }

  console.log("\nThis ran in a sandbox — no real domains, no real mailboxes, no real emails sent.");
  console.log("Real sending is early-access: join the waitlist or sign up to run this live once it's available.");
}
