// Waitlist form submission. Posts to __API_BASE__/api/waitlist — the API
// host token is substituted post-deploy (see site/README.md). The endpoint
// itself is not wired yet in this build phase; this script degrades to a
// clear "not connected yet" status rather than pretending success.
const WAITLIST_ENDPOINT = "__API_BASE__/api/waitlist";

document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("form.waitlist");
  if (!form) return;

  const status = form.querySelector(".form-status");
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
  el.textContent = message;
  el.className = "form-status" + (kind ? ` ${kind}` : "");
}
