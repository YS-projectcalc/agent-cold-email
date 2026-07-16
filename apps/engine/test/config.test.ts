import { describe, expect, it } from "vitest";
import { loadConfig, mailboxCredentialsSchema } from "../src/config.js";

// The per-mailbox send-transport discriminator. The load-bearing property is
// BACKWARD COMPATIBILITY: an existing `{smtp, imap}` app-password entry (no
// `send` field) must keep validating as an SMTP mailbox unchanged, while the new
// API transports validate their own required OAuth fields.

const smtp = { host: "smtp.gmail.com", port: 465, secure: true, user: "u@x.test", pass: "p" };
const imap = { host: "imap.gmail.com", port: 993, secure: true, user: "u@x.test", pass: "p" };

describe("mailboxCredentialsSchema — transport discriminator", () => {
  it("accepts a legacy {smtp, imap} entry (no `send`) as the default SMTP transport", () => {
    const parsed = mailboxCredentialsSchema.parse({ smtp, imap });
    expect(parsed.send).toBeUndefined();
    expect(parsed.smtp).toEqual(smtp);
  });

  it("rejects an SMTP mailbox missing its smtp endpoint", () => {
    const res = mailboxCredentialsSchema.safeParse({ imap });
    expect(res.success).toBe(false);
  });

  it("accepts a gmail_api mailbox with OAuth fields and no smtp endpoint", () => {
    const parsed = mailboxCredentialsSchema.parse({
      imap,
      send: { kind: "gmail_api", clientId: "cid", clientSecret: "sec", refreshToken: "rt" },
    });
    expect(parsed.send).toMatchObject({ kind: "gmail_api", clientId: "cid" });
    expect(parsed.smtp).toBeUndefined();
  });

  it("rejects a gmail_api mailbox missing the refresh token", () => {
    const res = mailboxCredentialsSchema.safeParse({
      imap,
      send: { kind: "gmail_api", clientId: "cid", clientSecret: "sec" },
    });
    expect(res.success).toBe(false);
  });

  it("accepts an ms_graph delegated mailbox with a refresh token", () => {
    const parsed = mailboxCredentialsSchema.parse({
      imap,
      send: { kind: "ms_graph", mode: "delegated", tenantId: "t", clientId: "c", clientSecret: "s", refreshToken: "rt" },
    });
    expect(parsed.send).toMatchObject({ kind: "ms_graph", mode: "delegated" });
  });

  it("rejects an ms_graph delegated mailbox with no refresh token", () => {
    const res = mailboxCredentialsSchema.safeParse({
      imap,
      send: { kind: "ms_graph", mode: "delegated", tenantId: "t", clientId: "c", clientSecret: "s" },
    });
    expect(res.success).toBe(false);
  });

  it("accepts an ms_graph app_only mailbox with an explicit user", () => {
    const parsed = mailboxCredentialsSchema.parse({
      imap,
      send: { kind: "ms_graph", mode: "app_only", tenantId: "t", clientId: "c", clientSecret: "s", user: "box@x.test" },
    });
    expect(parsed.send).toMatchObject({ kind: "ms_graph", mode: "app_only", user: "box@x.test" });
  });

  it("rejects an ms_graph app_only mailbox with no user (Graph app-only has no `me`)", () => {
    const res = mailboxCredentialsSchema.safeParse({
      imap,
      send: { kind: "ms_graph", mode: "app_only", tenantId: "t", clientId: "c", clientSecret: "s" },
    });
    expect(res.success).toBe(false);
  });
});

describe("loadConfig — backward compatibility", () => {
  it("loads a legacy inline SMTP credentials map unchanged", () => {
    const cfg = loadConfig({
      ENGINE_AUTH_SECRET: "a-strong-shared-secret-value",
      MAILBOX_CREDENTIALS: JSON.stringify({ "u@x.test": { smtp, imap } }),
    } as NodeJS.ProcessEnv);
    expect(cfg.credentials["u@x.test"]?.smtp).toEqual(smtp);
    expect(cfg.credentials["u@x.test"]?.send).toBeUndefined();
  });

  it("loads a mixed map with an API-transport mailbox alongside a legacy SMTP one", () => {
    const cfg = loadConfig({
      ENGINE_AUTH_SECRET: "a-strong-shared-secret-value",
      MAILBOX_CREDENTIALS: JSON.stringify({
        "legacy@x.test": { smtp, imap },
        "api@x.test": { imap, send: { kind: "gmail_api", clientId: "c", clientSecret: "s", refreshToken: "rt" } },
      }),
    } as NodeJS.ProcessEnv);
    expect(cfg.credentials["legacy@x.test"]?.send).toBeUndefined();
    expect(cfg.credentials["api@x.test"]?.send).toMatchObject({ kind: "gmail_api" });
  });
});
