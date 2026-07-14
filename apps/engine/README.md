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

## Config surface (all env-driven — no secret in code)

See `.env.example`. `ENGINE_AUTH_SECRET` (required, ≥16 chars), `ENGINE_PORT`
(default 8080), `ENGINE_STATE_DIR` (default `./state`), and
`MAILBOX_CREDENTIALS` (inline JSON) **or** `MAILBOX_CREDENTIALS_FILE` (path) — a
`{ email → { smtp, imap, messageIdDomain? } }` map.

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
