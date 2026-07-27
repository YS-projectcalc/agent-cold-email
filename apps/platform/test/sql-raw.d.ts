declare module "*.sql?raw" {
  const content: string;
  export default content;
}

// Source-text imports for the failing-by-construction guards
// (spend-armed-env-coverage.test.ts parses env.ts/billing.ts as text;
//  brand-copy-guard.test.ts scans customer-visible sources as text).
declare module "*.ts?raw" {
  const content: string;
  export default content;
}
declare module "*.tsx?raw" {
  const content: string;
  export default content;
}

// G1a — fixture SDN.CSV text (test/fixtures/ofac/*.csv), same `?raw` mechanism.
declare module "*.csv?raw" {
  const content: string;
  export default content;
}

// Claim-surface tool-count guard (site-tool-count-claims.test.ts) — scans
// public-facing pages/manifests as raw text for stale MCP tool-count claims.
declare module "*.html?raw" {
  const content: string;
  export default content;
}
declare module "*.json?raw" {
  const content: string;
  export default content;
}
declare module "*.svg?raw" {
  const content: string;
  export default content;
}
declare module "*.yaml?raw" {
  const content: string;
  export default content;
}
declare module "*.txt?raw" {
  const content: string;
  export default content;
}
declare module "*.md?raw" {
  const content: string;
  export default content;
}
