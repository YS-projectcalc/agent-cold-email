// Turnstile site key (design docs/research/human-signup-magic-link-design-
// 2026-07-22.md §2.3) — PUBLIC by design (it embeds in client HTML for the
// widget to render), so a plain source constant rather than a fetched
// config value. `null` until ACTIVATION.md provisions a real widget (the
// turnstile-spin skill) and this constant is updated — TurnstileWidget.tsx
// renders nothing while it stays null, matching the server-side
// TURNSTILE_SECRET's own dark-by-default posture.
export const TURNSTILE_SITE_KEY: string | null = null;
