import { afterEach, describe, expect, it, vi } from "vitest";
import { VendorError } from "@coldstart/shared";
import { InboxKitClient } from "../src/vendors/real/inboxkit-client.js";
import { InboxKitOAuthMinter, ManualOAuthMinter, type GmailGrant } from "../src/vendors/real/oauth-mint.js";
import { IK_API_KEY, IK_CONSENT_SUCCESS, IK_WORKSPACE_ID } from "./fixtures/inboxkit.js";

// The OAuth-mint seam (I3c): the two ways a provisioned mailbox gets its
// gmail_api refresh token, behind one interface. No live calls — fetch stubbed.

const CONFIG = { apiKey: IK_API_KEY, workspaceId: IK_WORKSPACE_ID, baseUrl: "https://ik.example.internal/v1/api" };
const MAILBOX = { email: "john.doe@example-lookalike.com", domain: "example-lookalike.com" };
const GRANT: GmailGrant = { clientId: "cid", clientSecret: "csecret", refreshToken: "1//operator-minted" };

function stubFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  const spy = vi.spyOn(globalThis, "fetch");
  for (const res of responses) {
    spy.mockImplementationOnce(async () => new Response(JSON.stringify(res.body), { status: res.status, headers: { "content-type": "application/json" } }));
  }
  return spy;
}
afterEach(() => vi.restoreAllMocks());

describe("ManualOAuthMinter — the proven operator-supplied path", () => {
  it("returns the operator-supplied grant for a known mailbox", async () => {
    const minter = new ManualOAuthMinter({ [MAILBOX.email]: GRANT });
    expect(minter.kind).toBe("manual");
    await expect(minter.mintGmailGrant(MAILBOX)).resolves.toEqual(GRANT);
  });

  it("fails LOUD (permanent) when no grant was supplied for the mailbox — never a silent no-send", async () => {
    const minter = new ManualOAuthMinter({});
    const err = await minter.mintGmailGrant(MAILBOX).catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).retryable).toBe(false);
  });
});

describe("InboxKitOAuthMinter — the programmatic fleet path (DARK, UNVERIFIED)", () => {
  it("registers the client id then requests consent, extracting the refresh token", async () => {
    const spy = stubFetchSequence([
      { status: 200, body: { error: false } }, // client-id-request/initiate
      { status: 200, body: IK_CONSENT_SUCCESS }, // consent-request
    ]);
    const minter = new InboxKitOAuthMinter(new InboxKitClient(CONFIG), "our-google-client-id", "fallback-secret");
    const grant = await minter.mintGmailGrant(MAILBOX);

    expect(grant.refreshToken).toBe("1//refresh-token-from-consent");
    expect(grant.clientId).toBe("our-google-client-id");
    expect(grant.clientSecret).toBe("google-oauth-client-secret"); // from the consent response, not the fallback
    const [initiateUrl] = spy.mock.calls[0]!;
    const [consentUrl] = spy.mock.calls[1]!;
    expect(initiateUrl).toBe("https://ik.example.internal/v1/api/mailboxes/client-id-request/initiate");
    expect(consentUrl).toBe("https://ik.example.internal/v1/api/mailboxes/client-id-request/initiate-consent-request");
  });

  it("fails LOUD when consent returns no refresh token (UNVERIFIED response shape) — never pushes an unsendable mailbox", async () => {
    stubFetchSequence([{ status: 200, body: { error: false } }, { status: 200, body: { error: false, message: "shape differs" } }]);
    const minter = new InboxKitOAuthMinter(new InboxKitClient(CONFIG), "our-google-client-id", "fallback-secret");
    const err = await minter.mintGmailGrant(MAILBOX).catch((e) => e);
    expect(err).toBeInstanceOf(VendorError);
    expect((err as VendorError).message).toMatch(/no refresh token|UNVERIFIED/i);
  });
});
