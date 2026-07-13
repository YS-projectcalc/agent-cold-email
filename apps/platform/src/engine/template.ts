// SPEC.md §19.4 [NEW-3] root cause (backend gaps brief item 5): sequence
// steps (campaigns.sequence_json) are AUTHORED as templates with
// `{{firstName}}`/`{{company}}` placeholders (see engine/demo.ts's
// DEMO_SEQUENCE, launch_campaign's SequenceStepInput), but nothing in the
// send path ever substituted them against the lead's own fields — every
// real send (and the 'sent' event's own recorded metadata) carried the
// literal, unrendered template. This is the single rendering step every
// send-time call site (engine/tick.ts) uses so the vendor send, the event
// it records, and every reader of that event (thread detail, inbox v2)
// agree on the SAME rendered value.

export interface TemplateVars {
  firstName: string;
  company: string;
}

const TOKEN_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Substitutes `{{firstName}}`/`{{company}}` against a lead's own field
 * values. An unknown `{{token}}` is left VERBATIM (never silently dropped),
 * so a template typo is visible in the sent output instead of vanishing.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(TOKEN_PATTERN, (match, key: string) => {
    if (key === "firstName") return vars.firstName;
    if (key === "company") return vars.company;
    return match;
  });
}
