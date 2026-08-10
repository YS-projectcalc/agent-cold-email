# Adversary gate — purchased-domain DNS-wait fix (2026-08-10)

**Branch** `fix/purchased-dns-wait-2026-08-10` · **HEAD** `d0dd932` (verified with
`git rev-parse HEAD` at review start) · **Fix commit** `bc1a927` · **Also on branch**
`eca06a7` + `d0dd932`, a docs-only merge of main (HANDOFF tool-count claim guard).
**Reviewed diff** `git show bc1a927` (4 files, +256/-93) plus a full trace of every
consumer of what it changes.

**Rounds:** 1.

## VERDICT — SHIP

No BLOCKING finding survives self-refutation. The fix does what its commit message says,
its tests genuinely fail on the old code, and every over-widening attack I could construct
was refused by the code. Three NON-BLOCKING findings are recorded, all of them about what
the fix *does not* cover rather than about what it does; finding #1 is the residual the
builder flagged for ratification and it is stated here in full, unsoftened.

**Battery re-run independently** (sandbox copy at
`/private/tmp/.../scratchpad/sandbox`, `node_modules` symlinked to the worktree —
worktree git left untouched):

```
apps/platform  npx vitest run   →  Test Files 166 passed (166)   Tests 1528 passed (1528)
npm run typecheck (root)        →  dashboard / engine / platform / agent-cold-email / shared, rc=0
```

The builder's `1527/1528` is now `1528/1528`: the one red was main's HANDOFF tool-count
docs guard, fixed on main and merged in at `d0dd932`. Confirmed green, not waived.

**RED proof re-derived, not accepted.** I copied the tree to a sandbox, deleted the single
added line `inboxkit-domain-port.ts:455` (`if (connectionType === "purchased") return true;`)
and re-ran the two changed test files:

```
Tests  4 failed | 20 passed (24)
  × domain-connection-type      > Mordy's EXACT live shape … clears the gate
  × provisioning-orphan-accept. > MORDY'S LIVE SHAPE: … no longer block the mailbox
  × provisioning-orphan-accept. > the vendor failing DURING mailbox processing …
  × provisioning-orphan-accept. > the customer never sees the provider's name …
```

Restoring the line returns 24/24. The tests are load-bearing on the one-line behaviour
change, not coverage theater.

---

## Findings

### 1. NON-BLOCKING · lens 6/8 · THE RESIDUAL (brief item f + g), stated plainly: "never bill onto dead mail DNS" is now guaranteed by nothing that looks at DNS

The commit is explicit that the guarantee moved to the mailbox leg —
`engine/mailbox-provisioning.ts:197` awaits `provisioningState === "ready"` before the
billable row at `:158` and the meter at `:161`. I verified that ordering by reading it and
by executing it. **What I also verified is what that confirmation actually asserts, and it
is weaker than the sentence implies.**

`vendors/real/mailbox-port.ts:88-92`:

```ts
async provisioningState(email: string): Promise<MailboxProvisioningState> {
  const match = await this.findExactMailbox(email);
  if (!match) return "absent";
  return (match.status ?? "").trim().toLowerCase() === "active" ? "ready" : "pending";
}
```

That is one field of `POST /mailboxes/list`. It confirms **the mailbox exists and the
vendor calls it active**. It is not an assertion about the domain's MX/SPF/DKIM/DMARC, and
the adapter never asks about them again. So the chain is:

> the vendor said it would configure DNS during mailbox processing → the vendor says the
> mailbox is active → therefore the DNS is configured.

The last step is an inference from a support email, not an observation. Nothing in the
codebase can falsify it.

**Executed proof of the exposure (probe P7, real `POST /setup-infrastructure`, real
adapters, stateful vendor fake whose DNS fields NEVER move):**

