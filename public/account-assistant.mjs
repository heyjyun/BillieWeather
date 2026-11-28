import { institutions, isDebt, proposeAccounts } from "./account-capture.mjs";

const el = (tag, text, css) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (css) node.className = css;
  return node;
};
function button(text, css, action) {
  const node = el("button", text, css);
  node.type = "button";
  node.onclick = action;
  return node;
}
function select(values) {
  const node = el("select");
  for (const [value, label] of values) node.add(new Option(label, value));
  return node;
}
function input(type, max) {
  const node = el("input");
  node.type = type;
  if (max) node.maxLength = max;
  return node;
}
function field(parent, label, control) {
  const wrapper = el("label", "", "bw-field");
  const caption = el("span", label);
  wrapper.append(caption, control);
  parent.append(wrapper);
  return caption;
}
// Only reuse a naming format if multiple saved names demonstrate it exactly.
export function suggestedName(bank, type, accounts, types) {
  const label = types[type] || "";
  if (!label || !bank) return label || bank;
  const patterns = [
    (b,t) => b + " " + t, (b,t) => t + " · " + b, (b,t) => b + " · " + t,
    (b,t) => t + " (" + b + ")", (b,t) => b + " - " + t, (b,t) => t + " - " + b,
  ];
  const scores = patterns.map(format => accounts.filter(a => a.institution && types[a.type] &&
    format(a.institution,types[a.type]).toLowerCase() === a.name.toLowerCase()).length);
  const high = Math.max(...scores);
  const winner = high >= 2 && scores.filter(n => n === high).length === 1 ? scores.indexOf(high) : 0;
  return patterns[winner](bank,label).slice(0,60);
}
export function mountCapture(root, options) {
  const {copy, types, currency, region, empty, accounts} = options;
  const container = el(empty ? "section" : "details", "", "bw-panel bw-section-gap bw-account-capture");
  if (!empty) container.append(el("summary", options.add, "bw-text-link"));
  const heading = el(empty ? "h2" : "h3", empty ? copy.start : copy.ai);
  const intro = el("p", copy.intro);
  const text = el("textarea");
  if (options.suggestion) { text.value = options.suggestion; container.open = true; }
  text.maxLength = 12000;
  text.rows = 2;
  const description = el("label", "", "bw-field");
  description.append(intro, text);
  const actions = el("div", "", "bw-actions bw-heading-actions");
  const preview = el("div");
  const message = el("p", "", "bw-caption");
  message.setAttribute("role", "status");
  const showMessage = key => { message.textContent = copy[key] || copy.failure; };
  let sequence = 0;
  let saving = false;
  function review(proposals, source) {
    preview.replaceChildren();
    message.textContent = "";
    if (!proposals.length) return showMessage("none");
    const requestKey = options.id();
    const form = el("form", "", "bw-entry-form");
    form.append(el("h3", copy.preview), el("p", copy.review + " " + copy.anchorHelp));
    const listId = "banks-" + requestKey;
    const banks = el("datalist");
    banks.id = listId;
    for (const name of institutions[region] || []) banks.append(new Option(name, name));
    form.append(banks);
    const readers = [];
    for (const proposal of proposals) {
      const box = el("fieldset", "", "bw-panel");
      const legend = el("legend");
      const include = input("checkbox");
      const selection = el("label");
      selection.append(include, document.createTextNode(" " + copy.selected));
      legend.append(selection);
      box.append(legend);
      const grid = el("div", "", "bw-form-grid");
      const type = select([["", "—"], ...Object.entries(types)]);
      type.required = true;
      type.value = proposal.type;
      const bank = input("text", 60);
      bank.value = proposal.institution;
      bank.setAttribute("list", listId);
      const name = input("text", 60);
      name.value = suggestedName(proposal.institution,proposal.type,accounts,types);
      name.required = true;
      const amount = input("text", 16);
      amount.inputMode = "decimal";
      amount.pattern = "-?[0-9]{1,12}([.][0-9]{1,2})?";
      amount.placeholder = copy.unknown;
      amount.value = proposal.amount;
      const suffix = input("text", 4);
      suffix.inputMode = "numeric";
      suffix.pattern = "[0-9]{4}";
      suffix.value = proposal.last4;
      const date = input("date");
      date.value = proposal.date;
      const today = new Date();
      date.max = new Date(today.getTime()-today.getTimezoneOffset()*60000).toISOString().slice(0,10);
      const requireDate = () => { date.required = Boolean(amount.value); };
      amount.addEventListener("input", requireDate);
      requireDate();
      const cur = select([...new Set([currency, proposal.currency].filter(Boolean))].map(c => [c,c]));
      cur.value = proposal.currency || currency;
      field(grid, copy.name, name);
      field(grid, copy.type, type);
      field(grid, copy.institution, bank);
      field(grid, copy.currency, cur);
      const balanceLabel = field(grid, isDebt(type.value) ? copy.owed : copy.balance, amount);
      type.onchange = () => { balanceLabel.textContent = isDebt(type.value) ? copy.owed : copy.balance; };
      field(grid, copy.date, date);
      field(grid, copy.last4, suffix);
      const duplicate = accounts.some(a => a.name.toLowerCase() === name.value.toLowerCase() ||
        (bank.value && suffix.value && a.institution?.toLowerCase() === bank.value.toLowerCase() && a.last4 === suffix.value && a.type === type.value));
      const controls = {name, type, institution:bank, currency:cur, amount, date, last4:suffix};
      const originals = Object.fromEntries(Object.entries(controls).map(([key,control]) => [key,control.value]));
      const origin = key => {
        if (!controls[key].value) return "unknown";
        if (controls[key].value !== originals[key]) return "edited";
        return key === "name" || key === "type" || (key === "currency" && !proposal.currency) ? "suggested" : source;
      };
      for (const key of Object.keys(controls)) {
        const control = controls[key];
        const hint = el("small");
        const update = () => { hint.textContent = copy["origin_" + origin(key)]; };
        update();
        control.addEventListener("input",update);
        const label = control.closest("label");
        const wrap = el("div","","bw-assistant-field");
        label.replaceWith(wrap);
        wrap.append(label,hint);
        hint.id = listId + "-" + readers.length + "-" + key;
        control.setAttribute("aria-describedby",hint.id);
      }
      box.append(grid);
      if (duplicate) box.append(el("p", copy.duplicate));
      include.checked = !duplicate;
      const toggle = () => { for (const control of grid.querySelectorAll("input,select")) control.disabled = !include.checked; };
      include.onchange = toggle;
      toggle();
      const remove = button(copy.removeProposal,"bw-link-button",() => {
        include.checked = false;
        box.remove();
        if (!form.querySelector("fieldset")) {
          preview.replaceChildren();
          text.focus();
        }
      });
      box.append(remove);
      form.append(box);
      readers.push(() => include.checked ? {
        name: name.value.trim(), institution: bank.value.trim(), type: type.value, last4: suffix.value,
        amount: amount.value.trim(), date: date.value, currency: cur.value,
        origins: Object.fromEntries(Object.keys(controls).map(key => [key,origin(key)])),
      } : null);
    }
    const confirm = el("button", copy.confirm, "bw-button bw-button-dark");
    confirm.type = "submit";
    form.append(confirm);
    form.onsubmit = async event => {
      event.preventDefault();
      if (saving) return;
      const rows = readers.map(read => read()).filter(Boolean);
      if (!rows.length || rows.some(row => row.currency !== currency)) return showMessage("failure");
      saving = true;
      confirm.disabled = true;
      try {
        await options.commit({ key: requestKey, rows, source, confirmed: true });
        preview.replaceChildren();
        text.value = "";
        message.textContent = "";
      } catch (e) { showMessage(e.message === "duplicate" ? "duplicate" : "failure"); }
      finally { saving = false; confirm.disabled = false; }
    };
    preview.append(form);
  }
  const file = input("file");
  file.accept = "image/png,image/jpeg,image/webp,image/heic";
  file.hidden = true;
  file.onchange = async () => {
    const selected = file.files?.[0];
    if (!selected || saving) return;
    const current = ++sequence;
    preview.replaceChildren();
    try {
      if (selected.size > 8 * 1024 * 1024) throw new Error();
      const lines = await options.recognize(selected);
      if (current === sequence && root.contains(container)) review(proposeAccounts(lines, true), "screenshot");
    } catch { if (current === sequence) showMessage("ocrOff"); }
    finally { file.value = ""; }
  };
  actions.append(button(copy.preview, "bw-button bw-button-dark", () => {
    if (saving) return;
    sequence++;
    review(proposeAccounts(text.value), "text");
  }), button(copy.shot, "bw-button bw-button-outline", () => options.recognize ? file.click() : showMessage("ocrOff")),
    button(copy.statement, "bw-button bw-button-outline", options.statement), button(copy.manual, "bw-button bw-button-outline", options.manual));
  const futureConnection = el("button",copy.future,"bw-button bw-button-outline");
  futureConnection.type = "button";
  futureConnection.disabled = true;
  actions.append(futureConnection);
  container.append(heading, description, actions, file, message, preview);
  if (options.serverOcr) container.insertBefore(el("small",copy.serverOcr,"bw-caption"),message);
  root.replaceChildren(container);
  return () => { sequence++; root.replaceChildren(); };
}
