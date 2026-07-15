import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { createOpsMailer, OpsMailNotConfiguredError, OPS_FROM_EMAIL, OPS_FROM_NAME } from "../src/ops-mail/ops-mailer.js";
import { RealOpsMailer } from "../src/ops-mail/real-ops-mailer.js";
import { SandboxOpsMailer } from "../src/ops-mail/sandbox-ops-mailer.js";

describe("OpsMailer port", () => {
  it("SandboxOpsMailer records every send with the fixed ops sender identity", async () => {
    const mailer = new SandboxOpsMailer();
    const res = await mailer.send({ to: "x@example.com", subject: "hi", text: "t", html: "<p>t</p>" });

    expect(res.messageId).toMatch(/@ops\.sandbox\.local>$/);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      to: "x@example.com",
      subject: "hi",
      text: "t",
      html: "<p>t</p>",
      from: { email: OPS_FROM_EMAIL, name: OPS_FROM_NAME },
    });
  });

  it("RealOpsMailer with NO binding throws the typed OpsMailNotConfiguredError (dark)", async () => {
    const mailer = new RealOpsMailer(undefined);
    await expect(mailer.send({ to: "x@example.com", subject: "s", text: "t", html: "<p>t</p>" })).rejects.toBeInstanceOf(
      OpsMailNotConfiguredError,
    );
  });

  it("createOpsMailer picks the real impl when OPS_EMAIL is bound, sandbox when absent", () => {
    // Fake envs isolate the factory's single decision (mirrors vendors/
    // factory.ts). The binding IS declared in wrangler.toml, so real is the
    // production path; absent (pre-onboarding / a stripped env) -> sandbox.
    const withBinding = { OPS_EMAIL: { async send() { return { messageId: "x" }; } } } as unknown as Env;
    const withoutBinding = { OPS_EMAIL: undefined } as unknown as Env;
    expect(createOpsMailer(withBinding)).toBeInstanceOf(RealOpsMailer);
    expect(createOpsMailer(withoutBinding)).toBeInstanceOf(SandboxOpsMailer);
  });
});