```
domains:    [{ domain: goauthorpitchdesk.com, dns_status: "ready", first_send_eligible_at: null }]
mailboxes:  [{ email: sender11@goauthorpitchdesk.com, provider: "google",
               source: "provisioned", deliv_status: "healthy", released_at: null }]
vendor row: dns_propagation_status: "pending", nameserver_match_status: "pending",
            actual_nameservers: []
send-eligible count  before credential push: 0
send-eligible count  after  credential push: 1     ← sends through unproven DNS
```

The only thing holding the mailbox back before the flip is the un-armed credential push
(`mailbox_cred_pushes.status='pending'`), which production arms. I ran
`engine/mailbox-eligibility.ts`'s predicate verbatim: it joins `domains` for exactly one
column, `first_send_eligible_at` (NULL for every provisioned domain — only a BYO *primary*
gets a DMARC window at `byo-intake.ts:174`). **No DNS state appears anywhere in the
send-eligibility chain.** Warmup does not gate on it either.

Related and worth naming: `dns_status` now has exactly **one** consumer in the whole
codebase — `provisioning.ts:251` (`if (existing.dns_status !== "ready")` → skip the DNS
leg). It is a "this step is done" marker, not a claim anyone reads. Once a purchased
domain flips 'ready' on attempt 1, the poll never runs again for it.

**Self-refutation.** I tried hard to grade this BLOCKING and could not:
- The pre-fix state is strictly worse — a permanent deadlock, zero mailboxes, six days
  live. A residual risk of billing onto bad DNS beats a certainty of billing onto nothing.
- The vendor's own dashboard computed NS "Matched" from real DNS throughout, so the
  delegation half is known-live for the actual customer.
- If the DNS really is dead, sends bounce and `engine/deliverability.ts` pauses the
  mailboxes. Expensive and late, but detected and recoverable — not silent forever.
- The exposure level is the pre-wave-1 one, re-entered deliberately and with the reasoning
  written down at `inboxkit-domain-port.ts:395-450`, not by accident.

**Residual exposure, for the founder, in one sentence:** for a purchased domain we now buy
and bill monthly mailboxes on the strength of the vendor saying the *mailbox* is active,
with no check of any kind — ours or the vendor's — that the domain's mail DNS was actually
configured; if InboxKit ever marks a mailbox active while its DNS work failed, we bill for
a mailbox that cannot deliver and only bounce rates will tell us.

**Cheapest thing that would close it (I flag, I do not fix):** the vendor's contract makes
a testable prediction — if DNS is configured *during* mailbox processing, then once
`provisioningState === "ready"` the two stored verdicts should finally move. A single
re-poll of `/domains/list` after the mailbox is ready, before `insertProvisionedMailbox`,
would restore a real guarantee without re-creating the deadlock (the wait now has an exit,
because the thing it waits for has already happened). Whether the fields actually move is
unknown to us today — see UNVERIFIABLE.

---

### 2. NON-BLOCKING · lens 1 (spec-vs-code) · "the discriminator is never the vendor row's own field" is true only inside `polledDomainIsReady`; one level up it is exactly that field

Claimed in the commit message and again at `inboxkit-domain-port.ts:399-403`:

> "…decided by the OPERATING connection type (the discriminator the caller resolved), never
> by the vendor row's own field: reading it off the row would silently import this rule into
> the connected flow."

Traced the operating type to its sources. There are three, and two of them are the vendor's
`connection_type` from `POST /domains/list`:

| where the row's `connection_type` comes from | source |
|---|---|
| `provisioning.ts:334-340` after a real buy | `buy()` returns `"purchased"` — a fact about the operation. Genuinely independent. |
| `provisioning.ts:294-299` on the ADOPT path | `adopted.connectionType` ← `findAdoptableDomain` ← `listOwnedDomains` ← `normalizeConnectionType(row.connection_type)` (`:149`) |
| `domain-dns.ts:101-114` legacy backfill | same `listOwnedDomains` call, persisted onto the row |

