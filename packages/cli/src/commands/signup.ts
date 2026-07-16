import { request } from "../client.js";
import { emitClaudeCodeHint } from "../claude-code-hint.js";
import { flagString, type ParsedArgs } from "../flags.js";

export async function runSignup(args: ParsedArgs): Promise<void> {
  const brand = flagString(args.flags, "brand") ?? args.positional[0];
  const contactEmail = flagString(args.flags, "email") ?? args.positional[1];

  if (!brand || !contactEmail) {
    console.error("Usage: agent-cold-email signup --brand <name> --email <contact@email>");
    process.exitCode = 1;
    return;
  }

  const result = await request<{ tenantId: string; token: string }>("/signup", {
    method: "POST",
    body: { brand, contactEmail },
  });

  console.log(`Tenant created: ${result.tenantId}`);
  console.log(`Token (store this securely — shown once): ${result.token}`);
  console.log(`\nUse it in later commands:\n  export AGENT_COLD_EMAIL_TOKEN=${result.token}`);
  emitClaudeCodeHint();
}
