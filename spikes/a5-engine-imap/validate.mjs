// A5 engine spike — validates the ColdStart EmailPort contract
// (packages/shared/src/vendor-ports.ts) against a REAL local SMTP+IMAP server
// (GreenMail in Docker). Proves the send/reply/bounce/thread/unsub assumptions
// the real engine adapter will rely on, BEFORE the VendorPort interface freezes.
//
// The five contract behaviors, each mapped to the sandbox EmailPort behavior it
// stands in for:
//   1. SMTP send            <- SandboxEmailPort.send returns { messageId }
//   2. IMAP reply detection <- SandboxEmailPort.poll returns a PolledReply
//   3. Threading            <- PolledReply.threadId / PolledBounce.threadId
//   4. Bounce classification<- PolledBounce { originalMessageId, reason }
//   5. List-Unsubscribe     <- (no field on SendEmailInput today — see findings)
//
// $0, local containers only. Nothing here touches production code or the root
// workspace; this package is deliberately outside the workspace globs.

import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const SMTP_PORT = 3025;
const IMAP_PORT = 3143;
const HOST = "127.0.0.1";
const DOMAIN = "coldstart.test";
const SENDER = `sender@${DOMAIN}`;
const LEAD = `lead@${DOMAIN}`;

// ---- tiny assert/report harness ----------------------------------------------
const results = [];
function record(behavior, verdict, evidence) {
  results.push({ behavior, verdict, evidence });
}
function ok(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`   [PASS] ${msg}`);
}
function line(label, val) {
  console.log(`   ${label}: ${val}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function smtp() {
  return nodemailer.createTransport({
    host: HOST,
    port: SMTP_PORT,
    secure: false,
    ignoreTLS: true,
    tls: { rejectUnauthorized: false },
  });
}

async function imap(user) {
  const client = new ImapFlow({
    host: HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user, pass: "any-password-auth-is-disabled" },
    logger: false,
    // GreenMail's plain IMAP (3143) does not advertise STARTTLS; stay plaintext.
    tls: { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}

// Fetch every message in a mailbox as parsed objects, retrying briefly so we
// don't race SMTP->IMAP delivery. Returns the raw source too (for DSN parsing).
// Poll a mailbox over IMAP, retrying to absorb SMTP->IMAP delivery latency.
// `matchMessageId` makes the fetch robust to a pre-existing/dirty inbox (so the
// spike re-runs without a container restart): it waits until the exact message
// it just sent has arrived, matched by Message-ID rather than by position.
async function fetchAll(user, { minCount = 1, matchMessageId = null } = {}) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const client = await imap(user);
    const lock = await client.getMailboxLock("INBOX");
    const out = [];
    try {
      for await (const msg of client.fetch("1:*", { uid: true, source: true })) {
        const parsed = await simpleParser(msg.source);
        out.push({ uid: msg.uid, source: msg.source.toString("utf8"), parsed });
      }
    } finally {
      lock.release();
      await client.logout();
    }
    const matched = matchMessageId ? out.some((m) => m.parsed.messageId === matchMessageId) : true;
    if (out.length >= minCount && matched) return out;
    await sleep(300);
  }
  throw new Error(
    `timed out waiting for ${matchMessageId ?? `>=${minCount} message(s)`} in ${user} inbox`,
  );
}

// Extract a header from the RAW RFC 5322 source, unfolding continuation lines.
// This is exactly what a real EmailPort adapter does (fetch raw over IMAP, parse
// headers) and it is more faithful than trusting a library's normalized view —
// mailparser folds/structures some headers (e.g. List-Unsubscribe) in ways that
// hide the wire value we are trying to prove survived.
function rawHeader(source, name) {
  const headerBlock = source.split(/\r?\n\r?\n/)[0];
  const lines = headerBlock.split(/\r?\n/);
  const re = new RegExp(`^${name}:`, "i");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      let val = lines[i].slice(lines[i].indexOf(":") + 1).trim();
      let j = i + 1;
      while (j < lines.length && /^[ \t]/.test(lines[j])) {
        val += " " + lines[j].trim();
        j++;
      }
      return val;
    }
  }
  return undefined;
}

async function main() {
  console.log(`\n=== A5 ENGINE SPIKE — EmailPort contract vs real GreenMail SMTP/IMAP ===`);
  console.log(`SMTP ${HOST}:${SMTP_PORT}  IMAP ${HOST}:${IMAP_PORT}\n`);

  const transport = smtp();
  await transport.verify();
  console.log("SMTP transport verified (server reachable).\n");

  // ---- (1) SMTP SEND + (5) List-Unsubscribe round-trip -----------------------
  // The engine mints a Message-ID and expects it back (tick.ts stores
  // result.messageId on scheduled_sends). A real client must SET an RFC 5322
  // Message-ID that survives the round-trip. We also attach RFC 8058 unsub
  // headers to test whether a real server round-trips them verbatim.
  const originalMessageId = `<a-${Date.now()}@${DOMAIN}>`;
  const unsubMailto = `<mailto:unsub@${DOMAIN}?subject=unsubscribe>`;
  const unsubHttps = `<https://${DOMAIN}/u/abc123>`;
  const listUnsub = `${unsubMailto}, ${unsubHttps}`;

  console.log(`[1] SMTP SEND — sender -> lead, Message-ID ${originalMessageId}`);
  const sendInfo = await transport.sendMail({
    from: SENDER,
    to: LEAD,
    subject: "Quick question about your outreach",
    text: "Hi — are you the right person for this? Reply STOP to opt out.",
    messageId: originalMessageId,
    headers: {
      "List-Unsubscribe": listUnsub,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
  line("SMTP response", sendInfo.response);
  line("accepted", JSON.stringify(sendInfo.accepted));
  ok(sendInfo.accepted.includes(LEAD), "server accepted the recipient (250 OK)");

  console.log(`\n[1/5] IMAP FETCH at lead inbox — verify send + headers survived`);
  const leadMsgs = await fetchAll(LEAD, { matchMessageId: originalMessageId });
  const inbound = leadMsgs.find((m) => m.parsed.messageId === originalMessageId);
  const inboundUnsub = rawHeader(inbound.source, "List-Unsubscribe");
  const inboundUnsubPost = rawHeader(inbound.source, "List-Unsubscribe-Post");
  line("fetched Message-ID  ", inbound.parsed.messageId);
  line("List-Unsubscribe    ", inboundUnsub);
  line("List-Unsubscribe-Post", inboundUnsubPost);
  ok(inbound.parsed.messageId === originalMessageId,
     "Message-ID round-tripped verbatim over SMTP->IMAP");
  record("1. SMTP send", "VALIDATED",
    `250 accepted ${JSON.stringify(sendInfo.accepted)}; Message-ID ${inbound.parsed.messageId} readable over IMAP`);

  ok(inboundUnsub?.includes(unsubMailto) && inboundUnsub?.includes(unsubHttps),
     "List-Unsubscribe header (mailto + https) round-tripped over SMTP->IMAP");
  ok(inboundUnsubPost === "List-Unsubscribe=One-Click",
     "List-Unsubscribe-Post (RFC 8058 one-click) round-tripped verbatim");
  record("5. List-Unsubscribe round-trip", "VALIDATED (server) / MISMATCH (interface)",
    `Server round-trips both headers verbatim. BUT SendEmailInput (vendor-ports.ts:71-78) has no header/listUnsubscribe field — the port cannot express these today.`);

  // ---- (2) IMAP REPLY DETECTION + (3) THREADING ------------------------------
  // Simulate the lead replying. A real reply carries In-Reply-To + References
  // pointing at the original Message-ID. The engine links replies by threadId
  // (reply-processor.ts:128 -> lookupThreadRef on scheduled_sends.thread_id),
  // so the real adapter MUST reconstruct threadId from these headers. This
  // proves that reconstruction is possible.
  const replyMessageId = `<b-${Date.now()}@${DOMAIN}>`;
  console.log(`\n[2/3] SIMULATE REPLY — lead -> sender, In-Reply-To ${originalMessageId}`);
  const replyInfo = await transport.sendMail({
    from: LEAD,
    to: SENDER,
    subject: "Re: Quick question about your outreach",
    text: "Yes, I'm the right person. Tell me more.",
    messageId: replyMessageId,
    inReplyTo: originalMessageId,
    references: originalMessageId,
  });
  line("SMTP response", replyInfo.response);

  console.log(`\n[2/3] IMAP FETCH at sender inbox — detect reply + verify thread linkage`);
  const senderAfterReply = await fetchAll(SENDER, { matchMessageId: replyMessageId });
  const reply = senderAfterReply.find((m) => m.parsed.messageId === replyMessageId);
  ok(!!reply, "reply message detected in sender inbox over IMAP");
  const inReplyTo = rawHeader(reply.source, "In-Reply-To");
  const references = rawHeader(reply.source, "References");
  line("reply Message-ID", reply.parsed.messageId);
  line("In-Reply-To     ", inReplyTo);
  line("References      ", references);
  line("mailparser inReplyTo", reply.parsed.inReplyTo);
  line("mailparser references", JSON.stringify(reply.parsed.references));
  record("2. IMAP reply detection", "VALIDATED",
    `Reply ${reply.parsed.messageId} fetched over real IMAP from sender's INBOX`);

  ok(inReplyTo === originalMessageId,
     "reply In-Reply-To === original Message-ID (thread anchor recoverable)");
  ok(String(references).includes(originalMessageId),
     "reply References contains original Message-ID (thread chain recoverable)");
  const highWaterUid = Math.max(...senderAfterReply.map((m) => m.uid));
  record("3. Threading (Message-ID/In-Reply-To/References)", "VALIDATED",
    `In-Reply-To=${inReplyTo} and References=${references} both resolve to the original send's Message-ID. A real adapter maps these -> scheduled_sends.message_id -> thread_id. The sandbox's pre-supplied PolledReply.threadId is a convenience the real path must reconstruct from headers (it can).`);

  // ---- incremental "poll since last" (the real IMAP equivalent of the
  // sandbox poll()'s "returns and clears" high-water mark) --------------------
  console.log(`\n[2b] INCREMENTAL POLL — UID high-water mark = ${highWaterUid} (real equivalent of poll-and-clear)`);

  // ---- (4) BOUNCE DETECTION + CLASSIFICATION ---------------------------------
  // A real bounce is an async DSN (RFC 3464) from MAILER-DAEMON:
  // Content-Type: multipart/report; report-type=delivery-status. The engine
  // needs { originalMessageId, reason } (PolledBounce) and hard/soft
  // classification. GreenMail auto-provisions any recipient so it won't emit a
  // natural NDR; we deliver a real RFC 3464 DSN and prove the adapter can
  // fetch + parse + classify it over real IMAP, and recover the original id.
  const boundary = "=_dsn_boundary_9137";
  const dsnMessageId = `<dsn-${Date.now()}@${DOMAIN}>`;
  const rawDsn = [
    `From: Mail Delivery Subsystem <MAILER-DAEMON@${DOMAIN}>`,
    `To: ${SENDER}`,
    `Subject: Delivery Status Notification (Failure)`,
    `Message-ID: ${dsnMessageId}`,
    `In-Reply-To: ${originalMessageId}`,
    `References: ${originalMessageId}`,
    `Auto-Submitted: auto-replied`,
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    `MIME-Version: 1.0`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Your message could not be delivered to nosuchuser@example.com.`,
    `The recipient address does not exist (550 5.1.1).`,
    ``,
    `--${boundary}`,
    `Content-Type: message/delivery-status`,
    ``,
    `Reporting-MTA: dns; mail.${DOMAIN}`,
    ``,
    `Final-Recipient: rfc822; nosuchuser@example.com`,
    `Action: failed`,
    `Status: 5.1.1`,
    `Diagnostic-Code: smtp; 550 5.1.1 <nosuchuser@example.com> No such user here`,
    ``,
    `--${boundary}`,
    `Content-Type: text/rfc822-headers`,
    ``,
    `Message-ID: ${originalMessageId}`,
    `From: ${SENDER}`,
    `To: nosuchuser@example.com`,
    `Subject: Quick question about your outreach`,
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");

  console.log(`\n[4] SIMULATE BOUNCE — deliver RFC 3464 DSN to sender inbox`);
  const dsnInfo = await transport.sendMail({
    envelope: { from: `MAILER-DAEMON@${DOMAIN}`, to: SENDER },
    raw: rawDsn,
  });
  line("SMTP response", dsnInfo.response);

  console.log(`\n[4] IMAP FETCH — parse + classify the DSN (UID high-water mark = ${highWaterUid})`);
  const newMsgs = await fetchAll(SENDER, { matchMessageId: dsnMessageId });
  const dsn = newMsgs.find((m) => m.parsed.messageId === dsnMessageId);
  ok(dsn.uid > highWaterUid,
     `DSN UID ${dsn.uid} > high-water ${highWaterUid} (a real 'poll since last UID' would surface it as new)`);
  const contentType = rawHeader(dsn.source, "Content-Type");
  line("Content-Type    ", contentType);
  const isDsn =
    /multipart\/report/i.test(contentType) && /report-type=delivery-status/i.test(contentType);
  ok(isDsn, "message identified as a DSN (multipart/report; report-type=delivery-status)");

  // Parse the delivery-status part fields out of the raw source (the machine part).
  const statusMatch = dsn.source.match(/^Status:\s*([245])\.(\d+)\.(\d+)/im);
  const actionMatch = dsn.source.match(/^Action:\s*(\w+)/im);
  const diagMatch = dsn.source.match(/^Diagnostic-Code:\s*(.+)$/im);
  ok(!!statusMatch, "delivery-status Status field present");
  const statusClass = Number(statusMatch[1]);
  const statusCode = `${statusMatch[1]}.${statusMatch[2]}.${statusMatch[3]}`;
  const classification = statusClass === 5 ? "hard" : statusClass === 4 ? "soft" : "unknown";
  line("Status          ", statusCode);
  line("Action          ", actionMatch?.[1]);
  line("Diagnostic-Code ", diagMatch?.[1]?.trim());
  line("classification  ", classification.toUpperCase() + " bounce");
  ok(classification === "hard", "5.x.x classified as HARD (permanent) bounce -> suppress");

  // Recover the original Message-ID two ways a real adapter would.
  const recoveredFromReturnedHeaders =
    dsn.source.match(new RegExp(`Message-ID:\\s*(${originalMessageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "i"))?.[1];
  const recoveredFromInReplyTo = rawHeader(dsn.source, "In-Reply-To");
  line("orig id via rfc822-headers", recoveredFromReturnedHeaders);
  line("orig id via In-Reply-To   ", recoveredFromInReplyTo);
  ok(recoveredFromReturnedHeaders === originalMessageId || recoveredFromInReplyTo === originalMessageId,
     "original Message-ID recovered from the DSN (maps bounce -> scheduled_sends row)");
  record("4. Bounce classification", "VALIDATED (parse/classify/recover) / UNTESTABLE-LOCALLY (DSN generation)",
    `Real IMAP-fetched DSN parsed: Status ${statusCode} -> ${classification.toUpperCase()}; original Message-ID recovered. NOTE: GreenMail auto-provisions recipients so it never EMITS a natural NDR — the DSN payload here is synthesized to RFC 3464; whether a real vendor (Gmail/Inboxkit) emits this exact shape is an activation-time check.`);

  // ---- SUMMARY ---------------------------------------------------------------
  console.log(`\n=== CONTRACT FINDINGS ===`);
  for (const r of results) {
    console.log(`\n[${r.verdict}] ${r.behavior}`);
    console.log(`   ${r.evidence}`);
  }
  console.log(`\nALL ASSERTIONS PASSED.\n`);
}

main().catch((err) => {
  console.error(`\nSPIKE FAILED: ${err.stack || err}`);
  process.exit(1);
});
