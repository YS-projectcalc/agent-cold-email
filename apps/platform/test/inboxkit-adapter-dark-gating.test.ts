import { RegistrarUnarmedError } from "@coldstart/shared";
import { describe, expect, it } from "vitest";
import { VirtualClock } from "../src/clock.js";
import { createVendorAdapters } from "../src/vendors/factory.js";
import { RegistrarUnarmedDomainPort } from "../src/vendors/real/domain-port.js";
import { RealInboxKitDomainPort } from "../src/vendors/real/inboxkit-domain-port.js";
import { SandboxMailboxPort } from "../src/vendors/sandbox/mailbox-port.js";

// Proves the InboxKit adapters built this pass (RealMailboxPort's real HTTP
// client + RealInboxKitDomainPort) are UNREACHABLE from the current build,
// mirroring demo-adapter-guard.test.ts / activation-gate.test.ts's style for
// the existing real/ adapters. No call site supplies `inboxKitConfig`
// (tenant-do.ts's 4-arg call) — every guard below forces the hypothetical
// "what if [I1's `activated` gate] were true" case and asserts the
// SANDBOX-by-default outcome still holds (mailbox needs BOTH `activated` AND
// `inboxKitConfig` to ever go real — factory.ts's doc comment), so a future
// accidental wiring change fails loudly here instead of at runtime against a
// live vendor.
//
// G5 gate (a) (ROADMAP.md:19,33,43; adversary B1 2026-07-23): the LAST test
// in this file used to be a "positive control" asserting that supplying
// `inboxKitConfig` alone DOES wire `RealInboxKitDomainPort` for domain — that
// was the B1 bug itself, enshrined as expected behavior (arming InboxKit for
// mailboxes silently also armed InboxKit-as-registrar). It's rewritten below
// to assert the FIXED behavior instead: `inboxKitConfig` alone must NEVER
// reach a real domain port — only a decoupled `registrarConfig` could, and
// even that adapter is deferred to the GA wave, so domain always hard-blocks.

const clock = new VirtualClock(Date.now(), 0, 1);
const INBOXKIT_CONFIG = { apiKey: "test-key", workspaceId: "00000000-0000-4000-8000-000000000001" };

describe("InboxKit adapters — unreachable from the current call-site shape", () => {
  it("the real tenant-do.ts call-site shape (no inboxKitConfig arg) keeps domain SANDBOX even if activated were hypothetically true", () => {
    const bundle = createVendorAdapters("launch", clock, true); // matches tenant-do.ts's 4-positional-arg call today (trailing args omitted)
    expect(bundle.kind).toBe("sandbox");
    expect(bundle.domain).not.toBeInstanceOf(RegistrarUnarmedDomainPort);
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

  it("mailbox still flips real with inboxKitConfig on an activated+paid bundle — proves the mailbox gate is config-driven, not a dead/always-false branch (mailbox is UNAFFECTED by gate (a))", () => {
    const bundle = createVendorAdapters("launch", clock, true, undefined, INBOXKIT_CONFIG);
    expect(bundle.kind).toBe("real");
    expect(bundle.mailbox).not.toBeInstanceOf(SandboxMailboxPort);
  });

  // R3-1 guard (G5 gate (a), adversary B1 2026-07-23) — THE fix this lane
  // ships. Before the fix, this exact scenario (inboxKitConfig armed,
  // NO registrarConfig at all) wired `RealInboxKitDomainPort` for domain,
  // i.e. real InboxKit-as-registrar spend reachable via `domain.buy` — the
  // failure this test must catch. Revert-fail-restore proof: temporarily
  // restoring the old welded factory logic makes this test go RED (quoted in
  // the build report); the fix below is what turns it GREEN.
  it("gate (a): inboxKitConfig armed alone (registrarConfig absent) NEVER wires a real domain port — domain.buy hard-blocks with RegistrarUnarmedError, not InboxKit-as-registrar", async () => {
    const bundle = createVendorAdapters("launch", clock, true, undefined, INBOXKIT_CONFIG);
    expect(bundle.kind).toBe("real");
    expect(bundle.domain).toBeInstanceOf(RegistrarUnarmedDomainPort);
    expect(bundle.domain).not.toBeInstanceOf(RealInboxKitDomainPort);
    await expect(bundle.domain.buy("evil-lookalike.com", "k1")).rejects.toBeInstanceOf(RegistrarUnarmedError);
  });
});
