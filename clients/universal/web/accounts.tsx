// Rails serves the same Accounts & Assets table as the local client (built by scripts/build-overview.mjs).
// The page renders a plain table first, so it works without JavaScript; this replaces it.
import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { AccountsTable, openCapture, type TableActions, type TableContext } from "../src/accounts/AccountTable";
import { summarize, type AccountRow } from "../src/accounts/model";
import type { Position } from "../src/overview/model";

type Links = Record<"edit" | "transactions" | "entry" | "adjust" | "statements" | "archive" | "unarchive" | "destroy" | "reorder" | "manual", string>;
interface Data { context: TableContext; rows: AccountRow[]; positions: { currency: string; position: Position }[]; links: Links; addLabel: string }

const token = () => document.querySelector<HTMLMetaElement>("meta[name=csrf-token]")?.content ?? "";
const link = (template: string, id: string) => template.replace("__ID__", encodeURIComponent(id));

/** Sends a Rails form (with method override and CSRF token) so the server's redirect and notice apply. */
function submit(url: string, method: "patch" | "delete") {
  const form = document.createElement("form");
  form.method = "post";
  form.action = url;
  for (const [name, value] of [["_method", method], ["authenticity_token", token()]]) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.append(input);
  }
  document.body.append(form);
  form.submit();
}

/** Moves the server-rendered AI / statement / manual entry panel into the table's slot, keeping its listeners. */
function CaptureSlot() {
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const capture = document.getElementById("accounts-capture");
    if (capture && slot.current) slot.current.append(capture);
  }, []);
  return <div ref={slot} className="at-capture-slot" />;
}

function WebAccounts({ data }: { data: Data }) {
  const [rows, setRows] = useState(data.rows);
  const { links } = data;
  const go = (url: string) => location.assign(url);
  const actions: TableActions = {
    open: (row) => go(link(links.edit, row.id)),
    edit: (row) => go(link(links.edit, row.id)),
    transactions: (row) => go(link(links.transactions, row.id)),
    addTransaction: (row) => go(link(links.entry, row.id)),
    updateBalance: (row) => go(link(links.adjust, row.id)),
    importStatement: () => go(links.statements),
    archive: (row) => submit(link(links.archive, row.id), "patch"),
    unarchive: (row) => submit(link(links.unarchive, row.id), "patch"),
    remove: (row) => submit(link(links.destroy, row.id), "delete"),
    reorder: async (ids) => {
      const res = await fetch(links.reorder, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-CSRF-Token": token() },
        body: JSON.stringify({ ids }),
        credentials: "same-origin",
      });
      if (!res.ok) throw Error(String(res.status));
      // The server saved exactly this order; mirror it so the table does not need a reload.
      setRows((old) => old.map((row) => ({ ...row, sortOrder: ids.indexOf(row.id) })));
    },
  };
  const summaries = data.positions.map(({ currency, position }) => summarize(currency, position));
  return (
    <AccountsTable rows={rows} summaries={summaries} context={data.context} actions={actions}
      add={<button type="button" className="bw-button bw-button-dark bw-button-small" onClick={() => { if (!openCapture()) go(links.manual); }}>{data.addLabel}</button>}>
      <CaptureSlot />
    </AccountsTable>
  );
}

const node = document.getElementById("accounts-table");
if (node?.dataset.table) {
  const data: Data = JSON.parse(node.dataset.table);
  node.replaceChildren();
  createRoot(node).render(<WebAccounts data={data} />);
}
