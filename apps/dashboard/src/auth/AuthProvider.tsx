import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import { onUnauthorized, type UnauthorizedReason } from "../api/unauthorizedBus";
import { useLogin, useLogout } from "../api/queries";
import type { AccountSummary } from "../api/types";

type AuthStatus = "unknown" | "authed" | "unauthed";

interface AuthState {
  status: AuthStatus;
  tenantId: string | null;
  /** Set only when a *global* 401 dropped an already-authed session — distinct
   * from a fresh visitor who has never signed in, and distinct from the
   * token-gate form's own "that token was rejected" error (LoginForm's local
   * state) — §19.1/§19.6: "401 from any API → return to token-gate with
   * explanation." */
  reason: UnauthorizedReason | null;
}

interface AuthContextValue extends AuthState {
  login: (token: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Magic-link login (design §1.4) — POST /login/consume already minted the
   * httpOnly cookie session server-side (the SAME mintDashboardSession() the
   * bearer exchange uses), so there is no second network call here: this
   * just flips local state to authed, mirroring what `login()` does after
   * its own mutation succeeds. */
  completeMagicLinkSession: (tenantId: string) => void;
  logout: () => Promise<void>;
  loginPending: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "unknown", tenantId: null, reason: null });
  const queryClient = useQueryClient();
  const loginMutation = useLogin();
  const logoutMutation = useLogout();

  // Bootstrap: the httpOnly cookie is invisible to JS by design (§19.1), so
  // the only way to know "is there already a valid session" is to probe an
  // authed endpoint once on load.
  useEffect(() => {
    let cancelled = false;
    apiRequest<AccountSummary>("/account", { suppressUnauthorizedRedirect: true })
      .then((account) => {
        if (!cancelled) setState({ status: "authed", tenantId: account.tenantId, reason: null });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "unauthed", tenantId: null, reason: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () =>
      onUnauthorized((reason) => {
        setState({ status: "unauthed", tenantId: null, reason });
        queryClient.clear();
      }),
    [queryClient],
  );

  const login = useCallback(
    async (token: string) => {
      try {
        const result = await loginMutation.mutateAsync(token);
        setState({ status: "authed", tenantId: result.tenantId, reason: null });
        return { ok: true as const };
      } catch (err) {
        const message = err instanceof Error ? err.message : "invalid token";
        return { ok: false as const, message };
      }
    },
    [loginMutation],
  );

  const logout = useCallback(async () => {
    try {
      await logoutMutation.mutateAsync();
    } finally {
      queryClient.clear();
      setState({ status: "unauthed", tenantId: null, reason: null });
    }
  }, [logoutMutation, queryClient]);

  const completeMagicLinkSession = useCallback((tenantId: string) => {
    setState({ status: "authed", tenantId, reason: null });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, completeMagicLinkSession, logout, loginPending: loginMutation.isPending }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
