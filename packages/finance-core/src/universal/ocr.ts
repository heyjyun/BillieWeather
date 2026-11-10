// OCR for scanned PDFs and photos, behind a platform adapter.
//
// This module does NOT recognize text. Each platform supplies an `OcrEngine` (for example
// Apple Vision on macOS/iOS, Windows.Media.Ocr, ML Kit on Android, a WASM engine on the Web).
// Engines must run on the device; a cloud engine may only be offered behind explicit opt-in.
// What is shared is everything after recognition: rebuilding table rows from word positions,
// carrying each word's confidence into the cells, and the same normalize/validate pipeline as
// CSV, so every platform produces identical canonical records from identical OCR output.
// Low-confidence dates, amounts and directions are flagged for review; nothing is invented.
import type { SourceCell, SourceTable } from "./normalize";

export interface OcrBox {
  /** Pixels, origin at the top-left of the upright page image. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrElement extends OcrBox {
  text: string;
  /** 0..1 as reported by the engine; null when the engine reports none for this element. */
  confidence: number | null;
}

export interface OcrLine extends OcrElement {
  words: OcrElement[];
}

export interface OcrPage {
  page: number;
  width: number;
  height: number;
  /** Clockwise rotation applied to make the page upright (EXIF or detected). Boxes are in the upright frame. */
  rotation: 0 | 90 | 180 | 270;
  lines: OcrLine[];
}

export type OcrErrorCode = "decode_failed" | "recognition_failed" | "too_large" | "cancelled" | "unsupported_format" | "engine_unavailable";

export interface OcrPageError {
  page: number | null;
  code: OcrErrorCode;
  message: string;
}

/** What every engine adapter returns (Apple Vision, ML Kit, Tesseract). */
export interface OcrResult {
  engine: { id: string; version: string };
  /** Languages the engine was configured with. */
  languages: string[];
  pages: OcrPage[];
  errors: OcrPageError[];
  /** Capabilities this engine lacks for this input, e.g. "word_confidence", "language:zh-Hant", "format:heic". */
  unsupported: string[];
  /**
   * Engines that cannot tell Simplified from Traditional Chinese (Tesseract) return both readings;
   * the person chooses. `pages` is then the zh-Hans reading. Amounts and dates are the same in both.
   */
  scriptVariants?: { "zh-Hans": OcrPage[]; "zh-Hant": OcrPage[] };
}

export type OcrImageKind = "png" | "jpeg" | "heic" | "webp" | "tiff";

/** One page image, in document order. Scanned PDFs are rendered to images before OCR. */
export interface OcrImage {
  page: number;
  bytes: Uint8Array;
  kind: OcrImageKind;
}

export interface OcrEngineInfo {
  id: string;
  /** "device": runs locally. "cloud": sends the document away and requires explicit opt-in. */
  location: "device" | "cloud";
  languages: string[];
}

export interface OcrEngine {
  info: OcrEngineInfo;
  recognize(input: { images: OcrImage[]; languages: string[]; signal?: AbortSignal }): Promise<OcrResult>;
}

export const OCR_LANGUAGES = ["en", "zh-Hans", "zh-Hant"] as const;

/** A missing confidence is not certainty: it is treated as low so the row is reviewed. */
export const UNKNOWN_CONFIDENCE = 0.5;

export class OcrUnavailableError extends Error {
  constructor() {
    super("ocr_unavailable");
    this.name = "OcrUnavailableError";
  }
}

