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

// CDN dependencies — single source of truth for all external library URLs.
// Update version numbers here only; they propagate to all import sites.
const DEPS = {
  PDFJS:        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.min.mjs',
  PDFJS_WORKER: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.worker.min.mjs',
  TESSERACT:    'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js',
  PDF_LIB:      'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js',
  FONTKIT:       'https://esm.sh/@pdf-lib/fontkit@1.1.1',
  NOTO_SANS:    'https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSans/hinted/ttf/NotoSans-Regular.ttf',
};

import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/5.4.149/pdf.min.mjs';

import {
  initExport,
  exportDarkPdf,
  cancelExport,
  hideExportProgress,
} from './export.js';

import {
  saveSession,
  loadSession,
  clearSession,
  SESSION_MAX_SIZE,
  hasFileSystemAccess,
} from './session.js';

import {
  initOcr,
  resetOcrState,
  enqueueOcrJob,
  cancelOcrJobsForPage,
  ocrCache,
  ocrFingerprints,
  ocrQueue,
  ocrImageRegions,
  ocrImageVertical,
  ensureTesseractWorker,
  preprocessCanvasForOcr,
  buildOcrTextLayerDirect,
  scheduleTextLayer,
} from './ocr.js';

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
  isOcrArtifact,
} from './core.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = DEPS.PDFJS_WORKER;

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

// Feature-detect ctx.filter support (Safari iOS ignores it silently)
const supportsCtxFilter = (() => {
  try {
    const src = document.createElement('canvas');
    src.width = 1; src.height = 1;
    const srcCtx = src.getContext('2d');
    srcCtx.fillStyle = '#ff0000';
    srcCtx.fillRect(0, 0, 1, 1);
    const dst = document.createElement('canvas');
    dst.width = 1; dst.height = 1;
    const dstCtx = dst.getContext('2d');
    dstCtx.filter = 'invert(1)';
    dstCtx.drawImage(src, 0, 0);
    const px = dstCtx.getImageData(0, 0, 1, 1).data;
    return px[0] < 128 && px[1] > 128;
  } catch (_) { return false; }
})();

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

const pdfState = {
  doc: null,
  scale: 0,
  buffer: null,              // raw bytes for iOS engine reset
  geometry: [],              // [{cssWidth, cssHeight, offsetTop}] per page (1-based)
  generation: 0,             // monotonic counter for stale detection
  isScanned: false,
  fileName: 'document',
  largeDocConstrained: false,
  currentPage: 1,
  darkOverride: new Map(),   // 'auto' | 'dark' | 'light' per page
  alreadyDark: new Map(),    // boolean per page
  slots: new Map(),          // pageNum → pool container
  renderState: new Map(),    // pageNum → {rendered, rendering, ...}
  zoomMultiplier: parseFloat(localStorage.getItem('veil-zoom')) || 1.0,
  get renderScale() {
    // On phone landscape (short screens), always render at 1x — fit-to-width is optimal.
    // Foldable/tablet landscape keeps user zoom (screens are tall enough).
    const zoom = (typeof isPhoneLandscape === 'function' && isPhoneLandscape())
      ? 1 : this.zoomMultiplier;
    return this.scale * zoom;
  },
};
// Desktop: generous pool for fluid scrolling (RAM is abundant).
// Mobile: tight pool to minimize canvas context memory pressure.
const POOL_SIZE = _memConstrainedEarly ? 5 : window.matchMedia('(pointer: fine)').matches ? 15 : 7;
const VIRTUAL_BUFFER = _memConstrainedEarly ? 1 : window.matchMedia('(pointer: fine)').matches ? 5 : 2;
const PAGE_GAP = 40; // px between pages (matches CSS gap)
const VIEWPORT_PADDING_TOP = 64; // space for floating toolbar

// Monotonically increasing, bumped on new PDF load or resize

// true if the document is detected as scanned (full-page images, no text).
// When true, image protection is skipped so CSS inversion covers the whole page.





// ============================================================
// DOM References
// ============================================================

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const readerEl = document.getElementById('reader');

// Screen reader announcements
const srAnnouncer = document.getElementById('sr-announcer');
function announce(message) {
  if (!srAnnouncer) return;
  srAnnouncer.textContent = '';
  requestAnimationFrame(() => { srAnnouncer.textContent = message; });
}
const btnHome = document.getElementById('btn-home');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const btnToggle = document.getElementById('btn-toggle');
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

// iOS detection — all browsers on iOS use WebKit (Apple policy),
// so they ALL share the same Jetsam memory limits. This detects
// the device, not the browser engine.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Detect true mobile OS (phones and tablets, not 2-in-1 laptops).
// Surface Pro / Chromebook with touch pass through — they have
// desktop-class RAM and browser capabilities for export.
const isMobileOS = isIOS || /Android|HarmonyOS|Mobile|Opera Mini/i.test(navigator.userAgent);

// Hide export on mobile — browser sandbox memory limits make
// Tesseract OCR + PDF generation crash on documents over ~50 pages.
if (isMobileOS) {
  btnExport.style.display = 'none';
}

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

const uiState = {
  focusTimer: null,
  focusPaused: false,
  hoverTimer: null,
  mouseMoveThrottled: false,
  errorTimeout: null,
  infoTimeout: null,
  zoomHintShown: false,
  hasZoomedIn: false,
  savePageTimer: null,
  ocrPressTimer: null,
  ocrPressStartX: 0,
  ocrPressStartY: 0,
  resizeTimer: null,
};
// On mobile, the user needs more time to decide what to tap.
const FOCUS_DELAY = window.matchMedia('(pointer: coarse)').matches ? 2500 : 1500;
const TOOLBAR_TRIGGER_ZONE = 35; // px from top edge
const TOOLBAR_HOVER_DELAY = 300; // ms mouse must stay in zone

function enterFocusMode() {
  if (!readerEl || readerEl.hidden || uiState.focusPaused) return;
  toolbar.classList.add('toolbar-hidden');
  // Remove toolbar elements from tab order when hidden
  toolbar.querySelectorAll('button, a, [tabindex]').forEach(el => {
    el.setAttribute('tabindex', '-1');
  });
}

function exitFocusMode() {
  // Mobile landscape: toolbar stays hidden unconditionally.
  // The user rotates to portrait to access toolbar actions.
  if (isPhoneLandscape()) return;
  toolbar.classList.remove('toolbar-hidden');
  // Restore toolbar elements to tab order
  toolbar.querySelectorAll('button, a, [tabindex="-1"]').forEach(el => {
    el.removeAttribute('tabindex');
  });
  resetFocusTimer();
}

function resetFocusTimer() {
  if (uiState.focusTimer) clearTimeout(uiState.focusTimer);
  uiState.focusTimer = setTimeout(() => { uiState.focusTimer = null; enterFocusMode(); }, FOCUS_DELAY);
}

// Mouse near top edge: show toolbar after dwelling briefly.
// Throttled to ~30fps to avoid timer churn during trackpad scroll.

document.addEventListener('mousemove', (e) => {
  if (uiState.mouseMoveThrottled || !readerEl || readerEl.hidden) return;
  uiState.mouseMoveThrottled = true;
  requestAnimationFrame(() => { uiState.mouseMoveThrottled = false; });

  // Is the mouse over the toolbar or in the trigger zone?
  const toolbarRect = toolbar.getBoundingClientRect();
  const overToolbar = e.clientY <= toolbarRect.bottom + 5 &&
    e.clientX >= toolbarRect.left - 10 && e.clientX <= toolbarRect.right + 10;

  if (e.clientY <= TOOLBAR_TRIGGER_ZONE || overToolbar) {
    if (toolbar.classList.contains('toolbar-hidden') && !uiState.hoverTimer) {
      uiState.hoverTimer = setTimeout(() => {
        uiState.hoverTimer = null;
        exitFocusMode();
      }, TOOLBAR_HOVER_DELAY);
    }
  } else {
    if (uiState.hoverTimer) {
      clearTimeout(uiState.hoverTimer);
      uiState.hoverTimer = null;
    }
  }

  // Toolbar visible: keep it while mouse is over it, hide timer when away
  if (!toolbar.classList.contains('toolbar-hidden')) {
    if (overToolbar) {
      clearTimeout(uiState.focusTimer);
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
  if (isPhoneLandscape()) return;

  const touch = e.touches[0];
  if (touch && touch.clientY <= TOOLBAR_TRIGGER_ZONE * 2) {
    e.preventDefault();
    exitFocusMode();
  }
}, { passive: false });

// Keyboard: Tab reveals toolbar when hidden (accessibility)
// F to toggle focus mode
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && !readerEl.hidden && toolbar.classList.contains('toolbar-hidden')) {
    exitFocusMode();
  }
  if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey
      && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA') {
    if (toolbar.classList.contains('toolbar-hidden')) {
      exitFocusMode();
    } else {
      clearTimeout(uiState.focusTimer);
      enterFocusMode();
    }
  }
});

