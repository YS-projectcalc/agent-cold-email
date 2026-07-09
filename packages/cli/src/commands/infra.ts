import { request, resolveToken } from "../client.js";
import { flagNumber, flagString, type ParsedArgs } from "../flags.js";

export async function runSetup(args: ParsedArgs): Promise<void> {
  const token = resolveToken(flagString(args.flags, "token"));
  const brand = flagString(args.flags, "brand") ?? "Sample Brand";

  const body = {
    brand,
    primaryDomain: flagString(args.flags, "primary-domain") ?? "sample-brand.com",
    domains: flagNumber(args.flags, "domains", 2),
    inboxesEach: flagNumber(args.flags, "inboxes-each", 2),
    persona: flagString(args.flags, "persona") ?? "Sales",
    physicalAddress: flagString(args.flags, "physical-address") ?? "123 Main St, Springfield, USA",
    senderIdentity: flagString(args.flags, "sender-identity") ?? `Sales <sales@${brand.toLowerCase().replace(/\s+/g, "-")}.com>`,
  };

  const result = await request("/setup-infrastructure", { method: "POST", token, body });
  console.log(JSON.stringify(result, null, 2));
}

export async function runStatus(args: ParsedArgs): Promise<void> {
  const token = resolveToken(flagString(args.flags, "token"));
  const result = await request("/infrastructure-status", { token });
  console.log(JSON.stringify(result, null, 2));
}
