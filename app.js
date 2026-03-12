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

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.worker.min.mjs';

// ============================================================
// Constants
// ============================================================

const OPS = pdfjsLib.OPS;
const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];

// How many pages around the visible area to pre-render
const PRERENDER_MARGIN = 2;

// Luminance threshold: pages with average background luminance
// below this are considered "already dark" and won't be inverted.
const DARK_LUMINANCE_THRESHOLD = 0.4;

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
    alert('Could not load this PDF. It may be corrupted or password-protected.');
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

const SCAN_IMAGE_COVERAGE_THRESHOLD = 0.85;
const SCAN_TEXT_CHAR_THRESHOLD = 50;

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

  // Need at least 2 samples for confidence (or all pages if <2)
  const samplesToCheck = [...sampleIndices];

  for (const pageNum of samplesToCheck) {
    const page = await pdfDoc.getPage(pageNum);
    const vp = page.getViewport({ scale: 1 });
    const pageArea = vp.width * vp.height;

    const [opList, textContent] = await Promise.all([
      page.getOperatorList(),
      page.getTextContent(),
    ]);

    // Count text characters
    let charCount = 0;
    for (const item of textContent.items) {
      if (item.str) charCount += item.str.length;
    }

    // If this page has substantial text, it's not a scanned document
    if (charCount >= SCAN_TEXT_CHAR_THRESHOLD) return false;

    // Check image coverage at scale 1 (PDF user space)
    const regions = extractImageRegions(opList, vp.transform);

    // Find the largest image's coverage ratio
    let maxCoverage = 0;
    for (const r of regions) {
      const coverage = (r.width * r.height) / pageArea;
      if (coverage > maxCoverage) maxCoverage = coverage;
    }

    // If this page doesn't have a dominant full-page image, not scanned
    if (maxCoverage < SCAN_IMAGE_COVERAGE_THRESHOLD) return false;
  }

  // ALL sampled pages matched the scanned pattern
  console.log(`Scanned document detected (${samplesToCheck.length} pages sampled)`);
  return true;
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
    // Convert canvas to blob for Tesseract (more reliable than passing canvas directly)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (globalGeneration !== myGen) return;

    const { data } = await worker.recognize(blob);
    if (globalGeneration !== myGen) return;

    buildOcrTextLayer(textLayerDiv, data.words, canvas.width, canvas.height, cssWidth, cssHeight);

    // Release the canvas now that OCR is done
    canvas.width = 0;
  } catch (err) {
    if (globalGeneration !== myGen) return;
    console.warn('OCR failed for page:', err);
  }
}

