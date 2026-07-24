-- Adversary finding 2 (docs/adversarial/sdn-relay-review-2026-07-24.md) — a
-- monotonicity/staleness guard on the droplet-relay ingest needs a signal to
-- detect a naive REPLAY of an already-active list. SDN.CSV carries no
-- publication-date column (see sdn-parse.ts's column contract), so the
-- cheapest honest signal is a content hash of the raw CSV text, recorded
-- alongside the list it produced. Only src/ofac/sdn-ingest.ts writes/reads
-- this column; the direct-fetch refresh (sdn-refresh.ts) leaves it NULL
-- (that path has no attacker-controlled-replay threat model — a fixed,
-- non-attacker-controlled Treasury URL, not a bearer-token-gated upload).

ALTER TABLE sdn_list_meta ADD COLUMN content_hash TEXT;
