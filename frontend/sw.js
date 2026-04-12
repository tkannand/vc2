const CACHE_NAME = "vc-v189";
const STATIC_ASSETS = [
    "/",
    "/css/style.css",
    "/js/app.js",
    "/js/api.js",
    "/js/auth.js",
    "/js/booth.js",
    "/js/ward.js",
    "/js/admin.js",
    "/js/notice.js",
    "/js/coupon.js",
    "/js/scheme.js",
    "/js/telecaller.js",
    "/js/i18n.js",
    "/js/timer.js",
    "/manifest.json",
];

self.addEventListener("install", (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener("activate", (e) => {
    e.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Network-first strategy: try network, fallback to cache
self.addEventListener("fetch", (e) => {
    if (e.request.url.includes("/api/")) {
        return;
    }
    e.respondWith(
        fetch(e.request).then((response) => {
            if (response && response.status === 200) {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(e.request, clone));
            }
            return response;
        }).catch(() => caches.match(e.request))
    );
});