function buildOcrTextLayer(container, words, canvasW, canvasH, cssW, cssH) {
  container.innerHTML = '';
  if (!words || words.length === 0) return;

  const scaleX = cssW / canvasW;
  const scaleY = cssH / canvasH;
  const measureCtx = document.createElement('canvas').getContext('2d');

  // --- Step 1: Transform OCR words to CSS coordinates ---
  const items = words
    .filter(w => w.text && w.text.trim())
    .map(w => ({
      str: w.text,
      left: w.bbox.x0 * scaleX,
      top: w.bbox.y0 * scaleY,
      width: (w.bbox.x1 - w.bbox.x0) * scaleX,
      height: (w.bbox.y1 - w.bbox.y0) * scaleY,
    }));

  if (items.length === 0) return;

  // --- Step 2: Sort and group into lines ---
  items.sort((a, b) => a.top - b.top || a.left - b.left);

  const lines = [];
  let currentLine = [items[0]];
  let lineTop = items[0].top;
  let lineHeight = items[0].height;

  for (let i = 1; i < items.length; i++) {
    const item = items[i];
    const threshold = lineHeight * 0.5;

    if (Math.abs(item.top - lineTop) < threshold) {
      currentLine.push(item);
      if (item.height > lineHeight) lineHeight = item.height;
    } else {
      lines.push(currentLine);
      currentLine = [item];
      lineTop = item.top;
      lineHeight = item.height;
    }
  }
  lines.push(currentLine);

  // --- Step 3: Build DOM with continuous flow ---
  //
  // Same strategy as native buildTextLayer: each line is a
  // block-level <div class="text-line"> in normal document flow.
  // Vertical positioning uses padding-top for the gap between lines.
  //
  // Each non-last span extends its width to the next word's start
  // via scaleX(), so selection highlight is continuous with no gaps.
  //
  // Between spans, a TextNode(' ') ensures copy/paste produces
  // "word1 word2" with proper spacing. The TextNode takes up layout
  // space, which we compensate by reducing the next span's width
  // by the space advance. width:fit-content prevents the selection
  // from extending past the last word.
  const fragment = document.createDocumentFragment();

  // Measure inherited space width for TextNode compensation
  const inheritedFontSize = parseFloat(getComputedStyle(container).fontSize) || 16;
  measureCtx.font = `${inheritedFontSize}px sans-serif`;
  const spaceAdvance = measureCtx.measureText(' ').width;

  let prevBottom = 0;

  for (const line of lines) {
    line.sort((a, b) => a.left - b.left);

    const lineDiv = document.createElement('div');
    lineDiv.className = 'text-line';
    lineDiv.style.width = 'fit-content';

    const lt = line[0].top;
    const lh = Math.max(...line.map(it => it.height));
    const fontSize = lh * 0.85;

    const vGap = Math.max(0, lt - prevBottom);
    lineDiv.style.paddingTop = vGap + 'px';
    lineDiv.style.height = (lh + vGap) + 'px';

    prevBottom = lt + lh;

    for (let i = 0; i < line.length; i++) {
      const item = line[i];
      const isLast = i === line.length - 1;
      const nextItem = isLast ? null : line[i + 1];

      // Insert a real TextNode(' ') between words for copy/paste
      if (i > 0) {
        lineDiv.appendChild(document.createTextNode(' '));
      }

      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.fontSize = fontSize + 'px';

      // First span: indent from left edge via marginLeft
      if (i === 0 && item.left > 0.5) {
        span.style.marginLeft = item.left + 'px';
      }

      // Target width: for non-last words, extend to the start
      // of the next word, minus the TextNode space advance.
      // For the last word, use its own bbox width.
      const targetWidth = isLast
        ? item.width
        : nextItem.left - item.left - spaceAdvance;

      if (targetWidth > 0) {
        measureCtx.font = `${fontSize}px sans-serif`;
        const naturalWidth = measureCtx.measureText(item.str).width;

        if (naturalWidth > 0) {
          span.style.display = 'inline-block';
          span.style.width = targetWidth + 'px';
          span.style.transform = `scaleX(${targetWidth / naturalWidth})`;
          span.style.transformOrigin = 'left top';
        }
      }

      lineDiv.appendChild(span);
    }

    fragment.appendChild(lineDiv);
  }

  container.appendChild(fragment);
}

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
}

// ============================================================
// Scale Calculation
// ============================================================

