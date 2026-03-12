// ============================================================
// Smart Dark PDF Reader - v0.2
//
// Double buffering + page cache with pre-rendering.
// No intermediate broken frames. Instant page transitions
// when the next page is already cached.
//
// Run with a local server:
//   python3 -m http.server 8000
//   then open http://localhost:8000
// ============================================================

import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.worker.min.mjs';

// ============================================================
// Constants
// ============================================================

const OPS = pdfjsLib.OPS;
const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

// How many pages to keep cached around the current page.
// Buffer: 1 behind, 2 ahead = 4 total (including current).
const CACHE_BEHIND = 1;
const CACHE_AHEAD = 2;
const CACHE_MAX_DISTANCE = 3;

// ============================================================
// Matrix Utilities
// ============================================================

function multiplyMatrices(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

function transformPoint(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

// An image in PDF occupies the unit square [0,0]-[1,1].
// The CTM scales/positions it in PDF user space.
// The viewport transform converts to screen (backing store) pixels.
function computeImageBounds(ctm, viewportTransform) {
  const final = multiplyMatrices(viewportTransform, ctm);

  const c0 = transformPoint(final, 0, 0);
  const c1 = transformPoint(final, 1, 0);
  const c2 = transformPoint(final, 1, 1);
  const c3 = transformPoint(final, 0, 1);

  const xs = [c0[0], c1[0], c2[0], c3[0]];
  const ys = [c0[1], c1[1], c2[1], c3[1]];

  return {
    x: Math.floor(Math.min(...xs)),
    y: Math.floor(Math.min(...ys)),
    width: Math.ceil(Math.max(...xs)) - Math.floor(Math.min(...xs)),
    height: Math.ceil(Math.max(...ys)) - Math.floor(Math.min(...ys)),
  };
}

// ============================================================
// State
// ============================================================

let pdfDoc = null;
let currentPageNum = 1;
let currentScale = 0;

// Monotonically increasing ID. Incremented on every navigation
// or resize. Any async work tagged with a stale ID is discarded.
let navigationId = 0;

// Tracks which pages have dark mode disabled by the user.
const lightPages = new Set();

// Page cache: Map<pageNum, CacheEntry>
// CacheEntry = { mainBitmap: ImageBitmap, overlayBitmap: ImageBitmap,
//                scale: number, width: number, height: number }
const pageCache = new Map();

// ============================================================
// DOM References
// ============================================================

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const reader = document.getElementById('reader');
const pdfCanvas = document.getElementById('pdf-canvas');
const overlayCanvas = document.getElementById('overlay-canvas');
const pdfCtx = pdfCanvas.getContext('2d');
const overlayCtx = overlayCanvas.getContext('2d');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnToggle = document.getElementById('btn-toggle');
const btnFile = document.getElementById('btn-file');
const pageInfo = document.getElementById('page-info');
const iconDark = document.getElementById('icon-dark');
const iconLight = document.getElementById('icon-light');
const loadingIndicator = document.getElementById('loading-indicator');
const pageWrapper = document.getElementById('page-wrapper');

// ============================================================
// File Handling
// ============================================================

function handleFile(file) {
  if (!file || file.type !== 'application/pdf') return;

  const fr = new FileReader();
  fr.onload = async (e) => {
    await loadPDF(new Uint8Array(e.target.result));
  };
  fr.readAsArrayBuffer(file);
}

// ============================================================
// PDF Loading
// ============================================================

async function loadPDF(data) {
  try {
    if (pdfDoc) pdfDoc.destroy();
    invalidateCache();

    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    currentPageNum = 1;
    lightPages.clear();

    dropZone.hidden = true;
    reader.hidden = false;

    await renderCurrentPage();
  } catch (err) {
    console.error('Failed to load PDF:', err);
    alert('Could not load this PDF. It may be corrupted or password-protected.');
  }
}

// ============================================================
// Scale Calculation
// ============================================================

function calculateScale(page) {
  const vp = page.getViewport({ scale: 1 });
  const toolbarH = 48;
  const padding = 48;
  const availW = window.innerWidth - padding;
  const availH = window.innerHeight - toolbarH - padding;
  return Math.min(availW / vp.width, availH / vp.height, 3);
}

// ============================================================
// Page Cache Management
// ============================================================

function invalidateCache() {
  for (const entry of pageCache.values()) {
    entry.mainBitmap.close();
    entry.overlayBitmap.close();
  }
  pageCache.clear();
}

function evictDistantPages(centerPage) {
  for (const [num, entry] of pageCache) {
    if (Math.abs(num - centerPage) > CACHE_MAX_DISTANCE) {
      entry.mainBitmap.close();
      entry.overlayBitmap.close();
      pageCache.delete(num);
    }
  }
}

function getCachedPage(pageNum, scale) {
  const entry = pageCache.get(pageNum);
  if (entry && entry.scale === scale) return entry;
  return null;
}

// ============================================================
// Offscreen Page Rendering
//
// Renders a page to temporary offscreen canvases, extracts
// image regions, composites the overlay, and returns ImageBitmaps
// ready for instant display.
//
// Key optimization: we render the page only ONCE. The same render
// is used both for the main canvas bitmap and for extracting
// original image pixels for the overlay.
// ============================================================

function createCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function renderPageOffscreen(page, cssScale) {
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: cssScale * dpr });
  const w = Math.floor(viewport.width);
  const h = Math.floor(viewport.height);

  // Single render + operator list extraction in parallel
  const renderCanvas = createCanvas(w, h);
  const [, opList] = await Promise.all([
    page.render({
      canvasContext: renderCanvas.getContext('2d'),
      viewport,
    }).promise,
    page.getOperatorList(),
  ]);

  // Extract image positions from the operator list
  const regions = extractImageRegions(opList, viewport.transform);

  // Composite overlay: copy only image regions from the render
  const overlayCanvas = createCanvas(w, h);
  compositeImageRegions(overlayCanvas.getContext('2d'), renderCanvas, regions, w, h);

  // Create immutable, GPU-friendly bitmaps for caching
  const [mainBitmap, overlayBitmap] = await Promise.all([
    createImageBitmap(renderCanvas),
    createImageBitmap(overlayCanvas),
  ]);

  // Release temporary canvases immediately
  renderCanvas.width = 0;
  overlayCanvas.width = 0;

  return { mainBitmap, overlayBitmap, scale: cssScale, width: w, height: h };
}

