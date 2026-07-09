import { request, resolveToken } from "../client.js";
import { flagString, type ParsedArgs } from "../flags.js";

function usage(): void {
  console.error("Usage: agent-cold-email inbox");
  console.error("       agent-cold-email inbox thread <threadId>");
  console.error("       agent-cold-email inbox reply <threadId> <body>");
  console.error("       agent-cold-email inbox mark <threadId> <read|unread|archived>");
  process.exitCode = 1;
}

export async function runInbox(args: ParsedArgs): Promise<void> {
  const token = resolveToken(flagString(args.flags, "token"));
  const sub = args.positional[0];

  if (sub === "thread") {
    const id = args.positional[1];
    if (!id) return usage();
    console.log(JSON.stringify(await request(`/threads/${id}`, { token }), null, 2));
    return;
  }

  if (sub === "reply") {
    const id = args.positional[1];
    const body = args.positional[2];
    if (!id || !body) return usage();
    console.log(JSON.stringify(await request(`/threads/${id}/reply`, { method: "POST", token, body: { body } }), null, 2));
    return;
  }

  if (sub === "mark") {
    const id = args.positional[1];
    const status = args.positional[2];
    if (!id || !status) return usage();
    console.log(JSON.stringify(await request(`/threads/${id}/mark`, { method: "POST", token, body: { status } }), null, 2));
    return;
  }

  if (sub !== undefined) return usage();

  console.log(JSON.stringify(await request("/inbox", { token }), null, 2));
}
