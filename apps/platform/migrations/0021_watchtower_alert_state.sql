-- The alert-state increment (frozen design docs/research/alert-state-design-
-- 2026-08-20.md §2.1) — three fields the state machine needs and the D1-backed
-- store had nowhere to put. The transition RULE is src/admin/watchtower-policy.ts;
-- this file only widens the row.
--
-- NUMBERED 0021, NOT the 0020 the design names. 0019 was taken by the sweep
-- cursor and 0020 by the SDN name index while that design was being gated — the
-- rule the design states is "re-pick from `ls apps/platform/migrations | tail -1`
-- at build time", precisely because a number written in a design doc is stale by
-- construction when other lanes are in flight.
--
-- NOT read by GET /admin/ops/checks (src/routes/admin-ops.ts): that route's
-- SELECT names its columns explicitly (readAllCheckRows), so its response shape
-- is unchanged by these three.

-- Healthy observations since the last unhealthy one, WITHIN an open episode. A
-- re-observed check now needs 3 clean observations to close, so an intermittent
-- fault no longer has its unhealthy count wiped by every good tick — the defect
-- that made a check failing every other sweep stay silent forever (0 emails over
-- 24 alternating observations, executed against the pre-fix code). It is also
-- what tells an operator a recovery is in progress on a row still reading
-- status='unhealthy'.
ALTER TABLE watchtower_state ADD COLUMN healthy_obs INTEGER NOT NULL DEFAULT 0;

-- Ladder rungs climbed — `realerted` emails only. SPLIT OFF alert_count, which
-- was carrying two facts at once ("was this episode announced" AND "how many
-- rungs"). Because the gap was `alert_count >= 2 ? steady : first`, ANY
-- increment promoted the check from the 6h rung to the 24h rung, so the new
-- `escalated` email would have silently DELETED the episode's "still broken"
-- ping. Escalations are now rung-neutral.
ALTER TABLE watchtower_state ADD COLUMN realert_count INTEGER NOT NULL DEFAULT 0;

-- The per-episode announced ledger: which materiality keys this episode has
-- actually told the founder about, and how many distinct ones the per-episode
-- cap turned away. Without it the machine compares a two-valued healthy/unhealthy
-- status and cannot tell a repeat from an escalation — a second, genuinely worse
-- condition under the same check name reached the founder as an edited detail
-- string on an already-suppressed row.
ALTER TABLE watchtower_state ADD COLUMN announced_keys TEXT NOT NULL DEFAULT '{"keys":[],"overflow":0}';

-- Preserve each IN-FLIGHT episode's current rung exactly. 0018's own backfill
-- credited alert_count = 2 to running episodes precisely so they sit on the 24h
-- step; without this line they drop back to the 6h rung and emit one extra email
-- each on deploy day — the thing that ruling exists to stop.
UPDATE watchtower_state
   SET realert_count = 1
 WHERE alert_count >= 2;

-- NO BACKFILL FOR announced_keys, deliberately. An episode with alert_count > 0
-- and an EMPTY ledger is the LEGACY-ADOPT predicate (design §2.2): decideAlert
-- adopts its first observed key SILENTLY — no email, key appended, counters
-- untouched. That one rule covers this table AND WatchtowerDO storage, which has
-- no migration mechanism at all; a backfill would only ever reach one of them.
-- The predicate is unreachable for state the new code writes: `alerted` writes
-- alert_count and the first key together, `escalated`/`realerted` only append,
-- withheldAlertState copies the previous ledger, and an episode close zeroes both.
