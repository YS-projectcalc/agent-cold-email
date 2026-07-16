# @coldstart/engine — external email engine (the real `EmailPort`)

The 24/7 Node SMTP/IMAP daemon that becomes the production `EmailPort`
(ARCHITECTURE.md #6). Cloudflare Workers cannot hold the long-lived IMAP/SMTP
connections a cold-email product's core act requires, so this runs **off-Worker**
on a small VM/container. The Worker's `RealEmailPort`
(`apps/platform/src/vendors/real/email-port.ts`) speaks the HTTP boundary
contract below to it.

It uses the exact libraries the **A5 spike** (`spikes/a5-engine-imap/`) validated
against real GreenMail SMTP+IMAP — `nodemailer` (send), `imapflow` (poll),
`mailparser` (parse) — so the send/reply/bounce/thread/unsub behaviors are the
ones already proven end-to-end, not re-derived.

> **Ships dark.** Nothing here is reachable in the deployed product today: the
> Worker's adapter factory (`vendors/factory.ts`) hands every tenant the
> `sandbox` EmailPort, and `RealEmailPort` itself throws `NotActivatedError`
> until `ENGINE_BASE_URL` + `ENGINE_AUTH_SECRET` are set. This is Gate-2
> activation infrastructure (`ACTIVATION.md`), built to contract.

## Boundary contract (Worker → engine, HTTP)

Every mutating route requires `Authorization: Bearer <ENGINE_AUTH_SECRET>`.
Request/response shapes mirror the frozen `EmailPort`
(`packages/shared/src/vendor-ports.ts`); `src/wire.ts` carries a compile-time
assertion that they can't drift.

| Method | Path        | Auth | Body → Response |
|--------|-------------|------|-----------------|
| GET    | `/health`   | no   | `200 { status:"ok", uptimeSec }` |
| POST   | `/v1/send`  | yes  | `{ input: SendEmailInput, idempotencyKey } → 200 SendEmailResult` |
| POST   | `/v1/poll`  | yes  | `{ mailboxEmail, sinceCursor } → 200 { events: PolledEvent[], cursor }` |

**Cursor ownership (consumer, not engine).** The engine holds NO poll cursor.
The Worker DO stores each mailbox's IMAP UID high-water (`mailboxes.poll_cursor`),
passes it as `sinceCursor`, and — after transactionally processing the returned
events — persists the returned `cursor`. So a lost `/v1/poll` response leaves the
consumer's cursor un-advanced and the next poll redelivers the same events
(deduped on Message-ID) instead of dropping them forever.

**First contact never fetches history.** `sinceCursor: -1` is the sentinel for
"never polled this mailbox before" (real IMAP UIDs start at 1, so -1 is
distinct from every legitimate cursor value, INCLUDING 0 — a genuinely empty
mailbox's high-water is 0, and 0 is an ordinary INCREMENTAL cursor, not a
sentinel). On first contact the engine initializes the cursor at the
mailbox's CURRENT high-water (`uidNext - 1`, one cheap `STATUS` call) and
returns `{ events: [], cursor }` — it never pulls a real, pre-existing
mailbox's history. Poll's semantics are "events since we started watching,"
never "mirror the inbox." Every subsequent poll, including `sinceCursor: 0`,
is incremental and capped to `POLL_BATCH_CAP` (300) UIDs per call (`src/
engine.ts`), so a backlog larger than one cap pages across polls instead of
buffering an unbounded number of full RFC5322 sources in memory (the defect
found live by the Gate-1 smoke on a real >147k-UID mailbox).

**Error grading** (the Worker re-derives a `VendorError.retryable` from the
status, so `engine/tick.ts` retries transient failures under its cap and fails
fast on permanent ones):

| Status | Meaning | Worker grade |
|--------|---------|--------------|
| 400 | malformed request / body | permanent |
| 401 | bad/missing bearer secret | permanent |
| 409 | same-key send already in flight | **retryable** |
| 422 | no credentials for that mailbox | **retryable** (operator-fixable: creds file) |
| 5xx | SMTP/IMAP transient failure | **retryable** |

**Why the engine resolves credentials, not the Worker:** the frozen `EmailPort`
carries only the mailbox email (`send`) / address (`poll`) — never credentials.
So per-mailbox SMTP/IMAP creds are injected into the *engine's* config and
resolved by address here. The engine trusts the Worker (single shared secret);
per-tenant isolation is already enforced upstream in the Worker.

**Thread reconstruction:** at send time the engine records `Message-ID →
threadId`. At poll time an inbound reply/bounce/complaint is matched back to its
thread via `In-Reply-To` / `References` / returned `rfc822-headers` → the stored
`Message-ID` → `threadId` (`src/classify.ts`). This is the reconstruction the
sandbox hands out for free (memory: the four sandbox conveniences a real server
withholds).

## Send transports (HTTPS/443 — the SMTP-egress-wall path)

Sending has three interchangeable transports, chosen **per mailbox** by the
`send.kind` discriminator in that mailbox's credentials. All three build the
outbound message with the SAME builder (`src/message.ts`), so the compliance
surface — RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post`, the in-body
opt-out link + CAN-SPAM footer (carried verbatim in the body), the real
`Message-ID`, sequence `In-Reply-To`/`References` — is **byte-identical no matter
which wire the send takes**. Reply reading is ALWAYS IMAP (993) regardless of
send transport, so every mailbox still needs an `imap` endpoint. (API-based reply
reading is possible future work; not built.)

| `send.kind`  | Wire | Auth | Why |
|--------------|------|------|-----|
| `smtp` (default, or `send` omitted) | SMTP 465/587 | app password | the original path; unchanged |
| `gmail_api`  | HTTPS 443 → `gmail.googleapis.com` | OAuth2 refresh token | survives a host that blocks outbound SMTP |
| `ms_graph`   | HTTPS 443 → `graph.microsoft.com` | OAuth2 (delegated refresh token **or** app-only client credentials) | same, for Microsoft 365 |

The API transports exist because a host can block outbound SMTP egress (465/587)
account-wide while leaving 443 and IMAP 993 open — the exact condition on the
current DO droplet. `gmail_api` POSTs the raw base64url RFC822 to Gmail's
`messages.send`; `ms_graph` POSTs the raw MIME (base64, `text/plain` body) to
Graph's `sendMail`, which preserves every header. Both use the built-in `fetch`
(no vendor SDK), cache the access token, refresh once on a 401, and back off on
429/5xx — then map any unrecovered failure to the SAME transient error the SMTP
path throws, so the Worker's retry/bounce accounting is unchanged.

> **Gmail endpoint note.** We use the standard `messages.send`
> (`https://gmail.googleapis.com/gmail/v1/users/me/messages/send`) with a
> base64url `{ raw }` JSON body — the documented path for messages ≤5 MB, which
> every cold email is. The resumable `/upload/gmail/v1/...` endpoint is for large
> media and takes raw `message/rfc822` bytes (not base64url), so it is not used
> here.

## Config surface (all env-driven — no secret in code)

See `.env.example`. `ENGINE_AUTH_SECRET` (required, ≥16 chars), `ENGINE_PORT`
(default 8080), `ENGINE_STATE_DIR` (default `./state`), and
`MAILBOX_CREDENTIALS` (inline JSON) **or** `MAILBOX_CREDENTIALS_FILE` (path) — a
`{ email → MailboxCredentials }` map. Each `MailboxCredentials`:

```jsonc
{
  "imap": { "host": "…", "port": 993, "secure": true, "user": "…", "pass": "…" }, // always required (reply reading)
  "messageIdDomain": "…",   // optional; defaults to the sending address's domain

  // Send transport — OMIT for the default SMTP path (backward compatible):
  "smtp": { "host": "…", "port": 465, "secure": true, "user": "…", "pass": "…" }, // required iff SMTP

  // …OR pick an HTTPS/443 transport instead of `smtp`:
  "send": { "kind": "gmail_api", "clientId": "…", "clientSecret": "…", "refreshToken": "…" }
  // "send": { "kind": "ms_graph", "mode": "delegated", "tenantId": "…", "clientId": "…", "clientSecret": "…", "refreshToken": "…" }
  // "send": { "kind": "ms_graph", "mode": "app_only",  "tenantId": "…", "clientId": "…", "clientSecret": "…", "user": "box@domain" }
}
```

Validation is fail-fast at boot: an `smtp`-transport mailbox must carry an `smtp`
endpoint; `ms_graph` `delegated` requires `refreshToken`; `ms_graph` `app_only`
requires `user` (Graph app-only has no `me`). A legacy `{ smtp, imap }` entry
(no `send`) is unchanged — it is the `smtp` transport.

## Minting BYO send credentials (founder runbook)

The API transports need per-mailbox OAuth credentials. These are minted ONCE by
the mailbox owner and dropped into `MAILBOX_CREDENTIALS_FILE` — never committed
(CLAUDE.md rule g). Send-only scopes throughout (least privilege).

### Gmail (`gmail_api`)

1. **Google Cloud Console** → a project → *APIs & Services* → **enable the Gmail
   API**.
2. *OAuth consent screen*: External, add the mailbox as a **test user** (no app
   verification needed while in Testing for your own mailbox).
3. *Credentials* → **Create OAuth client ID** → application type **Desktop app**.
   Note the `client_id` + `client_secret`.
4. Mint the refresh token with the loopback helper (opens a consent URL, catches
   the redirect on `http://127.0.0.1`, exchanges the code):
   ```bash
   node apps/engine/scripts/mint-gmail-token.mjs <client_id> <client_secret>
   ```
   Consent as the mailbox; the script prints the `refresh_token`. Scope minted:
   `https://www.googleapis.com/auth/gmail.send`.
5. Put `{ "kind": "gmail_api", "clientId", "clientSecret", "refreshToken" }` under
   that mailbox's `send`, keeping its `imap` endpoint (app password) for replies.

### Microsoft 365 — delegated (`ms_graph`, `mode:"delegated"`)

1. **Entra ID** → *App registrations* → **New registration**. Note the
   *Application (client) ID* and *Directory (tenant) ID*.
2. *Authentication* → add a **Mobile & desktop** platform with redirect URI
   `http://localhost` (loopback), and enable **Allow public client flows**.
3. *API permissions* → **Microsoft Graph → Delegated → `Mail.Send`** (add
   `offline_access` for the refresh token). Grant consent.
4. *Certificates & secrets* → **New client secret**; note the value.
5. Mint a refresh token via any standard v2.0 auth-code + loopback flow for scope
   `https://graph.microsoft.com/Mail.Send offline_access` (the Gmail helper's
   flow is the same shape against `login.microsoftonline.com/<tenant>/oauth2/
   v2.0/{authorize,token}`; a dedicated Graph helper is future work).
6. Put `{ "kind":"ms_graph", "mode":"delegated", "tenantId", "clientId",
   "clientSecret", "refreshToken" }` under `send`.

### Microsoft 365 — app-only (`ms_graph`, `mode:"app_only"`)

1. Same app registration; instead of delegated, add **Graph → Application →
   `Mail.Send`** and click **Grant admin consent**.
2. **Scope the blast radius.** Application `Mail.Send` grants send-as-ANY mailbox
   in the tenant by default. Restrict it to only the sending mailboxes with an
   Exchange **Application Access Policy** (`New-ApplicationAccessPolicy … 
   -AccessRight RestrictAccess`) before using it in production.
3. No refresh token — the client-credentials grant mints app tokens directly. Put
   `{ "kind":"ms_graph", "mode":"app_only", "tenantId", "clientId",
   "clientSecret", "user":"<the-sending-mailbox>" }` under `send`.

## Run / test locally

```bash
npm run build -w @coldstart/engine      # tsc -> dist/
npm run typecheck -w @coldstart/engine
npm run test -w @coldstart/engine       # pure-unit suite (no network)

# start the daemon (reads env)
ENGINE_AUTH_SECRET=$(openssl rand -hex 24) \
  MAILBOX_CREDENTIALS_FILE=./mailboxes.json \
  node apps/engine/dist/index.js
```

### GreenMail end-to-end (opt-in — proves real send/receive)

```bash
docker run -d --name coldstart-engine-greenmail -p 3025:3025 -p 3143:3143 \
  -e GREENMAIL_OPTS="-Dgreenmail.setup.test.smtp -Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" \
  greenmail/standalone:2.1.3
ENGINE_E2E=1 npm run test -w @coldstart/engine   # runs greenmail.e2e.test.ts
docker rm -f coldstart-engine-greenmail
```

The e2e sends `sender@ → lead@`, polls the reply over real IMAP and asserts the
reconstructed `threadId`, then delivers a real RFC 3464 hard-bounce DSN and
asserts it classifies to `severity:"hard"`. Without `ENGINE_E2E=1` the file
self-skips (default `npm test` needs no Docker).

## Deploy

Provisioning runbook (droplet sizing, secrets, one-real-send smoke test) lives in
`ACTIVATION.md` → Gate 2 → "Go-engine host". Image build:

```bash
npm run build -w @coldstart/engine
docker build -t coldstart-engine apps/engine
```

## Scaling beyond one instance

`src/store.ts` is a single-daemon JSON-file store (atomic writes, serialized
queue) — correct for the pilot's ONE engine instance. Two instances behind a
load balancer would each hold a private idempotency/thread/high-water map and
double-send. A multi-instance deployment swaps `EngineStore` for a shared store
(Redis/SQLite) behind the same interface; not built (YAGNI until a second
instance is needed).
