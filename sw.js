// Lets the app open without internet. Tries the network first so new versions
// show up right away; uses the saved copy when offline or when the network is
// too slow to answer.
const CACHE = "journal-v1";
const SLOW_NETWORK_MS = 4000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;

  // "no-cache" = always ask the server whether the file changed, so an update
  // never mixes old and new files.
  const network = fetch(req, { cache: "no-cache" }).then(res => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(cache => cache.put(req, copy));
    }
    return res;
  });
  network.catch(() => {});

  const slow = new Promise(resolve => setTimeout(resolve, SLOW_NETWORK_MS)).then(() => caches.match(req));

  e.respondWith((async () => {
    try {
      return (await Promise.race([network, slow])) || (await network);
    } catch (err) {
      return (await caches.match(req)) || Response.error();
    }
  })());
});
