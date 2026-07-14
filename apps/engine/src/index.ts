import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadConfig } from "./config.js";
import { EmailEngine } from "./engine.js";
import { imapflowFetcher } from "./imap.js";
import { route, type EngineRequest } from "./router.js";
import { nodemailerSender } from "./smtp.js";
import { EngineStore } from "./store.js";

// Entry point for the 24/7 daemon. Loads env config (fail-fast on a bad
// secret/creds), wires the real SMTP/IMAP adapters, and serves the pure router
// over node:http. Body is capped so a hostile client can't exhaust memory.

const MAX_BODY_BYTES = 1_000_000;

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

function main(): void {
  const config = loadConfig();
  const store = new EngineStore(config.stateDir);
  const engine = new EmailEngine({
    credentials: config.credentials,
    store,
    smtp: nodemailerSender,
    imap: imapflowFetcher,
  });

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
      const { status, body } = await route(engine, config.authSecret, req);
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
}

main();
