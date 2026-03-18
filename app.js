// ============================================================
// Smart Dark PDF Reader - v0.3
//
// New in v0.3:
//   - Already-dark detection: pages with dark backgrounds
//     skip inversion automatically
//   - Text layer: selectable/copyable text overlay
//   - Continuous scroll: all pages in a column with
//     IntersectionObserver-based lazy rendering
//   - Softer inversion: invert(0.86) instead of invert(1)
//
// Run with a local server:
//   python3 -m http.server 8000
//   then open http://localhost:8000
// ============================================================

import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.min.mjs';

import {
  IDENTITY_MATRIX,
  DARK_LUMINANCE_THRESHOLD,
  SCAN_IMAGE_COVERAGE_THRESHOLD,
  SCAN_TEXT_CHAR_THRESHOLD,
  OCR_CONFIDENCE_THRESHOLD,
  multiplyMatrices,
  transformPoint,
  computeImageBounds,
  extractImageRegions as _extractImageRegions,
  compositeImageRegions,
  detectAlreadyDark as _detectAlreadyDark,
  shouldApplyDark as _shouldApplyDark,
  normalizeLigatures,
  mergePunctuation,
  groupItemsIntoLines,
  shouldInsertSpace,
  calculateScale as _calculateScale,
  isScannedPattern,
  sanitizeOcrWords,
  filterFlowBreakingItems,
  OCR_GAP_OUTLIER_FACTOR,
  detectLanguageFromText,
  getNavigatorLanguage,
  isOcrArtifact,
} from './core.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.worker.min.mjs';

// ============================================================
// Constants
// ============================================================

// Yield to the UI thread without setTimeout.
//
// In background tabs, browsers throttle setTimeout to a minimum
// of 1 second per call. For a 352-page export, that's 352 extra
// seconds of dead waiting. MessageChannel.postMessage is NOT
// throttled — it fires at full speed regardless of tab visibility.
//
// This is the same technique React Scheduler uses internally for
// its concurrent mode work loop.
const yieldToUI = (() => {
  const channel = new MessageChannel();
  return () => new Promise(resolve => {
    channel.port1.onmessage = resolve;
    channel.port2.postMessage(null);
  });
})();

const OPS = pdfjsLib.OPS;

// OPS map for core.extractImageRegions (decouples core from pdfjsLib)
const OPS_MAP = {
  save: OPS.save,
  restore: OPS.restore,
  transform: OPS.transform,
  paintFormXObjectBegin: OPS.paintFormXObjectBegin,
  paintFormXObjectEnd: OPS.paintFormXObjectEnd,
  paintImageXObject: OPS.paintImageXObject,
  paintInlineImageXObject: OPS.paintInlineImageXObject,
  paintImageXObjectRepeat: OPS.paintImageXObjectRepeat,
};

// How many pages around the visible area to pre-render.
// Memory-constrained (iOS, budget Android ≤4GB): 1 page.
// Other devices: 2 pages.
const _memConstrainedEarly = (
  window.matchMedia('(pointer: coarse)').matches &&
  (/iPad|iPhone/.test(navigator.userAgent) || (navigator.deviceMemory && navigator.deviceMemory <= 4))
);
const PRERENDER_MARGIN = _memConstrainedEarly ? 1 : 2;

// Minimum PDF.js render scale for Tesseract OCR.
// PDF standard is 72 points/inch. At scale 3, a page is rendered
// at 72 * 3 = 216 DPI — above Tesseract's minimum threshold (~200 DPI).
// Below this, OCR quality degrades sharply: confidence drops, words are
// garbled or missed entirely. When the display canvas (currentScale * dpr)
// is below this threshold, we render a separate higher-res canvas just
// for Tesseract. The coordinate conversion in buildOcrTextLayerDirect
// handles the difference automatically via scaleX/scaleY.
const OCR_MIN_SCALE = 3;

// ============================================================
// OCR Image Preprocessing
//
// Tesseract works best on high-contrast grayscale images.
// The PDF.js render is full-color with anti-aliased text —
// great for display, suboptimal for OCR. Converting to
// grayscale removes color noise, and boosting contrast
// sharpens character edges, reducing confusions on visually
// similar glyphs (5/S/$, 9/8, /→7).
//
// This is Tesseract's own recommendation #1 for improving
// quality: https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html
//
// The preprocessing creates a temporary canvas, applies CSS
// filters (GPU-accelerated), and returns it. The caller is
// responsible for releasing it (canvas.width = 0) after use.
// ============================================================

const OCR_CONTRAST = 1.4;

// Feature-detect ctx.filter by actually rendering through a filter
// and checking pixels. Safari iOS reflects the filter string on
// assignment (so typeof/equality checks pass) but silently ignores
// the filter during drawImage. Only a pixel test catches this.
const supportsCtxFilter = (() => {
  try {
    const src = document.createElement('canvas');
    src.width = 1; src.height = 1;
    const srcCtx = src.getContext('2d');
    srcCtx.fillStyle = '#ff0000'; // pure red
    srcCtx.fillRect(0, 0, 1, 1);

    const dst = document.createElement('canvas');
    dst.width = 1; dst.height = 1;
    const dstCtx = dst.getContext('2d');
    dstCtx.filter = 'invert(1)';
    dstCtx.drawImage(src, 0, 0);

    // If invert worked, red (255,0,0) becomes cyan (0,255,255).
    // If filter was ignored, the pixel is still red.
    const px = dstCtx.getImageData(0, 0, 1, 1).data;
    return px[0] < 128 && px[1] > 128; // cyan-ish, not red
  } catch (_) { return false; }
})();

function preprocessCanvasForOcr(sourceCanvas) {
  const c = document.createElement('canvas');
  c.width = sourceCanvas.width;
  c.height = sourceCanvas.height;
  const ctx = c.getContext('2d');

  if (supportsCtxFilter) {
    ctx.filter = `grayscale(1) contrast(${OCR_CONTRAST})`;
    ctx.drawImage(sourceCanvas, 0, 0);
  } else {
    // Manual fallback: grayscale + contrast via pixel manipulation
    ctx.drawImage(sourceCanvas, 0, 0);
    const imgData = ctx.getImageData(0, 0, c.width, c.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      // Grayscale (BT.601)
      const grey = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
      // Contrast: (grey - 128) * factor + 128
      const c1 = (grey - 128) * OCR_CONTRAST + 128;
      const v = Math.max(0, Math.min(255, c1));
      d[i] = d[i+1] = d[i+2] = v;
    }
    ctx.putImageData(imgData, 0, 0);
  }
  return c;
}

// Baseline offset ratio: measured at runtime via canvas.measureText().
// Tells us exactly where the browser places the baseline within
// a line-box of height = font-size. This varies by OS/font.
const BASELINE_RATIO = (() => {
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    ctx.font = '100px sans-serif';
    const m = ctx.measureText('Hg');
    if (m.fontBoundingBoxAscent != null && m.fontBoundingBoxDescent != null) {
      // CSS baseline position within a line-height:1 line box:
      // baseline = top + fontSize/2 + (ascent - descent) / 2
      // So: top = baseline - fontSize * ratio
      // where ratio = 0.5 + (ascent - descent) / (2 * fontSize)
      return 0.5 + (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 200;
    }
  } catch (e) { /* fall through */ }
  return 0.85; // safe fallback
})();

// Matrix utilities, image region extraction, dark detection,
// text layer helpers, and other pure functions are in core.js.
// Imported above — see the import block at the top of this file.

// ============================================================
// State
// ============================================================

let pdfDoc = null;
let currentScale = 0;
// Original PDF bytes — kept for iOS document recreation (see resetPdfEngine).
let _pdfBuffer = null;

// Each page can be in one of these dark-mode states:
//   'auto'  – use already-dark detection result
//   'dark'  – force dark mode on (user override)
//   'light' – force dark mode off (user override)
// Default is 'auto' for all pages.
const pageDarkOverride = new Map();

// Cache of already-dark detection results per page.
// true = page is already dark, skip inversion.
const pageAlreadyDark = new Map();

// Virtual scrolling: only a few DOM containers exist at any time.
// pageSlots maps currently-active page numbers to their pool container.
// pageRenderState tracks per-page state that persists across recycling.
const pageSlots = new Map(); // Map<pageNum, poolSlot>
const pageRenderState = new Map(); // Map<pageNum, { rendered, rendering, ... }>
let pageGeometry = []; // [{cssWidth, cssHeight, offsetTop}] indexed by pageNum (1-based, index 0 unused)
const POOL_SIZE = 7;
const VIRTUAL_BUFFER = 2; // pages above/below viewport to pre-assign
const PAGE_GAP = 40; // px between pages (matches CSS gap)
const VIEWPORT_PADDING_TOP = 64; // space for floating toolbar

// Monotonically increasing, bumped on new PDF load or resize
let globalGeneration = 0;

// true if the document is detected as scanned (full-page images, no text).
// When true, image protection is skipped so CSS inversion covers the whole page.
let isScannedDocument = false;

// Tesseract.js worker — loaded lazily only for scanned documents.
let tesseractWorker = null;
let tesseractLoading = false;

// OCR language: determined from navigator.languages at worker creation.
// No scout pass needed — the worker starts with the right language.

// ============================================================
// OCR Scheduler — Priority Queue with Viewport Distance
//
// Instead of firing OCR calls directly (fire-and-forget), all
// OCR work goes through a centralized queue. The queue sorts
// jobs by distance from the currently visible page — closest
// pages are processed first. When the user scrolls, the queue
// re-prioritizes automatically.
//
// Jobs can be cancelled before they start (e.g. when a page is
// evicted). Results are cached so re-rendering a page doesn't
// re-OCR it.
//
// The scheduler also implements:
//   - Per-page image budget (max images per page)
//   - Image deduplication (skip identical images across pages)
//   - Text detection heuristic (skip images unlikely to contain text)
//   - Vertical pass on-demand (only on Option+drag, not eagerly)
// ============================================================

// Maximum images to OCR per page (horizontal pass only).
// Sorted by area — largest images are most likely to contain text.
// Remaining images are OCR'd on-demand when the user clicks them.
const OCR_IMAGE_BUDGET = 4;

// Cache for OCR results: avoids re-running Tesseract when a page
// is evicted (memory freed) and later re-rendered (scrolled back).
// Map<string, ocrData> where key is "page-{pageNum}" for full-page
// or "img-{pageNum}-{x}-{y}" for image regions.
// Cleared on new PDF load (globalGeneration++).
const ocrCache = new Map();

// Image fingerprint cache for deduplication.
// Map<string, boolean> — true if this fingerprint was already OCR'd.
const ocrFingerprints = new Map();

// The OCR job queue. Each job: { id, pageNum, type, priority, execute, cancelled }
const ocrQueue = [];
let ocrProcessing = false; // true while a job is being processed

/**
 * Fingerprint an image by sampling ~64 evenly-spaced pixels.
 * Fast (~0.5ms) and sufficient to detect repeated logos/headers.
 * Returns null if the canvas is too small to sample.
 */
function fingerprint(canvas) {
  if (canvas.width < 8 || canvas.height < 8) return null;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const stepX = Math.floor(canvas.width / 8);
  const stepY = Math.floor(canvas.height / 8);
  let hash = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const d = ctx.getImageData(x * stepX, y * stepY, 1, 1).data;
      // Quantize to 4-bit per channel for tolerance
      hash += ((d[0] >> 4) << 8 | (d[1] >> 4) << 4 | (d[2] >> 4)).toString(36);
    }
  }
  return hash;
}

/**
 * Heuristic: does this image likely contain text?
 * Checks edge density — text has many high-contrast edges,
 * photos and gradients have few. ~3-5ms per image.
 */
function likelyContainsText(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  if (w < 50 || h < 50) return false;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Sample a grid of pixels and count sharp brightness transitions
  const step = Math.max(4, Math.floor(Math.min(w, h) / 60));
  let edges = 0;
  let samples = 0;

  const data = ctx.getImageData(0, 0, w, h).data;
  const lum = (i) => data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;

  for (let y = step; y < h - step; y += step) {
    for (let x = step; x < w - step; x += step) {
      const idx = (y * w + x) * 4;
      const idxR = (y * w + x + step) * 4;
      const idxD = ((y + step) * w + x) * 4;
      if (idxR < data.length && idxD < data.length) {
        const l = lum(idx);
        const diffH = Math.abs(l - lum(idxR));
        const diffV = Math.abs(l - lum(idxD));
        if (diffH > 40 || diffV > 40) edges++;
        samples++;
      }
    }
  }

  // Text-heavy images typically have >8% edge pixels.
  // Pure photos or gradients have <3%.
  return samples > 0 && (edges / samples) > 0.05;
}

/**
 * Enqueue an OCR job. Jobs are sorted by distance from the
 * currently visible page before each processing cycle.
 */
function enqueueOcrJob(job) {
  ocrQueue.push(job);
  processOcrQueue(); // kick the processor if idle
}

/**
 * Cancel all queued (not in-flight) OCR jobs for a given page.
 */
function cancelOcrJobsForPage(pageNum) {
  for (const job of ocrQueue) {
    if (job.pageNum === pageNum) {
      job.cancelled = true;
    }
  }
}

/**
 * Process the OCR queue one job at a time. Sorts by priority
 * (distance from viewport) before picking the next job.
 */
async function processOcrQueue() {
  if (ocrProcessing) return; // already running
  ocrProcessing = true;

  while (ocrQueue.length > 0) {
    // Sort: closest to current visible page first
    const visPage = currentVisiblePage || 1;
    ocrQueue.sort((a, b) => {
      const da = Math.abs(a.pageNum - visPage);
      const db = Math.abs(b.pageNum - visPage);
      return da - db;
    });

    // Pop the highest-priority non-cancelled job
    let job = null;
    while (ocrQueue.length > 0) {
      const candidate = ocrQueue.shift();
      if (!candidate.cancelled) {
        job = candidate;
        break;
      }
    }
    if (!job) break;

    try {
      await job.execute();
    } catch (err) {
      console.warn('OCR job failed:', err);
    }
  }

  ocrProcessing = false;
}

// pdf-lib module — loaded lazily for export.
let pdfLibModule = null;

// fontkit + Unicode font — loaded lazily for export.
// fontkit is required by pdf-lib to embed custom (non-standard) fonts.
// The Unicode font replaces Helvetica (WinAnsi-only, 256 chars) so that
// symbols like −, ≥, α, β, ∑ are preserved in the exported PDF.
let fontkitModule = null;
let cachedFontBytes = null;

