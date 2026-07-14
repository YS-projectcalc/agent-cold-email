// Waitlist form submission. Posts to https://agent-cold-email-api.yaakovscher.workers.dev/api/waitlist — the API
// host token is substituted post-deploy (see site/README.md). On a network
// failure this degrades to a clear status rather than pretending success.
const WAITLIST_ENDPOINT = "https://agent-cold-email-api.yaakovscher.workers.dev/api/waitlist";

document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("form.waitlist");
  if (!form) return;

  // The status node may sit outside the form element, so fall back to a
  // document-level lookup rather than assuming it is a descendant.
  const status = form.querySelector(".form-status") || document.querySelector(".form-status");
  const emailInput = form.querySelector('input[type="email"]');

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!emailInput.checkValidity()) {
      setStatus(status, "Enter a valid email address.", "err");
      return;
    }

    setStatus(status, "Submitting…", "");
    const button = form.querySelector("button");
    button.disabled = true;

    try {
      const res = await fetch(WAITLIST_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailInput.value }),
      });
      if (res.ok) {
        setStatus(status, "You're on the list — we'll email you when real sending goes live.", "ok");
        form.reset();
      } else {
        setStatus(status, "That didn't go through. Try again in a moment.", "err");
      }
    } catch {
      setStatus(
        status,
        "Waitlist isn't connected yet in this preview — check back once the platform is deployed.",
        "err",
      );
    } finally {
      button.disabled = false;
    }
  });
});

function setStatus(el, message, kind) {
  if (!el) return;
  el.textContent = message;
  el.className = "form-status" + (kind ? ` ${kind}` : "");
}
