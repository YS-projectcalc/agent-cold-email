import { request, resolveToken } from "../client.js";
import { flagString, type ParsedArgs } from "../flags.js";

export async function runPause(args: ParsedArgs): Promise<void> {
  const token = resolveToken(flagString(args.flags, "token"));

  if (args.flags.all) {
    console.log(JSON.stringify(await request("/campaigns/pause-all", { method: "POST", token }), null, 2));
    return;
  }

  const id = args.positional[0];
  if (!id) {
    console.error("Usage: agent-cold-email pause <campaignId>");
    console.error("       agent-cold-email pause --all");
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(await request(`/campaigns/${id}/pause`, { method: "POST", token }), null, 2));
}