// Export state
let exporting = false;
let exportGeneration = 0; // incremented on each export start and cancel
let originalFileName = 'document';

// ============================================================
// DOM References
// ============================================================

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const readerEl = document.getElementById('reader');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnToggle = document.getElementById('btn-toggle');
const btnFile = document.getElementById('btn-file');
const pageInfo = document.getElementById('page-info');
const iconDark = document.getElementById('icon-dark');
const iconLight = document.getElementById('icon-light');
const viewport = document.getElementById('viewport');
const btnExport = document.getElementById('btn-export');
const exportProgressEl = document.getElementById('export-progress');
const exportProgressFill = document.querySelector('.export-progress-fill');
const exportProgressText = document.querySelector('.export-progress-text');
const exportCancelBtn = document.getElementById('export-cancel');
const errorBanner = document.getElementById('error-banner');
const infoBanner = document.getElementById('info-banner');
const infoMessage = document.getElementById('info-message');
const iosWarnEl = document.getElementById('ios-export-warn');
const iosWarnText = document.getElementById('ios-export-warn-text');
const iosWarnTry = document.getElementById('ios-export-try');
const iosWarnCancel = document.getElementById('ios-export-cancel');

// iOS detection — all browsers on iOS use WebKit (Apple policy),
// so they ALL share the same Jetsam memory limits. This detects
// the device, not the browser engine.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const errorMessage = document.getElementById('error-message');
const errorDismiss = document.getElementById('error-dismiss');
const fileNameEl = document.getElementById('file-name');
const toolbar = document.getElementById('toolbar');

// ============================================================
// Focus Mode
//
// After 3 seconds of no mouse movement, the toolbar fades out.
// The reader becomes pure content — just the PDF.
//
// The toolbar reappears ONLY when the mouse approaches the top
// edge of the window (top 60px). Moving the mouse elsewhere
// does NOT bring it back — reading should be uninterrupted.
//
// Keyboard shortcut: F to toggle manually.
// ============================================================

let focusTimer = null;
let focusPaused = false;
// On mobile, the user needs more time to decide what to tap.
const FOCUS_DELAY = window.matchMedia('(pointer: coarse)').matches ? 2500 : 1500;
const TOOLBAR_TRIGGER_ZONE = 35; // px from top edge
const TOOLBAR_HOVER_DELAY = 300; // ms mouse must stay in zone

function enterFocusMode() {
  if (!readerEl || readerEl.hidden || focusPaused) return;
  toolbar.classList.add('toolbar-hidden');
}

function exitFocusMode() {
  // Mobile landscape: toolbar stays hidden unconditionally.
  // The user rotates to portrait to access toolbar actions.
  if (isMobileLandscape()) return;
  toolbar.classList.remove('toolbar-hidden');
  resetFocusTimer();
}

function resetFocusTimer() {
  if (focusTimer) clearTimeout(focusTimer);
  focusTimer = setTimeout(() => { focusTimer = null; enterFocusMode(); }, FOCUS_DELAY);
}

// Mouse near top edge: show toolbar after dwelling briefly.
// Throttled to ~30fps to avoid timer churn during trackpad scroll.
let hoverTimer = null;
let mouseMoveThrottled = false;

document.addEventListener('mousemove', (e) => {
  if (mouseMoveThrottled || !readerEl || readerEl.hidden) return;
  mouseMoveThrottled = true;
  requestAnimationFrame(() => { mouseMoveThrottled = false; });

  // Is the mouse over the toolbar or in the trigger zone?
  const toolbarRect = toolbar.getBoundingClientRect();
  const overToolbar = e.clientY <= toolbarRect.bottom + 5 &&
    e.clientX >= toolbarRect.left - 10 && e.clientX <= toolbarRect.right + 10;

  if (e.clientY <= TOOLBAR_TRIGGER_ZONE || overToolbar) {
    if (toolbar.classList.contains('toolbar-hidden') && !hoverTimer) {
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        exitFocusMode();
      }, TOOLBAR_HOVER_DELAY);
    }
  } else {
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
  }

  // Toolbar visible: keep it while mouse is over it, hide timer when away
  if (!toolbar.classList.contains('toolbar-hidden')) {
    if (overToolbar) {
      clearTimeout(focusTimer);
    } else {
      resetFocusTimer();
    }
  }
}, { passive: true });

// Touch: tap in the top zone when toolbar is hidden reveals it.
// In mobile landscape the toolbar is completely hidden (no reveal
// mechanism) — the user rotates to portrait for toolbar actions.
document.addEventListener('touchstart', (e) => {
  if (!readerEl || readerEl.hidden) return;
  if (!toolbar.classList.contains('toolbar-hidden')) return;
  if (isMobileLandscape()) return;

  const touch = e.touches[0];
  if (touch && touch.clientY <= TOOLBAR_TRIGGER_ZONE * 2) {
    e.preventDefault();
    exitFocusMode();
  }
}, { passive: false });

// Keyboard: F to toggle focus mode
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey
      && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
    if (toolbar.classList.contains('toolbar-hidden')) {
      exitFocusMode();
    } else {
      clearTimeout(focusTimer);
      enterFocusMode();
    }
  }
});

// ============================================================
// Error Display
// ============================================================

let errorTimeout = null;

function showError(msg, duration = 8000) {
  errorMessage.textContent = msg;
  errorBanner.hidden = false;
  if (errorTimeout) clearTimeout(errorTimeout);
  if (duration > 0) {
    errorTimeout = setTimeout(() => { errorBanner.hidden = true; }, duration);
  }
}

errorDismiss.addEventListener('click', () => {
  errorBanner.hidden = true;
  if (errorTimeout) clearTimeout(errorTimeout);
});

let infoTimeout = null;

function showInfo(msg, duration = 6000) {
  infoMessage.textContent = msg;
  infoBanner.hidden = false;
  if (infoTimeout) clearTimeout(infoTimeout);
  if (duration > 0) {
    infoTimeout = setTimeout(() => { infoBanner.hidden = true; }, duration);
  }
}

// Dismiss info banner on tap (mobile)
infoBanner.addEventListener('click', () => {
  infoBanner.hidden = true;
  if (infoTimeout) clearTimeout(infoTimeout);
});

// Pinch-to-zoom hint: on mobile, portrait pages are rendered at
// a lower scale than landscape (fit-to-page vs fit-to-width).
// When the user zooms in for the first time, the pixel density
// becomes noticeable. Suggest landscape where pages render at
// full width with more pixels per point. Shown once per session.
let _zoomHintShown = false;
if (window.matchMedia('(pointer: coarse)').matches && window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    if (_zoomHintShown || !pdfDoc) return;
    if (window.visualViewport.scale > 1.2) {
      _zoomHintShown = true;
      showInfo('For best visual quality, try landscape mode.');
    }
  });
}

// ============================================================
// File Handling
// ============================================================

function handleFile(file) {
  if (!file || file.type !== 'application/pdf') return;
  originalFileName = file.name.replace(/\.pdf$/i, '');
  if (fileNameEl) fileNameEl.textContent = file.name;
  document.title = `veil - ${file.name}`;

  // Start focus mode timer when a PDF is loaded
  resetFocusTimer();

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
    cleanup();

    // Keep the original bytes for iOS document recreation.
    // PDF.js may transfer the buffer, so we keep our own copy.
    _pdfBuffer = data.slice(0);
    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    _isLargeDocConstrained = _isMemoryConstrained && pdfDoc.numPages > LARGE_DOC_THRESHOLD;
    pageDarkOverride.clear();
    pageAlreadyDark.clear();
    isScannedDocument = false;
    globalGeneration++;

    // Clear OCR caches — new document, old results are invalid
    ocrCache.clear();
    ocrFingerprints.clear();
    // Cancel all pending render and OCR jobs from previous document
    renderQueue.length = 0;
    ocrQueue.forEach(j => { j.cancelled = true; });
    ocrQueue.length = 0;
    isScrollingFast = false;
    rendersSinceReset = 0;
    isResetPending = false;

    // Show the reader behind the drop zone, then animate the veil open.
    // The veil layers slide right while the reader renders underneath.
    readerEl.hidden = false;
    dropZone.classList.add('veil-opening');
    // After the longest layer finishes (1s), hide the drop zone entirely
    setTimeout(() => {
      dropZone.hidden = true;
      dropZone.classList.remove('veil-opening');
    }, 1050);

    // Detect scanned document before building pages
    isScannedDocument = await detectScannedDocument();

    await buildPageSlots();
    // Center the first page in the viewport immediately (no animation)
    scrollToPage(1, true);
    reconcileContainers();
    updateCurrentPageFromScroll();

  } catch (err) {
    console.error('Failed to load PDF:', err);
    if (err?.name === 'PasswordException') {
      showError('This PDF is password-protected. Please unlock it first.');
    } else if (err?.name === 'InvalidPDFException') {
      showError('This file does not appear to be a valid PDF.');
    } else {
      showError('Could not load this PDF. The file may be corrupted.');
    }
  }
}

// ============================================================
// Scanned Document Detection
//
// Samples 3-5 pages spread across the document. If ALL sampled
// pages have a single large image covering >85% of the page
// area AND <50 characters of text, the document is scanned.
//
// When scanned, image protection is skipped: CSS inversion
// covers the entire page including the scan image, turning
// black-on-white text into white-on-dark. This is correct
// because the "image" IS the text content.
// ============================================================

async function detectScannedDocument() {
  if (!pdfDoc || pdfDoc.numPages === 0) return false;

  // Pick sample pages spread across the document
  const numPages = pdfDoc.numPages;
  const sampleIndices = new Set();
  sampleIndices.add(1); // first page always
  if (numPages >= 2) sampleIndices.add(numPages); // last
  if (numPages >= 4) sampleIndices.add(Math.floor(numPages * 0.25));
  if (numPages >= 6) sampleIndices.add(Math.floor(numPages * 0.5));
  if (numPages >= 8) sampleIndices.add(Math.floor(numPages * 0.75));

  const samplesToCheck = [...sampleIndices];
  const pageSamples = [];

  for (const pageNum of samplesToCheck) {
    const page = await pdfDoc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1 });
    const pageArea = vp.width * vp.height;

    const [opList, textContent] = await Promise.all([
      page.getOperatorList(),
      page.getTextContent(),
    ]);

    let charCount = 0;
    for (const item of textContent.items) {
      if (item.str) charCount += item.str.length;
    }

    const regions = extractImageRegions(opList, vp.transform);

    let maxCoverage = 0;
    for (const r of regions) {
      const coverage = (r.width * r.height) / pageArea;
      if (coverage > maxCoverage) maxCoverage = coverage;
    }

    pageSamples.push({ charCount, maxImageCoverage: maxCoverage });
  }

  const result = isScannedPattern(pageSamples);
  if (result) {
    console.log(`Scanned document detected (${samplesToCheck.length} pages sampled)`);
  }
  return result;
}

// ============================================================
// Tesseract.js — Lazy OCR for Scanned Documents
//
// Loaded only when a scanned PDF is detected. The worker runs
// in a separate thread, so OCR never blocks the UI. Text
// becomes selectable silently once recognition completes.
// ============================================================

async function ensureTesseractWorker() {
  if (tesseractWorker) return tesseractWorker;
  if (tesseractLoading) {
    // Another call is already loading — wait for it
    while (tesseractLoading) {
      await new Promise(r => setTimeout(r, 100));
    }
    return tesseractWorker;
  }

  tesseractLoading = true;
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js');
    // Handle both named export and default export patterns
    const createWorker = mod.createWorker || (mod.default && mod.default.createWorker);
    if (!createWorker) throw new Error('createWorker not found in Tesseract module');

    // Use navigator.languages to determine the user's primary language.
    // Creates a dual-model worker (eng+lang) so both the user's language
    // AND English are recognized in a single pass — no scout needed.
    const navLang = getNavigatorLanguage();
    const langs = navLang ? 'eng+' + navLang : 'eng';
    tesseractWorker = await createWorker(langs, 1, {
      logger: () => {},
    });
    return tesseractWorker;
  } catch (err) {
    console.warn('Tesseract.js failed to load:', err);
    return null;
  } finally {
    tesseractLoading = false;
  }
}

async function ocrPage(canvas, textLayerDiv, cssWidth, cssHeight, myGen) {
  const worker = await ensureTesseractWorker();
  if (!worker || globalGeneration !== myGen) return;

  try {
    // Preprocess: grayscale + contrast for sharper character edges.
    // The processed canvas has the same dimensions as the source,
    // so coordinate mapping in buildOcrTextLayerDirect is unchanged.
    const processed = preprocessCanvasForOcr(canvas);
    canvas.width = 0; // release original immediately

    const { data } = await worker.recognize(processed);
    if (globalGeneration !== myGen) { processed.width = 0; return; }

    buildOcrTextLayerDirect(
      textLayerDiv, data, processed.width, processed.height, cssWidth, cssHeight
    );

    processed.width = 0;
  } catch (err) {
    if (globalGeneration !== myGen) return;
    console.warn('OCR failed for page:', err);
  }
}

// ============================================================
// OCR on Images within Native PDFs
//
// In native PDFs, the body text is already selectable. But text
// inside raster images (chart labels, table photos, code screenshots)
// is not. This function runs Tesseract on each image region to make
// that text selectable too.
//
// It piggybacks on the existing lazy rendering: runs in background
// after the native text layer is built, using the same IntersectionObserver
// lifecycle. When the page is evicted, the OCR spans are cleared with
// the rest of the text layer.
//
// Each image region gets its own absolutely-positioned container div
// within the text layer. buildOcrTextLayerDirect fills it with the
// same line/span structure used for full-page scanned OCR.
// ============================================================

// Minimum image size (canvas pixels) to attempt OCR.
// Skips icons, decorations, and tiny logos.
const OCR_IMAGE_MIN_SIZE = 100;

/**
 * Rotates a canvas 90° clockwise.
 * Returns a new canvas with swapped dimensions (W×H → H×W).
 * The source canvas is NOT modified.
 */
