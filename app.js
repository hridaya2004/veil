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

// How many pages around the visible area to pre-render
const PRERENDER_MARGIN = 2;

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

function preprocessCanvasForOcr(sourceCanvas) {
  const c = document.createElement('canvas');
  c.width = sourceCanvas.width;
  c.height = sourceCanvas.height;
  const ctx = c.getContext('2d');
  ctx.filter = `grayscale(1) contrast(${OCR_CONTRAST})`;
  ctx.drawImage(sourceCanvas, 0, 0);
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

// Each page can be in one of these dark-mode states:
//   'auto'  – use already-dark detection result
//   'dark'  – force dark mode on (user override)
//   'light' – force dark mode off (user override)
// Default is 'auto' for all pages.
const pageDarkOverride = new Map();

// Cache of already-dark detection results per page.
// true = page is already dark, skip inversion.
const pageAlreadyDark = new Map();

// Tracks which page containers exist in the DOM and their render state.
// Map<pageNum, { container, mainCanvas, overlayCanvas, textLayer,
//                rendered: boolean, rendering: boolean, renderGeneration }>
const pageSlots = new Map();

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
let exportCancelled = false;
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
const FOCUS_DELAY = 1500;
const TOOLBAR_TRIGGER_ZONE = 35; // px from top edge
const TOOLBAR_HOVER_DELAY = 300; // ms mouse must stay in zone

function enterFocusMode() {
  if (!readerEl || readerEl.hidden || focusPaused) return;
  toolbar.classList.add('toolbar-hidden');
}

function exitFocusMode() {
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

    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    pageDarkOverride.clear();
    pageAlreadyDark.clear();
    isScannedDocument = false;
    globalGeneration++;

    dropZone.hidden = true;
    readerEl.hidden = false;

    // Detect scanned document before building pages
    isScannedDocument = await detectScannedDocument();

    await buildPageSlots();
    setupIntersectionObserver();
    // Center the first page in the viewport immediately (no animation)
    scrollToPage(1, true);
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

async function ocrImageRegions(mainCanvas, textLayerDiv, verticalLayerDiv, regions, dpr, myGen) {
  // Filter to images large enough to contain readable text
  const candidates = regions.filter(
    r => r.width >= OCR_IMAGE_MIN_SIZE && r.height >= OCR_IMAGE_MIN_SIZE
  );
  if (candidates.length === 0) return;

  const worker = await ensureTesseractWorker();
  if (!worker || globalGeneration !== myGen) return;

  for (const region of candidates) {
    if (globalGeneration !== myGen) return;

    // --- Extract the image region from the main canvas ---
    const sx = Math.max(0, region.x);
    const sy = Math.max(0, region.y);
    const sw = Math.min(region.width, mainCanvas.width - sx);
    const sh = Math.min(region.height, mainCanvas.height - sy);
    if (sw <= 0 || sh <= 0) continue;

    const regionCanvas = document.createElement('canvas');
    regionCanvas.width = sw;
    regionCanvas.height = sh;
    regionCanvas.getContext('2d').drawImage(
      mainCanvas, sx, sy, sw, sh, 0, 0, sw, sh
    );

    // CSS position of this region
    const regionCssX = sx / dpr;
    const regionCssY = sy / dpr;
    const regionCssW = sw / dpr;
    const regionCssH = sh / dpr;

    // ==========================================================
    // Pass 1: Horizontal text (0° — normal orientation)
    // Catches: chart titles, X-axis labels, legend text, data labels
    // ==========================================================
    const processed0 = preprocessCanvasForOcr(regionCanvas);
    try {
      const { data } = await worker.recognize(processed0);
      processed0.width = 0;
      if (globalGeneration !== myGen) { regionCanvas.width = 0; return; }

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
    } catch (err) {
      processed0.width = 0;
      if (globalGeneration !== myGen) { regionCanvas.width = 0; return; }
    }

    if (globalGeneration !== myGen) { regionCanvas.width = 0; return; }

    // ==========================================================
    // Pass 2: Vertical text (90° CW rotation)
    // Catches: Y-axis labels, rotated annotations, vertical headers
    //
    // The image is rotated 90° CW before OCR. Tesseract sees the
    // vertical text as horizontal and recognizes it normally.
    //
    // The result container is positioned over the image region with
    // transform: rotate(-90deg) so the text appears vertical on
    // screen. transform-origin is set so the container stays
    // aligned with the image region.
    //
    // Coordinate mapping:
    //   Rotated canvas: W=sh, H=sw (dimensions swapped)
    //   CSS container:  same dimensions as original region, but
    //                   rotated -90° around its center. The inner
    //                   text is laid out in the rotated space (W=sh,
    //                   H=sw) and the CSS rotation brings it back
    //                   to vertical alignment.
    // ==========================================================
    const rotated = rotateCanvas90CW(regionCanvas);
    regionCanvas.width = 0; // release original

    const processed90 = preprocessCanvasForOcr(rotated);
    rotated.width = 0;

    try {
      const { data } = await worker.recognize(processed90);
      processed90.width = 0;
      if (globalGeneration !== myGen) return;

      if (hasValidOcrWords(data)) {
        // The rotated canvas has dimensions sh×sw (swapped).
        // The CSS container for the rotated text uses the rotated
        // dimensions, then CSS rotate(-90deg) brings it back to
        // the original orientation.
        const rotCssW = regionCssH; // rotated: height becomes width
        const rotCssH = regionCssW; // rotated: width becomes height

        const div90 = document.createElement('div');
        div90.className = 'ocr-image-region ocr-image-region-rotated';
        div90.style.position = 'absolute';

        // Position at the center of the image region, then rotate.
        // After rotation, the container covers the same area.
        const centerX = regionCssX + regionCssW / 2;
        const centerY = regionCssY + regionCssH / 2;
        div90.style.left = (centerX - rotCssW / 2) + 'px';
        div90.style.top = (centerY - rotCssH / 2) + 'px';
        div90.style.width = rotCssW + 'px';
        div90.style.height = rotCssH + 'px';
        div90.style.overflow = 'hidden';
        div90.style.transform = 'rotate(-90deg)';
        div90.style.transformOrigin = 'center center';

        buildOcrTextLayerDirect(
          div90, data,
          sh, sw,       // rotated canvas: W=sh, H=sw
          rotCssW, rotCssH
        );

        if (div90.querySelector('span:not([data-gap])')) {
          verticalLayerDiv.appendChild(div90);
        }
      }
    } catch (err) {
      processed90.width = 0;
      if (globalGeneration !== myGen) return;
    }
  }
}

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
  // Remove all page containers from viewport
  viewport.innerHTML = '';
  pageSlots.clear();
  if (scrollObserver) {
    scrollObserver.disconnect();
    scrollObserver = null;
  }
  if (evictionObserver) {
    evictionObserver.disconnect();
    evictionObserver = null;
  }
}

// ============================================================
// Scale Calculation
// ============================================================

function calculateScale(page) {
  const vp = page.getViewport({ scale: 1 });
  return _calculateScale(vp.width, vp.height, window.innerWidth, window.innerHeight);
}

// ============================================================
// Continuous Scroll: Build Page Slots
//
// Creates a container for each page with placeholder dimensions.
// The actual rendering happens lazily via IntersectionObserver.
// ============================================================

async function buildPageSlots() {
  if (!pdfDoc) return;

  viewport.innerHTML = '';
  pageSlots.clear();

  // We need the first page to determine scale
  const firstPage = await pdfDoc.getPage(1);
  const scale = calculateScale(firstPage);
  currentScale = scale;
  const dpr = window.devicePixelRatio || 1;

  // Batch DOM insertion with DocumentFragment
  const fragment = document.createDocumentFragment();

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const scaledViewport = page.getViewport({ scale: scale * dpr });

    const cssW = Math.floor(scaledViewport.width / dpr);
    const cssH = Math.floor(scaledViewport.height / dpr);

    // Container
    const container = document.createElement('div');
    container.className = 'page-container';
    container.style.width = cssW + 'px';
    container.style.height = cssH + 'px';
    container.dataset.pageNum = i;

    // Main canvas
    const mainCanvas = document.createElement('canvas');
    mainCanvas.className = 'page-canvas';
    mainCanvas.style.width = cssW + 'px';
    mainCanvas.style.height = cssH + 'px';

    // Overlay canvas
    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.className = 'page-overlay';
    overlayCanvas.style.width = cssW + 'px';
    overlayCanvas.style.height = cssH + 'px';

    // Text layer (horizontal text: native + OCR horizontal)
    const textLayer = document.createElement('div');
    textLayer.className = 'text-layer';
    textLayer.style.width = cssW + 'px';
    textLayer.style.height = cssH + 'px';

    // Vertical OCR layer (separate from text-layer to prevent
    // selection interference between horizontal and vertical text).
    // Same position/size as text-layer but independent DOM tree.
    const verticalOcrLayer = document.createElement('div');
    verticalOcrLayer.className = 'text-layer vertical-ocr-layer';
    verticalOcrLayer.style.width = cssW + 'px';
    verticalOcrLayer.style.height = cssH + 'px';

    // Page number label
    const pageLabel = document.createElement('div');
    pageLabel.className = 'page-label';
    pageLabel.textContent = i;

    container.appendChild(mainCanvas);
    container.appendChild(overlayCanvas);
    container.appendChild(textLayer);
    container.appendChild(verticalOcrLayer);
    container.appendChild(pageLabel);
    fragment.appendChild(container);

    pageSlots.set(i, {
      container,
      mainCanvas,
      overlayCanvas,
      textLayer,
      verticalOcrLayer,
      rendered: false,
      rendering: false,
      renderGeneration: 0,
    });
  }

  viewport.appendChild(fragment);
}

