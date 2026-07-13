// Mirrors site/assets/brand.js's single swappable brand constant (SPEC.md
// §0.3 defers the final display brand to activation) — kept in sync by
// hand since apps/dashboard is a separate static bundle from site/ and out
// of this build's scope to import from directly. Change ONLY here to
// rebrand the dashboard SPA at activation.
export const BRAND_NAME = "agent-cold-email";