function rotateCanvas90CW(source) {
  const rotated = document.createElement('canvas');
  rotated.width = source.height;
  rotated.height = source.width;
  const ctx = rotated.getContext('2d');
  // Translate to new center, rotate, draw
  ctx.translate(rotated.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(source, 0, 0);
  return rotated;
}

/**
 * Checks whether OCR data contains meaningful text (after filtering).
 */
function hasValidOcrWords(data) {
  return (data.words || []).some(
    w => w.text && w.text.trim() &&
         w.confidence >= OCR_CONFIDENCE_THRESHOLD &&
         !isOcrArtifact(w.text)
  );
}

async function ocrImageRegions(mainCanvas, textLayerDiv, _verticalLayerDiv, regions, dpr, myGen, pageNum) {
  if (regions.length === 0) return;

  const worker = await ensureTesseractWorker();
  if (!worker || globalGeneration !== myGen) return;

  for (const region of regions) {
    if (globalGeneration !== myGen) return;

    // --- Extract the image region from the main canvas ---
    const sx = Math.max(0, region.x);
    const sy = Math.max(0, region.y);
    const sw = Math.min(region.width, mainCanvas.width - sx);
    const sh = Math.min(region.height, mainCanvas.height - sy);
    if (sw <= 0 || sh <= 0) continue;

    // CSS position of this region
    const regionCssX = sx / dpr;
    const regionCssY = sy / dpr;
    const regionCssW = sw / dpr;
    const regionCssH = sh / dpr;

    // --- Cache check FIRST ---
    // When a page is evicted and re-rendered, the OCR result is
    // already in cache. Using it directly avoids re-extracting
    // pixels, re-fingerprinting, and re-running the text heuristic.
    const cacheKey = `img-${pageNum}-${Math.round(sx)}-${Math.round(sy)}`;
    const cached = ocrCache.get(cacheKey);

    let data;
    if (cached) {
      data = cached;
    } else {
      // No cache — we need to extract and analyze the image.
      const regionCanvas = document.createElement('canvas');
      regionCanvas.width = sw;
      regionCanvas.height = sh;
      regionCanvas.getContext('2d').drawImage(
        mainCanvas, sx, sy, sw, sh, 0, 0, sw, sh
      );

      // --- Deduplication: skip images we've already OCR'd elsewhere ---
      // Catches repeated logos, headers, watermarks across pages.
      // The fingerprint is a lightweight hash of 64 sampled pixels.
      const fp = fingerprint(regionCanvas);
      if (fp && ocrFingerprints.has(fp)) {
        regionCanvas.width = 0;
        continue;
      }

      // --- Text heuristic: skip images unlikely to contain text ---
      // Photos, gradients, and solid fills have few high-contrast edges.
      if (!likelyContainsText(regionCanvas)) {
        regionCanvas.width = 0;
        // Store fingerprint so we don't re-analyze this image
        // if it appears on another page (same visual = same verdict).
        if (fp) ocrFingerprints.set(fp, true);
        continue;
      }

      // --- OCR: horizontal text (0° — normal orientation) ---
      const processed0 = preprocessCanvasForOcr(regionCanvas);
      regionCanvas.width = 0;
      try {
        const result = await worker.recognize(processed0);
        data = result.data;
        processed0.width = 0;
        if (globalGeneration !== myGen) return;
        // Cache the result and record the fingerprint
        ocrCache.set(cacheKey, data);
        if (fp) ocrFingerprints.set(fp, true);
      } catch (err) {
        processed0.width = 0;
        if (globalGeneration !== myGen) return;
        continue;
      }
    }

    if (hasValidOcrWords(data)) {
      const div0 = document.createElement('div');
      div0.className = 'ocr-image-region';
      div0.style.position = 'absolute';
      div0.style.left = regionCssX + 'px';
      div0.style.top = regionCssY + 'px';
      div0.style.width = regionCssW + 'px';
      div0.style.height = regionCssH + 'px';
      div0.style.overflow = 'hidden';

      buildOcrTextLayerDirect(div0, data, sw, sh, regionCssW, regionCssH);

      if (div0.querySelector('span:not([data-gap])')) {
        textLayerDiv.appendChild(div0);
      }
    }

    if (globalGeneration !== myGen) return;
  }
}

// ============================================================
// Vertical OCR Pass — On-Demand Only
//
// The 90° rotation pass is expensive (doubles OCR work per image)
// and vertical text (axis labels, rotated annotations) is rare.
// Instead of running it eagerly, it's triggered only when the
// user holds Option/Alt and drags on an image region.
// ============================================================

async function ocrImageVertical(mainCanvas, verticalLayerDiv, region, dpr, myGen) {
  const sx = Math.max(0, region.x);
  const sy = Math.max(0, region.y);
  const sw = Math.min(region.width, mainCanvas.width - sx);
  const sh = Math.min(region.height, mainCanvas.height - sy);
  if (sw <= 0 || sh <= 0) return;

  const regionCanvas = document.createElement('canvas');
  regionCanvas.width = sw;
  regionCanvas.height = sh;
  regionCanvas.getContext('2d').drawImage(
    mainCanvas, sx, sy, sw, sh, 0, 0, sw, sh
  );

  const rotated = rotateCanvas90CW(regionCanvas);
  regionCanvas.width = 0;

  const worker = await ensureTesseractWorker();
  if (!worker || globalGeneration !== myGen) { rotated.width = 0; return; }

  const processed90 = preprocessCanvasForOcr(rotated);
  rotated.width = 0;

  try {
    const { data } = await worker.recognize(processed90);
    processed90.width = 0;
    if (globalGeneration !== myGen) return;

    if (hasValidOcrWords(data)) {
      const regionCssX = sx / dpr;
      const regionCssY = sy / dpr;
      const regionCssW = sw / dpr;
      const regionCssH = sh / dpr;
      const rotCssW = regionCssH;
      const rotCssH = regionCssW;

      const div90 = document.createElement('div');
      div90.className = 'ocr-image-region ocr-image-region-rotated';
      div90.style.position = 'absolute';

      const centerX = regionCssX + regionCssW / 2;
      const centerY = regionCssY + regionCssH / 2;
      div90.style.left = (centerX - rotCssW / 2) + 'px';
      div90.style.top = (centerY - rotCssH / 2) + 'px';
      div90.style.width = rotCssW + 'px';
      div90.style.height = rotCssH + 'px';
      div90.style.overflow = 'hidden';
      div90.style.transform = 'rotate(-90deg)';
      div90.style.transformOrigin = 'center center';

      buildOcrTextLayerDirect(div90, data, sh, sw, rotCssW, rotCssH);

      if (div90.querySelector('span:not([data-gap])')) {
        verticalLayerDiv.appendChild(div90);
      }
    }
  } catch (_) {
    processed90.width = 0;
  }
}

// ============================================================
// OCR Loading Indicator
//
// The loading animation is deliberately invisible by default.
// It only appears when the user tries to interact (select text)
// with a page whose OCR hasn't finished yet. Most of the time,
// OCR completes in background before the user even tries — so
// they never see the indicator. When they do, a warm amber light
// sweeps along the page perimeter until the text becomes selectable.
//
// For scanned documents: the animation covers the entire page.
// For native PDFs: it covers individual image regions (since the
// body text is already selectable — only images need OCR).
// ============================================================

function cleanupOcrIndicators(slot) {
  const fadeOut = (el) => {
    el.classList.add('ocr-done');
    setTimeout(() => {
      if (el.dataset.ocrLoading) {
        el.remove();
      } else {
        el.classList.remove('ocr-loading', 'ocr-done');
      }
    }, 650);
  };

  if (slot.element.classList.contains('ocr-loading')) {
    fadeOut(slot.element);
  }
  slot.element.querySelectorAll('[data-ocr-loading]').forEach(fadeOut);
}

function ocrFinished(slot) {
  const pageNum = slot.assignedPage;
  const state = pageNum != null ? pageRenderState.get(pageNum) : null;
  if (state) {
    state.ocrInProgress = false;
  }

  cleanupOcrIndicators(slot);
  setTimeout(() => cleanupOcrIndicators(slot), 100);
}

/**
 * Checks whether a CSS-space point (x,y relative to the page container)
 * falls inside one of the known image regions on this page.
 */
function hitTestImageRegion(stateOrSlot, x, y) {
  for (const r of stateOrSlot.imageRegionsCss) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      return r;
    }
  }
  return null;
}

/**
 * Shows the OCR loading animation when the user tries to select
 * text that isn't ready yet.
 */
function showOcrLoading(slot, region) {
  const pageNum = slot.assignedPage;
  const state = pageNum != null ? pageRenderState.get(pageNum) : null;
  if (!state || !state.ocrInProgress) return;

  if (isScannedDocument) {
    if (!slot.element.classList.contains('ocr-loading')) {
      slot.element.classList.remove('ocr-done');
      slot.element.classList.add('ocr-loading');
    }
  } else if (region) {
    const key = `${Math.round(region.x)}-${Math.round(region.y)}`;
    if (slot.element.querySelector(`[data-ocr-loading="${key}"]`)) return;

    const indicator = document.createElement('div');
    indicator.className = 'ocr-loading';
    indicator.dataset.ocrLoading = key;
    indicator.style.position = 'absolute';
    indicator.style.left = region.x + 'px';
    indicator.style.top = region.y + 'px';
    indicator.style.width = region.w + 'px';
    indicator.style.height = region.h + 'px';
    indicator.style.pointerEvents = 'none';
    indicator.style.zIndex = '11';
    slot.element.appendChild(indicator);
  }
}

// If the user successfully selects text inside an OCR image region,
// the OCR is ready — kill the indicator for that region.
// We check that the selection is specifically inside an .ocr-image-region,
// not in native text that happens to be adjacent to the image.
document.addEventListener('selectionchange', () => {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) return;

  const anchor = sel.anchorNode;
  if (!anchor) return;
  const el = anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement;
  if (!el) return;

  // For scanned docs: any selection on the page means OCR worked
  if (isScannedDocument) {
    const container = el.closest('.page-container');
    if (!container) return;
    const pageNum = parseInt(container.dataset.pageNum, 10);
    const slot = pageSlots.get(pageNum);
    if (slot) cleanupOcrIndicators(slot);
    return;
  }

  // For native PDFs: only kill indicator if selection is inside an OCR image region
  const ocrRegion = el.closest('.ocr-image-region');
  if (!ocrRegion) return;

  const container = ocrRegion.closest('.page-container');
  if (!container) return;
  const pageNum = parseInt(container.dataset.pageNum, 10);
  const slot = pageSlots.get(pageNum);
  if (slot) cleanupOcrIndicators(slot);
});

// Listen for selection attempts on pages with pending OCR.
// On touch: require a long press (350ms hold without movement) to
// distinguish "trying to select text" from "scrolling past".
// On mouse/pen: trigger immediately (no ambiguity with scroll).
let _ocrPressTimer = null;
let _ocrPressStartX = 0;
let _ocrPressStartY = 0;
const OCR_PRESS_DELAY = 350; // ms — shorter than iOS native long press (500ms)
const OCR_PRESS_MOVE_TOLERANCE = 10; // px — finger jitter allowance

function triggerOcrIndicator(e) {
  const container = e.target.closest('.page-container');
  if (!container) return;

  const pageNum = parseInt(container.dataset.pageNum, 10);
  const slot = pageSlots.get(pageNum);
  const state = pageRenderState.get(pageNum);
  if (!slot || !state || !state.ocrInProgress) return;

  const rect = container.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (isScannedDocument) {
    showOcrLoading(slot, null);
  } else {
    const region = hitTestImageRegion(state, x, y);
    if (region) {
      showOcrLoading(slot, region);
    }
  }
}

document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') {
    // Touch: start long press timer
    _ocrPressStartX = e.clientX;
    _ocrPressStartY = e.clientY;
    if (_ocrPressTimer) clearTimeout(_ocrPressTimer);
    _ocrPressTimer = setTimeout(() => {
      _ocrPressTimer = null;
      triggerOcrIndicator(e);
    }, OCR_PRESS_DELAY);
  } else {
    // Mouse/pen: immediate
    triggerOcrIndicator(e);
  }
});

document.addEventListener('pointermove', (e) => {
  if (!_ocrPressTimer || e.pointerType !== 'touch') return;
  const dx = e.clientX - _ocrPressStartX;
  const dy = e.clientY - _ocrPressStartY;
  if (dx * dx + dy * dy > OCR_PRESS_MOVE_TOLERANCE * OCR_PRESS_MOVE_TOLERANCE) {
    clearTimeout(_ocrPressTimer);
    _ocrPressTimer = null;
  }
}, { passive: true });

document.addEventListener('pointerup', () => {
  if (_ocrPressTimer) {
    clearTimeout(_ocrPressTimer);
    _ocrPressTimer = null;
  }
});

document.addEventListener('pointercancel', () => {
  if (_ocrPressTimer) {
    clearTimeout(_ocrPressTimer);
    _ocrPressTimer = null;
  }
});

/**
 * Builds an OCR text layer with flat absolute positioning.
 *
 * Each word becomes an absolutely-positioned span at the exact
 * coordinates Tesseract reports, converted from canvas pixels to
 * CSS pixels. No round-trip PDF, no flow layout, no prevBottom.
 *
 * Key design decisions (informed by 12 failed attempts):
 *   - Absolute positioning: eliminates the Phantom Clamp Theorem
 *     (cumulative errors from flow layout paddingTop)
 *   - line-height: 1 on spans: prevents selection highlight from
 *     expanding beyond the text (the fix for Attempt #1's failure)
 *   - Per-LINE fontSize: all words on the same line share the same
 *     fontSize, preventing PDF.js-style sorting fractures
 *   - Tesseract line.baseline for Y positioning: more accurate than
 *     bbox.y1 (which includes descenders and varies per word)
 *   - No round-trip: eliminates two-source matrix mismatch entirely
 *   - Trailing space in textContent: preserves word spacing in copy/paste
 */
