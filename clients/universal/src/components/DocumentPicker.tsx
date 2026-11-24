import { browseDocuments, usesDesktopDocumentPicker, webDocuments, type LocalDocument } from "../services/documentInput";
import { useRef, useState } from "react";

export function DocumentPicker({ extensions, accept, multiple = false, label, help, busy, onChoose, onError }: {
  extensions: readonly string[]; accept: string; multiple?: boolean; label: string; help: string; busy: boolean;
  onChoose: (files: LocalDocument[]) => Promise<void>; onError: () => void;
}) {
  const desktop = usesDesktopDocumentPicker();
  const picking = useRef(false);
  const [dragOver, setDragOver] = useState(false);
  const classes = "bw-dropzone" + (busy ? " is-busy" : "") + (dragOver ? " is-dragover" : "");

  async function browse() {
    if (picking.current || busy) return;
    picking.current = true;
    try {
      const files = await browseDocuments(extensions, multiple);
      if (files.length) await onChoose(files);
    } catch {
      onError();
    } finally {
      picking.current = false;
    }
  }

  const text = <><strong>{label}</strong><small>{help}</small></>;
  return desktop ? (
    <button type="button" className={classes} aria-label={label} disabled={busy} onClick={() => void browse()}
      onDragOver={(event) => { event.preventDefault(); if (!busy) setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        if (!busy && !picking.current) void onChoose(webDocuments(event.dataTransfer.files));
      }}>
      {text}
    </button>
  ) : (
    <label className={classes} onDragEnter={() => setDragOver(true)}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false); }}
      onDrop={() => setDragOver(false)}>
      <input type="file" accept={accept} aria-label={label} multiple={multiple} disabled={busy}
        onChange={(event) => { void onChoose(webDocuments(event.target.files)); event.target.value = ""; }} />
      {text}
    </label>
  );
}
