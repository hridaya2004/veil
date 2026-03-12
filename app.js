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
    cleanup();

    pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    pageDarkOverride.clear();
    pageAlreadyDark.clear();
    globalGeneration++;

    dropZone.hidden = true;
    readerEl.hidden = false;

    await buildPageSlots();
    setupIntersectionObserver();
    updateCurrentPageFromScroll();
  } catch (err) {
    console.error('Failed to load PDF:', err);
    alert('Could not load this PDF. It may be corrupted or password-protected.');
  }
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

    // Render + get operator list + get text content in parallel
    const renderCanvas = createOffscreenCanvas(w, h);
    const [, opList, textContent] = await Promise.all([
      page.render({
        canvasContext: renderCanvas.getContext('2d'),
        viewport: scaledViewport,
      }).promise,
      page.getOperatorList(),
      page.getTextContent(),
    ]);

    if (globalGeneration !== myGen) return;

    // --- Already-dark detection ---
    const isDark = detectAlreadyDark(renderCanvas);
    pageAlreadyDark.set(pageNum, isDark);

    // --- Extract image regions ---
    const regions = extractImageRegions(opList, scaledViewport.transform);

    // --- Paint main canvas ---
    slot.mainCanvas.width = w;
    slot.mainCanvas.height = h;
    const mainCtx = slot.mainCanvas.getContext('2d');
    mainCtx.drawImage(renderCanvas, 0, 0);

    // --- Paint overlay canvas ---
    slot.overlayCanvas.width = w;
    slot.overlayCanvas.height = h;
    compositeImageRegions(slot.overlayCanvas.getContext('2d'), renderCanvas, regions, w, h);

    // --- Build text layer ---
    buildTextLayer(slot.textLayer, textContent, scaledViewport, dpr);

    // Release temp canvas
    renderCanvas.width = 0;

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

  // --- Step 1: Transform all items to screen coordinates ---
  const items = [];
  for (const item of textContent.items) {
    if (!item.str && !item.hasEOL) continue;

    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
    const fontSize = fontHeight / dpr;

    // Skip items with degenerate size
    if (fontSize < 1) continue;

    const left = tx[4] / dpr;
    // tx[5] is the baseline Y in canvas pixels. BASELINE_RATIO
    // (measured at runtime) tells us where the browser places the
    // baseline within a line-height:1 box, so we can align precisely.
    const top = tx[5] / dpr - fontSize * BASELINE_RATIO;
    const width = item.width > 0 ? (item.width * viewport.scale / dpr) : 0;

    items.push({
      str: item.str || '',
      left,
      top,
      fontSize,
      width,
      height: fontSize,
      hasEOL: !!item.hasEOL,
      // For rotation detection
      tx1: tx[1],
      tx2: tx[2],
    });
  }

  if (items.length === 0) return;

  // --- Step 2: Group into lines by Y coordinate ---
  // Items within half a font-height of each other are on the same line.
  // Sort by top first, then group.
  items.sort((a, b) => a.top - b.top || a.left - b.left);

  const lines = [];
  let currentLine = [items[0]];
  let lineTop = items[0].top;
  let lineHeight = items[0].height;

  for (let i = 1; i < items.length; i++) {
    const item = items[i];
    const threshold = lineHeight * 0.5;

    if (Math.abs(item.top - lineTop) < threshold) {
      // Same line
      currentLine.push(item);
      // Update line height to max
      if (item.height > lineHeight) lineHeight = item.height;
    } else {
      // New line
      lines.push(currentLine);
      currentLine = [item];
      lineTop = item.top;
      lineHeight = item.height;
    }
  }
  lines.push(currentLine);

  // --- Step 3: Build DOM with continuous flow ---
  //
  // Key insight: for seamless selection across lines, the DOM
  // must be in normal document flow — not position:absolute.
  // We use padding-top on each line-div to push it to its
  // correct Y position relative to the previous line's bottom.
  // This gives the browser a continuous selectable surface.
  const fragment = document.createDocumentFragment();
  const pageWidth = viewport.width / dpr;

  let prevBottom = 0; // bottom edge of the previous line (in CSS px)

  for (const line of lines) {
    // Sort items within the line left-to-right
    line.sort((a, b) => a.left - b.left);

    const lineDiv = document.createElement('div');
    lineDiv.className = 'text-line';

    const lineTop = line[0].top;
    const lineHeight = Math.max(...line.map(it => it.height));

    // Vertical gap from previous line → padding-top
    const vGap = Math.max(0, lineTop - prevBottom);
    lineDiv.style.paddingTop = vGap + 'px';
    lineDiv.style.height = (lineHeight + vGap) + 'px';
    lineDiv.style.width = pageWidth + 'px';

    prevBottom = lineTop + lineHeight;

    let cursor = 0; // horizontal position tracker

    for (let i = 0; i < line.length; i++) {
      const item = line[i];
      if (!item.str) continue;

      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.fontSize = item.fontSize + 'px';

      // Horizontal gap from the previous span (or line start)
      const gap = item.left - cursor;
      if (gap > 0.5) {
        span.style.paddingLeft = gap + 'px';
      }

      // Stretch span to match PDF glyph width
      if (item.width > 0) {
        span.style.width = (item.width + Math.max(0, gap)) + 'px';
        span.style.display = 'inline-block';
      }

      // Handle rotation
      if (item.tx1 !== 0 || item.tx2 !== 0) {
        const angle = Math.atan2(item.tx1, Math.sqrt(item.tx2 * item.tx2 + (item.fontSize * dpr) * (item.fontSize * dpr)));
        span.style.transform = `rotate(${angle}rad)`;
        span.style.transformOrigin = '0 100%';
      }

      lineDiv.appendChild(span);
      cursor = item.left + (item.width || 0);
    }

    // Fill remaining width so dragging past end-of-line stays in flow
    const remaining = pageWidth - cursor;
    if (remaining > 1) {
      const filler = document.createElement('span');
      filler.className = 'text-filler';
      filler.textContent = '\u00A0';
      filler.style.width = remaining + 'px';
      lineDiv.appendChild(filler);
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
