import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthProvider";
import { TokenGate } from "./auth/TokenGate";
import { AppShell } from "./shell/AppShell";

// SPEC.md §19.1 perf budget ("initial JS ≤ 200 KB gzip, route-split") — the
// token-gate + shell chrome load eagerly (needed on every visit); each page's
// own widgets/tables are route-split so a token-gate-only visit, or a visit
// that never opens Settings, never pays for that code.
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const InboxPage = lazy(() => import("./pages/InboxPage").then((m) => ({ default: m.InboxPage })));
const SetupPage = lazy(() => import("./pages/SetupPage").then((m) => ({ default: m.SetupPage })));
const BillingPage = lazy(() => import("./pages/BillingPage").then((m) => ({ default: m.BillingPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const SignupPage = lazy(() => import("./auth/SignupPage").then((m) => ({ default: m.SignupPage })));
const RecoveryPage = lazy(() => import("./auth/RecoveryPage").then((m) => ({ default: m.RecoveryPage })));

function FullPageSpinner() {
  return (
    <div className="flex h-screen items-center justify-center bg-canvas text-ink-muted" role="status" aria-live="polite">
      Loading…
    </div>
  );
}

function RouteFallback() {
  return (
    <div className="animate-pulse space-y-3" aria-hidden="true">
      <div className="h-6 w-32 rounded bg-surface-inset" />
      <div className="h-24 w-full rounded bg-surface-inset" />
    </div>
  );
}

export function App() {
  const { status } = useAuth();

  // §19.1: an unauthed visitor (fresh, logged-out, or 401-dropped) only ever
  // sees the token-gate, regardless of which client route they landed on.
  if (status === "unknown") return <FullPageSpinner />;
  if (status === "unauthed") {
    return (
      <Routes>
        <Route path="signup" element={<Suspense fallback={<FullPageSpinner />}><SignupPage /></Suspense>} />
        <Route path="recover" element={<Suspense fallback={<FullPageSpinner />}><RecoveryPage /></Suspense>} />
        <Route path="*" element={<TokenGate />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route
        path="recover"
        element={
          <Suspense fallback={<FullPageSpinner />}>
            <RecoveryPage />
          </Suspense>
        }
      />
      <Route path="signup" element={<Navigate to="/setup" replace />} />
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route
          path="dashboard"
          element={
            <Suspense fallback={<RouteFallback />}>
              <DashboardPage />
            </Suspense>
          }
        />
        <Route
          path="inbox"
          element={
            <Suspense fallback={<RouteFallback />}>
              <InboxPage />
            </Suspense>
          }
        />
        <Route
          path="setup"
          element={
            <Suspense fallback={<RouteFallback />}>
              <SetupPage />
            </Suspense>
          }
        />
        <Route
          path="billing"
          element={
            <Suspense fallback={<RouteFallback />}>
              <BillingPage />
            </Suspense>
          }
        />
        <Route
          path="settings"
          element={
            <Suspense fallback={<RouteFallback />}>
              <SettingsPage />
            </Suspense>
          }
        />
        <Route path="*" element={<Navigate to="dashboard" replace />} />
      </Route>
    </Routes>
  );
}