Mordy's domain — the one this fix exists for — reaches the purchased branch by the second
or third row of that table, not the first. Probe P8 executed it end to end: a listing row
carrying `connection_type: "purchased"` produced `0` `/domains/nameservers` handshakes, `1`
`/mailboxes/buy`, and `dns_status: "ready"` on the persisted row.

**Why NON-BLOCKING (self-refutation).** The claim is about a real safety property and the
property mostly holds: a BYO/connected domain gets `'connected'` written at intake
(`byo-intake.ts:192`) and never consults the vendor, so the mislabel would require InboxKit
itself to report `purchased` for a domain it did not register. I could not construct a
reachable path that does that, so the risk is hypothetical. But the *sentence* is
load-bearing in the module's own safety argument and it is inaccurate as written — the
resolution is one step earlier in time, not absent. If the vendor ever does mislabel, the
consequence changed with this commit from "silent stall, no spend" to "spend, on a domain
whose InboxKit-side zone was never created." That trade deserves to be written down where
the claim is made.

---

### 3. NON-BLOCKING · lens 6/4 · The deadlock CLASS is not closed — only its purchased instance — and there is still no detector for a domain stuck at `dns_status='pending'`

The `'unknown'` branch keeps the full conjunction, which is the right call on the evidence
(the contract fact is about domains InboxKit registered). But that means
gate-waits-on-state-the-gated-action-produces is still reachable: a domain the vendor lists
without a recognized `connection_type` gets `normalizeConnectionType → 'unknown'`, is not
persisted (`domain-dns.ts:102`), and waits on verdicts that — if it is in fact a purchased
domain — never arrive. Fail-safe (no spend), permanent, and invisible.

Invisible is the part that cost six days. I enumerated every ops check:
`mailboxProvisioningCheckName`, `mailboxRebuyCheckName`, `credPushAgingCheckName`,
`sendStarvedCheckName`, `tenantDoWedgedCheckName` (`admin/watchtower.ts:56-71`). **None
covers a domain sitting at `dns_status='pending'`.** `DOMAIN_DNS_PENDING`
(`domain-dns.ts:194-205`) is a `logAction` activity row only — no `reportCheck`, no founder
mail. Send-starved cannot substitute: it requires `dueNonDemoPendingSends > 0`
(`watchtower.ts:265`), and a tenant deadlocked before it has a single mailbox has no due
sends.

So the same six-day silence is still available to the next domain that lands in the
`'unknown'` branch. Recorded as the highest-value follow-up, not as a blocker: it is
pre-existing, it costs no money when it fires, and it is out of this commit's stated scope.

---

## Attacks that failed

Each of these was run or traced to a conclusion; none produced a defect.

**lens 2 — "would it actually run? RUN it."** Full platform suite 1528/1528 and typecheck
rc=0 across five workspaces, executed in a sandbox copy, not accepted from the commit
message. The one previously-red doc guard is green at this HEAD.

**(a) end-to-end on Mordy's exact shape.** Ran `POST /setup-infrastructure` with
`status:"active"`, `dns_propagation_status:"pending"`, `nameserver_match_status:"pending"`,
`actual_nameservers:[]`. `/mailboxes/buy` fires (pre-fix: 0, forever); the domain flips
`dns_status='ready'`; the two propagation fields never move; on the attempt where the vendor
activates the mailbox the route answers 202 with one mailbox row. Ordering re-derived by
reading, not by trusting the citation: `awaitMailboxReady` at `mailbox-provisioning.ts:197`
strictly precedes `insertProvisionedMailbox` at `:158` and `meterProvisionedMailbox` at
`:161`, both of which sit *outside* the `withRequestIdempotency` unit that contains the buy.
On every failing attempt `readMailboxes` is `[]` and the `usage` ledger is empty.