function buildOcrTextLayerDirect(container, ocrData, canvasW, canvasH, cssW, cssH) {
  container.innerHTML = '';

  const scaleX = cssW / canvasW;
  const scaleY = cssH / canvasH;

  const ocrLines = ocrData.lines || [];
  const flatWords = ocrData.words || [];

  const linesToProcess = ocrLines.length > 0
    ? ocrLines
    : [{ words: flatWords, baseline: null }];

  const fragment = document.createDocumentFragment();
  const measureCtx = document.createElement('canvas').getContext('2d');

  // Two-cursor flow layout (Antigravity's "independent cursors" pattern).
  //
  // The dilemma: the div's height determines both the selection
  // highlight size AND the flow advancement. These need different
  // values — fontSize for the highlight, medianHeight for the flow.
  //
  // Solution: two independent tracking variables:
  //   - actualDomBottom: where the div's box physically ends in the
  //     DOM (fontSize). Used to calculate marginTop for the next div.
  //   - logicalReservedBottom: where the line's "reserved space" ends
  //     (medianHeight). Used to prevent overlap with the next line.
  //
  // marginTop bridges the gap between actualDomBottom (small, tight
  // around text) and the target position. Since margins are NOT
  // highlighted during selection, the gap stays invisible.
  let actualDomBottom = 0;
  let logicalReservedBottom = 0;

  for (const line of linesToProcess) {
    const words = (line.words || [])
      .filter(w => w.text && w.text.trim() && w.confidence >= OCR_CONFIDENCE_THRESHOLD && !isOcrArtifact(w.text));

    if (words.length === 0) continue;

    // Sort words left-to-right
    words.sort((a, b) => a.bbox.x0 - b.bbox.x0);

    // --- Per-line fontSize from MEDIAN bbox height ---
    const wordHeights = words.map(w => (w.bbox.y1 - w.bbox.y0) * scaleY);
    wordHeights.sort((a, b) => a - b);
    const medianHeight = wordHeights[Math.floor(wordHeights.length / 2)];
    const fontSize = medianHeight * 0.85;

    if (fontSize < 1) continue;

    // --- Baseline Y from Tesseract ---
    let baselineY;
    if (line.baseline && line.baseline.y0 != null) {
      baselineY = ((line.baseline.y0 + line.baseline.y1) / 2) * scaleY;
    } else {
      const medianY0 = words.reduce((s, w) => s + w.bbox.y0, 0) / words.length;
      baselineY = (medianY0 * scaleY) + medianHeight * 0.78;
    }

    const lineTop = baselineY - fontSize;

    // --- Flow layout line div ---
    const lineDiv = document.createElement('div');
    lineDiv.className = 'text-line';
    lineDiv.style.fontSize = fontSize + 'px';

    // Target position: respect the logical reserved space of the
    // previous line (prevents overlap), but don't go above lineTop.
    const targetTop = Math.max(logicalReservedBottom, lineTop);

    // marginTop: physical distance from the previous div's DOM bottom
    // to where this div should start. margin is NOT highlighted
    // during selection, so the gap between lines stays invisible.
    const margin = targetTop - actualDomBottom;
    lineDiv.style.marginTop = margin + 'px';

    // height = fontSize ONLY — the div wraps tightly around the text.
    // No "zoccolo" (extra space below text that gets highlighted).
    lineDiv.style.height = fontSize + 'px';

    // Update both cursors for the next line:
    actualDomBottom = targetTop + fontSize;       // where the DOM box ends
    logicalReservedBottom = targetTop + medianHeight; // where the reserved space ends

    measureCtx.font = `${fontSize}px sans-serif`;

    // Track the right edge of the previous word (in CSS px) to compute
    // the exact marginLeft for each word. This eliminates the drift
    // caused by TextNode spaces accumulating tiny width errors across
    // a long line (the "space accumulation" bug — up to 10px on lines
    // with 15+ words, enough to cut off 2-6 characters of selection).
    let prevWordEnd = 0;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const wordText = normalizeLigatures(word.text);

      // Zero-width space separator for copy/paste.
      // A <span> with font-size:0 renders at zero width in the layout,
      // so it doesn't affect positioning. But the space character IS
      // part of the DOM text, so getSelection().toString() includes it
      // when the user copies text — preserving word boundaries.
      if (i > 0) {
        const gap = document.createElement('span');
        gap.textContent = ' ';
        gap.style.fontSize = '0';
        gap.dataset.gap = '';
        lineDiv.appendChild(gap);
      }

      const span = document.createElement('span');
      span.textContent = wordText;
      span.style.fontSize = fontSize + 'px';

      // Position each word at its exact OCR coordinate.
      // marginLeft = distance from where the flow cursor is (prevWordEnd)
      // to where this word actually starts (wordLeft from Tesseract bbox).
      // Since gap spans are zero-width, prevWordEnd IS the flow cursor.
      const wordLeft = word.bbox.x0 * scaleX;
      const margin = wordLeft - prevWordEnd;
      if (Math.abs(margin) > 0.5) {
        span.style.marginLeft = margin + 'px';
      }

      // Width: scaleX to match OCR bbox
      const wordWidth = (word.bbox.x1 - word.bbox.x0) * scaleX;
      if (wordWidth > 0) {
        const naturalWidth = measureCtx.measureText(wordText).width;
        if (naturalWidth > 0) {
          span.style.display = 'inline-block';
          span.style.width = wordWidth + 'px';
          span.style.transform = `scaleX(${wordWidth / naturalWidth})`;
          span.style.transformOrigin = 'left top';
        }
      }

      // Update flow cursor to this word's right edge
      prevWordEnd = wordLeft + wordWidth;

      lineDiv.appendChild(span);
    }

    fragment.appendChild(lineDiv);
  }

  container.appendChild(fragment);
}

/*
 * buildOcrTextLayerViaRoundTrip has been removed (Fase 31).
 * OCR text now uses buildOcrTextLayerDirect() — flat absolute
 * positioning directly from Tesseract coordinates, no round-trip.
 */

// Previous OCR text layer approaches (Fase 26-30) have been removed:
// - buildOcrTextLayer (Fase 8-21): manual OCR DOM builder
// - convertOcrToTextContent (Fase 26): arithmetic conversion to native format
// - buildOcrTextLayerViaRoundTrip (Fase 27-30): pdf-lib → PDF.js round-trip
// All replaced by buildOcrTextLayerDirect (Fase 31): flat absolute positioning.

// ============================================================
// Cleanup
// ============================================================

function cleanup() {
  viewport.innerHTML = '';
  pageSlots.clear();
  pageRenderState.clear();
  containerPool.length = 0;
  pageGeometry = [null];
  scrollSpacer = null;
}

// ============================================================
// Scale Calculation
// ============================================================

function isMobileLandscape() {
  return window.matchMedia('(pointer: coarse)').matches &&
    window.matchMedia('(orientation: landscape)').matches &&
    window.innerHeight < 500;
}

function calculateScale(page) {
  const vp = page.getViewport({ scale: 1 });
  return _calculateScale(
    vp.width, vp.height,
    window.innerWidth, window.innerHeight,
    48, 16, isMobileLandscape()
  );
}

// ============================================================
// Virtual Scrolling: Page Geometry + Container Pool
//
// Instead of creating one container per page (O(N) DOM nodes,
// 2N canvas contexts), we maintain a small pool of recycled
// containers. A spacer div provides the correct scroll height
// for the native scrollbar. During scroll, containers are
// repositioned and reassigned to whichever pages are visible.
//
// Why: 505 pages × 2 canvases = 1010 CanvasRenderingContext2D.
// Even zeroed, each context holds GPU state in the compositor.
// On 4GB devices this alone triggers OOM. With 7 containers
// (14 contexts), memory is O(1) regardless of document length.
// ============================================================

let scrollSpacer = null; // the tall div that drives the native scrollbar
const containerPool = []; // array of {element, mainCanvas, overlayCanvas, ...}

function createPoolContainer() {
  const container = document.createElement('div');
  container.className = 'page-container';
  container.style.position = 'absolute';
  container.style.left = '50%';
  container.style.transform = 'translateX(-50%)';
  container.style.display = 'none';

  const mainCanvas = document.createElement('canvas');
  mainCanvas.className = 'page-canvas';

  const overlayCanvas = document.createElement('canvas');
  overlayCanvas.className = 'page-overlay';

  const textLayer = document.createElement('div');
  textLayer.className = 'text-layer';

  const verticalOcrLayer = document.createElement('div');
  verticalOcrLayer.className = 'text-layer vertical-ocr-layer';

  const pageLabel = document.createElement('div');
  pageLabel.className = 'page-label';

  container.appendChild(mainCanvas);
  container.appendChild(overlayCanvas);
  container.appendChild(textLayer);
  container.appendChild(verticalOcrLayer);
  container.appendChild(pageLabel);

  return {
    element: container,
    mainCanvas,
    overlayCanvas,
    textLayer,
    verticalOcrLayer,
    pageLabel,
    assignedPage: null,
  };
}

function getOrCreateRenderState(pageNum) {
  let state = pageRenderState.get(pageNum);
  if (!state) {
    state = {
      rendered: false,
      rendering: false,
      renderGeneration: 0,
      ocrInProgress: false,
      imageRegionsCss: [],
      imageRegionsRaw: [],
      _renderTask: null,
    };
    pageRenderState.set(pageNum, state);
  }
  return state;
}

// Binary search: find first page whose bottom edge > viewTop
function binarySearchFirstVisible(viewTop) {
  let lo = 1, hi = pdfDoc.numPages;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const pg = pageGeometry[mid];
    if (pg.offsetTop + pg.cssHeight < viewTop) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function getVisiblePageRange() {
  const scrollTop = viewport.scrollTop;
  const viewportHeight = viewport.clientHeight;
  const viewBottom = scrollTop + viewportHeight;

  let firstVisible = binarySearchFirstVisible(scrollTop);
  let lastVisible = firstVisible;
  while (lastVisible < pdfDoc.numPages &&
    pageGeometry[lastVisible + 1].offsetTop < viewBottom) {
    lastVisible++;
  }

  const buf = _isMemoryConstrained ? 1 : VIRTUAL_BUFFER;
  const rangeStart = Math.max(1, firstVisible - buf);
  const rangeEnd = Math.min(pdfDoc.numPages, lastVisible + buf);

  return { firstVisible, lastVisible, rangeStart, rangeEnd };
}

function assignContainer(poolSlot, pageNum) {
  const geo = pageGeometry[pageNum];
  const el = poolSlot.element;

  el.style.top = geo.offsetTop + 'px';
  el.style.width = geo.cssWidth + 'px';
  el.style.height = geo.cssHeight + 'px';
  el.style.display = '';
  el.dataset.pageNum = pageNum;

  poolSlot.mainCanvas.style.width = geo.cssWidth + 'px';
  poolSlot.mainCanvas.style.height = geo.cssHeight + 'px';
  poolSlot.overlayCanvas.style.width = geo.cssWidth + 'px';
  poolSlot.overlayCanvas.style.height = geo.cssHeight + 'px';
  poolSlot.textLayer.style.width = geo.cssWidth + 'px';
  poolSlot.textLayer.style.height = geo.cssHeight + 'px';
  poolSlot.verticalOcrLayer.style.width = geo.cssWidth + 'px';
  poolSlot.verticalOcrLayer.style.height = geo.cssHeight + 'px';
  poolSlot.pageLabel.textContent = pageNum;

  poolSlot.assignedPage = pageNum;
  pageSlots.set(pageNum, poolSlot);

  // Trigger rendering if not already done
  const state = getOrCreateRenderState(pageNum);
  if (!state.rendered && !state.rendering) {
    enqueueRender(pageNum);
  }
}

function evictContainer(poolSlot) {
  const pageNum = poolSlot.assignedPage;
  if (pageNum == null) return;

  // Cancel pending work
  cancelQueuedRender(pageNum);
  cancelOcrJobsForPage(pageNum);
  const state = pageRenderState.get(pageNum);
  if (state && state._renderTask) {
    state._renderTask.cancel();
    state._renderTask = null;
  }

  // Release canvas memory
  poolSlot.mainCanvas.width = 0;
  poolSlot.mainCanvas.height = 0;
  poolSlot.overlayCanvas.width = 0;
  poolSlot.overlayCanvas.height = 0;
  poolSlot.overlayCanvas.classList.remove('overlay-visible');
  poolSlot.mainCanvas.classList.remove('dark-active');
  poolSlot.mainCanvas.style.visibility = '';
  poolSlot.overlayCanvas.style.visibility = '';

  // Clear text layers and annotations
  poolSlot.textLayer.innerHTML = '';
  poolSlot.verticalOcrLayer.innerHTML = '';
  poolSlot.element.querySelectorAll('.link-annot').forEach(el => el.remove());
  poolSlot.element.querySelectorAll('[data-ocr-loading]').forEach(el => el.remove());
  poolSlot.element.classList.remove('ocr-loading', 'ocr-done');

  // Release PDF.js page cache on constrained devices
  if (_isMemoryConstrained && pdfDoc && !isResetting) {
    pdfDoc.getPage(pageNum).then(p => p.cleanup()).catch(() => {});
  }

  // Update state
  if (state) {
    state.rendered = false;
    state.rendering = false;
    state.ocrInProgress = false;
    state.imageRegionsCss = [];
    state.imageRegionsRaw = [];
  }

  poolSlot.element.style.display = 'none';
  poolSlot.assignedPage = null;
  pageSlots.delete(pageNum);
}

function reconcileContainers() {
  if (!pdfDoc || pdfDoc.numPages === 0) return;

  const { rangeStart, rangeEnd } = getVisiblePageRange();
  const needed = new Set();
  for (let p = rangeStart; p <= rangeEnd; p++) needed.add(p);

  // Release containers no longer in range
  for (const poolSlot of containerPool) {
    if (poolSlot.assignedPage != null && !needed.has(poolSlot.assignedPage)) {
      evictContainer(poolSlot);
    }
  }

  // Assign free containers to newly-needed pages (closest to center first)
  const centerPage = Math.round((rangeStart + rangeEnd) / 2);
  const sorted = [...needed].filter(p => !pageSlots.has(p))
    .sort((a, b) => Math.abs(a - centerPage) - Math.abs(b - centerPage));

  for (const pageNum of sorted) {
    const free = containerPool.find(s => s.assignedPage === null);
    if (!free) break; // pool exhausted
    assignContainer(free, pageNum);
  }
}

async function buildPageSlots() {
  if (!pdfDoc) return;

  // Clear previous state
  viewport.innerHTML = '';
  pageSlots.clear();
  pageRenderState.clear();
  containerPool.length = 0;
  pageGeometry = [null]; // index 0 unused (pages are 1-based)

  // Determine scale from first page
  const firstPage = await pdfDoc.getPage(1);
  const scale = calculateScale(firstPage);
  currentScale = scale;
  const dpr = getDpr();

  // Compute geometry for all pages. Most PDFs have uniform page sizes —
  // detect this after page 1 and skip getPage() for the rest.
  const firstVp = firstPage.getViewport({ scale: scale * dpr });
  const firstCssW = Math.floor(firstVp.width / dpr);
  const firstCssH = Math.floor(firstVp.height / dpr);
  let uniform = true;

  // Build geometry table
  let offsetTop = VIEWPORT_PADDING_TOP;
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    let cssW = firstCssW;
    let cssH = firstCssH;

    if (i > 1) {
      // Check if this page has different dimensions
      const page = await pdfDoc.getPage(i);
      const vp = page.getViewport({ scale: scale * dpr });
      cssW = Math.floor(vp.width / dpr);
      cssH = Math.floor(vp.height / dpr);
      if (cssW !== firstCssW || cssH !== firstCssH) uniform = false;
    }

    pageGeometry[i] = { cssWidth: cssW, cssHeight: cssH, offsetTop };
    offsetTop += cssH + PAGE_GAP;

    // Optimization: if all pages so far are uniform, skip getPage for rest
    if (uniform && i === 2 && cssW === firstCssW && cssH === firstCssH) {
      for (let j = 3; j <= pdfDoc.numPages; j++) {
        offsetTop = VIEWPORT_PADDING_TOP + (j - 1) * (firstCssH + PAGE_GAP);
        pageGeometry[j] = { cssWidth: firstCssW, cssHeight: firstCssH, offsetTop };
      }
      break;
    }
  }

  // Total scroll height
  const totalHeight = pageGeometry[pdfDoc.numPages].offsetTop +
    pageGeometry[pdfDoc.numPages].cssHeight + 16; // bottom padding

  // Create spacer
  scrollSpacer = document.createElement('div');
  scrollSpacer.id = 'scroll-spacer';
  scrollSpacer.style.position = 'relative';
  scrollSpacer.style.width = '100%';
  scrollSpacer.style.height = totalHeight + 'px';

  // Create container pool
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = createPoolContainer();
    scrollSpacer.appendChild(slot.element);
    containerPool.push(slot);
  }

  viewport.appendChild(scrollSpacer);

  // Initial assignment
  reconcileContainers();
}

