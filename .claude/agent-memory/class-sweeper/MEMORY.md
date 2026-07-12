# class-sweeper memory index

- [coverage-ledger.md](coverage-ledger.md) — ColdStart surfaces that UNDER-COUNT in a sweep (downstream signal consumers, port error contract, sandbox masking, dropped webhook fields, schema can't-express, cron lanes). Read FIRST.
- [idempotency-at-least-once-surfaces.md](idempotency-at-least-once-surfaces.md) — sweeping non-idempotent at-least-once external inputs: activation-latent inputs (sandbox delivers exactly-once), fake `:${now}` idempotency keys, client-retry vs vendor-redelivery variants.
