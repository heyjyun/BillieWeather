// Rails hands the bounded XLSX reader a single statement workbook on stdin.
// Only a single visible, nonempty data sheet can be represented by one CSV statement.
import { readXlsx } from "./xlsx";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
try {
  const {sheets} = await readXlsx(Buffer.concat(chunks), {maxCells: 100000, maxTotalBytes: 16 * 1024 * 1024});
  const data = sheets.filter(s => s.state === "visible" && s.rows.length);
  if (data.length !== 1 || data[0].rows.length > 5001) throw new Error();
  const csv = data[0].rows.map(row => row.map(cell => {
    if (cell.kind === "error") throw new Error();
    const value = cell.kind === "empty" ? "" : cell.kind === "date" ? cell.iso : cell.kind === "boolean" ? String(cell.value) : cell.text;
    return '"' + value.replaceAll('"', '""') + '"';
  }).join(",")).join("\n");
  if (Buffer.byteLength(csv) > 2 * 1024 * 1024) throw new Error();
  process.stdout.write(csv);
} catch { process.exitCode = 1; }