// ============================================================
// Device Detection & Memory Profiles
// ============================================================

const _isMobileDevice = window.matchMedia('(pointer: coarse)').matches;
const _isIOS = _isMobileDevice && /iPad|iPhone/.test(navigator.userAgent);
const _deviceMemoryGB = navigator.deviceMemory || 0;
const _isMemoryConstrained = _isIOS || (_isMobileDevice && (_deviceMemoryGB > 0 ? _deviceMemoryGB <= 4 : false));

const LARGE_DOC_THRESHOLD = 150;
let _isLargeDocConstrained = false;

function getDpr() {
  const raw = window.devicePixelRatio || 1;
  return _isLargeDocConstrained ? Math.min(raw, 2) : raw;
}

// ============================================================
// Scroll Velocity Detection
//
// Measures scroll speed to distinguish reading (slow) from
// seeking (fast). During fast scroll, page rendering is deferred
// to avoid allocating dozens of canvas backing stores that
// overwhelm iOS WebKit's lazy GC — the #1 cause of Jetsam kills.
//
// Pattern: Instagram/Twitter infinite scroll, iOS UIScrollView
// scrollViewDidEndDecelerating.
// ============================================================

let isScrollingFast = false;
let lastScrollTop = 0;
let lastScrollTime = 0;
let scrollVelocityTimer = null;
const SCROLL_FAST_THRESHOLD = 3000; // px/sec — above this, defer rendering

viewport.addEventListener('scroll', () => {
  const now = performance.now();
  const dt = now - lastScrollTime;
  const scrollTop = viewport.scrollTop;
  if (dt > 0 && lastScrollTime > 0) {
    const dy = Math.abs(scrollTop - lastScrollTop);
    const velocity = (dy / dt) * 1000; // px/sec
    isScrollingFast = velocity > SCROLL_FAST_THRESHOLD;
  }
  lastScrollTop = scrollTop;
  lastScrollTime = now;

  // When scroll stops, mark as slow after a brief settle
  clearTimeout(scrollVelocityTimer);
  scrollVelocityTimer = setTimeout(() => {
    isScrollingFast = false;
    // Flush any deferred renders now that scroll has settled
    flushRenderQueue();
  }, 150);
}, { passive: true });

// ============================================================
// Canvas Pool
//
// Reusable offscreen canvases for PDF.js rendering. Instead of
// creating/destroying a canvas per page (which thrashes iOS
// WebKit's lazy GC of GPU backing stores), we maintain a small
// pool. A canvas is borrowed for rendering, then returned.
//
// Pool size matches the concurrency limit — we never need more
// canvases than concurrent renders.
// ============================================================

// Mobile: 1 concurrent render to stay within iOS Safari's memory budget.
// Playwright: 1 to avoid Tesseract contention in headless Chromium.
// Desktop: 3 for fast parallel rendering.
// Memory-constrained: 1 (iOS, budget Android). Other mobile: 2. Desktop: 3.
// Playwright: 1 (avoid Tesseract contention in headless Chromium).
let MAX_CONCURRENT_RENDERS = navigator.webdriver ? 1 : _isMemoryConstrained ? 1 : _isMobileDevice ? 2 : 3;

function createOffscreenCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const canvasPool = [];

function borrowCanvas(w, h) {
  const c = canvasPool.pop() || document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function returnCanvas(c) {
  // Clear but keep the backing store for reuse
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
  if (canvasPool.length < MAX_CONCURRENT_RENDERS + 1) {
    canvasPool.push(c);
  } else {
    // Pool full — release this one
    c.width = 0;
  }
}

// ============================================================
// Render Queue with Concurrency Limit
//
// Pages don't render directly — they enter a queue sorted by
// distance from the viewport center. At most MAX_CONCURRENT_RENDERS
// can run simultaneously. If a queued page is evicted before
// rendering starts, it's silently dropped.
//
// During fast scroll, the queue accepts entries but doesn't
// process them until scroll settles (flushRenderQueue).
// ============================================================

const renderQueue = [];
let activeRenders = 0;

// ============================================================
// iOS PDF Engine Reset (Compartment Seal)
//
// PDF.js runs a web worker that accumulates internal state:
// parsed XRef tables, decoded font programs, stream decoder
// caches, shared objects. page.cleanup() releases per-page
// data; pdfDoc.cleanup() releases some shared resources. But
// the worker thread retains structures that neither cleanup
// method fully releases. After ~400 getPage() calls, this
// accumulated state alone can reach 200-300MB — triggering
// iOS Safari's jetsam kill (tab crash).
//
// The solution: periodically destroy the entire PDF.js instance
// (main thread + worker thread) and recreate it from the
// original ArrayBuffer. This is a full reset — zero residual
// state, zero accumulation. The cost is ~200-400ms to
// reinitialize the document, scheduled during idle time so the
// user never notices.
//
// Pages already painted on canvas are unaffected — the pixels
// live in the DOM, not in PDF.js. Only the next page the user
// scrolls to will use the fresh instance.
//
// Non-iOS devices skip this entirely — Android Chrome and
// desktop browsers have real swap/compression and don't need it.
// ============================================================

// Large iOS documents reset more aggressively (15) to keep the
// worker thread's accumulated state well under the jetsam limit.
// Normal mobile documents get a relaxed threshold (40) for
// smoother scrolling and less CPU heat.
function getEngineResetThreshold() {
  if (_isLargeDocConstrained) return 15;
  return 40;
}
let rendersSinceReset = 0;
let isResetPending = false;
let isResetting = false; // true during async destroy/recreate

// Safari's requestIdleCallback support is incomplete — use rAF + setTimeout
// as a reliable fallback that still defers to an idle moment.
const scheduleIdle = typeof requestIdleCallback === 'function'
  ? requestIdleCallback
  : (fn) => requestAnimationFrame(() => setTimeout(fn, 0));

async function resetPdfEngine() {
  if (!pdfDoc || !_pdfBuffer || isResetting) return;

  isResetting = true;
  const gen = ++globalGeneration;

  // Cancel all in-flight and queued work — they hold page
  // references from the old instance that will become invalid.
  renderQueue.length = 0;
  ocrQueue.forEach(j => { j.cancelled = true; });
  ocrQueue.length = 0;

  try {
    // Destroy the old instance (main thread + worker thread).
    // This releases ALL accumulated state.
    await pdfDoc.destroy();

    // Recreate from the original buffer. PDF.js may transfer
    // ArrayBuffers internally, so we always pass a fresh copy.
    pdfDoc = await pdfjsLib.getDocument({
      data: _pdfBuffer.slice(0),
    }).promise;

    rendersSinceReset = 0;
    isResetPending = false;

    // Stale check: if a new document was loaded during the await,
    // globalGeneration will have changed — abandon this reset.
    if (globalGeneration !== gen) return;

    // Re-trigger rendering for pages currently near the viewport.
    // Their canvases still have pixels — this is a no-op for
    // slot.rendered === true pages. Only evicted-then-revisited
    // pages will actually re-render.
    flushRenderQueue();
  } catch (err) {
    // If destroy/recreate fails (e.g., corrupt buffer), log but
    // don't crash — the old pdfDoc is already destroyed, so we
    // can't recover. The user will need to re-open the file.
    console.warn('PDF engine reset failed:', err);
  } finally {
    isResetting = false;
  }
}

function maybeScheduleEngineReset() {
  if (!_isMemoryConstrained || !isResetPending || !pdfDoc) return;
  if (activeRenders > 0 || isResetting) return;

  scheduleIdle(() => {
    // Re-check after yielding to the event loop — a render
    // may have started, or a new document may have been loaded.
    if (!pdfDoc || activeRenders > 0 || isResetting || !isResetPending) return;
    resetPdfEngine();
  });
}

function enqueueRender(pageNum) {
  if (!pdfDoc || pageNum < 1 || pageNum > pdfDoc.numPages) return;
  if (!pageSlots.has(pageNum)) return; // page has no active container
  const state = getOrCreateRenderState(pageNum);
  if (state.rendered || state.rendering) return;

  // Don't duplicate
  if (renderQueue.includes(pageNum)) return;

  renderQueue.push(pageNum);
  processRenderQueue();
}

function processRenderQueue() {
  if (isScrollingFast || isResetting) return; // wait for scroll to settle / engine reset

  while (activeRenders < MAX_CONCURRENT_RENDERS && renderQueue.length > 0) {
    // Sort by distance from current visible page (closest first)
    const visPage = currentVisiblePage || 1;
    renderQueue.sort((a, b) => Math.abs(a - visPage) - Math.abs(b - visPage));

    const pageNum = renderQueue.shift();
    const slot = pageSlots.get(pageNum);

    // Skip if already rendered, evicted, or stale
    if (!slot || slot.rendered || slot.rendering) continue;

    activeRenders++;
    renderPageIfNeeded(pageNum).finally(() => {
      activeRenders--;

      // Track memory pressure from accumulated renders.
      // On iOS, trigger a full engine reset every N pages to
      // prevent the PDF.js worker from accumulating fatal levels
      // of cached state (fonts, XRef, stream decoders).
      rendersSinceReset++;
      if (rendersSinceReset >= getEngineResetThreshold()) {
        isResetPending = true;
      }

      // If queue is empty and a reset is pending, this is the
      // quiet moment — schedule it before picking up more work.
      if (activeRenders === 0 && isResetPending) {
        maybeScheduleEngineReset();
      }

      processRenderQueue(); // pick up next in queue
    });
  }
}

function flushRenderQueue() {
  processRenderQueue();
}

// Cancel queued renders for a specific page (called by eviction observer)
function cancelQueuedRender(pageNum) {
  const idx = renderQueue.indexOf(pageNum);
  if (idx !== -1) renderQueue.splice(idx, 1);
}

// ============================================================
// Page Rendering
// ============================================================

async function renderPageIfNeeded(pageNum) {
  if (!pdfDoc || pageNum < 1 || pageNum > pdfDoc.numPages) return;

  const slot = pageSlots.get(pageNum);
  if (!slot) return;
  const state = getOrCreateRenderState(pageNum);
  if (state.rendered || state.rendering) return;

  state.rendering = true;
  const myGen = globalGeneration;
  state.renderGeneration = myGen;

  try {
    const page = await pdfDoc.getPage(pageNum);
    if (globalGeneration !== myGen) return;

    const dpr = getDpr();
    const scaledViewport = page.getViewport({ scale: currentScale * dpr });
    const w = Math.floor(scaledViewport.width);
    const h = Math.floor(scaledViewport.height);

    // Borrow a canvas from the pool instead of creating a new one.
    // This avoids thrashing iOS WebKit's lazy GC of GPU backing stores.
    const renderCanvas = borrowCanvas(w, h);

    // Render + get operator list (+ text content for native PDFs).
    // Store the RenderTask so we can cancel it if the page is evicted.
    const renderTask = page.render({
      canvasContext: renderCanvas.getContext('2d'),
      viewport: scaledViewport,
    });
    state._renderTask = renderTask;

    const parallelTasks = [
      renderTask.promise,
      page.getOperatorList(),
    ];
    // Skip getTextContent for scanned docs — it returns nothing useful
    if (!isScannedDocument) {
      parallelTasks.push(page.getTextContent());
    }

    const results = await Promise.all(parallelTasks);
    const opList = results[1];
    const textContent = isScannedDocument ? null : results[2];

    if (globalGeneration !== myGen) return;

    // --- Already-dark detection ---
    const isDark = detectAlreadyDark(renderCanvas);
    pageAlreadyDark.set(pageNum, isDark);

    // --- Extract image regions (skip if scanned document) ---
    const regions = isScannedDocument
      ? []
      : extractImageRegions(opList, scaledViewport.transform);

    // --- Compose page behind placeholder, then reveal ---
    // Hide the canvas during composition so the user sees the
    // dark placeholder (#1e1e1e) until everything is ready:
    // content painted + dark mode filter + overlay. This eliminates
    // the light→dark flash on page transitions. The visibility
    // toggle is a compositing-only operation (GPU flag, no reflow).
    slot.mainCanvas.style.visibility = 'hidden';
    slot.overlayCanvas.style.visibility = 'hidden';

    // Paint main canvas
    slot.mainCanvas.width = w;
    slot.mainCanvas.height = h;
    const mainCtx = slot.mainCanvas.getContext('2d');
    mainCtx.drawImage(renderCanvas, 0, 0);

    // Paint overlay canvas
    slot.overlayCanvas.width = w;
    slot.overlayCanvas.height = h;
    if (regions.length > 0) {
      compositeImageRegions(slot.overlayCanvas.getContext('2d'), renderCanvas, regions, w, h);
    }

    // --- Text layer ---
    if (isScannedDocument) {
      // OCR runs in background — text becomes selectable silently
      const cssW = Math.floor(w / dpr);
      const cssH = Math.floor(h / dpr);

      // Check cache first — avoids re-OCR when page was evicted and re-rendered
      const cacheKey = `page-${pageNum}`;
      const cached = ocrCache.get(cacheKey);
      if (cached) {
        buildOcrTextLayerDirect(
          slot.textLayer, cached, cached._canvasW, cached._canvasH, cssW, cssH
        );
      } else {
        state.ocrInProgress = true;
        const effectiveScale = currentScale * dpr;

        enqueueOcrJob({
          id: cacheKey,
          pageNum,
          cancelled: false,
          execute: async () => {
            if (globalGeneration !== myGen) return;

            let ocrCanvas;
            if (effectiveScale >= OCR_MIN_SCALE) {
              ocrCanvas = renderCanvas;
            } else {
              // Display canvas is too low-res — render higher resolution for Tesseract
              renderCanvas.width = 0;
              const ocrViewport = page.getViewport({ scale: OCR_MIN_SCALE });
              ocrCanvas = createOffscreenCanvas(
                Math.floor(ocrViewport.width),
                Math.floor(ocrViewport.height)
              );
              await page.render({
                canvasContext: ocrCanvas.getContext('2d'),
                viewport: ocrViewport,
              }).promise;
              if (globalGeneration !== myGen) { ocrCanvas.width = 0; return; }
            }

            const worker = await ensureTesseractWorker();
            if (!worker || globalGeneration !== myGen) { ocrCanvas.width = 0; return; }

            const processed = preprocessCanvasForOcr(ocrCanvas);
            ocrCanvas.width = 0;

            const { data } = await worker.recognize(processed);
            if (globalGeneration !== myGen) { processed.width = 0; return; }

            // Cache the result for re-renders
            data._canvasW = processed.width;
            data._canvasH = processed.height;
            ocrCache.set(cacheKey, data);

            // The slot may have been recycled during OCR — re-lookup
            const currentSlot = pageSlots.get(pageNum);
            if (currentSlot) {
              buildOcrTextLayerDirect(
                currentSlot.textLayer, data, processed.width, processed.height, cssW, cssH
              );
              ocrFinished(currentSlot);
            }
          },
        });
      }
    } else {
      buildTextLayer(slot.textLayer, textContent, scaledViewport, dpr);
      returnCanvas(renderCanvas);

      // OCR on images within native PDFs — scheduled through the queue.
      if (regions.length > 0) {
        const candidates = regions
          .filter(r => r.width >= OCR_IMAGE_MIN_SIZE && r.height >= OCR_IMAGE_MIN_SIZE)
          .sort((a, b) => (b.width * b.height) - (a.width * a.height)); // largest first

        // Store image region bounds for hit-testing and on-demand vertical OCR
        state.imageRegionsRaw = candidates.map(r => ({ ...r }));
        state.imageRegionsCss = candidates.map(r => ({
          x: Math.max(0, r.x) / dpr,
          y: Math.max(0, r.y) / dpr,
          w: Math.min(r.width, w - Math.max(0, r.x)) / dpr,
          h: Math.min(r.height, h - Math.max(0, r.y)) / dpr,
        }));

        // Only auto-OCR the top N images (budget). Rest are on-demand.
        const autoOcr = candidates.slice(0, OCR_IMAGE_BUDGET);
        if (autoOcr.length > 0) {
          state.ocrInProgress = true;

          enqueueOcrJob({
            id: `img-${pageNum}`,
            pageNum,
            cancelled: false,
            execute: async () => {
              const currentSlot = pageSlots.get(pageNum);
              if (!currentSlot) return;
              await ocrImageRegions(
                currentSlot.mainCanvas, currentSlot.textLayer, currentSlot.verticalOcrLayer,
                autoOcr.map(r => ({ ...r })), dpr, myGen, pageNum
              );
              ocrFinished(currentSlot);
            },
          });
        }
      }
    }

    // --- Link annotations ---
    try {
      const annotations = await page.getAnnotations();
      if (globalGeneration === myGen) {
        buildLinkLayer(slot.element, annotations, scaledViewport, dpr, pageNum);
      }
    } catch (_) { /* some pages have no annotations */ }

    state.rendered = true;
    state._renderTask = null;
    applyDarkModeToPage(pageNum);

    // Everything is ready — reveal both canvases in one compositing frame.
    slot.mainCanvas.style.visibility = '';
    slot.overlayCanvas.style.visibility = '';

    // On memory-constrained devices, release PDF.js internal caches.
    if (_isMemoryConstrained) page.cleanup();
  } catch (err) {
    if (globalGeneration !== myGen) return;
    if (err?.name !== 'RenderingCancelledException' && err?.message !== 'Rendering cancelled') {
      console.error(`Render page ${pageNum} failed:`, err);
    }
  } finally {
    state.rendering = false;
    state._renderTask = null;
  }
}

// ============================================================
// Already-Dark Detection
//
// Samples corners and edges of the rendered page to estimate
// background luminance. If the background is already dark,
// inverting would make it light — which is not what we want.
// ============================================================

function detectAlreadyDark(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, w, h);
  return _detectAlreadyDark(imageData.data, w, h);
}

