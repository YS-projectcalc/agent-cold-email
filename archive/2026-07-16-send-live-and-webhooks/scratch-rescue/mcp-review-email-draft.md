REVISED after `anthropic-mechanics` grounded the actual review process
(https://claude.com/docs/connectors/building/review-criteria). Recommendation
changed:

## Recommendation: skip this email, submit directly instead

Per anthropic-mechanics' research, submission isn't a manual queue you need
to pre-clear: *"When you submit a server, it is automatically scanned for
policy compliance and, by default, listed in the directory as a community
connector... Anthropic may then escalate listings flagged as highly useful to
Claude users to verified review... This escalation is assessed automatically,
and you do not need to take any action."* `static_headers` (beta) is also
already confirmed as the correct auth mode for coldrig's fixed-token-per-org
pattern — that was the one open question this email existed to ask.

So: nothing here actually needs Anthropic's advance sign-off. The right move
is to submit through the wizard directly (see
`connectors-directory-listing.md` in this same folder) and let the automated
scan run. Sending a general "please confirm this is OK" email to
mcp-review@anthropic.com ahead of that isn't how the docs frame that inbox's
purpose, and per CLAUDE.md's "shortest ask that unblocks us" discipline, an
email nobody needs to answer is ceremony, not progress.

**Keep this draft on file only for a genuine escalation** — e.g. the
submission gets stuck, an automated-scan rejection is ambiguous and the
review-criteria page doesn't explain why, or the founder wants Anthropic to
coordinate on `oauth_anthropic_creds`/`custom_connection` for a future auth
upgrade. If that happens, here's a starting point (edit the specific problem
in before sending — don't send this as a generic "please review us" nudge):

---

To: mcp-review@anthropic.com
Subject: [ESCALATION — edit before sending] Coldrig Connectors Directory submission — <specific issue>

Hi,

We submitted Coldrig (agent-cold-email) — cold-email infrastructure, 17
tools, streamable HTTP at
https://agent-cold-email-api.yaakovscher.workers.dev/mcp — to the Connectors
Directory on <date>. <Describe the specific stuck point: e.g. "the automated
scan flagged X and the review-criteria page doesn't cover this case" or "we
haven't heard back after N days" — do not send this as a general check-in.>

Server card: https://coldrig.dev/.well-known/mcp/server-card.json
Privacy policy: https://coldrig.dev/privacy · Terms: https://coldrig.dev/terms
· Security/responsible disclosure: https://coldrig.dev/security · DPA: https://coldrig.dev/dpa

For context: the platform is in public early access. The MCP endpoint and
full tool surface are live and fully functional, but currently run against a
sandbox vendor layer only — no real domains, mailboxes, or sends yet, and we
make no deliverability guarantees. This is disclosed plainly in the listing
itself.

Thanks,
[Founder name]
[Founder email]
EpiphanyMade / Coldrig
