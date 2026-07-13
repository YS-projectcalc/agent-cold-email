import { env } from "cloudflare:test";
// `?raw` (Vite import suffix) pulls each migration file's text in at
// transform time — no runtime filesystem access needed inside workerd, and
// the D1 schema stays defined in exactly one place: migrations/*.sql.
import migration1Sql from "../migrations/0001_init.sql?raw";
import migration2Sql from "../migrations/0002_admin_ops.sql?raw";
import migration3Sql from "../migrations/0003_lifecycle.sql?raw";
import migration4Sql from "../migrations/0004_waitlist.sql?raw";
import migration5Sql from "../migrations/0005_support_dedupe.sql?raw";
import migration6Sql from "../migrations/0006_dashboard_sessions.sql?raw";

function statementsOf(sql: string): string[] {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

for (const statement of [
  ...statementsOf(migration1Sql),
  ...statementsOf(migration2Sql),
  ...statementsOf(migration3Sql),
  ...statementsOf(migration4Sql),
  ...statementsOf(migration5Sql),
  ...statementsOf(migration6Sql),
]) {
  await env.DB.prepare(statement).run();
}

// D1/D2/D6 admin surface (src/admin/README.md): `env.ADMIN_TOKEN` itself is
// injected by vitest.config.ts's `miniflare.bindings` (a test-only binding,
// not a real secret — CLAUDE.md rule g) — see test/helpers.ts's `adminApi()`
// for the matching value every admin-route test presents.
