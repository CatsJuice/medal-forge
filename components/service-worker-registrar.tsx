"use client";

import { useEffect } from "react";

const SERVICE_WORKER_PATH = "/sw.js";
const PRECACHE_MESSAGE_TYPE = "MEDAL_FORGE_PRECACHE_URLS";

function isCacheableSameOriginUrl(value: string) {
  try {
    const url = new URL(value, window.location.href);

    if (url.origin !== window.location.origin) {
      return false;
    }

    return (
      url.pathname === "/" ||
      url.pathname === "/offline.html" ||
      url.pathname === "/manifest.webmanifest" ||
      url.pathname.startsWith("/_next/") ||
      url.pathname.startsWith("/material-previews/") ||
      url.pathname.startsWith("/openusd/") ||
      url.pathname.startsWith("/api/showcase") ||
      url.pathname.startsWith("/work/")
    );
  } catch {
    return false;
  }
}

function normalizeUrl(value: string) {
  const url = new URL(value, window.location.href);

  return `${url.pathname}${url.search}`;
}

function collectLoadedResourceUrls() {
  const urls = new Set<string>([
    "/",
    "/offline.html",
    `${window.location.pathname}${window.location.search}`,
  ]);

  for (const entry of performance.getEntriesByType("resource")) {
    if (!("name" in entry) || !isCacheableSameOriginUrl(entry.name)) {
      continue;
    }

    urls.add(normalizeUrl(entry.name));
  }

  return Array.from(urls);
}

function postPrecacheUrls(registration: ServiceWorkerRegistration) {
  const urls = collectLoadedResourceUrls();
  const worker =
    registration.active ?? registration.waiting ?? registration.installing;

  worker?.postMessage({
    type: PRECACHE_MESSAGE_TYPE,
    urls,
  });

  navigator.serviceWorker.controller?.postMessage({
    type: PRECACHE_MESSAGE_TYPE,
    urls,
  });
}

function schedulePrecache(registration: ServiceWorkerRegistration) {
  const run = () => postPrecacheUrls(registration);

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 3000 });
    return;
  }

  globalThis.setTimeout(run, 1000);
}

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") {
      return;
    }

    if (!("serviceWorker" in navigator)) {
      return;
    }

    let isCancelled = false;

    async function registerServiceWorker() {
      try {
        const registration = await navigator.serviceWorker.register(
          SERVICE_WORKER_PATH,
          {
            scope: "/",
          },
        );

        if (isCancelled) {
          return;
        }

        schedulePrecache(registration);

        navigator.serviceWorker.ready
          .then((readyRegistration) => {
            if (!isCancelled) {
              schedulePrecache(readyRegistration);
            }
          })
          .catch(() => undefined);
      } catch {
        // Offline support is opportunistic; the app should keep running normally
        // if registration is blocked by the browser or the hosting environment.
      }
    }

    if (document.readyState === "complete") {
      void registerServiceWorker();
    } else {
      window.addEventListener("load", registerServiceWorker, { once: true });
    }

    return () => {
      isCancelled = true;
      window.removeEventListener("load", registerServiceWorker);
    };
  }, []);

  return null;
}
