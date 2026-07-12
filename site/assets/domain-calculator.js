// Domains/inboxes-per-volume calculator. Pure client-side arithmetic, no network call.
// Assumptions (stated on-page, not hidden): 30 sends/mailbox/day once fully warmed —
// a conservative figure within the 25-40/day range already published in
// guide-cold-email-deliverability.html#warmup — and 3 mailboxes per domain, the top
// of the independently-reported "2-3 mailboxes per domain" figure cited in
// docs/research/agent-search-queries-2026-07-12.md.
const SENDS_PER_MAILBOX_PER_DAY = 30;
const MAILBOXES_PER_DOMAIN = 3;

document.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("#domain-calc");
  if (!form) return;

  const volumeInput = form.querySelector("#calc-volume");
  const result = form.querySelector(".calc-result");

  function run() {
    const target = Number(volumeInput.value);
    if (!Number.isFinite(target) || target <= 0) {
      result.textContent = "Enter a target number of emails per day greater than 0.";
      return;
    }
    const mailboxes = Math.ceil(target / SENDS_PER_MAILBOX_PER_DAY);
    const domains = Math.ceil(mailboxes / MAILBOXES_PER_DOMAIN);
    result.innerHTML =
      `At ${target.toLocaleString()} emails/day fully warmed, you need roughly ` +
      `<strong>${mailboxes} mailbox${mailboxes === 1 ? "" : "es"}</strong> across ` +
      `<strong>${domains} domain${domains === 1 ? "" : "s"}</strong>.`;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    run();
  });

  run();
});
