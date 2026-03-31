// Service Worker for Online Curling PWA
const CACHE_NAME = 'curling-v129b';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './physics.js',
    './physics-worker.js',
    './bot.js',
    './network.js',
    './game.js',
    './olympic-rings.svg',
    './logo.png',
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

// Push notification: only skip if a game tab is actively focused and visible
self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {};
    const title = data.title || "It's your turn!";
    const body = data.body || 'Your opponent has thrown. Time to deliver your stone!';
    const gameCode = data.gameCode || '';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            // Only skip if the user is actively looking at the game tab
            const hasFocusedAndVisible = clients.some((c) => c.focused && c.visibilityState === 'visible');
            if (hasFocusedAndVisible) return;

            return self.registration.showNotification(title, {
                body,
                icon: './olympic-rings.svg',
                badge: './olympic-rings.svg',
                // Per-game tag so multiple games get separate notifications
                tag: gameCode ? `turn-${gameCode}` : 'turn-notification',
                renotify: true,
                vibrate: [200, 100, 200],
                data: { gameCode }, // Pass to click handler
                actions: gameCode ? [{ action: 'play', title: 'Play Now' }] : [],
            });
        })
    );
});

// Notification click: deep-link to the specific game
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const gameCode = event.notification.data?.gameCode || '';
    const targetUrl = gameCode ? `./?game=${gameCode}` : './';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            // Try to focus an existing game tab and navigate it
            for (const client of clients) {
                if (client.url && client.focus) {
                    // Navigate to the game if we have a code
                    if (gameCode && client.navigate) {
                        return client.navigate(targetUrl).then((c) => c.focus());
                    }
                    return client.focus();
                }
            }
            // No existing tab — open the game
            return self.clients.openWindow(targetUrl);
        })
    );
});
