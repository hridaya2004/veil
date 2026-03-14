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
const errorBanner = document.getElementById('error-banner');
const errorMessage = document.getElementById('error-message');
const errorDismiss = document.getElementById('error-dismiss');

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

    tesseractWorker = await createWorker('eng', 1, {
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
    // Pass canvas directly to Tesseract (avoids lossy blob conversion)
    const { data } = await worker.recognize(canvas);
    if (globalGeneration !== myGen) return;

    // Convert OCR data to the same textContent format that PDF.js
    // produces for native PDFs, then pass it through buildTextLayer
    // (the native builder). This gives OCR text the same perfect
    // selection behavior as native text.
    //
    // The insight: the native builder handles scaleX, BASELINE_RATIO,
    // flow layout, and Antigravity spacing perfectly. Instead of
    // maintaining a separate OCR builder, we convert OCR coordinates
    // to the format the native builder expects.
    const canvasW = canvas.width;
    const canvasH = canvas.height;
    const dpr = canvasW / cssWidth;

    const textContent = convertOcrToTextContent(data, dpr);

    // Create a fake viewport: identity transform, scale = dpr.
    // This makes buildTextLayer treat our canvas-pixel coordinates
    // as if they were native PDF coordinates transformed to canvas space.
    const fakeViewport = {
      transform: [1, 0, 0, 1, 0, 0],
      scale: dpr,
    };

    buildTextLayer(textLayerDiv, textContent, fakeViewport, dpr);

    // Release the canvas now that OCR is done
    canvas.width = 0;
  } catch (err) {
    if (globalGeneration !== myGen) return;
    console.warn('OCR failed for page:', err);
  }
}

/**
 * Converts Tesseract OCR output to the textContent format that
 * PDF.js produces for native PDFs.
 *
 * This allows OCR text to flow through buildTextLayer (the native
 * text layer builder) which handles selection, spacing, scaleX,
 * and BASELINE_RATIO perfectly.
 *
 * The coordinate math:
 *   buildTextLayer does: tx = Util.transform(viewport.transform, item.transform)
 *   With identity viewport: tx = item.transform
 *   Then: fontSize = sqrt(tx[2]² + tx[3]²) / dpr
 *         left = tx[4] / dpr
 *         top = tx[5] / dpr - fontSize * BASELINE_RATIO
 *         pdfWidth = item.width * viewport.scale / dpr = item.width
 *
 *   So we construct item.transform = [0, 0, 0, fontSizeCanvas, x, y]
 *   where y includes BASELINE_RATIO compensation.
 */
function convertOcrToTextContent(ocrData, dpr) {
  const words = ocrData.words || [];
  const ocrLines = ocrData.lines || [];

  // Collect all words (from lines if available, otherwise flat)
  const allWords = ocrLines.length > 0
    ? ocrLines.flatMap(line => line.words || [])
    : words;

  const items = [];
  for (const word of allWords) {
    if (!word.text || !word.text.trim()) continue;
    if (word.confidence < OCR_CONFIDENCE_THRESHOLD) continue;

    const bboxW = word.bbox.x1 - word.bbox.x0;
    const bboxH = word.bbox.y1 - word.bbox.y0;
    if (bboxH < 2 || bboxW < 2) continue;

    // Font size in canvas pixels (0.75 compensates for Tesseract bbox padding)
    const fontSizeCanvas = bboxH * 0.75;

    // Construct the transform matrix [a, b, c, d, e, f]
    // For horizontal text: a=0, b=0, c=0, d=fontSizeCanvas, e=x, f=y
    // fontHeight = sqrt(c² + d²) = fontSizeCanvas
    // The y coordinate compensates for BASELINE_RATIO so that
    // buildTextLayer computes the correct top position.
    const x = word.bbox.x0;
    const y = word.bbox.y0 + fontSizeCanvas * BASELINE_RATIO;

    items.push({
      str: normalizeLigatures(word.text),
      transform: [fontSizeCanvas, 0, 0, fontSizeCanvas, x, y],
      width: bboxW / dpr,  // pdfWidth = item.width * scale / dpr = item.width
      hasEOL: false,
    });
  }

  return { items };
}

// buildOcrTextLayer has been removed.
// OCR text now flows through convertOcrToTextContent() → buildTextLayer(),
// using the same native text layer builder for identical selection behavior.

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

    // Text layer
    const textLayer = document.createElement('div');
    textLayer.className = 'text-layer';
    textLayer.style.width = cssW + 'px';
    textLayer.style.height = cssH + 'px';

    // Page number label
    const pageLabel = document.createElement('div');
    pageLabel.className = 'page-label';
    pageLabel.textContent = i;

    container.appendChild(mainCanvas);
    container.appendChild(overlayCanvas);
    container.appendChild(textLayer);
    container.appendChild(pageLabel);
    fragment.appendChild(container);

    pageSlots.set(i, {
      container,
      mainCanvas,
      overlayCanvas,
      textLayer,
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

        // Clear text layer and link annotations
        slot.textLayer.innerHTML = '';
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
      ocrPage(renderCanvas, slot.textLayer, cssW, cssH, myGen);
      // renderCanvas is kept alive for OCR; it will be GC'd after
    } else {
      buildTextLayer(slot.textLayer, textContent, scaledViewport, dpr);
      renderCanvas.width = 0; // release temp canvas
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

function scrollToPage(pageNum) {
  if (!pdfDoc) return;
  const clamped = Math.max(1, Math.min(pageNum, pdfDoc.numPages));
  const slot = pageSlots.get(clamped);
  if (!slot) return;

  slot.container.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
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
      } else if (isScannedDocument) {
        // Scanned PDF: run OCR for text layer
        const worker = await ensureTesseractWorker();
        if (worker) {
          // Use the original (non-inverted) render for OCR
          const ocrBlob = await new Promise(r =>
            renderCanvas.toBlob(r, 'image/png')
          );
          const { data } = await worker.recognize(ocrBlob);

          if (data.words) {
            const sx = origVp.width / w;
            const sy = origVp.height / h;

            for (const word of data.words) {
              if (!word.text || !word.text.trim()) continue;
              if (word.confidence < OCR_CONFIDENCE_THRESHOLD) continue;
              const wordText = normalizeLigatures(word.text);
              const baseFontSize = (word.bbox.y1 - word.bbox.y0) * sy * 0.85;
              if (baseFontSize < 1) continue;

              try {
                // Adjust fontSize so font width matches OCR bbox width
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
              } catch (_) {
                // Skip characters not encodable in the current font
              }
            }
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
    showError('Export failed. Please try again.');
  } finally {
    exporting = false;
    btnExport.disabled = false;
  }
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
btnPrev.addEventListener('click', () => scrollToPage(currentVisiblePage - 1));
btnNext.addEventListener('click', () => scrollToPage(currentVisiblePage + 1));
btnToggle.addEventListener('click', toggleDarkMode);
btnExport.addEventListener('click', exportDarkPdf);
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
