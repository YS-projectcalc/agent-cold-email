import { describe, expect, it } from "vitest";
import { NEXT_STEP_REASONS, NEXT_STEP_TOOLS } from "@coldstart/shared";
import { MCP_TOOLS } from "../src/mcp/tools.js";
import { TENANT_MESSAGE_SEVERITIES } from "../src/engine/tenant-messages.js";
import openapiYaml from "../../../site/openapi.yaml?raw";

// I9 — the docs<->behaviour lockstep guards (design §2.6). The claim-guard
// idiom (site-claim-surface-scope.test.ts) catches REINTRODUCED prose; it
// does not catch behaviour that OUTGREW its prose — the vendor-truth wave
// had to hand-edit four descriptions to add `operator_pending`, and nothing
// would have caught a miss. These guards are driven by the RUNTIME arrays,
// so a new member reddens them before it can ship undocumented.

function toolDescription(name: string): string {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no MCP tool named ${name}`);
  return tool.description;
}

describe("G1 — severity vocabulary lockstep", () => {
  it("every MCP_TOOLS description that mentions ANY severity mentions ALL of them", () => {
    const offenders: string[] = [];
    for (const tool of MCP_TOOLS) {
      const mentionsAny = TENANT_MESSAGE_SEVERITIES.some((s) => tool.description.includes(`'${s}'`));
      if (!mentionsAny) continue;
      const missing = TENANT_MESSAGE_SEVERITIES.filter((s) => !tool.description.includes(`'${s}'`));
      if (missing.length > 0) offenders.push(`${tool.name}: missing ${missing.join(", ")}`);
    }
    expect(offenders).toEqual([]);
    // The scan itself must actually fire on something, or this is a no-op guard.
    expect(MCP_TOOLS.some((t) => TENANT_MESSAGE_SEVERITIES.some((s) => t.description.includes(`'${s}'`)))).toBe(true);
  });

  it("openapi.yaml's Message.severity enum equals TENANT_MESSAGE_SEVERITIES exactly", () => {
    const match = /Message:[\s\S]*?severity:\s*\n\s*type: string\s*\n\s*enum: \[([^\]]+)\]/.exec(openapiYaml);
    expect(match, "could not find the Message.severity enum in openapi.yaml").not.toBeNull();
    const declared = match![1]!.split(",").map((s) => s.trim());
    expect(declared).toEqual([...TENANT_MESSAGE_SEVERITIES]);
  });
});

describe("G2 — next-step reason vocabulary lockstep", () => {
  it("openapi.yaml's NextStepReason enum equals NEXT_STEP_REASONS exactly", () => {
    const match = /NextStepReason:[\s\S]*?enum: \[([^\]]+)\]/.exec(openapiYaml);
    expect(match, "could not find a NextStepReason enum in openapi.yaml").not.toBeNull();
    const declared = match![1]!.split(",").map((s) => s.trim());
    expect(declared).toEqual([...NEXT_STEP_REASONS]);
  });

  it("infrastructure_status and setup_infrastructure both say the response carries nextSteps", () => {
    expect(toolDescription("infrastructure_status")).toMatch(/nextSteps/);
    expect(toolDescription("setup_infrastructure")).toMatch(/nextSteps/);
  });
});

describe("G3 — every NextStepAction.tool value is a REAL MCP tool name", () => {
  it("every NextStepTool member is in MCP_TOOLS", () => {
    // ITERATES THE RUNTIME ARRAY, never a hand-copied literal (non-blocking 5,
    // build gate 2026-08-19). The literal version was green-by-construction for
    // ADDITIONS — a sixth union member emitted in a step was never checked,
    // which is precisely the direction this guard exists for. `NextStepTool` is
    // now derived FROM this array, so the two cannot disagree.
    const realNames = new Set(MCP_TOOLS.map((t) => t.name));
    const missing = NEXT_STEP_TOOLS.filter((t) => !realNames.has(t));
    expect(missing).toEqual([]);
    // Non-vacuous: the scan must actually be looking at something.
    expect(NEXT_STEP_TOOLS.length).toBeGreaterThan(0);
  });
});

describe("G4 — slot-semantics claims (the B2 quartet, ticket sup_71e8b4d1)", () => {
  const infraStatus = () => toolDescription("infrastructure_status");
  const setupInfra = () => toolDescription("setup_infrastructure");

  it("claim 1 — vendor-pool warmup is feed-invisible by design", () => {
    expect(infraStatus()).toMatch(/feed-invisible/i);
  });

  it("claim 2 — sendReady is a fully-ramped flag, NOT a send gate", () => {
    expect(infraStatus()).toMatch(/not a send gate/i);
  });

  it("claim 3 — ramp caps permit CAPPED sending from day 1 (not zero until fully warmed)", () => {
    expect(infraStatus()).toMatch(/capped sending/i);
  });

  it("claim 4 — top-level sendReady is the AND across mailboxes; the per-mailbox flag is the one that matters", () => {
    expect(infraStatus()).toMatch(/AND across (all )?mailboxes/i);
  });

  it("setup_infrastructure teaches slot/ordinal semantics: a repeat call at the same domains provisions nothing new", () => {
    expect(setupInfra()).toMatch(/ordinal/i);
  });

  it("setup_infrastructure teaches persona determinism (address = persona+ordinal+slot)", () => {
    expect(setupInfra()).toMatch(/persona/i);
    expect(setupInfra()).toMatch(/deterministic|determinism/i);
  });
});
