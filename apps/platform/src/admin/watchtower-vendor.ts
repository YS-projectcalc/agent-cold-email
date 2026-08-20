// D2 monitoring — the ACCOUNT-WIDE vendor checks (Item 1, docs/adversarial/
// class-sweep-vendor-truth-2026-08-18.md, class B: "the vendor's prepaid
// credit wallet is a third resource — ≠ our $ ceiling, ≠ plan slots — that no
// code path reads, models, or can express").
//
// Split out of watchtower.ts (CLAUDE.md rule b) because these two checks are
// the only ones in the sweep that make a REAL VENDOR CALL: `d1`/`do_storage`
// probe our own infrastructure, `engine` probes our own droplet, and every
// per-tenant check reads D1/TenantDO state — none of them touch InboxKit.
// Activation-gated exactly like `RealMailboxPort`/`RealInboxKitDomainPort`
// (dark until BOTH `INBOXKIT_API_KEY` and `INBOXKIT_WORKSPACE_ID` are set),
// constructed the same way `TenantDO.inboxKitConfig()` does — this module has
// no tenant, so it builds its own `InboxKitClient` straight from `env`
// instead of going through a TenantContext.

import type { Env } from "../env.js";
import { InboxKitClient, type InboxKitClientConfig } from "../vendors/real/inboxkit-client.js";
import type { CheckResult } from "./watchtower-alerts.js";

export const VENDOR_WALLET_CHECK = "vendor_wallet";
export const WARMUP_DUPLICATES_CHECK = "warmup_duplicates";

/** Below this many InboxKit credits remaining, the wallet check is UNHEALTHY.
 * Env-tunable (`WALLET_FLOOR_CREDITS`) — mailbox/domain purchases and every
 * warmup add-on draw against this SAME wallet, so 10 credits is a few days'
 * runway at pilot scale, not a hard technical minimum. */
export const DEFAULT_WALLET_FLOOR_CREDITS = 10;

function walletFloorCredits(env: Env): number {
  const raw = env.WALLET_FLOOR_CREDITS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WALLET_FLOOR_CREDITS;
}

function inboxKitConfig(env: Env): InboxKitClientConfig | undefined {
  const apiKey = env.INBOXKIT_API_KEY;
  const workspaceId = env.INBOXKIT_WORKSPACE_ID;
  return apiKey && workspaceId ? { apiKey, workspaceId } : undefined;
}

/**
 * Are the two account-wide vendor checks EXPECTED to run in this environment?
 *
 * The one predicate, exported so `admin/watchtower-roster.ts` asks THIS file
 * rather than re-deriving "armed" from env vars. A roster that decides
 * separately whether a check should exist is a second source of truth, and the
 * gap between the two is where a check goes missing without anything saying so
 * — which is the exact defect the roster exists to close.
 */
export function vendorChecksArmed(env: Env): boolean {
  return inboxKitConfig(env) !== undefined;
}

// GET /billing/wallet's LIVE response (class-sweep Finding 6, live-probed
// 2026-08-18) — snake_case, like every other InboxKit payload. The sweep's
// own fix sketch guessed `{creditsRemaining, autoTopupEnabled}`; shipping
// that against `InboxKitClient.request`'s `body as T` cast would read
// `undefined < floor` as `false` and report this check healthy FOREVER — the
// exact class-F defect reproducing itself inside the class-B fix. Every field
// below is read through `unknown` and validated, never cast straight through.
interface WalletResponseUnknown {
  error?: unknown;
  message?: unknown;
  credits_remaining?: unknown;
  auto_topup_enabled?: unknown;
  total_credits?: unknown;
  auto_topup_trigger_drops_below?: unknown;
}

// POST /warmup/list — same shape RealMailboxPort.warmupSubscriptionState
// already parses (vendors/real/mailbox-port.ts); duplicated here in miniature
// (only the fields this check reads) rather than imported, since that method
// is private and this check's failure mode (an unparseable page) is its own,
// simpler "inconclusive -> healthy" (never alarm on a lookup we could not
// complete — false positives on an unrelated vendor hiccup are worse than a
// missed duplicate for one cycle).
interface WarmupListResponseUnknown {
  error?: unknown;
  subscriptions?: Array<{ uid?: unknown; mailbox_email?: unknown; mailbox?: { uid?: unknown } }>;
  pages?: unknown;
}

const WARMUP_PAGE_SIZE = 100;
// Same ceiling RealMailboxPort.warmupSubscriptionState uses — bounds the walk
// so a very large workspace can never turn this into an unbounded crawl.
const WARMUP_MAX_PAGES = 10;

/**
 * The two account-wide InboxKit checks, or `[]` when InboxKit is not armed
 * (skip-dark — a dark vendor is not a failure, matching `evaluateHealthChecks`'s
 * own `engine` check). NEVER throws: a vendor call failing IS the unhealthy
 * signal for `vendor_wallet`; `warmup_duplicates` reports the same call
 * family's own transient failure as healthy (nothing conclusive to alarm on,
 * see the interface comment above) rather than compounding one vendor hiccup
 * into two alerts.
 */
