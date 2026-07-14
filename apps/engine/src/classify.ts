import { simpleParser } from "mailparser";
import type { PolledEvent } from "@coldstart/shared";

/**
 * PURE classification of one raw inbound RFC 5322 message into the EmailPort's
 * PolledEvent shape (or null when it isn't attributable to a known thread). This
 * is the engine's contract core and is unit-tested against real RFC 3464 / RFC
 * 5965 fixtures — no network. The routing decision reads RAW headers (more
 * faithful than a library's normalized view for structured headers — the A5
 * spike finding); the reply's From/body come from mailparser.
 *
 *   multipart/report; report-type=delivery-status -> bounce (5.x.x hard / 4.x.x soft)
 *   multipart/report; report-type=feedback-report -> complaint (RFC 5965 ARF)
 *   In-Reply-To/References resolving to a known send -> reply
 *   anything else -> null (silently ignored, matching the sandbox's "silence")
 */
export type ThreadResolver = (originalMessageId: string) => string | undefined;

export async function classifyMessage(
  source: string,
  mailboxEmail: string,
  resolveThread: ThreadResolver,
  receivedAt: number,
): Promise<PolledEvent | null> {
  const contentType = rawHeader(source, "Content-Type") ?? "";
  const isReport = /multipart\/report/i.test(contentType);

  if (isReport && /report-type=\s*"?delivery-status/i.test(contentType)) {
    return classifyBounce(source, mailboxEmail, resolveThread, receivedAt);
  }
  if (isReport && /report-type=\s*"?feedback-report/i.test(contentType)) {
    return classifyComplaint(source, mailboxEmail, resolveThread, receivedAt);
  }
  return classifyReply(source, mailboxEmail, resolveThread, receivedAt);
}

function classifyBounce(
  source: string,
  mailboxEmail: string,
  resolveThread: ThreadResolver,
  receivedAt: number,
): PolledEvent | null {
  const resolved = resolveOriginal(source, resolveThread);
  if (!resolved) return null; // can't attribute -> drop (Worker would drop it too)

  // RFC 3464 enhanced status: 5.x.x = permanent (hard), 4.x.x = transient (soft).
  // Missing/unparseable status defaults to SOFT — never wrongly permanent-
  // suppress an address on an ambiguous DSN (the exact A5 severity-blind defect).
  const statusMatch = source.match(/^Status:\s*([245])\.(\d+)\.(\d+)/im);
  const statusClass = statusMatch ? Number(statusMatch[1]) : 4;
  const severity: "hard" | "soft" = statusClass === 5 ? "hard" : "soft";
  const diag = source.match(/^Diagnostic-Code:\s*(.+)$/im)?.[1]?.trim();
  const reason = statusMatch
    ? `${severity} bounce ${statusMatch[1]}.${statusMatch[2]}.${statusMatch[3]}${diag ? ` ${diag}` : ""}`
    : `${severity} bounce (no enhanced status)`;

  return {
    kind: "bounce",
    mailboxEmail,
    threadId: resolved.threadId,
    originalMessageId: resolved.originalMessageId,
    // Final-Recipient lives in the message/delivery-status MIME PART, not the
    // outer header block — scan the whole source, not rawHeader().
    toEmail: bodyFieldValue(source, "Final-Recipient")?.replace(/^rfc822;\s*/i, "").trim() ?? "",
    reason,
    severity,
    receivedAt,
  };
}

function classifyComplaint(
  source: string,
  mailboxEmail: string,
  resolveThread: ThreadResolver,
  receivedAt: number,
): PolledEvent | null {
  const resolved = resolveOriginal(source, resolveThread);
  if (!resolved) return null;
  return {
    kind: "complaint",
    mailboxEmail,
    threadId: resolved.threadId,
    originalMessageId: resolved.originalMessageId,
    // Original-Rcpt-To lives in the message/feedback-report MIME part (RFC
    // 5965), not the outer header block — scan the whole source.
    toEmail: bodyFieldValue(source, "Original-Rcpt-To")?.trim() ?? rawHeader(source, "To")?.trim() ?? "",
    receivedAt,
  };
}

async function classifyReply(
  source: string,
  mailboxEmail: string,
  resolveThread: ThreadResolver,
  receivedAt: number,
): Promise<PolledEvent | null> {
  const resolved = resolveOriginal(source, resolveThread);
  if (!resolved) return null; // not a reply to any send we know -> ignore
  const parsed = await simpleParser(source);
  const messageId = parsed.messageId ?? rawHeader(source, "Message-ID") ?? "";
  if (!messageId) return null; // no stable dedupe key -> can't safely emit
  const fromEmail = parsed.from?.value?.[0]?.address ?? "";
  return {
    kind: "reply",
    mailboxEmail,
    threadId: resolved.threadId,
    messageId,
    fromEmail,
    body: parsed.text ?? "",
    receivedAt,
  };
}

/**
 * Recover the ORIGINAL send's Message-ID + threadId a report/reply refers to.
 * Tries, in order: the In-Reply-To header, the References chain (newest first),
 * and every Message-ID that appears in a returned rfc822-headers part (a DSN/ARF
 * echoes the original's headers). The first candidate that resolves to a known
 * thread wins.
 */
function resolveOriginal(
  source: string,
  resolveThread: ThreadResolver,
): { originalMessageId: string; threadId: string } | undefined {
  const candidates: string[] = [];
  const inReplyTo = rawHeader(source, "In-Reply-To");
  if (inReplyTo) candidates.push(inReplyTo.trim());
  const references = rawHeader(source, "References");
  if (references) {
    const ids = references.match(/<[^>]+>/g) ?? [];
    for (let i = ids.length - 1; i >= 0; i--) candidates.push(ids[i]!);
  }
  // Every Message-ID in the source EXCEPT the report's own (the first one).
  const allIds = source.match(/^Message-ID:\s*(<[^>]+>)/gim)?.map((l) => l.replace(/^Message-ID:\s*/i, "").trim()) ?? [];
  for (let i = 1; i < allIds.length; i++) candidates.push(allIds[i]!);

  for (const id of candidates) {
    const threadId = resolveThread(id);
    if (threadId) return { originalMessageId: id, threadId };
  }
  return undefined;
}

/**
 * Extract a machine-report field (Status, Final-Recipient, Original-Rcpt-To,
 * ...) that lives in a MIME sub-part of a DSN/ARF report rather than the outer
 * header block — a line-anchored scan over the WHOLE source. Returns the first
 * match's value.
 */
function bodyFieldValue(source: string, name: string): string | undefined {
  const re = new RegExp(`^${name}:\\s*(.+)$`, "im");
  return source.match(re)?.[1]?.trim();
}

/**
 * Extract a header from the RAW RFC 5322 source, unfolding continuation lines —
 * the A5 spike's approach (a library's normalized view hides the wire value of
 * structured headers like List-Unsubscribe/References).
 */
export function rawHeader(source: string, name: string): string | undefined {
  const headerBlock = source.split(/\r?\n\r?\n/)[0] ?? "";
  const lines = headerBlock.split(/\r?\n/);
  const re = new RegExp(`^${name}:`, "i");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) {
      let val = lines[i]!.slice(lines[i]!.indexOf(":") + 1).trim();
      let j = i + 1;
      while (j < lines.length && /^[ \t]/.test(lines[j]!)) {
        val += " " + lines[j]!.trim();
        j++;
      }
      return val;
    }
  }
  return undefined;
}