/** Checks an adapter's JSON against the contract; anything malformed is dropped, never repaired. */
export function parseOcrResult(value: unknown): OcrResult {
  const object = (value ?? {}) as Record<string, unknown>;
  const number = (input: unknown) => (typeof input === "number" && Number.isFinite(input) ? input : null);
  const element = (input: unknown): OcrElement | null => {
    const item = (input ?? {}) as Record<string, unknown>;
    const [x, y, width, height] = [number(item.x), number(item.y), number(item.width), number(item.height)];
    if (typeof item.text !== "string" || x === null || y === null || width === null || height === null) return null;
    const confidence = number(item.confidence);
    return { text: item.text, x, y, width, height, confidence: confidence === null ? null : Math.min(1, Math.max(0, confidence)) };
  };
  const pages = (Array.isArray(object.pages) ? object.pages : []).flatMap((raw): OcrPage[] => {
    const page = (raw ?? {}) as Record<string, unknown>;
    const [index, width, height] = [number(page.page), number(page.width), number(page.height)];
    if (index === null || width === null || height === null) return [];
    const rotation = [0, 90, 180, 270].includes(Number(page.rotation)) ? (Number(page.rotation) as OcrPage["rotation"]) : 0;
    const lines = (Array.isArray(page.lines) ? page.lines : []).flatMap((rawLine): OcrLine[] => {
      const line = element(rawLine);
      if (!line) return [];
      const words = (Array.isArray((rawLine as Record<string, unknown>).words) ? ((rawLine as Record<string, unknown>).words as unknown[]) : []).map(element).filter((word): word is OcrElement => word !== null);
      return [{ ...line, words }];
    });
    return [{ page: index, width, height, rotation, lines }];
  });
  const engine = (object.engine ?? {}) as Record<string, unknown>;
  const codes: OcrErrorCode[] = ["decode_failed", "recognition_failed", "too_large", "cancelled", "unsupported_format", "engine_unavailable"];
  return {
    engine: { id: typeof engine.id === "string" ? engine.id : "unknown", version: typeof engine.version === "string" ? engine.version : "unknown" },
    languages: Array.isArray(object.languages) ? object.languages.filter((item): item is string => typeof item === "string") : [],
    pages,
    errors: (Array.isArray(object.errors) ? object.errors : []).map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      return { page: number(item.page), code: codes.includes(item.code as OcrErrorCode) ? (item.code as OcrErrorCode) : "recognition_failed", message: typeof item.message === "string" ? item.message.slice(0, 200) : "" };
    }),
    unsupported: Array.isArray(object.unsupported) ? object.unsupported.filter((item): item is string => typeof item === "string") : [],
    ...(object.scriptVariants && typeof object.scriptVariants === "object" ? {
      scriptVariants: {
        "zh-Hans": parseOcrResult({ pages: (object.scriptVariants as Record<string, unknown>)["zh-Hans"] }).pages,
        "zh-Hant": parseOcrResult({ pages: (object.scriptVariants as Record<string, unknown>)["zh-Hant"] }).pages,
      },
    } : {}),
  };
}

/** Merges per-page results of one engine into a single result, pages in order. */
export function mergeOcrResults(results: readonly OcrResult[]): OcrResult {
  const [first] = results;
  return {
    engine: first?.engine ?? { id: "unknown", version: "unknown" },
    languages: first?.languages ?? [],
    pages: results.flatMap((result) => result.pages).sort((a, b) => a.page - b.page),
    errors: results.flatMap((result) => result.errors),
    unsupported: [...new Set(results.flatMap((result) => result.unsupported))],
  };
}

/** Words of a page; a line without word boxes counts as one word. Small skew is removed first. */
function pageWords(page: OcrPage): OcrElement[] {
  const words = page.lines.flatMap((line) => (line.words.length > 0 ? line.words.map((word) => ({ ...word, confidence: word.confidence ?? line.confidence })) : [line]));
  const angle = estimateSkew(page);
  if (Math.abs(angle) < 0.002) return words; // under ~0.1 degrees
  // Rotate word centres back by the skew around the page centre; sizes are kept.
  const [cx, cy] = [page.width / 2, page.height / 2];
  const [cos, sin] = [Math.cos(-angle), Math.sin(-angle)];
  return words.map((word) => {
    const [x, y] = [word.x + word.width / 2 - cx, word.y + word.height / 2 - cy];
    return { ...word, x: cx + x * cos - y * sin - word.width / 2, y: cy + x * sin + y * cos - word.height / 2 };
  });
}

/**
 * Skew of a tilted scan or photo in radians (positive when y grows along a line, i.e. clockwise tilt),
 * from the slope of word centres inside each engine line that has several words. Median of the
 * lines, limited to +-10 degrees; larger angles are the engine's job (quarter-turn rotation).
 */
export function estimateSkew(page: OcrPage): number {
  const slopes: number[] = [];
  for (const line of page.lines) {
    if (line.words.length < 2) continue;
    const points = line.words.map((word) => [word.x + word.width / 2, word.y + word.height / 2] as const);
    const meanX = points.reduce((sum, [x]) => sum + x, 0) / points.length;
    const meanY = points.reduce((sum, [, y]) => sum + y, 0) / points.length;
    const sxx = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
    if (sxx < 1) continue;
    const sxy = points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
    slopes.push(Math.atan(sxy / sxx));
  }
  if (slopes.length < 2) return 0;
  slopes.sort((a, b) => a - b);
  const median = slopes[Math.floor(slopes.length / 2)];
  return Math.abs(median) <= Math.PI / 18 ? median : 0;
}

