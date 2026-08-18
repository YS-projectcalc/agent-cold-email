---
name: fixture-born-with-the-code-restates-its-premise
description: A fixture written in the SAME commit as the adapter that reads it tests the code's premise, not the vendor's behaviour — getHealth destructured fields the live payload never had, shipped NaN, and stayed green for a month.
metadata:
  type: reference
---

⚠️ CLASS. If a response fixture and the code that parses it were authored together from *docs* rather than a *capture*, the contract test proves only that the mapper can read our own invention. Every such test is green by construction and says nothing about production.

**The instance (coldstart, class F, 2026-08-18):** `IK_MAILBOX_HEALTH_SUCCESS` had `health_status`, `bounce_rate`, `reply_rate`, `sent_7d`, `received_7d`. The live `GET /email-insights/mailbox/{uid}/health` returns `status`, `bounce_rate_30d`, `total_7d`, `total_30d`, `last_event_at` — no overlap on the two fields read. So `bounce_rate / 100` was `NaN`, `Math.min(1, Math.max(0, NaN))` is `NaN` (the clamp that LOOKS like a guard passes it straight through), and a customer-facing `vendorPlacementRate` was NaN while `vendorReputationScore` was a constant 50 derived from an absent enum. `IK_MAILBOX_CREDENTIALS_SUCCESS` was worse: an invented success payload for an endpoint that 404s.

**Tells:** the fixture's doc comment says "documented-shape guess" / "UNVERIFIED" · a `KNOWN APPROXIMATION` comment on the mapper · derived fields (`1 - x`) with no capture behind them.

**How to apply:**
- Give every fixture a provenance header — `capturedFrom:` (full URL + method) and `capturedAt:` (date). No provenance = not evidence.
- DELETE rather than "correct" a fixture whose endpoint does not exist; there is nothing to correct it to. Replace it with the real answer (e.g. the 404) and let the mapper stay explicitly untested-by-design.
- Type the port so it can say "the vendor does not report this" (`number | null`). A shape that cannot express *unknown* forces every implementation to invent a value — and then a `?? 0` at the consumer quietly re-invents it one layer out.
- A non-finite guard belongs where the division happens, returning null — not a clamp.

Siblings: [[fixture-decorates-vendor-owned-object]] (our field on a vendor-minted object), [[sandbox-port-masks-real-server-contract]], [[sandbox-fallback-masks-a-missing-activation-gate]].
