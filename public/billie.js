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

  // Support modal: a native <dialog>, so Esc, focus containment and returning focus
  // to the trigger come from the browser. Clicking the dimmed backdrop also closes it.
  function setupDialogTrigger(trigger) {
    if (trigger.dataset.dialogReady) return;
    var dialog = document.getElementById(trigger.dataset.dialogOpen);
    if (!dialog || typeof dialog.showModal !== "function") return;
    trigger.dataset.dialogReady = "1";
    trigger.setAttribute("aria-expanded", "false");
    trigger.addEventListener("click", function (event) {
      // Links (like "Support us" in the header) fall back to /features#support without JS.
      event.preventDefault();
      if (dialog.open) return;
      dialog.showModal();
      trigger.setAttribute("aria-expanded", "true");
    });
    if (dialog.dataset.dialogReady) return;
    dialog.dataset.dialogReady = "1";
    dialog.addEventListener("close", function () {
      trigger.setAttribute("aria-expanded", "false");
      if (document.activeElement === document.body) trigger.focus();
    });
    dialog.addEventListener("click", function (event) {
      if (event.target !== dialog) return;
      var box = dialog.getBoundingClientRect();
      var inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
      if (!inside) dialog.close();
    });
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      (document.querySelector("dialog[open]") || document.body).appendChild(area);
      area.select();
      var copied = false;
      try { copied = document.execCommand("copy"); } catch (error) { copied = false; }
      area.remove();
      if (copied) resolve(); else reject(new Error("copy failed"));
    });
  }

  // "Copy Note" copies the whole payment note, e.g. "jyun donation".
  function setupCopyButton(button) {
    if (button.dataset.copyReady) return;
    button.dataset.copyReady = "1";
    var label = button.querySelector("span") || button;
    var original = label.textContent;
    button.addEventListener("click", function () {
      var text = button.dataset.copyText || "";
      var status = document.querySelector("[data-copy-status]");
      copyText(text).then(function () {
        label.textContent = button.dataset.copiedLabel || original;
        button.classList.add("is-copied");
        if (status) status.textContent = (button.dataset.copiedLabel || "") + " " + text;
        setTimeout(function () { label.textContent = original; button.classList.remove("is-copied"); }, 2000);
      }, function () {
        // Clipboard unavailable: select the note so it can be copied by hand.
        var code = button.parentElement && button.parentElement.querySelector("code");
        if (code && window.getSelection) {
          var range = document.createRange();
          range.selectNodeContents(code);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(range);
        }
      });
    });
  }

  // "Enlarge" opens the QR code in a larger view on top of the support modal, so it is
  // easy to scan from another phone or to long-press and save. Without <dialog>
  // support the link simply opens the image in a new tab.
  function setupQrZoom(link) {
    if (link.dataset.qrZoomReady) return;
    var zoom = document.getElementById("support-qr-zoom");
    if (!zoom || typeof zoom.showModal !== "function") return;
    link.dataset.qrZoomReady = "1";
    link.addEventListener("click", function (event) {
      event.preventDefault();
      var image = zoom.querySelector("[data-qr-zoom-image]");
      var title = zoom.querySelector("[data-qr-zoom-title]");
      image.src = link.getAttribute("href");
      image.alt = (link.querySelector("img") || {}).alt || link.dataset.qrTitle || "";
      if (title) title.textContent = link.dataset.qrTitle || "";
      if (!zoom.open) zoom.showModal();
    });
    if (zoom.dataset.qrZoomReady) return;
    zoom.dataset.qrZoomReady = "1";
    zoom.addEventListener("click", function (event) {
      if (event.target === zoom) zoom.close();
      event.stopPropagation();
    });
  }

  // Admin → Payment Methods: show the chosen file before it is saved.
  function setupQrPreview(input) {
    if (input.dataset.qrPreviewReady) return;
    input.dataset.qrPreviewReady = "1";
    var card = input.closest("[data-payment-method]");
    var preview = card && card.querySelector("[data-qr-preview]");
    if (!preview || !window.URL || !URL.createObjectURL) return;
    var image = preview.querySelector("img");
    input.addEventListener("change", function () {
      if (image.src) URL.revokeObjectURL(image.src);
      var file = input.files && input.files[0];
      if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) { preview.hidden = true; image.removeAttribute("src"); return; }
      image.src = URL.createObjectURL(file);
      preview.hidden = false;
    });
  }

  // This layout has no Turbo/UJS, so honor data-confirm on forms here.
  function setupConfirmForm(form) {
    if (form.dataset.confirmReady) return;
    form.dataset.confirmReady = "1";
    form.addEventListener("submit", function (event) {
      if (!window.confirm(form.dataset.confirm)) event.preventDefault();
    });
  }

  function init() {
    document.querySelectorAll("[data-region-search]").forEach(setupRegionSearch);
    document.querySelectorAll("[data-dialog-open]").forEach(setupDialogTrigger);
    document.querySelectorAll("[data-copy-text]").forEach(setupCopyButton);
    document.querySelectorAll("form[data-confirm]").forEach(setupConfirmForm);
    document.querySelectorAll("[data-qr-zoom]").forEach(setupQrZoom);
    document.querySelectorAll("[data-qr-input]").forEach(setupQrPreview);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  document.addEventListener("turbo:load", init);
})();
