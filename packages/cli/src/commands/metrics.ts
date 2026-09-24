import { request, resolveToken } from "../client.js";
import { flagString, type ParsedArgs } from "../flags.js";

export async function runMetrics(args: ParsedArgs): Promise<void> {
  const token = resolveToken(flagString(args.flags, "token"));
  console.log(JSON.stringify(await request("/metrics", { token }), null, 2));
}
