import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runDunningSweep } from "../src/admin/ops-sweep.js";
import { CONTINUITY_NUDGE_KIND } from "../src/engine/continuity-nudge.js";
import {
  drainMessageMirror,
  getMessageEmailMirrorState,
  isAffirmativeEnvFlag,
  isMirrorArmed,
  MIRROR_MAX_PER_DAY,
  MIRROR_WINDOW_MS,
  pruneMirrorRing,
  setMirrorEmailOptOut,
  type MirrorRing,
} from "../src/engine/message-mirror.js";
import { emitOperatorMessage, emitTenantMessage } from "../src/engine/tenant-messages.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";
import type { TenantContext } from "../src/tenant-context.js";
import { envWithFailingD1Statements, failPayment, mintTenant, signup, tenantStub, withTenantContext } from "./helpers.js";

// msgchannel Increment 4 — the email mirror (design docs/research/
// msgchannel-inc4-email-mirror-design-2026-08-24.md). Every test here is
// numbered against that brief's §9 test list and is RED against pre-Inc4
// code (the module does not exist at all).

/** Arms the mirror for exactly the tenants passed (or every tenant when
 * omitted), and restores both flags afterward — `env` is a shared global
 * across this whole test file. */
async function withMirrorArmed<T>(fn: () => Promise<T> | T, allowlist?: string[]): Promise<T> {
  const prevEnabled = env.MESSAGE_EMAIL_MIRROR_ENABLED;
  const prevAllowlist = env.MESSAGE_MIRROR_TENANT_ALLOWLIST;
  env.MESSAGE_EMAIL_MIRROR_ENABLED = "1";
  env.MESSAGE_MIRROR_TENANT_ALLOWLIST = allowlist ? allowlist.join(",") : undefined;
  try {
    return await fn();
  } finally {
    env.MESSAGE_EMAIL_MIRROR_ENABLED = prevEnabled;
    env.MESSAGE_MIRROR_TENANT_ALLOWLIST = prevAllowlist;
  }
}

function rowMirroredAt(tenantId: string, id: string): Promise<number | null> {
  return withTenantContext(tenantId, (ctx) =>
    ctx.sql.exec<{ mirrored_at: number | null }>(`SELECT mirrored_at FROM tenant_messages WHERE id = ? AND tenant_id = ?`, id, tenantId).one()
      .mirrored_at,
  );
}