// ============================================================
// IntersectionObserver: Lazy Rendering
//
// Observes each page container. When a page enters (or is near)
// the viewport, we render it. Pages far from view are unloaded
// to save memory.
// ============================================================

let scrollObserver = null;
let evictionObserver = null;

// How far from the viewport (in %) a page must be before its
// canvas memory is released. Must be larger than the render
// margin (200%) so pages are re-rendered before becoming visible.
const EVICTION_MARGIN = '600%';

function setupIntersectionObserver() {
  if (scrollObserver) scrollObserver.disconnect();
  if (evictionObserver) evictionObserver.disconnect();

  // --- Render observer: triggers rendering for nearby pages ---
  scrollObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const pageNum = parseInt(entry.target.dataset.pageNum, 10);
        const slot = pageSlots.get(pageNum);
        if (!slot) continue;

        if (entry.isIntersecting) {
          renderPageIfNeeded(pageNum);
          // Pre-render adjacent pages
          for (let offset = 1; offset <= PRERENDER_MARGIN; offset++) {
            renderPageIfNeeded(pageNum + offset);
            renderPageIfNeeded(pageNum - offset);
          }
        }
      }
      // Update current page indicator based on scroll
      updateCurrentPageFromScroll();
    },
    {
      root: viewport,
      rootMargin: '200% 0px', // Start rendering well before visible
      threshold: 0,
    }
  );

  // --- Eviction observer: releases memory for distant pages ---
  // Uses a wider margin than the render observer, so pages get
  // re-rendered (by the render observer) before they become visible.
  // When a page leaves this wide margin, its canvases are zeroed
  // and its text layer is cleared — freeing GPU and DOM memory.
  evictionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) continue; // still nearby, keep it

        const pageNum = parseInt(entry.target.dataset.pageNum, 10);
        const slot = pageSlots.get(pageNum);
        if (!slot || !slot.rendered) continue;

        // Release canvas memory
        slot.mainCanvas.width = 0;
        slot.mainCanvas.height = 0;
        slot.overlayCanvas.width = 0;
        slot.overlayCanvas.height = 0;
        slot.overlayCanvas.classList.remove('overlay-visible');

        // Clear text layers and link annotations
        slot.textLayer.innerHTML = '';
        slot.verticalOcrLayer.innerHTML = '';
        slot.container.querySelectorAll('.link-annot').forEach(el => el.remove());

        // Mark as unrendered so the render observer will redo it
        slot.rendered = false;
        slot.rendering = false;
      }
    },
    {
      root: viewport,
      rootMargin: EVICTION_MARGIN + ' 0px',
      threshold: 0,
    }
  );

  for (const [, slot] of pageSlots) {
    scrollObserver.observe(slot.container);
    evictionObserver.observe(slot.container);
  }
}

