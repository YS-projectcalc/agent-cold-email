import { readFileSync } from "node:fs";

/**
 * Load a JSON-file-backed durable state file with FAIL-LOUD corruption handling,
 * shared by every engine durable store (the send/thread snapshot in store.ts, the
 * pushed-credential store in mailbox-store.ts). MISSING -> `emptyValue` (a normal
 * first boot). CORRUPT (exists but unreadable-for-a-reason-other-than-absence, or
 * invalid JSON, or not a JSON object) -> THROW, so the daemon refuses to start
 * rather than silently discarding durable state and then overwriting the only copy
 * of it on the next flush. `project` narrows a partially-shaped parse into the
 * concrete state (and, for the snapshot, defaults a v1 shape's absent
 * parked/danglings to empty — backward compatible).
 */
export function loadJsonStateFile<T>(
  filePath: string,
  emptyValue: T,
  label: string,
  project: (parsed: Record<string, unknown>) => T,
): T {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(emptyValue);
    // A read error that is NOT "file absent" (permissions, I/O) is a real fault,
    // not a first boot — fail loud rather than masquerade as an empty store.
    throw new Error(`${label} file ${filePath} is unreadable — refusing to start: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${label} file ${filePath} is corrupt (invalid JSON) — refusing to start empty, which would silently drop durable state and overwrite the only copy on the next write. Repair or quarantine the file. Parse error: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} file ${filePath} is corrupt (not a JSON object) — refusing to start empty.`);
  }
  return project(parsed as Record<string, unknown>);
}
