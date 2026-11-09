// BillieWeather progressive enhancements. Pages work without this file.
(function () {
  "use strict";

  function normalize(text) {
    return (text || "").toString().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }

  // Region picker: a search box that filters the long region <select> as you type.
  // Safari cannot hide <option>s, so matching options are rebuilt instead of hidden.
  function setupRegionSearch(root) {
    if (root.dataset.regionSearchReady) return;
    var input = root.querySelector("[data-region-search-input]");
    var select = root.querySelector("select");
    var empty = root.querySelector("[data-region-search-empty]");
    if (!input || !select) return;
    root.dataset.regionSearchReady = "1";

    var prompt = select.options[0] && select.options[0].value === "" ? select.options[0] : null;
    var all = Array.prototype.slice.call(select.options).filter(function (option) { return option !== prompt; });
    all.forEach(function (option) { option.dataset.match = normalize(option.dataset.search || option.text); });

    // The last real choice survives searches that match nothing, so clearing the box restores it.
    var lastValue = select.value;

    function render(query) {
      var selected = select.value || lastValue;
      var terms = normalize(query).split(/\s+/).filter(Boolean);
      var matches = terms.length === 0 ? all : all.filter(function (option) {
        return terms.every(function (term) { return option.dataset.match.indexOf(term) !== -1; });
      });
      // Names that start with the query come first, so "ja" lists Japan before Azerbaijan.
      if (terms.length) {
        var first = terms[0];
        matches = matches.slice().sort(function (a, b) {
          return (normalize(a.text).indexOf(first) === 0 ? 0 : 1) - (normalize(b.text).indexOf(first) === 0 ? 0 : 1);
        });
      }
      select.textContent = "";
      if (prompt) select.appendChild(prompt);
      matches.forEach(function (option) { select.appendChild(option); });

      if (matches.some(function (option) { return option.value === selected; })) {
        select.value = selected;
      } else if (terms.length && matches.length) {
        select.value = matches[0].value;
      } else {
        select.value = "";
      }
      if (select.value) lastValue = select.value;
      // While searching, show the matches as an open list instead of a closed dropdown.
      select.size = terms.length ? Math.max(2, Math.min(matches.length + (prompt ? 1 : 0), 7)) : 0;
      if (empty) empty.hidden = !(terms.length && matches.length === 0);
    }

    var form = select.form;
    if (form) form.addEventListener("submit", function () {
      if (input.value) { input.value = ""; render(""); }
    });

    input.hidden = false;
    input.addEventListener("input", function () { render(input.value); });
    input.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" && input.value) {
        event.preventDefault();
        select.focus();
      } else if (event.key === "Enter" && input.value) {
        // Enter picks the highlighted match instead of submitting a half-finished form.
        event.preventDefault();
        if (select.value) { input.value = ""; render(""); select.focus(); }
      } else if (event.key === "Escape" && input.value) {
        input.value = "";
        render("");
      }
    });
    select.addEventListener("change", function () {
      if (select.value) lastValue = select.value;
      if (input.value && select.value) { input.value = ""; render(""); }
    });
    select.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && select.size > 1) { event.preventDefault(); input.value = ""; render(""); }
    });
  }

  function init() {
    document.querySelectorAll("[data-region-search]").forEach(setupRegionSearch);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  document.addEventListener("turbo:load", init);
})();
