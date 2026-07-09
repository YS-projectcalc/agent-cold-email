import { request, resolveToken } from "../client.js";
import { flagString, type ParsedArgs } from "../flags.js";

export async function runAccount(args: ParsedArgs): Promise<void> {
  const token = resolveToken(flagString(args.flags, "token"));
  console.log(JSON.stringify(await request("/account", { token }), null, 2));
}
