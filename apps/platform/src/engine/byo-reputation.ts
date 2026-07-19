// SPEC.md §20.5 — the intake reputation ladder the warmup machine consumes.
// PURE — no I/O; the caller supplies already-gathered signals (age, blocklist
// hit, DMARC enforcement, active-sending evidence) exactly like
// deliverability.ts's `evaluate`. Primary-axis-first: the isPrimary/blocklist
// gates are checked BEFORE the non-primary composite signal is even consulted.

export type ReputationBranch = "primary_standard" | "established_good" | "unknown_fresh" | "blocklisted_reject";

export interface ReputationSignal {
  isPrimary: boolean;
  /** Domain age in days, or null if unknown/unavailable. */
  ageDays: number | null;
  /** Hit on a public blocklist (Spamhaus DBL/SURBL-class) at intake. */
  blocklisted: boolean;
  /** DMARC policy already in enforcement (p=quarantine/p=reject) at intake — the §20.1 scan's own dmarcPolicy field. */
  dmarcEnforced: boolean;
  /**
   * Positive evidence of an ACTIVE MX in real use (DMARC aggregate-report
   * volume, or an equivalent actual-send-volume signal) -- NOT merely a
   * resolvable/long-resolving MX record. Passive-DNS history alone can never
   * satisfy this (it only proves an MX record existed, never that mail moved
   * through it) -- see the ReputationPort doc comment in vendor-ports.ts.
   */
  activeSendingEvidence: boolean;
}

export interface ReputationVerdict {
  branch: ReputationBranch;
  reason: string;
}

const ESTABLISHED_GOOD_MIN_AGE_DAYS = 730; // 2 years

export function computeReputationBranch(input: ReputationSignal): ReputationVerdict {
  // Blocklisted rejects at intake for BOTH primary and non-primary -- this is
  // the deliverability lane (not the abuse/KYC gate, §20.3), checked first
  // regardless of the primary axis.
  if (input.blocklisted) {
    return { branch: "blocklisted_reject", reason: "domain hit a public blocklist at intake -- not viable to send from yet" };
  }

  // Primary-axis-first (SPEC.md §20.5): a primary domain never branches into
  // established_good/unknown_fresh, regardless of how good its signals are --
  // more existing reputation at stake is more to protect, not a license to
  // move faster (§20.2's "no schedule compression" restated on the ramp-length axis).
  if (input.isPrimary) {
    return { branch: "primary_standard", reason: "primary domain -- full standard ramp regardless of reputation signal" };
  }

  const establishedGood =
    input.ageDays !== null && input.ageDays >= ESTABLISHED_GOOD_MIN_AGE_DAYS && input.dmarcEnforced && input.activeSendingEvidence;

  if (establishedGood) {
    return {
      branch: "established_good",
      reason: `age ${input.ageDays}d >= ${ESTABLISHED_GOOD_MIN_AGE_DAYS}d, DMARC enforced, active-sending evidence present -- qualifies for the shortened ramp`,
    };
  }

  return {
    branch: "unknown_fresh",
    reason:
      input.ageDays !== null && input.ageDays >= ESTABLISHED_GOOD_MIN_AGE_DAYS && !input.activeSendingEvidence
        ? "domain is aged and clean but has no active-sending evidence -- age+cleanliness alone doesn't earn the shortcut"
        : "no disqualifying signal but no established track record either -- standard 28-day ramp",
  };
}