function insertRow(
  tenantId: string,
  id: string,
  kind: string,
  severity: string,
  body: string,
  source: "system" | "operator",
  extra: { readAt?: number | null; expiresAt?: number | null; createdAt?: number } = {},
): Promise<void> {
  return withTenantContext(tenantId, (ctx) => {
    const now = ctx.clock.now();
    ctx.sql.exec(
      `INSERT INTO tenant_messages (id, tenant_id, kind, severity, body, source, created_at, last_occurred_at, read_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      tenantId,
      kind,
      severity,
      body,
      source,
      extra.createdAt ?? now,
      extra.createdAt ?? now,
      extra.readAt ?? null,
      extra.expiresAt ?? null,
    );
  });
}

describe("T1 — selection: severity + source gate, not a kind allowlist (C3)", () => {
  it("system 'info' never mirrors", async () => {
    const { tenantId } = await signup("Mirror T1a", "t1a@mirror.test");
    await withMirrorArmed(async () => {
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "retry_setup", severity: "info", body: "pending" }));
      const mailer = new SandboxOpsMailer();
      const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
      expect(result).toEqual({ sent: 0, failed: 0, suppressed: 0, noContact: 0 });
      expect(mailer.sent).toHaveLength(0);
    });
  });

  it.each(["action_required", "operator_pending", "terminal"] as const)("system '%s' mirrors", async (severity) => {
    const { tenantId } = await signup(`Mirror T1 ${severity}`, `t1-${severity}@mirror.test`);
    await withMirrorArmed(async () => {
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity, body: `stuck: ${severity}` }));
      const mailer = new SandboxOpsMailer();
      const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
      expect(result.sent).toBe(1);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.text).toContain(`stuck: ${severity}`);
    });
  });

  it("source='operator' at ANY severity always mirrors, including 'info'", async () => {
    const { tenantId } = await signup("Mirror T1 operator", "t1-operator@mirror.test");
    await withMirrorArmed(async () => {
      await withTenantContext(tenantId, (ctx) =>
        emitOperatorMessage(ctx, { kind: "operator_notice", severity: "info", body: "a human wrote this" }),
      );
      const mailer = new SandboxOpsMailer();
      const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
      expect(result.sent).toBe(1);
      expect(mailer.sent[0]!.text).toContain("a human wrote this");
    });
  });
});

describe("T2 — a dedup REFRESH of an already-mirrored row does not re-mirror", () => {
  it("emit(dedupKey) -> drain (1 send) -> re-emit same key -> drain -> 0 more sends, mirrored_at unchanged", async () => {
    const { tenantId } = await signup("Mirror T2", "t2@mirror.test");
    await withMirrorArmed(async () => {
      await withTenantContext(tenantId, (ctx) =>
        emitTenantMessage(ctx, { kind: "retry_setup", severity: "action_required", body: "first", dedupKey: "acme.com" }),
      );
      const mailer1 = new SandboxOpsMailer();
      const first = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer1));
      expect(first.sent).toBe(1);

      const row = await withTenantContext(tenantId, (ctx) =>
        ctx.sql.exec<{ id: string; mirrored_at: number }>(`SELECT id, mirrored_at FROM tenant_messages WHERE tenant_id = ?`, tenantId).one(),
      );
      expect(row.mirrored_at).not.toBeNull();

      // Re-trigger the SAME condition — the dedup branch REFRESHES the row
      // in place (C4); it must never touch mirrored_at.
      await withTenantContext(tenantId, (ctx) =>
        emitTenantMessage(ctx, { kind: "retry_setup", severity: "action_required", body: "second", dedupKey: "acme.com" }),
      );
      const mailer2 = new SandboxOpsMailer();
      const second = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer2));
      expect(second).toEqual({ sent: 0, failed: 0, suppressed: 0, noContact: 0 });
      expect(mailer2.sent).toHaveLength(0);

      const after = await rowMirroredAt(tenantId, row.id);
      expect(after).toBe(row.mirrored_at);
    });
  });
});

describe("T3 — exactly-once: repeated drains of an already-claimed row send nothing more", () => {
  it("5 drains in a row -> 1 send total", async () => {
    const { tenantId } = await signup("Mirror T3", "t3@mirror.test");
    await withMirrorArmed(async () => {
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: "dead" }));
      let totalSent = 0;
      for (let i = 0; i < 5; i++) {
        const mailer = new SandboxOpsMailer();
        const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
        totalSent += result.sent;
      }
      expect(totalSent).toBe(1);
    });
  });
});

describe("T4 — a send failure releases the claim but consumes the ring slot (Inc5 NEW-4 shape)", () => {
  class ThrowingMailer {
    async send(): Promise<never> {
      throw new Error("simulated transient send failure");
    }
  }

  it("throws revert mirrored_at to NULL; after MIRROR_MAX_PER_DAY attempts a further attempt in the window is refused, not retried", async () => {
    const { tenantId } = await signup("Mirror T4", "t4@mirror.test");
    await withMirrorArmed(async () => {
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: "stuck" }));
      const row = await withTenantContext(tenantId, (ctx) =>
        ctx.sql.exec<{ id: string }>(`SELECT id FROM tenant_messages WHERE tenant_id = ?`, tenantId).one(),
      );

      const throwing = new ThrowingMailer() as unknown as SandboxOpsMailer;
      for (let i = 0; i < MIRROR_MAX_PER_DAY; i++) {
        const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, throwing));
        expect(result.failed).toBe(1);
        // The row is eligible again — the claim was released.
        expect(await rowMirroredAt(tenantId, row.id)).toBeNull();
      }

      // The ring now shows MIRROR_MAX_PER_DAY consumed slots even though every
      // attempt FAILED (the slot is never freed on a throw) — a 4th attempt in
      // the same 24h window must be SUPPRESSED, not retried.
      const fourth = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, throwing));
      expect(fourth).toEqual({ sent: 0, failed: 0, suppressed: 1, noContact: 0 });
      expect(await rowMirroredAt(tenantId, row.id)).toBeNull();
    });
  });
});

describe("T5 — cap + overflow digest: nothing is ever dropped", () => {
  it("5 eligible conditions across the day: 3 individual mails, then 1 digest carrying every withheld body once the ring readmits", async () => {
    const { tenantId } = await signup("Mirror T5", "t5@mirror.test");
    await withMirrorArmed(async () => {
      // Three conditions, each drained immediately — spends all 3 ring slots.
      for (let i = 0; i < 3; i++) {
        await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: `cond-${i}` }));
        const mailer = new SandboxOpsMailer();
        const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
        expect(result.sent).toBe(1);
      }

      // Two more conditions arrive while the ring is full — held, not dropped.
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: "cond-3" }));
      const heldMailer = new SandboxOpsMailer();
      const held = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, heldMailer));
      expect(held).toEqual({ sent: 0, failed: 0, suppressed: 1, noContact: 0 });

      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: "cond-4" }));
      const held2Mailer = new SandboxOpsMailer();
      const held2 = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, held2Mailer));
      expect(held2).toEqual({ sent: 0, failed: 0, suppressed: 2, noContact: 0 });

      // Age the ring's 3 slots out (advance the ring's own stored timestamps
      // back by more than MIRROR_WINDOW_MS) so it readmits — the digest fires.
      await withTenantContext(tenantId, (ctx) => {
        const row = ctx.sql.exec<{ mirror_ring_json: string | null }>(`SELECT mirror_ring_json FROM tenant_profile WHERE id = ?`, tenantId).one();
        const ring: MirrorRing = row.mirror_ring_json ? JSON.parse(row.mirror_ring_json) : { sends: [] };
        const backdated: MirrorRing = { sends: ring.sends.map((ts) => ts - MIRROR_WINDOW_MS - 1000) };
        ctx.sql.exec(`UPDATE tenant_profile SET mirror_ring_json = ? WHERE id = ?`, JSON.stringify(backdated), tenantId);
      });

      const digestMailer = new SandboxOpsMailer();
      const digest = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, digestMailer));
      expect(digest.sent).toBe(1);
      expect(digestMailer.sent).toHaveLength(1);
      expect(digestMailer.sent[0]!.text).toContain("cond-3");
      expect(digestMailer.sent[0]!.text).toContain("cond-4");

      // 0 dropped: every one of the 5 conditions is now mirrored.
      const rows = await withTenantContext(tenantId, (ctx) =>
        ctx.sql.exec<{ mirrored_at: number | null }>(`SELECT mirrored_at FROM tenant_messages WHERE tenant_id = ?`, tenantId).toArray(),
      );
      expect(rows.every((r) => r.mirrored_at !== null)).toBe(true);
      expect(rows).toHaveLength(5);
    });
  });
});

describe("T6 — the ring is a sliding window over timestamps, never a tumbling {windowStart,count}", () => {
  it("3 sends at T+23.9h then 3 more at T+24.1h do not both admit", () => {
    const dayStart = 1_700_000_000_000;
    const firstBatchAt = dayStart + 23.9 * 60 * 60 * 1000;
    let ring: MirrorRing = { sends: [] };
    for (let i = 0; i < MIRROR_MAX_PER_DAY; i++) {
      const pruned = pruneMirrorRing(ring, firstBatchAt);
      expect(pruned.sends.length).toBeLessThan(MIRROR_MAX_PER_DAY);
      ring = { sends: [...pruned.sends, firstBatchAt] };
    }

    // Only 0.2h later — a TUMBLING window keyed on a day boundary would have
    // reset between T+24.0h and here and wrongly readmit a fresh 3.
    const secondBatchAt = dayStart + 24.1 * 60 * 60 * 1000;
    const stillLive = pruneMirrorRing(ring, secondBatchAt);
    expect(stillLive.sends).toHaveLength(MIRROR_MAX_PER_DAY);
    expect(stillLive.sends.length).not.toBeLessThan(MIRROR_MAX_PER_DAY);

    // Well past the window (measured from the sends themselves, not the
    // arbitrary day-start anchor), the same ring finally ages out.
    const wellPast = firstBatchAt + MIRROR_WINDOW_MS + 1000;
    expect(pruneMirrorRing(ring, wellPast).sends).toHaveLength(0);
  });
});

describe("T7 — continuity_nudge never mirrors (ruling Q1, 2026-08-18)", () => {
  it("a continuity_nudge row at action_required is excluded by kind, not by a weaker severity gate", async () => {
    const { tenantId } = await signup("Mirror T7", "t7@mirror.test");
    await withMirrorArmed(async () => {
      await withTenantContext(tenantId, (ctx) =>
        emitTenantMessage(ctx, { kind: CONTINUITY_NUDGE_KIND, severity: "action_required", body: "stalled" }),
      );
      const mailer = new SandboxOpsMailer();
      const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
      expect(result).toEqual({ sent: 0, failed: 0, suppressed: 0, noContact: 0 });
      expect(mailer.sent).toHaveLength(0);
    });
  });
});

describe("Gate NB1 — the mirrorability predicate lives in SQL, so LIMIT bounds CANDIDATES, not raw rows", () => {
  it("200 non-mirrorable 'info' rows created ahead of ONE terminal row still sends it (the exact starvation the gate proved)", async () => {
    const { tenantId } = await signup("Gate NB1 Co", "nb1@gate.test");
    await withMirrorArmed(async () => {
      const base = await withTenantContext(tenantId, (ctx) => ctx.clock.now());
      for (let i = 0; i < 200; i++) {
        await insertRow(tenantId, `tmsg_info_${i}`, "retry_setup", "info", `info-${i}`, "system", { createdAt: base + i });
      }
      await insertRow(tenantId, "tmsg_terminal", "setup_failed", "terminal", "the real one", "system", { createdAt: base + 200 });

      const mailer = new SandboxOpsMailer();
      const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
      expect(result.sent).toBe(1);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.text).toContain("the real one");
    });
  });

  it("the boundary one row narrower (199 ahead) also sends — proving the fix isn't a LIMIT-count coincidence", async () => {
    const { tenantId } = await signup("Gate NB1 Boundary Co", "nb1b@gate.test");
    await withMirrorArmed(async () => {
      const base = await withTenantContext(tenantId, (ctx) => ctx.clock.now());
      for (let i = 0; i < 199; i++) {
        await insertRow(tenantId, `tmsg_info_${i}`, "retry_setup", "info", `info-${i}`, "system", { createdAt: base + i });
      }
      await insertRow(tenantId, "tmsg_terminal", "setup_failed", "terminal", "the real one", "system", { createdAt: base + 199 });

      const mailer = new SandboxOpsMailer();
      const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
      expect(result.sent).toBe(1);
    });
  });
});

describe("Gate NB4 — MESSAGE_MIRROR_MAX_PER_DAY=\"0\" means a genuine hard-off, not the silent default", () => {
  it('env override "0" suppresses every send while armed, rather than falling back to 3', async () => {
    const { tenantId } = await signup("Gate NB4 Co", "nb4@gate.test");
    const prevMax = env.MESSAGE_MIRROR_MAX_PER_DAY;
    env.MESSAGE_MIRROR_MAX_PER_DAY = "0";
    try {
      await withMirrorArmed(async () => {
        await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: "stuck" }));
        const mailer = new SandboxOpsMailer();
        const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
        expect(result).toEqual({ sent: 0, failed: 0, suppressed: 1, noContact: 0 });
        expect(mailer.sent).toHaveLength(0);
      });
    } finally {
      env.MESSAGE_MIRROR_MAX_PER_DAY = prevMax;
    }
  });

  it("an unset/empty/malformed override still falls back to the default 3, unaffected by the \"0\" fix", async () => {
    const { tenantId } = await signup("Gate NB4 Default Co", "nb4default@gate.test");
    const prevMax = env.MESSAGE_MIRROR_MAX_PER_DAY;
    env.MESSAGE_MIRROR_MAX_PER_DAY = "not-a-number";
    try {
      await withMirrorArmed(async () => {
        await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: "stuck" }));
        const mailer = new SandboxOpsMailer();
        const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
        expect(result.sent).toBe(1); // malformed -> default (3), so the first send still admits
      });
    } finally {
      env.MESSAGE_MIRROR_MAX_PER_DAY = prevMax;
    }
  });
});

describe("T8 — NULL contact email never leaks a synthetic address into mailer.send", () => {
  it("mintTenant has no contact email on file -> 0 sends, noContact counted", async () => {
    const { tenantId } = await mintTenant("Mirror T8 No Contact", "managed");
    await withMirrorArmed(async () => {
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: "stuck" }));
      const mailer = new SandboxOpsMailer();
      const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
      expect(result).toEqual({ sent: 0, failed: 0, suppressed: 0, noContact: 1 });
      expect(mailer.sent).toHaveLength(0);
    });
  });
});

describe("Gate B2 — a THROWN contact lookup is retryable (failed), never confused with a resolved NULL (noContact)", () => {
  it("D1 fault on the lookup -> failed:1, claim released; D1 recovers -> the SAME row sends", async () => {
    const { tenantId } = await signup("Gate B2 Co", "b2@gate.test");
    await withMirrorArmed(async () => {
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: "stuck" }));
      const row = await withTenantContext(tenantId, (ctx) =>
        ctx.sql.exec<{ id: string }>(`SELECT id FROM tenant_messages WHERE tenant_id = ?`, tenantId).one(),
      );

      // Fault-inject the EXACT lookup lookupTenantContactEmail issues
      // (db.ts: `SELECT contact_email FROM tenants_index WHERE id = ?`).
      const faultingEnv = envWithFailingD1Statements(/contact_email FROM tenants_index/);
      const faultMailer = new SandboxOpsMailer();
      const faultResult = await withTenantContext(tenantId, (ctx) => drainMessageMirror({ ...ctx, env: faultingEnv }, faultMailer));

      expect(faultResult).toEqual({ sent: 0, failed: 1, suppressed: 0, noContact: 0 });
      expect(faultMailer.sent).toHaveLength(0);
      // The claim was RELEASED (not committed as noContact) -- the row is
      // eligible again, exactly like a send failure (§5's NEW-4 shape).
      expect(await rowMirroredAt(tenantId, row.id)).toBeNull();

      // D1 recovers: the SAME row, never touched, now sends for real.
      const healthyMailer = new SandboxOpsMailer();
      const healthyResult = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, healthyMailer));
      expect(healthyResult).toEqual({ sent: 1, failed: 0, suppressed: 0, noContact: 0 });
      expect(healthyMailer.sent).toHaveLength(1);
    });
  });

  it("the ring slot from the faulting attempt still counted (Inc5 NEW-4 carried through the fix)", async () => {
    const { tenantId } = await signup("Gate B2 Ring Co", "b2ring@gate.test");
    await withMirrorArmed(async () => {
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: "stuck" }));
      const faultingEnv = envWithFailingD1Statements(/contact_email FROM tenants_index/);
      for (let i = 0; i < MIRROR_MAX_PER_DAY; i++) {
        const mailer = new SandboxOpsMailer();
        const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror({ ...ctx, env: faultingEnv }, mailer));
        expect(result.failed).toBe(1);
      }
      // Ring is now full from 3 faulting attempts -- a 4th (even against a
      // healthy env) is suppressed, not retried a 4th time in the window.
      const mailer = new SandboxOpsMailer();
      const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
      expect(result).toEqual({ sent: 0, failed: 0, suppressed: 1, noContact: 0 });
    });
  });
});

describe("T9 — opt-out suppresses the mirror only, never dunning", () => {
  it("opted out -> 0 mirror sends", async () => {
    const { tenantId } = await signup("Mirror T9", "t9@mirror.test");
    await withMirrorArmed(async () => {
      await withTenantContext(tenantId, (ctx) => setMirrorEmailOptOut(ctx, true));
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: "stuck" }));
      const mailer = new SandboxOpsMailer();
      const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
      expect(result).toEqual({ sent: 0, failed: 0, suppressed: 0, noContact: 0 });
      expect(mailer.sent).toHaveLength(0);

      const state = await withTenantContext(tenantId, (ctx) => getMessageEmailMirrorState(ctx));
      expect(state.optedOut).toBe(true);
    });
  });

  it("an opted-out tenant's dunning suspend notice still sends — the two channels are independent", async () => {
    const { tenantId } = await signup("Mirror T9 Dunning", "t9-dunning@mirror.test");
    await withTenantContext(tenantId, (ctx) => setMirrorEmailOptOut(ctx, true));
    for (let i = 0; i < 4; i++) await failPayment(tenantId);

    const mailer = new SandboxOpsMailer();
    await runDunningSweep(env, Date.now(), mailer);
    expect(mailer.sent.find((m) => m.to === "t9-dunning@mirror.test")).toBeDefined();
  });
});

describe("T11 — dark by default: the flag unset returns before ANY I/O", () => {
  it("0 sends and no D1/contact-email read when MESSAGE_EMAIL_MIRROR_ENABLED is unset", async () => {
    const { tenantId } = await signup("Mirror T11", "t11@mirror.test");
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: "stuck" }));

    const originalFetchFirst = env.DB.prepare;
    let d1Touched = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (env.DB as any).prepare = (...args: unknown[]) => {
      d1Touched = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalFetchFirst as any).apply(env.DB, args);
    };
    try {
      const mailer = new SandboxOpsMailer();
      const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
      expect(result).toEqual({ sent: 0, failed: 0, suppressed: 0, noContact: 0 });
      expect(mailer.sent).toHaveLength(0);
      expect(d1Touched).toBe(false);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (env.DB as any).prepare = originalFetchFirst;
    }
  });

  it("touches ZERO Durable Object storage when the flag is unset — not just D1 (the arming check is the literal first line, before ctx.sql)", async () => {
    const { tenantId } = await signup("Mirror T11 DO Spy", "t11-dospy@mirror.test");
    await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: "stuck" }));

    const execCalls = await runInDurableObject(tenantStub(tenantId), async (_instance, state) => {
      const sql = state.storage.sql;
      let calls = 0;
      const original = sql.exec.bind(sql);
      // Monkey-patch AFTER the fixture write above already landed — this spy
      // only has to prove the DRAIN itself makes zero calls, not that the
      // tenant's DO has never been touched (coldstart-readonly-hint-write-spy
      // technique: patching state.storage.sql.exec directly is the only way
      // to intercept the real object drainMessageMirror actually receives).
      (sql as unknown as { exec: typeof sql.exec }).exec = ((...args: Parameters<typeof sql.exec>) => {
        calls++;
        return original(...args);
      }) as typeof sql.exec;

      // A minimal TenantContext: drainMessageMirror provably never reads
      // plan/clock/adapters (grep engine/message-mirror.ts — only sql,
      // tenantId, env), so these are inert placeholders, not a shortcut
      // around what's actually being proven (the sql spy is the real object).
      const ctx: TenantContext = {
        sql,
        tenantId,
        plan: "demo",
        clock: { now: () => Date.now() },
        adapters: {} as TenantContext["adapters"],
        env,
      };

      await drainMessageMirror(ctx, new SandboxOpsMailer());
      return calls;
    });

    expect(execCalls).toBe(0);
  });

  it("isMirrorArmed is false for every dark-reading value", () => {
    for (const off of [undefined, "", "0", "false", "FALSE"]) {
      expect(isMirrorArmed({ MESSAGE_EMAIL_MIRROR_ENABLED: off, MESSAGE_MIRROR_TENANT_ALLOWLIST: undefined }, "ten_x")).toBe(false);
    }
    expect(isAffirmativeEnvFlag("1")).toBe(true);
  });

  it("an armed allowlist scopes arming to exactly the listed tenants", () => {
    const flagged = { MESSAGE_EMAIL_MIRROR_ENABLED: "1", MESSAGE_MIRROR_TENANT_ALLOWLIST: "ten_a,ten_b" };
    expect(isMirrorArmed(flagged, "ten_a")).toBe(true);
    expect(isMirrorArmed(flagged, "ten_c")).toBe(false);
  });
});

describe("T12 — backfill: a DO whose tenant_messages predates the column mails nothing on its first armed drain", () => {
  it("pre-existing NULL-mirrored_at rows are stamped suppressed on the column's arrival, never mailed", async () => {
    const { tenantId } = await signup("Mirror T12", "t12@mirror.test");
    // Simulate a row that existed BEFORE this column did by inserting it and
    // then re-running the exact backfill tenant-do.ts's boot path performs
    // (the column already exists on a freshly-migrated worktree DO, so this
    // proves the backfill UPDATE's own predicate/effect directly).
    await insertRow(tenantId, "tmsg_legacy", "setup_failed", "terminal", "pre-existing", "system");
    await withTenantContext(tenantId, (ctx) => {
      ctx.sql.exec(`UPDATE tenant_messages SET mirrored_at = 0 WHERE tenant_id = ? AND mirrored_at IS NULL`, tenantId);
    });

    await withMirrorArmed(async () => {
      const mailer = new SandboxOpsMailer();
      const result = await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
      expect(result).toEqual({ sent: 0, failed: 0, suppressed: 0, noContact: 0 });
      expect(mailer.sent).toHaveLength(0);
    });
  });
});

describe("T15 — the composed email carries no promotional content and no link but the account's own (C9)", () => {
  it("the only URL in the body is the opt-out link; no upsell/cross-sell copy", async () => {
    const { tenantId } = await signup("Mirror T15", "t15@mirror.test");
    await withMirrorArmed(async () => {
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: "your setup stopped" }));
      const mailer = new SandboxOpsMailer();
      await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
      expect(mailer.sent).toHaveLength(1);
      const { text, html } = mailer.sent[0]!;

      const urls = [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0].replace(/[).,]+$/, ""));
      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url).toContain("/messages/mirror/optout");

      for (const banned of ["upgrade", "% off", "discount", "buy now", "limited time", "sale"]) {
        expect(text.toLowerCase()).not.toContain(banned);
        expect(html.toLowerCase()).not.toContain(banned);
      }
    });
  });
});

describe("T16 — the HTML leg escapes every interpolated body", () => {
  it("a body containing HTML-significant characters is never rendered unescaped", async () => {
    const { tenantId } = await signup("Mirror T16", "t16@mirror.test");
    await withMirrorArmed(async () => {
      const hostile = `<img src=x onerror=alert(1)> & "quoted"`;
      await withTenantContext(tenantId, (ctx) => emitTenantMessage(ctx, { kind: "setup_failed", severity: "terminal", body: hostile }));
      const mailer = new SandboxOpsMailer();
      await withTenantContext(tenantId, (ctx) => drainMessageMirror(ctx, mailer));
      expect(mailer.sent).toHaveLength(1);
      const { html } = mailer.sent[0]!;
      expect(html).not.toContain("<img src=x onerror=alert(1)>");
      expect(html).toContain("&lt;img");
      expect(html).toContain("&amp;");
    });
  });
});
