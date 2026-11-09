import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import initSqlJs, { type Database } from "sql.js";
import { sqljsDriver } from "../src/services/sqljsDriver";
import { FinanceStore } from "../src/services/store";

export const MIGRATIONS_DIR = join(__dirname, "../src-tauri/migrations");
export const FIXTURES = join(__dirname, "../../../packages/finance-core/fixtures");

/** Applies each migration once, in order (like Tauri's SQL plugin). `upTo` stops at that version. */
export function migrate(db: Database, upTo = Infinity) {
  db.exec("CREATE TABLE IF NOT EXISTS test_migrations (version INTEGER PRIMARY KEY)");
  const applied = new Set((db.exec("SELECT version FROM test_migrations")[0]?.values ?? []).map((row) => Number(row[0])));
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const version = Number(file.slice(0, 4));
    if (version > upTo || applied.has(version)) continue;
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    db.run("INSERT INTO test_migrations (version) VALUES (?)", [version]);
  }
}

export async function newStore() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  migrate(db);
  return { db, store: new FinanceStore(sqljsDriver(db)) };
}

export const fixtureBytes = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, "statements", name)));

/**
 * A minimal text PDF: each page is a list of lines; a line is either text or
 * columns at x positions ([x, text][]), like a bank statement table. Synthetic data only.
 */
export function makePdf(pages: Array<Array<string | Array<[number, string]>>>): Uint8Array {
  const escape = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) - 1 + 1; // object numbers start at 1
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesRef = add(""); // filled in below
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const lines of pages) {
    const ops = lines.map((line, index) => {
      const y = 760 - index * 16;
      const columns = typeof line === "string" ? [[50, line] as [number, string]] : line;
      return columns.map(([x, text]) => `BT /F1 10 Tf 1 0 0 1 ${x} ${y} Tm (${escape(text)}) Tj ET`).join("\n");
    }).join("\n");
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[pagesRef - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out); // ASCII only, so string offsets are byte offsets
}
