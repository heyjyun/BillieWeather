/**
 * File drag-and-drop in the installed apps.
 *
 * tauri.conf.json sets `dragDropEnabled: false`, so the operating system's file drops reach the
 * web view like in a browser: a file dropped on the Import drop zone (an <input type="file">) is
 * read exactly as if it had been picked, and no file-system path is ever exposed to JavaScript.
 * (With Tauri's own handler enabled, macOS and Windows swallow the drop and the input never sees it.)
 *
 * Without a handler, a file dropped anywhere else would make the web view open it in place of
 * the app. This guard cancels drops that are not on a file input. Nothing is read or sent.
 */
export function isFileInput(target: EventTarget | null): boolean {
  return typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement && target.type === "file" && !target.disabled;
}

export function installDropGuard(root: Document = document): () => void {
  const guard = (event: DragEvent) => {
    if (isFileInput(event.target)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  root.addEventListener("dragover", guard);
  root.addEventListener("drop", guard);
  return () => {
    root.removeEventListener("dragover", guard);
    root.removeEventListener("drop", guard);
  };
}
