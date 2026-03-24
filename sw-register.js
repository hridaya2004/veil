// Service worker registration (non-blocking, outside the ES module)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}