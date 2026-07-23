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

// G1a — fixture SDN.CSV text (test/fixtures/ofac/*.csv), same `?raw` mechanism.
declare module "*.csv?raw" {
  const content: string;
  export default content;
}
