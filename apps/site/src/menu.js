// Phone menu. Without this script the nav is a plain list of links (see styles.css).
(function () {
  var root = document.documentElement;
  root.classList.add("js");
  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.querySelector(".menu-btn");
    var nav = document.getElementById("site-nav");
    if (!btn || !nav) return;
    function set(open) {
      btn.setAttribute("aria-expanded", String(open));
      btn.textContent = open ? "Close" : "Menu";
      nav.classList.toggle("open", open);
    }
    btn.addEventListener("click", function () {
      set(btn.getAttribute("aria-expanded") !== "true");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && btn.getAttribute("aria-expanded") === "true") {
        set(false);
        btn.focus();
      }
    });
  });
})();