// ============================================================
// Error Display
// ============================================================


function showError(msg, duration = 8000) {
  errorMessage.textContent = msg;
  errorBanner.hidden = false;
  if (uiState.errorTimeout) clearTimeout(uiState.errorTimeout);
  if (duration > 0) {
    uiState.errorTimeout = setTimeout(() => { errorBanner.hidden = true; }, duration);
  }
}

errorDismiss.addEventListener('click', () => {
  errorBanner.hidden = true;
  if (uiState.errorTimeout) clearTimeout(uiState.errorTimeout);
});


function showInfo(msg, duration = 6000) {
  infoMessage.textContent = msg;
  infoBanner.hidden = false;
  if (uiState.infoTimeout) clearTimeout(uiState.infoTimeout);
  if (duration > 0) {
    uiState.infoTimeout = setTimeout(() => { infoBanner.hidden = true; }, duration);
  }
}

// Dismiss info banner on tap (mobile)
infoBanner.addEventListener('click', () => {
  infoBanner.hidden = true;
  if (uiState.infoTimeout) clearTimeout(uiState.infoTimeout);
});

// Pinch-to-zoom hint: on mobile, portrait pages are rendered at
// a lower scale than landscape. When the user zooms in and then
// back out, suggest landscape. Shown once per session, triggered
// on zoom-out — the moment the user realizes the quality isn't
// enough and returns to normal view.
if (window.matchMedia('(pointer: coarse)').matches && window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    if (uiState.zoomHintShown || !pdfState.doc) return;
    // Don't suggest landscape if already in landscape
    if (window.matchMedia('(orientation: landscape)').matches) return;
    const scale = window.visualViewport.scale;
    if (scale > 1.2) {
      uiState.hasZoomedIn = true;
    } else if (uiState.hasZoomedIn && scale < 1.1) {
      uiState.hasZoomedIn = false;
      uiState.zoomHintShown = true;
      showInfo('For best visual quality, try landscape mode.');
    }
  });
}

// ============================================================
// Session Persistence (PWA Resume)
//
// Hybrid architecture:
// - Desktop (File System Access API): save a file handle (~30 bytes)
//   in IndexedDB. On resume, the browser asks permission and reads
//   the original file from disk. Zero duplication.
// - Mobile (iOS/Android): save the ArrayBuffer in IndexedDB.
//   LRU 1 slot — only the last PDF is kept. Limit ~120MB to avoid
//   RAM spike on boot when deserializing.
// - Both: page number + filename in localStorage (survives SW updates)
// ============================================================


function savePagePosition() {
  if (!pdfState.doc) return;
  localStorage.setItem('veil-page', String(pdfState.currentPage));

  // Persist dark mode overrides (pages manually toggled by the user)
  const overrides = {};
  for (const [pageNum, mode] of pdfState.darkOverride) {
    if (mode !== 'auto') overrides[pageNum] = mode;
  }
  if (Object.keys(overrides).length > 0) {
    localStorage.setItem('veil-dark-overrides', JSON.stringify(overrides));
  } else {
    localStorage.removeItem('veil-dark-overrides');
  }
}

// Page position saving is handled by the unified scroll coordinator below

async function persistFile(file, arrayBuffer) {
  const filename = file.name;

  if (hasFileSystemAccess && file._handle) {
    // Desktop: save the lightweight file handle (~30 bytes)
    localStorage.setItem('veil-filename', filename);
    localStorage.setItem('veil-page', '1');
    await saveSession({ type: 'handle', handle: file._handle, filename });
  } else if (arrayBuffer.byteLength <= SESSION_MAX_SIZE) {
    // Mobile: save the full ArrayBuffer (LRU 1 slot)
    localStorage.setItem('veil-filename', filename);
    localStorage.setItem('veil-page', '1');
    await saveSession({ type: 'buffer', buffer: arrayBuffer, filename });
  } else {
    // File too large for IndexedDB — clear any stale file from
    // IndexedDB (previous smaller file) but keep filename + page
    // in localStorage as a reminder for the resume screen.
    await clearSession();
    localStorage.setItem('veil-filename', filename);
    localStorage.setItem('veil-page', '1');
  }
}

async function restoreSession(forceButton = false) {
  const loader = document.getElementById('app-loader');
  const savedFilename = localStorage.getItem('veil-filename');
  const savedPage = parseInt(localStorage.getItem('veil-page'), 10) || 1;

  if (!savedFilename) return false;

  const sessionData = await loadSession();
  if (!sessionData) {
    if (forceButton && pdfState.buffer) {
      // User clicked "veil" while reading a large file — the PDF is
      // still in memory even though it wasn't persisted to IndexedDB.
      // Show a clickable resume button that reloads from the buffer.
      showResumeButton(savedFilename, async () => {
        try {
          if (loader) loader.hidden = false;
          pdfState.fileName = savedFilename.replace(/\.pdf$/i, '');
          if (fileNameEl) fileNameEl.textContent = savedFilename;
          document.title = `veil - ${savedFilename}`;
          await loadPDF(new Uint8Array(pdfState.buffer), savedPage);
          if (loader) loader.hidden = true;
        } catch (_) {
          if (loader) loader.hidden = true;
          hideResumeButton();
        }
      });
    } else {
      // Cold start with no file in IndexedDB — show a non-actionable
      // reminder of where the user was, with Browse PDF as primary.
      showResumeReminder(savedFilename, savedPage);
    }
    return false;
  }

  try {
    if (sessionData.type === 'handle') {
      // Desktop File System Access API: requestPermission() requires
      // a user gesture (Transient User Activation). We cannot call it
      // at page load — Chrome silently denies it. Instead, show a
      // resume button on the drop zone. The user clicks once, the
      // browser approves, and the file loads from disk.
      showResumeButton(savedFilename, async () => {
        try {
          const permission = await sessionData.handle.requestPermission({ mode: 'read' });
          if (permission !== 'granted') { clearSession(); return; }
          const file = await sessionData.handle.getFile();
          const buffer = await file.arrayBuffer();
          if (loader) loader.hidden = false;
          pdfState.fileName = savedFilename.replace(/\.pdf$/i, '');
          if (fileNameEl) fileNameEl.textContent = savedFilename;
          document.title = `veil - ${savedFilename}`;
          await loadPDF(new Uint8Array(buffer), savedPage);
          if (loader) loader.hidden = true;
        } catch (err) {
          if (loader) loader.hidden = true;
          clearSession();
          hideResumeButton();
        }
      });
      return false; // drop zone stays visible (with resume button)
    } else if (sessionData.type === 'buffer') {
      if (forceButton) {
        // User explicitly returned to drop zone — show resume button
        showResumeButton(savedFilename, async () => {
          try {
            if (loader) loader.hidden = false;
            pdfState.fileName = savedFilename.replace(/\.pdf$/i, '');
            if (fileNameEl) fileNameEl.textContent = savedFilename;
            document.title = `veil - ${savedFilename}`;
            await loadPDF(new Uint8Array(sessionData.buffer), savedPage);
            if (loader) loader.hidden = true;
          } catch (err) {
            if (loader) loader.hidden = true;
            clearSession();
            hideResumeButton();
          }
        });
        return false;
      }
      // Natural reopen — auto-restore without click
      if (loader) loader.hidden = false;
      pdfState.fileName = savedFilename.replace(/\.pdf$/i, '');
      if (fileNameEl) fileNameEl.textContent = savedFilename;
      document.title = `veil - ${savedFilename}`;
      await loadPDF(new Uint8Array(sessionData.buffer), savedPage);
      if (loader) loader.hidden = true;
      return true;
    }
  } catch (err) {
    if (loader) loader.hidden = true;
    clearSession();
    return false;
  }

  return false;
}

function showResumeButton(filename, onClick) {
  const existing = document.getElementById('resume-section');
  if (existing) existing.remove();

  const savedPage = parseInt(localStorage.getItem('veil-page'), 10) || 1;

  const section = document.createElement('div');
  section.id = 'resume-section';
  section.className = 'drop-resume-section';
  section.role = 'button';
  section.tabIndex = 0;
  section.setAttribute('aria-label', `Resume reading ${filename}`);
  const label = document.createElement('p');
  label.className = 'drop-resume-label';
  label.textContent = 'Pick up where you left off';
  const fname = document.createElement('p');
  fname.className = 'drop-resume-filename';
  fname.textContent = filename;
  const page = document.createElement('p');
  page.className = 'drop-resume-page';
  page.textContent = `Page ${savedPage}`;
  section.append(label, fname, page);
  // Empty touchstart enables :active on iOS Safari
  section.addEventListener('touchstart', () => {}, { passive: true });
  function activateResume(e) {
    e.stopPropagation();
    section.querySelector('.drop-resume-label').textContent = 'Loading...';
    onClick();
  }
  section.addEventListener('click', activateResume);
  section.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activateResume(e);
    }
  });

  const hero = document.querySelector('.drop-hero');
  if (hero) hero.appendChild(section);

  // Hide "Browse PDF" button and tagline when resume is shown
  const browseBtn = document.querySelector('.drop-browse-btn');
  if (browseBtn) browseBtn.style.display = 'none';
  document.querySelectorAll('.drop-tagline').forEach(el => el.style.display = 'none');

  // Add "or open a different file" below
  const altExisting = document.getElementById('drop-alt-action');
  if (altExisting) altExisting.remove();
  const alt = document.createElement('label');
  alt.id = 'drop-alt-action';
  alt.className = 'drop-alt-action';
  alt.htmlFor = 'file-input';
  alt.textContent = 'or open a different file';
  // Empty touchstart enables :active on iOS Safari
  alt.addEventListener('touchstart', () => {}, { passive: true });
  hero.appendChild(alt);
}

