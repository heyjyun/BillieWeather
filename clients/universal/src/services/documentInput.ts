import { isTauri } from "./platform";

export interface LocalDocument {
  name: string;
  type: string;
  read: (maximum: number) => Promise<Uint8Array>;
}

export class DocumentTooLarge extends Error {}

export function usesDesktopDocumentPicker(): boolean {
  return isTauri() && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    && !(/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

export function webDocuments(files: FileList | null): LocalDocument[] {
  return Array.from(files ?? [], (file) => ({
    name: file.name, type: file.type,
    read: async (max) => {
      if (file.size > max) throw new DocumentTooLarge();
      return new Uint8Array(await file.arrayBuffer());
    },
  }));
}

const imageTypes: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif",
  webp: "image/webp", tif: "image/tiff", tiff: "image/tiff", pdf: "application/pdf",
};

export const receiptExtensions = ["png", "jpg", "jpeg", "heic", "heif", "webp", "tif", "tiff", "pdf"];
export const statementExtensions = ["csv", "tsv", "tab", "txt", "xlsx", "ofx", "qfx", ...receiptExtensions];

/** The native picker grants access only to files the person selects. Read them one at a time. */
export async function browseDocuments(extensions: readonly string[], multiple = false): Promise<LocalDocument[]> {
  const [{ open }, { stat, readFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
  const result = await open({ multiple, directory: false, filters: [{ name: extensions.map((ext) => ext.toUpperCase()).join(", "), extensions: [...extensions] }] });
  const paths = Array.isArray(result) ? result : result ? [result] : [];
  return paths.map((path) => {
    const name = path.split(/[\\/]/).pop() ?? "";
    const type = imageTypes[name.split(".").pop()?.toLowerCase() ?? ""] ?? "";
    return {
      name, type,
      read: async (max) => {
        const info = await stat(path);
        if (!info.isFile) throw new Error("The selected item is not a file");
        if (info.size > max) throw new DocumentTooLarge();
        const bytes = await readFile(path);
        if (bytes.byteLength > max) throw new DocumentTooLarge();
        return bytes;
      },
    };
  });
}
