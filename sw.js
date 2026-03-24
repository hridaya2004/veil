/* DESIGN
   ------
   * This service worker runs in the background, separate from the web
   * page, intercepting every network request the app makes. When a
   * request matches something in the local cache, it serves the cached
   * version instead of going to the network. This is what lets veil
   * open PDFs without an internet connection after the first visit.
   *
   * The SW lifecycle has three phases: install (where I download and
   * cache the essential files upfront, called "precaching"), activate
   * (where I clean up caches from previous versions), and fetch (where
   * every network request gets routed to the right caching strategy).
   *
   * I chose a three-tier caching strategy because different resources
   * have different update patterns:
   *
   * - App shell (HTML, CSS, JS): changes with every deploy, so I use
   *   network-first. The user gets the latest version when online,
   *   the cached version when offline.
   *
   * - CDN libraries (PDF.js, Tesseract, pdf-lib, fontkit, Noto Sans):
   *   versioned URLs that never change once published. Cache-first
   *   means they're downloaded once and served from cache forever.
   *
   * - Google Fonts CSS: network-first because Google serves different
   *   CSS depending on the user's browser (different font formats
   *   for Chrome vs Safari). Caching one browser's CSS would break
   *   fonts for another.
   *
   * I deliberately chose NOT to precache the heavy libraries (Tesseract
   * WASM is ~3MB, language packs ~2MB each). Precaching them would
   * block the install event for 30+ seconds on slow connections. Instead,
   * they're cached on first use: the first OCR takes a moment to
   * download, then it's instant forever after.
   *
   * Update strategy: NO skipWaiting(). Most tutorials tell you to call
   * skipWaiting() so the new SW takes control immediately. I deliberately
   * avoid this because veil is a document app where the user may have
   * a PDF open for hours or days. skipWaiting() forces the new SW to
   * replace the old one while the page is still running. If the new
   * version changed any JS files, the running page would try to load
   * modules from the new cache that don't match the old page's imports,
   * potentially crashing the session mid-read.
   *
   * Instead, the new SW waits in "installed" state and activates
   * naturally when all tabs close and reopen.
   * No banner, no badge, no "update available" notification.
   * The user never knows an update happened.
   *
   * The file follows this flow:
   *
   * 1. CONSTANTS (lines 60-101)
   * 2. INSTALL (lines 104-110)
   * 3. ACTIVATE (lines 113-128)
   * 4. FETCH (lines 131-169)
   * 5. CACHING STRATEGIES (lines 172-219)
*/


// --- CONSTANTS ---

const CACHE_NAME = 'veil-v1';

/*
 * App shell: the files that make veil run. Precached at install so
 * the app works offline immediately after first visit.
 * Paths are relative to the SW location so the app works on any
 * deploy path (root domain, GitHub Pages subpath, etc.)
 */
const PRECACHE_URLS = [
  './',
  './reader.html',
  './index.html',
  './app.js',
  './ocr.js',
  './export.js',
  './session.js',
  './core.js',
  './style.css',
  './landing.css',
  './landing.js',
  './sw-register.js',
  './manifest.json',
  './icon/favicon.svg',
  './icon/manifest-icon.png',
  './icon/manifest.png',
  './icon/apple-touch-icon.png',
];

/*
 * CDN hostnames that serve versioned, immutable resources.
 * Matched by exact hostname or subdomain (e.g. "cdn.jsdelivr.net"
 * also matches "fastly.cdn.jsdelivr.net"). Cache-first because
 * once a versioned URL is published, its content never changes
 */
const CDN_CACHE_PATTERNS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'esm.sh',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];


// --- INSTALL ---

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
});


// --- ACTIVATE ---

// When a new version of the SW activates, delete caches from the
// previous version. This is the only cleanup needed because the
// new SW precaches its own resources during install
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


// --- FETCH ---

/*
 * The fetch handler routes each request to the right caching strategy.
 * Order matters: Google Fonts is checked first (special case), then
 * CDN resources (cache-first), then same-origin (network-first).
 * Anything that doesn't match falls through without interception
 */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Only intercept HTTP/HTTPS requests, skip everything else
  if (!url.protocol.startsWith('http')) return;

  // Google Fonts serves different CSS to different browsers (WOFF2 for
  // Chrome, TTF for older Safari). Same URL, different response. So I
  // always try the network first to get the right format for this browser
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // CDN resources: cache-first (versioned URLs, immutable)
  if (CDN_CACHE_PATTERNS.some((pattern) => url.hostname === pattern || url.hostname.endsWith('.' + pattern))) {
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


// --- CACHING STRATEGIES ---

/*
 * cache-first: check the cache, only go to network on miss.
 * Used for CDN resources where the URL contains the version number,
 * so the content is guaranteed to be immutable
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // I clone the response because its body can only be read once (it's
    // consumed like a stream). Without the clone, saving to cache would
    // exhaust the body and the browser would receive nothing
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Network failed and no cache, return a basic error
    return new Response('Network error', { status: 503 });
  }
}

/*
 * network-first: try the network, fall back to cache on failure.
 * Used for app shell files (HTML, CSS, JS) that change with deploys
 * and for Google Fonts CSS that varies by browser
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    // Clone before caching (see cacheFirst for why)
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Network failed, serve from cache (offline mode)
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('Offline', { status: 503 });
  }
}