// SPEC.md §20.4 — primary-domain consent mechanics. Primary-domain sending
// requires a separate, unbundled acknowledgment screen (never a checkbox
// buried in general ToS acceptance). The system logs, alongside the
// acknowledgment: the domain, a timestamp, and the pre-flight live-infra-scan
// result — so there is a record of exactly what risk was disclosed against
// what was actually found on the domain at consent time. The waiver does NOT
// remove the business's exposure; it documents informed consent only.

import { ValidationError } from "@coldstart/shared";

export interface ConsentRecord {
  domain: string;
  acknowledgedAt: number;
  /** The pre-flight scan result snapshot at the moment of acknowledgment (opaque — whatever byo-preflight.ts produced). */
  scanSnapshot: unknown;
}

export function buildConsentRecord(domain: string, nowMs: number, scanSnapshot: unknown): ConsentRecord {
  return { domain, acknowledgedAt: nowMs, scanSnapshot };
}

/**
 * Primary-domain sending requires an EXPLICIT acknowledgment — not an implied
 * or defaulted one. Throws ValidationError (routes/tenant-do map this to HTTP
 * 400) on anything short of a literal `true`.
 */
export function validateConsentAcknowledgment(input: { acknowledged: boolean }): void {
  if (input.acknowledged !== true) {
    throw new ValidationError(
      "primary-domain sending requires an explicit risk acknowledgment (acknowledged: true) — see SPEC.md §20.4. This waiver does not remove your business's exposure; it documents informed consent, not a substitute for the technical safeguards.",
    );
  }
}
