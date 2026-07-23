import { Outlet } from "react-router-dom";
import { DESKTOP_QUERY, useMediaQuery } from "../lib/useMediaQuery";
import { NavRail } from "./NavRail";
import { BottomTabs } from "./BottomTabs";
import { MailboxHealthBanner } from "./MailboxHealthBanner";
import { ActivationBanner } from "./ActivationBanner";

// §19.1 shell: desktop (≥1024px) icon nav rail + content pane; mobile
// (<768px) bottom tab bar. The 768-1024px band gets the mobile shell (a
// dedicated tablet layout is out of scope for v1).
//
// `h-dvh` (not `min-h-screen`) + `overflow-y-auto` on `<main>` — an M3 fix,
// not just an inbox-only concern: this makes `<main>` the ONE real,
// height-bounded scroll container app-wide (flexbox stretches it to fill
// exactly `h-dvh` minus its row siblings), which the inbox's virtualized
// split view needs a genuine ref-measurable height for. Dashboard/Settings
// keep scrolling exactly as before, just inside `main` instead of `body`.
//
// The bottom padding on mobile was a flat `pb-20` (5rem) — that reserves
// space for BottomTabs' own ~5rem content height, but BottomTabs ALSO adds
// `pb-[env(safe-area-inset-bottom)]` to grow taller on notched devices. A
// flat constant doesn't grow with it, so on a large safe-area device the
// last list row could peek out from under the tab bar — fixed by adding the
// same `env()` term here (M2 artifact, fixed as part of this build).
//
// M5 R2 item 1 — the mailbox-health failsafe banner sits ABOVE the nav
// rail/main row (not inside `main`), so it's the exact same persistent strip
// on every page, and no page/widget can suppress it. That moves `h-dvh` to
// this outer column wrapper; the row below it needs its own `min-h-0` (a
// bare `flex-1` on a flex child doesn't shrink below its content's natural
// height without it) so `main`'s `overflow-y-auto` still gets a real bounded
// height to scroll within — same invariant the comment above already
// established, just one flex level deeper now.
export function AppShell() {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);

  return (
    <div className="flex h-dvh flex-col bg-canvas text-ink">
      <ActivationBanner />
      <MailboxHealthBanner />
      <div className="flex min-h-0 flex-1">
        {isDesktop && <NavRail />}
        <main className={`min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8 ${isDesktop ? "" : "pb-[calc(5rem+env(safe-area-inset-bottom))]"}`}>
          <Outlet />
        </main>
        {!isDesktop && <BottomTabs />}
      </div>
    </div>
  );
}
