// msgchannel Increment 4 — the email mirror (design docs/research/
// msgchannel-inc4-email-mirror-design-2026-08-24.md). Mirrors a bounded
// subset of a tenant's own `tenant_messages` rows (engine/tenant-messages.ts)
// to its signup contact email, for the founder-ratified case where nobody's
// agent is polling. NEVER the system of record — the DO row always is; this
// is a best-effort, capped, opt-out-able courtesy channel (§1 C1/C2).
//
// Ridden into the EXISTING per-tenant cron leg (TenantDO.deliverabilitySweep,
// one line after pruneTenantMessages) rather than a new cron/RPC (§4) — no
// new subrequest-budget leg, just a bigger per-tenant term (admin/
// sweep-budget.ts's MIRROR_SUBREQUESTS_PER_TENANT).

import { lookupTenantContactEmail } from "../db.js";
import { escapeHtml } from "../html-escape.js";
import { createOpsMailer, type OpsMailer } from "../ops-mail/ops-mailer.js";
import type { TenantContext } from "../tenant-context.js";
import { buildMirrorOptOutUrl, signUnsubscribeToken } from "../unsubscribe-token.js";
import { CONTINUITY_NUDGE_KIND } from "./continuity-nudge.js";
import { realNowMs } from "./clamped-age.js";
import { DEFAULT_PUBLIC_BASE_URL } from "./tick.js";
import { toSeverity } from "./tenant-messages.js";

// --- §4 caps -----------------------------------------------------------
//
// MIRROR_MAX_PER_TICK (design §4) = 1 is enforced by CONSTRUCTION, not a
// checked constant: `drainMessageMirror` below claims and sends at most one
// batch per call, by its own control flow, which is what pins the per-tenant
// subrequest term at one send (C6) — there is nowhere in the loop shape a
// second send could occur.

/** Rolling 24h. A stalling tenant's rows REFRESH rather than multiply (C4),
 * so 3 covers a new blocker + an operator reply + a digest on the worst day. */
export const MIRROR_MAX_PER_DAY = 3;

/** Bodies folded into one overflow digest, at most. */
export const MIRROR_DIGEST_MAX = 10;

/** The rolling window the ring below is measured over. */
export const MIRROR_WINDOW_MS = 24 * 60 * 60 * 1000;

/** §2 — a named exclusion, with the ruling that requires it cited at the
 * constant: continuity_nudge is email-EXCLUDED by founder ruling Q1
 * (2026-08-18, docs/research/customer-continuity-design-2026-08-18.md:1139;
 * restated at engine/continuity-nudge.ts:5-7). This postdates and narrows the
 * 2026-08-05 Inc4 authorization. */
export const MIRROR_EXCLUDED_KINDS: readonly string[] = [CONTINUITY_NUDGE_KIND];

/** §2 — the system-severity rungs that mean "the account has stopped". `info`
 * ("the condition resolves on its own") is deliberately absent. */
const MIRRORABLE_SYSTEM_SEVERITIES: readonly ReturnType<typeof toSeverity>[] = ["action_required", "operator_pending", "terminal"];

// How many unmirrored candidate rows one drain will look at. DO-local
// `ctx.sql` reads are free (C6) so this is generous, not budget-sized — it
// only exists so a single tenant's unbounded backlog can't make one read
// scan without limit.
const MIRROR_CANDIDATE_SCAN_LIMIT = 200;

export interface MirrorDrainResult {
  /** Emails actually sent (individual or digest) this tick — 0 or 1. */
  sent: number;
  /** Send attempts that threw this tick — 0 or 1 (the claim was released). */
  failed: number;
  /** Eligible rows that existed but were NOT claimed because the daily ring
   * was full — held, never dropped (§4). */
  suppressed: number;
  /** Eligible rows claimed-then-abandoned because the tenant has no contact
   * email on file — counted, never faked (§3). */
  noContact: number;
}

const EMPTY_MIRROR_RESULT: MirrorDrainResult = { sent: 0, failed: 0, suppressed: 0, noContact: 0 };

// --- §8 T4 / arming --------------------------------------------------------

/**
 * Generalized from admin/ops-sweep.ts's `provisioningReconcileArmed` (rule c)
 * rather than re-written per flag: empty/"0"/"false"/"off" (case-insensitive)
 * all read as OFF, so a founder who sets a disabling word gets what they meant
 * instead of the "any-non-empty-value" footgun.
 */
export function isAffirmativeEnvFlag(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return value !== "" && value !== "0" && value !== "false" && value !== "off";
}

