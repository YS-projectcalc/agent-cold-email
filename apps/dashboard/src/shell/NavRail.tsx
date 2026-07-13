import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { DashboardIcon, InboxIcon, LogoutIcon, SettingsIcon } from "../lib/icons";
import { BRAND_NAME } from "../lib/brand";

const linkBase = "flex flex-col items-center gap-1 rounded-[var(--radius-card)] px-2 py-2.5 text-[11px] font-medium text-ink-muted hover:bg-surface hover:text-ink";
const linkActive = "bg-surface text-accent";

export function NavRail() {
  const { logout } = useAuth();

  return (
    <nav aria-label="Primary" className="flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-line bg-canvas py-4">
      <div className="mb-3 font-mono text-[10px] font-bold text-ink-muted" title={BRAND_NAME}>
        {BRAND_NAME.slice(0, 2).toUpperCase()}
      </div>
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
      <button type="button" onClick={() => void logout()} className={`${linkBase} mt-auto`}>
        <LogoutIcon />
        Log out
      </button>
    </nav>
  );
}
