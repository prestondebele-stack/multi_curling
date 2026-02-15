// Service Worker for Capital Curling Club PWA
const CACHE_NAME = 'curling-v66';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './physics.js',
    './bot.js',
    './network.js',
    './game.js',
    './olympic-rings.svg',
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

    // JS/CSS: network first, fall back to cache (ensures fresh code)
    if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
        event.respondWith(
            fetch(event.request).then((response) => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, clone);
                });
                return response;
            }).catch(() => caches.match(event.request))
        );
        return;
    }

    // Other assets (images, etc.): cache first, then network
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

// Push notification: only show if no focused game tab exists
self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {};
    const title = data.title || "It's your turn!";
    const body = data.body || 'Your opponent has thrown. Time to deliver your stone!';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            // If any game tab is focused, skip the notification
            const hasFocused = clients.some((c) => c.focused);
            if (hasFocused) return;

            return self.registration.showNotification(title, {
                body,
                icon: './olympic-rings.svg',
                badge: './olympic-rings.svg',
                tag: 'turn-notification',
                renotify: true,
                vibrate: [200, 100, 200],
            });
        })
    );
});

// Notification click: focus existing game tab or open a new one
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            // Try to focus an existing game tab
            for (const client of clients) {
                if (client.url && client.focus) {
                    return client.focus();
                }
            }
            // No existing tab — open the game
            return self.clients.openWindow('./');
        })
    );
});
