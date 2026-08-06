---
name: caller-side-effect-gated-on-callee-result-field
description: CLASS - a caller-side side effect gated on a result field (if (result.plan)) silently stops firing when the callee gains a NEW return path that applies the effects but reports them as a duplicate
metadata:
  type: project
---

CLASS: lane A hangs a side effect off a field of another function's RESULT
(`const r = await applyStripeWebhookEvent(...); if (r.plan) this.switchToRealClock()`).
Lane B then adds a NEW return path in that callee which DOES apply the effects
but reports them under different flags (`{applied:false, duplicate:true,
completed:true}` — no `plan`). The gate silently stops firing on that path.
Neither lane's tests can see it: lane A never exercises the new path, lane B
does not know the caller's hook exists.

**Observed (wave-2 integration, 2026-08-06).** Stripe `checkout.session.completed`
crashes on the vendor round trip; the retry's completion pass finishes it. Probe
on the real HTTP path:
```
PROBE after crash:  {"plan":"managed","clock_mode":"virtual","billing_state":"active"}
PROBE completion body: {"received":true,"applied":false,"duplicate":true,"completed":true}
PROBE after retry:  {"plan":"managed","clock_mode":"virtual","billing_state":"active"}
PROBE after evict+reconstruct: {"plan":"managed","clock_mode":"real",...}
```
Durably paid, still on the virtual clock. NOT merge-introduced (base's plain
duplicate return carried no `plan` either) and it self-heals at the next DO
construction, and the failure direction is "stays gated off" — but the gate is
the caller's, so no callee test protects it.

**How to apply:** when a lane adds a return path to a shared applier, grep the
CALLERS for branches on that result's fields and re-check each. Prefer gating a
caller-side flip on the DURABLE state it cares about (read `plan`/`clock_mode`
back) over a transport field of one call's result. A constructor/rehydrate
self-heal makes such a gap bounded rather than permanent — check for one before
grading severity.

**Sibling trap in the same merge:** a schema comment asserted a defensive gate
that does not exist (`mailboxes.provider = ''` "excluded by the send-eligibility
picker" — `tick.ts` never filters on `provider`). Implementing it as written
would brick sending for every NEW mailbox, since `insertProvisionedMailbox` never
sets the column. Verify a comment's claimed gate with a grep before trusting or
"restoring" it.

Related: [[merge-of-prerefactor-lane-reverts-sibling-fix]],
[[completion-pass-must-recheck-ordering]], [[persist-before-confirm-cross-boundary]].
