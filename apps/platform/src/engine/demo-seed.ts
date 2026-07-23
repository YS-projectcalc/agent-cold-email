// Deterministic demo-lead + campaign-batch generation for POST /demo/run's
// optional `{leads, campaigns}` params (backend gaps brief item 3 / SPEC.md
// §0 — sandbox-only, zero real vendor spend). Pure functions, no ctx/clock/
// randomness — kept separate from engine/demo.ts's orchestration (CLAUDE.md
// rule b: one file, one responsibility) so the generation itself is
// independently unit-testable.

export type DemoLeadKind = "reply" | "bounce" | "ooo" | "silent";

export interface DemoLeadSeed {
  email: string;
  firstName: string;
  company: string;
  kind: DemoLeadKind;
}

// The platform's ORIGINAL canned demo set. subject-fidelity.test.ts hardcodes
// "Reply Co" as the replied lead's rendered subject's company — a bare POST
// /demo/run (leads defaulted to 3) must reproduce this byte-for-byte, never
// just "close enough".
const BASE_LEADS: readonly DemoLeadSeed[] = [
  { email: "morgan.reply@demo-leads.coldrig.dev", firstName: "Morgan", company: "Reply Co", kind: "reply" },
  { email: "casey.bounce@demo-leads.coldrig.dev", firstName: "Casey", company: "Bounce Co", kind: "bounce" },
  { email: "jordan.prospect@demo-leads.coldrig.dev", firstName: "Jordan", company: "Prospect Co", kind: "silent" },
];

const EXTRA_FIRST_NAMES = ["Alex", "Sam", "Riley", "Taylor", "Drew", "Jamie", "Quinn", "Avery", "Rowan", "Skyler"];
const EXTRA_COMPANIES = [
  "Nimbus Labs",
  "Vertex Robotics",
  "Solstice Analytics",
  "Anchor Freight",
  "Pinecrest Media",
  "Fathom Systems",
  "Meridian Foods",
  "Cobalt Studio",
  "Harborlight Group",
  "Brightline Energy",
];
const EXTRA_KIND_CYCLE: readonly DemoLeadKind[] = ["reply", "bounce", "ooo", "silent"];

// The sandbox EmailPort (vendors/sandbox/email-port.ts) classifies purely by
// local-part substring. "ooo" reuses the "reply" trigger — a real
// out-of-office IS an auto-reply — and is told apart from a genuinely
// interested reply only by the `out_of_office` label engine/demo.ts applies
// to its thread afterward, the same way a real customer agent would
// classify one, not by a separate EmailPort behavior.
function triggerFor(kind: DemoLeadKind): string {
  if (kind === "bounce") return "bounce";
  if (kind === "silent") return "prospect";
  return "reply"; // "reply" and "ooo" both need the sandbox's reply trigger
}

/**
 * Deterministic — the Nth lead for a given `count` is always the same across
 * calls/tenants (no Math.random, no clock read). `count <= BASE_LEADS.length`
 * slices the original canned set, so the default (3) reproduces it
 * byte-for-byte; beyond that, extra leads cycle through every kind so a
 * richer run shows real inbox variety.
 */
export function buildDemoLeads(count: number): DemoLeadSeed[] {
  if (count <= BASE_LEADS.length) return BASE_LEADS.slice(0, count);

  const leads = [...BASE_LEADS];
  for (let i = BASE_LEADS.length; i < count; i++) {
    const kind = EXTRA_KIND_CYCLE[i % EXTRA_KIND_CYCLE.length]!;
    const firstName = EXTRA_FIRST_NAMES[i % EXTRA_FIRST_NAMES.length]!;
    // A different stride than firstName's cycle so the (name, company)
    // pairing doesn't repeat in lockstep every EXTRA_FIRST_NAMES.length leads.
    const company = EXTRA_COMPANIES[(i * 3) % EXTRA_COMPANIES.length]!;
    leads.push({ email: `lead${i}.${triggerFor(kind)}@demo-leads.coldrig.dev`, firstName, company, kind });
  }
  return leads;
}

/**
 * Splits `items` into up to `campaignCount` near-even, order-preserving
 * batches (ceil-sized first batches, ordinary "divide the remainder" split —
 * deterministic, never an empty batch). Clamped down to `items.length` when
 * there are fewer items than campaigns requested. `campaignCount=1` returns
 * `[items]` unchanged, which is what keeps the default (1 campaign) path
 * IDENTICAL to the platform's original single-campaign runDemo().
 */
const FRIENDLY_CAMPAIGN_BASE_NAME = "Founder outreach";
const BATCH_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * M5 dashboard-polish defect D — a human-readable demo campaign name,
 * replacing the old `Demo run ${newId("run")}` (an opaque random id that
 * clipped/overflowed every chip and table column it appeared in). Purely a
 * display string: deterministic (no clock/randomness), so it carries the
 * same reproducibility guarantee as `buildDemoLeads`/
 * `splitIntoCampaignBatches` above. `totalBatches<=1` (the default
 * `campaigns=1` path) returns the bare base name — nothing in
 * test/demo-run.test.ts or test/subject-fidelity.test.ts asserts the
 * literal campaign name, so there is no byte-compat constraint here the way
 * there is for `buildDemoLeads`' lead set, but a bare name reads better than
 * an unconditional "— batch A" suffix when there's only one batch anyway.
 * `idx` wraps past 26 rather than throwing, even though POST /demo/run
 * bounds `campaigns` to 3.
 */
export function friendlyCampaignName(idx: number, totalBatches: number): string {
  if (totalBatches <= 1) return FRIENDLY_CAMPAIGN_BASE_NAME;
  const letter = BATCH_LETTERS[idx % BATCH_LETTERS.length] ?? "?";
  return `${FRIENDLY_CAMPAIGN_BASE_NAME} — batch ${letter}`;
}

export function splitIntoCampaignBatches<T>(items: T[], campaignCount: number): T[][] {
  const n = Math.min(Math.max(1, campaignCount), Math.max(1, items.length));
  const batches: T[][] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const remaining = n - i;
    const size = Math.ceil((items.length - start) / remaining);
    batches.push(items.slice(start, start + size));
    start += size;
  }
  return batches;
}
