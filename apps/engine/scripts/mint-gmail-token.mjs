#!/usr/bin/env node
// One-time helper: mint a Gmail send-only OAuth2 refresh token for a BYO mailbox
// via the loopback (installed-app) flow. Run by the mailbox owner ONCE; the
// printed refresh_token goes into MAILBOX_CREDENTIALS_FILE under the mailbox's
// `send` block — NEVER committed (CLAUDE.md rule g). Node built-ins only; no deps.
//
//   node apps/engine/scripts/mint-gmail-token.mjs <client_id> <client_secret>
//
// Prereqs (see apps/engine/README.md runbook): a Google Cloud project with the
// Gmail API enabled and a Desktop-type OAuth client; the mailbox added as a test
// user on the consent screen.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const SCOPE = "https://www.googleapis.com/auth/gmail.send";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PORT = Number(process.env.MINT_PORT || 42813);

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("usage: node scripts/mint-gmail-token.mjs <client_id> <client_secret>");
  process.exit(2);
}

const redirectUri = `http://127.0.0.1:${PORT}`;
const state = randomBytes(16).toString("hex");
const authUrl =
  `${AUTH_URL}?response_type=code&access_type=offline&prompt=consent` +
  `&client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(redirectUri)}` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&state=${state}`;

async function exchange(code) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${JSON.stringify(body)}`);
  return body;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== "/") {
    res.writeHead(404).end();
    return;
  }
  const err = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (err || url.searchParams.get("state") !== state || !code) {
    res.writeHead(400, { "content-type": "text/plain" }).end(`Consent failed: ${err ?? "missing/invalid code"}`);
    console.error(`\nConsent failed: ${err ?? "missing or state-mismatched code"}`);
    server.close();
    process.exit(1);
  }
  try {
    const tokens = await exchange(code);
    res.writeHead(200, { "content-type": "text/plain" }).end("Refresh token minted — return to the terminal. You can close this tab.");
    if (!tokens.refresh_token) {
      console.error("\nNo refresh_token returned. Revoke the app's access and re-run (prompt=consent forces a fresh one).");
      process.exitCode = 1;
    } else {
      console.log(`\nrefresh_token:\n${tokens.refresh_token}\n`);
      console.log(`Put it under the mailbox's send block:\n  "send": { "kind": "gmail_api", "clientId": "${clientId}", "clientSecret": "<secret>", "refreshToken": "<the token above>" }`);
    }
  } catch (e) {
    console.error(`\n${e.message}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Listening on ${redirectUri} for the consent redirect.`);
  console.log(`\nOpen this URL, sign in as the mailbox, and grant send access:\n\n${authUrl}\n`);
});
