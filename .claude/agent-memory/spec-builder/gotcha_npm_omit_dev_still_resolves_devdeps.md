---
name: gotcha_npm_omit_dev_still_resolves_devdeps
description: npm install --omit=dev (or the older --production) still needs registry metadata for devDependencies to build its ideal tree before pruning — an unpublished private/workspace devDependency (e.g. @coldstart/shared) 404s the install even though it's never actually installed. Reproduces across npm 8/10/11, inside and outside Docker.
metadata:
  type: reference
---

`apps/engine/Dockerfile` (ColdStart repo) does `COPY package.json ./` then
`RUN npm install --omit=dev`, with a comment claiming `@coldstart/shared`
(a workspace-only, type-erased devDependency) is never resolved because of
`--omit=dev`. That claim is false: the build failed with `npm error 404
Not Found - GET https://registry.npmjs.org/@coldstart%2fshared`. Reproduced
identically with a bare `npm install --omit=dev --no-package-lock` on the
host (no Docker involved) and with `npx npm@8 install --production` — same
404 across npm 8/10/11. This is npm's arborist needing full-tree metadata
(including devDependencies) to compute what to omit, even when nothing in
that subtree will actually be installed.

**Why it matters for ColdStart specifically:** any Dockerfile in this repo
that copies a workspace package's `package.json` alone (no lockfile, no
sibling `@coldstart/*` packages in the build context) and runs `npm install
--omit=dev` will hit this if that package lists ANY unpublished
`@coldstart/*` package in devDependencies — not engine-specific.

**How to apply:** the safe, zero-risk workaround (used 2026-07-15, does not
touch any repo-tracked file) is to build from a scratch copy of the
package's build context with the `devDependencies` block stripped from the
copied `package.json` before `docker build` — devDependencies are never
copied into the runtime image regardless (already erased by the `tsc`
build), so removing the block changes nothing about the resulting image.
The real fix (out of scope for a runbook-execution dispatch — would need an
explicit decision/PR) is either: publish `@coldstart/shared` to a private
registry the Dockerfile can auth against, vendor its erased types some other
way, or have the Dockerfile strip devDependencies itself (e.g. `RUN npm pkg
delete devDependencies && npm install --omit=dev`) so the real, tracked
Dockerfile no longer relies on the false claim in its own comment.
