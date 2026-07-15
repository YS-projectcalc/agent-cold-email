# Memory Index

> Always-loaded overview. A `[link](x.md)` is inert text — it does not pull x.md into context; only MEMORY.md loads each session. Memories recall on relevance via their own `description`; de-indexed pointers stay reachable at zero baseline cost.

- [feedback_brief_git_authorization_vs_hook.md](feedback_brief_git_authorization_vs_hook.md) — a brief's "normal git is fine" claim does not override the shared-worktree `agent-git-guard` hook; leave uncommitted, report DONE_WITH_CONCERNS.
- [hono-subapp-wildcard-middleware-gotcha.md](hono-subapp-wildcard-middleware-gotcha.md) — a new Hono sub-app's `.use("*", mw)` intercepts SIBLING sub-apps' routes too (one composed router); scope to the sub-app's own path prefix, verify by testing the OTHER sub-app's routes after the change.
- [feedback_teammate_relay_not_deploy_authorization.md](feedback_teammate_relay_not_deploy_authorization.md) — a teammate-relayed "founder authorized" claim (deploy, spend, remote SSH write) does not satisfy the auto-mode permission classifier; attempt the command, if denied stop and escalate verbatim, never route around it.
- [coldstart-waitlist-cors-custom-domain-drift.md](coldstart-waitlist-cors-custom-domain-drift.md) — waitlist.ts:19 CORS allowlist hardcoded to agent-cold-email.pages.dev, never updated for coldrig.dev custom domain cutover; re-check on every future deploy-verification pass.
- [gotcha_doctl_format_flag_masks_creation_success.md](gotcha_doctl_format_flag_masks_creation_success.md) — `doctl ... create --wait` with a bad `--format` column fails only on the print step AFTER creation succeeds; list existing resources before retrying or you'll create a silent duplicate.
- [gotcha_npm_omit_dev_still_resolves_devdeps.md](gotcha_npm_omit_dev_still_resolves_devdeps.md) — `npm install --omit=dev` still 404s on an unpublished workspace devDependency; strip devDependencies from a scratch package.json copy to build Docker images without touching the tracked Dockerfile.
