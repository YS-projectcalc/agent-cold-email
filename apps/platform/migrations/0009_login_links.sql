-- Magic-link login (design docs/research/human-signup-magic-link-design-
-- 2026-07-22.md §1.2, adversary r1 2026-07-23). `login_links` mirrors
-- `dashboard_sessions` (migrations/0006): `token_hash` is SHA-256(pepper:id)
-- of a random 256-bit id (src/auth.ts) — the raw id lives only in the emailed
-- URL, never here. Bound to `contact_email`, NOT a single tenant (one email
-- can own several tenants — see the picker flow, routes/login.ts).
CREATE TABLE IF NOT EXISTS login_links (
  token_hash    TEXT PRIMARY KEY,
  contact_email TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_login_links_expires ON login_links(expires_at);

-- Adversary r1 NB4 (2026-07-23): normalize-on-write, not query-time LOWER() —
-- a plain index does not serve a LOWER() query. Backfill existing rows to
-- lowercase BEFORE indexing so the index and the stored data agree from the
-- start; src/db.ts's insertTenantIndex lowercases contact_email on every
-- write from here on, and routes/login.ts lowercases its lookup email too.
UPDATE tenants_index SET contact_email = LOWER(contact_email) WHERE contact_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenants_contact_email ON tenants_index(contact_email);
