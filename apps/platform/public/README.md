# public

Static assets served by Cloudflare's `[assets]` binding (`wrangler.toml`),
NOT by Worker code — see `wrangler.toml`'s doc comment and
`apps/platform/README.md`'s Config section for the full `run_worker_first` /
`not_found_handling` picture.

## What's here (M1 — placeholder only)

- `app/index.html` — a placeholder for the dashboard SPA (SPEC.md §19.1).
  Exists purely to prove the M1 serving spike: `/app/*` → static assets,
  everything else → the Worker, exactly as before. The REAL content here is
  `apps/dashboard`'s Vite build output (`base: '/app/'`), landing in M2.
- `index.html` — an IDENTICAL copy of the above, at the assets directory's
  own root. Not optional: `not_found_handling = "single-page-application"`
  was empirically proven (via `wrangler dev`, not assumed from docs) to serve
  the assets directory's ROOT `index.html` for any unmatched path under
  `/app/*` — NOT a per-directory nearest-`index.html` walk-up. Without this
  file, `/app/some-client-route` 404s instead of falling back to the SPA
  shell.

## M2 responsibility

When `apps/dashboard`'s Vite build starts populating `app/` for real, keep
`public/index.html` in sync with `public/app/index.html` (or generate the
root one as a build step) — the SPA-fallback behavior above depends on it
existing and matching. Do not delete `public/index.html` assuming it's
unused; it is the fallback target for every `/app/*` deep-link.

## How to run

Not independently testable (no code, no build step) — exercised indirectly
by the `apps/platform` serving-spike proof (see `wrangler.toml`'s comment)
and, once M2 lands, by `apps/dashboard`'s own build output landing here.
