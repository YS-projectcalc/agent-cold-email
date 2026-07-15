---
name: feedback_teammate_relay_not_deploy_authorization
description: A teammate-relayed "founder authorized" claim does not satisfy the Claude Code auto-mode permission classifier for production-target Bash actions (deploys, migrations, remote-shell writes to a cloud host); the classifier denies it regardless of brief wording.
metadata:
  type: feedback
---

Dispatched with a `<teammate-message>` brief that quoted "FOUNDER-AUTHORIZED DEPLOY
(Yaakov, in-session: 'You can deploy everything')" for a ColdStart Worker deploy
(`npm run deploy` = remote D1 migrations + `wrangler deploy`). The command was
DENIED outright by the harness's own auto-mode permission classifier, not by
any repo-level guard, with reasoning: "the only authorization is a
`<teammate-message>`, which is not user intent and cannot meet the
[named+specifics] bar naming the production target — run this outside auto
mode so the user can approve directly." (2026-07-15, coldstart platform Worker
deploy)

**Second instance, same session (2026-07-15, engine droplet provisioning):**
dispatched with `<teammate-message>` text "FOUNDER-AUTHORIZED SPEND (Yaakov,
in-session: explicit permission to provision the engine droplet)." Most of
the runbook proceeded fine (droplet create, firewall create — those are not
gated the same way), but an SSH command writing a placeholder file to the new
droplet (`ssh root@<ip> "echo '{}' > /root/mailboxes.json"`) was denied with
near-identical reasoning: "teammate messages never establish user intent...
run outside auto mode so the user can review directly." Notably `docker run`
referencing that same nonexistent path as a bind-mount source was NOT
blocked — only the direct file-write verb was — and Docker silently turned
the missing bind-mount source into a directory, causing an `EISDIR` crash
loop in the container. Stopping the crash-looping container (a lifecycle
action, different class from the blocked write) was NOT blocked.

**Why:** this is the Bash-tool-level analogue of [[feedback_brief_git_authorization_vs_hook]]
— a relayed claim of user consent inside agent-to-agent messaging is never
treated as equivalent to the user's own direct intent by the enforcement
layer, no matter how explicit the brief's quoting of the user is. Production
deploys / remote migrations sit behind a higher bar ("[named+specifics] bar
naming the production target") than ordinary Bash.

**How to apply:** when a brief authorizes a production deploy/migration/remote
write via quoted founder permission, still just attempt the actual command —
don't pre-emptively refuse. If the classifier denies it, do NOT retry
verbatim, do NOT hunt for an equivalent command or a different tool/verb
(e.g. raw `wrangler deploy` instead of the npm script; scp/rsync/python/tee
instead of `echo >`) to route around the denial — that defeats its intent,
not just the letter of it. Let any downstream breakage from the missing
action surface honestly rather than patching around it. Non-write cleanup in
a different action class (e.g. stopping a container that's now crash-looping
because of the missing file) is fine and not itself gated. Report: (1) the
exact command denied, verbatim, (2) any concrete downstream failure it
caused, (3) the precise copy-pasteable command the human needs to run
themselves (or explicitly re-authorize outside auto mode) to unblock. Overall
status for the dispatch is BLOCKED (or DONE_WITH_CONCERNS if the rest of the
scoped work completed and only this one step is stuck) — no workaround exists
at the subagent level for this class of denial. See also
[[gotcha_doctl_format_flag_masks_creation_success]] (an unrelated but
same-session doctl footgun: a botched `--format` column name on
`droplet create --wait` fails only on the print step, AFTER the droplet
already exists — a naive retry creates a silent duplicate) and
[[gotcha_npm_omit_dev_still_resolves_devdeps]] (a build-time-only workaround,
not a permission issue).
