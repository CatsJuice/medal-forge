const APP_VERSION = "2026-06-28-v1";
const CORE_CACHE = `medal-forge-core-${APP_VERSION}`;
const RUNTIME_CACHE = `medal-forge-runtime-${APP_VERSION}`;
const PRECACHE_MESSAGE_TYPE = "MEDAL_FORGE_PRECACHE_URLS";

const CORE_ASSETS = [
  "/",
  "/offline.html",
  "/material-previews/aged-silver.svg",
  "/material-previews/blackened-steel.svg",
  "/material-previews/brushed-gold.svg",
  "/material-previews/copper.svg",
  "/material-previews/matte-polymer.svg",
  "/material-previews/white-ceramic.svg",
  "/openusd/openusd_pxr_wasm.js",
  "/openusd/openusd_pxr_wasm.wasm",
];

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isCacheableResponse(response) {
  return response && response.status === 200 && response.type !== "opaqueredirect";
}

function isNavigationRequest(request) {
  return (
    request.mode === "navigate" ||
    (request.headers.get("accept") ?? "").includes("text/html")
  );
}

function isStaticAssetRequest(request, url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/material-previews/") ||
    url.pathname.startsWith("/openusd/") ||
    request.destination === "font" ||
    request.destination === "image" ||
    request.destination === "script" ||
    request.destination === "style" ||
    request.destination === "worker"
  );
}

async function putInCache(cacheName, request, response) {
  if (!isCacheableResponse(response)) {
    return;
  }

  const cache = await caches.open(cacheName);
  await cache.put(request, response);
}

async function cacheFirst(request) {
  const cached = await caches.match(request);

  if (cached) {
    return cached;
  }

  const response = await fetch(request);
  await putInCache(RUNTIME_CACHE, request, response.clone());

  return response;
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    await putInCache(RUNTIME_CACHE, request, response.clone());

    return response;
  } catch (error) {
    const cached = await caches.match(request);

    if (cached) {
      return cached;
    }

    throw error;
  }
}

async function navigationNetworkFirst(request) {
  try {
    const response = await fetch(request);
    await putInCache(RUNTIME_CACHE, request, response.clone());

    return response;
  } catch {
    const cachedRoute = await caches.match(request);

    if (cachedRoute) {
      return cachedRoute;
    }

    const cachedHome = await caches.match("/");

    if (cachedHome) {
      return cachedHome;
    }

    return caches.match("/offline.html");
  }
}

async function apiNetworkFirst(request) {
  try {
    const response = await fetch(request);
    await putInCache(RUNTIME_CACHE, request, response.clone());

    return response;
  } catch {
    const cached = await caches.match(request);

    if (cached) {
      return cached;
    }

    return new Response(
      JSON.stringify({
        error: "offline",
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
        status: 503,
      },
    );
  }
}

async function precacheCoreAssets() {
  const cache = await caches.open(CORE_CACHE);

  await Promise.allSettled(
    CORE_ASSETS.map((url) =>
      cache.add(
        new Request(url, {
          cache: "reload",
          credentials: "same-origin",
        }),
      ),
    ),
  );
}

async function precacheUrls(urls) {
  const cache = await caches.open(RUNTIME_CACHE);

  await Promise.allSettled(
    urls.map(async (value) => {
      const url = new URL(value, self.location.origin);

      if (!isSameOrigin(url)) {
        return;
      }

      const request = new Request(`${url.pathname}${url.search}`, {
        cache: "reload",
        credentials: "same-origin",
      });
      const response = await fetch(request);

      if (isCacheableResponse(response)) {
        await cache.put(request, response);
      }
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    precacheCoreAssets().then(() => {
      return self.skipWaiting();
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => {
              return (
                cacheName.startsWith("medal-forge-") &&
                cacheName !== CORE_CACHE &&
                cacheName !== RUNTIME_CACHE
              );
            })
            .map((cacheName) => caches.delete(cacheName)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data;

  if (
    !data ||
    data.type !== PRECACHE_MESSAGE_TYPE ||
    !Array.isArray(data.urls)
  ) {
    return;
  }

  event.waitUntil(precacheUrls(data.urls));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  if (!isSameOrigin(url) || url.pathname === "/sw.js") {
    return;
  }

  if (isNavigationRequest(request)) {
    event.respondWith(navigationNetworkFirst(request));
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(apiNetworkFirst(request));
    return;
  }

  if (isStaticAssetRequest(request, url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  event.respondWith(networkFirst(request));
});
