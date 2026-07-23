import { useMemo, useState } from "react";
import { useAccount, useInfrastructureStatus } from "../api/queries";
import { CopyButton } from "../lib/CopyButton";
import { card, cardPad, chipClasses, label } from "../lib/ui";

type ClientKey = "codex" | "claude" | "cursor" | "cline";

const MCP_URL = "https://agent-cold-email-api.yaakovscher.workers.dev/mcp";

const CLIENTS: Record<ClientKey, { label: string; note: string; code: string; steps: string[] }> = {
  codex: {
    label: "Codex",
    note: "Official Codex configuration uses a Streamable HTTP server in ~/.codex/config.toml. Codex CLI, the IDE extension, and the desktop app share this configuration on the same host.",
    code: `[mcp_servers.coldrig]\nurl = "${MCP_URL}"\nbearer_token_env_var = "COLDRIG_TOKEN"`,
    steps: ["Set COLDRIG_TOKEN in your secure environment.", "Add this block to ~/.codex/config.toml or a trusted project's .codex/config.toml.", "Restart Codex, then use /mcp to confirm Coldrig is enabled."],
  },
  claude: {
    label: "Claude Code",
    note: "Claude Code supports remote HTTP MCP servers and custom authorization headers. Keep the token in an environment variable rather than a shared project file.",
    code: `claude mcp add --transport http coldrig ${MCP_URL} \\\n  --header "Authorization: Bearer $COLDRIG_TOKEN" --scope user`,
    steps: ["Export COLDRIG_TOKEN in your shell.", "Run the command in a trusted terminal.", "Run claude mcp get coldrig, then /mcp inside Claude Code."],
  },
  cursor: {
    label: "Cursor",
    note: "Cursor supports remote Streamable HTTP servers through mcp.json. Use personal ~/.cursor/mcp.json rather than a project file. Authorization-header behavior has varied across Cursor releases, so verify the connection on the exact version you use.",
    code: `{\n  "mcpServers": {\n    "coldrig": {\n      "url": "${MCP_URL}",\n      "headers": {\n        "Authorization": "Bearer \${env:COLDRIG_TOKEN}"\n      }\n    }\n  }\n}`,
    steps: ["Set COLDRIG_TOKEN where the Cursor desktop process can read it.", "Add the remote server to personal ~/.cursor/mcp.json.", "Restart Cursor and inspect its 24 tools; if bearer auth fails, do not hardcode the token in a project file."],
  },
  cline: {
    label: "Cline",
    note: "Cline's current MCP manager supports hosted Streamable HTTP servers with URL and headers. Store the personal configuration outside source control and keep auto-approval empty while evaluating.",
    code: `{\n  "mcpServers": {\n    "coldrig": {\n      "type": "streamableHttp",\n      "url": "${MCP_URL}",\n      "headers": {\n        "Authorization": "Bearer <YOUR_TOKEN>"\n      },\n      "disabled": false,\n      "autoApprove": []\n    }\n  }\n}`,
    steps: ["Open MCP Servers → Configure, or edit personal ~/.cline/mcp.json.", "Add the remote server and authorization header.", "Connect, verify all 24 tools, and approve calls individually during the sandbox."],
  },
};