/**
 * DARK unless MESSAGE_EMAIL_MIRROR_ENABLED is armed AND (the allowlist is
 * empty, meaning every tenant, OR this tenant is named in it). T11: the
 * caller must check this BEFORE any I/O — this function touches neither
 * ctx.sql nor env.DB, only two already-resident env strings.
 */
export function isMirrorArmed(
  env: { MESSAGE_EMAIL_MIRROR_ENABLED?: string; MESSAGE_MIRROR_TENANT_ALLOWLIST?: string },
  tenantId: string,
): boolean {
  if (!isAffirmativeEnvFlag(env.MESSAGE_EMAIL_MIRROR_ENABLED)) return false;
  const allowlist = (env.MESSAGE_MIRROR_TENANT_ALLOWLIST ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return allowlist.length === 0 || allowlist.includes(tenantId);
}

function effectiveMaxPerDay(env: { MESSAGE_MIRROR_MAX_PER_DAY?: string }): number {
  const parsed = Number(env.MESSAGE_MIRROR_MAX_PER_DAY);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : MIRROR_MAX_PER_DAY;
}

// --- §4/§5 the ring ---------------------------------------------------------

/**
 * A bounded ring of send timestamps — ported verbatim from admin/
 * watchtower-budget.ts's AnnouncementRing (§4), NOT `{windowStart, count}`:
 * two fields express a TUMBLING window that resets on a boundary, which
 * permits MIRROR_MAX_PER_DAY sends at T+23.9h and MIRROR_MAX_PER_DAY more at
 * T+24.1h. REAL wall-clock throughout (never `ctx.clock`) — a demo/free
 * tenant's VirtualClock runs up to 1440x accelerated, so gating on it would
 * blow through the cap in real seconds (contact-operator-guard.ts's own
 * documented rule for the same reason).
 */
export interface MirrorRing {
  sends: number[];
}

const EMPTY_MIRROR_RING: MirrorRing = { sends: [] };

function parseMirrorRing(json: string | null): MirrorRing {
  if (!json) return EMPTY_MIRROR_RING;
  try {
    const parsed = JSON.parse(json) as { sends?: unknown };
    if (!Array.isArray(parsed.sends)) return EMPTY_MIRROR_RING;
    return { sends: parsed.sends.filter((n): n is number => typeof n === "number") };
  } catch {
    return EMPTY_MIRROR_RING;
  }
}

/** Drops entries aged out of the rolling window, and trims to `maxPerDay` so a
 * value written by a future edit (or a corrupted one) can't make the ring
 * unbounded. Exported for the pure ring-vs-tumbling test (§9 T6) — no DO, no
 * clock needed to prove the property. */
export function pruneMirrorRing(ring: MirrorRing, nowMs: number, maxPerDay: number = MIRROR_MAX_PER_DAY): MirrorRing {
  const live = ring.sends.filter((ts) => nowMs - ts < MIRROR_WINDOW_MS);
  return { sends: live.length > maxPerDay ? live.slice(-maxPerDay) : live };
}

// --- selection (§2) ---------------------------------------------------------

interface MirrorCandidateRow {
  id: string;
  kind: string;
  severity: string;
  body: string;
  source: "system" | "operator";
  [column: string]: SqlStorageValue;
}

function isMirrorable(row: MirrorCandidateRow): boolean {
  if (MIRROR_EXCLUDED_KINDS.includes(row.kind)) return false;
  if (row.source === "operator") return true; // §2 — a human wrote it once; always mirrors.
  return MIRRORABLE_SYSTEM_SEVERITIES.includes(toSeverity(row.severity));
}

/**
 * Candidates: unmirrored, unacked, unexpired — reusing the EXACT predicate
 * `listSurfacedTenantMessages`/`listMessagesPage` already use
 * (engine/tenant-messages.ts:308's `read_at IS NULL AND (expires_at IS NULL
 * OR expires_at > ?)`), plus `mirrored_at IS NULL`. Oldest first, so a digest
 * that only fits MIRROR_DIGEST_MAX carries the longest-held conditions.
 */
function selectMirrorCandidates(ctx: TenantContext, now: number): MirrorCandidateRow[] {
  return ctx.sql
    .exec<MirrorCandidateRow>(
      `SELECT id, kind, severity, body, source FROM tenant_messages
       WHERE tenant_id = ? AND mirrored_at IS NULL AND read_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at ASC, rowid ASC
       LIMIT ?`,
      ctx.tenantId,
      now,
      MIRROR_CANDIDATE_SCAN_LIMIT,
    )
    .toArray()
    .filter(isMirrorable);
}

// --- §5 claim / release -----------------------------------------------------

type MirrorClaimOutcome =
  | { kind: "empty" }
  | { kind: "suppressed"; count: number }
  | { kind: "claimed"; rows: MirrorCandidateRow[] };

/**
 * Synchronous, no `await` anywhere in this function (C7) — select candidates,
 * check opt-out + ring, stamp `mirrored_at` on the batch, append the ring
 * slot, ALL in one DO-local pass. The ring slot is appended here regardless
 * of what happens next (a no-contact-email tenant included) — it is the
 * SAME synchronous step the design names as one unit (§5).
 */
function claimMirrorBatch(ctx: TenantContext, now: number): MirrorClaimOutcome {
  const profile = ctx.sql
    .exec<{ mirror_email_optout_at: number | null; mirror_ring_json: string | null }>(
      `SELECT mirror_email_optout_at, mirror_ring_json FROM tenant_profile WHERE id = ?`,
      ctx.tenantId,
    )
    .one();
  if (profile.mirror_email_optout_at !== null) return { kind: "empty" };

  const candidates = selectMirrorCandidates(ctx, now);
  if (candidates.length === 0) return { kind: "empty" };

  const maxPerDay = effectiveMaxPerDay(ctx.env);
  const ring = pruneMirrorRing(parseMirrorRing(profile.mirror_ring_json), now, maxPerDay);
  if (ring.sends.length >= maxPerDay) return { kind: "suppressed", count: candidates.length };

  const batch = candidates.slice(0, MIRROR_DIGEST_MAX);
  const ids = batch.map((r) => r.id);
  ctx.sql.exec(
    `UPDATE tenant_messages SET mirrored_at = ? WHERE tenant_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
    now,
    ctx.tenantId,
    ...ids,
  );
  const nextRing: MirrorRing = { sends: [...ring.sends, now] };
  ctx.sql.exec(`UPDATE tenant_profile SET mirror_ring_json = ? WHERE id = ?`, JSON.stringify(nextRing), ctx.tenantId);

  return { kind: "claimed", rows: batch };
}

/**
 * Undoes the row-side of a claim after a send throws — the ring slot is
 * DELIBERATELY NOT released (Inc5's NEW-4 fix, §5): a revoked call freeing
 * its own rate slot let 30 sequential D1-outage throws send 30 uncapped
 * attempts. Here a totally dark channel costs at most MIRROR_MAX_PER_DAY
 * attempts/tenant/day instead of one per tick forever.
 */
function releaseMirrorClaim(ctx: TenantContext, ids: string[]): void {
  if (ids.length === 0) return;
  ctx.sql.exec(
    `UPDATE tenant_messages SET mirrored_at = NULL WHERE tenant_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
    ctx.tenantId,
    ...ids,
  );
}

// --- §6 opt-out --------------------------------------------------------

/**
 * Idempotent (§9 T10): a repeat call in the SAME direction (opt-out twice, or
 * opt back in twice) is a genuine no-op — it neither re-stamps the timestamp
 * nor writes at all — matching this codebase's convention (ackMessage's
 * "acking an already-read row ... without writing again").
 */
export function setMirrorEmailOptOut(ctx: TenantContext, optedOut: boolean): void {
  const current = ctx.sql.exec<{ mirror_email_optout_at: number | null }>(`SELECT mirror_email_optout_at FROM tenant_profile WHERE id = ?`, ctx.tenantId).one();
  const alreadyOptedOut = current.mirror_email_optout_at !== null;
  if (alreadyOptedOut === optedOut) return;
  ctx.sql.exec(`UPDATE tenant_profile SET mirror_email_optout_at = ? WHERE id = ?`, optedOut ? realNowMs() : null, ctx.tenantId);
}

export interface MessageEmailMirrorState {
  enabled: boolean;
  optedOut: boolean;
}

/** infrastructure_status's `messageEmailMirror` field — PURE SELECT, same
 * posture as listSurfacedTenantMessages. */
export function getMessageEmailMirrorState(ctx: TenantContext): MessageEmailMirrorState {
  const row = ctx.sql.exec<{ mirror_email_optout_at: number | null }>(`SELECT mirror_email_optout_at FROM tenant_profile WHERE id = ?`, ctx.tenantId).one();
  return { enabled: isMirrorArmed(ctx.env, ctx.tenantId), optedOut: row.mirror_email_optout_at !== null };
}

// --- composition (§6, §9 T15/T16) ------------------------------------------

async function buildMirrorOptOutLink(ctx: TenantContext, contactEmail: string): Promise<string> {
  const sig = await signUnsubscribeToken(ctx.env.TOKEN_HASH_PEPPER, ctx.tenantId, contactEmail);
  const baseUrl = ctx.env.PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL;
  return buildMirrorOptOutUrl(baseUrl, ctx.tenantId, contactEmail, sig);
}

function mirrorSubject(rows: readonly MirrorCandidateRow[]): string {
  return rows.length === 1 ? "[coldrig] an update on your account" : `[coldrig] ${rows.length} updates on your account`;
}

/**
 * C9 — the exemption survives only while the mail carries ZERO promotional
 * content: no upsell, no cross-sell, no link but the account's own (the
 * opt-out link IS the account's own control, the one link this mail may
 * carry). No `fenceAgentContent` wrapper (contact-operator.ts:64) — that
 * fence exists because TENANT-authored text flows to an operator who might
 * paste it into a coding agent; here the content is platform/operator-
 * authored flowing TO the tenant, so `escapeHtml` is the only guard the HTML
 * leg needs (§9 T16).
 */
async function composeMirrorEmail(ctx: TenantContext, contactEmail: string, rows: readonly MirrorCandidateRow[]): Promise<{ text: string; html: string }> {
  const optOutUrl = await buildMirrorOptOutLink(ctx, contactEmail);
  const bodies = rows.map((r) => r.body);
  const multi = bodies.length > 1;

  const textParts = [
    "This is an automated notice mirroring a message already recorded on your coldrig account.",
    "",
    ...bodies.flatMap((body, i) => [multi ? `${i + 1}. ${body}` : body, ""]),
    "This mirrors your account's own message channel and carries no offers or marketing.",
    `Turn these emails off: ${optOutUrl}`,
  ];

  const htmlBodyParts = bodies
    .map((body, i) => `<p>${multi ? `${i + 1}. ` : ""}${escapeHtml(body).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  const html = [
    "<p>This is an automated notice mirroring a message already recorded on your coldrig account.</p>",
    htmlBodyParts,
    "<p>This mirrors your account's own message channel and carries no offers or marketing.</p>",
    `<p><a href="${escapeHtml(optOutUrl)}">Turn these emails off</a></p>`,
  ].join("\n");

  return { text: textParts.join("\n"), html };
}

// --- §4/§5 the drain ---------------------------------------------------

/**
 * Called once per tenant per tick, one line after `pruneTenantMessages` inside
 * `TenantDO.deliverabilitySweep` (§4). T11: the flag check is the FIRST thing
 * this function does — before any `ctx.sql` or `env.DB` touch.
 */
export async function drainMessageMirror(ctx: TenantContext, mailer: OpsMailer = createOpsMailer(ctx.env)): Promise<MirrorDrainResult> {
  if (!isMirrorArmed(ctx.env, ctx.tenantId)) return EMPTY_MIRROR_RESULT;

  const now = realNowMs();
  const outcome = claimMirrorBatch(ctx, now);
  if (outcome.kind === "empty") return EMPTY_MIRROR_RESULT;
  if (outcome.kind === "suppressed") return { ...EMPTY_MIRROR_RESULT, suppressed: outcome.count };

  const ids = outcome.rows.map((r) => r.id);

  let contactEmail: string | null = null;
  try {
    contactEmail = await lookupTenantContactEmail(ctx.env, ctx.tenantId);
  } catch (err) {
    console.error(`message mirror: contact-email lookup failed for tenant ${ctx.tenantId}`, err);
  }
  // §3 — NULL contact email -> no mirror, ever, no synthetic address. The
  // claim stays committed (this condition is permanently unmirrorable, same
  // as C4's "identity is the row" logic); nothing reaches mailer.send.
  if (!contactEmail) return { ...EMPTY_MIRROR_RESULT, noContact: 1 };

  try {
    const { text, html } = await composeMirrorEmail(ctx, contactEmail, outcome.rows);
    await mailer.send({ to: contactEmail, subject: mirrorSubject(outcome.rows), text, html });
    return { ...EMPTY_MIRROR_RESULT, sent: 1 };
  } catch (err) {
    releaseMirrorClaim(ctx, ids);
    console.error(`message mirror: send to tenant ${ctx.tenantId} failed (dark or transient)`, err);
    return { ...EMPTY_MIRROR_RESULT, failed: 1 };
  }
}
