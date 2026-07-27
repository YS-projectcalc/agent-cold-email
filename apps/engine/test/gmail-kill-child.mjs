// Out-of-process crash harness for the gmail SIGKILL e2e (test/gmail-kill.e2e.test.ts).
// Runs the REAL compiled engine (dist/) so the parent can SIGKILL it at a provable
// point: post messages.send accept + durable `submitted{id}`, mid the wire-id
// read-back (which the mock BLOCKS). Imports dist because a killed OS process must
// be a true separate process — run `npm run build -w @coldstart/engine` first.
import { EmailEngine } from "../dist/engine.js";
import { createGmailSender } from "../dist/gmail.js";
import { EngineStore } from "../dist/store.js";

const stateDir = process.env.KILL_STATE_DIR;
const base = process.env.KILL_MOCK_BASE;

function redirect(u) {
  if (u.startsWith("https://oauth2.googleapis.com/token")) return `${base}/token`;
  const sendUrl = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
  if (u === sendUrl) return `${base}/send`;
  const msgPrefix = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  if (u.startsWith(msgPrefix)) return `${base}/messages${u.slice(msgPrefix.length)}`;
  return u;
}
const mockFetch = (url, init) => fetch(redirect(String(url)), init);

const creds = {
  "gmail@coldstart.test": {
    imap: { host: "imap", port: 993, secure: true, user: "gmail@coldstart.test", pass: "p" },
    send: { kind: "gmail_api", clientId: "c", clientSecret: "s", refreshToken: "rt" },
  },
};
const noopImap = { async currentUidNext() { return 1; }, async fetchRange() { return []; } };
const engine = new EmailEngine({
  credentials: creds,
  store: new EngineStore(stateDir),
  smtp: { async send() {} },
  imap: noopImap,
  gmail: createGmailSender(mockFetch),
});

// This hangs in the wire-id read-back (the mock BLOCKS /messages/<id>) — the
// process sits post-accept / post-submitted / pre-recorded until SIGKILL.
await engine.send(
  { fromEmail: "gmail@coldstart.test", toEmail: "lead@example.com", subject: "s", body: "b", threadId: "thr_kill", inReplyToMessageId: null },
  "kill-key",
);
console.log("CHILD_UNEXPECTEDLY_RETURNED");