// ============================================================
// Display: Paint cached bitmaps onto the visible canvases
//
// This is synchronous and instant - no intermediate frames.
// The browser batches the canvas resize + drawImage into a
// single repaint, so the user sees only the final result.
// ============================================================

function displayPage(entry) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.floor(entry.width / dpr) + 'px';
  const cssH = Math.floor(entry.height / dpr) + 'px';

  // Size and fill the main canvas
  pdfCanvas.width = entry.width;
  pdfCanvas.height = entry.height;
  pdfCanvas.style.width = cssW;
  pdfCanvas.style.height = cssH;
  pdfCtx.drawImage(entry.mainBitmap, 0, 0);

  // Size and fill the overlay canvas
  overlayCanvas.width = entry.width;
  overlayCanvas.height = entry.height;
  overlayCanvas.style.width = cssW;
  overlayCanvas.style.height = cssH;
  overlayCtx.drawImage(entry.overlayBitmap, 0, 0);

  applyDarkModeState();
}

// ============================================================
// Core Navigation Pipeline
// ============================================================

async function renderCurrentPage() {
  if (!pdfDoc) return;

  const myId = ++navigationId;
  const pageNum = currentPageNum;

  updateNavigationUI();

  const page = await pdfDoc.getPage(pageNum);
  if (navigationId !== myId) return;

  const scale = calculateScale(page);
  currentScale = scale;

  // --- Fast path: page is already cached ---
  const cached = getCachedPage(pageNum, scale);
  if (cached) {
    displayPage(cached);
    evictDistantPages(pageNum);
    schedulePreRender(pageNum, scale, myId);
    return;
  }

  // --- Slow path: render offscreen, show loading ---
  pageWrapper.classList.add('loading');
  loadingIndicator.hidden = false;

  try {
    const entry = await renderPageOffscreen(page, scale);

    // Discard if the user navigated away during render
    if (navigationId !== myId) {
      entry.mainBitmap.close();
      entry.overlayBitmap.close();
      return;
    }

    pageCache.set(pageNum, entry);
    displayPage(entry);
  } catch (err) {
    if (navigationId !== myId) return;
    console.error('Render failed:', err);
  } finally {
    if (navigationId === myId) {
      pageWrapper.classList.remove('loading');
      loadingIndicator.hidden = true;
      evictDistantPages(pageNum);
      schedulePreRender(pageNum, scale, myId);
    }
  }
}