// ============================================================
// Page Rendering
// ============================================================

function createOffscreenCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

async function renderPageIfNeeded(pageNum) {
  if (!pdfDoc || pageNum < 1 || pageNum > pdfDoc.numPages) return;

  const slot = pageSlots.get(pageNum);
  if (!slot || slot.rendered || slot.rendering) return;

  slot.rendering = true;
  const myGen = globalGeneration;
  slot.renderGeneration = myGen;

  try {
    const page = await pdfDoc.getPage(pageNum);
    if (globalGeneration !== myGen) return;

    const dpr = window.devicePixelRatio || 1;
    const scaledViewport = page.getViewport({ scale: currentScale * dpr });
    const w = Math.floor(scaledViewport.width);
    const h = Math.floor(scaledViewport.height);

    // Render + get operator list (+ text content for native PDFs)
    const renderCanvas = createOffscreenCanvas(w, h);
    const parallelTasks = [
      page.render({
        canvasContext: renderCanvas.getContext('2d'),
        viewport: scaledViewport,
      }).promise,
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

    // --- Paint main canvas ---
    slot.mainCanvas.width = w;
    slot.mainCanvas.height = h;
    const mainCtx = slot.mainCanvas.getContext('2d');
    mainCtx.drawImage(renderCanvas, 0, 0);

    // --- Paint overlay canvas ---
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

      const effectiveScale = currentScale * dpr;
      if (effectiveScale >= OCR_MIN_SCALE) {
        // Display canvas already has enough resolution for Tesseract
        ocrPage(renderCanvas, slot.textLayer, cssW, cssH, myGen);
      } else {
        // Display canvas is too low-res for good OCR (< 216 DPI).
        // Render a separate higher-resolution canvas for Tesseract.
        // The display canvas data has already been copied to mainCanvas
        // and overlayCanvas above, so we can release it immediately.
        renderCanvas.width = 0;

        const ocrViewport = page.getViewport({ scale: OCR_MIN_SCALE });
        const ocrCanvas = createOffscreenCanvas(
          Math.floor(ocrViewport.width),
          Math.floor(ocrViewport.height)
        );
        page.render({
          canvasContext: ocrCanvas.getContext('2d'),
          viewport: ocrViewport,
        }).promise.then(() => {
          if (globalGeneration === myGen) {
            ocrPage(ocrCanvas, slot.textLayer, cssW, cssH, myGen);
          } else {
            ocrCanvas.width = 0;
          }
        });
      }
    } else {
      buildTextLayer(slot.textLayer, textContent, scaledViewport, dpr);
      renderCanvas.width = 0; // release temp canvas

      // OCR on images within native PDFs (fire-and-forget background).
      // The native text is already selectable; this makes text INSIDE
      // images (chart labels, table photos, code screenshots) selectable
      // too. Uses slot.mainCanvas which persists until page eviction.
      if (regions.length > 0) {
        ocrImageRegions(
          slot.mainCanvas, slot.textLayer, slot.verticalOcrLayer,
          regions, dpr, myGen
        );
      }
    }

    // --- Link annotations ---
    try {
      const annotations = await page.getAnnotations();
      if (globalGeneration === myGen) {
        buildLinkLayer(slot.container, annotations, scaledViewport, dpr, pageNum);
      }
    } catch (_) { /* some pages have no annotations */ }

    slot.rendered = true;
    applyDarkModeToPage(pageNum);
  } catch (err) {
    if (globalGeneration !== myGen) return;
    console.error(`Render page ${pageNum} failed:`, err);
  } finally {
    slot.rendering = false;
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
  if (!slot || !slot.rendered) return;

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
  if (!pdfDoc) return;

  const viewportRect = viewport.getBoundingClientRect();
  const viewportCenter = viewportRect.top + viewportRect.height / 2;
  let closestPage = 1;
  let closestDist = Infinity;

  for (const [pageNum, slot] of pageSlots) {
    const rect = slot.container.getBoundingClientRect();
    const pageCenter = rect.top + rect.height / 2;
    const dist = Math.abs(pageCenter - viewportCenter);
    if (dist < closestDist) {
      closestDist = dist;
      closestPage = pageNum;
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

// Click-to-edit page number: transforms the label into an input
pageInfo.addEventListener('click', () => {
  if (!pdfDoc) return;

  const current = currentVisiblePage;
  const total = pdfDoc.numPages;

  // Create inline input
  const input = document.createElement('input');
  input.id = 'page-input';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.value = current;
  input.setAttribute('aria-label', `Go to page (1-${total})`);

  // Pause focus mode while editing — toolbar stays visible
  focusPaused = true;
  clearTimeout(focusTimer);
  focusTimer = null;

  // Replace the label with the input
  pageInfo.style.display = 'none';
  pageInfo.parentNode.insertBefore(input, pageInfo);
  input.select();

  function commit() {
    const val = parseInt(input.value, 10);
    if (!isNaN(val) && val >= 1 && val <= total) {
      scrollToPage(val);
    }
    restore();
  }

  function restore() {
    input.remove();
    pageInfo.style.display = '';
    // Resume focus mode
    focusPaused = false;
    resetFocusTimer();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); restore(); }
  });

  input.addEventListener('blur', restore);
});

function scrollToPage(pageNum, instant = false) {
  if (!pdfDoc) return;
  const clamped = Math.max(1, Math.min(pageNum, pdfDoc.numPages));
  const slot = pageSlots.get(clamped);
  if (!slot) return;

  slot.container.scrollIntoView({
    behavior: instant ? 'instant' : 'smooth',
    block: 'center',
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

async function exportDarkPdf() {
  if (!pdfDoc || exporting) return;

  exporting = true;
  exportCancelled = false;
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
    const exportDpr = 2;

    showExportProgress(0, totalPages);
    const deferredAnnotations = [];

    // Create a shared eng-only OCR worker for the entire export.
    // Used for both scanned documents AND image OCR in native PDFs.
    // Created once, terminated after the loop — no per-page overhead.
    let exportWorker = null;
    const needsOcr = isScannedDocument || true; // always create — native PDFs may have images
    if (needsOcr) {
      try {
        const mod = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js');
        const createWorker = mod.createWorker || (mod.default && mod.default.createWorker);
        exportWorker = await createWorker('eng', 1, { logger: () => {} });
      } catch (err) {
        console.warn('[Export] Failed to create OCR worker:', err);
      }
    }

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      if (exportCancelled) break;

      const page = await pdfDoc.getPage(pageNum);
      const origVp = page.getViewport({ scale: 1 });
      const renderVp = page.getViewport({ scale: currentScale * exportDpr });
      const w = Math.floor(renderVp.width);
      const h = Math.floor(renderVp.height);

      // --- Render + get operator list in parallel ---
      const renderCanvas = createOffscreenCanvas(w, h);
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
      if (exportCancelled) { renderCanvas.width = 0; break; }

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
      const finalCanvas = createOffscreenCanvas(w, h);
      const ctx = finalCanvas.getContext('2d');

      if (applyDark) {
        // Apply the same inversion as the CSS filter
        ctx.filter = 'invert(0.86) hue-rotate(180deg)';
        ctx.drawImage(renderCanvas, 0, 0);
        ctx.filter = 'none';

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

        // --- OCR on images within this native page ---
        // Makes text inside charts, figures, and screenshots selectable
        // in the exported PDF. Same dual-pass approach as the web view
        // (0° horizontal + 90° vertical) for maximum coverage.
        if (exportWorker) {
          const regions = extractImageRegions(opList, renderVp.transform);
          const imgCandidates = regions.filter(
            r => r.width >= OCR_IMAGE_MIN_SIZE && r.height >= OCR_IMAGE_MIN_SIZE
          );

          if (imgCandidates.length > 0) {
            await new Promise(r => setTimeout(r, 0));
          }

          for (const region of imgCandidates) {
            if (exportCancelled) break;
            const sx2 = Math.max(0, region.x);
            const sy2 = Math.max(0, region.y);
            const sw2 = Math.min(region.width, w - sx2);
            const sh2 = Math.min(region.height, h - sy2);
            if (sw2 <= 0 || sh2 <= 0) continue;

            // Scale factors: render canvas pixels → PDF points
            const imgSx = origVp.width / w;
            const imgSy = origVp.height / h;

            // Extract region from the original (non-inverted) render
            const regionCanvas = document.createElement('canvas');
            regionCanvas.width = sw2;
            regionCanvas.height = sh2;
            regionCanvas.getContext('2d').drawImage(
              renderCanvas, sx2, sy2, sw2, sh2, 0, 0, sw2, sh2
            );

            // --- Pass 1: Horizontal text ---
            const proc0 = preprocessCanvasForOcr(regionCanvas);
            try {
              const blob0 = await new Promise(r => proc0.toBlob(r, 'image/png'));
              proc0.width = 0;
              const { data: data0 } = await exportWorker.recognize(blob0);

              if (data0.words) {
                for (const word of data0.words) {
                  if (!word.text || !word.text.trim()) continue;
                  if (word.confidence < OCR_CONFIDENCE_THRESHOLD) continue;
                  if (isOcrArtifact(word.text)) continue;
                  const wordText = normalizeLigatures(word.text);
                  const fontSize = (word.bbox.y1 - word.bbox.y0) * imgSy * 0.85;
                  if (fontSize < 1) continue;

                  try {
                    const targetW = (word.bbox.x1 - word.bbox.x0) * imgSx;
                    let drawSize = fontSize;
                    if (targetW > 0) {
                      const natW = font.widthOfTextAtSize(wordText, fontSize);
                      if (natW > 0) drawSize = fontSize * (targetW / natW);
                    }
                    outPage.drawText(wordText, {
                      x: (sx2 + word.bbox.x0) * imgSx,
                      y: origVp.height - (sy2 + word.bbox.y1) * imgSy,
                      size: drawSize,
                      font,
                      opacity: 0,
                    });
                  } catch (_) {}
                }
              }
            } catch (_) { proc0.width = 0; }

            // --- Pass 2: Vertical text (90° CW rotation) ---
            const rotated = rotateCanvas90CW(regionCanvas);
            regionCanvas.width = 0;
            const proc90 = preprocessCanvasForOcr(rotated);
            rotated.width = 0;

            try {
              const blob90 = await new Promise(r => proc90.toBlob(r, 'image/png'));
              proc90.width = 0;
              const { data: data90 } = await exportWorker.recognize(blob90);

              if (data90.words) {
                // Rotated canvas: W=sh2, H=sw2. Map back to original coordinates.
                // In the 90° CW rotated image, a word at (rx, ry) maps to
                // original coordinates: (ry, sh2 - rx - wordHeight)
                for (const word of data90.words) {
                  if (!word.text || !word.text.trim()) continue;
                  if (word.confidence < OCR_CONFIDENCE_THRESHOLD) continue;
                  if (isOcrArtifact(word.text)) continue;
                  const wordText = normalizeLigatures(word.text);
                  const wordH = word.bbox.y1 - word.bbox.y0;
                  const wordW = word.bbox.x1 - word.bbox.x0;
                  const fontSize = wordH * imgSx * 0.85; // rotated: height maps to X
                  if (fontSize < 1) continue;

                  // Transform rotated coords back to original region coords
                  const origX = word.bbox.y0; // ry → origX
                  const origY = sh2 - word.bbox.x1; // sh2 - rx1 → origY

                  try {
                    const targetW = wordW * imgSy; // rotated width maps to Y in original
                    let drawSize = fontSize;
                    if (targetW > 0) {
                      const natW = font.widthOfTextAtSize(wordText, fontSize);
                      if (natW > 0) drawSize = fontSize * (targetW / natW);
                    }
                    outPage.drawText(wordText, {
                      x: (sx2 + origX) * imgSx,
                      y: origVp.height - (sy2 + origY + wordH) * imgSy,
                      size: drawSize,
                      font,
                      opacity: 0,
                    });
                  } catch (_) {}
                }
              }
            } catch (_) { proc90.width = 0; }
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

      // --- Release memory ---
      renderCanvas.width = 0;
      finalCanvas.width = 0;

      showExportProgress(pageNum, totalPages);

      // Yield to UI thread for progress bar update
      await new Promise(r => setTimeout(r, 0));
    }

    // --- Cancelled? Clean up and abort ---
    if (exportCancelled) {
      if (exportWorker) await exportWorker.terminate();
      hideExportProgress();
      exporting = false;
      btnExport.disabled = false;
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
    const pdfBytes = await outPdf.save();
    hideExportProgress();

    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${originalFileName}-dark.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

  } catch (err) {
    console.error('Export failed:', err);
    hideExportProgress();
    if (!exportCancelled) showError('Export failed. Please try again.');
  } finally {
    exporting = false;
    btnExport.disabled = false;
  }
}

// ============================================================
// Event Listeners
// ============================================================

// --- Option/Alt + Drag: vertical text selection in images ---
// Default drag = horizontal text selection (chart titles, x-axis, data labels).
// Option/Alt + drag = vertical text selection (y-axis labels, rotated annotations).
//
// On mousedown, if Alt is held, we activate the vertical OCR layer and
// mute the horizontal one. This happens BEFORE the browser starts the
// selection, so there's no mid-selection glitch.
// On mouseup, layers are restored to default state.
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
btnPrev.addEventListener('click', () => scrollToPage(currentVisiblePage - 1));
btnNext.addEventListener('click', () => scrollToPage(currentVisiblePage + 1));
btnToggle.addEventListener('click', toggleDarkMode);
btnExport.addEventListener('click', exportDarkPdf);
exportCancelBtn.addEventListener('click', () => { exportCancelled = true; });
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
    updateCurrentPageFromScroll();
  });
}, { passive: true });

// --- Resize: rebuild all pages at new scale ---
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    if (!pdfDoc) return;
    const pageToRestore = currentVisiblePage;
    globalGeneration++;
    await buildPageSlots();
    setupIntersectionObserver();
    // Restore scroll position to the same page
    const slot = pageSlots.get(pageToRestore);
    if (slot) {
      slot.container.scrollIntoView({ block: 'start' });
    }
    updateCurrentPageFromScroll();
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
