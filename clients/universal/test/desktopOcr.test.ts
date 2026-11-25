import { appleVisionDesktopEngine } from "../src/services/ocr/nativeEngines";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const options = { images: [{ page: 1, bytes: new Uint8Array([1]), kind: "png" as const }], languages: [] };

beforeEach(() => { invoke.mockReset(); invoke.mockImplementation(() => new Promise(() => {})); });
afterEach(() => { vi.useRealTimers(); });

it("stops waiting for an unresponsive Vision request after the deadline", async () => {
  vi.useFakeTimers();
  const result = appleVisionDesktopEngine().recognize(options);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await result).toMatchObject({ pages: [], errors: [{ page: 1, code: "recognition_failed" }] });
});

it("returns cancellation immediately while a Vision request is still pending", async () => {
  const controller = new AbortController();
  const fallback = vi.fn();
  const result = appleVisionDesktopEngine(fallback).recognize({ ...options, signal: controller.signal });
  await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
  controller.abort();
  expect(await result).toMatchObject({ pages: [], errors: [{ page: 1, code: "cancelled" }] });
  expect(fallback).not.toHaveBeenCalled();
  const job = invoke.mock.calls[0][2].headers["x-ocr-job-id"];
  expect(invoke).toHaveBeenCalledWith("ocr_cancel_image", { job });
});

it("uses the on-device fallback once for all pages after a Vision timeout", async () => {
  vi.useFakeTimers();
  const fallbackResult = { engine: { id: "tesseract-js", version: "test" }, pages: [], languages: [], errors: [], unsupported: [] };
  const recognize = vi.fn(async () => fallbackResult);
  const engine = appleVisionDesktopEngine(async () => ({
    info: { id: "tesseract-js", location: "device", languages: [] }, recognize,
  }));
  const batch = { ...options, images: [...options.images, { ...options.images[0], page: 2 }] };
  const result = engine.recognize(batch);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await result).toBe(fallbackResult);
  const job = invoke.mock.calls[0][2].headers["x-ocr-job-id"];
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["ocr_recognize_image", "ocr_cancel_image"]);
  expect(invoke).toHaveBeenCalledWith("ocr_cancel_image", { job });
  expect(recognize).toHaveBeenCalledExactlyOnceWith(batch);
});

it("honors the native deadline without dispatching the remaining pages", async () => {
  invoke.mockRejectedValue("ocr_timeout");
  const fallbackResult = { engine: { id: "tesseract-js", version: "test" }, pages: [], languages: [], errors: [], unsupported: [] };
  const recognize = vi.fn(async () => fallbackResult);
  const engine = appleVisionDesktopEngine(async () => ({
    info: { id: "tesseract-js", location: "device", languages: [] }, recognize,
  }));
  const batch = { ...options, images: [...options.images, { ...options.images[0], page: 2 }] };
  expect(await engine.recognize(batch)).toBe(fallbackResult);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["ocr_recognize_image"]);
});

it("reads this batch with the fallback while the models are still being prepared, then uses Vision", async () => {
  const page = { page: 1, width: 1, height: 1, rotation: 0, lines: [] };
  const vision = { engine: { id: "apple-vision", version: "v" }, languages: [], pages: [page], errors: [], unsupported: [] };
  invoke.mockRejectedValueOnce("ocr_preparing").mockResolvedValueOnce(vision);
  const fallbackResult = { engine: { id: "tesseract-js", version: "test" }, pages: [], languages: [], errors: [], unsupported: [] };
  const recognize = vi.fn(async () => fallbackResult);
  const engine = appleVisionDesktopEngine(async () => ({ info: { id: "tesseract-js", location: "device", languages: [] }, recognize }));
  expect(await engine.recognize(options)).toBe(fallbackResult);
  expect(await engine.recognize(options)).toMatchObject({ engine: { id: "apple-vision" }, pages: [{ page: 1 }] });
  expect(recognize).toHaveBeenCalledOnce();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["ocr_recognize_image", "ocr_recognize_image"]);
});

const pageOf = (page: number) => ({ page, width: 1, height: 1, rotation: 0, lines: [] });
const visionPage = (page: number) => ({ engine: { id: "apple-vision", version: "v" }, languages: [], pages: [pageOf(page)], errors: [], unsupported: [] });
const threePages = { ...options, images: [1, 2, 3].map((page) => ({ ...options.images[0], page })) };

it("sends only the pages Vision could not read to the fallback and keeps the others, in order", async () => {
  invoke.mockResolvedValueOnce(visionPage(1)).mockRejectedValueOnce("ocr_failed").mockResolvedValueOnce(visionPage(3));
  const recognize = vi.fn(async () => ({ engine: { id: "tesseract-js", version: "t" }, languages: [], pages: [pageOf(2)], errors: [], unsupported: [] }));
  const result = await appleVisionDesktopEngine(async () => ({ info: { id: "tesseract-js", location: "device", languages: [] }, recognize }) as never).recognize(threePages);
  expect(recognize).toHaveBeenCalledExactlyOnceWith({ ...threePages, images: [threePages.images[1]] });
  expect(result.pages.map((page) => page.page)).toEqual([1, 2, 3]);
  expect(result.errors).toEqual([]);
});

it.each([
  ["cannot start", async () => { throw new Error("no assets"); }],
  ["crashes", async () => ({ info: { id: "tesseract-js", location: "device", languages: [] }, recognize: async () => { throw new Error("wasm"); } })],
])("keeps what Vision read and reports the rest when the fallback %s", async (_name, fallback) => {
  invoke.mockResolvedValueOnce(visionPage(1)).mockRejectedValueOnce("ocr_failed").mockResolvedValueOnce(visionPage(3));
  const result = await appleVisionDesktopEngine(fallback as never).recognize(threePages);
  expect(result.pages.map((page) => page.page)).toEqual([1, 3]);
  expect(result.errors).toMatchObject([{ page: 2, code: "recognition_failed" }]);
});

it("never sends a document to a fallback that is not on this device", async () => {
  invoke.mockRejectedValue("ocr_failed");
  const recognize = vi.fn();
  const result = await appleVisionDesktopEngine(async () => ({ info: { id: "cloud", location: "cloud", languages: [] }, recognize }) as never).recognize(threePages);
  expect(recognize).not.toHaveBeenCalled();
  expect(result.errors).toHaveLength(3);
});