function showResumeReminder(filename, savedPage) {
  // Non-actionable resume: the file wasn't stored (too large for IndexedDB)
  // but we remember the filename and page. Shows where the user was
  // with Browse PDF as the primary action to re-open the file.
  const existing = document.getElementById('resume-section');
  if (existing) existing.remove();

  const section = document.createElement('div');
  section.id = 'resume-section';
  section.className = 'drop-resume-section';
  section.style.cursor = 'default';
  section.style.pointerEvents = 'none';
  section.style.opacity = '0.5';

  const label = document.createElement('p');
  label.className = 'drop-resume-label';
  label.textContent = `You were on page ${savedPage}`;
  const fname = document.createElement('p');
  fname.className = 'drop-resume-filename';
  fname.textContent = filename;
  section.append(label, fname);

  const hero = document.querySelector('.drop-hero');
  if (hero) hero.appendChild(section);

  // Hide tagline, move Browse PDF below the reminder box
  document.querySelectorAll('.drop-tagline').forEach(el => el.style.display = 'none');
  const browseBtn = document.querySelector('.drop-browse-btn');
  if (browseBtn) {
    browseBtn.style.display = '';
    browseBtn.style.marginTop = '24px';
    hero.appendChild(browseBtn); // moves (not clones) after the section
  }
}

function hideResumeButton() {
  const section = document.getElementById('resume-section');
  if (section) section.remove();
  const alt = document.getElementById('drop-alt-action');
  if (alt) alt.remove();
  // Restore Browse PDF button and tagline
  const browseBtn = document.querySelector('.drop-browse-btn');
  if (browseBtn) browseBtn.style.display = '';
  document.querySelectorAll('.drop-tagline').forEach(el => el.style.display = '');
}

// ============================================================
// File Handling
// ============================================================

function handleFile(file) {
  if (!file) return;
  if (file.size === 0) {
    showError('This file is empty.');
    return;
  }
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) return;
  if (file.size > 512 * 1024 * 1024) {
    showError('This file is too large. Maximum size is 512 MB.');
    return;
  }
  hideResumeButton();
  announce('Loading document...');
  pdfState.fileName = file.name.replace(/\.pdf$/i, '');
  if (fileNameEl) fileNameEl.textContent = file.name;
  document.title = `veil - ${file.name}`;

  // Start focus mode timer when a PDF is loaded
  resetFocusTimer();

  // If reopening the same file, resume at the saved page
  const savedName = localStorage.getItem('veil-filename');
  const resumePage = (savedName && file.name === savedName)
    ? parseInt(localStorage.getItem('veil-page'), 10) || 1
    : 1;

  const fr = new FileReader();
  fr.onload = async (e) => {
    const arrayBuffer = e.target.result;
    // Copy the buffer BEFORE loadPDF — PDF.js may transfer (detach)
    // the original ArrayBuffer to its worker thread.
    const bufferCopy = arrayBuffer.slice(0);
    const success = await loadPDF(new Uint8Array(arrayBuffer), resumePage);
    // Only persist on success — a corrupted or password-protected PDF
    // must not be saved to IndexedDB, or the resume logic would
    // re-load a broken file on every app restart.
    if (success) {
      persistFile(file, bufferCopy);
    }
  };
  fr.readAsArrayBuffer(file);
}

// ============================================================
// PDF Loading
// ============================================================

