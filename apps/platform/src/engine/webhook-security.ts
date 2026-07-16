// Webhook delivery SECURITY boundary — the adversary attacks exactly here.
// Three concerns: (1) validate a subscription URL at registration AND
// re-validate at every delivery (DNS-rebinding posture), rejecting non-https
// and any host that is (or is written as) a private/loopback/link-local/
// carrier-grade-NAT/metadata IP; (2) sign each delivery body with HMAC-SHA256
// so the consumer can verify authenticity; (3) fetch with a strict timeout, no
// redirect following, and never store more than a truncated response snippet.
//
// Platform note (honest, documented in SPEC.md): a Cloudflare Worker has NO DNS
// resolver API, so a HOSTNAME cannot be resolved-then-checked in-process — that
// is the known residual, additionally contained by the runtime's public egress
// being unable to route to RFC1918/link-local space. What this module DOES
// cover, exhaustively as far as the checks below reach: non-https / credentialed
// / non-443 URLs; private/loopback/link-local/CGNAT/metadata IPv4 literals in
// every encoding `new URL` normalizes (decimal/octal/hex/integer -> dotted
// quad); the same ranges reached via IPv4-embedded IPv6 (mapped ::ffff:/96,
// IPv4-compatible ::/96, NAT64 64:ff9b::/96, 6to4 2002::/16 — decoded to the
// embedded v4 and re-checked); IPv6 loopback/link-local/ULA/multicast; and non-public hostname
// shapes (localhost, single-label, .local/.internal/.home.arpa, trailing dot).
// It does NOT claim to catch a private IP reached only via DNS resolution of a
// public-looking hostname. Re-validation at delivery time catches a subscription
// row mutated after creation.

import { ValidationError } from "@coldstart/shared";

export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;
export const WEBHOOK_SNIPPET_MAX = 512;

export interface DeliveryTarget {
  url: string;
  secret: string;
}

export interface DeliveryOutcome {
  ok: boolean;
  statusCode: number | null;
  snippet: string;
  /** Stable, non-sensitive failure tag (never contains the secret/body). */
  error?: string;
}

/** A pluggable deliverer so the queue pump can be driven with a fake in tests
 *  (no live network) while production wires `realWebhookDeliverer`. */
export type WebhookDeliverer = (
  target: DeliveryTarget,
  rawBody: string,
  headers: Record<string, string>,
) => Promise<DeliveryOutcome>;

/**
 * Validates + returns a parsed webhook URL, or throws ValidationError (mapped
 * to HTTP 400 by the Worker's onError). Applied at create/update AND re-applied
 * before every delivery. `new URL()` normalizes IPv4 written in decimal/octal/
 * hex or as a bare integer to dotted-quad form, so the literal-IP check below
 * sees `127.0.0.1` whether the caller wrote `0x7f000001`, `2130706433`, or
 * `0177.0.0.1` — the encoding-evasion class is closed by normalization.
 */
export function assertSafeWebhookUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError("webhook url must be a valid absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new ValidationError("webhook url must use https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ValidationError("webhook url must not embed credentials");
  }
  // Only the default https port — a custom port is a common pivot onto an
  // internal service and a legitimate public webhook never needs one.
  if (url.port !== "" && url.port !== "443") {
    throw new ValidationError("webhook url must use the default https port (443)");
  }
  const reason = disallowedHostReason(url.hostname);
  if (reason) throw new ValidationError(`webhook url host is not allowed: ${reason}`);
  return url;
}

/** Returns a reason string if the host is private/reserved/non-public, else null. */
function disallowedHostReason(hostnameRaw: string): string | null {
  // Strip ALL trailing dots: `localhost.` / `localhost..` / `127.0.0.1.` are
  // fully-qualified forms of the same host and must not slip past the name/
  // literal checks below (a single-dot strip left `localhost..` -> `localhost.`,
  // still bypassing). A bracketed IPv6 literal never carries an outer trailing dot.
  const hostname = hostnameRaw.toLowerCase().replace(/\.+$/, "");
  // IPv6 literal — WHATWG URL keeps the brackets on `url.hostname`.
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return disallowedIpv6Reason(hostname.slice(1, -1));
  }
  // IPv4 dotted-quad literal (post-normalization form for every IPv4 encoding).
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return disallowedIpv4Reason(hostname);
  }
  // A hostname. We cannot resolve DNS in a Worker; reject the shapes that are
  // never a legitimate public endpoint and are the usual SSRF pivots.
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return "localhost";
  if (hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) {
    return "non-public TLD";
  }
  if (!hostname.includes(".")) return "single-label / non-FQDN host";
  return null;
}

function disallowedIpv4Reason(ip: string): string | null {
  const octets = ip.split(".").map((o) => Number(o));
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return "malformed IPv4 literal";
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return "reserved (0.0.0.0/8)";
  if (a === 10) return "private (10.0.0.0/8)";
  if (a === 127) return "loopback (127.0.0.0/8)";
  if (a === 169 && b === 254) return "link-local / cloud metadata (169.254.0.0/16)";
  if (a === 172 && b >= 16 && b <= 31) return "private (172.16.0.0/12)";
  if (a === 192 && b === 168) return "private (192.168.0.0/16)";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT (100.64.0.0/10)";
  if (a === 192 && b === 0) return "reserved (192.0.0.0/24)";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking (198.18.0.0/15)";
  if (a >= 224) return "reserved multicast/future (>=224.0.0.0/3)";
  return null;
}

