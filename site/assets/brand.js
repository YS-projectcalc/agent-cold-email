// Display identity. The permanent package/repository handle remains
// `agent-cold-email`; the customer-facing product brand is Coldrig.
const BRAND_NAME = "Coldrig";

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-brand]").forEach((el) => {
    el.textContent = BRAND_NAME;
  });
  document.title = document.title.replace("{{BRAND}}", BRAND_NAME);
});
