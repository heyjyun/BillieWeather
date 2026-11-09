// @vitest-environment jsdom
import { fileForSlot, freeSlot, loadRegistry, MAX_DATABASES, saveRegistry } from "../src/services/databases";

beforeEach(() => localStorage.clear());

describe("database list on this device", () => {
  it("starts with the first database, which keeps the original file name", () => {
    expect(loadRegistry()).toEqual({ entries: [{ id: "1", file: "billieweather.db" }], active: "1" });
    expect(fileForSlot(3)).toBe("billieweather-3.db");
  });

  it("remembers the list and which database is in use", () => {
    saveRegistry({ entries: [{ id: "1", file: fileForSlot(1) }, { id: "3", file: fileForSlot(3) }], active: "3" });
    expect(loadRegistry()).toEqual({ entries: [{ id: "1", file: "billieweather.db" }, { id: "3", file: "billieweather-3.db" }], active: "3" });
  });

  it("ignores damaged or out-of-range entries and falls back to a database that exists", () => {
    localStorage.setItem("billie.databases", JSON.stringify({ ids: [2, 2, 99, "../etc", 5], active: 7 }));
    expect(loadRegistry()).toEqual({ entries: [{ id: "2", file: "billieweather-2.db" }, { id: "5", file: "billieweather-5.db" }], active: "2" });
    localStorage.setItem("billie.databases", "not json");
    expect(loadRegistry().entries.length).toBe(1);
  });

  it("hands out the lowest free slot and stops at the limit", () => {
    const registry = loadRegistry();
    expect(freeSlot(registry)).toEqual({ id: "2", file: "billieweather-2.db" });
    const full = { entries: Array.from({ length: MAX_DATABASES }, (_, i) => ({ id: String(i + 1), file: fileForSlot(i + 1) })), active: "1" };
    expect(freeSlot(full)).toBeNull();
  });
});
