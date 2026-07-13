#!/usr/bin/env node
// SPEC.md §19.1: "`dangerouslySetInnerHTML` is banned outside the two
// sanctioned sinks above (CI grep guard)." Two raw-HTML sinks now exist:
// (1) agent_note markdown via `dangerouslySetInnerHTML` (M2), (2) email
// message HTML via `iframe[srcdoc]` (M3, inbox/EmailHtmlFrame.tsx) — srcdoc
// is the SAME class of risk (a raw-HTML sink) even though it isn't the
// `dangerouslySetInnerHTML` API, so it gets its own needle/sink pair below
// rather than being silently unguarded. Wired into .github/workflows/ci.yml.
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

// Each pair: a raw-HTML sink API (JSX-attribute usage form, not the bare
// identifier — so a doc comment that merely NAMES the API, e.g. lib/
// sanitize.ts's own explainer, doesn't false-positive this guard) and the
// ONE file allowed to use it.
const SINKS = [
  { needle: "dangerouslySetInnerHTML=", sink: "src/widgets/AgentNote.tsx" },
  { needle: "srcDoc={", sink: "src/inbox/EmailHtmlFrame.tsx" },
];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const files = await walk(srcDir);
const violations = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  const rel = relative(join(here, ".."), file).split("\\").join("/");
  for (const { needle, sink } of SINKS) {
    if (content.includes(needle) && rel !== sink) violations.push(`${rel} (uses ${needle.replace(/=\{?$/, "")})`);
  }
}

if (violations.length > 0) {
  console.error(`Raw-HTML sink found outside its sanctioned file:`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error(`Sanctioned sinks: ${SINKS.map((s) => `${s.sink} (${s.needle})`).join(", ")}`);
  process.exit(1);
}

console.log(`OK — raw-HTML sinks only appear in their sanctioned file(s): ${SINKS.map((s) => s.sink).join(", ")}.`);
