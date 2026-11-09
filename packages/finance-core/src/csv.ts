// A strict RFC 4180 reader with the same failure cases as Ruby's CSV library:
// unclosed quotes and stray quotes inside unquoted fields are errors, never guesses.

export class MalformedCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedCsvError";
  }
}

/** Returns every row as an array of raw field strings. Completely empty lines are skipped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  let afterQuote = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
    fieldStarted = false;
    afterQuote = false;
  };
  const endRow = () => {
    endField();
    // skip_blanks: a line with nothing on it at all.
    if (!(row.length === 1 && row[0] === "" && !rowHadQuotes)) rows.push(row);
    row = [];
    rowHadQuotes = false;
  };
  let rowHadQuotes = false;

  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        afterQuote = true;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === ",") {
      endField();
      i += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      endRow();
      i += char === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (afterQuote) throw new MalformedCsvError("Unexpected text after a closing quote.");
    if (char === '"') {
      if (fieldStarted) throw new MalformedCsvError("Illegal quoting.");
      quoted = true;
      fieldStarted = true;
      rowHadQuotes = true;
      i += 1;
      continue;
    }
    field += char;
    fieldStarted = true;
    i += 1;
  }
  if (quoted) throw new MalformedCsvError("Unclosed quoted field.");
  if (fieldStarted || afterQuote || row.length > 0) endRow();
  return rows;
}

/** Ruby CSV output: quote fields with comma, quote, CR or LF, and empty strings. */
export function csvField(value: string): string {
  if (value === "" || /[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
