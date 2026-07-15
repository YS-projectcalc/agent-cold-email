export function LogoMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" role="img" aria-label="Coldrig">
      <rect width="64" height="64" rx="17" fill="#2E5CFF" />
      <path d="M14 48h36" stroke="#1839AF" strokeWidth="4" strokeLinecap="round" opacity=".55" />
      <rect x="16" y="31" width="7" height="17" rx="3.5" fill="#fff" />
      <rect x="28.5" y="23" width="7" height="25" rx="3.5" fill="#fff" />
      <rect x="41" y="14" width="7" height="34" rx="3.5" fill="#fff" />
      <circle cx="47.5" cy="13.5" r="5.5" fill="#FF6B35" stroke="#F7F7F2" strokeWidth="3" />
    </svg>
  );
}