interface PlacedCell {
  text: string;
  confidence: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Groups words into lines (by vertical overlap) and lines into cells (by horizontal gaps).
 * Cells are then assigned to columns by x-position, using the line with the most cells on the
 * page (normally the header) as anchors, so an empty Debit column never shifts a Credit amount
 * into it. A cell that overlaps no anchor, or shares one with another cell, is placed by nearest
 * centre and its confidence is capped at 0.5 so the row is reviewed. A cell's confidence is the
 * lowest confidence of its words.
 */
export function layoutToTable(pages: readonly OcrPage[], format: "image" | "pdf_scanned"): SourceTable {
  const rows: SourceCell[][] = [];
  const rowNumbers: number[] = [];
  const pageNumbers: number[] = [];
  const rowBoxes: OcrBox[] = [];
  for (const page of pages) {
    const words = pageWords(page).filter((word) => word.text.trim() !== "").sort((a, b) => a.y - b.y || a.x - b.x);
    const lines: OcrElement[][] = [];
    for (const word of words) {
      const center = word.y + word.height / 2;
      const line = lines.find((candidate) => {
        const top = Math.min(...candidate.map((item) => item.y));
        const bottom = Math.max(...candidate.map((item) => item.y + item.height));
        return center >= top && center <= bottom;
      });
      if (line) line.push(word);
      else lines.push([word]);
    }
    const placed: PlacedCell[][] = lines.map((line) => {
      line.sort((a, b) => a.x - b.x);
      const groups: OcrElement[][] = [];
      for (const word of line) {
        const current = groups[groups.length - 1];
        const previous = current?.[current.length - 1];
        const charWidth = previous ? previous.width / Math.max(1, [...previous.text].length) : 0;
        if (current && previous && word.x - (previous.x + previous.width) <= charWidth * 1.5) current.push(word);
        else groups.push([word]);
      }
      return groups.map((group) => ({
        text: group.map((word) => word.text).join(" "),
        confidence: Math.min(...group.map((word) => word.confidence ?? UNKNOWN_CONFIDENCE)),
        left: group[0].x,
        right: Math.max(...group.map((word) => word.x + word.width)),
        top: Math.min(...group.map((word) => word.y)),
        bottom: Math.max(...group.map((word) => word.y + word.height)),
      }));
    });
    const anchors = placed.reduce<PlacedCell[]>((best, line) => (line.length > best.length ? line : best), []);
    placed.forEach((line, lineIndex) => {
      const out: SourceCell[] = anchors.map(() => ({ text: "" }));
      const taken = new Set<number>();
      for (const cell of line) {
        const overlaps = anchors.map((anchor) => Math.min(anchor.right, cell.right) - Math.max(anchor.left, cell.left));
        let column = overlaps.indexOf(Math.max(...overlaps));
        let certain = overlaps[column] > 0 && overlaps.filter((value) => value > 0).length === 1;
        if (!certain) {
          const center = (cell.left + cell.right) / 2;
          const distances = anchors.map((anchor) => Math.abs((anchor.left + anchor.right) / 2 - center));
          column = distances.indexOf(Math.min(...distances));
        }
        if (taken.has(column)) certain = false;
        taken.add(column);
        const existing = out[column];
        const confidence = Math.min(existing.confidence ?? 1, cell.confidence, certain ? 1 : 0.5);
        out[column] = { text: existing.text ? `${existing.text} ${cell.text}` : cell.text, confidence };
      }
      rows.push(out);
      rowNumbers.push(lineIndex + 1);
      pageNumbers.push(page.page);
      const left = Math.min(...line.map((cell) => cell.left));
      const top = Math.min(...line.map((cell) => cell.top));
      rowBoxes.push({ x: left, y: top, width: Math.max(...line.map((cell) => cell.right)) - left, height: Math.max(...line.map((cell) => cell.bottom)) - top });
    });
  }
  return { format, rows, rowNumbers, pageNumbers, rowBoxes };
}