**(b) over-widening, CONNECTED — ROUTE level, not just the port.** Probe P1: a listing row
byte-identical to the purchased-active-pending record that now clears the gate, driven as
`connected`. Result: `0` `/mailboxes/buy`, `0` mailbox rows, HTTP 502 retryable, row stays
`{dns_status: "pending", connection_type: "connected"}`, and the connect handshake *did*
run (twice — the in-call backoff budget). The short-circuit does not leak into the connected
flow.

**(b) over-widening, UNKNOWN.** The shipped acceptance test drives a vendor row with
`connection_type` omitted through the real route: `0` buys, `0` warmups, nothing billable,
row persisted as `connection_type: "unknown"`, and it only proceeds after `propagate()`.
The 2026-08-06 false-ready repro was re-pointed here, not deleted. I checked that this is
the same shape, not a weakened one — it is.

**(b) over-widening, non-active status.** Probe P2 across `suspended`, `expired`. The
purchased record is refused (`polledDomainIsReady` returns false before the short-circuit,
`:454`). What then happens is *not* a bypass: `findAdoptableDomain` requires vendor
`status === "active"`, so the domain is not adoptable, the availability filter reports it
unavailable, and the flow buys the **next lookalike candidate** (`theauthorpitchdesk.com`),
which is a genuinely fresh, genuinely active purchased domain. My probe's premise was wrong,
not the code. Case/whitespace (`"  Active "`) is accepted by design via `trim().toLowerCase()`.

**(c) the deleted NS-match short-circuit stayed deleted.** `grep -rn actual_nameservers
apps/platform/src` returns four hits, all of them a comment or a type field
(`:320`, `:347`, `:433`, `:441`). No code path reads it. The 2026-08-06 guards were
re-pointed to `'unknown'`, not dropped — see above.

**(d) vendor failure during mailbox processing.** 500 is covered by the shipped test. I
added 429 (probe P4): HTTP 502, `retryable: true`, `step: "mailbox purchase"`, `0`
`/warmup/add`, `0` mailbox rows, `0` usage ledger rows, and `JSON.stringify(body)` matches
neither `/inboxkit/i` nor the vendor's message text. Grading confirmed at
`inboxkit-errors.ts:24` (`status >= 500 || status === 429`).

**(d) a NON-retryable 4xx does not loop forever.** Probe P5, 400 on `/mailboxes/buy`, three
consecutive attempts: attempt 1 → `retryable: false` (correct, the agent is told to stop);
attempts 2 and 3 → `retryable: true` with **still exactly 1 buy**, because the intent is
`dangling` and `confirmVendorOwnership` answers `too_recent` inside the 15-minute
`ABSENCE_MIN_AGE_MS` window. After that window it grades `absent`, spends the **one**
authorized re-buy (`MAX_BUY_DISPATCHES = 2`), and then hard-stops with
`abandonedPurchaseError` plus a founder alert. Bounded, alerted, terminating. No leak.

**(e) retry after a mid-provision crash.** Probe P6, four attempts through a vendor that
accepts the buy and leaves the mailbox `scheduled`: `/mailboxes/buy` = 1, `/warmup/add` = 1,
one `mailboxes` row, exactly one `usage` ledger entry — and a fourth attempt after success
adds none of them. `dns_status='ready'` flipping early does not skip anything a CONNECTED
domain needs: the skip at `provisioning.ts:251` is per-domain-row and a connected domain
carries its own `dns_status` and its own resolved type.

**lens 7 (regression ring) — the previous gate's finding #2.** The 2026-08-05 gate recorded
that `retry_setup` hard-coded a DNS sentence while the REST body named a different step.
That matters much more now, because with the purchased branch always clearing, the *mailbox*
leg becomes the default failure point. It is already fixed: `retry-setup-message.ts:19-25`
is step-aware and `provisioning.ts:629` derives the step from the same
`customerSafeVendorFailure` the REST body uses. The builder's own updated assertion
(`step: "mailbox purchase"`) is consistent with it.

