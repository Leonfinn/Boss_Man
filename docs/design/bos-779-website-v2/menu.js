// Phone menu for the mock-ups: the Menu button opens the main menu as a panel under the header and becomes Close.
// Escape closes it and puts focus back on the button. Opening the page with #menu shows it open (for the renders).
(() => {
  const button = document.querySelector(".menu");
  const header = document.querySelector(".top");
  function setOpen(open) {
    header.classList.toggle("open", open);
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Close" : "Menu";
  }
  button.addEventListener("click", () => setOpen(button.getAttribute("aria-expanded") !== "true"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && header.classList.contains("open")) { setOpen(false); button.focus(); }
  });
  if (location.hash === "#menu") setOpen(true);
})();
