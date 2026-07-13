import { NavLink } from "react-router-dom";
import { DashboardIcon, InboxIcon, SettingsIcon } from "../lib/icons";

const linkBase = "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-ink-muted";
const linkActive = "text-accent";

export function BottomTabs() {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-10 flex border-t border-line bg-canvas pb-[env(safe-area-inset-bottom)]"
    >
      <NavLink to="dashboard" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : ""}`}>
        <DashboardIcon />
        Dashboard
      </NavLink>
      <NavLink to="inbox" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : ""}`}>
        <InboxIcon />
        Inbox
      </NavLink>
      <NavLink to="settings" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : ""}`}>
        <SettingsIcon />
        Settings
      </NavLink>
    </nav>
  );
}