function disallowedIpv6Reason(ip: string): string | null {
  const bytes = parseIpv6ToBytes(ip.toLowerCase());
  // `url.hostname` only contained this via `[...]`, so `new URL` already proved
  // it a syntactically valid IPv6; an unexpected parse miss is not silently
  // allowed as a public host — reject conservatively.
  if (!bytes) return "unparseable IPv6 literal";

  if (bytes.every((b) => b === 0)) return "unspecified (::)";
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return "loopback (::1)";
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return "link-local (fe80::/10)";
  if ((bytes[0]! & 0xfe) === 0xfc) return "unique-local (fc00::/7)";
  if (bytes[0] === 0xff) return "multicast (ff00::/8)";

  // Any IPv6 that EMBEDS an IPv4 in its low 32 bits — IPv4-mapped ::ffff:/96,
  // IPv4-compatible ::/96, or NAT64 well-known 64:ff9b::/96 — gets its embedded
  // v4 pulled out and run through the FULL v4 rejection set. One path closes
  // every private/link-local/loopback v4 hidden behind any of these prefixes,
  // not just the specific literals an attacker happened to try.
  const high12Zero = bytes.slice(0, 12).every((b) => b === 0); // ::/96 (IPv4-compatible)
  const isMapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff; // ::ffff:/96
  const isNat64 =
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((b) => b === 0); // 64:ff9b::/96
  if (high12Zero || isMapped || isNat64) {
    const v4reason = disallowedIpv4Reason(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
    if (v4reason) return `IPv4-embedded IPv6 ${v4reason}`;
  }
  // 6to4 `2002::/16` embeds the v4 in bytes 2-5 (a routing PREFIX, not the low
  // 32 bits) — a structurally different extraction. RFC-7526-deprecated, closed
  // anyway for defense-in-depth (don't rely on the relay being unreachable).
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    const v4reason = disallowedIpv4Reason(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`);
    if (v4reason) return `6to4-embedded IPv6 ${v4reason}`;
  }
  return null;
}

/** Expands an IPv6 literal (already lower-cased, WHATWG-normalized, brackets
 *  stripped) to its 16 bytes, or null if it can't be parsed. Handles a single
 *  `::` zero-compression and a trailing dotted-quad IPv4 group. */
function parseIpv6ToBytes(str: string): number[] | null {
  const halves = str.split("::");
  if (halves.length === 1) {
    const bytes = ipv6HalfToBytes(halves[0]!);
    return bytes && bytes.length === 16 ? bytes : null;
  }
  if (halves.length === 2) {
    const head = ipv6HalfToBytes(halves[0]!);
    const tail = ipv6HalfToBytes(halves[1]!);
    if (!head || !tail) return null;
    const fill = 16 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...new Array<number>(fill).fill(0), ...tail];
  }
  return null; // more than one "::" is invalid
}

function ipv6HalfToBytes(part: string): number[] | null {
  if (part === "") return [];
  const tokens = part.split(":");
  const out: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.includes(".")) {
      if (i !== tokens.length - 1) return null; // a dotted IPv4 group is only valid last
      const octets = tok.split(".");
      if (octets.length !== 4) return null;
      for (const o of octets) {
        if (!/^\d{1,3}$/.test(o)) return null;
        const n = Number(o);
        if (n > 255) return null;
        out.push(n);
      }
    } else {
      if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
      const v = parseInt(tok, 16);
      out.push((v >> 8) & 0xff, v & 0xff);
    }
  }
  return out;
}

/** Hex HMAC-SHA256 of `body` under `secret` — the signature scheme documented
 *  for consumers (verify: recompute over the RAW request body, compare to the
 *  hex after `sha256=` in X-Coldrig-Signature, constant-time). */
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reads at most `max` chars of a response body without materializing a huge
 *  one: pulls from the stream and stops early. A missing/again-unreadable body
 *  yields "". */
async function readCappedText(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  try {
    while (out.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } catch {
    // A truncated/broken body is not a delivery outcome — return what we have.
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.slice(0, max);
}

/**
 * Production deliverer: re-validate (SSRF/rebinding), sign, POST with a strict
 * timeout and NO redirect following, capture only a truncated snippet. Never
 * throws — every failure mode returns a DeliveryOutcome the pump can grade.
 * A 2xx is success; a 3xx is a refused redirect; anything else (4xx/5xx,
 * timeout, network error, or a URL that no longer validates) is a retryable
 * failure. The secret is used only to sign — it is never returned or logged.
 */
export async function realWebhookDeliverer(
  target: DeliveryTarget,
  rawBody: string,
  headers: Record<string, string>,
): Promise<DeliveryOutcome> {
  let url: URL;
  try {
    url = assertSafeWebhookUrl(target.url);
  } catch (err) {
    return { ok: false, statusCode: null, snippet: "", error: `url_rejected: ${err instanceof Error ? err.message : "invalid"}` };
  }

  const signature = await hmacSha256Hex(target.secret, rawBody);
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(WEBHOOK_DELIVERY_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "user-agent": "coldrig-webhooks/1",
        "X-Coldrig-Signature": `sha256=${signature}`,
        ...headers,
      },
      body: rawBody,
    });
    const snippet = await readCappedText(res, WEBHOOK_SNIPPET_MAX);
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, statusCode: res.status, snippet };
    }
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, statusCode: res.status, snippet, error: "redirect_not_followed" };
    }
    return { ok: false, statusCode: res.status, snippet, error: `http_${res.status}` };
  } catch (err) {
    // Timeout (AbortError / TimeoutError) or any network failure.
    return { ok: false, statusCode: null, snippet: "", error: err instanceof Error ? err.name : "fetch_error" };
  }
}