/** @returns {Promise<boolean>} true if the PDF loaded successfully */
async function loadPDF(data, resumePage = 1) {
  try {
    if (pdfState.doc) await pdfState.doc.destroy();
    cleanup();

    // Keep the original bytes for iOS document recreation.
    // PDF.js may transfer the buffer, so we keep our own copy.
    pdfState.buffer = data.slice(0);
    pdfState.doc = await pdfjsLib.getDocument({ data }).promise;
    pdfState.largeDocConstrained = _isMemoryConstrained && pdfState.doc.numPages > LARGE_DOC_THRESHOLD;
    pdfState.darkOverride.clear();
    pdfState.alreadyDark.clear();
    pdfState.isScanned = false;
    pdfState.generation++;

    // Cancel all pending render and OCR jobs from previous document
    resetOcrState();
    renderPipeline.queue.length = 0;
    scrollState.isFast = false;
    renderPipeline.sinceReset = 0;
    renderPipeline.resetPending = false;

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
    pdfState.isScanned = await detectScannedDocument();

    await buildPageSlots();
    // Wait one frame for the browser to reflow the new spacer/pool DOM.
    // Without this, reconcileContainers() may see stale viewport dimensions
    // (especially after cleanup → rebuild when returning from reader).
    await new Promise(r => requestAnimationFrame(r));
    // Scroll to the target page (page 1 for new files, saved page for resume)
    // Restore dark mode overrides from previous session
    const savedOverrides = localStorage.getItem('veil-dark-overrides');
    if (savedOverrides) {
      try {
        const overrides = JSON.parse(savedOverrides);
        for (const [pageNum, mode] of Object.entries(overrides)) {
          pdfState.darkOverride.set(parseInt(pageNum, 10), mode);
        }
      } catch (e) { console.warn('[Session] Failed to parse dark overrides:', e); }
    }

    scrollToPage(resumePage, true);
    reconcileContainers();
    updateCurrentPageFromScroll();
    checkPresentationMode();
    updateZoomUI();
    announce(`Document loaded, ${pdfState.doc.numPages} pages`);
    return true;

  } catch (err) {
    console.error('Failed to load PDF:', err);
    // Release any PDF.js resources allocated before the failure
    if (pdfState.doc) {
      try { pdfState.doc.cleanup(); } catch (_) {}
    }
    if (err?.name === 'PasswordException') {
      showError('This PDF is password-protected. Please unlock it first.');
    } else if (err?.name === 'InvalidPDFException') {
      showError('This file does not appear to be a valid PDF.');
    } else {
      showError('Could not load this PDF. The file may be corrupted.');
    }
    return false;
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
  if (!pdfState.doc || pdfState.doc.numPages === 0) return false;

  // Pick sample pages spread across the document
  const numPages = pdfState.doc.numPages;
  const sampleIndices = new Set();
  sampleIndices.add(1); // first page always
  if (numPages >= 2) sampleIndices.add(numPages); // last
  if (numPages >= 4) sampleIndices.add(Math.floor(numPages * 0.25));
  if (numPages >= 6) sampleIndices.add(Math.floor(numPages * 0.5));
  if (numPages >= 8) sampleIndices.add(Math.floor(numPages * 0.75));

  const samplesToCheck = [...sampleIndices];
  const pageSamples = [];

  for (const pageNum of samplesToCheck) {
    const page = await pdfState.doc.getPage(pageNum);
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
  const state = pageNum != null ? pdfState.renderState.get(pageNum) : null;
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
  const state = pageNum != null ? pdfState.renderState.get(pageNum) : null;
  if (!state || !state.ocrInProgress) return;

  // Don't show the indicator if OCR started recently (< 500ms ago).
  // When Tesseract resources are SW-cached, OCR completes in 1-2s.
  // Flashing the indicator for sub-second OCR is distracting.
  if (state._ocrStartTime && (Date.now() - state._ocrStartTime) < 500) return;

  if (pdfState.isScanned) {
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
  if (pdfState.isScanned) {
    const container = el.closest('.page-container');
    if (!container) return;
    const pageNum = parseInt(container.dataset.pageNum, 10);
    const slot = pdfState.slots.get(pageNum);
    if (slot) cleanupOcrIndicators(slot);
    return;
  }

  // For native PDFs: only kill indicator if selection is inside an OCR image region
  const ocrRegion = el.closest('.ocr-image-region');
  if (!ocrRegion) return;

  const container = ocrRegion.closest('.page-container');
  if (!container) return;
  const pageNum = parseInt(container.dataset.pageNum, 10);
  const slot = pdfState.slots.get(pageNum);
  if (slot) cleanupOcrIndicators(slot);
});

// Force clean clipboard on copy. The text layer uses color:transparent
// on a dark background — without this, pasting into Word/Pages/Notion
// carries those invisible styles (black bg + transparent text).
// Setting both text/plain and text/html ensures every target app gets
// clean, unstyled content: LaTeX editors use plain, rich editors use HTML.
document.addEventListener('copy', (e) => {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString();
  if (!text) return;

  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const html = escaped.split('\n').join('<br>');

  e.clipboardData.setData('text/plain', text);
  e.clipboardData.setData('text/html', html);
  e.preventDefault();
});

// Listen for selection attempts on pages with pending OCR.
// On touch: require a long press (350ms hold without movement) to
// distinguish "trying to select text" from "scrolling past".
// On mouse/pen: trigger immediately (no ambiguity with scroll).
const OCR_PRESS_DELAY = 350; // ms — shorter than iOS native long press (500ms)
const OCR_PRESS_MOVE_TOLERANCE = 10; // px — finger jitter allowance

function triggerOcrIndicator(e) {
  const container = e.target.closest('.page-container');
  if (!container) return;

  const pageNum = parseInt(container.dataset.pageNum, 10);
  const slot = pdfState.slots.get(pageNum);
  const state = pdfState.renderState.get(pageNum);
  if (!slot || !state || !state.ocrInProgress) return;

  const rect = container.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  if (pdfState.isScanned) {
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
    uiState.ocrPressStartX = e.clientX;
    uiState.ocrPressStartY = e.clientY;
    if (uiState.ocrPressTimer) clearTimeout(uiState.ocrPressTimer);
    uiState.ocrPressTimer = setTimeout(() => {
      uiState.ocrPressTimer = null;
      triggerOcrIndicator(e);
    }, OCR_PRESS_DELAY);
  } else {
    // Mouse/pen: immediate
    triggerOcrIndicator(e);
  }
});

document.addEventListener('pointermove', (e) => {
  if (!uiState.ocrPressTimer || e.pointerType !== 'touch') return;
  const dx = e.clientX - uiState.ocrPressStartX;
  const dy = e.clientY - uiState.ocrPressStartY;
  if (dx * dx + dy * dy > OCR_PRESS_MOVE_TOLERANCE * OCR_PRESS_MOVE_TOLERANCE) {
    clearTimeout(uiState.ocrPressTimer);
    uiState.ocrPressTimer = null;
  }
}, { passive: true });

document.addEventListener('pointerup', () => {
  if (uiState.ocrPressTimer) {
    clearTimeout(uiState.ocrPressTimer);
    uiState.ocrPressTimer = null;
  }
});

document.addEventListener('pointercancel', () => {
  if (uiState.ocrPressTimer) {
    clearTimeout(uiState.ocrPressTimer);
    uiState.ocrPressTimer = null;
  }
});


// ============================================================
// Cleanup
// ============================================================

function cleanup() {
  viewport.innerHTML = '';
  pdfState.slots.clear();
  pdfState.renderState.clear();
  renderPipeline.pool.length = 0;
  pdfState.geometry = [null];
  renderPipeline.spacer = null;
}

// ============================================================
// Scale Calculation
// ============================================================

// Phone landscape: small screen held sideways. Toolbar hidden, fit-to-width.
function isPhoneLandscape() {
  return window.matchMedia('(pointer: coarse)').matches &&
    window.matchMedia('(orientation: landscape)').matches &&
    window.innerHeight < 500;
}

// Any touch device in landscape (phone + tablet). Fit-to-width for both.
function isTouchLandscape() {
  return window.matchMedia('(pointer: coarse)').matches &&
    window.matchMedia('(orientation: landscape)').matches;
}

function calculateScale(page) {
  const vp = page.getViewport({ scale: 1 });
  const sidePadding = _isMobileDevice ? 0 : 16;
  return _calculateScale(
    vp.width, vp.height,
    window.innerWidth, window.innerHeight,
    48, sidePadding, _isMobileDevice
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

const renderPipeline = {
  spacer: null,
  pool: [],
  queue: [],
  active: 0,
  sinceReset: 0,
  resetPending: false,
  resetting: false,
  debounceTimer: null,
  pendingSet: new Set(),
};

function createPoolContainer() {
  const container = document.createElement('div');
  container.className = 'page-container';
  container.style.position = 'absolute';
  container.style.left = '0';
  container.style.right = '0';
  container.style.margin = '0 auto';
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
  let state = pdfState.renderState.get(pageNum);
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
    pdfState.renderState.set(pageNum, state);
  }
  return state;
}

// Binary search: find first page whose bottom edge > viewTop
function binarySearchFirstVisible(viewTop) {
  let lo = 1, hi = pdfState.doc.numPages;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const pg = pdfState.geometry[mid];
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
  while (lastVisible < pdfState.doc.numPages &&
    pdfState.geometry[lastVisible + 1].offsetTop < viewBottom) {
    lastVisible++;
  }

  const buf = _isMemoryConstrained ? 1 : VIRTUAL_BUFFER;
  const rangeStart = Math.max(1, firstVisible - buf);
  const rangeEnd = Math.min(pdfState.doc.numPages, lastVisible + buf);

  return { firstVisible, lastVisible, rangeStart, rangeEnd };
}

function assignContainer(poolSlot, pageNum) {
  const geo = pdfState.geometry[pageNum];
  const el = poolSlot.element;

  el.style.top = geo.offsetTop + 'px';
  el.style.width = geo.cssWidth + 'px';
  el.style.height = geo.cssHeight + 'px';
  el.style.scrollSnapAlign = '';
  el.style.display = '';

  // On mobile with zoom >1x, center oversized pages with negative margin
  // so the middle of the PDF is visible (overflow-x is hidden on mobile)
  if (_isMobileDevice && geo.cssWidth > window.innerWidth) {
    const offset = (geo.cssWidth - window.innerWidth) / 2;
    el.style.marginLeft = -offset + 'px';
    el.style.marginRight = 'auto';
  } else {
    el.style.marginLeft = '0';
    el.style.marginRight = '0';
    el.style.margin = '0 auto';
  }
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

  // Hide canvases until the new render completes. Without this,
  // a recycled container briefly shows content from its previous
  // page assignment (wrong page flash) or appears without dark mode
  // (the class was removed during eviction). The render will set
  // visibility back to '' after painting + dark mode + overlay.
  poolSlot.mainCanvas.style.visibility = 'hidden';
  poolSlot.overlayCanvas.style.visibility = 'hidden';

  poolSlot.assignedPage = pageNum;
  pdfState.slots.set(pageNum, poolSlot);

  // Don't render immediately — schedule it. During scroll animation,
  // containers get repositioned at 60fps but PDF.js rendering only
  // starts when the scroll settles. Pre-rendered pages (already in
  // the pool) appear instantly; new ones show the placeholder until
  // the debounced render fires.
  scheduleRender(pageNum);
}

// Debounced render scheduler: accumulates pages that need rendering
// and fires them all at once when scrolling stops.

function scheduleRender(pageNum) {
  const state = getOrCreateRenderState(pageNum);
  if (state.rendered || state.rendering) return;
  renderPipeline.pendingSet.add(pageNum);
  clearTimeout(renderPipeline.debounceTimer);
  renderPipeline.debounceTimer = setTimeout(flushPendingRenders, 150);
}

function flushPendingRenders() {
  for (const pageNum of renderPipeline.pendingSet) {
    if (pdfState.slots.has(pageNum)) {
      enqueueRender(pageNum);
    }
  }
  renderPipeline.pendingSet.clear();
}

function evictContainer(poolSlot) {
  const pageNum = poolSlot.assignedPage;
  if (pageNum == null) return;

  // Cancel pending work
  cancelQueuedRender(pageNum);
  cancelOcrJobsForPage(pageNum);
  const state = pdfState.renderState.get(pageNum);
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
  if (_isMemoryConstrained && pdfState.doc && !renderPipeline.resetting) {
    pdfState.doc.getPage(pageNum).then(p => p.cleanup()).catch(() => {});
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
  pdfState.slots.delete(pageNum);
}

function reconcileContainers() {
  if (!pdfState.doc || pdfState.doc.numPages === 0) return;

  const { rangeStart, rangeEnd } = getVisiblePageRange();
  const needed = new Set();
  for (let p = rangeStart; p <= rangeEnd; p++) needed.add(p);

  // Release containers no longer in range
  for (const poolSlot of renderPipeline.pool) {
    if (poolSlot.assignedPage != null && !needed.has(poolSlot.assignedPage)) {
      evictContainer(poolSlot);
    }
  }

  // Assign free containers to newly-needed pages (closest to center first)
  const centerPage = Math.round((rangeStart + rangeEnd) / 2);
  const sorted = [...needed].filter(p => !pdfState.slots.has(p))
    .sort((a, b) => Math.abs(a - centerPage) - Math.abs(b - centerPage));

  for (const pageNum of sorted) {
    const free = renderPipeline.pool.find(s => s.assignedPage === null);
    if (!free) break; // pool exhausted
    assignContainer(free, pageNum);
  }
}

async function buildPageSlots() {
  if (!pdfState.doc) return;

  // Clear previous state
  viewport.innerHTML = '';
  pdfState.slots.clear();
  pdfState.renderState.clear();
  renderPipeline.pool.length = 0;
  pdfState.geometry = [null]; // index 0 unused (pages are 1-based)

  // Determine scale from first page
  const firstPage = await pdfState.doc.getPage(1);
  const scale = calculateScale(firstPage);
  pdfState.scale = scale;
  const zoomedScale = pdfState.renderScale;
  const dpr = getDpr();

  // Compute geometry for all pages.
  //
  // Most PDFs have uniform page sizes — we detect this by checking
  // a few sample pages and skip getPage() for the rest if all match.
  // Mixed-size PDFs (paper with landscape appendices, slides with
  // handout pages) measure every page individually.
  const firstVp = firstPage.getViewport({ scale: zoomedScale * dpr });
  const round = _isMobileDevice ? Math.round : Math.floor;
  const firstCssW = round(firstVp.width / dpr);
  const firstCssH = round(firstVp.height / dpr);

  // Sample up to 5 pages spread across the document to detect mixed sizes.
  // If all samples match page 1, assume uniform and skip the rest.
  let uniform = true;
  const numPages = pdfState.doc.numPages;

  if (numPages > 1) {
    const sampleIndices = new Set();
    sampleIndices.add(2);
    if (numPages >= 4) sampleIndices.add(Math.floor(numPages * 0.25));
    if (numPages >= 6) sampleIndices.add(Math.floor(numPages * 0.5));
    if (numPages >= 8) sampleIndices.add(Math.floor(numPages * 0.75));
    if (numPages >= 3) sampleIndices.add(numPages);

    for (const idx of sampleIndices) {
      const samplePage = await pdfState.doc.getPage(idx);
      const sampleVp = samplePage.getViewport({ scale: zoomedScale * dpr });
      const sW = round(sampleVp.width / dpr);
      const sH = round(sampleVp.height / dpr);
      if (sW !== firstCssW || sH !== firstCssH) {
        uniform = false;
        break;
      }
    }
  }

  // Build geometry table
  let offsetTop = VIEWPORT_PADDING_TOP;

  if (uniform) {
    // Fast path: all pages have the same dimensions
    for (let i = 1; i <= numPages; i++) {
      pdfState.geometry[i] = { cssWidth: firstCssW, cssHeight: firstCssH, offsetTop };
      offsetTop += firstCssH + PAGE_GAP;
    }
  } else {
    // Slow path: measure each page individually
    pdfState.geometry[1] = { cssWidth: firstCssW, cssHeight: firstCssH, offsetTop };
    offsetTop += firstCssH + PAGE_GAP;

    for (let i = 2; i <= numPages; i++) {
      const page = await pdfState.doc.getPage(i);
      const vp = page.getViewport({ scale: zoomedScale * dpr });
      const cssW = round(vp.width / dpr);
      const cssH = round(vp.height / dpr);
      pdfState.geometry[i] = { cssWidth: cssW, cssHeight: cssH, offsetTop };
      offsetTop += cssH + PAGE_GAP;
    }
  }

  // Total scroll height
  const totalHeight = pdfState.geometry[pdfState.doc.numPages].offsetTop +
    pdfState.geometry[pdfState.doc.numPages].cssHeight + 16; // bottom padding

  // Create spacer
  renderPipeline.spacer = document.createElement('div');
  renderPipeline.spacer.id = 'scroll-spacer';
  renderPipeline.spacer.style.position = 'relative';
  renderPipeline.spacer.style.width = '100%';
  renderPipeline.spacer.style.height = totalHeight + 'px';

  // Create container pool
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = createPoolContainer();
    renderPipeline.spacer.appendChild(slot.element);
    renderPipeline.pool.push(slot);
  }

  viewport.appendChild(renderPipeline.spacer);

  // Initial assignment
  reconcileContainers();
}

// ============================================================
// Device Detection & Memory Profiles
// ============================================================

const _isMobileDevice = window.matchMedia('(pointer: coarse)').matches;
const _isIOS = _isMobileDevice && (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
const _deviceMemoryGB = navigator.deviceMemory || 0;
const _isMemoryConstrained = _isIOS || (_isMobileDevice && (_deviceMemoryGB > 0 ? _deviceMemoryGB <= 4 : false));

const LARGE_DOC_THRESHOLD = 150;

function getDpr() {
  const raw = window.devicePixelRatio || 1;
  // Cap DPR on memory-constrained devices (iOS, budget Android).
  // With fit-to-width, canvases are larger — full 3x DPR exhausts
  // Jetsam memory budget especially on scanned docs.
  // Cap DPR on memory-constrained devices (iOS, budget Android).
  // With fit-to-width, canvases are larger — full 3x DPR exhausts
  // Jetsam memory budget especially on scanned docs.
  if (pdfState.largeDocConstrained) return Math.min(raw, 2);
  if (_isMemoryConstrained) return Math.min(raw, 2);
  return raw;
  return raw;
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

const scrollState = {
  isFast: false,
  lastTop: 0,
  lastTime: 0,
  velocityTimer: null,
  raf: 0,
  presentationMode: false,
  wheelAccum: 0,
  wheelTimer: null,
  willChangeTimer: null,
};
const SCROLL_FAST_THRESHOLD = 3000; // px/sec — above this, defer rendering

// --- Unified scroll coordinator ---
// Single scrollTop read per frame. Three separate listeners each called
// viewport.scrollTop independently — on Android budget devices each read
// can force a layout reflow (~2-5ms), totaling 6-15ms per frame wasted.
// Order matters: velocity MUST update before reconcile reads scrollState.isFast.
viewport.addEventListener('scroll', () => {
  const now = performance.now();
  const scrollTop = viewport.scrollTop; // single reflow

  // 0. will-change: promote containers during scroll, demote after 200ms idle.
  //    Permanent will-change wastes compositor memory for every pooled container
  //    even when the user is just reading. Lazy promotion keeps GPU layers only
  //    while they're actually being repositioned.
  if (!scrollState.willChangeTimer) {
    for (const slot of renderPipeline.pool) {
      if (slot.assignedPage != null) slot.element.style.willChange = 'transform';
    }
  }
  clearTimeout(scrollState.willChangeTimer);
  scrollState.willChangeTimer = setTimeout(() => {
    scrollState.willChangeTimer = null;
    for (const slot of renderPipeline.pool) {
      slot.element.style.willChange = '';
    }
  }, 200);

  // 1. Velocity detection (synchronous — reconcile reads isFast)
  const dt = now - scrollState.lastTime;
  if (dt > 0 && scrollState.lastTime > 0) {
    const dy = Math.abs(scrollTop - scrollState.lastTop);
    const velocity = (dy / dt) * 1000; // px/sec
    scrollState.isFast = velocity > SCROLL_FAST_THRESHOLD;
  }
  scrollState.lastTop = scrollTop;
  scrollState.lastTime = now;

  clearTimeout(scrollState.velocityTimer);
  scrollState.velocityTimer = setTimeout(() => {
    scrollState.isFast = false;
    flushRenderQueue();
  }, 150);

  // 2. Reconcile containers + update page indicator (rAF-throttled)
  if (!scrollState.raf) {
    scrollState.raf = requestAnimationFrame(() => {
      scrollState.raf = 0;
      reconcileContainers();
      updateCurrentPageFromScroll();
    });
  }

  // 3. Save page position (debounced 1s)
  if (pdfState.doc) {
    clearTimeout(uiState.savePageTimer);
    uiState.savePageTimer = setTimeout(savePagePosition, 1000);
  }
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


// ============================================================
// iOS PDF Engine Reset (Compartment Seal)
//
// PDF.js runs a web worker that accumulates internal state:
// parsed XRef tables, decoded font programs, stream decoder
// caches, shared objects. page.cleanup() releases per-page
// data; pdfState.doc.cleanup() releases some shared resources. But
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
  if (pdfState.largeDocConstrained) return 15;
  return 40;
}

// Safari's requestIdleCallback support is incomplete — use rAF + setTimeout
// as a reliable fallback that still defers to an idle moment.
const scheduleIdle = typeof requestIdleCallback === 'function'
  ? requestIdleCallback
  : (fn) => requestAnimationFrame(() => setTimeout(fn, 0));

async function resetPdfEngine() {
  if (!pdfState.doc || !pdfState.buffer || renderPipeline.resetting) return;

  renderPipeline.resetting = true;
  const gen = ++pdfState.generation;

  // Cancel in-flight work but preserve OCR cache — text data is tiny
  // and re-running Tesseract after every engine reset wastes CPU/battery.
  renderPipeline.queue.length = 0;
  resetOcrState(true);

  try {
    // Destroy the old instance (main thread + worker thread).
    // This releases ALL accumulated state.
    await pdfState.doc.destroy();

    // Recreate from the original buffer. PDF.js may transfer
    // ArrayBuffers internally, so we always pass a fresh copy.
    pdfState.doc = await pdfjsLib.getDocument({
      data: pdfState.buffer.slice(0),
    }).promise;

    renderPipeline.sinceReset = 0;
    renderPipeline.resetPending = false;

    // Stale check: if a new document was loaded during the await,
    // pdfState.generation will have changed — abandon this reset.
    if (pdfState.generation !== gen) return;

    // Re-trigger rendering for pages currently near the viewport.
    // Their canvases still have pixels — this is a no-op for
    // slot.rendered === true pages. Only evicted-then-revisited
    // pages will actually re-render.
    flushRenderQueue();
  } catch (err) {
    // If destroy/recreate fails (e.g., corrupt buffer), log but
    // don't crash — the old pdfState.doc is already destroyed, so we
    // can't recover. The user will need to re-open the file.
    console.warn('PDF engine reset failed:', err);
  } finally {
    renderPipeline.resetting = false;
  }
}

function maybeScheduleEngineReset() {
  if (!_isMemoryConstrained || !renderPipeline.resetPending || !pdfState.doc) return;
  if (renderPipeline.active > 0 || renderPipeline.resetting) return;

  scheduleIdle(() => {
    // Re-check after yielding to the event loop — a render
    // may have started, or a new document may have been loaded.
    if (!pdfState.doc || renderPipeline.active > 0 || renderPipeline.resetting || !renderPipeline.resetPending) return;
    resetPdfEngine();
  });
}

function enqueueRender(pageNum) {
  if (!pdfState.doc || pageNum < 1 || pageNum > pdfState.doc.numPages) return;
  if (!pdfState.slots.has(pageNum)) return; // page has no active container
  const state = getOrCreateRenderState(pageNum);
  if (state.rendered || state.rendering) return;

  // Don't duplicate
  if (renderPipeline.queue.includes(pageNum)) return;

  renderPipeline.queue.push(pageNum);
  processRenderQueue();
}

function processRenderQueue() {
  if (scrollState.isFast || renderPipeline.resetting) return; // wait for scroll to settle / engine reset

  while (renderPipeline.active < MAX_CONCURRENT_RENDERS && renderPipeline.queue.length > 0) {
    // Sort by distance from current visible page (closest first)
    const visPage = pdfState.currentPage || 1;
    renderPipeline.queue.sort((a, b) => Math.abs(a - visPage) - Math.abs(b - visPage));

    const pageNum = renderPipeline.queue.shift();
    const slot = pdfState.slots.get(pageNum);

    // Skip if already rendered, evicted, or stale.
    // State lives in renderState (per-page), not on the slot (per-container).
    const state = pdfState.renderState.get(pageNum);
    if (!slot || (state && (state.rendered || state.rendering))) continue;

    renderPipeline.active++;
    renderPageIfNeeded(pageNum).finally(() => {
      renderPipeline.active--;

      // Track memory pressure from accumulated renders.
      // On iOS, trigger a full engine reset every N pages to
      // prevent the PDF.js worker from accumulating fatal levels
      // of cached state (fonts, XRef, stream decoders).
      renderPipeline.sinceReset++;
      if (renderPipeline.sinceReset >= getEngineResetThreshold()) {
        renderPipeline.resetPending = true;
      }

      // If queue is empty and a reset is pending, this is the
      // quiet moment — schedule it before picking up more work.
      if (renderPipeline.active === 0 && renderPipeline.resetPending) {
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
  const idx = renderPipeline.queue.indexOf(pageNum);
  if (idx !== -1) renderPipeline.queue.splice(idx, 1);
}

// ============================================================
// Page Rendering
// ============================================================

async function renderPageIfNeeded(pageNum) {
  if (!pdfState.doc || pageNum < 1 || pageNum > pdfState.doc.numPages) return;

  const slot = pdfState.slots.get(pageNum);
  if (!slot) return;
  const state = getOrCreateRenderState(pageNum);
  if (state.rendered || state.rendering) return;

  state.rendering = true;
  const myGen = pdfState.generation;
  state.renderGeneration = myGen;
  let renderCanvas = null; // tracked for exception-safe pool return

  try {
    const page = await pdfState.doc.getPage(pageNum);
    if (pdfState.generation !== myGen) return;
    if (slot.assignedPage !== pageNum) return;

    const dpr = getDpr();
    const scaledViewport = page.getViewport({ scale: pdfState.renderScale * dpr });
    const w = Math.floor(scaledViewport.width);
    const h = Math.floor(scaledViewport.height);

    // Borrow a canvas from the pool instead of creating a new one.
    // This avoids thrashing iOS WebKit's lazy GC of GPU backing stores.
    // IMPORTANT: every exit path after this MUST return the canvas
    // via returnCanvas(). Without this, the pool shrinks on errors
    // or generation changes — exactly when memory is most critical.
    renderCanvas = borrowCanvas(w, h);

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
    if (!pdfState.isScanned) {
      parallelTasks.push(page.getTextContent());
    }

    const results = await Promise.all(parallelTasks);
    const opList = results[1];
    const textContent = pdfState.isScanned ? null : results[2];

    if (pdfState.generation !== myGen) { returnCanvas(renderCanvas); return; }
    if (slot.assignedPage !== pageNum) { returnCanvas(renderCanvas); return; }

    // --- Already-dark detection ---
    const isDark = detectAlreadyDark(renderCanvas);
    pdfState.alreadyDark.set(pageNum, isDark);

    // --- Extract image regions (skip if scanned document) ---
    const regions = pdfState.isScanned
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

    // Paint overlay canvas (only allocate backing store when page has image regions)
    if (regions.length > 0) {
      slot.overlayCanvas.width = w;
      slot.overlayCanvas.height = h;
      compositeImageRegions(slot.overlayCanvas.getContext('2d'), renderCanvas, regions, w, h);
    }

    // --- Text layer ---
    // scheduleTextLayer takes ownership of renderCanvas: the native path
    // returns it to the pool synchronously, the scanned path captures it
    // in the OCR job closure. Either way, we must NOT touch it after this.
    scheduleTextLayer(slot, state, pageNum, page, renderCanvas, textContent, scaledViewport, regions, w, h, dpr, myGen);
    renderCanvas = null; // ownership transferred — prevent double-return in catch

    // --- Link annotations ---
    try {
      const annotations = await page.getAnnotations();
      if (pdfState.generation !== myGen || slot.assignedPage !== pageNum) return;
      buildLinkLayer(slot.element, annotations, scaledViewport, dpr, pageNum);
    } catch (_) { 
      if (pdfState.generation !== myGen || slot.assignedPage !== pageNum) return;
    }

    state.rendered = true;
    state._renderTask = null;
    applyDarkModeToPage(pageNum);

    // Everything is ready — reveal both canvases in one compositing frame.
    slot.mainCanvas.style.visibility = '';
    slot.overlayCanvas.style.visibility = '';

    // On memory-constrained devices, release PDF.js internal caches.
    if (_isMemoryConstrained) page.cleanup();
  } catch (err) {
    // Return the canvas to the pool if it was borrowed before the error.
    // Without this, every failed render permanently shrinks the pool —
    // exactly when memory-constrained devices need it most.
    if (renderCanvas) { returnCanvas(renderCanvas); renderCanvas = null; }
    if (pdfState.generation !== myGen) return;
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
        // Combine with existing scaleX if present, instead of overwriting it
        const existingTransform = span.style.transform;
        span.style.transform = existingTransform
          ? `${existingTransform} rotate(${angle}rad)`
          : `rotate(${angle}rad)`;
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
      // Sanitize URL protocol — malicious PDFs can embed javascript: links
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) continue;
      } catch (_) { continue; }
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      // Accessible label: show host for http/https, full address for mailto
      try {
        const parsed = new URL(url);
        a.setAttribute('aria-label', parsed.protocol === 'mailto:'
          ? `Email ${parsed.pathname}`
          : `${parsed.hostname} (opens in new tab)`);
      } catch (_) {
        a.setAttribute('aria-label', 'External link (opens in new tab)');
      }
    } else if (dest) {
      a.href = '#';
      a.setAttribute('aria-label', `Internal link to page ${typeof dest === 'string' ? dest : ''}`);
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
  if (!pdfState.doc) return;

  try {
    let pageIndex;

    if (typeof dest === 'string') {
      // Named destination — resolve via PDF.js
      const resolved = await pdfState.doc.getDestination(dest);
      if (!resolved) return;
      pageIndex = await pdfState.doc.getPageIndex(resolved[0]);
    } else if (Array.isArray(dest) && dest.length > 0) {
      // Explicit destination — first element is page ref
      pageIndex = await pdfState.doc.getPageIndex(dest[0]);
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
  return _shouldApplyDark(pageNum, pdfState.darkOverride, pdfState.alreadyDark);
}

function applyDarkModeToPage(pageNum) {
  const slot = pdfState.slots.get(pageNum);
  if (!slot) return;
  const state = pdfState.renderState.get(pageNum);
  if (!state || !state.rendered) return;

  const dark = shouldApplyDark(pageNum);
  slot.mainCanvas.classList.toggle('dark-active', dark);
  slot.overlayCanvas.classList.toggle('overlay-visible', dark);
}

function applyDarkModeToAllPages() {
  for (const [pageNum] of pdfState.slots) {
    applyDarkModeToPage(pageNum);
  }
}

// ============================================================
// Current Page Tracking (from scroll position)
// ============================================================


function updateCurrentPageFromScroll() {
  if (!pdfState.doc || pdfState.geometry.length <= 1) return;

  // Find the page whose center is closest to the viewport center.
  // Uses the precomputed geometry table — pure math, no DOM queries.
  const viewCenter = viewport.scrollTop + viewport.clientHeight / 2;
  let closestPage = 1;
  let closestDist = Infinity;

  // Binary search for approximate location, then linear scan nearby
  const approx = binarySearchFirstVisible(viewport.scrollTop);
  const lo = Math.max(1, approx - 3);
  const hi = Math.min(pdfState.doc.numPages, approx + 5);
  for (let i = lo; i <= hi; i++) {
    const geo = pdfState.geometry[i];
    const pageCenter = geo.offsetTop + geo.cssHeight / 2;
    const dist = Math.abs(pageCenter - viewCenter);
    if (dist < closestDist) {
      closestDist = dist;
      closestPage = i;
    }
  }

  pdfState.currentPage = closestPage;
  updateNavigationUI();
  updateToggleButton();
}

// ============================================================
// Toggle Button State
// ============================================================

function updateToggleButton() {
  const dark = shouldApplyDark(pdfState.currentPage);
  iconDark.hidden = !dark;
  iconLight.hidden = dark;
  btnToggle.classList.toggle('toggle-active', dark);
  btnToggle.setAttribute('aria-pressed', dark ? 'true' : 'false');
}

function toggleDarkMode() {
  const pageNum = pdfState.currentPage;
  const currentlyDark = shouldApplyDark(pageNum);

  if (currentlyDark) {
    pdfState.darkOverride.set(pageNum, 'light');
  } else {
    pdfState.darkOverride.set(pageNum, 'dark');
  }

  applyDarkModeToPage(pageNum);
  updateToggleButton();
  announce(shouldApplyDark(pageNum) ? 'Dark mode enabled' : 'Dark mode disabled');
  // Persist immediately so the override survives app close
  savePagePosition();
}

// ============================================================
// Navigation
// ============================================================

function updateNavigationUI() {
  if (!pdfState.doc) return;
  pageInfo.textContent = `${pdfState.currentPage} / ${pdfState.doc.numPages}`;
  btnPrev.disabled = pdfState.currentPage <= 1;
  btnNext.disabled = pdfState.currentPage >= pdfState.doc.numPages;
}

// Click-to-edit page number: transforms the label into an input.
//
// On mobile, the virtual keyboard's "Go"/"Done" button fires blur
// BEFORE keydown Enter. If blur calls restore() (removing the input),
// the keydown never arrives and the navigation doesn't happen.
// Fix: commit on blur if the value changed, not just on Enter.
pageInfo.addEventListener('click', () => {
  if (!pdfState.doc) return;

  const current = pdfState.currentPage;
  const total = pdfState.doc.numPages;

  // Create inline input
  const input = document.createElement('input');
  input.id = 'page-input';
  input.type = 'text';
  input.inputMode = 'numeric';
  input.pattern = '[0-9]*';
  input.value = current;
  input.setAttribute('aria-label', `Go to page (1-${total})`);

  // Pause focus mode while editing — toolbar stays visible
  uiState.focusPaused = true;
  clearTimeout(uiState.focusTimer);
  uiState.focusTimer = null;

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
    uiState.focusPaused = false;
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
  if (!pdfState.doc || pdfState.geometry.length <= 1) return;
  const clamped = Math.max(1, Math.min(pageNum, pdfState.doc.numPages));
  const geo = pdfState.geometry[clamped];
  if (!geo) return;

  // Scroll so the page is centered in the viewport
  const target = geo.offsetTop - (viewport.clientHeight - geo.cssHeight) / 2;
  viewport.scrollTo({
    top: Math.max(0, target),
    behavior: (instant || _isMemoryConstrained) ? 'instant' : 'smooth',
  });
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

  const slot = pdfState.slots.get(pdfState.currentPage);
  const state = pdfState.renderState.get(pdfState.currentPage);
  if (!slot || !state || state.imageRegionsRaw.length === 0) return;
  if (slot.mainCanvas.width === 0) return;

  const vertLayer = slot.verticalOcrLayer;
  if (vertLayer.children.length > 0) return;

  const dpr = getDpr();
  const myGen = pdfState.generation;
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
dropZone.addEventListener('click', async (e) => {
  if (window.matchMedia('(pointer: coarse)').matches) return;
  if (e.target.closest('a') || e.target.closest('label')) return;

  // Desktop with File System Access API: use showOpenFilePicker
  // to get a file handle for session resume (zero-copy persistence).
  if (hasFileSystemAccess) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
      });
      const file = await handle.getFile();
      file._handle = handle; // attach handle for persistFile()
      handleFile(file);
    } catch (_) { /* user cancelled picker */ }
    return;
  }

  fileInput.click();
});

// Keyboard: Enter/Space opens file picker (accessibility)
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    if (e.target.closest('#resume-section') || e.target.closest('a') || e.target.closest('label')) return;
    e.preventDefault();
    dropZone.click();
  }
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');

  // Try to get a file handle from the drop (File System Access API).
  // This enables session resume from the original file path on desktop,
  // same as showOpenFilePicker(). Without this, dropped files fall back
  // to ArrayBuffer persistence (120MB limit).
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  if (item && item.getAsFileSystemHandle) {
    try {
      const handle = await item.getAsFileSystemHandle();
      if (handle && handle.kind === 'file') {
        const file = await handle.getFile();
        file._handle = handle;
        handleFile(file);
        return;
      }
    } catch (_) { /* fallback to regular file */ }
  }

  handleFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', () => {
  handleFile(fileInput.files[0]);
  fileInput.value = '';
});

// --- Toolbar ---
// "veil" logo: return to drop zone without reloading the page.
// Session is preserved — the resume button appears so the user
// can continue reading or open a new file.
btnHome.addEventListener('click', async (e) => {
  e.preventDefault();
  if (!pdfState.doc) return;

  // Save current page position before leaving
  savePagePosition();

  // Stop all rendering and OCR
  pdfState.generation++;
  renderPipeline.queue.length = 0;
  resetOcrState();

  // Destroy PDF.js instance to free memory
  if (pdfState.doc) { await pdfState.doc.destroy(); pdfState.doc = null; }
  pdfState.buffer = null;
  cleanup();

  // Hide reader, show drop zone with resume button
  readerEl.hidden = true;
  dropZone.hidden = false;
  dropZone.classList.remove('veil-opening');
  document.title = 'veil';

  // Show resume button if there's a saved session.
  // Force button mode (no auto-load) — the user explicitly chose
  // to leave the reader, so they should choose to resume.
  const savedFilename = localStorage.getItem('veil-filename');
  if (savedFilename) {
    restoreSession(true);
  }
});

btnPrev.addEventListener('click', () => scrollToPage(pdfState.currentPage - 1, true));
btnNext.addEventListener('click', () => scrollToPage(pdfState.currentPage + 1, true));
btnToggle.addEventListener('click', toggleDarkMode);
btnExport.addEventListener('click', exportDarkPdf);
exportCancelBtn.addEventListener('click', cancelExport);

// --- Keyboard ---
document.addEventListener('keydown', (e) => {
  if (!pdfState.doc) return;
  if (e.key === 'ArrowLeft') scrollToPage(pdfState.currentPage - 1, true);
  else if (e.key === 'ArrowRight') scrollToPage(pdfState.currentPage + 1, true);
  else if (e.key === 'd') toggleDarkMode();
});

// --- Presentation mode: page-by-page navigation ---
// When pages fill ≥85% of the viewport height (slides, presentations),
// continuous scroll produces jank on Chrome/Edge (GPU IPC churn on
// large canvas eviction). Instead, intercept wheel/trackpad and
// jump page-by-page — same pattern as Google Slides, PowerPoint Online.
// Normal documents (papers, books) keep continuous scroll.

const WHEEL_PAGE_THRESHOLD = 60; // accumulated delta before jumping

// ============================================================
// Zoom
// ============================================================

const btnZoomIn = document.getElementById('btn-zoom-in');
const btnZoomOut = document.getElementById('btn-zoom-out');
const zoomLevelEl = document.getElementById('zoom-level');

function updateZoomUI() {
  // Only disable zoom on phone landscape (short screens), not foldable/tablet landscape
  const isLandscapeTouch = isPhoneLandscape();
  const effectiveZoom = isLandscapeTouch ? 1 : pdfState.zoomMultiplier;
  const pct = Math.round(effectiveZoom * 100);
  if (zoomLevelEl) zoomLevelEl.textContent = `${pct}%`;
  if (btnZoomIn) btnZoomIn.disabled = isLandscapeTouch || pdfState.zoomMultiplier >= 3;
  if (btnZoomOut) btnZoomOut.disabled = isLandscapeTouch || pdfState.zoomMultiplier <= 0.5;
  // Toggle horizontal scroll when zoomed beyond viewport.
  // Desktop: scrollbar for horizontal panning.
  // Mobile: keep hidden + negative margin to center the oversized page.
  if (_isMobileDevice) {
    viewport.style.overflowX = 'hidden';
  } else {
    viewport.style.overflowX = pdfState.zoomMultiplier > 1 ? 'auto' : 'hidden';
  }
}

async function rebuildForZoom() {
  if (!pdfState.doc) return;
  const pageToRestore = pdfState.currentPage;
  pdfState.generation++;
  renderPipeline.queue.length = 0;
  resetOcrState();
  scrollState.isFast = false;
  renderPipeline.sinceReset = 0;
  renderPipeline.resetPending = false;
  await buildPageSlots();
  scrollToPage(pageToRestore, true);
  reconcileContainers();
  updateCurrentPageFromScroll();
  checkPresentationMode();
  updateZoomUI();
}

if (btnZoomIn) {
  btnZoomIn.addEventListener('click', () => {
    if (pdfState.zoomMultiplier >= 3) return;
    pdfState.zoomMultiplier = Math.min(3, pdfState.zoomMultiplier + 0.25);
    localStorage.setItem('veil-zoom', pdfState.zoomMultiplier);
    rebuildForZoom();
  });
}

if (btnZoomOut) {
  btnZoomOut.addEventListener('click', () => {
    if (pdfState.zoomMultiplier <= 0.5) return;
    pdfState.zoomMultiplier = Math.max(0.5, pdfState.zoomMultiplier - 0.25);
    localStorage.setItem('veil-zoom', pdfState.zoomMultiplier);
    rebuildForZoom();
  });
}

function checkPresentationMode() {
  if (!pdfState.doc || pdfState.geometry.length <= 1) {
    scrollState.presentationMode = false;
    return;
  }
  // Presentations have landscape pages (wider than tall).
  // Papers/books have portrait pages — keep normal scroll for those.
  // Disable presentation mode when zoomed — zoomed pages need free scroll
  if (pdfState.zoomMultiplier > 1) {
    scrollState.presentationMode = false;
    return;
  }
  const firstGeo = pdfState.geometry[1];
  scrollState.presentationMode = firstGeo.cssWidth > firstGeo.cssHeight;
}

viewport.addEventListener('wheel', (e) => {
  if (!scrollState.presentationMode || !pdfState.doc) return;

  e.preventDefault();

  // Accumulate delta to handle trackpad inertia (many small events)
  scrollState.wheelAccum += e.deltaY;

  clearTimeout(scrollState.wheelTimer);
  scrollState.wheelTimer = setTimeout(() => { scrollState.wheelAccum = 0; }, 200);

  if (Math.abs(scrollState.wheelAccum) >= WHEEL_PAGE_THRESHOLD) {
    const direction = scrollState.wheelAccum > 0 ? 1 : -1;
    scrollState.wheelAccum = 0;
    scrollToPage(pdfState.currentPage + direction, true);
  }
}, { passive: false });

// Scroll handling consolidated in the unified scroll coordinator above

let _lastResizeWidth = window.innerWidth;

// --- iOS Zoom Rotation Fix ---
// When the user zooms in portrait and rotates to landscape (or vice
// versa), Safari keeps its internal zoom level from the previous
// orientation. The layout recalculates for the new width, but Safari
// magnifies it with the stale zoom factor — breaking the layout
// completely (pages off-screen, navbar inaccessible).
//
// Fix: on orientation change, temporarily inject maximum-scale=1 into
// the viewport meta tag, forcing Safari to reset its zoom to 1x.
// After 300ms (during the native rotation animation), restore the
// original value to allow zooming again. On Android this is a no-op
// since Chrome resets zoom correctly on rotation.
if (/iPad|iPhone/.test(navigator.userAgent)) {
  const vpMeta = document.querySelector('meta[name="viewport"]');
  if (vpMeta) {
    const originalContent = vpMeta.getAttribute('content');
    window.addEventListener('resize', () => {
      // Only trigger on width changes (rotation), not height (keyboard/chrome UI)
      if (window.innerWidth === _lastResizeWidth) return;
      vpMeta.setAttribute('content', originalContent + ', maximum-scale=1');
      setTimeout(() => {
        vpMeta.setAttribute('content', originalContent);
      }, 350);
    });
  }
}

// --- Resize: rebuild all pages at new scale ---
// Only rebuild when the WIDTH changes. Height-only changes happen
// constantly on mobile (Android chrome UI hide/show, iOS address
// bar, virtual keyboard open/close) and don't affect the page
// scale (which is determined by width). Rebuilding on height-only
// changes causes scroll snap, DOM churn, and kills the page input.
window.addEventListener('resize', () => {
  clearTimeout(uiState.resizeTimer);
  uiState.resizeTimer = setTimeout(async () => {
    if (!pdfState.doc) return;
    if (window.innerWidth === _lastResizeWidth) return; // height-only change
    _lastResizeWidth = window.innerWidth;
    const pageToRestore = pdfState.currentPage;
    pdfState.generation++;
    // Cancel pending render and OCR — scale changed, coordinates are stale
    renderPipeline.queue.length = 0;
    resetOcrState();
    scrollState.isFast = false;
    renderPipeline.sinceReset = 0;
    renderPipeline.resetPending = false;
    await buildPageSlots();
    // Restore scroll position to the same page
    scrollToPage(pageToRestore, true);
    reconcileContainers();
    updateCurrentPageFromScroll();
    checkPresentationMode();
    updateZoomUI();

    // Mobile landscape: toolbar is completely hidden — pure reading.
    // Rotating back to portrait restores normal focus mode behavior.
    if (isPhoneLandscape()) {
      clearTimeout(uiState.focusTimer);
      enterFocusMode();
    } else {
      exitFocusMode();
    }
  }, 200);
});

// --- Allow dropping a new file onto the reader too ---
readerEl.addEventListener('dragover', (e) => e.preventDefault());
readerEl.addEventListener('drop', async (e) => {
  e.preventDefault();
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  if (item && item.getAsFileSystemHandle) {
    try {
      const handle = await item.getAsFileSystemHandle();
      if (handle && handle.kind === 'file') {
        const file = await handle.getFile();
        file._handle = handle;
        handleFile(file);
        return;
      }
    } catch (_) {}
  }
  handleFile(e.dataTransfer.files[0]);
});

// Initialize export module with app context
initExport({
  get pdfDoc() { return pdfState.doc; },
  get isScannedDocument() { return pdfState.isScanned; },
  get currentScale() { return pdfState.scale; },
  get pageDarkOverride() { return pdfState.darkOverride; },
  get originalFileName() { return pdfState.fileName; },
  supportsCtxFilter,
  DEPS,
  btnExport,
  exportProgressEl,
  exportProgressFill,
  exportProgressText,
  detectAlreadyDark,
  extractImageRegions,
  showError,
  announce,
  yieldToUI,
});

// Initialize OCR module with app context (read-only getters + function refs)
initOcr({
  get globalGeneration() { return pdfState.generation; },
  get currentVisiblePage() { return pdfState.currentPage; },
  get currentScale() { return pdfState.scale; },
  get isScannedDocument() { return pdfState.isScanned; },
  get pageSlots() { return pdfState.slots; },
  supportsCtxFilter,
  DEPS,
  createOffscreenCanvas,
  returnCanvas,
  buildTextLayer,
  ocrFinished,
});

// Attempt to restore the last reading session (PWA resume).
// If a saved PDF exists in IndexedDB or via File System handle,
// load it and scroll to the saved page. Otherwise, show the drop zone.
restoreSession().then((restored) => {
  if (!restored) {
    // No saved session — hide the loader (if visible), show drop zone
    const loader = document.getElementById('app-loader');
    if (loader) loader.hidden = true;
  }
  // Fade out the amber transition overlay (if present from landing page navigation)
  const transitionOverlay = document.getElementById('page-transition');
  if (transitionOverlay) {
    requestAnimationFrame(() => {
      transitionOverlay.classList.remove('active');
      // Remove from DOM after fade completes
      setTimeout(() => transitionOverlay.remove(), 600);
    });
  }
  // Signal that the app module has fully initialized (used by e2e tests)
  document.documentElement.dataset.appReady = 'true';
});