// ============================================================
// Text Layer
//
// Builds a continuous-flow text overlay for smooth selection.
//
// Problem: absolutely-positioned spans leave gaps in the DOM.
// When the user drags a selection through a gap, the browser
// loses track and jumps to random fragments.
//
// Solution: group text items into lines (by Y coordinate),
// sort left-to-right within each line, and render as a
// continuous DOM flow with:
//   - Each line is a block-level <div> positioned at its Y
//   - Within a line, spans flow left-to-right with precise
//     left-margin gaps between them
//   - Between lines, the block flow gives the browser a
//     natural top-to-bottom selection path
//
// The result is a gapless selectable surface: dragging from
// any point to any other point produces a clean, continuous
// selection — like on iOS.
// ============================================================

function buildTextLayer(container, textContent, viewport, dpr) {
  container.innerHTML = '';

  // Shared canvas for measuring text widths without DOM reflows
  const measureCtx = document.createElement('canvas').getContext('2d');

  // --- Step 1: Transform all items to screen coordinates ---
  const items = [];
  for (const item of textContent.items) {
    if (!item.str && !item.hasEOL) continue;

    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
    const fontSize = fontHeight / dpr;

    if (fontSize < 1) continue;

    const left = tx[4] / dpr;
    const top = tx[5] / dpr - fontSize * BASELINE_RATIO;
    const pdfWidth = item.width > 0 ? (item.width * viewport.scale / dpr) : 0;

    items.push({
      str: normalizeLigatures(item.str || ''),
      left,
      top,
      fontSize,
      pdfWidth,
      height: fontSize,
      hasEOL: !!item.hasEOL,
      tx1: tx[1],
      tx2: tx[2],
    });
  }

  if (items.length === 0) return;

  // --- Step 2: Group into lines (uses core.groupItemsIntoLines) ---
  const lines = groupItemsIntoLines(items);

  // --- Step 3: Build DOM with continuous flow ---
  const fragment = document.createDocumentFragment();

  // Measure inherited space width for TextNode compensation
  const inheritedFontSize = parseFloat(getComputedStyle(container).fontSize) || 16;
  measureCtx.font = `${inheritedFontSize}px sans-serif`;
  const spaceAdvance = measureCtx.measureText(' ').width;

  let prevBottom = 0;

  for (const rawLine of lines) {
    rawLine.sort((a, b) => a.left - b.left);
    const line = mergePunctuation(rawLine);

    const lineDiv = document.createElement('div');
    lineDiv.className = 'text-line';

    const lt = line[0].top;
    const lh = Math.max(...line.map(it => it.height));

    const vGap = Math.max(0, lt - prevBottom);
    lineDiv.style.paddingTop = vGap + 'px';
    lineDiv.style.height = (lh + vGap) + 'px';

    prevBottom = lt + lh;

    let cursor = 0;
    let prevStr = '';

    for (let i = 0; i < line.length; i++) {
      const item = line[i];
      if (!item.str) continue;

      const gap = item.left - cursor;
      let adjustedGap = gap;

      // Determine word boundary (uses core.shouldInsertSpace)
      if (cursor > 0) {
        const result = shouldInsertSpace(
          prevStr, item.str, gap, item.fontSize, spaceAdvance
        );
        if (result.insertSpace) {
          lineDiv.appendChild(document.createTextNode(' '));
        }
        adjustedGap = result.adjustedGap;
      }

      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.fontSize = item.fontSize + 'px';

      if (adjustedGap > 0.5) {
        span.style.marginLeft = adjustedGap + 'px';
      }

      if (item.pdfWidth > 0) {
        measureCtx.font = `${item.fontSize}px sans-serif`;
        const naturalWidth = measureCtx.measureText(item.str).width;

        if (naturalWidth > 0) {
          const scaleX = item.pdfWidth / naturalWidth;
          span.style.display = 'inline-block';
          span.style.width = item.pdfWidth + 'px';
          span.style.transform = `scaleX(${scaleX})`;
          span.style.transformOrigin = 'left top';
        }
      }

      if (item.tx1 !== 0 || item.tx2 !== 0) {
        const angle = Math.atan2(item.tx1, Math.sqrt(item.tx2 * item.tx2 + (item.fontSize * dpr) * (item.fontSize * dpr)));
        span.style.transform = `rotate(${angle}rad)`;
        span.style.transformOrigin = '0 100%';
      }

      lineDiv.appendChild(span);
      cursor = item.left + (item.pdfWidth || 0);
      prevStr = item.str;
    }

    fragment.appendChild(lineDiv);
  }

  container.appendChild(fragment);
}

// ============================================================
// Link Annotation Layer
//
// Extracts link annotations from the PDF and overlays clickable
// <a> elements on top of the page. External links open in a new
// tab; internal links scroll to the target page in the viewport.
//
// These are position:absolute elements in the page-container,
// sitting above the text layer but with pointer-events only on
// themselves. user-select:none ensures they don't interfere
// with text selection or copy/paste.
// ============================================================

function buildLinkLayer(container, annotations, viewport, dpr, pageNum) {
  // Remove any previous link layer
  container.querySelectorAll('.link-annot').forEach(el => el.remove());

  for (const annot of annotations) {
    if (annot.subtype !== 'Link') continue;
    if (!annot.rect || annot.rect.length < 4) continue;

    // Determine destination
    const url = annot.url || null;
    const dest = annot.dest || null;
    if (!url && !dest) continue;

    // Transform PDF rect [x1, y1, x2, y2] to CSS coordinates.
    // viewport.transform is a 6-element affine matrix [a,b,c,d,e,f].
    const [x1, y1, x2, y2] = annot.rect;
    const vt = viewport.transform;
    const p1 = transformPoint(vt, x1, y1);
    const p2 = transformPoint(vt, x2, y2);

    const left = Math.min(p1[0], p2[0]) / dpr;
    const top = Math.min(p1[1], p2[1]) / dpr;
    const width = Math.abs(p2[0] - p1[0]) / dpr;
    const height = Math.abs(p2[1] - p1[1]) / dpr;

    if (width < 1 || height < 1) continue;

    const a = document.createElement('a');
    a.className = 'link-annot';

    if (url) {
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else if (dest) {
      a.href = '#';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        resolveInternalLink(dest);
      });
    }

    a.style.position = 'absolute';
    a.style.left = left + 'px';
    a.style.top = top + 'px';
    a.style.width = width + 'px';
    a.style.height = height + 'px';

    container.appendChild(a);
  }
}

async function resolveInternalLink(dest) {
  if (!pdfDoc) return;

  try {
    let pageIndex;

    if (typeof dest === 'string') {
      // Named destination — resolve via PDF.js
      const resolved = await pdfDoc.getDestination(dest);
      if (!resolved) return;
      pageIndex = await pdfDoc.getPageIndex(resolved[0]);
    } else if (Array.isArray(dest) && dest.length > 0) {
      // Explicit destination — first element is page ref
      pageIndex = await pdfDoc.getPageIndex(dest[0]);
    } else {
      return;
    }

    const targetPage = pageIndex + 1; // PDF.js uses 0-based index
    scrollToPage(targetPage);
  } catch (err) {
    console.warn('Could not resolve internal link:', err);
  }
}

// extractImageRegions: thin wrapper that passes OPS_MAP to core
function extractImageRegions(opList, viewportTransform) {
  return _extractImageRegions(opList, viewportTransform, OPS_MAP);
}

// compositeImageRegions: imported from core.js

// ============================================================
// Dark Mode Logic
//
// Each page resolves its dark mode state through:
// 1. User override (if set) — 'dark' or 'light'
// 2. Already-dark detection — if page is dark, skip inversion
// 3. Default — apply dark mode
// ============================================================

function shouldApplyDark(pageNum) {
  return _shouldApplyDark(pageNum, pageDarkOverride, pageAlreadyDark);
}

function applyDarkModeToPage(pageNum) {
  const slot = pageSlots.get(pageNum);
  if (!slot) return;
  const state = pageRenderState.get(pageNum);
  if (!state || !state.rendered) return;

  const dark = shouldApplyDark(pageNum);
  slot.mainCanvas.classList.toggle('dark-active', dark);
  slot.overlayCanvas.classList.toggle('overlay-visible', dark);
}

function applyDarkModeToAllPages() {
  for (const [pageNum] of pageSlots) {
    applyDarkModeToPage(pageNum);
  }
}

// ============================================================
// Current Page Tracking (from scroll position)
// ============================================================

let currentVisiblePage = 1;

function updateCurrentPageFromScroll() {
  if (!pdfDoc || pageGeometry.length <= 1) return;

  // Find the page whose center is closest to the viewport center.
  // Uses the precomputed geometry table — pure math, no DOM queries.
  const viewCenter = viewport.scrollTop + viewport.clientHeight / 2;
  let closestPage = 1;
  let closestDist = Infinity;

  // Binary search for approximate location, then linear scan nearby
  const approx = binarySearchFirstVisible(viewport.scrollTop);
  const lo = Math.max(1, approx - 3);
  const hi = Math.min(pdfDoc.numPages, approx + 5);
  for (let i = lo; i <= hi; i++) {
    const geo = pageGeometry[i];
    const pageCenter = geo.offsetTop + geo.cssHeight / 2;
    const dist = Math.abs(pageCenter - viewCenter);
    if (dist < closestDist) {
      closestDist = dist;
      closestPage = i;
    }
  }

  currentVisiblePage = closestPage;
  updateNavigationUI();
  updateToggleButton();
}

// ============================================================
// Toggle Button State
// ============================================================

