// Service Worker for Capital Curling Club PWA
const CACHE_NAME = 'curling-v13';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './physics.js',
    './bot.js',
    './network.js',
    './game.js',
    './ccc-final-png_orig.png',
    './manifest.json'
];

// Install: cache all core assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
    // Activate immediately (don't wait for old SW to finish)
    self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            );
        })
    );
    // Take control of all pages immediately
    self.clients.claim();
});

// Fetch: network-first strategy for HTML, cache-first for assets
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // HTML pages: try network first, fall back to cache
    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    // Update cache with fresh version
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, clone);
                    });
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // Assets (JS, CSS, images): cache first, then network
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) {
                // Return cache but also update in background
                fetch(event.request).then((response) => {
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(event.request, response);
                    });
                }).catch(() => { });
                return cached;
            }
            // Not cached — fetch from network and cache it
            return fetch(event.request).then((response) => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, clone);
                });
                return response;
            });
        })
    );
});
