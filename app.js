// ============================================================
// Smart Dark PDF Reader - v0
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

  // Transform all four corners of the unit square
  const c0 = transformPoint(final, 0, 0);
  const c1 = transformPoint(final, 1, 0);
  const c2 = transformPoint(final, 1, 1);
  const c3 = transformPoint(final, 0, 1);

  // Axis-aligned bounding box
  const xs = [c0[0], c1[0], c2[0], c3[0]];
  const ys = [c0[1], c1[1], c2[1], c3[1]];

  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    x: Math.floor(minX),
    y: Math.floor(minY),
    width: Math.ceil(maxX) - Math.floor(minX),
    height: Math.ceil(maxY) - Math.floor(minY),
  };
}

// ============================================================
// State
// ============================================================

let pdfDoc = null;
let currentPageNum = 1;
let currentRenderTask = null;
// Tracks which pages have dark mode disabled by the user
const lightPages = new Set();

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

// Hidden canvas for "clean" (non-inverted) rendering.
// Created offscreen - never added to the DOM.
const hiddenCanvas = document.createElement('canvas');
const hiddenCtx = hiddenCanvas.getContext('2d');

// ============================================================
// File Handling
// ============================================================

function handleFile(file) {
  if (!file || file.type !== 'application/pdf') return;

  const fileReader = new FileReader();
  fileReader.onload = async (e) => {
    const typedArray = new Uint8Array(e.target.result);
    await loadPDF(typedArray);
  };
  fileReader.readAsArrayBuffer(file);
}

// ============================================================
// PDF Loading
// ============================================================

async function loadPDF(data) {
  try {
    if (pdfDoc) {
      pdfDoc.destroy();
    }

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
  const viewport = page.getViewport({ scale: 1 });
  const toolbarH = 48;
  const padding = 48;
  const availW = window.innerWidth - padding;
  const availH = window.innerHeight - toolbarH - padding;
  const scaleW = availW / viewport.width;
  const scaleH = availH / viewport.height;
  return Math.min(scaleW, scaleH, 3);
}

// ============================================================
// Rendering Pipeline
// ============================================================

async function renderCurrentPage() {
  if (!pdfDoc) return;

  // Cancel any in-progress render
  if (currentRenderTask) {
    currentRenderTask.cancel();
    currentRenderTask = null;
  }

  loadingIndicator.hidden = false;
  updateNavigationUI();

  const page = await pdfDoc.getPage(currentPageNum);
  const dpr = window.devicePixelRatio || 1;
  const cssScale = calculateScale(page);
  const renderScale = cssScale * dpr;
  const viewport = page.getViewport({ scale: renderScale });

  // Size all canvases identically
  const w = viewport.width;
  const h = viewport.height;
  const cssW = Math.floor(w / dpr) + 'px';
  const cssH = Math.floor(h / dpr) + 'px';

  pdfCanvas.width = w;
  pdfCanvas.height = h;
  pdfCanvas.style.width = cssW;
  pdfCanvas.style.height = cssH;

  overlayCanvas.width = w;
  overlayCanvas.height = h;
  overlayCanvas.style.width = cssW;
  overlayCanvas.style.height = cssH;

  hiddenCanvas.width = w;
  hiddenCanvas.height = h;

  // Clear canvases
  pdfCtx.clearRect(0, 0, w, h);
  overlayCtx.clearRect(0, 0, w, h);
  hiddenCtx.clearRect(0, 0, w, h);

  // Render to both canvases in parallel + extract operator list
  const renderMain = page.render({
    canvasContext: pdfCtx,
    viewport,
  });
  currentRenderTask = renderMain;

  try {
    const [, , opList] = await Promise.all([
      renderMain.promise,
      page.render({ canvasContext: hiddenCtx, viewport }).promise,
      page.getOperatorList(),
    ]);

    // Extract image regions from the operator list
    const imageRegions = extractImageRegions(opList, viewport.transform);

    // Composite original images onto the overlay
    compositeOverlay(imageRegions, w, h);

    // Apply dark mode state for this page
    applyDarkModeState();
  } catch (err) {
    if (err.name === 'RenderingCancelled' || err.message?.includes('Rendering cancelled')) {
      return; // Page navigation interrupted the render - this is expected
    }
    console.error('Render failed:', err);
  } finally {
    currentRenderTask = null;
    loadingIndicator.hidden = true;
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
        // args = [a, b, c, d, e, f]
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
        // args = [objId, imgPixelWidth, imgPixelHeight, tx0, ty0, tx1, ty1, ...]
        // Each (tx, ty) pair is a translation for one repeat of the image.
        // The image size in PDF space comes from the CTM (not imgPixelWidth/Height).
        if (args.length > 3) {
          for (let j = 3; j < args.length; j += 2) {
            const tx = args[j];
            const ty = args[j + 1];
            const repeatCtm = multiplyMatrices(ctm, [1, 0, 0, 1, tx, ty]);
            regions.push(computeImageBounds(repeatCtm, viewportTransform));
          }
        } else {
          // Fallback: single image at current CTM
          regions.push(computeImageBounds(ctm, viewportTransform));
        }
        break;
      }

      // Image masks are NOT raster photos - they are 1-bit stencils
      // used for clipping or solid-color fills. We intentionally skip them
      // so they get inverted along with the rest of the page content.
      //
      // Skipped: paintImageMaskXObject (83)
      //          paintImageMaskXObjectGroup (84)
      //          paintImageMaskXObjectRepeat (89)
      //          paintSolidColorImageMask (90)
    }
  }

  return regions;
}

