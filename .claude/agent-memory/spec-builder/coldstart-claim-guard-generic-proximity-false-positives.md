---
name: coldstart-claim-guard-generic-proximity-false-positives
description: building a claim-drift enum-completeness guard (G2-style, "does this doc enumerate ALL N members of a closed set") over this repo's dense marketing/doc corpus — generic word-proximity checks (fixed-window slicing, chained-occurrence clustering) both false-positived live; an ORDER-ANCHORED regex anchored on the corpus's actual phrasing convention was the only precise approach.
metadata:
  type: project
---

Building `apps/platform/test/tool-claim-binding.test.ts`'s G2 rule (webhook
event-type enumeration completeness across ~15 site/doc surfaces), three
generic approaches were tried in order and each failed for a different reason
before landing on an order-anchored one:

1. **Fixed-size sliding windows** (slice text into overlapping 200-char
   chunks, check membership per chunk): a member word can be TRUNCATED right
   at a slice boundary, reading as absent from every slice even though fully
   present — false-positived a genuinely correct fix.
2. **Whole-document membership after a proximity trigger** (detect ≥2 members
   close together, then check the WHOLE doc for the rest): too permissive
   when a member name is ALSO ordinary product vocabulary used elsewhere in
   the SAME document in an unrelated sense (here: "unsubscribe" is both a
   webhook event type and an `EventCounts` field name) — a genuinely-stale
   partial enumeration read as complete because the missing word appeared
   1000+ chars away in an unrelated sentence. False NEGATIVE.
3. **Proximity-clustering on real occurrence positions** (chain occurrences
   within N chars of each other into clusters, require completeness per
   cluster): closer, but ≥2 of the 5 target words are ALSO ordinary prose
   ("unsubscribe handling", "complaint auto-pause") that coincidentally
   co-occur within the window in a totally unrelated sentence — false
   POSITIVE on real, correct sites. Raising the trigger threshold to ≥3
   members reduced but did not eliminate this (a different unrelated
   enumeration — suppress_lead's "bounce/soft_bounce/complaint/unsubscribe
   are auto-recorded reasons" note — coincidentally shares 4 of 5 target
   words).

**What worked:** anchor on the corpus's ACTUAL phrasing convention instead of
generic word-proximity. Every real site in this repo enumerates the set in
one canonical ORDER (here: `reply, bounce, soft_bounce, complaint[,
unsubscribe]` — the same order as the `const` array itself), so
`/reply.{1,20}?bounce.{1,20}?soft_bounce.{1,20}?complaint/` (any-char gaps,
not punctuation-only — a real "X, Y, Z, and W" list's connector word "and"
sits inside a gap) matched ONLY the real enumeration sites, then checking
whether the last member appears within a short trailing window closed the
gap with zero false positives/negatives against the real corpus, verified by
revert-fail-restore.

**How to apply:** for any future claim-drift completeness guard over this
same site/doc corpus, don't reach for a generic proximity/window check first
— check whether the corpus enumerates in one consistent order and anchor on
that instead. Related: [[coldstart-d1-migrations-hardcoded-in-test-setup]]
(same "check the actual convention, not a generic heuristic" lesson, different
domain).
