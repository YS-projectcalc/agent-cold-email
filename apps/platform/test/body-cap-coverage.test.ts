import { describe, expect, it } from "vitest";
import validateSource from "../src/validate.ts?raw";

// Failing-by-construction guard for the request-body cap class
// (audit-stripe-webhook-2026-08-06.md finding 7), in the same spirit as
// spend-armed-env-coverage.test.ts: the FIX is in the code, but nothing stops
// the next route reopening the class, and the reopened version LOOKS capped.
//
// The class: every body-reading site checked the DECLARED `content-length`.
// A chunked/streamed request carries none, so `Number(undefined)` is NaN,
// `Number.isFinite` is false, and the cap is skipped while the whole body is
// materialised anyway. It reached every one of them by copy — the audit found
// it on the Stripe webhook, and the same four lines sat in validate.ts's
// `parseJsonBody` (25 call sites, including the unauthenticated /signup and
// /api/waitlist), routes/lifecycle.ts, routes/mcp.ts and
// routes/admin-sdn-ingest.ts, with routes/demo.ts reading a body under no cap
// at all.
//
// The rule this pins: `readTextBodyWithCap` (validate.ts) is the ONLY sanctioned
// way to read a request body. Anything else — `c.req.text()`, `c.req.json()`,
// `c.req.parseBody()`, `c.req.arrayBuffer()`, or reaching into `c.req.raw.body`
// directly — is uncapped by construction, so the guard bans them outright
// rather than trying to prove a cap sits nearby.

const routeSources = import.meta.glob("../src/routes/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const otherBodyReaders = import.meta.glob("../src/{mcp,ofac,admin}/*.ts", { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;
/**
 * Comments out. A guard that scans raw source text otherwise fires on PROSE:
 * the first run of this file flagged login.ts, mcp.ts and validate.ts, all three
 * for the string `c.req.json()` inside a comment explaining why it is not used.
 * A guard with false positives gets weakened by the next person who hits one.
 * Quote-state tracking keeps `//` inside a string literal (a URL) from cutting
 * the line.
 */
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote) {
          if (ch === "\\") i++;
          else if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'" || ch === "`") {
          quote = ch;
        } else if (ch === "/" && line[i + 1] === "/") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

const scanned: Record<string, string> = Object.fromEntries(
  Object.entries({ ...routeSources, ...otherBodyReaders, "../src/validate.ts": validateSource }).map(([path, source]) => [
    path,
    stripComments(source),
  ]),
);

/** Hono body accessors that read the WHOLE body with no size bound. */
const UNCAPPED_BODY_READS = /c\.req\.(text|json|parseBody|arrayBuffer|blob|formData)\s*\(/;
/** The raw stream. Legitimate in exactly one place: the capped reader itself. */
const RAW_BODY_ACCESS = /c\.req\.raw\.body/;

describe("no route may read a request body without the byte-counting cap", () => {
  it("sees the real sources (guard is not vacuously green)", () => {
    // A broken glob would make every assertion below pass while checking
    // nothing — the exact failure mode a coverage guard has to rule out first.
    expect(Object.keys(routeSources).length).toBeGreaterThan(15);
    expect(Object.keys(routeSources).some((p) => p.includes("webhooks.ts"))).toBe(true);
    expect(Object.keys(otherBodyReaders).some((p) => p.includes("handler.ts"))).toBe(true);
    expect(validateSource).toContain("export async function readTextBodyWithCap");
  });

  it("no source calls an uncapped Hono body accessor", () => {
    const offenders = Object.entries(scanned)
      .filter(([, source]) => UNCAPPED_BODY_READS.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("only the capped reader touches the raw body stream", () => {
    const offenders = Object.entries(scanned)
      .filter(([path, source]) => RAW_BODY_ACCESS.test(source) && !path.endsWith("validate.ts"))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("every route that reads a body pairs the capped read with the declared-length fast path", () => {
    // Both halves earn their place: the declared check rejects an honest
    // oversized client without touching the stream, the capped read is what a
    // chunked client cannot slip past. A route with only the fast path is the
    // original bug.
    const missingFastPath = Object.entries(scanned)
      .filter(([path, source]) => source.includes("readTextBodyWithCap(c,") && !path.endsWith("validate.ts"))
      .filter(([, source]) => !source.includes("declaresOverCap(c,"))
      .map(([path]) => path);
    expect(missingFastPath).toEqual([]);
  });

  it("routes/unsubscribe.ts is the ONE reasoned exception — it reads no body at all", () => {
    // RFC 8058 one-click POST: the signed token is in the query string, so the
    // body is never read. Measuring it would mean CONSUMING bytes this route
    // otherwise ignores — more parse cost, not less. Not reading beats capping,
    // so it keeps the declared-length courtesy check and nothing more. If this
    // route ever starts reading its body, the first two assertions above catch
    // it, and this one documents why the exception was granted.
    const source = scanned["../src/routes/unsubscribe.ts"];
    expect(source).toBeDefined();
    expect(source).toContain("declaresOverCap(c,");
    expect(source).not.toContain("readTextBodyWithCap");
  });
});