// ============================================================
// Background Pre-rendering
//
// After the current page is displayed, we silently pre-render
// adjacent pages so future navigations are instant.
// Pages are rendered sequentially (not parallel) to avoid
// memory spikes from multiple simultaneous offscreen canvases.
// The pre-render is cancelled if the user navigates away.
// ============================================================

function schedulePreRender(centerPage, scale, myId) {
  // Use requestIdleCallback if available, otherwise setTimeout
  const schedule = window.requestIdleCallback || ((cb) => setTimeout(cb, 50));
  schedule(() => preRenderAdjacent(centerPage, scale, myId));
}

async function preRenderAdjacent(centerPage, scale, myId) {
  // Priority order: next page first, then +2, then previous
  const offsets = [];
  for (let i = 1; i <= CACHE_AHEAD; i++) offsets.push(i);
  for (let i = 1; i <= CACHE_BEHIND; i++) offsets.push(-i);

  for (const offset of offsets) {
    // Bail if the user navigated away
    if (navigationId !== myId) return;

    const num = centerPage + offset;
    if (num < 1 || num > pdfDoc.numPages) continue;

    // Skip if already cached at the current scale
    if (getCachedPage(num, scale)) continue;

    try {
      const page = await pdfDoc.getPage(num);
      if (navigationId !== myId) return;

      const entry = await renderPageOffscreen(page, scale);
      if (navigationId !== myId) {
        entry.mainBitmap.close();
        entry.overlayBitmap.close();
        return;
      }

      pageCache.set(num, entry);
    } catch (err) {
      // Pre-render failures are non-critical
      if (navigationId !== myId) return;
      console.warn(`Pre-render page ${num} failed:`, err);
    }
  }
}

// ============================================================
// Image Region Extraction
//
// Walks the PDF operator list, tracks the Current Transformation
// Matrix (CTM) stack, and records the screen-space bounding box
// of every raster image encountered.
// ============================================================

function extractImageRegions(opList, viewportTransform) {
  const regions = [];
  const ctmStack = [];
  let ctm = [...IDENTITY_MATRIX];

  const fnArray = opList.fnArray;
  const argsArray = opList.argsArray;

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const args = argsArray[i];

    switch (op) {
      // --- CTM Stack Management ---

      case OPS.save:
        ctmStack.push([...ctm]);
        break;

      case OPS.restore:
        ctm = ctmStack.pop() || [...IDENTITY_MATRIX];
        break;

      case OPS.transform:
        ctm = multiplyMatrices(ctm, args);
        break;

      // Form XObjects push their own transform context
      case OPS.paintFormXObjectBegin:
        ctmStack.push([...ctm]);
        if (args[0]) {
          ctm = multiplyMatrices(ctm, args[0]);
        }
        break;

      case OPS.paintFormXObjectEnd:
        ctm = ctmStack.pop() || [...IDENTITY_MATRIX];
        break;

      // --- Raster Images ---

      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
        regions.push(computeImageBounds(ctm, viewportTransform));
        break;

      case OPS.paintImageXObjectRepeat: {
        if (args.length > 3) {
          for (let j = 3; j < args.length; j += 2) {
            const repeatCtm = multiplyMatrices(ctm, [1, 0, 0, 1, args[j], args[j + 1]]);
            regions.push(computeImageBounds(repeatCtm, viewportTransform));
          }
        } else {
          regions.push(computeImageBounds(ctm, viewportTransform));
        }
        break;
      }

      // Image masks (83, 84, 89, 90) are 1-bit stencils, NOT photos.
      // They get inverted along with the rest of the page content.
    }
  }

  return regions;
}

