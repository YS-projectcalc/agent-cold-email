import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signup, tenantStub } from "./helpers.js";

// NB3 — a DO that predates the unique dedupe indexes could hold duplicate rows
// (the plain-INSERT poll/reprocess path). Creating the index over those dups
// would throw a UNIQUE-constraint error out of the constructor and permanently
// brick the DO (every intent 500s). The constructor now collapses dups BEFORE
// creating each index, keeping the lowest rowid and preserving NULL-key rows.
// This drives the SAME code path (ensureColumnMigrations) the constructor runs.
describe("NB3 — dedup-before-unique-index keeps the DO constructor from bricking", () => {
  it("collapses duplicate event rows, preserves NULL message_id rows, and (re)creates the index", async () => {
    const { tenantId } = await signup("Dedupe Co", "founder@dedupeco.com");
    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      const sql = state.storage.sql;
      // Simulate a pre-index DO: drop the index, then accumulate duplicates.
      sql.exec(`DROP INDEX IF EXISTS idx_events_dedupe`);
      const insertEvent = (id: string, mid: string | null) =>
        sql.exec(
          `INSERT INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
           VALUES (?, ?, 'c', 'l', 'reply', 0, ?, 't', 1, '{}')`,
          id,
          tenantId,
          mid,
        );
      insertEvent("e1", "<dup@x.com>");
      insertEvent("e2", "<dup@x.com>");
      insertEvent("e3", "<dup@x.com>");
      insertEvent("e4", null); // NULLs are distinct under the unique index — must survive
      insertEvent("e5", null);
      expect(sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE message_id = '<dup@x.com>'`).one().n).toBe(3);

      // Run the migration path the constructor runs.
      (instance as unknown as { ensureColumnMigrations(): void }).ensureColumnMigrations();

      expect(sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE message_id = '<dup@x.com>'`).one().n).toBe(1);
      expect(sql.exec<{ id: string }>(`SELECT id FROM events WHERE message_id = '<dup@x.com>'`).one().id).toBe("e1"); // lowest rowid kept
      expect(sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE message_id IS NULL`).one().n).toBe(2);

      // The unique index now exists and enforces: a duplicate INSERT OR IGNORE is a no-op.
      sql.exec(
        `INSERT OR IGNORE INTO events (id, tenant_id, campaign_id, lead_id, type, step, message_id, thread_id, ts, metadata_json)
         VALUES ('e6', ?, 'c', 'l', 'reply', 0, '<dup@x.com>', 't', 1, '{}')`,
        tenantId,
      );
      expect(sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM events WHERE message_id = '<dup@x.com>'`).one().n).toBe(1);
    });
  });

  it("does the same for the ledger source_send_id index (in-class sibling)", async () => {
    const { tenantId } = await signup("Ledger Dedupe Co", "founder@ledgerdedupe.com");
    await runInDurableObject(tenantStub(tenantId), async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`DROP INDEX IF EXISTS idx_ledger_source_send`);
      const insertLedger = (id: string, src: string | null) =>
        sql.exec(
          `INSERT INTO ledger_entries (id, tenant_id, kind, amount_cents, description, ts, source_send_id)
           VALUES (?, ?, 'usage', 2, 'x', 1, ?)`,
          id,
          tenantId,
          src,
        );
      insertLedger("l1", "ss_dup");
      insertLedger("l2", "ss_dup");
      insertLedger("l3", null); // credits/adjustments have NULL source_send_id — must survive
      insertLedger("l4", null);
      // initTenant already seeded one NULL-source credit row; compare against the
      // live count rather than a literal so the preservation check is exact.
      const nullBefore = sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM ledger_entries WHERE source_send_id IS NULL`).one().n;

      (instance as unknown as { ensureColumnMigrations(): void }).ensureColumnMigrations();

      expect(sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM ledger_entries WHERE source_send_id = 'ss_dup'`).one().n).toBe(1);
      expect(sql.exec<{ n: number }>(`SELECT COUNT(*) as n FROM ledger_entries WHERE source_send_id IS NULL`).one().n).toBe(nullBefore); // every NULL-key row preserved
    });
  });
});
