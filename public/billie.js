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

  // Sign-in buttons rotate the CSRF token, so a second click would post a stale one.
  // Submit once; pageshow re-enables the form when the browser restores this page from history.
  function setupSingleSubmit(form) {
    if (form.dataset.singleSubmitReady) return;
    form.dataset.singleSubmitReady = "1";
    form.addEventListener("submit", function (event) {
      if (form.dataset.submitting) { event.preventDefault(); return; }
      form.dataset.submitting = "1";
      form.querySelectorAll("button[type=submit], input[type=submit], button:not([type])").forEach(function (button) {
        button.setAttribute("aria-disabled", "true");
      });
    });
    window.addEventListener("pageshow", function (event) {
      if (!event.persisted) return;
      delete form.dataset.submitting;
      form.querySelectorAll("[aria-disabled]").forEach(function (button) { button.removeAttribute("aria-disabled"); });
    });
  }

  // Theme menu (System / Light / Dark). The choice stays in this browser only (see /billie-theme.js).
  function storageGet(key) { try { return window.localStorage.getItem(key); } catch (error) { return null; } }
  function storageSet(key, value) { try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, value); } catch (error) { /* ignore */ } }

  function setupThemeMenu(menu) {
    if (menu.dataset.themeReady) return;
    menu.dataset.themeReady = "1";
    menu.hidden = false;
    var buttons = menu.querySelectorAll("[data-theme-choice]");
    function apply(choice) {
      if (choice === "light" || choice === "dark") document.documentElement.setAttribute("data-theme", choice);
      else document.documentElement.removeAttribute("data-theme");
      buttons.forEach(function (button) { button.setAttribute("aria-pressed", button.dataset.themeChoice === choice ? "true" : "false"); });
    }
    apply(storageGet("billie.theme") || "system");
    buttons.forEach(function (button) {
      button.addEventListener("click", function () {
        var choice = button.dataset.themeChoice;
        storageSet("billie.theme", choice === "system" ? null : choice);
        document.querySelectorAll("[data-theme-menu]").forEach(function (other) {
          other.querySelectorAll("[data-theme-choice]").forEach(function (b) { b.setAttribute("aria-pressed", b.dataset.themeChoice === choice ? "true" : "false"); });
        });
        apply(choice);
        menu.open = false;
        menu.querySelector("summary").focus();
      });
    });
  }

  // Collapsible sidebar on wide screens. aria-expanded mirrors the state; the label swaps.
  function setupSidebarToggle(button) {
    if (button.dataset.sidebarReady) return;
    button.dataset.sidebarReady = "1";
    button.hidden = false;
    function sync() {
      var collapsed = document.documentElement.getAttribute("data-sidebar") === "collapsed";
      button.setAttribute("aria-expanded", collapsed ? "false" : "true");
      var label = collapsed ? button.dataset.expandLabel : button.dataset.collapseLabel;
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }
    sync();
    button.addEventListener("click", function () {
      var collapsed = document.documentElement.getAttribute("data-sidebar") === "collapsed";
      if (collapsed) document.documentElement.removeAttribute("data-sidebar"); else document.documentElement.setAttribute("data-sidebar", "collapsed");
      storageSet("billie.sidebar", collapsed ? null : "collapsed");
      sync();
    });
  }

  // Close an open <details> menu (language, theme) on Escape or an outside click.
  function setupMenuDismiss() {
    if (document.documentElement.dataset.menuDismissReady) return;
    document.documentElement.dataset.menuDismissReady = "1";
    document.addEventListener("click", function (event) {
      document.querySelectorAll(".bw-language-menu[open], .bw-theme-menu[open]").forEach(function (menu) {
        if (!menu.contains(event.target)) menu.open = false;
      });
    });
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      document.querySelectorAll(".bw-language-menu[open], .bw-theme-menu[open]").forEach(function (menu) {
        menu.open = false;
        var summary = menu.querySelector("summary");
        if (summary) summary.focus();
      });
    });
  }

  // Statement upload: drop files anywhere on the upload box. The file input stays the real control
  // (keyboard, screen readers, no-JS); dropping just fills it. Chosen file names are listed locally.
  function setupDropzone(zone) {
    if (zone.dataset.dropzoneReady) return;
    var input = zone.querySelector("input[type=file]");
    var list = zone.querySelector("[data-dropzone-files]");
    if (!input) return;
    zone.dataset.dropzoneReady = "1";
    function showFiles() {
      if (!list) return;
      list.textContent = "";
      Array.prototype.forEach.call(input.files || [], function (file) {
        var item = document.createElement("li");
        item.textContent = file.name;
        list.appendChild(item);
      });
      list.hidden = !(input.files && input.files.length);
    }
    ["dragenter", "dragover"].forEach(function (type) {
      zone.addEventListener(type, function (event) { event.preventDefault(); zone.classList.add("is-dragover"); });
    });
    ["dragleave", "dragend"].forEach(function (type) {
      zone.addEventListener(type, function (event) { if (!zone.contains(event.relatedTarget)) zone.classList.remove("is-dragover"); });
    });
    zone.addEventListener("drop", function (event) {
      event.preventDefault();
      zone.classList.remove("is-dragover");
      if (!event.dataTransfer || !event.dataTransfer.files.length) return;
      try { input.files = event.dataTransfer.files; } catch (error) { return; }
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    input.addEventListener("change", showFiles);
  }

  // Unfinished input survives switching between Default Mode and Manual Mode (or any other
  // navigation): forms marked data-draft-key keep a draft in sessionStorage (this tab only, cleared on
  // submit) and restore it on return, with a way to discard it. Without storage, the mode switch
  // warns before leaving a changed form instead.
  var draftStore = (function () {
    try { var probe = "billie.draft.probe"; window.sessionStorage.setItem(probe, "1"); window.sessionStorage.removeItem(probe); return window.sessionStorage; } catch (error) { return null; }
  })();

  function draftFields(form) {
    return Array.prototype.filter.call(form.elements, function (el) {
      return el.name && !el.disabled && el.name !== "authenticity_token" && ["hidden", "submit", "button", "file", "reset", "password"].indexOf(el.type) === -1;
    });
  }

  function draftKeyOf(el) { return el.type === "checkbox" || el.type === "radio" ? el.name + "|" + el.value : el.name; }

  function draftSnapshot(form) {
    var data = {};
    draftFields(form).forEach(function (el) { data[draftKeyOf(el)] = el.type === "checkbox" || el.type === "radio" ? el.checked : el.value; });
    return data;
  }

  function draftApply(form, data) {
    draftFields(form).forEach(function (el) {
      var key = draftKeyOf(el);
      if (!Object.prototype.hasOwnProperty.call(data, key)) return;
      if (el.type === "checkbox" || el.type === "radio") el.checked = Boolean(data[key]);
      else if (el.tagName === "SELECT") { if (Array.prototype.some.call(el.options, function (o) { return o.value === data[key]; })) el.value = data[key]; }
      else el.value = data[key];
    });
  }

  function setupDraft(form) {
    if (form.dataset.draftReady) return;
    form.dataset.draftReady = "1";
    var key = "billie.draft." + location.pathname + "#" + form.dataset.draftKey;
    var initial = draftSnapshot(form);
    var initialJson = JSON.stringify(initial);
    var labels = document.body.dataset;

    function save() {
      var now = JSON.stringify(draftSnapshot(form));
      var dirty = now !== initialJson;
      if (dirty) form.dataset.dirty = "1"; else delete form.dataset.dirty;
      if (!draftStore) return;
      if (dirty) draftStore.setItem(key, now); else draftStore.removeItem(key);
    }

    if (draftStore) {
      var saved = null;
      try { saved = JSON.parse(draftStore.getItem(key) || "null"); } catch (error) { saved = null; }
      if (saved && JSON.stringify(saved) !== initialJson) {
        draftApply(form, saved);
        form.dataset.dirty = "1";
        var note = document.createElement("p");
        note.className = "bw-draft-note";
        note.setAttribute("role", "status");
        note.dataset.draftNote = "";
        note.appendChild(document.createTextNode((labels.draftRestored || "Your unfinished input was restored.") + " "));
        var discard = document.createElement("button");
        discard.type = "button";
        discard.className = "bw-link-button";
        discard.textContent = labels.draftDiscard || "Discard";
        discard.addEventListener("click", function () {
          draftApply(form, initial);
          draftStore.removeItem(key);
          delete form.dataset.dirty;
          note.remove();
        });
        note.appendChild(discard);
        form.insertBefore(note, form.firstChild);
      }
    }
    form.addEventListener("input", save);
    form.addEventListener("change", save);
    form.addEventListener("submit", function () { if (draftStore) draftStore.removeItem(key); delete form.dataset.dirty; });
  }

  function setupModeSwitch(form) {
    if (form.dataset.modeSwitchReady) return;
    form.dataset.modeSwitchReady = "1";
    form.addEventListener("submit", function (event) {
      if (draftStore || !document.querySelector("form[data-draft-key][data-dirty]")) return;
      if (!window.confirm(form.dataset.unsavedWarning)) event.preventDefault();
    });
  }

  // "Ask Billie" on the Billie Insights page. The conversation stays in this tab (sessionStorage);
  // each question sends the recent turns to the server, which answers and stores nothing.
  function setupInsightChat(root) {
    if (root.dataset.insightChatReady) return;
    var form = root.querySelector("[data-chat-form]");
    var log = root.querySelector("[data-chat-log]");
    var input = root.querySelector("[data-chat-input]");
    var consent = root.querySelector("[data-chat-consent]");
    var status = root.querySelector("[data-chat-status]");
    var send = root.querySelector("[data-chat-send]");
    var empty = root.querySelector("[data-chat-empty]");
    if (!form || !log || !input || !consent) return;
    root.dataset.insightChatReady = "1";

    var storeKey = root.dataset.storeKey || "billie-insight-chat";
    var store = null;
    try { store = window.sessionStorage; store.getItem(storeKey); } catch (error) { store = null; }
    var messages = [];
    try { messages = JSON.parse((store && store.getItem(storeKey)) || "[]"); } catch (error) { messages = []; }
    if (!Array.isArray(messages)) messages = [];
    var busy = false;

    function persist() {
      if (!store) return;
      try { store.setItem(storeKey, JSON.stringify(messages.slice(-40))); } catch (error) { /* storage full or blocked */ }
    }

    function bubble(role, text, pending) {
      var item = document.createElement("div");
      item.className = "bw-chat-message bw-chat-message-" + role + (pending ? " bw-chat-message-pending" : "");
      var author = document.createElement("span");
      author.className = "bw-chat-author";
      author.textContent = role === "user" ? root.dataset.you : root.dataset.billie;
      var body = document.createElement("div");
      body.className = "bw-chat-bubble";
      body.textContent = text;
      item.appendChild(author);
      item.appendChild(body);
      log.appendChild(item);
      if (empty) empty.hidden = true;
      log.scrollTop = log.scrollHeight;
      return item;
    }

    function showError(text) {
      if (!status) return;
      status.textContent = text || "";
      status.hidden = !text;
    }

    function setBusy(value) {
      busy = value;
      input.disabled = value;
      if (send) send.disabled = value;
    }

    messages.forEach(function (message) { bubble(message.role, message.content); });

    function ask(question) {
      question = (question || "").trim();
      if (!question || busy) return;
      if (!consent.checked) { showError(root.dataset.consentError); consent.focus(); return; }
      showError("");
      messages.push({ role: "user", content: question });
      persist();
      bubble("user", question);
      input.value = "";
      var pending = bubble("assistant", root.dataset.thinking, true);
      setBusy(true);
      var token = document.querySelector('meta[name="csrf-token"]');
      fetch(root.dataset.url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "X-CSRF-Token": token ? token.content : "" },
        body: JSON.stringify({ consent: "1", messages: messages.slice(-12) })
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) { return { ok: response.ok, data: data }; });
      }).then(function (result) {
        pending.remove();
        if (result.ok && result.data.answer) {
          messages.push({ role: "assistant", content: result.data.answer });
          persist();
          bubble("assistant", result.data.answer);
        } else {
          // Keep the question so the person can retry, but take it out of the history sent next time.
          messages.pop();
          persist();
          input.value = question;
          showError(result.data.error || root.dataset.error);
        }
      }).catch(function () {
        pending.remove();
        messages.pop();
        persist();
        input.value = question;
        showError(root.dataset.error);
      }).then(function () {
        setBusy(false);
        input.focus();
      });
    }

    form.addEventListener("submit", function (event) { event.preventDefault(); ask(input.value); });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); ask(input.value); }
    });
    root.querySelectorAll("[data-chat-suggestion]").forEach(function (button) {
      button.addEventListener("click", function () { ask(button.textContent); });
    });
    var clear = root.querySelector("[data-chat-clear]");
    if (clear) clear.addEventListener("click", function () {
      if (busy) return;
      messages = [];
      persist();
      log.querySelectorAll(".bw-chat-message").forEach(function (item) { item.remove(); });
      if (empty) empty.hidden = false;
      showError("");
      input.focus();
    });
  }

  // Settings › Local databases › Manage. Without JS the forms post directly; with it, a
  // selection toolbar (select all, select empty ones, live count) and one confirmation dialog
  // shared by single and bulk removal, listing exactly what will be removed.
  function setupLocalManage(root) {
    if (root.dataset.localReady) return;
    root.dataset.localReady = "1";
    var bulk = root.querySelector("form[data-local-remove=bulk]");
    var dialog = root.querySelector("[data-local-remove-dialog]");
    var picks = Array.prototype.slice.call(root.querySelectorAll("input[data-local-pick]"));
    var all = root.querySelector("[data-local-select-all]");
    var empty = root.querySelector("[data-local-select-empty]");
    var count = root.querySelector("[data-local-selected-count]");
    var removeSelected = root.querySelector("[data-local-remove-selected]");
    var confirmButton = dialog && dialog.querySelector("[data-local-remove-confirm]");
    var pending = null;
    root.querySelectorAll("[data-local-js-only]").forEach(function (el) { el.hidden = false; });
    // Never start with a selection the person did not make on this page view (browsers can
    // restore checkbox state on reload or history navigation).
    picks.forEach(function (pick) { pick.checked = false; });
    window.addEventListener("pageshow", function (event) { if (event.persisted) { picks.forEach(function (pick) { pick.checked = false; }); refresh(); } });

    function fill(template, values) {
      return template.replace(/%\{(\w+)\}/g, function (_, key) { return values[key] != null ? values[key] : ""; });
    }
    function size(bytes) {
      var units = ["B", "KB", "MB", "GB"], value = bytes, unit = 0;
      while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
      return (unit === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "")) + " " + units[unit];
    }
    function selected() { return picks.filter(function (pick) { return pick.checked; }); }
    function refresh() {
      var n = selected().length;
      if (all) { all.checked = n > 0 && n === picks.length; all.indeterminate = n > 0 && n < picks.length; }
      count.textContent = n ? fill(dialog.dataset.selected, { count: n }) : dialog.dataset.none;
      bulk.classList.toggle("has-selection", n > 0);
      removeSelected.disabled = n === 0;
    }
    function ask(form, items) {
      if (!dialog || typeof dialog.showModal !== "function") return true; // no <dialog>: plain submit
      pending = form;
      var many = items.length > 1;
      dialog.querySelector("[data-local-remove-title]").textContent = many ? fill(dialog.dataset.titleMany, { count: items.length }) : dialog.dataset.titleOne;
      confirmButton.textContent = many ? fill(dialog.dataset.buttonMany, { count: items.length }) : dialog.dataset.buttonOne;
      var list = dialog.querySelector("[data-local-remove-items]");
      list.textContent = "";
      var bytes = 0;
      items.forEach(function (item) {
        var li = document.createElement("li");
        var name = document.createElement("strong");
        name.textContent = item.name;
        var detail = document.createElement("small");
        detail.textContent = item.detail;
        li.appendChild(name);
        li.appendChild(detail);
        list.appendChild(li);
        bytes += Number(item.bytes) || 0;
      });
      dialog.querySelector("[data-local-remove-total]").textContent = fill(dialog.dataset.total, { count: items.length, size: size(bytes) });
      confirmButton.disabled = false;
      dialog.showModal();
      return false;
    }

    picks.forEach(function (pick) { pick.addEventListener("change", refresh); });
    if (all) all.addEventListener("change", function () {
      var on = all.checked;
      picks.forEach(function (pick) { pick.checked = on; });
      refresh();
    });
    if (empty) empty.addEventListener("click", function () {
      picks.forEach(function (pick) { pick.checked = pick.dataset.empty === "true"; });
      refresh();
    });
    bulk.addEventListener("submit", function (event) {
      var items = selected().map(function (pick) { return pick.dataset; });
      if (!items.length) { event.preventDefault(); return; }
      if (!ask(bulk, items)) event.preventDefault();
    });
    root.querySelectorAll("form[data-local-remove=single]").forEach(function (form) {
      form.addEventListener("submit", function (event) {
        if (!ask(form, [form.dataset])) event.preventDefault();
      });
    });
    if (confirmButton) confirmButton.addEventListener("click", function () {
      if (!pending) return;
      confirmButton.disabled = true; // one request only
      var form = pending;
      pending = null;
      form.submit(); // bypasses the submit listener above
    });
    if (dialog) dialog.addEventListener("close", function () { pending = null; });
    if (dialog) dialog.addEventListener("click", function (event) {
      if (event.target !== dialog) return;
      var box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
    });
    refresh();
  }

  // Settings › Feature Library: switches save without a page reload and swap in the new sidebar the
  // server rendered; filters show and hide cards in place. Without JavaScript the forms and filter
  // links work as ordinary requests.
  function setupFeatureLibrary(root) {
    if (root.dataset.libraryReady) return;
    root.dataset.libraryReady = "1";
    var status = root.querySelector("[data-library-status]");
    var empty = root.querySelector("[data-library-empty]");
    var cards = Array.prototype.slice.call(root.querySelectorAll("[data-module]"));
    var filter = root.dataset.filter || "all";
    function visible(card) {
      if (filter === "enabled") return card.dataset.enabled === "true";
      if (filter === "available") return card.dataset.available === "true";
      if (filter === "coming_soon") return card.dataset.available !== "true";
      return true;
    }
    function applyFilter() {
      var shown = 0;
      cards.forEach(function (card) { var show = visible(card); card.hidden = !show; if (show) shown += 1; });
      if (empty) empty.hidden = shown > 0;
      root.querySelectorAll("[data-library-filter]").forEach(function (link) {
        var active = link.dataset.libraryFilter === filter;
        link.classList.toggle("is-active", active);
        if (active) link.setAttribute("aria-current", "true"); else link.removeAttribute("aria-current");
      });
      root.querySelectorAll("input[name=filter]").forEach(function (input) { input.value = filter; });
    }
    root.querySelectorAll("[data-library-filter]").forEach(function (link) {
      link.addEventListener("click", function (event) {
        event.preventDefault();
        filter = link.dataset.libraryFilter;
        root.dataset.filter = filter;
        if (window.history && window.history.replaceState) window.history.replaceState(null, "", link.href);
        applyFilter();
      });
    });
    root.querySelectorAll("form[data-library-toggle]").forEach(function (form) {
      form.addEventListener("submit", function (event) {
        if (!window.fetch) return;
        event.preventDefault();
        var button = form.querySelector(".bw-switch");
        var card = form.closest("[data-module]");
        var input = form.querySelector("input[name=enabled]");
        var token = document.querySelector('meta[name="csrf-token"]');
        button.setAttribute("aria-busy", "true");
        fetch(form.action, {
          method: "PATCH",
          headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-Token": token ? token.content : "" },
          body: new URLSearchParams({ enabled: input.value }).toString(),
          credentials: "same-origin"
        }).then(function (response) {
          return response.json().then(function (data) { return { ok: response.ok, data: data }; });
        }).then(function (result) {
          button.removeAttribute("aria-busy");
          if (!result.ok) { if (status) status.textContent = result.data.message || ""; return; }
          var on = result.data.enabled === true;
          card.dataset.enabled = on ? "true" : "false";
          card.classList.toggle("is-on", on);
          button.setAttribute("aria-checked", on ? "true" : "false");
          var text = button.querySelector(".bw-switch-text");
          if (text) text.textContent = on ? text.dataset.on : text.dataset.off;
          input.value = on ? "0" : "1";
          var open = card.querySelector("[data-library-open]");
          if (open) open.hidden = !on;
          var nav = document.getElementById("module-nav");
          if (nav && result.data.nav) {
            var holder = document.createElement("div");
            holder.innerHTML = result.data.nav;
            var fresh = holder.querySelector("#module-nav");
            if (fresh) nav.replaceWith(fresh);
          }
          if (status) status.textContent = result.data.message || "";
          applyFilter();
        }).catch(function () {
          button.removeAttribute("aria-busy");
          form.submit(); // fall back to an ordinary request
        });
      });
    });
    applyFilter();
  }

  function init() {
    document.querySelectorAll("form[data-draft-key]").forEach(setupDraft);
    document.querySelectorAll("form[data-mode-switch]").forEach(setupModeSwitch);
    document.querySelectorAll("[data-dropzone]").forEach(setupDropzone);
    document.querySelectorAll("[data-theme-menu]").forEach(setupThemeMenu);
    document.querySelectorAll("[data-sidebar-toggle]").forEach(setupSidebarToggle);
    setupMenuDismiss();
    document.querySelectorAll("[data-region-search]").forEach(setupRegionSearch);
    document.querySelectorAll("[data-dialog-open]").forEach(setupDialogTrigger);
    document.querySelectorAll("[data-copy-text]").forEach(setupCopyButton);
    document.querySelectorAll("form[data-confirm]").forEach(setupConfirmForm);
    document.querySelectorAll("form[data-single-submit]").forEach(setupSingleSubmit);
    document.querySelectorAll("[data-qr-zoom]").forEach(setupQrZoom);
    document.querySelectorAll("[data-qr-input]").forEach(setupQrPreview);
    document.querySelectorAll("[data-insight-chat]").forEach(setupInsightChat);
    document.querySelectorAll("[data-local-manage]").forEach(setupLocalManage);
    document.querySelectorAll("[data-feature-library]").forEach(setupFeatureLibrary);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  document.addEventListener("turbo:load", init);
})();
