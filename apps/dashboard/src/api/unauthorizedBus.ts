// SPEC.md §19.1/§19.6 — "401 from any API → return to token-gate with
// explanation." The API client (client.ts) can't reach into React context,
// so it emits here; AuthProvider (auth/AuthProvider.tsx) is the only
// subscriber and turns this into a route change + explanatory copy.
//
// Backend gaps brief item 4 — mirrors apps/platform/src/require-auth.ts's
// `AuthFailureCode` exactly (the machine-readable `code` every 401 body now
// carries), so TokenGate can render a DISTINCT, honest explanation per
// reason instead of one generic "session ended" banner.
export type UnauthorizedReason = "invalid_token" | "expired_session" | "account_suspended";

type Listener = (reason: UnauthorizedReason) => void;
const listeners = new Set<Listener>();

export function onUnauthorized(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitUnauthorized(reason: UnauthorizedReason): void {
  for (const listener of listeners) listener(reason);
}
