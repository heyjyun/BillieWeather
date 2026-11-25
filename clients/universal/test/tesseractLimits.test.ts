// The WebAssembly engine's worker can stop answering (crash, missing file, killed by the system). Every wait
// on it ends: by its result, by a deadline, or by the person's cancellation.
import { TESSERACT_LIMITS, tesseractEngine } from "../src/services/ocr/tesseractEngine";

const { createWorker } = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock("tesseract.js", () => ({ createWorker, OEM: { LSTM_ONLY: 1 } }));

const never = () => new Promise<never>(() => undefined);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10, 8, 2, 0, 0, 0]);
const images = [1, 2].map((page) => ({ page, bytes: png, kind: "png" as const }));
const engine = () => tesseractEngine({ workerPath: "w", corePath: "c", langPath: "l", cacheMethod: "none" });
const read = (signal?: AbortSignal) => engine().recognize({ images, languages: ["en"], signal });
const line = { text: "TOTAL 1.00", confidence: 95, bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } };
const good = async () => ({ data: { blocks: [{ paragraphs: [{ lines: [{ ...line, words: [line] }] }] }] } });

beforeEach(() => { createWorker.mockReset(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

it("gives up when the engine does not start, and stops it if it starts later", async () => {
  let start!: (worker: unknown) => void;
  const terminate = vi.fn(async () => undefined);
  createWorker.mockReturnValue(new Promise((resolve) => { start = resolve; }));
  const result = read();
  await vi.advanceTimersByTimeAsync(TESSERACT_LIMITS.load);
  expect((await result).errors.map((error) => [error.page, error.code])).toEqual([[1, "recognition_failed"], [2, "recognition_failed"]]);
  start({ terminate });
  await vi.advanceTimersByTimeAsync(0);
  expect(terminate).toHaveBeenCalledOnce();
});

it("reports an engine that cannot be loaded", async () => {
  createWorker.mockRejectedValue("script missing");
  expect((await read()).errors).toHaveLength(2);
});

it("cancels at once while the engine is still starting", async () => {
  createWorker.mockImplementation(never);
  const controller = new AbortController();
  const result = read(controller.signal);
  await vi.advanceTimersByTimeAsync(10);
  controller.abort();
  expect((await result).errors.map((error) => error.code)).toEqual(["cancelled", "cancelled"]);
});

it("stops a worker that hangs on a page, keeps the pages already read, and refuses the rest", async () => {
  const terminate = vi.fn(async () => undefined);
  createWorker.mockResolvedValue({ recognize: vi.fn().mockImplementationOnce(good).mockImplementation(never), reinitialize: never, terminate });
  const result = read();
  await vi.advanceTimersByTimeAsync(TESSERACT_LIMITS.page + 10);
  const { pages, errors } = await result;
  expect(pages.map((page) => page.page)).toEqual([1]);
  expect(errors).toMatchObject([{ page: 2, code: "recognition_failed" }]);
  expect(terminate).toHaveBeenCalledOnce();
});

it("cancels at once during a page, and the worker is stopped", async () => {
  const terminate = vi.fn(async () => undefined);
  createWorker.mockResolvedValue({ recognize: never, reinitialize: never, terminate });
  const controller = new AbortController();
  const result = read(controller.signal);
  await vi.advanceTimersByTimeAsync(10);
  controller.abort();
  expect((await result).errors.map((error) => error.code)).toEqual(["cancelled", "cancelled"]);
  expect(terminate).toHaveBeenCalledOnce();
});

it("one failing page does not stop the others", async () => {
  createWorker.mockResolvedValue({ recognize: vi.fn().mockRejectedValueOnce("bad page").mockImplementation(good), reinitialize: never, terminate: async () => undefined });
  const { pages, errors } = await read();
  expect([pages.map((page) => page.page), errors.map((error) => error.page)]).toEqual([[2], [1]]);
});
