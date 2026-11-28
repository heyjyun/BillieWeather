import { mountNext } from "./next-steps.mjs";
import { mountCapture } from "./account-assistant.mjs";
import { institutions, isDebt } from "./account-capture.mjs";

export async function request(url, method, body) {
  const headers = { Accept: "application/json", "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content || "" };
  if (!(body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {method, headers, credentials: "same-origin", cache: "no-store", body: body instanceof FormData ? body : JSON.stringify(body)});
  if (!response.ok) throw new Error(response.status === 409 ? "duplicate" : "failure");
  return response.json();
}
function connect() {
  for (const root of document.querySelectorAll("[data-capture-options]")) {
    if (root.dataset.connected) continue;
    const o = JSON.parse(root.dataset.captureOptions);
    root.dataset.connected = "1";
    mountCapture(root, {...o, id: () => crypto.randomUUID(),
      manual: () => location.assign(o.manualUrl), statement: () => location.assign(o.importUrl),
      recognize: o.ocrUrl ? async file => {
        const data = new FormData();
        data.set("file", file);
        const result = await request(o.ocrUrl, "POST", data);
        return result.lines.filter(line => line.confidence == null || line.confidence >= 0.65).map(line => line.text).join("\n");
      } : undefined,
      commit: async batch => { await request(o.createUrl, "POST", batch); location.reload(); },
    });
  }
  for (const form of document.querySelectorAll("form[data-review-url]")) {
    const preview = form.querySelector("[data-statement-preview]");
    const token = form.elements.review_token;
    const submit = form.querySelector("[type=submit]");
    const original = submit.value;
    let revision = 0;
    form.onchange = () => { revision++; token.value = ""; preview.replaceChildren(); submit.value = original; };
    form.onsubmit = async e => {
      if (token.value) return;
      e.preventDefault();
      const current = revision;
      submit.disabled = true;
      try {
        const result = await request(form.dataset.reviewUrl,"POST",new FormData(form));
        if (current !== revision) return;
        preview.replaceChildren();
        for (const file of result.files) {
          const title = document.createElement("h3");
          const copy = JSON.parse(form.dataset.reviewCopy);
          title.textContent = [file.filename,file.account && (copy[file.account_id ? "matchedAccount" : "proposedAccount"] + " · " + file.account),
            copy.sampleRows + " · " + file.count].filter(Boolean).join(" · ");
          preview.append(title);
          for (const line of file.rows) {
            const p = document.createElement("p");
            p.textContent = line.join(" · ");
            preview.append(p);
          }
          if (file.error) preview.append(document.createTextNode(file.error));
        }
        if (result.files.some(f => f.status !== "failed")) { token.value = result.token; submit.value = submit.dataset.confirmLabel; }
      } catch { preview.textContent = form.dataset.error || original; }
      finally { submit.disabled = false; }
    };
  }
  for (const root of document.querySelectorAll("[data-next-step-options]")) {
    if (root.dataset.connected) continue;
    root.dataset.connected = "1";
    const {url, urls, copy, page} = JSON.parse(root.dataset.nextStepOptions);
    request(url, "GET").then(({facts, state}) => {
      if (!facts || !root.isConnected) return;
      const main = root.closest("main");
      const capture = main?.querySelector("[data-capture-options]");
      const slot = main?.querySelector("[data-next-slot]");
      if (capture) capture.after(root);
      else if (slot) slot.append(root);
      else main?.querySelector(".bw-page-heading")?.after(root);
      mountNext(root, {facts, state, copy, page, save: (key,value,expected) => request(url, "PATCH", {key,value,expected}),
        choose: item => {
          const target = new URL(urls[item.kind].replace("ACCOUNT_ID", encodeURIComponent(item.target)), location.origin);
          if (["budget","discover","recurring"].includes(item.kind)) target.searchParams.set("suggestion", item.target);
          location.assign(target.href);
        }});
    }).catch(() => { delete root.dataset.connected; });
  }
  for (const form of document.querySelectorAll("[data-manual-assistant]")) {
    const {copy, region} = JSON.parse(form.dataset.manualAssistant);
    const type = form.querySelector("[name$='[account_type]']");
    const label = form.querySelector("[data-amount-label]");
    const name = form.querySelector("[name$='[custom_name]']");
    const bank = form.querySelector("[name$='[bank_name]']");
    const names = form.querySelector("[data-name-options]");
    const list = form.querySelector("#account-institutions");
    list.replaceChildren(...(institutions[region] || []).map(bank => new Option(bank,bank)));
    const update = () => {
      label.textContent = isDebt(type.value) ? copy.owed : type.value === "cash" ? copy.cash : copy.balance;
      const kind = type.selectedOptions[0].text.split(" (")[0];
      name.placeholder = [bank.value,kind].filter(Boolean).join(" ");
      names.replaceChildren(...[...new Set([name.placeholder,kind])].map(value => new Option(value,value)));
      for (const [field,show] of [["credit_limit",isDebt(type.value)],["statement_day",type.value === "credit_card"],["due_day",isDebt(type.value)]]) {
        const control = form.querySelector("[name$='[" + field + "]']");
        control.closest(".bw-field").hidden = !show;
        control.disabled = !show;
      }
    };
    type.onchange = update;
    bank.oninput = update;
    update();
  }
}
connect();
document.addEventListener("turbo:load", connect);
