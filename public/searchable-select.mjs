const names = {};
const searchLocales = ["en", "zh-CN", "zh-TW"];
const aliases = {
  region: {
    US: "usa america", GB: "uk britain england scotland wales", AE: "uae emirates",
    KR: "korea south 韩国 韓國", CN: "prc mainland china 中国大陆 中國大陸",
    NL: "holland", CZ: "czechia", RU: "russia", VN: "vietnam", TR: "turkiye",
    XG: "global citizen 全球公民 地球公民 世界公民", XO: "other 其他",
  },
  currency: {
    USD: "american dollar 美金", EUR: "欧元 歐元", GBP: "british pound 英镑 英鎊",
    AUD: "澳元 澳幣 澳币", CAD: "加元 加幣 加币", NZD: "纽币 紐幣 纽元 紐元",
    SGD: "新币 新幣", HKD: "港币 港幣", CNY: "chinese yuan rmb 人民币 人民幣",
    JPY: "日元 日圆 日圓 日币 日幣",
  },
};

function translatedNames(type, code) {
  if (!type || !code) return [];
  const format = type === "region" ? /^[a-z]{2}$/i : /^[a-z]{3}$/i;
  if (!format.test(code)) return [];
  names[type] ??= searchLocales.map((locale) => {
    try {
      return new Intl.DisplayNames(locale, { type, fallback: "none" });
    } catch {
      return null;
    }
  });
  return names[type].map((display) => display?.of(code));
}

function fold(text) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").replaceAll("臺", "台").toLowerCase().trim();
}

/** Binds the same search behavior to a native select in Rails or React. */
export function connectSearchableSelect(root) {
  const input = root.querySelector("input");
  const select = root.querySelector("select");
  const list = root.querySelector("[role='listbox']");
  const status = root.querySelector("[role='status']");
  const listeners = new AbortController();
  const listen = { signal: listeners.signal };
  const type = root.dataset.searchableSelect;
  // Read Rails options in place. React supplies its options through update().
  let source;
  let all = index([...select.options]);
  let matches = [];
  let active = -1;
  let composing = false;
  let choosing = false;

  function index(options) {
    return options.map((option) => {
      const code = option.value;
      const terms = [option.label, code, option.dataset.search, aliases[type]?.[code], ...translatedNames(type, code)];
      return { option, code: fold(code), terms: fold(terms.filter(Boolean).join(" ")) };
    });
  }

  function filter(query) {
    if (!query) return all;
    const eligible = all.filter(({ option }) => option.value && !option.disabled);
    const exact = eligible.find(({ code }) => code === query);
    if (exact) return [exact];
    const words = query.split(/\s+/);
    return eligible.filter(({ terms }) => words.every((word) => terms.includes(word)));
  }

  function showActive(index, scroll = false) {
    active = index;
    for (const [position, item] of [...list.children].entries()) {
      item.setAttribute("aria-selected", String(!list.hidden && position === active));
    }
    const current = !list.hidden && list.children[active];
    if (current) {
      input.setAttribute("aria-activedescendant", current.id);
      if (scroll) current.scrollIntoView?.({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function render(value = select.value) {
    const query = fold(input.value);
    matches = filter(query);
    // Keep the current option in the native control so a partial search never changes the form value.
    const shown = query ? all.filter((entry) => entry.option.value === value || matches.includes(entry)) : all;
    // Rebuild only when filtering changes the options. Safari cannot hide individual options.
    if (shown.length !== select.options.length || shown.some(({ option }, position) => select.options[position] !== option)) {
      select.replaceChildren(...shown.map(({ option }) => option));
    }
    if (select.value !== value) select.value = value;

    const open = query !== "" && matches.length > 1 && input === root.ownerDocument.activeElement;
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    list.replaceChildren();
    if (open) {
      matches.forEach(({ option }, position) => {
        const item = root.ownerDocument.createElement("li");
        item.id = `${list.id}-${position}`;
        item.dataset.matchIndex = String(position);
        item.setAttribute("role", "option");
        item.textContent = option.label;
        list.append(item);
      });
    }
    showActive(active < matches.length ? active : -1);
    status.hidden = !query || matches.length !== 0;
  }

  function choose(option) {
    if (select.value === option.value) return;
    select.value = option.value;
    choosing = true;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    choosing = false;
  }

  function reset() {
    input.value = "";
    active = -1;
    render();
  }

  function search() {
    active = -1;
    render();
    if (fold(input.value) && matches.length === 1) {
      choose(matches[0].option);
      render();
    }
  }

  function confirm(index) {
    const match = matches[index];
    if (!match) return;
    choose(match.option);
    reset();
    select.focus();
  }

  input.addEventListener("compositionstart", () => { composing = true; }, listen);
  input.addEventListener("compositionend", () => { composing = false; search(); }, listen);
  input.addEventListener("input", (event) => { if (!composing && !event.isComposing) search(); }, listen);
  input.addEventListener("focus", () => render(), listen);
  input.addEventListener("blur", () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    showActive(-1);
  }, listen);
  input.addEventListener("keydown", (event) => {
    if (composing || event.isComposing) return;
    const query = fold(input.value);
    if (event.key === "Escape" && input.value) {
      event.preventDefault();
      event.stopPropagation();
      reset();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (query) confirm(Math.max(active, 0));
    } else if (query && matches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const index = event.key === "ArrowDown"
        ? (active + 1) % matches.length
        : (active < 0 ? matches.length - 1 : (active + matches.length - 1) % matches.length);
      showActive(index, true);
    }
  }, listen);
  // Preserve search focus while clicking a result so blur doesn't close it before click.
  list.addEventListener("mousedown", (event) => event.preventDefault(), listen);
  list.addEventListener("click", (event) => {
    const item = event.target.closest("[data-match-index]");
    if (item) confirm(Number(item.dataset.matchIndex));
  }, listen);
  select.addEventListener("change", () => { if (!choosing && input.value) reset(); }, listen);
  select.form?.addEventListener("reset", reset, listen);
  input.hidden = false;
  root.classList.add("is-searchable");

  return {
    update(options, value) {
      if (source !== options) {
        source = options;
        all = index(options.map(({ value, label, terms, disabled }) => {
          const option = root.ownerDocument.createElement("option");
          option.value = value;
          option.text = label;
          if (terms) option.dataset.search = terms;
          option.disabled = Boolean(disabled);
          return option;
        }));
      }
      render(value);
    },
    reset,
    disconnect() { listeners.abort(); },
  };
}