// ============================================================
// Overlay Composition
//
// Copies image regions from the hidden (clean) canvas onto the
// overlay canvas. Since the overlay sits on top of the inverted
// main canvas, these regions appear in their original colors.
// ============================================================

function compositeOverlay(regions, canvasWidth, canvasHeight) {
  overlayCtx.clearRect(0, 0, canvasWidth, canvasHeight);

  for (const r of regions) {
    // Clamp to canvas bounds
    const sx = Math.max(0, r.x);
    const sy = Math.max(0, r.y);
    const sx2 = Math.min(canvasWidth, r.x + r.width);
    const sy2 = Math.min(canvasHeight, r.y + r.height);
    const sw = sx2 - sx;
    const sh = sy2 - sy;

    if (sw <= 0 || sh <= 0) continue;

    // Copy from hidden canvas to overlay at the exact same position
    overlayCtx.drawImage(hiddenCanvas, sx, sy, sw, sh, sx, sy, sw, sh);
  }
}

// ============================================================
// Dark Mode Toggle (per-page)
// ============================================================

function isDarkForCurrentPage() {
  return !lightPages.has(currentPageNum);
}

function applyDarkModeState() {
  const isDark = isDarkForCurrentPage();

  // CSS inversion filter on the main canvas
  pdfCanvas.classList.toggle('dark-active', isDark);

  // Show overlay only when dark mode is active (images need protection)
  overlayCanvas.hidden = !isDark;

  // Toggle button icon
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
  const total = pdfDoc.numPages;
  pageInfo.textContent = `${currentPageNum} / ${total}`;
  btnPrev.disabled = currentPageNum <= 1;
  btnNext.disabled = currentPageNum >= total;
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
  const file = e.dataTransfer.files[0];
  handleFile(file);
});

fileInput.addEventListener('change', () => {
  handleFile(fileInput.files[0]);
  fileInput.value = '';
});

// --- Toolbar Buttons ---

btnPrev.addEventListener('click', () => goToPage(currentPageNum - 1));
btnNext.addEventListener('click', () => goToPage(currentPageNum + 1));
btnToggle.addEventListener('click', toggleDarkMode);

btnFile.addEventListener('click', () => {
  fileInput.click();
});

// --- Keyboard Navigation ---

document.addEventListener('keydown', (e) => {
  if (!pdfDoc) return;

  switch (e.key) {
    case 'ArrowLeft':
      goToPage(currentPageNum - 1);
      break;
    case 'ArrowRight':
      goToPage(currentPageNum + 1);
      break;
    case 'd':
      // 'd' key toggles dark mode for current page
      toggleDarkMode();
      break;
  }
});

// --- Window Resize ---

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (pdfDoc) renderCurrentPage();
  }, 200);
});

// Also allow dropping files onto the reader view
reader.addEventListener('dragover', (e) => e.preventDefault());
reader.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  handleFile(file);
});
