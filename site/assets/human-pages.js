document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-tab-set]").forEach((set) => {
    const buttons = [...set.querySelectorAll("[data-tab]")];
    const panels = [...set.querySelectorAll("[data-panel]")];
    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        buttons.forEach((candidate) => candidate.setAttribute("aria-selected", String(candidate === button)));
        panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === button.dataset.tab));
      });
    });
  });

  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.querySelector(button.dataset.copy);
      if (!target) return;
      try {
        await navigator.clipboard.writeText(target.textContent.trim());
        button.textContent = "Copied";
      } catch {
        button.textContent = "Select and copy";
      }
    });
  });

  const query = new URLSearchParams(window.location.search);
  document.querySelectorAll("[data-query]").forEach((element) => {
    const value = query.get(element.dataset.query);
    if (value) element.textContent = value.slice(0, 200);
  });

  document.querySelectorAll("[data-sandbox-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const result = form.parentElement.querySelector(".recipient-result");
      if (result) result.classList.add("is-visible");
    });
  });
});