function updateToggleButton() {
  const dark = shouldApplyDark(currentVisiblePage);
  iconDark.hidden = !dark;
  iconLight.hidden = dark;
  btnToggle.classList.toggle('toggle-active', dark);
}

function toggleDarkMode() {
  const pageNum = currentVisiblePage;
  const currentlyDark = shouldApplyDark(pageNum);

  if (currentlyDark) {
    pageDarkOverride.set(pageNum, 'light');
  } else {
    pageDarkOverride.set(pageNum, 'dark');
  }

  applyDarkModeToPage(pageNum);
  updateToggleButton();
}

// ============================================================
// Navigation
// ============================================================

function updateNavigationUI() {
  if (!pdfDoc) return;
  pageInfo.textContent = `${currentVisiblePage} / ${pdfDoc.numPages}`;
  btnPrev.disabled = currentVisiblePage <= 1;
  btnNext.disabled = currentVisiblePage >= pdfDoc.numPages;
}

// Click-to-edit page number: transforms the label into an input.
//
// On mobile, the virtual keyboard's "Go"/"Done" button fires blur
// BEFORE keydown Enter. If blur calls restore() (removing the input),
// the keydown never arrives and the navigation doesn't happen.
// Fix: commit on blur if the value changed, not just on Enter.
pageInfo.addEventListener('click', () => {
  if (!pdfDoc) return;

  const current = currentVisiblePage;
  const total = pdfDoc.numPages;

  // Create inline input
  const input = document.createElement('input');
  input.id = 'page-input';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.pattern = '[0-9]*';
  input.value = current;
  input.setAttribute('aria-label', `Go to page (1-${total})`);

  // Pause focus mode while editing — toolbar stays visible
  focusPaused = true;
  clearTimeout(focusTimer);
  focusTimer = null;

  let committed = false;

  // Replace the label with the input
  pageInfo.style.display = 'none';
  pageInfo.parentNode.insertBefore(input, pageInfo);
  input.select();

  function commit() {
    if (committed) return;
    committed = true;
    const val = parseInt(input.value, 10);
    if (!isNaN(val) && val >= 1 && val <= total) {
      scrollToPage(val);
    }
    restore();
  }

  function restore() {
    if (!input.parentNode) return; // already removed
    input.remove();
    pageInfo.style.display = '';
    // Resume focus mode
    focusPaused = false;
    resetFocusTimer();
  }

  input.addEventListener('keydown', (e) => {
    // Android virtual keyboards may send keyCode 13 without key='Enter',
    // or fire 'Go'/'Done' as an unidentified key. Check both.
    if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); restore(); }
  });

  // Some Android IMEs fire 'change' instead of keydown on submit.
  input.addEventListener('change', () => { commit(); });

  // On mobile, blur fires when the keyboard dismisses.
  // Commit if the value changed, otherwise just restore.
  input.addEventListener('blur', () => {
    if (input.value !== String(current)) {
      commit();
    } else {
      restore();
    }
  });
});

function scrollToPage(pageNum, instant = false) {
  if (!pdfDoc || pageGeometry.length <= 1) return;
  const clamped = Math.max(1, Math.min(pageNum, pdfDoc.numPages));
  const geo = pageGeometry[clamped];
  if (!geo) return;

  // Scroll so the page is centered in the viewport
  const target = geo.offsetTop - (viewport.clientHeight - geo.cssHeight) / 2;
  viewport.scrollTo({
    top: Math.max(0, target),
    behavior: (instant || _isMemoryConstrained) ? 'instant' : 'smooth',
  });
}

// ============================================================
// Export Dark PDF
//
// Renders each page with dark mode applied, composites original
// images on top, and assembles a new PDF using pdf-lib.
// An invisible text layer (opacity: 0) is embedded for
// selectability and search. For scanned docs, OCR runs on each
// page during export.
//
// Pages are processed sequentially to keep memory bounded:
// only one page's canvases are alive at any time.
// ============================================================

async function ensurePdfLib() {
  if (pdfLibModule) return pdfLibModule;
  pdfLibModule = await import('https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js');
  return pdfLibModule;
}

async function ensureUnicodeFont() {
  // Load fontkit (required by pdf-lib for custom font embedding)
  if (!fontkitModule) {
    try {
      const mod = await import(
        'https://esm.sh/@pdf-lib/fontkit@1.1.1'
      );
      fontkitModule = mod.default || mod;
    } catch (e) {
      console.warn('Failed to load fontkit:', e);
      return null;
    }
  }

  // Load Noto Sans Regular TTF (comprehensive Unicode coverage)
  if (!cachedFontBytes) {
    try {
      const resp = await fetch(
        'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf'
      );
      if (!resp.ok) throw new Error(`Font fetch ${resp.status}`);
      cachedFontBytes = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      console.warn('Failed to load Unicode font:', e);
      return null;
    }
  }

  return { fontkit: fontkitModule, fontBytes: cachedFontBytes };
}

function showExportProgress(current, total) {
  exportProgressEl.hidden = false;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  exportProgressFill.style.width = pct + '%';
  exportProgressText.textContent = `${current} / ${total}`;
}

function hideExportProgress() {
  exportProgressEl.hidden = true;
  exportProgressFill.style.width = '0%';
}

async function embedLinkAnnotations(outPdf, outPage, annotations) {
  const { PDFName, PDFString } = pdfLibModule;

  for (const annot of annotations) {
    if (annot.subtype !== 'Link') continue;
    if (!annot.rect || annot.rect.length < 4) continue;

    const url = annot.url || null;
    const dest = annot.dest || null;
    if (!url && !dest) continue;

    const [x1, y1, x2, y2] = annot.rect;

    try {
      const context = outPdf.context;

      const annotDict = context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [x1, y1, x2, y2],
        Border: [0, 0, 0],
        F: 4,
      });

      if (url) {
        // External link: URI action
        const actionDict = context.obj({
          Type: 'Action',
          S: 'URI',
          URI: PDFString.of(url),
        });
        annotDict.set(PDFName.of('A'), context.register(actionDict));
      } else if (dest) {
        // Internal link — resolve to explicit destination.
        let explicitDest = null;

        try {
          if (typeof dest === 'string') {
            explicitDest = await pdfDoc.getDestination(dest);
          } else if (Array.isArray(dest) && dest.length > 0) {
            explicitDest = dest;
          }
        } catch (e) {
          console.warn('[LinkExport] Failed to resolve dest:', dest, e);
          continue;
        }

        if (!explicitDest || !Array.isArray(explicitDest) || explicitDest.length === 0) {
          console.warn('[LinkExport] Empty or invalid explicitDest for:', dest);
          continue;
        }

        try {
          const pageIndex = await pdfDoc.getPageIndex(explicitDest[0]);

          if (pageIndex >= outPdf.getPageCount()) {
            console.warn('[LinkExport] Page index out of range:', pageIndex, '>=', outPdf.getPageCount());
            continue;
          }

          const targetPageRef = outPdf.getPage(pageIndex).ref;

          // Build dest array: [pageRef, /FitType, ...params]
          // Use context.obj() for individual values, assemble manually.
          //
          // PDF.js dest format (confirmed by analysis):
          //   [0] = {num, gen} page ref — already resolved above
          //   [1] = fit type — could be:
          //         - string: "/XYZ" or "XYZ"
          //         - object: {name: "XYZ"}
          //   [2+] = number or null
          const destValues = [targetPageRef];

          for (let d = 1; d < explicitDest.length; d++) {
            const v = explicitDest[d];

            if (v === null || v === undefined) {
              // Null parameter — use context.obj(null) to create
              // a proper PDFNull instance (not the PDFNull class itself)
              destValues.push(context.obj(null));
            } else if (typeof v === 'object' && v.name) {
              // Fit type as object: {name: "XYZ"} — extract the name
              destValues.push(PDFName.of(v.name));
            } else if (typeof v === 'string') {
              // Fit type as string: "/XYZ" or "XYZ"
              const name = v.startsWith('/') ? v.slice(1) : v;
              destValues.push(PDFName.of(name));
            } else if (typeof v === 'number') {
              destValues.push(context.obj(v));
            } else {
              console.warn('[LinkExport] Unknown dest value type:', typeof v, v);
              destValues.push(context.obj(null));
            }
          }

          const destArray = context.obj(destValues);
          annotDict.set(PDFName.of('Dest'), destArray);
        } catch (e) {
          console.warn('[LinkExport] Failed to build dest array:', e);
          continue;
        }
      }

      // Attach annotation to page
      const annotRef = context.register(annotDict);
      const pageDict = outPage.node;
      let annots = pageDict.lookup(PDFName.of('Annots'));

      if (annots instanceof pdfLibModule.PDFArray) {
        annots.push(annotRef);
      } else {
        const newAnnots = context.obj([annotRef]);
        pageDict.set(PDFName.of('Annots'), newAnnots);
      }
    } catch (e) {
      console.warn('[LinkExport] Annotation failed:', e);
    }
  }
}

// Threshold for iOS scanned PDF export warning.
// Based on real testing: iPhone 15 Pro crashed at ~240/334 scanned pages.
// Native PDFs handle 500+ pages fine (no OCR overhead).
const IOS_SCANNED_EXPORT_WARN = 150;

/**
 * Shows the iOS export warning and returns a Promise that resolves
 * to true (proceed) or false (cancel).
 */
function showIosExportWarning(pageCount) {
  return new Promise(resolve => {
    iosWarnText.innerHTML =
      `<strong>This PDF has ${pageCount} scanned pages.</strong><br>` +
      `iOS browsers limit memory for long OCR exports.<br>` +
      `For best results, use a desktop browser.`;
    iosWarnEl.hidden = false;

    // Keep toolbar visible while the warning is showing
    exitFocusMode();
    focusPaused = true;

    function cleanup() {
      iosWarnEl.hidden = true;
      focusPaused = false;
      resetFocusTimer();
      iosWarnTry.removeEventListener('click', onTry);
      iosWarnCancel.removeEventListener('click', onCancel);
    }
    function onTry() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }

    iosWarnTry.addEventListener('click', onTry);
    iosWarnCancel.addEventListener('click', onCancel);
  });
}

