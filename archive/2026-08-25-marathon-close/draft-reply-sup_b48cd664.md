# DRAFT operator reply — ticket sup_b48cd664 (Mordy / Author Pitch Desk, via his agent, 2026-08-25)

> FOUNDER REVIEW BEFORE SEND. Pre-send checklist: (1) re-confirm warmup enrollment ×4 live via InboxKit `POST /v1/api/warmup/list` at send time; (2) fill in the timing commitment in A3 — it should match when you will actually run the 4 Gmail OAuth grants (checklist item #1, ~10 min/mailbox, before warmup ripens ~Sep 14); (3) send via the standard operator-message path (never email from a personal address).

---

Thanks for the detailed questions — answers in order.

**1) Warmup mechanism — both (a) and (b).** All four of your mailboxes are enrolled in genuine seed-pool warmup ((b)): real messages exchanged with a pool of established mailboxes, opened and engaged, run by our mailbox-infrastructure layer. That traffic runs vendor-side between pool mailboxes, so it does not transit your Coldrig sending pipeline — which is exactly why `sends`, `sentToday`, and the activity feed show zero: those count your campaign sends only. Your first-party evidence today is the per-mailbox "warmup enrollment" deliverability action you found, plus `warmupDay` advancing daily. We have re-confirmed enrollment is active on all four mailboxes as of this reply. You're right that richer first-party warmup evidence (pool traffic stats surfaced in `infrastructure_status`) is missing — we've added it to the roadmap. Separately, (a) is also true: Coldrig applies its own server-side ramp caps to your campaign sends (that's the 5→40/day ramp).

**2) Safe test volume now.** Your current caps are the safe ceiling: 15/day on mordytee11 and 5/day on each of the other three — 30/day total. Campaign sends draw the per-mailbox `dailyCap`; warmup traffic does not (separate budget, vendor-side). Spread the test across all four mailboxes rather than concentrating it — even ramp per mailbox is what protects reputation. One dependency: see (3) — sending begins once send-authorization lands.

**3) Credentials pending — yes, a real step is outstanding on our side.** Each mailbox needs a one-time send-authorization grant that, per the mailbox provider's policy, we complete manually on our side; nothing is required from you. We have it scheduled for <FOUNDER: date/time>. If you launch your test before it lands: the campaign is accepted and your leads queue safely — nothing leaves and nothing is lost — and sending starts automatically per mailbox as its authorization lands, under the ramp caps above. We'll drop you a note when all four are live.
