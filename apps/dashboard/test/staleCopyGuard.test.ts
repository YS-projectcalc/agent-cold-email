import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

// Second addendum (live customer-agent finding, 2026-07-27): an external
// agent quoted SignupPage's stale "Real sending and paid infrastructure are
// not active yet" verbatim — false since 07-19 (billing live, real sending
// prod-proven). The truthful state is now the ONE SandboxBanner message
// ("Sandbox mode — sends are simulated · Go live"), so no dashboard surface
// may ALSO claim the platform-wide capability doesn't exist yet.
const FORBIDDEN_PHRASES = [/not active yet/i, /early access/i, /join the waitlist/i];

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe("dashboard source — no stale activation-status copy", () => {
  it("contains none of the retired 'not active yet' / 'early access' / 'join the waitlist' phrases anywhere in src/", async () => {
    const files = await walk(srcDir);
    const violations: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const phrase of FORBIDDEN_PHRASES) {
        if (phrase.test(content)) violations.push(`${file}: matches ${phrase}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
