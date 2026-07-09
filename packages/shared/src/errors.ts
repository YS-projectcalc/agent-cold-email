// Shared error types. Kept tiny and dependency-free so both the platform
// worker and (later) the CLI/MCP surface can catch/branch on these classes.

export class ValidationError extends Error {
  constructor(message: string, public readonly issues?: unknown) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Thrown by every `real/` VendorPort implementation. ARCHITECTURE.md #6 and
 * #8: real vendor adapters are typed stubs coded against public docs but
 * never actually called — they exist so the swap sandbox->real is a
 * provable no-op later, and so a demo/free tenant is structurally unable to
 * reach a live vendor (the adapter factory only ever hands them `sandbox`).
 */
export class NotActivatedError extends Error {
  constructor(vendor: string, op: string) {
    super(
      `${vendor}.${op} is not activated — real vendor adapters are coded stubs only until ACTIVATION.md is executed by the owner.`,
    );
    this.name = "NotActivatedError";
  }
}

export class TenantIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantIsolationError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
