// ============================================================
// Veil Service Worker
//
// Caching strategy:
// 1. Precache: app shell files (HTML, CSS, JS) — installed with SW
// 2. Cache-first: CDN resources (PDF.js, pdf-lib, fontkit, fonts)
//    — cached on first use, served from cache forever after
// 3. Network-first: Google Fonts CSS (may update font subsets)
//
// Update strategy: NO skipWaiting(). Veil is a document app — the
// user may have a PDF open for days. Forcing activation while
// reading could invalidate cached worker scripts and crash the
// session. The new SW activates naturally when all tabs close.
// ============================================================

const CACHE_NAME = 'veil-v1';

// App shell: small, essential, precached at install
const PRECACHE_URLS = [
  '/',
  '/reader.html',
  '/index.html',
  '/app.js',
  '/core.js',
  '/style.css',
  '/landing.css',
  '/landing.js',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// CDN resources: cached on first use (cache-first strategy).
// These URLs are versioned — they never change once published.
const CDN_CACHE_PATTERNS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'esm.sh',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

// ============================================================
// Install: precache app shell
// ============================================================

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});

// ============================================================
// Activate: clean up old caches from previous versions
// ============================================================

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
});

// ============================================================
// Fetch: serve from cache, fall back to network
// ============================================================

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Skip chrome-extension, blob, and data URLs
  if (!url.protocol.startsWith('http')) return;

  // CDN resources: cache-first (versioned URLs, immutable)
  if (CDN_CACHE_PATTERNS.some((pattern) => url.hostname.includes(pattern))) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // App shell (same origin): network-first with cache fallback.
  // This ensures the user gets the latest version when online,
  // but the app still works offline from the precache.
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(event.request));
    return;
  }
});

// ============================================================
// Caching strategies
// ============================================================

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // Only cache successful responses (not opaque or errors)
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Network failed and no cache — return a basic error
    return new Response('Network error', { status: 503 });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    // Update cache with fresh response
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Network failed — serve from cache (offline mode)
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('Offline', { status: 503 });
  }
}
