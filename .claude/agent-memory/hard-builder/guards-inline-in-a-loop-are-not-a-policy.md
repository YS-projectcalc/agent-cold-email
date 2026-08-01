---
name: guards-inline-in-a-loop-are-not-a-policy
description: "CLASS: governance written INLINE in a batch loop (tick) is unenforced on every other path that reaches the same effect — a second entry point (manual reply) bypasses caps/pause/suppression silently while the read-only status API still reports 0."
metadata:
  type: project
---

CLASS: a policy (rate cap, pause state, suppression, quota) implemented **inline inside one
batch loop** is not a policy — it is a property of that loop. Any second entry point that
reaches the same side effect gets ZERO enforcement, and the metering column the policy reads
is never incremented, so the read-only status surface keeps reporting compliance while the
bypass runs unbounded.

**Member found (ColdStart, warm-lead Q3):** `engine/tick.ts` enforced per-mailbox daily cap,
`deliv_status='paused'` exclusion, suppression re-check and `sent_today` increment inline in
its send loop. `engine/threads.ts` `replyToThread` called `adapters.email.send` DIRECTLY —
an agent could loop the `reply` MCP tool with varied bodies and send unbounded mail from a
day-1 or deliverability-paused mailbox while `infrastructure_status` reported `sentToday: 0`.
`engine/mailbox-state.ts:51-53` had literally documented the gap ("currently just the tick")
and it still shipped. Fix: `engine/guarded-send.ts` `sendWithGuards`, the ONE choke point
every non-campaign send goes through.

**Why:** the tick's guards were written as loop-local control flow, not as a callable unit,
so there was nothing for a second caller to reuse even if it wanted to. The adversary
(`docs/adversarial/warm-lead-thin-layer-design-2026-07-16.md` R1/R2) predicted this exact
defect *at design time* and it was still built the ungoverned way.

**How to apply:** when you see governance inline in a loop, the sweep question is never "is
this loop correct?" — it is **"grep every call site of the guarded EFFECT (the vendor port /
the write), not the guard."** In ColdStart that's `adapters.email.send`: two call sites, one
governed and one not. A guard-side grep finds nothing.

Two build details that fell out and generalize:
- **Do not copy the whole loop's guard list into the new primitive.** The tick's
  `lead_status !== 'active'` skip would have refused the entire warm-reply use case (a lead
  that replied is exactly who a manual reply targets, and `global_status` moves off 'active'
  on reply). Sort guards into *compliance* (re-check everywhere: suppression) vs *sequencing*
  (loop-local: lead lifecycle, campaign send-window, row claim).
- **A cap check followed by an `await` is a TOCTOU.** In a DO the await reopens the input
  gate. Use ONE conditional UPDATE as check-and-reserve
  (`SET sent_today = sent_today + 1 WHERE id = ? AND tenant_id = ? AND sent_today < daily_cap`,
  assert `rowsWritten === 1`), then release on send failure — same `rowsWritten` claim idiom
  `tick.ts` uses on `scheduled_sends`.

Related: [[persist-before-confirm-cross-boundary]] (same await-boundary family, opposite
direction), [[coldstart-authed-route-needs-path-pattern-and-zod-default-output-required]].
