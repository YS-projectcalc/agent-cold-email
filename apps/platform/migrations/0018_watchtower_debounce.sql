-- Founder ruling 2026-08-16 — the alert-policy change (transition debounce +
-- re-alert backoff). Two counters the state machine needs and the D1-backed
-- store had nowhere to put; see src/admin/watchtower-policy.ts for the rule.
--
-- NOT read by GET /admin/ops/checks (src/routes/admin-ops.ts): that route's
-- SELECT names its columns explicitly (readAllCheckRows), so its response shape
-- is unchanged by these two.

-- Consecutive unhealthy observations in the current episode. A check must be
-- observed unhealthy on 2 CONSECUTIVE sweeps before its first email, so a
-- single-sweep flap costs zero emails; any healthy observation resets this.
ALTER TABLE watchtower_state ADD COLUMN unhealthy_obs INTEGER NOT NULL DEFAULT 0;

-- Unhealthy emails ISSUED in the current episode. 0 means the founder was never
-- told about this episode, which is what suppresses the RECOVERED email for a
-- debounced flap; it also drives the backoff ladder (confirm -> +6h -> +24h).
ALTER TABLE watchtower_state ADD COLUMN alert_count INTEGER NOT NULL DEFAULT 0;

-- Backfill the episodes that are ALREADY running at deploy time — the two
-- stuck `domain_dns_aging` checks this ruling exists for are exactly this case.
-- Under the old rule an unhealthy row always carried last_alert_ts (it was set
-- on entering the state), so a non-NULL one is proof the episode was announced.
-- Crediting 2 alerts puts it straight onto the 24h step: without this it would
-- read as a brand-new, never-announced episode, re-announce itself two sweeps
-- after deploy and restart the ladder at 6h — one more duplicate email for the
-- checks the founder is already drowning in.
UPDATE watchtower_state
   SET alert_count = 2,
       unhealthy_obs = 2
 WHERE status = 'unhealthy'
   AND last_alert_ts IS NOT NULL;
