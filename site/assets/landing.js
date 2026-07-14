document.documentElement.classList.add("js");

const reveals = document.querySelectorAll("[data-reveal]");
if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8%", threshold: 0.12 });
  reveals.forEach((element) => observer.observe(element));
} else {
  reveals.forEach((element) => element.classList.add("is-visible"));
}

const handoffItems = [...document.querySelectorAll("[data-handoff]")];
let activeHandoff = 0;
let handoffTimer;

function selectHandoff(index) {
  activeHandoff = index;
  handoffItems.forEach((item, itemIndex) => item.classList.toggle("is-selected", itemIndex === index));
}

function startHandoffRotation() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || handoffItems.length < 2) return;
  clearInterval(handoffTimer);
  handoffTimer = window.setInterval(() => selectHandoff((activeHandoff + 1) % handoffItems.length), 3600);
}

handoffItems.forEach((item, index) => {
  item.addEventListener("click", () => {
    selectHandoff(index);
    startHandoffRotation();
  });
});
startHandoffRotation();
