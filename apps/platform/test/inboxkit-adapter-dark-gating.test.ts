import { describe, expect, it } from "vitest";
import { NotActivatedError } from "@coldstart/shared";
import { VirtualClock } from "../src/clock.js";
import { createVendorAdapters } from "../src/vendors/factory.js";
import { RealDomainPort } from "../src/vendors/real/domain-port.js";
import { RealInboxKitDomainPort } from "../src/vendors/real/inboxkit-domain-port.js";
import { SandboxMailboxPort } from "../src/vendors/sandbox/mailbox-port.js";

// Proves the InboxKit adapters built this pass (RealMailboxPort's real HTTP
// client + RealInboxKitDomainPort) are UNREACHABLE from the current build,
// mirroring demo-adapter-guard.test.ts / engine-tenants-allowlist.test.ts's
// style for the existing real/ adapters. `realAdaptersActivated` is hard-false
// in the deployed build (factory.ts's own doc comment) and no call site
// supplies `inboxKitConfig` (tenant-do.ts's 6-arg call) — every guard below
// forces the hypothetical "what if" case and asserts the dark/Porkbun-default
// outcome still holds, so a future accidental wiring change fails loudly here
// instead of at runtime against a live vendor.

const clock = new VirtualClock(Date.now(), 0, 1);
const INBOXKIT_CONFIG = { apiKey: "test-key", workspaceId: "00000000-0000-4000-8000-000000000001" };

describe("InboxKit adapters — unreachable from the current call-site shape", () => {
  it("the real tenant-do.ts call-site shape (no inboxKitConfig arg) never wires an InboxKit-backed domain adapter, even if realAdaptersActivated were hypothetically true", async () => {
    const bundle = createVendorAdapters("launch", clock, true); // matches tenant-do.ts's 6-positional-arg call today (trailing args omitted)
    expect(bundle.kind).toBe("real");
    expect(bundle.domain).toBeInstanceOf(RealDomainPort); // Porkbun default, NOT InboxKit
    expect(bundle.domain).not.toBeInstanceOf(RealInboxKitDomainPort);
  });

  it("mailbox stays dark (NotActivatedError) without an InboxKit config, even in the hypothetical real branch", async () => {
    const bundle = createVendorAdapters("launch", clock, true);
    await expect(bundle.mailbox.provision("x.example.com", "a", "k1")).rejects.toBeInstanceOf(NotActivatedError);
    await expect(bundle.mailbox.getHealth("a@x.example.com")).rejects.toBeInstanceOf(NotActivatedError);
  });

  it("demo/free tenants stay sandbox even with a fully-populated inboxKitConfig supplied (plan check dominates, ARCHITECTURE.md #8)", () => {
    const bundle = createVendorAdapters("demo", clock, true, undefined, undefined, undefined, INBOXKIT_CONFIG);
    expect(bundle.kind).toBe("sandbox");
    expect(bundle.mailbox).toBeInstanceOf(SandboxMailboxPort);
  });

  it("realAdaptersActivated=false (current deployed reality) keeps sandbox even with inboxKitConfig supplied", () => {
    const bundle = createVendorAdapters("launch", clock, false, undefined, undefined, undefined, INBOXKIT_CONFIG);
    expect(bundle.kind).toBe("sandbox");
  });

  it("positive control: supplying inboxKitConfig on an activated+paid bundle DOES wire RealInboxKitDomainPort — proves the gate is config-driven, not a dead/always-false branch", () => {
    const bundle = createVendorAdapters("launch", clock, true, undefined, undefined, undefined, INBOXKIT_CONFIG);
    expect(bundle.kind).toBe("real");
    expect(bundle.domain).toBeInstanceOf(RealInboxKitDomainPort);
  });
});
