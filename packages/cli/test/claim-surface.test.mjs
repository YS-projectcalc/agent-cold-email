// Claim-surface guard: the CLI's built output (help text, `demo`'s closing
// line, every command module) and its README must never regress to the
// retired pre-launch framing (real sending is NOT early-access/waitlist-gated
// — it and live Stripe billing have been in production since 2026-07-19/22),
// and must keep stating the CURRENT managed-plan pricing, not the retired
// three-tier Launch/Growth/Scale ladder. Scans the BUILT dist/ output (never
// src/) plus README.md, since dist+README.md are exactly what ships to npm
// (package.json "files").

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CLI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_DIR = path.join(CLI_ROOT, "dist");
const README_PATH = path.join(CLI_ROOT, "README.md");

function readAllJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readAllJs(full));
    else if (entry.name.endsWith(".js")) out.push({ file: path.relative(DIST_DIR, full), text: readFileSync(full, "utf8") });
  }
  return out;
}

const distFiles = readAllJs(DIST_DIR);
const readmeText = readFileSync(README_PATH, "utf8");

const RETIRED_PATTERNS = [
  { name: "waitlist", re: /waitlist/i },
  { name: "early-access", re: /early[- ]access/i },
  { name: "once it's available", re: /once it'?s available/i },
  { name: "not active yet", re: /not active yet/i },
  { name: "coming soon", re: /coming soon/i },
];

test("no dist/ command module contains retired pre-launch framing", () => {
  assert.ok(distFiles.length > 0, "expected a built dist/ (run `npm run build` first)");
  for (const { file, text } of distFiles) {
    for (const { name, re } of RETIRED_PATTERNS) {
      assert.doesNotMatch(text, re, `dist/${file} still contains retired "${name}" framing`);
    }
  }
});

test("demo's closing line describes the real current funnel (checkout -> Stripe), not the retired waitlist", () => {
  const demo = distFiles.find((f) => f.file === "commands/demo.js");
  assert.ok(demo, "expected dist/commands/demo.js to exist");
  assert.match(demo.text, /checkout/i, "demo closing text should point at the checkout tool");
  assert.match(demo.text, /stripe/i, "demo closing text should mention Stripe");
});

test("README.md has no retired pre-launch framing and no retired tiered pricing", () => {
  // "waitlist" alone is skipped here: README's Pricing section legitimately
  // says the free `demo` command needs "no signup, no card, no waitlist" —
  // true before AND after the fix, since the demo never required joining
  // one. What's retired is the CTA to join a waitlist to unlock real
  // sending, checked explicitly below.
  for (const { name, re } of RETIRED_PATTERNS) {
    if (name === "waitlist") continue;
    assert.doesNotMatch(readmeText, re, `README.md still contains retired "${name}" framing`);
  }
  assert.doesNotMatch(readmeText, /join the waitlist/i, "README.md still tells readers to join a waitlist for real sending");
  // Retired 3-tier Launch/Growth/Scale $99/$299/$799 ladder.
  assert.doesNotMatch(readmeText, /\bgrowth\b/i, "README.md still names the retired Growth tier");
  assert.doesNotMatch(readmeText, /\bscale\b/i, "README.md still names the retired Scale tier");
  assert.doesNotMatch(readmeText, /\$299|\$799/, "README.md still quotes a retired tier price");
  // Current managed-plan pricing must still be present.
  assert.match(readmeText, /\$99/, "README.md should state the current $99/mo starting price");
  assert.match(readmeText, /5 provisioned\s+mailboxes|5-mailbox minimum/i, "README.md should state the current 5-mailbox baseline");
  assert.match(readmeText, /\$10\/month per additional mailbox|\$10\/mailbox/i, "README.md should state the current +$10/additional-mailbox price");
});
