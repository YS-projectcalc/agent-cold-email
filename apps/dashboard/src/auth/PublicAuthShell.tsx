import type { ReactNode } from "react";
import { BRAND_NAME } from "../lib/brand";
import { LogoMark } from "../lib/LogoMark";
import { card, cardPad } from "../lib/ui";

export function PublicAuthShell({
  eyebrow,
  title,
  description,
  children,
  wide = false,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-canvas px-4 py-10">
      <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(circle_at_68%_22%,rgba(46,92,255,.13),transparent_34%),linear-gradient(rgba(217,218,211,.45)_1px,transparent_1px),linear-gradient(90deg,rgba(217,218,211,.45)_1px,transparent_1px)] bg-[size:auto,40px_40px,40px_40px] [mask-image:radial-gradient(ellipse_at_center,black,transparent_78%)]" />
      <div className={`${card} ${cardPad} relative w-full ${wide ? "max-w-[760px]" : "max-w-[440px]"} border-line bg-surface shadow-[0_28px_80px_rgba(23,27,37,.12)]`}>
        <a href="https://coldrig.dev/" className="mb-7 flex w-fit items-center gap-3 no-underline">
          <LogoMark className="h-9 w-9" />
          <span className="font-semibold tracking-[-0.03em] text-ink">{BRAND_NAME}</span>
        </a>
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[.14em] text-accent">{eyebrow}</p>
        <h1 className="mb-2 text-2xl font-semibold tracking-[-0.04em] text-ink">{title}</h1>
        <p className="mb-6 max-w-[64ch] text-sm leading-6 text-ink-muted">{description}</p>
        {children}
      </div>
    </div>
  );
}
