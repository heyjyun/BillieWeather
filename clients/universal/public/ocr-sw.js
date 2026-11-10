// Offline cache for the on-device OCR engine in browsers (not used inside the Tauri apps, whose
// assets are bundled files). Caches ONLY this origin's /ocr/ files: the Tesseract worker, WASM
// core and language models. Documents, images, recognized text and financial data are never seen
// or stored here: requests for anything else pass straight through.
const CACHE = "billie-ocr-assets-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("billie-ocr-assets-") && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith("/ocr/")) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(event.request);
    if (hit) return hit;
    const response = await fetch(event.request);
    if (response.ok) await cache.put(event.request, response.clone());
    return response;
  })());
});
