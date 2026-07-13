// Small inline stroke icons (20x20, currentColor) — no icon font/CDN per
// SPEC.md §19.1 ("system font stack, no external CDN/fonts"). Shared by the
// nav rail and bottom tab bar.
import type { SVGProps } from "react";

function Icon(props: SVGProps<SVGSVGElement>) {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props} />;
}

export function DashboardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="2.5" width="6.5" height="6.5" rx="1.2" />
      <rect x="11" y="2.5" width="6.5" height="4" rx="1.2" />
      <rect x="11" y="8.5" width="6.5" height="9" rx="1.2" />
      <rect x="2.5" y="11" width="6.5" height="6.5" rx="1.2" />
    </Icon>
  );
}

export function InboxIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M2.5 8.5h4l1.5 2.5h4l1.5-2.5h4" />
      <rect x="2.5" y="8.5" width="15" height="8.5" rx="1.4" />
      <path d="M4.5 8.5 6.5 3h7l2 5.5" />
    </Icon>
  );
}

export function SettingsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.7v2.1M10 15.2v2.1M17.3 10h-2.1M4.8 10H2.7M15.1 4.9l-1.5 1.5M6.4 13.6l-1.5 1.5M15.1 15.1l-1.5-1.5M6.4 6.4 4.9 4.9" />
    </Icon>
  );
}

export function LogoutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M8 3H4.5A1.5 1.5 0 0 0 3 4.5v11A1.5 1.5 0 0 0 4.5 17H8" />
      <path d="M13 6.5 17 10l-4 3.5" />
      <path d="M17 10H7.5" />
    </Icon>
  );
}