// ============================================================
// Overlay Composition
// ============================================================

function compositeImageRegions(ctx, sourceCanvas, regions, canvasW, canvasH) {
  for (const r of regions) {
    const sx = Math.max(0, r.x);
    const sy = Math.max(0, r.y);
    const sx2 = Math.min(canvasW, r.x + r.width);
    const sy2 = Math.min(canvasH, r.y + r.height);
    const sw = sx2 - sx;
    const sh = sy2 - sy;

    if (sw <= 0 || sh <= 0) continue;
    ctx.drawImage(sourceCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
  }
}

// ============================================================
// Dark Mode Toggle (per-page)
// ============================================================

function applyDarkModeState() {
  const isDark = !lightPages.has(currentPageNum);

  pdfCanvas.classList.toggle('dark-active', isDark);
  overlayCanvas.hidden = !isDark;

  iconDark.hidden = !isDark;
  iconLight.hidden = isDark;
  btnToggle.classList.toggle('toggle-active', isDark);
}

function toggleDarkMode() {
  if (lightPages.has(currentPageNum)) {
    lightPages.delete(currentPageNum);
  } else {
    lightPages.add(currentPageNum);
  }
  applyDarkModeState();
}

// ============================================================
// Navigation
// ============================================================

function updateNavigationUI() {
  if (!pdfDoc) return;
  pageInfo.textContent = `${currentPageNum} / ${pdfDoc.numPages}`;
  btnPrev.disabled = currentPageNum <= 1;
  btnNext.disabled = currentPageNum >= pdfDoc.numPages;
}

async function goToPage(num) {
  if (!pdfDoc) return;
  const clamped = Math.max(1, Math.min(num, pdfDoc.numPages));
  if (clamped === currentPageNum) return;
  currentPageNum = clamped;
  await renderCurrentPage();
}

// ============================================================
// Event Listeners
// ============================================================

// --- Drop Zone ---

dropZone.addEventListener('click', () => fileInput.click());

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', () => {
  handleFile(fileInput.files[0]);
  fileInput.value = '';
});

// --- Toolbar ---

btnPrev.addEventListener('click', () => goToPage(currentPageNum - 1));
btnNext.addEventListener('click', () => goToPage(currentPageNum + 1));
btnToggle.addEventListener('click', toggleDarkMode);
btnFile.addEventListener('click', () => fileInput.click());

// --- Keyboard ---

document.addEventListener('keydown', (e) => {
  if (!pdfDoc) return;
  if (e.key === 'ArrowLeft') goToPage(currentPageNum - 1);
  else if (e.key === 'ArrowRight') goToPage(currentPageNum + 1);
  else if (e.key === 'd') toggleDarkMode();
});

// --- Resize: invalidate cache since scale changes ---

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!pdfDoc) return;
    invalidateCache();
    renderCurrentPage();
  }, 200);
});

// --- Allow dropping a new file onto the reader too ---

reader.addEventListener('dragover', (e) => e.preventDefault());
reader.addEventListener('drop', (e) => {
  e.preventDefault();
  handleFile(e.dataTransfer.files[0]);
});
