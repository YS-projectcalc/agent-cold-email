import { useEffect, useRef } from "react";

// Cloudflare Turnstile client widget (design docs/research/human-signup-
// magic-link-design-2026-07-22.md §2.3) — `/login` request form ONLY. Dark
// by construction: with `siteKey` null (no real widget provisioned yet, see
// lib/turnstile.ts), this renders nothing and never touches the network —
// it loads the official Cloudflare script only once a real site key exists.

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: { sitekey: string; callback: (token: string) => void }) => string;
      remove: (widgetId: string) => void;
    };
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
let scriptLoadPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!scriptLoadPromise) {
    scriptLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("failed to load the Turnstile script"));
      document.head.appendChild(script);
    });
  }
  return scriptLoadPromise;
}

export function TurnstileWidget({ siteKey, onVerify }: { siteKey: string | null; onVerify: (token: string) => void }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!siteKey) return;
    let cancelled = false;
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        widgetIdRef.current = window.turnstile.render(containerRef.current, { sitekey: siteKey, callback: onVerify });
      })
      .catch((err: unknown) => console.error(err));
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) window.turnstile.remove(widgetIdRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  if (!siteKey) return null;
  return <div ref={containerRef} className="cf-turnstile" />;
}
