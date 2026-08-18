import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig } from "./config.js";
import { EmailEngine } from "./engine.js";
import { createGmailSender } from "./gmail.js";
import { createGraphSender } from "./graph.js";
import { imapflowFetcher } from "./imap.js";
import { MailboxCredentialStore } from "./mailbox-store.js";
import { route, type EngineRequest } from "./router.js";
import { nodemailerSender } from "./smtp.js";
import { EngineStore } from "./store.js";

// Entry point for the 24/7 daemon. Loads env config (fail-fast on a bad
// secret/creds), wires the real SMTP/IMAP adapters, and serves the pure router
// over node:http. Body is capped so a hostile client can't exhaust memory.

const MAX_BODY_BYTES = 1_000_000;

// Bound the SIGTERM drain wait: below `docker stop -t 150` (the runbook's stop
// timeout) but above the SMTP worst-case (~100s, smtp.ts) so an in-flight send
// finishes and records rather than being SIGKILL'd. A timed-out drain is still
// safe — a killed in-flight send leaves a dangling → park → drop, never dupe.
const DRAIN_TIMEOUT_MS = 140_000;

function readBody(reqMessage: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    reqMessage.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        reqMessage.destroy();
        return;
      }
      chunks.push(chunk);
    });
    reqMessage.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    reqMessage.on("error", reject);
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  // Both durable stores fail LOUD (throw) on a corrupt state file (F5) — so a
  // corrupt engine-state.json or pushed-mailboxes.json aborts boot HERE (via
  // loadConfig()'s siblings) rather than silently starting empty.
  const store = new EngineStore(config.stateDir);
  const credentialStore = new MailboxCredentialStore(config.stateDir);
  const engine = new EmailEngine({
    credentials: config.credentials,
    store,
    credentialStore,
    smtp: nodemailerSender,
    imap: imapflowFetcher,
    gmail: createGmailSender(),
    graph: createGraphSender(),
  });

  // Boot reconciliation BEFORE accepting traffic: resolve every dangling intent
  // the crash-recovery replay surfaced (finalize gmail sends that reached
  // submitted{id}, park everything else — drop, never duplicate), bounded so a
  // mass crash cannot hold the listen indefinitely. Then compact once so the
  // fresh snapshot reflects the reconciled state and the log starts empty.
  const summary = await engine.reconcilePendingSends();
  store.compact();
  if (summary.finalized || summary.parked || summary.failed) {
    console.log(
      `[engine] boot reconciliation: finalized ${summary.finalized}, parked ${summary.parked} (overflow ${summary.overflowParked}), ` +
        `unresolved ${summary.failed}`,
    );
  }

  // Graceful-drain flag. Flipped false on SIGTERM so new sends are refused
  // (transient, retried against the restarted engine) while in-flight sends
  // finish and record durably — closing the intent window cleanly on a planned
  // deploy instead of relying on a mid-send SIGKILL (which is still SAFE: it
  // leaves a dangling → park → drop, never a duplicate).
  let accepting = true;

  const server = createServer((reqMessage: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let rawBody = "";
      try {
        rawBody = reqMessage.method === "GET" ? "" : await readBody(reqMessage);
      } catch {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "request body too large" }));
        return;
      }
      const req: EngineRequest = {
        method: reqMessage.method ?? "GET",
        path: (reqMessage.url ?? "/").split("?")[0] ?? "/",
        authHeader: reqMessage.headers.authorization,
        rawBody,
      };
      const { status, body } = await route(engine, config.authSecret, req, { accepting });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    })().catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : "internal error" }));
    });
  });

  server.listen(config.port, () => {
    const mailboxes = Object.keys(config.credentials).length;
    console.log(`[engine] listening on :${config.port} — ${mailboxes} mailbox(es) configured, state ${config.stateDir}`);
  });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    accepting = false; // new sends 503 immediately; health/poll/ops still served
    console.log(`[engine] ${signal} — draining: refusing new sends, waiting for ${engine.inFlightCount()} in-flight`);
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (engine.inFlightCount() > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    store.close();
    server.close(() => process.exit(0));
    // Hard-stop if a lingering keep-alive connection prevents close() from firing
    // (still well inside `docker stop -t 150`; SIGKILL after that is also safe).
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(`[engine] fatal boot error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
