// @vitest-environment jsdom
// Files dropped on the Import drop zone reach its <input type="file">; drops anywhere else are
// cancelled so the web view never opens the file in place of the app.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installDropGuard, isFileInput } from "../src/services/dropGuard";

function dropOn(target: Element, type: "dragover" | "drop") {
  const event = new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("drop guard", () => {
  let uninstall: () => void;
  beforeEach(() => {
    document.body.innerHTML = `<main><p id="text">Dashboard</p><label class="bw-dropzone"><input id="file" type="file"></label><input id="off" type="file" disabled><input id="name" type="text"></main>`;
    uninstall = installDropGuard(document);
  });
  afterEach(() => uninstall());

  it("lets drops on an enabled file input through", () => {
    expect(isFileInput(document.getElementById("file"))).toBe(true);
    expect(dropOn(document.getElementById("file")!, "dragover")).toBe(false);
    expect(dropOn(document.getElementById("file")!, "drop")).toBe(false);
  });

  it("cancels drops anywhere else, including busy (disabled) inputs and text fields", () => {
    for (const id of ["text", "off", "name"]) {
      expect(dropOn(document.getElementById(id)!, "dragover"), id).toBe(true);
      expect(dropOn(document.getElementById(id)!, "drop"), id).toBe(true);
    }
  });

  it("can be removed", () => {
    uninstall();
    expect(dropOn(document.getElementById("text")!, "drop")).toBe(false);
    uninstall = installDropGuard(document);
  });
});

describe("Tauri window", () => {
  it("leaves file drops to the web view (no native handler, so no file paths reach JavaScript)", () => {
    const config = JSON.parse(readFileSync(join(__dirname, "../src-tauri/tauri.conf.json"), "utf8"));
    expect(config.app.windows.every((window: { dragDropEnabled?: boolean }) => window.dragDropEnabled === false)).toBe(true);
  });
});
