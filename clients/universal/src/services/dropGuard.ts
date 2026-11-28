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
 *
 * Drags that start inside the app (an element with `draggable`, e.g. reordering the sidebar in
 * Settings › Sidebar customization) are left to their own handlers: cancelling them here, with
 * dropEffect "none", made every in-app drop impossible (2026-11-28). Anything dragged in from outside
 * the page (files, text, links) is still cancelled exactly as before.
 */
export function isFileInput(target: EventTarget | null): boolean {
  return typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement && target.type === "file" && !target.disabled;
}

export function installDropGuard(root: Document = document): () => void {
  // Set by a dragstart in this page and cleared by its dragend: an external drag has no dragstart here.
  let internal = false;
  const start = () => { internal = true; };
  const end = () => { internal = false; };
  const guard = (event: DragEvent) => {
    if (internal || isFileInput(event.target)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  root.addEventListener("dragstart", start, true);
  root.addEventListener("dragend", end, true);
  root.addEventListener("dragover", guard);
  root.addEventListener("drop", guard);
  return () => {
    root.removeEventListener("dragstart", start, true);
    root.removeEventListener("dragend", end, true);
    root.removeEventListener("dragover", guard);
    root.removeEventListener("drop", guard);
  };
}
