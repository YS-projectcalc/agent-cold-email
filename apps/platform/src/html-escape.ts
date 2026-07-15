// The single HTML-escaper for Worker-rendered HTML (the unsubscribe confirm
// page, ops/dunning email bodies). One implementation, per CLAUDE.md rule c —
// escapes the five XML/HTML metacharacters incl. the apostrophe, so a value
// interpolated into either an attribute or element text is safe.
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
