import { env } from "cloudflare:test";
// `?raw` (Vite import suffix) pulls the migration file's text in at
// transform time — no runtime filesystem access needed inside workerd, and
// the D1 schema stays defined in exactly one place: migrations/0001_init.sql.
import migrationSql from "../migrations/0001_init.sql?raw";

const statements = migrationSql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

for (const statement of statements) {
  await env.DB.prepare(statement).run();
}
