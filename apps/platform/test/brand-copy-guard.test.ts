import { describe, expect, it } from "vitest";
// Raw-text imports (Vite `?raw`, resolved at bundle time) — the workers-pool
// test runtime has no general filesystem access, so a runtime readFileSync
// against a source path 404s; `?raw` bakes each file's text in as a string.
import demoSeedSource from "../src/engine/demo-seed.ts?raw";
import stripeClientSource from "../src/billing/stripe-client.ts?raw";

// Brand class-sweep (2026-07-22, founder ORDER, ROADMAP.md): the retired
// internal working name (the frozen ROADMAP/HANDOFF entries for this sweep
// spell it out; this guard deliberately does not, so editing this file can
// never itself trip the check) must never render on a customer-visible
// surface again — the Stripe checkout product name and the free-sandbox
// demo inbox's synthetic lead addresses both being confirmed instances.
//
// This is a systemic guard, not a repo-wide text linter: it enumerates the
// SPECIFIC source files that build customer-visible strings, so a future
// change to either file that reintroduces the retired name fails loudly here
// instead of silently shipping to a real customer's checkout or demo inbox.
// Add a new `[label, rawSource]` entry whenever a new customer-visible
// surface is built.
const RETIRED_BRAND_NAME = "Cold" + "Start";

const CUSTOMER_VISIBLE_SURFACE: ReadonlyArray<readonly [string, string]> = [
  ["src/billing/stripe-client.ts (Stripe checkout product name)", stripeClientSource],
  ["src/engine/demo-seed.ts (free-sandbox demo inbox lead addresses)", demoSeedSource],
];

describe("brand-copy reintroduction guard", () => {
  it.each(CUSTOMER_VISIBLE_SURFACE)("%s never reintroduces the retired brand name", (_label, source) => {
    expect(source).not.toContain(RETIRED_BRAND_NAME);
  });
});
