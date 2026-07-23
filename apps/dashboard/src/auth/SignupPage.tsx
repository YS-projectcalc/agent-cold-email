import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSignup } from "../api/queries";
import { useAuth } from "./AuthProvider";
import { CopyButton } from "../lib/CopyButton";
import { PublicAuthShell } from "./PublicAuthShell";

export function SignupPage() {
  const signup = useSignup();
  const { login, loginPending } = useAuth();
  const navigate = useNavigate();
  const [brand, setBrand] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [saved, setSaved] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    signup.mutate({ brand: brand.trim(), contactEmail: contactEmail.trim() });
  }

  async function openControlRoom() {
    if (!signup.data || !saved) return;
    setOpenError(null);
    const result = await login(signup.data.token);
    if (!result.ok) {
      setOpenError(result.message);
      return;
    }
    navigate("/setup", { replace: true });
  }

  if (signup.data) {
    return (
      <PublicAuthShell
        eyebrow="Sandbox created"
        title="Save your tenant token now."
        description="This is the only time Coldrig displays the full token. It controls your isolated tenant, so treat it like a password and never paste it into a public repository or prompt."
        wide
      >
        <div className="rounded-[var(--radius-card)] border border-line bg-[#151820] p-4 text-white">
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-[.12em] text-[#9fa6b3]">Tenant token</span>
            <CopyButton value={signup.data.token} label="Copy token" />
          </div>
          <code className="block overflow-x-auto whitespace-nowrap font-mono text-sm text-[#dfe4ef]">{signup.data.token}</code>
        </div>
        <div className="mt-4 rounded-[var(--radius-card)] border border-line bg-surface-inset p-4 text-sm">
          <p className="font-semibold text-ink">Tenant ID</p>
          <p className="mt-1 font-mono text-xs text-ink-muted">{signup.data.tenantId}</p>
        </div>
        <label className="mt-5 flex items-start gap-3 text-sm text-ink">
          <input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
          <span>I saved the token in a password manager or secure environment variable.</span>
        </label>
        {openError && <p role="alert" className="mt-3 text-sm text-chip-danger-text">{openError}</p>}
        <button
          type="button"
          disabled={!saved || loginPending}
          onClick={() => void openControlRoom()}
          className="mt-5 w-full rounded-full border border-accent bg-accent px-4 py-2.5 text-sm font-semibold text-accent-contrast shadow-[0_9px_22px_rgba(46,92,255,.2)] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {loginPending ? "Opening…" : "Open setup checklist"}
        </button>
      </PublicAuthShell>
    );
  }

  return (
    <PublicAuthShell
      eyebrow="Free technical pilot"
      title="Create your Coldrig sandbox."
      description="Test provisioning, warmup, campaigns, replies, and failure handling without a card, vendor spend, real domains, or real email."
    >
      <div className="mb-5 rounded-[var(--radius-card)] border border-warn-border bg-warn-bg px-3 py-2 text-xs leading-5 text-warn-text">
        <strong className="block">Sandbox only.</strong> Real sending and paid infrastructure are not active yet.
      </div>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label htmlFor="brand" className="mb-1 block text-sm font-medium text-ink">Company or brand</label>
          <input id="brand" required maxLength={200} value={brand} onChange={(event) => setBrand(event.target.value)} placeholder="Northstar" className="w-full rounded-[var(--radius-card)] border border-line bg-canvas px-3 py-2.5 text-sm text-ink" />
        </div>
        <div>
          <label htmlFor="contact-email" className="mb-1 block text-sm font-medium text-ink">Work email</label>
          <input id="contact-email" required type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} placeholder="you@company.com" className="w-full rounded-[var(--radius-card)] border border-line bg-canvas px-3 py-2.5 text-sm text-ink" />
        </div>
        {signup.isError && <p role="alert" className="text-sm text-chip-danger-text">{signup.error instanceof Error ? signup.error.message : "Could not create the sandbox."}</p>}
        <button type="submit" disabled={signup.isPending || !brand.trim() || !contactEmail.trim()} className="w-full rounded-full border border-accent bg-accent px-4 py-2.5 text-sm font-semibold text-accent-contrast shadow-[0_9px_22px_rgba(46,92,255,.2)] disabled:opacity-45">
          {signup.isPending ? "Creating isolated tenant…" : "Free sign up"}
        </button>
      </form>
      <p className="mt-4 text-xs leading-5 text-ink-muted">By continuing, you agree to the <a href="https://coldrig.dev/terms" className="underline">terms</a>, <a href="https://coldrig.dev/aup" className="underline">acceptable-use policy</a>, and <a href="https://coldrig.dev/privacy" className="underline">privacy policy</a>.</p>
      <p className="mt-4 text-center text-xs text-ink-muted">Already have a token? <Link to="/" className="font-semibold text-accent">Sign in</Link></p>
    </PublicAuthShell>
  );
}
