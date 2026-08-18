/**
 * Shared helper for the SOURCE TRIPWIRE tests — the guards that scan the tree's
 * own text for a literal that must not exist (a vendor's name in a customer
 * surface, a notification claim nothing can cite).
 *
 * It lives in a plain module rather than in one of those test files because
 * importing a `.test.ts` to borrow a function re-runs every suite inside it.
 */

/**
 * Source text with comments removed. Comments naming the thing are FINE and
 * valuable — they explain the rule. What must not exist is emittable text: a
 * string literal that can reach a customer. Stripping comments is what keeps a
 * tripwire from crying wolf, and a guard that cries wolf gets silenced.
 */
export function strippedSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?:^|\s)\/\/[^\n]*/g, "")
    // `--` line comments inside the embedded SQL schema (schema.ts is one big
    // template literal), which document the integration exactly as TS comments do.
    .replace(/^[ \t]*--.*$/gm, "");
}
