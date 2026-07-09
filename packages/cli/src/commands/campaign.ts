import { readFileSync } from "node:fs";
import { request, resolveToken } from "../client.js";
import { flagString, type ParsedArgs } from "../flags.js";

function usage(): void {
  console.error("Usage: agent-cold-email campaign launch --file <campaign.json>");
  console.error("       agent-cold-email campaign results <campaignId>");
  process.exitCode = 1;
}

export async function runCampaign(args: ParsedArgs): Promise<void> {
  const token = resolveToken(flagString(args.flags, "token"));
  const sub = args.positional[0];

  if (sub === "launch") {
    const file = flagString(args.flags, "file");
    if (!file) return usage();
    const body: unknown = JSON.parse(readFileSync(file, "utf8"));
    const result = await request("/campaigns", { method: "POST", token, body });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (sub === "results") {
    const id = args.positional[1];
    if (!id) return usage();
    const result = await request(`/campaigns/${id}/results`, { token });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  usage();
}
