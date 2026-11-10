// The site's only script. Without it every page still works: the nav is a plain list of links, the guide list is open,
// and code blocks can be selected by hand. With it: the phone menu, the guide list folding on a phone, the Copy buttons
// and the "On this page" marker.
(function () {
  document.documentElement.classList.add("js");
  document.addEventListener("DOMContentLoaded", function () {
    // Phone menu: the Menu button opens the main menu as a panel under the header and becomes Close.
    var header = document.querySelector(".top");
    var btn = document.querySelector(".menu");
    if (header && btn) {
      var set = function (open) {
        header.classList.toggle("open", open);
        btn.setAttribute("aria-expanded", String(open));
        btn.textContent = open ? "Close" : "Menu";
      };
      btn.addEventListener("click", function () {
        set(btn.getAttribute("aria-expanded") !== "true");
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && header.classList.contains("open")) {
          set(false);
          btn.focus();
        }
      });
    }

    // Guide list: closed by default on a phone, where it folds into an "All guides" button.
    var toggle = document.querySelector(".g-toggle");
    if (toggle && window.innerWidth <= 760) toggle.removeAttribute("open");

    // Copy buttons on code blocks: copy, then read "Copied" for two seconds.
    document.querySelectorAll("[data-copy]").forEach(function (button) {
      button.addEventListener("click", function () {
        var code = button.parentElement.querySelector("code");
        var text = code ? code.textContent : "";
        var done = function () {
          button.textContent = "Copied";
          button.setAttribute("data-state", "done");
          setTimeout(function () {
            button.textContent = "Copy";
            button.removeAttribute("data-state");
          }, 2000);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, function () {
            var range = document.createRange();
            range.selectNodeContents(code);
            var sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
          });
        } else if (code) {
          var r = document.createRange();
          r.selectNodeContents(code);
          var s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        }
      });
    });

    // "On this page": mark the heading nearest the top of the screen.
    var links = Array.prototype.slice.call(document.querySelectorAll(".g-toc a[href^='#']"));
    if (links.length && "IntersectionObserver" in window) {
      var byId = {};
      links.forEach(function (a) {
        byId[a.getAttribute("href").slice(1)] = a;
      });
      var mark = function (id) {
        links.forEach(function (a) {
          a.removeAttribute("aria-current");
        });
        if (byId[id]) byId[id].setAttribute("aria-current", "true");
      };
      var obs = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (en) {
            if (en.isIntersecting) mark(en.target.id);
          });
        },
        { rootMargin: "0px 0px -70% 0px" }
      );
      Object.keys(byId).forEach(function (id) {
        var h = document.getElementById(id);
        if (h) obs.observe(h);
      });
      mark(links[0].getAttribute("href").slice(1));
    }
  });
})();
