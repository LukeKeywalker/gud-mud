const CACHE = "mud-v1";

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/game_core/") && url.hostname !== "cdn.jsdelivr.net") return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const fetched = await fetch(req);
      if (fetched.ok || fetched.type === "opaque") c.put(req, fetched.clone());
      return fetched;
    })
  );
});
