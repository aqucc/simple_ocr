/* ラベルOCR — minimal service worker (PWA / home-screen).
 *
 * Goals: make the app installable and let the shell open offline. It does NOT
 * try to precache the OCR engine/models (tens of MB from a CDN + self-hosted);
 * those stay on the network / HTTP cache. Same-origin assets (index.html's
 * resources, the japan model under models/) are cached at runtime so a second
 * visit — and offline jpn OCR after one use — works.
 *
 * Scope is the directory this file is served from (e.g. /simple_ocr/).
 */
const CACHE = "labelocr-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Don't let one missing file abort the whole install.
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  // Navigations: network-first (always get fresh app when online), fall back to
  // the cached shell offline.
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("./index.html")));
    return;
  }

  const url = new URL(req.url);
  // Same-origin assets (shell + models/): cache-first, then network + store.
  // Cross-origin (the CDN engine/models) is left to the browser/network.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match("./index.html")))
    );
  }
});
