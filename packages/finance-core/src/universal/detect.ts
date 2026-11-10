// Upload -> Detect. Decides what a file is from its bytes (the extension is only a tie-breaker),
// which text encoding it uses, and how a delimited text file is split. Every decision that could
// change financial results reports whether it was proven or only suggested.

export type DetectedKind = "delimited" | "xlsx" | "xls_legacy" | "ofx" | "pdf" | "image" | "unknown";
export type ImageKind = "png" | "jpeg" | "heic" | "webp" | "tiff";

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export interface EncodingDetection {
  /** WHATWG encoding label used to decode. */
  encoding: string;
  /** Proven by a BOM or by being valid UTF-8 (which other encodings practically never are by accident). */
  confident: boolean;
  /** Other encodings that decode the bytes without errors, for the person to choose from. */
  alternatives: string[];
}

/** Legacy encodings tried, in this order, when a file is not UTF-8. */
export const LEGACY_ENCODINGS = ["gb18030", "big5", "shift_jis", "euc-kr", "windows-1252"] as const;

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

export function detectImage(bytes: Uint8Array): ImageKind | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (ascii(bytes, 4, 4) === "ftyp" && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(ascii(bytes, 8, 4))) return "heic";
  return null;
}

/** File kind from magic bytes first; text files are told apart by content. */
export function detectKind(bytes: Uint8Array, text: string | null): DetectedKind {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "xlsx";
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "xls_legacy";
  if (detectImage(bytes)) return "image";
  if (text === null) return "unknown";
  const head = text.slice(0, 4096);
  if (/^\s*OFXHEADER\s*:/i.test(head) || /<\?OFX\b/i.test(head) || /<OFX>/i.test(head)) return "ofx";
  return "delimited";
}

function decodes(bytes: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** Decodes text and says how sure that is. Binary content (NUL bytes outside UTF-16) is refused. */
export function detectEncoding(bytes: Uint8Array): { text: string; detection: EncodingDetection } | null {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    const text = decodes(bytes, "utf-8");
    return text === null ? null : { text, detection: { encoding: "utf-8", confident: true, alternatives: [] } };
  }
  for (const [signature, encoding] of [[[0xff, 0xfe], "utf-16le"], [[0xfe, 0xff], "utf-16be"]] as const) {
    if (startsWith(bytes, [...signature])) {
      const text = decodes(bytes, encoding);
      return text === null ? null : { text, detection: { encoding, confident: true, alternatives: [] } };
    }
  }
  if (bytes.includes(0)) return null;
  const utf8 = decodes(bytes, "utf-8");
  if (utf8 !== null) return { text: utf8, detection: { encoding: "utf-8", confident: true, alternatives: [] } };
  const candidates = LEGACY_ENCODINGS.flatMap((encoding) => {
    const text = decodes(bytes, encoding);
    return text === null ? [] : [{ encoding, text }];
  });
  if (candidates.length === 0) return null;
  // Prefer the decoding that yields the most letters of one script and the fewest odd symbols.
  const score = (text: string) => {
    const letters = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
    const odd = (text.match(/[\u0080-¿×÷� -⁯-]/gu) ?? []).length;
    return letters - odd * 4;
  };
  const ranked = [...candidates].sort((a, b) => score(b.text) - score(a.text));
  return {
    text: ranked[0].text,
    detection: { encoding: ranked[0].encoding, confident: false, alternatives: ranked.slice(1).map((candidate) => candidate.encoding) },
  };
}

export function decodeAs(bytes: Uint8Array, encoding: string): string | null {
  return decodes(bytes, encoding);
}

export class DelimitedParseError extends Error {
  constructor(public code: "unclosed_quote" | "stray_quote", public line: number) {
    super(code);
    this.name = "DelimitedParseError";
  }
}

export interface DelimitedTable {
  rows: string[][];
  /** 1-based source line where each row starts. */
  lines: number[];
}

/** RFC 4180 with a chosen delimiter. Quotes must be balanced; nothing is guessed. Blank lines are dropped. */
export function parseDelimited(text: string, delimiter: string): DelimitedTable {
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  let started = false;
  let line = 1;
  let rowLine = 1;
  const endField = () => {
    row.push(field);
    field = "";
    afterQuote = false;
    started = false;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === "")) {
      rows.push(row);
      lines.push(rowLine);
    }
    row = [];
  };
  const body = text.replace(/^﻿/, "");
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quoted) {
      if (char === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      continue;
    }
    if (char === delimiter) {
      endField();
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && body[i + 1] === "\n") i += 1;
      endRow();
      line += 1;
      rowLine = line;
      continue;
    }
    if (afterQuote) {
      if (char === " " || char === "\t") continue; // spaces after a closing quote are tolerated
      throw new DelimitedParseError("stray_quote", line);
    }
    if (char === '"') {
      if (started && field.trim() !== "") throw new DelimitedParseError("stray_quote", line);
      field = "";
      quoted = true;
      started = true;
      continue;
    }
    field += char;
    started = true;
  }
  if (quoted) throw new DelimitedParseError("unclosed_quote", line);
  if (started || afterQuote || row.length > 0) endRow();
  return { rows, lines };
}

export interface DelimiterDetection {
  delimiter: string;
  confident: boolean;
}

const DELIMITERS = [",", ";", "\t", "|"] as const;

/**
 * The delimiter that splits the most lines into the same number (>1) of fields. A tie between
 * candidates is reported as not confident; the person confirms it in the preview.
 */
export function detectDelimiter(text: string, preferTab = false): DelimiterDetection {
  const sample = text.slice(0, 64 * 1024);
  const results = DELIMITERS.flatMap((delimiter) => {
    try {
      const { rows } = parseDelimited(sample, delimiter);
      const body = rows.slice(0, 200);
      const widths = new Map<number, number>();
      for (const fields of body) widths.set(fields.length, (widths.get(fields.length) ?? 0) + 1);
      const [width, count] = [...widths.entries()].filter(([w]) => w > 1).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [1, 0];
      return [{ delimiter, width, count }];
    } catch {
      return [];
    }
  }).filter((result) => result.count > 0).sort((a, b) => b.count - a.count || b.width - a.width);
  if (results.length === 0) return { delimiter: preferTab ? "\t" : ",", confident: false };
  const [best, second] = results;
  if (preferTab && results.some((result) => result.delimiter === "\t" && result.count === best.count)) return { delimiter: "\t", confident: true };
  const confident = !second || second.count < best.count || second.width < best.width;
  return { delimiter: best.delimiter, confident };
}