function calculateScale(page) {
  const vp = page.getViewport({ scale: 1 });
  const padding = 48;
  const toolbarH = 48;
  const availW = window.innerWidth - padding;
  const availH = window.innerHeight - toolbarH - padding;
  return Math.min(availW / vp.width, availH / vp.height, 3);
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

function setupIntersectionObserver() {
  if (scrollObserver) scrollObserver.disconnect();

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

  for (const [, slot] of pageSlots) {
    scrollObserver.observe(slot.container);
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

  // Read all pixel data once (avoids repeated GPU readbacks)
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, w, h);
  const data = imageData.data;

  // Sample points biased toward edges/corners where background is visible
  const samplePoints = [];
  const margin = Math.max(5, Math.floor(Math.min(w, h) * 0.02));
  const step = Math.max(1, Math.floor(Math.min(w, h) * 0.05));

  // Corners
  samplePoints.push(
    [margin, margin], [w - margin, margin],
    [margin, h - margin], [w - margin, h - margin],
  );

  // Edges
  for (let x = margin; x < w - margin; x += step) {
    samplePoints.push([x, margin], [x, h - margin]);
  }
  for (let y = margin; y < h - margin; y += step) {
    samplePoints.push([margin, y], [w - margin, y]);
  }

  let totalLuminance = 0;
  let count = 0;

  for (const [sx, sy] of samplePoints) {
    const idx = (sy * w + sx) * 4;
    const luminance = (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]) / 255;
    totalLuminance += luminance;
    count++;
  }

  const avgLuminance = count > 0 ? totalLuminance / count : 1;
  return avgLuminance < DARK_LUMINANCE_THRESHOLD;
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
      str: item.str || '',
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

  // --- Step 2: Group into lines by Y coordinate ---
  items.sort((a, b) => a.top - b.top || a.left - b.left);

  const lines = [];
  let currentLine = [items[0]];
  let lineTop = items[0].top;
  let lineHeight = items[0].height;

  for (let i = 1; i < items.length; i++) {
    const item = items[i];
    const threshold = lineHeight * 0.5;

    if (Math.abs(item.top - lineTop) < threshold) {
      currentLine.push(item);
      if (item.height > lineHeight) lineHeight = item.height;
    } else {
      lines.push(currentLine);
      currentLine = [item];
      lineTop = item.top;
      lineHeight = item.height;
    }
  }
  lines.push(currentLine);

  // --- Step 3: Build DOM with continuous flow ---
  //
  // Two problems at style boundaries (italic↔normal, bold, links):
  //
  // Scenario A — "pdfWidth eats the space": the previous item's
  // pdfWidth includes the trailing space advance, so gap ≈ 0 and
  // no TextNode is inserted. But the space IS in item.str (e.g.
  // "I "). With white-space:pre on the span, the browser preserves
  // that trailing space during copy/paste instead of collapsing it.
  //
  // Scenario B — neither item contains the space: gap > 0 but
  // neither str ends/starts with a space. We insert a TextNode(' ')
  // and compensate marginLeft by its layout width.
  const fragment = document.createDocumentFragment();

  // Measure inherited space width for TextNode compensation
  const inheritedFontSize = parseFloat(getComputedStyle(container).fontSize) || 16;
  measureCtx.font = `${inheritedFontSize}px sans-serif`;
  const spaceAdvance = measureCtx.measureText(' ').width;

  let prevBottom = 0;

  for (const line of lines) {
    line.sort((a, b) => a.left - b.left);

    const lineDiv = document.createElement('div');
    lineDiv.className = 'text-line';

    const lineTop = line[0].top;
    const lineHeight = Math.max(...line.map(it => it.height));

    const vGap = Math.max(0, lineTop - prevBottom);
    lineDiv.style.paddingTop = vGap + 'px';
    lineDiv.style.height = (lineHeight + vGap) + 'px';

    prevBottom = lineTop + lineHeight;

    let cursor = 0;
    let prevStr = '';

    for (let i = 0; i < line.length; i++) {
      const item = line[i];
      if (!item.str) continue;

      const gap = item.left - cursor;
      let adjustedGap = gap;

      // Determine if a word boundary exists between prevStr and
      // this item. Three cases:
      //   1. prevStr ends with whitespace → space already in DOM
      //      (white-space:pre preserves it). No TextNode needed.
      //   2. item.str starts with whitespace → same, preserved.
      //   3. Neither has whitespace but gap is significant →
      //      insert a TextNode(' ') and compensate marginLeft.
      if (cursor > 0) {
        const prevEndsSpace = /\s$/.test(prevStr);
        const currStartsSpace = /^\s/.test(item.str);

        if (!prevEndsSpace && !currStartsSpace && gap > item.fontSize * 0.15) {
          lineDiv.appendChild(document.createTextNode(' '));
          adjustedGap = gap - spaceAdvance;
        }
      }

      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.fontSize = item.fontSize + 'px';

      // Horizontal gap from previous span
      if (adjustedGap > 0.5) {
        span.style.marginLeft = adjustedGap + 'px';
      }

      // Measure the natural width of this text in sans-serif,
      // then scale horizontally to match the PDF's exact width.
      // This handles bold, condensed, monospace, and any other
      // font whose glyph widths differ from sans-serif.
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

      // Handle rotation (overrides scaleX if present)
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
// Image Region Extraction
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
      case OPS.save:
        ctmStack.push([...ctm]);
        break;

      case OPS.restore:
        ctm = ctmStack.pop() || [...IDENTITY_MATRIX];
        break;

      case OPS.transform:
        ctm = multiplyMatrices(ctm, args);
        break;

      case OPS.paintFormXObjectBegin:
        ctmStack.push([...ctm]);
        if (args[0]) {
          ctm = multiplyMatrices(ctm, args[0]);
        }
        break;

      case OPS.paintFormXObjectEnd:
        ctm = ctmStack.pop() || [...IDENTITY_MATRIX];
        break;

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
// Dark Mode Logic
//
// Each page resolves its dark mode state through:
// 1. User override (if set) — 'dark' or 'light'
// 2. Already-dark detection — if page is dark, skip inversion
// 3. Default — apply dark mode
// ============================================================

function shouldApplyDark(pageNum) {
  const override = pageDarkOverride.get(pageNum);
  if (override === 'dark') return true;
  if (override === 'light') return false;

  // Auto mode: don't invert if already dark
  if (pageAlreadyDark.get(pageNum)) return false;

  return true; // Default: apply dark mode
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

async function exportDarkPdf() {
  if (!pdfDoc || exporting) return;

  exporting = true;
  btnExport.disabled = true;

  try {
    const { PDFDocument, StandardFonts } = await ensurePdfLib();

    const outPdf = await PDFDocument.create();
    const font = await outPdf.embedFont(StandardFonts.Helvetica);
    const totalPages = pdfDoc.numPages;
    const exportDpr = 2;

    showExportProgress(0, totalPages);

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
      ];
      if (!isScannedDocument) {
        tasks.push(page.getTextContent());
      }

      const results = await Promise.all(tasks);
      const opList = results[1];
      const textContent = isScannedDocument ? null : results[2];

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
      // Each text item is drawn in Helvetica at a fontSize adjusted
      // so the string's width matches the original PDF width. This
      // is the PDF-space equivalent of CSS scaleX(): Helvetica has
      // different glyph widths than the original font, so without
      // adjustment the selection would extend past the visible text.
      //
      // adjustedSize = baseFontSize * (targetWidth / helveticaWidth)
      //
      // The height distortion is invisible (opacity: 0 text).
      if (textContent) {
        // Native PDF: use original text coordinates
        for (const item of textContent.items) {
          if (!item.str || !item.str.trim()) continue;
          const tx = item.transform;
          const baseFontSize = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
          if (baseFontSize < 1) continue;

          // Adjust fontSize so Helvetica width matches PDF width
          let drawSize = baseFontSize;
          if (item.width > 0) {
            const naturalWidth = font.widthOfTextAtSize(item.str, baseFontSize);
            if (naturalWidth > 0) {
              drawSize = baseFontSize * (item.width / naturalWidth);
            }
          }

          try {
            outPage.drawText(item.str, {
              x: tx[4],
              y: tx[5],
              size: drawSize,
              font,
              opacity: 0,
            });
          } catch (_) {
            // Skip characters not in Helvetica encoding
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
              const baseFontSize = (word.bbox.y1 - word.bbox.y0) * sy * 0.85;
              if (baseFontSize < 1) continue;

              // Adjust fontSize so Helvetica width matches OCR bbox width
              const targetWidth = (word.bbox.x1 - word.bbox.x0) * sx;
              let drawSize = baseFontSize;
              if (targetWidth > 0) {
                const naturalWidth = font.widthOfTextAtSize(word.text, baseFontSize);
                if (naturalWidth > 0) {
                  drawSize = baseFontSize * (targetWidth / naturalWidth);
                }
              }

              try {
                outPage.drawText(word.text, {
                  x: word.bbox.x0 * sx,
                  y: origVp.height - word.bbox.y1 * sy,
                  size: drawSize,
                  font,
                  opacity: 0,
                });
              } catch (_) {
                // Skip characters not in Helvetica encoding
              }
            }
          }
        }
      }

      // --- Release memory ---
      renderCanvas.width = 0;
      finalCanvas.width = 0;

      showExportProgress(pageNum, totalPages);

      // Yield to UI thread for progress bar update
      await new Promise(r => setTimeout(r, 0));
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
