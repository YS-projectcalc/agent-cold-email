import { ValidationError } from "@coldstart/shared";

// Lookalike third-party-brand guardrail (ARCHITECTURE.md #8, SPEC.md §8,
// README/AGENTS "scoped to your own brand only"). setup_infrastructure buys
// lookalike domains DERIVED FROM the tenant's stated brand/primaryDomain
// (vendors/sandbox/domain-port.ts slugs the primaryDomain), so if the
// primaryDomain or brand names a third party the platform would provision
// impersonation infrastructure. This is the "enforced in code" validator the
// docs advertise: two hard gates, both at the setup_infrastructure boundary,
// before any searchLookalikes/buy.
//
// TEST-MODE SCOPE: real cryptographic domain-ownership verification (DNS TXT /
// registrar proof) is an activation step (ACTIVATION.md). Until then the guard
// is (a) a well-known-brand denylist and (b) a brand<->primaryDomain
// consistency check, so the lookalikes provably derive from the tenant's OWN
// asserted identity rather than an arbitrary third party.

// Well-known third-party brands a tenant must not provision lookalikes for
// unless it is that brand (which, in test mode, it cannot prove — hence a hard
// reject). Matched as whole slug tokens, never substrings, to avoid false
// positives (e.g. "metadata" != "meta"). Not exhaustive by design — the
// consistency gate below catches impersonation of brands not on this list.
// Exported: SPEC.md §20.3's BYO abuse gate (engine/byo-abuse-gate.ts) extends
// this SAME denylist to a BYO domain itself, rather than duplicating it
// (CLAUDE.md rule c).
export const DENYLISTED_BRANDS = new Set<string>([
  "google", "gmail", "youtube", "android",
  "microsoft", "outlook", "office", "azure", "windows", "xbox", "linkedin", "github",
  "apple", "icloud", "itunes",
  "amazon", "aws", "twitch",
  "meta", "facebook", "instagram", "whatsapp", "messenger", "threads",
  "paypal", "venmo",
  "stripe", "square",
  "netflix", "spotify", "disney", "hulu",
  "openai", "chatgpt", "anthropic", "claude",
  "twitter", "tiktok", "snapchat", "pinterest", "reddit", "discord", "slack", "zoom", "dropbox",
  "uber", "lyft", "airbnb", "doordash", "instacart",
  "salesforce", "oracle", "ibm", "adobe", "shopify", "atlassian", "cloudflare",
  "coinbase", "binance", "kraken", "robinhood",
  "chase", "wellsfargo", "bankofamerica", "citibank", "capitalone", "americanexpress", "amex",
  "visa", "mastercard", "discover",
  "walmart", "target", "costco", "ebay", "etsy", "alibaba", "aliexpress",
  "fedex", "ups", "usps", "dhl",
  "irs", "usbank",
]);

// Common company-name suffix tokens dropped before comparing a brand to its
// domain, so "Acme Rockets Inc" ~ "acmerockets.com".
const COMPANY_SUFFIX_TOKENS = new Set<string>([
  "co", "inc", "llc", "ltd", "corp", "corporation", "company", "group", "holdings", "labs", "io", "app", "hq",
]);

/** Alphanumeric tokens of a free-text brand string, lowercased. */
function brandTokens(brand: string): string[] {
  return brand
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The registrable-ish root label of a domain: first label, lowercased alnum. */
function domainRootLabel(primaryDomain: string): string {
  const host = primaryDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
  const firstLabel = host.split("/")[0]?.split(".")[0] ?? "";
  return firstLabel.replace(/[^a-z0-9]/g, "");
}

/** A brand's tokens collapsed to a single slug, with company suffixes removed. */
function brandSlug(brand: string): string {
  return brandTokens(brand)
    .filter((t) => !COMPANY_SUFFIX_TOKENS.has(t))
    .join("");
}

/**
 * Hard-reject when setup_infrastructure would provision lookalikes for a
 * third-party brand or a domain the tenant's own brand does not correspond to.
 * Throws ValidationError (Worker maps to HTTP 400).
 */
export function assertBrandOwnership(input: { brand: string; primaryDomain: string }): void {
  const tokens = brandTokens(input.brand);
  const domainRoot = domainRootLabel(input.primaryDomain);
  const domainTokens = input.primaryDomain
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  // Gate (a): well-known-brand denylist — reject if any brand token OR any
  // domain label is a denylisted third-party brand.
  for (const token of [...tokens, ...domainTokens]) {
    if (DENYLISTED_BRANDS.has(token)) {
      throw new ValidationError(
        `setup_infrastructure rejected: "${token}" is a well-known third-party brand. Lookalike domains may only be provisioned for your OWN brand and a primary domain you control — this platform is not a phishing/impersonation tool (see SPEC.md §8).`,
      );
    }
  }

  // Gate (b): brand<->primaryDomain consistency. The lookalikes are derived
  // from the primaryDomain, so it must correspond to the tenant's stated
  // brand (one is a substring of the other after normalization). This blocks
  // provisioning lookalikes of a domain unrelated to the asserted brand.
  const slug = brandSlug(input.brand);
  if (!slug || !domainRoot) {
    throw new ValidationError(
      "setup_infrastructure rejected: brand and primaryDomain are required and must contain alphanumeric characters.",
    );
  }
  const consistent = domainRoot.includes(slug) || slug.includes(domainRoot);
  if (!consistent) {
    throw new ValidationError(
      `setup_infrastructure rejected: primaryDomain "${input.primaryDomain}" does not correspond to brand "${input.brand}". Lookalike domains must derive from your OWN brand and a domain you control; asserting ownership of an unrelated domain is an activation-gated verification step (ACTIVATION.md).`,
    );
  }
}