export async function evaluateVendorChecks(env: Env): Promise<CheckResult[]> {
  const config = inboxKitConfig(env);
  if (!config) return [];
  const client = new InboxKitClient(config);
  return [await checkVendorWallet(client, env), await checkWarmupDuplicates(client)];
}

async function checkVendorWallet(client: InboxKitClient, env: Env): Promise<CheckResult> {
  const floor = walletFloorCredits(env);
  let body: WalletResponseUnknown;
  try {
    body = await client.request<WalletResponseUnknown>("watchtowerWallet", "GET", "/billing/wallet");
  } catch (err) {
    return { name: VENDOR_WALLET_CHECK, healthy: false, detail: `inboxkit billing/wallet unreachable: ${errMsg(err)}` };
  }

  const creditsRemaining = body.credits_remaining;
  const autoTopupEnabled = body.auto_topup_enabled;
  if (typeof creditsRemaining !== "number" || !Number.isFinite(creditsRemaining) || typeof autoTopupEnabled !== "boolean") {
    // FAIL LOUD on shape drift — never report healthy on a body we could not
    // parse (the class-B "wallet response is snake_case" trap, applied
    // generally: ANY unexpected shape, not just the specific camelCase guess).
    return {
      name: VENDOR_WALLET_CHECK,
      healthy: false,
      detail: `inboxkit billing/wallet returned an unexpected shape (expected numeric credits_remaining + boolean auto_topup_enabled): ${JSON.stringify(body)}`,
    };
  }

  const belowFloor = creditsRemaining < floor;
  if (!belowFloor) {
    return {
      name: VENDOR_WALLET_CHECK,
      healthy: true,
      basis: "reobserved",
      detail: `inboxkit wallet has ${creditsRemaining} credit(s) remaining (floor ${floor}).`,
    };
  }
  return {
    name: VENDOR_WALLET_CHECK,
    healthy: false,
    detail:
      `inboxkit wallet has ${creditsRemaining} credit(s) remaining, below the floor of ${floor}. ` +
      (autoTopupEnabled
        ? `Auto-topup is ON — this may self-heal, but is worth watching (purchases/warmup draw against this same wallet).`
        : `Auto-topup is OFF — this will NOT self-heal; fund the wallet or enable auto-topup before the next purchase/warmup call refuses for funds.`),
  };
}

async function checkWarmupDuplicates(client: InboxKitClient): Promise<CheckResult> {
  const seen = new Map<string, string>(); // mailbox uid|email -> first-seen subscription uid
  const duplicateMailboxes = new Set<string>();

  for (let page = 1; page <= WARMUP_MAX_PAGES; page++) {
    let body: WarmupListResponseUnknown;
    try {
      body = await client.request<WarmupListResponseUnknown>("watchtowerWarmupDuplicates", "POST", "/warmup/list", {
        body: { page, limit: WARMUP_PAGE_SIZE, status: "active", include_cancelled: false },
      });
    } catch {
      // Inconclusive lookup — proves nothing (mirrors warmupSubscriptionState's
      // own "inconclusive" reasoning). Reported healthy: an unrelated vendor
      // hiccup here must not alarm this check every cycle.
      return { name: WARMUP_DUPLICATES_CHECK, healthy: true, basis: "reobserved", detail: "inboxkit warmup/list lookup was inconclusive this cycle — nothing to report." };
    }
    if (body.error) {
      return { name: WARMUP_DUPLICATES_CHECK, healthy: true, basis: "reobserved", detail: "inboxkit warmup/list returned an application error this cycle — nothing to report." };
    }

    const subscriptions = body.subscriptions ?? [];
    for (const sub of subscriptions) {
      const mailboxUid = typeof sub.mailbox?.uid === "string" ? sub.mailbox.uid : undefined;
      const mailboxEmail = typeof sub.mailbox_email === "string" ? sub.mailbox_email.toLowerCase() : undefined;
      const identity = mailboxUid ?? mailboxEmail;
      if (!identity) continue; // can't identify which mailbox this subscribes — nothing to compare
      const subUid = typeof sub.uid === "string" ? sub.uid : "(no uid)";
      if (seen.has(identity)) {
        duplicateMailboxes.add(mailboxEmail ?? identity);
      } else {
        seen.set(identity, subUid);
      }
    }

    if (subscriptions.length === 0 || page >= (typeof body.pages === "number" ? body.pages : 1)) break;
  }

  if (duplicateMailboxes.size === 0) {
    return { name: WARMUP_DUPLICATES_CHECK, healthy: true, basis: "reobserved", detail: "no duplicate active warmup subscriptions found." };
  }
  return {
    name: WARMUP_DUPLICATES_CHECK,
    healthy: false,
    detail: `${duplicateMailboxes.size} mailbox(es) have MORE THAN ONE active InboxKit warmup subscription (double-billing the $3/mo add-on): ${[...duplicateMailboxes].join(", ")}.`,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
