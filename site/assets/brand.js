// Single swappable brand constant. SPEC.md §0.3 defers the final display
// brand (candidates: coldrig / coldpipe / coldloop) to activation — until
// then, every page shows the permanent keyword handle here instead of a
// name that would need to be hunted down and replaced across every page.
//
// TO REBRAND AT ACTIVATION: change BRAND_NAME below. That is the only edit
// needed — every `[data-brand]` element across the site reads from here.
// The keyword-permanent identity (`agent-cold-email`, used for repo/npm/
// MCP registry) is separate and does NOT change at activation; see
// SPEC.md §0.3 and ROADMAP.md C0.
const BRAND_NAME = "agent-cold-email";

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-brand]").forEach((el) => {
    el.textContent = BRAND_NAME;
  });
  document.title = document.title.replace("{{BRAND}}", BRAND_NAME);
});
