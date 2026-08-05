# class-sweeper memory index

- [coverage-ledger.md](coverage-ledger.md) — ColdStart surfaces that UNDER-COUNT in a sweep (downstream signal consumers, port error contract, sandbox masking, dropped webhook fields, schema can't-express, cron lanes). Read FIRST.
- [idempotency-at-least-once-surfaces.md](idempotency-at-least-once-surfaces.md) — sweeping non-idempotent at-least-once external inputs: activation-latent inputs (sandbox delivers exactly-once), fake `:${now}` idempotency keys, client-retry vs vendor-redelivery variants.
- [vendor-mutation-saga-surfaces.md](vendor-mutation-saga-surfaces.md) — stranded-vendor-state sweeps: wrappers that delete their own record on throw, `_idempotencyKey` no-op adapters, spend ledger without resource identity, worktree copies inflating greps.
- [idempotency-replay-surfaces.md](idempotency-replay-surfaces.md) — keys that exist but don't replay: `_idempotencyKey` ignored, the claim-kept-effect-lost mirror, clients that send no key, a test encoding the defect, docs asserting absent coverage.
- [error-mapping-surfaces.md](error-mapping-surfaces.md) — opaque-500 sweeps: THREE mapping chains (HTTP onError / MCP handler / engine statusFor), subclass-mapped-but-base-unmapped, openapi as published contract, per-call-site graceful catches.