**lens 4 (deploy/arm-time plumbing).** No flag, no env var, no migration, no new dependency
— an unconditional code change, so deploy is arming. I checked the one arm-time question
that matters: Mordy's row predates the `connection_type` column, so it reads NULL →
`readDomainConnectionType` → `'unknown'` → `resolveDomainConnectionType` asks the vendor,
gets `"purchased"` (live-captured 2026-08-05), persists it, and takes the new branch on the
first post-deploy retry. A row already storing the literal `'unknown'` also re-resolves
rather than sticking (`domain-dns.ts:88`). Self-healing either way.

**lens 5 (fixture realism).** The stateful fake's `/mailboxes/buy` succeeds on a domain
whose DNS the vendor has not configured. I attacked that as an assumption and it survives:
it is precisely what the vendor's support reply describes ("the DNS will be configured
during mailbox processing" — the buy has to be accepted first). The fixture that hid the
2026-08-06 bug (all signals flipped simultaneously) is now split, and the new acceptance
test's fixture NEVER propagates, which is the harder shape.

---

## UNVERIFIABLE

1. **The vendor contract itself — three load-bearing claims, zero independent evidence.**
   Everything here rests on one sentence in a support email. Unverified: (i) InboxKit
   accepts `/mailboxes/buy` on a purchased domain whose DNS it has not configured;
   (ii) it then actually configures it; (iii) it marks the mailbox `active` only after that
   work is done. I have no InboxKit credentials and made no live call.
   **What would resolve it:** on the next real provision of `goauthorpitchdesk.com`, capture
   `POST /domains/list` immediately before the buy, at `provisioningState === "ready"`, and
   an hour later. If `dns_propagation_status` flips to a ready token once the mailbox is
   active, all three claims are confirmed *and* finding #1's remedy (a post-buy re-poll)
   becomes a real guarantee rather than a guess. If it never flips, the stored fields are
   simply dead for purchased domains and only a DNS-level check could ever close #1.

2. **lens 3 (live-surface drive) — partial.** This is a Cloudflare Worker; there is no
   running surface to drive from here. My substitute was the real `POST
   /setup-infrastructure` route with the real adapters under Miniflare against a stateful
   vendor fake. Real InboxKit was never contacted. **Resolves on:** the post-deploy live
   retry for Mordy's tenant, watching `/mailboxes/buy` count and the `domains` row.

---

## NEW (out of scope, no verdict weight)

- **The burn/replace lane inherits this change and is untested for it.**
  `deliverability-actions.ts:194` calls the same `provisionDomainWithMailboxes`, so an
  automated REPLACE_DOMAIN now buys a replacement lookalike *and* provisions mailboxes onto
  it in one pass without waiting for propagation — same contract, same reasoning, but no
  test in this commit or any other exercises that path with the purchased branch. Flagged in
  the 2026-08-05 class sweep (`sweep-domain-type-2026-08-05.md`, row 21) as in-class for the
  original defect; it is in-class for this change too.
- **A permanent 4xx on the first mailbox buy is reported as permanent once and then as
  retryable for the next 15 minutes** (probe P5). Correct-by-design given the dispatch
  record, but it now becomes the customer-facing default for purchased domains, because the
  mailbox leg is the first leg that can fail. Pre-existing wave-1/2 machinery.
- **An expired or suspended purchased domain is silently replaced rather than repaired.**
  `findAdoptableDomain` requires `status === "active"`, so the flow buys a different
  lookalike (a second $12.50) instead of surfacing that the customer's existing domain
  lapsed. Pre-existing, unrelated to this commit.

---

## Method note

Reviewed read-only against a shared live worktree: `git rev-parse/show/log/grep` only, no
state-changing git. Every mutated-code experiment (the RED proof, all eight probes) ran in
`/private/tmp/.../scratchpad/sandbox`, an `rsync` copy with `node_modules` symlinked back.
The worktree's working tree and index were not touched.
