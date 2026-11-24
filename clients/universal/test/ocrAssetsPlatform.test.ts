// Which builds carry the Tesseract OCR assets (~10 MB in the installed app).
import { describe, expect, it } from "vitest";
import { needsTesseract } from "../vite.config";

describe("Tesseract assets per build target", () => {
  it("are left out of mobile builds, which only use the native engine", () => {
    for (const platform of ["ios", "android"]) expect(needsTesseract(platform)).toBe(false);
  });

  it("ship with macOS, where Tesseract is the fallback of Apple Vision", () => {
    for (const platform of ["darwin", "macos"]) expect(needsTesseract(platform)).toBe(true);
  });

  it("stay in browser, Windows and Linux builds, which have no native engine", () => {
    for (const platform of [undefined, "", "windows", "linux"]) expect(needsTesseract(platform)).toBe(true);
  });
});
