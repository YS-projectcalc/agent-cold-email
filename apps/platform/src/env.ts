import type { TenantDO } from "./tenant-do.js";
import type { RateLimiterDO } from "./rate-limiter-do.js";

// Cloudflare's convention (what `wrangler types` generates): augment the
// global `Cloudflare.Env` namespace so both `c.env` in Hono and the `env`
// export from `cloudflare:test`/`cloudflare:workers` pick up these bindings.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TENANT: DurableObjectNamespace<TenantDO>;
      SIGNUP_LIMITER: DurableObjectNamespace<RateLimiterDO>;
      TOKEN_HASH_PEPPER: string;
      WAITLIST: KVNamespace;
      // B1 money path — optional test-mode Stripe secrets. Unset in this
      // build (CLAUDE.md rule g: no real vendor secret anywhere in the
      // repo); wiring a real Stripe TEST key is an ACTIVATION.md step. Every
      // code path that reads these must treat them as absent and fall back
      // to the simulated checkout / accept-without-verification webhook mode.
      //
      // The `// spend-arming` marker below is a MACHINE-READABLE contract
      // enforced by spend-armed-env-coverage.test.ts (R3-1): every field so
      // tagged MUST be referenced by isRealSpendArmed (engine/billing.ts), and
      // every NEW env field must be categorized as spend-arming-or-not, so the
      // NEXT vendor binding trips RED instead of silently reopening the
      // free-money simulate bypass. STRIPE_SECRET_KEY arms Stripe spend;
      // STRIPE_WEBHOOK_SECRET only VERIFIES inbound events (arms nothing).
      STRIPE_SECRET_KEY?: string; // spend-arming
      STRIPE_WEBHOOK_SECRET?: string;
      // D1/D2/D6 admin surface (apps/platform/src/admin/README.md) — bearer
      // secret gating every /admin/* route (cross-tenant data, never the
      // per-tenant token from require-auth.ts). Optional binding: unset ->
      // requireAdminAuth fails closed (401 on every /admin/* call, never an
      // open-by-default bypass). Set via `wrangler secret put ADMIN_TOKEN`
      // for a deployed environment, or `.dev.vars` locally (see
      // .dev.vars.example) — CLAUDE.md rule g: never in code or git.
      ADMIN_TOKEN?: string;
      // External email engine (apps/engine — ARCHITECTURE.md #6). BOTH must be
      // set to activate the real EmailPort; either unset keeps RealEmailPort
      // dark (it throws NotActivatedError), so the deployed default cannot reach
      // a live mail server (CLAUDE.md rule g: the secret is a wrangler secret,
      // never in code/git; see ACTIVATION.md Gate 2 "Go-engine host"). Note:
      // even with both set, the adapter factory (vendors/factory.ts) still only
      // hands the real adapter to an activated paid tenant — a demo/free tenant
      // is forced to sandbox first, unconditionally.
      //
      // Both `// spend-arming` (R3-1): the engine is the real send path AND the
      // credential-push target — its presence means real vendor spend is
      // reachable, so isRealSpendArmed must OR them in (they gate together, but
      // each is tagged so removing either still trips the coverage guard).
      ENGINE_BASE_URL?: string; // spend-arming
      ENGINE_AUTH_SECRET?: string; // spend-arming
      // Self-serve activation I3 — InboxKit workspace credentials (the real
      // mailbox/domain vendor). Bearer JWT + X-Workspace-Id (inboxkit-client.ts).
      // Unset in this build (CLAUDE.md rule g — set as a wrangler secret + var
      // at arming, never in code/git); absent keeps every InboxKit-backed
      // adapter dark and the credential-push flow inert. `// spend-arming`
      // (R3-1): the moment these bind, real mailbox/domain spend is reachable —
      // isRealSpendArmed MUST treat them as an arming signal so the free-money
      // simulate checkout stays closed (the class the guard test enforces).
      INBOXKIT_API_KEY?: string; // spend-arming
      INBOXKIT_WORKSPACE_ID?: string; // spend-arming
      // G5 gate (a) — domain-registrar arming, DELIBERATELY DECOUPLED from
      // INBOXKIT_* above (ROADMAP.md:19,33,43; adversary B1 2026-07-23: the
      // old factory logic welded `domain.buy` to the mailbox vendor
      // credential, so arming InboxKit for mailboxes silently also armed
      // InboxKit-as-registrar). Cloudflare Registrar is the founder-ruled
      // default provider (Namecheap fallback) — see vendors/factory.ts and
      // vendors/real/domain-port.ts. Setting these does NOT yet wire a
      // working purchase adapter (the Cloudflare purchase-API wire shape is
      // unverified — GA-wave scope note 2026-07-23), but the moment they
      // bind, real registrar-spend intent is signaled, so `// spend-arming`
      // (R3-1): isRealSpendArmed MUST treat them as an arming signal same as
      // INBOXKIT_*, enforced by spend-armed-env-coverage.test.ts.
      REGISTRAR_PROVIDER?: string; // spend-arming
      CLOUDFLARE_REGISTRAR_API_TOKEN?: string; // spend-arming
      // GA gates G2/G4 (ga-gates-design-2026-07-22.md §G2/§G4) — the
      // vendor-spend ceiling + cost table + InboxKit plan-slot capacity. All
      // founder-tunable knobs with conservative defaults (see
      // engine/spend-ceiling.ts). DELIBERATELY *NOT* `// spend-arming`
      // (collision note vs the I3/I4 lane): these do NOT arm real vendor spend
      // — they BOUND it. Arming spend is INBOXKIT_*/ENGINE_*/REGISTRAR_*
      // (above); a ceiling with no armed vendor spends $0. Tagging them
      // spend-arming would make spend-armed-env-coverage.test.ts demand
      // isRealSpendArmed read them (wrong — a spend CAP is not a spend ENABLER),
      // so they are categorized in that test's KNOWN_NON_SPEND_ARMING instead.
      // Values are strings (wrangler `[vars]`); parsed to ints with the
      // documented defaults when unset/blank.
      SPEND_CEILING_CENTS?: string;
      COST_MAILBOX_CENTS?: string;
      COST_DOMAIN_CENTS?: string;
      COST_PREWARM_MAILBOX_CENTS?: string;
      INBOXKIT_PLAN_SLOTS?: string;
      // Self-serve I3 — operator-supplied gmail_api OAuth grants for the MANUAL
      // mint path (the proven 2026-07-19 pilot path), a JSON secret
      // {email:{clientId,clientSecret,refreshToken}}. NOT spend-arming: holding
      // refresh tokens arms nothing on its own — provisioning still needs
      // INBOXKIT_* and sending still needs ENGINE_*; this is inert without both.
      // Absent -> the manual minter fails LOUD per-mailbox (the mailbox stays
      // 'pending', reconcile retries once grants land). Set as a wrangler secret
      // at arming (CLAUDE.md rule g), never in code/git.
      GMAIL_OAUTH_GRANTS?: string;
      // Ops email + monitoring (watchtower/dunning/support). The Cloudflare
      // Email Service `send_email` binding (wrangler.toml `[[send_email]]`
      // name = "OPS_EMAIL") — NO api keys, sends from a domain onboarded via
      // `wrangler email sending enable coldrig.dev` (ACTIVATION.md, owner-
      // hands). OPTIONAL/dark by design: absent (binding undeclared or the
      // domain not yet onboarded) -> RealOpsMailer throws OpsMailNotConfigured
      // which every caller catches-and-logs, so an unsendable alert can never
      // take down a request path or the sweep. Present + domain live -> real
      // sends. Never bound in tests/dev (the sandbox mailer records instead).
      OPS_EMAIL?: SendEmail;
      // Destination for founder ops alerts + the support@ inbound forward
      // (src/admin/watchtower.ts, src/admin/support-inbound.ts). A plain
      // `[vars]` entry (jacob@epiphanymade.com), NOT a secret — it is already
      // public on the legal pages (site/privacy.html, site/terms.html). The
      // forward target must additionally be a VERIFIED Email Routing
      // destination before `message.forward` works (ACTIVATION.md arming step).
      OPS_ALERT_EMAIL: string;
      // SPEC.md §19.1 — the dashboard SPA's static asset bundle (public/app/),
      // served by Cloudflare's own asset layer via [assets] in wrangler.toml.
      // Not fetched from Worker code today (run_worker_first excludes /app/*
      // so the asset layer serves it directly) — typed here so a future
      // Worker-side ASSETS.fetch shim (the spec's documented fallback if the
      // declarative [assets] config can't scope cleanly) has a binding ready.
      ASSETS: Fetcher;
      // B4 opt-out — the public https origin this Worker is reachable at,
      // embedded in the RFC 8058 hosted one-click unsubscribe URL a tick
      // builds (engine/tick.ts's buildListUnsubscribe). NOT a secret (this
      // exact URL is already published in README.md/HANDOFF.md) — a plain
      // `[vars]` entry in wrangler.toml, not a wrangler secret. Optional:
      // engine/tick.ts falls back to the same real deployed URL as a
      // code-literal default, so local dev/test needs no configuration and a
      // missing binding never breaks the hosted link.
      PUBLIC_BASE_URL?: string;
      // Turnstile bot-challenge (design docs/research/human-signup-magic-
      // link-design-2026-07-22.md §2.3) — `/login` ONLY, never `/signup`
      // (signup.ts:15-16: signup must stay agent-drivable, so it cannot be
      // gated by an interactive challenge). SECRET is server-only (`wrangler
      // secret put TURNSTILE_SECRET` at ACTIVATION, never in code/git —
      // CLAUDE.md rule g); SITE_KEY is PUBLIC by design (it embeds in client
      // HTML for the widget to render) so it would be a plain [vars] entry
      // once the turnstile-spin skill provisions a real widget — neither is
      // declared in wrangler.toml yet (no real widget exists in this build).
      // Both OPTIONAL, dark-safe: absent SECRET -> turnstile.ts's
      // verifyTurnstile is a no-op (always passes); absent SITE_KEY -> the
      // dashboard's TurnstileWidget renders nothing.
      //
      // NOT spend-arming — this is auth/bot-defense infrastructure, not a
      // vendor-spend signal (adversary r1 guidance, design §4 collision
      // note): excluded from isRealSpendArmed on purpose, and categorized
      // into KNOWN_NON_SPEND_ARMING (spend-armed-env-coverage.test.ts).
      TURNSTILE_SECRET?: string;
      TURNSTILE_SITE_KEY?: string;
      // G1a OFAC screening — the public US Treasury SDN.CSV download URL
      // (ga-gates-design-2026-07-22.md §G1a). NOT a secret (no auth/API key —
      // a plain public download), so a plain `[vars]` entry like
      // PUBLIC_BASE_URL/OPS_ALERT_EMAIL above, not a wrangler secret.
      // NOT `// spend-arming` — fetching a public list costs nothing and arms
      // no vendor spend; isRealSpendArmed does not read it. Optional: absent
      // falls back to the real Treasury URL as a code-literal default
      // (src/ofac/sdn-refresh.ts), matching PUBLIC_BASE_URL's own
      // no-configuration-needed-in-dev/test posture.
      OFAC_LIST_URL?: string;
    }
  }
}

export type Env = Cloudflare.Env;
