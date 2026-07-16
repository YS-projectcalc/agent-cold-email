import { describe, expect, it, vi } from "vitest";
import { UpstreamTransientError } from "../src/errors.js";
import { TokenCache } from "../src/oauth.js";

// The access-token cache: mint once, reuse until (skewed) expiry, force-refresh
// on demand, and surface any token-endpoint failure as a transient send failure.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FORM = { client_id: "c", client_secret: "s", refresh_token: "rt", grant_type: "refresh_token" };

function tokenResponder(expiresIn = 3600) {
  let n = 1;
  return vi.fn(async (): Promise<Response> => new Response(JSON.stringify({ access_token: `tok${n++}`, expires_in: expiresIn }), { status: 200 }));
}

describe("TokenCache", () => {
  it("mints once and reuses the token within its (skewed) lifetime", async () => {
    const fetchImpl = tokenResponder(3600);
    let clock = 0;
    const cache = new TokenCache(fetchImpl as unknown as typeof fetch, TOKEN_URL, FORM, () => clock);

    expect(await cache.get()).toBe("tok1");
    clock += 60_000; // still well inside the ~1h lifetime
    expect(await cache.get()).toBe("tok1");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refreshes after the token expires (minus the safety skew)", async () => {
    const fetchImpl = tokenResponder(3600);
    let clock = 0;
    const cache = new TokenCache(fetchImpl as unknown as typeof fetch, TOKEN_URL, FORM, () => clock);

    expect(await cache.get()).toBe("tok1");
    clock += 3600_000; // past expiry
    expect(await cache.get()).toBe("tok2");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("forceRefresh mints a new token even while the cached one is valid", async () => {
    const fetchImpl = tokenResponder(3600);
    const cache = new TokenCache(fetchImpl as unknown as typeof fetch, TOKEN_URL, FORM, () => 0);

    expect(await cache.get()).toBe("tok1");
    expect(await cache.get(true)).toBe("tok2");
  });

  it("surfaces a token-endpoint HTTP error as UpstreamTransientError", async () => {
    const fetchImpl = vi.fn(async () => new Response("invalid_grant", { status: 400 }));
    const cache = new TokenCache(fetchImpl as unknown as typeof fetch, TOKEN_URL, FORM, () => 0);
    await expect(cache.get()).rejects.toBeInstanceOf(UpstreamTransientError);
  });

  it("surfaces a token response missing access_token as UpstreamTransientError", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 }));
    const cache = new TokenCache(fetchImpl as unknown as typeof fetch, TOKEN_URL, FORM, () => 0);
    await expect(cache.get()).rejects.toBeInstanceOf(UpstreamTransientError);
  });
});
