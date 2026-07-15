(() => {
  const range = document.querySelector("#mailbox-count");
  if (!range) return;

  const mailboxOutput = document.querySelector("[data-mailbox-output]");
  const formulaMailboxes = document.querySelector("[data-formula-mailboxes]");
  const resultMailboxes = document.querySelector("[data-result-mailboxes]");
  const priceOutput = document.querySelector("[data-price-output]");
  const domainOutput = document.querySelector("[data-domain-output]");
  const capacityOutput = document.querySelector("[data-capacity-output]");
  const quickCounts = [...document.querySelectorAll("[data-mailboxes]")];
  const integer = new Intl.NumberFormat("en-US");

  function render() {
    const mailboxes = Number(range.value);
    const price = 49 + (10 * mailboxes);
    const domains = Math.ceil(mailboxes / 3);
    const monthlyPlanningCapacity = mailboxes * 30 * 22;
    const progress = ((mailboxes - Number(range.min)) / (Number(range.max) - Number(range.min))) * 100;

    mailboxOutput.textContent = String(mailboxes);
    formulaMailboxes.textContent = String(mailboxes);
    resultMailboxes.textContent = String(mailboxes);
    priceOutput.textContent = integer.format(price);
    domainOutput.textContent = String(domains);
    capacityOutput.textContent = integer.format(monthlyPlanningCapacity);
    range.style.setProperty("--range-progress", `${progress}%`);

    quickCounts.forEach((button) => {
      button.setAttribute("aria-pressed", String(Number(button.dataset.mailboxes) === mailboxes));
    });
  }

  range.addEventListener("input", render);
  quickCounts.forEach((button) => {
    button.addEventListener("click", () => {
      range.value = button.dataset.mailboxes;
      render();
      range.focus({ preventScroll: true });
    });
  });

  render();
})();
