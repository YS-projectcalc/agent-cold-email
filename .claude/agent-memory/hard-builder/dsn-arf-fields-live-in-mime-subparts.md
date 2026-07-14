---
name: dsn-arf-fields-live-in-mime-subparts
description: DSN/ARF report fields (Final-Recipient, Original-Rcpt-To, Status) live in MIME SUB-PARTS, not the outer header block — a top-level header parser silently returns empty for them.
metadata:
  type: project
---

When parsing an RFC 3464 delivery-status notification (bounce) or RFC 5965 ARF
feedback report (complaint), the machine-readable fields are inside a MIME
sub-part *after* a blank line, NOT in the message's outer header block:

- `Final-Recipient`, `Action`, `Status`, `Diagnostic-Code` → `message/delivery-status` part
- `Original-Rcpt-To`, `Feedback-Type` → `message/feedback-report` part
- the ORIGINAL send's `Message-ID` → the returned `text/rfc822-headers` / `message/rfc822` part

ColdStart engine (`apps/engine/src/classify.ts`): a top-level header extractor
that scans only `source.split(/\r?\n\r?\n/)[0]` (the outer header block, correct
for `Content-Type`/`In-Reply-To`/`References`) returns `undefined` for these
sub-part fields → `toEmail: ""` on every bounce/complaint. Two engine unit tests
caught it (`expected '' to be 'nosuchuser@example.com'`). `Status`/`Diagnostic-Code`
happened to work only because they were already scanned with a full-source
`/^Status:/im` regex, not the top-level parser — which masked how load-bearing
the distinction is.

**Fix:** extract sub-part report fields with a line-anchored whole-source scan
(`new RegExp('^' + name + ':\\s*(.+)$', 'im')`), reserve the top-level
header-block parser for genuine outer headers. **How to apply:** any time you
parse a `multipart/report` (DSN or ARF), do NOT reuse the RFC 5322 outer-header
extractor for report-body fields. Relates to [[sandbox-port-masks-real-server-contract]]
(the real-server obligations a sandbox EmailPort hides — bounce hard/soft taxonomy).
