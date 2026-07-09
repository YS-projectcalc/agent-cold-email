# hard-builder memory index

## Failure mechanisms (check before diagnosing a hard case)
- [coldstart-per-tick-recompute-clobbers-control-state](coldstart-per-tick-recompute-clobbers-control-state.md) — a per-tick refresh that recomputes a column (warmup daily_cap/status) silently wipes any control-loop override written to the SAME column; keep loop state in a SEPARATE column + have the refresh honor it (MIN).
- [coldstart-suspend-auth-split-do-vs-d1](coldstart-suspend-auth-split-do-vs-d1.md) — ColdStart: DO `tenant_profile.status='suspended'` does NOT lock the token (requireAuth reads D1 `tenants_index.status`); flip BOTH to truly disable a tenant, or a "suspended" tenant re-provisions.
- [backtick-inside-template-literal-sql](backtick-inside-template-literal-sql.md) — a backtick in a backtick-delimited SQL template literal (even in a `--` comment) ends the string → misleading TS1005 errors; never backtick-quote inside a template literal.
