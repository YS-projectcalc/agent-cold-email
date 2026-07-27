import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import type { CredentialsMap } from "../src/config.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmailEngine } from "../src/engine.js";
import { createGmailSender } from "../src/gmail.js";
import { EngineStore } from "../src/store.js";

// OUT-OF-PROCESS crash determinism for gmail (opt-in, like the GreenMail e2e).
// A REAL child process runs the compiled engine against a mock gmail that accepts
// messages.send (200) then BLOCKS the wire-id read-back — so the child is
// provably post-accept + post-`submitted{id}` + pre-record for up to 15s. We
// SIGKILL it inside that window, then restart in-process: boot reconciliation
// finalizes via messages.get (now un-blocked) and a retry hits the cache — proving
// the durable log survives a genuine process kill with EXACTLY ONE messages.send.
//
// Gated behind ENGINE_KILL_E2E=1 (needs `npm run build -w @coldstart/engine`
// first — the child imports dist). Default `npm test` self-skips this file.
const RUN = process.env.ENGINE_KILL_E2E === "1";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, "gmail-kill-child.mjs");
const GMAIL_BOX = "gmail@coldstart.test";

const creds: CredentialsMap = {
  [GMAIL_BOX]: {
    imap: { host: "imap", port: 993, secure: true, user: GMAIL_BOX, pass: "p" },
    send: { kind: "gmail_api", clientId: "c", clientSecret: "s", refreshToken: "rt" },
  },
};

function redirect(u: string, base: string): string {
  if (u.startsWith("https://oauth2.googleapis.com/token")) return `${base}/token`;
  const sendUrl = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
  if (u === sendUrl) return `${base}/send`;
  const msgPrefix = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  if (u.startsWith(msgPrefix)) return `${base}/messages${u.slice(msgPrefix.length)}`;
  return u;
}

async function waitFor(predicate: () => boolean, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (!predicate()) throw new Error("waitFor timed out");
}

function hasSubmittedLine(logPath: string): boolean {
  if (!existsSync(logPath)) return false;
  return readFileSync(logPath, "utf8").split("\n").some((l) => l.includes('"type":"submitted"'));
}

let dir: string;
let server: Server;
let sendCount = 0;
let blockReadback = true;
let mockBase = "";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "gmail-kill-"));
  sendCount = 0;
  blockReadback = true;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (url.startsWith("/token")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      return;
    }
    if (url.startsWith("/send")) {
      sendCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "gm-kill-1" }));
      return;
    }
    if (url.startsWith("/messages")) {
      if (blockReadback) return; // hang: hold the child post-submitted / pre-record
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ payload: { headers: [{ name: "Message-ID", value: "<wire-kill@mail.gmail.com>" }] } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0);
  await once(server, "listening");
  mockBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!RUN)("gmail out-of-process SIGKILL (post-accept, pre-record)", () => {
  it("a killed child that durably wrote submitted{id} is FINALIZED at boot; the retry hits the cache — exactly ONE messages.send", async () => {
    const child = spawn(process.execPath, [CHILD], {
      env: { ...process.env, KILL_STATE_DIR: dir, KILL_MOCK_BASE: mockBase },
      stdio: "inherit",
    });

    // The child accepted the send and durably wrote `submitted{id}`, then hung in
    // the (blocked) read-back. Kill it inside that window.
    await waitFor(() => hasSubmittedLine(join(dir, "send-log.jsonl")));
    expect(sendCount).toBe(1);
    child.kill("SIGKILL");
    await once(child, "exit");

    // Un-block the read-back so reconciliation's messages.get can finalize.
    blockReadback = false;

    // Restart in-process over the SAME dir: boot reconciliation finalizes the
    // dangling via messages.get (wire id), and a retry hits the recorded cache.
    const store2 = new EngineStore(dir);
    const gmail = createGmailSender((url, init) => fetch(redirect(String(url), mockBase), init));
    const engine2 = new EmailEngine({
      credentials: creds,
      store: store2,
      smtp: { async send() {} },
      imap: { async currentUidNext() { return 1; }, async fetchRange() { return []; } },
      gmail,
    });
    const summary = await engine2.reconcilePendingSends();
    expect(summary.finalized).toBe(1);
    expect(store2.getSend("kill-key")).toMatchObject({ messageId: "<wire-kill@mail.gmail.com>" });

    const retry = await engine2.send(
      { fromEmail: GMAIL_BOX, toEmail: "lead@example.com", subject: "s", body: "b", threadId: "thr_kill", inReplyToMessageId: null },
      "kill-key",
    );
    expect(retry.messageId).toBe("<wire-kill@mail.gmail.com>");
    expect(sendCount).toBe(1); // NEVER a second messages.send across the kill + restart + retry
    store2.close();
  });
});