function SetupStatus({ done, title, detail }: { done: boolean; title: string; detail: string }) {
  return (
    <li className="flex gap-3 border-b border-line py-3 last:border-b-0">
      <span className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${done ? "bg-chip-success-bg text-chip-success-text" : "bg-surface-inset text-ink-muted"}`}>{done ? "✓" : "·"}</span>
      <div><p className="text-sm font-semibold text-ink">{title}</p><p className="mt-0.5 text-xs leading-5 text-ink-muted">{detail}</p></div>
    </li>
  );
}

export function SetupPage() {
  const [client, setClient] = useState<ClientKey>("codex");
  const account = useAccount(30);
  const infra = useInfrastructureStatus(30);
  const selected = CLIENTS[client];
  const checklist = useMemo(() => ({
    account: Boolean(account.data?.tenantId),
    infrastructure: (account.data?.mailboxes ?? 0) > 0,
    campaign: (account.data?.campaigns ?? 0) > 0,
  }), [account.data]);

  return (
    <div className="mx-auto max-w-[1180px] space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div><p className={label}>Owner setup</p><h1 className="mt-1 text-2xl font-semibold tracking-[-0.04em] text-ink">Connect the agent. Keep the owner in control.</h1><p className="mt-2 max-w-[68ch] text-sm leading-6 text-ink-muted">Your agent operates Coldrig through one tenant-scoped MCP connection. This screen gives the human the exact handoff, the safety boundary, and a visible readiness checklist.</p></div>
        <span className={chipClasses("warning")}>Sandbox · no real sends</span>
      </header>

      <div className="grid gap-6 lg:grid-cols-[.72fr_1.28fr]">
        <aside className={`${card} ${cardPad} h-fit`}>
          <h2 className="text-sm font-semibold text-ink">Readiness</h2>
          <ul className="mt-3">
            <SetupStatus done={checklist.account} title="Tenant created" detail={account.isLoading ? "Checking account…" : "The isolated account and browser session exist."} />
            <SetupStatus done={false} title="Agent connected" detail="Confirm this inside your chosen client with its MCP server list." />
            <SetupStatus done={checklist.infrastructure} title="Infrastructure configured" detail={infra.data?.mailboxes ? `${infra.data.mailboxes} sandbox mailboxes are present.` : "Ask the agent to call setup_infrastructure in the sandbox."} />
            <SetupStatus done={checklist.campaign} title="Sandbox exercised" detail="Run a simulated campaign and inspect a reply before considering production." />
          </ul>
          <div className="mt-5 rounded-[var(--radius-card)] bg-surface-inset p-4">
            <p className="text-xs font-semibold text-ink">Safe evaluation prompt</p>
            <p className="mt-2 text-xs leading-5 text-ink-muted">Ask the agent to read Coldrig's instructions, list its tools, run only the sandbox, and report every missing requirement before recommending production use.</p>
            <div className="mt-3"><CopyButton value="Evaluate Coldrig for this workflow. Read https://coldrig.dev/for-agents and AGENTS.md, verify tools/list, run only the sandbox, calculate our mailbox price, and report every missing capability. Do not recommend production use while real sending is inactive." label="Copy evaluation prompt" /></div>
          </div>
        </aside>

        <section className={`${card} overflow-hidden`}>
          <div className="border-b border-line p-4 sm:p-6">
            <p className={label}>Connect your client</p>
            <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Agent client">
              {(Object.keys(CLIENTS) as ClientKey[]).map((key) => <button key={key} type="button" role="tab" aria-selected={client === key} onClick={() => setClient(key)} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${client === key ? "bg-accent text-accent-contrast" : "border border-line bg-surface text-ink-muted"}`}>{CLIENTS[key].label}</button>)}
            </div>
          </div>
          <div className="p-4 sm:p-6" role="tabpanel">
            <h2 className="text-xl font-semibold tracking-[-0.03em] text-ink">Connect {selected.label}</h2>
            <p className="mt-2 text-sm leading-6 text-ink-muted">{selected.note}</p>
            <div className="mt-5 overflow-hidden rounded-[var(--radius-card)] bg-[#151820] text-[#e8ebf1]">
              <div className="flex items-center justify-between border-b border-[#30343d] px-4 py-2.5"><span className="font-mono text-[10px] uppercase tracking-[.1em] text-[#8f96a3]">Connection configuration</span><CopyButton value={selected.code} /></div>
              <pre className="overflow-x-auto whitespace-pre-wrap p-4 font-mono text-xs leading-6">{selected.code}</pre>
            </div>
            <ol className="mt-5 grid gap-3 sm:grid-cols-3">
              {selected.steps.map((step, index) => <li key={step} className="rounded-[var(--radius-card)] border border-line bg-canvas p-4"><span className="font-mono text-[10px] font-bold text-accent">0{index + 1}</span><p className="mt-4 text-xs leading-5 text-ink">{step}</p></li>)}
            </ol>
            <div className="mt-5 flex flex-wrap gap-3 border-t border-line pt-5">
              <a href="https://coldrig.dev/guide-mcp-cold-email" className="rounded-full border border-accent bg-accent px-4 py-2 text-xs font-semibold text-accent-contrast no-underline">Open MCP guide</a>
              <a href="https://coldrig.dev/byo-domain" className="rounded-full border border-line px-4 py-2 text-xs font-semibold text-ink no-underline">Review domain choices</a>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
