# hard-builder memory index

## Failure mechanisms (check before diagnosing a hard case)
- [coldstart-per-tick-recompute-clobbers-control-state](coldstart-per-tick-recompute-clobbers-control-state.md) — a per-tick refresh that recomputes a column (warmup daily_cap/status) silently wipes any control-loop override written to the SAME column; keep loop state in a SEPARATE column + have the refresh honor it (MIN).
