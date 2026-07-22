import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";
import { createVendorAdapters } from "../src/vendors/factory.js";
import { RealDomainPort } from "../src/vendors/real/domain-port.js";
import { RealInboxKitDomainPort } from "../src/vendors/real/inboxkit-domain-port.js";
import { SandboxMailboxPort } from "../src/vendors/sandbox/mailbox-port.js";

// Proves the InboxKit adapters built this pass (RealMailboxPort's real HTTP
// client + RealInboxKitDomainPort) are UNREACHABLE from the current build,
// mirroring demo-adapter-guard.test.ts / activation-gate.test.ts's style for
// the existing real/ adapters. No call site supplies `inboxKitConfig`
// (tenant-do.ts's 4-arg call) — every guard below forces the hypothetical
// "what if [I1's `activated` gate] were true" case and asserts the
// SANDBOX-by-default outcome still holds (domain/mailbox/billing/metrics need
// BOTH `activated` AND `inboxKitConfig` to ever go real — factory.ts's doc
// comment), so a future accidental wiring change fails loudly here instead of
// at runtime against a live vendor.

const clock = new VirtualClock(Date.now(), 0, 1);
const INBOXKIT_CONFIG = { apiKey: "test-key", workspaceId: "00000000-0000-4000-8000-000000000001" };

describe("InboxKit adapters — unreachable from the current call-site shape", () => {
  it("the real tenant-do.ts call-site shape (no inboxKitConfig arg) keeps domain SANDBOX even if activated were hypothetically true", () => {
    const bundle = createVendorAdapters("launch", clock, true); // matches tenant-do.ts's 4-positional-arg call today (trailing args omitted)
    expect(bundle.kind).toBe("sandbox");
    expect(bundle.domain).not.toBeInstanceOf(RealDomainPort);
    expect(bundle.domain).not.toBeInstanceOf(RealInboxKitDomainPort);
  });

  it("mailbox stays SANDBOX (functional, not merely dark) without an InboxKit config, even if activated were hypothetically true", () => {
    const bundle = createVendorAdapters("launch", clock, true);
    expect(bundle.mailbox).toBeInstanceOf(SandboxMailboxPort);
  });

  it("demo/free tenants stay sandbox even with a fully-populated inboxKitConfig supplied (plan check dominates, ARCHITECTURE.md #8)", () => {
    const bundle = createVendorAdapters("demo", clock, true, undefined, INBOXKIT_CONFIG);
    expect(bundle.kind).toBe("sandbox");
    expect(bundle.mailbox).toBeInstanceOf(SandboxMailboxPort);
  });

  it("activated=false (unpaid/frozen tenant) keeps sandbox even with inboxKitConfig supplied", () => {
    const bundle = createVendorAdapters("launch", clock, false, undefined, INBOXKIT_CONFIG);
    expect(bundle.kind).toBe("sandbox");
  });

  it("positive control: supplying inboxKitConfig on an activated+paid bundle DOES wire RealInboxKitDomainPort — proves the gate is config-driven, not a dead/always-false branch", () => {
    const bundle = createVendorAdapters("launch", clock, true, undefined, INBOXKIT_CONFIG);
    expect(bundle.kind).toBe("real");
    expect(bundle.domain).toBeInstanceOf(RealInboxKitDomainPort);
  });
});
