/* Service worker: caches the app shell so the page opens offline.
 * Live data (BusRadar API) and map tiles are never intercepted or cached here.
 * Bump VERSION whenever the shell files change in a way that must reach users at once. */
const VERSION = "v4";
const CACHE = "nz-shell-" + VERSION;
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon-512.png", "apple-touch-icon.png"];
const LEAFLET = [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    // A CDN hiccup must not block the installation.
    await Promise.allSettled(LEAFLET.map(url => cache.add(new Request(url, { mode: "cors" }))));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith("nz-shell-") && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isShell = url.origin === self.location.origin;
  const isLeaflet = url.href.startsWith("https://unpkg.com/leaflet@1.9.4/");
  if (!isShell && !isLeaflet) return; // API requests and map tiles go straight to the network

  if (req.mode === "navigate") {
    // Network first so updates show up immediately; cached page when offline.
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put("index.html", copy));
          return res;
        })
        .catch(() => caches.match("index.html").then(hit => hit || caches.match("./")))
    );
    return;
  }

  // Everything else: serve from cache, refresh in the background.
  event.respondWith(caches.match(req).then(hit => {
    const network = fetch(req)
      .then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => null);
    event.waitUntil(network);
    return hit || network.then(res => res || Response.error());
  }));
});
