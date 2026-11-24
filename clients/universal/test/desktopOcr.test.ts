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
