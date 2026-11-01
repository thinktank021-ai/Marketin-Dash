// Bump the shell cache whenever a runtime crash fix ships so stale JS/CSS cannot survive a deploy.
const STATIC_CACHE = "donyagardi-static-v3";
const DATA_CACHE = "donyagardi-data-v1";
const SHELL_ROUTES = ["/", "/login", "/manifest.webmanifest"];

const isSameOrigin = (request) => new URL(request.url).origin === self.location.origin;
const isApiRequest = (request) => new URL(request.url).pathname.startsWith("/api/");
const isStaticAsset = (request) => /\.(?:js|css|woff2?|png|jpg|jpeg|webp|svg|ico)$/i.test(new URL(request.url).pathname);
const cacheResponse = async (cacheName, request, response) => {
  if (!response || !response.ok) return response;
  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());
  return response;
};

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.allSettled(
      SHELL_ROUTES.map(async (route) => {
        const response = await fetch(route, { cache: "no-store" });
        await cacheResponse(STATIC_CACHE, route, response);
      }),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("donyagardi-") && ![STATIC_CACHE, DATA_CACHE].includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || !isSameOrigin(event.request)) return;

  if (isApiRequest(event.request)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => cacheResponse(DATA_CACHE, event.request, response))
        .catch(() => caches.match(event.request)),
    );
    return;
  }

  if (isStaticAsset(event.request) || event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => cacheResponse(STATIC_CACHE, event.request, response))
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/"))),
    );
  }
});
