import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { DashboardIcon, InboxIcon, LogoutIcon, SettingsIcon } from "../lib/icons";
import { BRAND_NAME } from "../lib/brand";
import { LogoMark } from "../lib/LogoMark";

const linkBase = "flex w-[58px] flex-col items-center gap-1.5 rounded-[var(--radius-card)] px-2 py-2.5 text-[10px] font-semibold text-ink-muted transition hover:bg-surface-inset hover:text-ink";
const linkActive = "bg-[#e9edff] text-accent";

export function NavRail() {
  const { logout } = useAuth();

  return (
    <nav aria-label="Primary" className="flex w-[84px] shrink-0 flex-col items-center gap-1 border-r border-line bg-surface py-4">
      <div className="mb-4" title={BRAND_NAME}><LogoMark className="h-9 w-9" /></div>
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