async function exportDarkPdf() {
  if (!pdfDoc || exporting) return;

  // Warn iOS users before starting a long scanned export
  if (isIOS && isScannedDocument && pdfDoc.numPages > IOS_SCANNED_EXPORT_WARN) {
    const proceed = await showIosExportWarning(pdfDoc.numPages);
    if (!proceed) return;
  }

  exporting = true;
  const myExportGen = ++exportGeneration;
  btnExport.disabled = true;

  try {
    const { PDFDocument, StandardFonts } = await ensurePdfLib();

    const outPdf = await PDFDocument.create();

    // Try to load a Unicode font (Noto Sans) for full character support.
    // Falls back to Helvetica (WinAnsi, 256 chars) if loading fails.
    let font;
    const fontResources = await ensureUnicodeFont();
    if (fontResources) {
      try {
        outPdf.registerFontkit(fontResources.fontkit);
        font = await outPdf.embedFont(fontResources.fontBytes, { subset: true });
        console.log('[Export] Using Noto Sans (full Unicode support)');
      } catch (e) {
        console.warn('[Export] Failed to embed Unicode font, falling back to Helvetica:', e);
        font = await outPdf.embedFont(StandardFonts.Helvetica);
      }
    } else {
      console.warn('[Export] Unicode font not available, using Helvetica (limited charset)');
      font = await outPdf.embedFont(StandardFonts.Helvetica);
    }

    const totalPages = pdfDoc.numPages;

    // Export at consistent quality regardless of screen size.
    // On a small mobile screen, currentScale can be 0.5 (fitting A4
    // into 390px). Without a floor, the export would be ~79 DPI — blurry.
    //
    // On mobile (touch devices), we cap at scale 2 (144 DPI) to stay
    // within iOS Safari's per-tab memory limit (~1-1.5GB). At scale 3,
    // a 218-page export crashes around page 120 because canvas allocations
    // (~18MB each) outpace the garbage collector.
    //
    // On desktop, scale 3 (216 DPI) gives sharper text. Desktop browsers
    // have much higher memory limits and faster GC.
    const isMobile = window.matchMedia('(pointer: coarse)').matches;
    const minExportScale = isMobile ? 2 : 3;
    const exportScale = Math.max(currentScale * 2, minExportScale);

    showExportProgress(0, totalPages);
    const deferredAnnotations = [];

    // OCR worker for scanned documents only.
    // Native PDFs don't need OCR in the export — their text is already
    // in the content stream. Image OCR lives in the web view only
    // (see shelved/image-ocr-export.js for the removed code).
    let exportWorker = null;
    if (isScannedDocument) {
      try {
        const mod = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js');
        const createWorker = mod.createWorker || (mod.default && mod.default.createWorker);
        exportWorker = await createWorker('eng', 1, { logger: () => {} });
      } catch (err) {
        console.warn('[Export] Failed to create OCR worker:', err);
      }
    }

    // Reusable canvases — created once, recycled every iteration.
    // Avoids GC thrashing on iOS WebKit where canvas backing stores
    // are released lazily. Reassigning width/height clears the canvas
    // and reuses the backing store if dimensions haven't changed.
    const renderCanvas = document.createElement('canvas');
    const finalCanvas = document.createElement('canvas');

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      if (exportGeneration !== myExportGen) break;

      const page = await pdfDoc.getPage(pageNum);
      const origVp = page.getViewport({ scale: 1 });
      const renderVp = page.getViewport({ scale: exportScale });
      const w = Math.floor(renderVp.width);
      const h = Math.floor(renderVp.height);

      // --- Recycle canvases (clears content, reuses backing store) ---
      renderCanvas.width = w;
      renderCanvas.height = h;
      finalCanvas.width = w;
      finalCanvas.height = h;

      // --- Render + get operator list in parallel ---
      const tasks = [
        page.render({
          canvasContext: renderCanvas.getContext('2d'),
          viewport: renderVp,
        }).promise,
        page.getOperatorList(),
        page.getAnnotations(),
      ];
      if (!isScannedDocument) {
        tasks.push(page.getTextContent());
      }

      const results = await Promise.all(tasks);
      if (exportGeneration !== myExportGen) break;

      const opList = results[1];
      const annotations = results[2];
      const textContent = isScannedDocument ? null : results[3];

      // --- Determine dark mode for this page ---
      const isDarkBg = detectAlreadyDark(renderCanvas);
      const override = pageDarkOverride.get(pageNum);
      let applyDark;
      if (override === 'dark') applyDark = true;
      else if (override === 'light') applyDark = false;
      else applyDark = !isDarkBg;

      // --- Compose final image ---
      const ctx = finalCanvas.getContext('2d');

      if (applyDark) {
        // Apply inversion matching CSS filter: invert(0.86) hue-rotate(180deg).
        // Safari iOS doesn't support ctx.filter — fall back to manual pixel manipulation.
        if (supportsCtxFilter) {
          ctx.filter = 'invert(0.86) hue-rotate(180deg)';
          ctx.drawImage(renderCanvas, 0, 0);
          ctx.filter = 'none';
        } else {
          ctx.drawImage(renderCanvas, 0, 0);
          const imgData = ctx.getImageData(0, 0, w, h);
          const d = imgData.data;
          // invert(0.86): newChannel = channel + 0.86 * (255 - 2 * channel)
          // hue-rotate(180deg): swap R↔(255-R) relative to grey, shift hue
          // Combined formula (matching CSS spec):
          //   inverted = ch + 0.86 * (255 - 2*ch)
          //   then rotate hue 180° by negating chroma in RGB
          for (let i = 0; i < d.length; i += 4) {
            // Step 1: invert(0.86)
            let r = d[i]   + 0.86 * (255 - 2 * d[i]);
            let g = d[i+1] + 0.86 * (255 - 2 * d[i+1]);
            let b = d[i+2] + 0.86 * (255 - 2 * d[i+2]);
            // Step 2: hue-rotate(180deg) — negate chroma around the grey axis
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            r = 2 * lum - r;
            g = 2 * lum - g;
            b = 2 * lum - b;
            d[i]   = Math.max(0, Math.min(255, r));
            d[i+1] = Math.max(0, Math.min(255, g));
            d[i+2] = Math.max(0, Math.min(255, b));
          }
          ctx.putImageData(imgData, 0, 0);
        }

        // Restore original images (skip for scanned docs)
        if (!isScannedDocument) {
          const regions = extractImageRegions(opList, renderVp.transform);
          if (regions.length > 0) {
            compositeImageRegions(ctx, renderCanvas, regions, w, h);
          }
        }
      } else {
        ctx.drawImage(renderCanvas, 0, 0);
      }

      // --- Convert to JPEG ---
      const jpegBlob = await new Promise(r =>
        finalCanvas.toBlob(r, 'image/jpeg', 0.85)
      );
      const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());

      // --- Add page to output PDF ---
      const jpegImage = await outPdf.embedJpg(jpegBytes);
      const outPage = outPdf.addPage([origVp.width, origVp.height]);
      outPage.drawImage(jpegImage, {
        x: 0,
        y: 0,
        width: origVp.width,
        height: origVp.height,
      });

      // --- Invisible text layer ---
      //
      // Each text item is drawn at a fontSize adjusted so the
      // string's width matches the original PDF width. This is
      // the PDF-space equivalent of CSS scaleX().
      //
      // With Noto Sans (Unicode), virtually all characters are
      // supported. With Helvetica fallback (WinAnsi), unsupported
      // characters are silently skipped per-item via try/catch.
      if (textContent) {
        // Native PDF: use original text coordinates
        for (const item of textContent.items) {
          if (!item.str || !item.str.trim()) continue;
          const itemText = normalizeLigatures(item.str);
          const tx = item.transform;
          const baseFontSize = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
          if (baseFontSize < 1) continue;

          try {
            // Adjust fontSize so font width matches PDF width
            let drawSize = baseFontSize;
            if (item.width > 0) {
              const naturalWidth = font.widthOfTextAtSize(itemText, baseFontSize);
              if (naturalWidth > 0) {
                drawSize = baseFontSize * (item.width / naturalWidth);
              }
            }

            outPage.drawText(itemText, {
              x: tx[4],
              y: tx[5],
              size: drawSize,
              font,
              opacity: 0,
            });
          } catch (_) {
            // Skip characters not encodable in the current font
          }
        }

      } else if (isScannedDocument && exportWorker) {
        // Scanned PDF: full-page OCR using the shared export worker.
        const processed = preprocessCanvasForOcr(renderCanvas);
        const ocrBlob = await new Promise(r =>
          processed.toBlob(r, 'image/png')
        );
        processed.width = 0;
        const { data } = await exportWorker.recognize(ocrBlob);

        if (data.words) {
          const sx = origVp.width / w;
          const sy = origVp.height / h;

          for (const word of data.words) {
            if (!word.text || !word.text.trim()) continue;
            if (word.confidence < OCR_CONFIDENCE_THRESHOLD) continue;
            if (isOcrArtifact(word.text)) continue;
            const wordText = normalizeLigatures(word.text);
            const baseFontSize = (word.bbox.y1 - word.bbox.y0) * sy * 0.85;
            if (baseFontSize < 1) continue;

            try {
              const targetWidth = (word.bbox.x1 - word.bbox.x0) * sx;
              let drawSize = baseFontSize;
              if (targetWidth > 0) {
                const naturalWidth = font.widthOfTextAtSize(wordText, baseFontSize);
                if (naturalWidth > 0) {
                  drawSize = baseFontSize * (targetWidth / naturalWidth);
                }
              }

              outPage.drawText(wordText, {
                x: word.bbox.x0 * sx,
                y: origVp.height - word.bbox.y1 * sy,
                size: drawSize,
                font,
                opacity: 0,
              });
            } catch (_) {}
          }
        }
      }

      // --- Collect link annotations for deferred embedding ---
      // (Internal links may reference pages not yet added to outPdf,
      // so we embed all annotations after all pages are created.)
      if (annotations.length > 0) {
        deferredAnnotations.push({ outPage, annotations });
      }

      // --- Release page resources ---
      // page.cleanup() tells PDF.js to discard decoded image data,
      // font caches, and other decompressed resources for this page.
      // Without this, PDF.js accumulates hundreds of MB of raw image
      // data across pages — the #1 cause of iOS Safari Jetsam kills.
      page.cleanup();

      // Clear canvas contents (backing store stays allocated for reuse)
      renderCanvas.getContext('2d').clearRect(0, 0, w, h);
      finalCanvas.getContext('2d').clearRect(0, 0, w, h);

      // Only update progress if this export is still the current one
      if (exportGeneration === myExportGen) {
        showExportProgress(pageNum, totalPages);
      }

      // Yield to UI thread. Every 10 pages, give iOS WebKit a real
      // idle pause (50ms) so the garbage collector can run a deep
      // sweep and reclaim canvas backing stores and dead Blobs.
      // On other pages, MessageChannel yield is sufficient.
      if (pageNum % 10 === 0) {
        await new Promise(r => setTimeout(r, 50));
      } else {
        await yieldToUI();
      }
    }

    // --- Release recycled canvases ---
    renderCanvas.width = 0;
    finalCanvas.width = 0;

    // --- Cancelled? Clean up silently and abort ---
    // The UI was already hidden by the cancel button handler (instant
    // perceived cancellation). We just need to release resources.
    if (exportGeneration !== myExportGen) {
      if (exportWorker) exportWorker.terminate().catch(() => {});
      return;
    }

    // --- Terminate the shared export OCR worker ---
    if (exportWorker) {
      await exportWorker.terminate();
    }

    // --- Embed link annotations (all pages now exist) ---
    for (const { outPage, annotations } of deferredAnnotations) {
      await embedLinkAnnotations(outPdf, outPage, annotations);
    }

    // --- Save and trigger download ---
    let pdfBytes = await outPdf.save();
    hideExportProgress();

    const filename = `${originalFileName}-dark.pdf`;
    let blob = new Blob([pdfBytes], { type: 'application/pdf' });

    // Release the raw bytes immediately — the Blob now owns the data.
    // On iOS this frees tens of MB that would otherwise linger in the
    // async function's closure and trigger Jetsam during scrolling.
    pdfBytes = null;

    // iOS Safari ignores the `download` attribute on anchor elements
    // and opens blob URLs inline instead of downloading. The reliable
    // workaround: use the native share sheet via navigator.share().
    // Falls back to the standard anchor technique on other browsers.
    if (navigator.share && isIOS) {
      try {
        const file = new File([blob], filename, { type: 'application/pdf' });
        blob = null; // File now owns the data
        await navigator.share({ files: [file] });
      } catch (e) {
        // User cancelled the share sheet — not an error
        if (e.name !== 'AbortError') console.warn('Share failed:', e);
      }
    } else {
      const url = URL.createObjectURL(blob);
      blob = null; // Blob URL now owns the data
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Delay revoke so the browser has time to start the download
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

  } catch (err) {
    console.error('Export failed:', err);
    hideExportProgress();
    if (exportGeneration === myExportGen) showError('Export failed. Please try again.');
  } finally {
    exporting = false;
    btnExport.disabled = false;
  }
}

// ============================================================
// Event Listeners
// ============================================================

// --- Option/Alt: vertical text OCR + selection in images ---
//
// Pressing Option starts vertical OCR on the current page's images
// immediately — before the user even drags. By the time they position
// the cursor and start selecting, the text is already there.
//
// On mousedown with Alt held, we activate the vertical OCR layer and
// mute the horizontal one. On mouseup, layers are restored.

// Pre-load vertical OCR as soon as Option is pressed
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Alt') return;

  const slot = pageSlots.get(currentVisiblePage);
  const state = pageRenderState.get(currentVisiblePage);
  if (!slot || !state || state.imageRegionsRaw.length === 0) return;
  if (slot.mainCanvas.width === 0) return;

  const vertLayer = slot.verticalOcrLayer;
  if (vertLayer.children.length > 0) return;

  const dpr = getDpr();
  const myGen = globalGeneration;
  for (const region of state.imageRegionsRaw) {
    ocrImageVertical(slot.mainCanvas, vertLayer, region, dpr, myGen);
  }
});

document.addEventListener('mousedown', (e) => {
  if (!e.altKey) return;
  const pageContainer = e.target.closest('.page-container');
  if (!pageContainer) return;

  const vertLayer = pageContainer.querySelector('.vertical-ocr-layer');
  if (!vertLayer) return;

  // Activate vertical layer
  vertLayer.style.pointerEvents = 'auto';
  for (const span of vertLayer.querySelectorAll('span')) {
    span.style.pointerEvents = 'auto';
  }
  // Mute horizontal image regions
  for (const hr of pageContainer.querySelectorAll('.text-layer .ocr-image-region')) {
    hr.style.pointerEvents = 'none';
  }
});

document.addEventListener('mouseup', () => {
  for (const vl of document.querySelectorAll('.vertical-ocr-layer')) {
    vl.style.pointerEvents = '';
    for (const span of vl.querySelectorAll('span')) {
      span.style.pointerEvents = '';
    }
  }
  for (const hr of document.querySelectorAll('.text-layer .ocr-image-region')) {
    hr.style.pointerEvents = '';
  }
});

// --- Drop Zone ---
// Desktop: click anywhere on the drop zone to browse.
// Mobile: only the <label for="file-input"> button triggers the picker
// (native browser behavior, no JS needed — bypasses iOS restrictions).
dropZone.addEventListener('click', (e) => {
  if (window.matchMedia('(pointer: coarse)').matches) return;
  if (e.target.closest('a') || e.target.closest('label')) return;
  fileInput.click();
});

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
btnPrev.addEventListener('click', () => scrollToPage(currentVisiblePage - 1));
btnNext.addEventListener('click', () => scrollToPage(currentVisiblePage + 1));
btnToggle.addEventListener('click', toggleDarkMode);
btnExport.addEventListener('click', exportDarkPdf);
exportCancelBtn.addEventListener('click', () => {
  // Increment generation to invalidate the running export.
  // Any in-flight export will see the generation mismatch and stop.
  exportGeneration++;
  // Instant perceived cancellation: hide progress and re-enable the
  // export button immediately. The actual cleanup (worker termination,
  // canvas release) happens in the background inside exportDarkPdf().
  hideExportProgress();
  exporting = false;
  btnExport.disabled = false;
});
btnFile.addEventListener('click', () => fileInput.click());

// --- Keyboard ---
document.addEventListener('keydown', (e) => {
  if (!pdfDoc) return;
  if (e.key === 'ArrowLeft') scrollToPage(currentVisiblePage - 1);
  else if (e.key === 'ArrowRight') scrollToPage(currentVisiblePage + 1);
  else if (e.key === 'd') toggleDarkMode();
});

// --- Scroll: update current page indicator (throttled) ---
let scrollRAF = 0;
viewport.addEventListener('scroll', () => {
  if (!pdfDoc) return;
  if (scrollRAF) return;
  scrollRAF = requestAnimationFrame(() => {
    scrollRAF = 0;
    reconcileContainers();
    updateCurrentPageFromScroll();
  });
}, { passive: true });

// --- Resize: rebuild all pages at new scale ---
// Only rebuild when the WIDTH changes. Height-only changes happen
// constantly on mobile (Android chrome UI hide/show, iOS address
// bar, virtual keyboard open/close) and don't affect the page
// scale (which is determined by width). Rebuilding on height-only
// changes causes scroll snap, DOM churn, and kills the page input.
let resizeTimer;
let _lastResizeWidth = window.innerWidth;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    if (!pdfDoc) return;
    if (window.innerWidth === _lastResizeWidth) return; // height-only change
    _lastResizeWidth = window.innerWidth;
    const pageToRestore = currentVisiblePage;
    globalGeneration++;
    // Cancel pending render and OCR — scale changed, coordinates are stale
    renderQueue.length = 0;
    ocrCache.clear();
    ocrFingerprints.clear();
    ocrQueue.forEach(j => { j.cancelled = true; });
    ocrQueue.length = 0;
    isScrollingFast = false;
    rendersSinceReset = 0;
    isResetPending = false;
    await buildPageSlots();
    // Restore scroll position to the same page
    scrollToPage(pageToRestore, true);
    reconcileContainers();
    updateCurrentPageFromScroll();

    // Mobile landscape: toolbar is completely hidden — pure reading.
    // Rotating back to portrait restores normal focus mode behavior.
    if (isMobileLandscape()) {
      clearTimeout(focusTimer);
      enterFocusMode();
    } else {
      exitFocusMode();
    }
  }, 200);
});

// --- Allow dropping a new file onto the reader too ---
readerEl.addEventListener('dragover', (e) => e.preventDefault());
readerEl.addEventListener('drop', (e) => {
  e.preventDefault();
  handleFile(e.dataTransfer.files[0]);
});

// Signal that the app module has fully initialized (used by e2e tests)
document.documentElement.dataset.appReady = 'true';
