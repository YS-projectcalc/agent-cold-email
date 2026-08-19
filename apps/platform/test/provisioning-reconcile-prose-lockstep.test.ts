import { describe, expect, it } from "vitest";
import { provisioningReconcileArmed } from "../src/admin/ops-sweep.js";
import { MCP_TOOLS } from "../src/mcp/tools.js";
import openapiYaml from "../../../site/openapi.yaml?raw";

// I10 — G6, the flag<->prose lockstep guard (design §7.7). `evaluateHealthChecks`
// / `runProvisioningReconcile` is a REAL background provisioning retry, dark
// only behind `PROVISIONING_RECONCILE_ENABLED` — an env flip, not a code
// change. The doc surfaces (mcp/tools.ts, site/openapi.yaml) make the
// UNCONDITIONAL claim "there is no background retry". G1-G5 are vocabulary
// guards and none of them binds THIS claim to the flag it depends on — this
// is the most instructive finding in the set (§2.6: "it does not catch
// behaviour that outgrew its prose").
//
// Asserts the documented default is dark AND the prose is present, in the
// SAME test — flipping the default (without also changing the prose) reddens
// this test, forcing both to change in the same commit.

function toolDescription(name: string): string {
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no MCP tool named ${name}`);
  return tool.description;
}

describe("G6 — provisioningReconcileArmed default vs the 'no background retry' claim", () => {
  it("the documented default (no PROVISIONING_RECONCILE_ENABLED set) is DARK", () => {
    expect(provisioningReconcileArmed({})).toBe(false);
  });

  it("also dark for every OFF-reading value the function documents", () => {
    for (const off of ["", "0", "false", "off", "FALSE", "Off"]) {
      expect(provisioningReconcileArmed({ PROVISIONING_RECONCILE_ENABLED: off })).toBe(false);
    }
  });

  it("armed for a genuinely-affirmative value — the guard is not vacuously true", () => {
    expect(provisioningReconcileArmed({ PROVISIONING_RECONCILE_ENABLED: "1" })).toBe(true);
  });

  it("setup_infrastructure's tool description carries the unconditional 'no background retry' claim", () => {
    expect(toolDescription("setup_infrastructure")).toMatch(/no background retry/i);
  });

  it("site/openapi.yaml's /setup-infrastructure description carries the unconditional claim", () => {
    // The raw YAML source line-wraps a folded (`>`) scalar — tolerate
    // whitespace/newlines between words rather than pinning one raw line.
    expect(openapiYaml).toMatch(/no\s+autonomous\s+background\s+retry/i);
  });
});
