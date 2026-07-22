declare module "*.sql?raw" {
  const content: string;
  export default content;
}

// Source-text imports for the spend-armed env-coverage guard
// (spend-armed-env-coverage.test.ts parses env.ts/billing.ts as text).
declare module "*.ts?raw" {
  const content: string;
  export default content;
}
