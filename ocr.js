// ============================================================
// Veil — OCR Module
//
// All Tesseract.js integration: worker lifecycle, page OCR,
// image region OCR, text layer construction, job queue.
//
// Depends on an appContext object passed via initOcr() that
// provides read access to app state (globalGeneration, pageSlots,
// currentScale, etc.) without circular imports.
// ============================================================

import {
  OCR_CONFIDENCE_THRESHOLD,
  normalizeLigatures,
  isOcrArtifact,
  detectLanguageFromText,
  getNavigatorLanguage,
} from './core.js';

// ============================================================
// Constants
// ============================================================

const OCR_MIN_SCALE = 3;
const OCR_CONTRAST = 1.4;
const OCR_IMAGE_BUDGET = 4;
const OCR_IMAGE_MIN_SIZE = 100;

// ============================================================
// Module State
// ============================================================

let tesseractWorker = null;
let tesseractLoading = false;
const ocrCache = new Map();
const ocrFingerprints = new Map();
const ocrQueue = [];
let ocrProcessing = false;

// App context — set once via initOcr()
let ctx = null;

// ============================================================
// Initialization
// ============================================================

export function initOcr(appContext) {
  ctx = appContext;
}

// ============================================================
// Public API (called from app.js)
// ============================================================

export { ocrCache, ocrFingerprints, ocrQueue };

export function resetOcrState(preserveCache = false) {
  ocrQueue.forEach(j => { j.cancelled = true; });
  ocrQueue.length = 0;
  if (!preserveCache) {
    ocrCache.clear();
    ocrFingerprints.clear();
  }
}

export function enqueueOcrJob(job) {
  ocrQueue.push(job);
  processOcrQueue();
}

export function cancelOcrJobsForPage(pageNum) {
  for (const job of ocrQueue) {
    if (job.pageNum === pageNum) {
      job.cancelled = true;
    }
  }
}

// ============================================================
// Preprocessing
// ============================================================

export function preprocessCanvasForOcr(sourceCanvas) {
  const c = document.createElement('canvas');
  c.width = sourceCanvas.width;
  c.height = sourceCanvas.height;
  const ctxC = c.getContext('2d');

  if (ctx.supportsCtxFilter) {
    ctxC.filter = `grayscale(1) contrast(${OCR_CONTRAST})`;
    ctxC.drawImage(sourceCanvas, 0, 0);
  } else {
    ctxC.drawImage(sourceCanvas, 0, 0);
    const imgData = ctxC.getImageData(0, 0, c.width, c.height);
    const d = imgData.data;
    for (let i = 0; i < d.length; i += 4) {
      const grey = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
      const c1 = (grey - 128) * OCR_CONTRAST + 128;
      const v = Math.max(0, Math.min(255, c1));
      d[i] = d[i+1] = d[i+2] = v;
    }
    ctxC.putImageData(imgData, 0, 0);
  }
  return c;
}

// ============================================================
// Fingerprinting & Text Detection
// ============================================================

function fingerprint(canvas) {
  if (canvas.width < 8 || canvas.height < 8) return null;
  const fpCtx = canvas.getContext('2d', { willReadFrequently: true });
  const stepX = Math.floor(canvas.width / 8);
  const stepY = Math.floor(canvas.height / 8);
  let hash = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const d = fpCtx.getImageData(x * stepX, y * stepY, 1, 1).data;
      hash += ((d[0] >> 4) << 8 | (d[1] >> 4) << 4 | (d[2] >> 4)).toString(36);
    }
  }
  return hash;
}

function likelyContainsText(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  if (w < 50 || h < 50) return false;

  const ltCtx = canvas.getContext('2d', { willReadFrequently: true });
  const step = Math.max(4, Math.floor(Math.min(w, h) / 60));
  let edges = 0;
  let samples = 0;

  const data = ltCtx.getImageData(0, 0, w, h).data;
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

  return samples > 0 && (edges / samples) > 0.05;
}

function hasValidOcrWords(data) {
  return (data.words || []).some(
    w => w.text && w.text.trim() &&
         w.confidence >= OCR_CONFIDENCE_THRESHOLD &&
         !isOcrArtifact(w.text)
  );
}

// ============================================================
// Queue Processor
// ============================================================

async function processOcrQueue() {
  if (ocrProcessing) return;
  ocrProcessing = true;

  while (ocrQueue.length > 0) {
    const visPage = ctx.currentVisiblePage || 1;
    ocrQueue.sort((a, b) => {
      const da = Math.abs(a.pageNum - visPage);
      const db = Math.abs(b.pageNum - visPage);
      return da - db;
    });

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

// ============================================================
// Tesseract Worker
// ============================================================

export async function ensureTesseractWorker() {
  if (tesseractWorker) return tesseractWorker;
  if (tesseractLoading) {
    while (tesseractLoading) {
      await new Promise(r => setTimeout(r, 100));
    }
    return tesseractWorker;
  }

  tesseractLoading = true;
  try {
    const mod = await import(ctx.DEPS.TESSERACT);
    const createWorker = mod.createWorker || (mod.default && mod.default.createWorker);
    if (!createWorker) throw new Error('createWorker not found in Tesseract module');

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

// ============================================================
// Image Region OCR (Native PDFs)
// ============================================================

function rotateCanvas90CW(source) {
  const rotated = document.createElement('canvas');
  rotated.width = source.height;
  rotated.height = source.width;
  const rCtx = rotated.getContext('2d');
  rCtx.translate(rotated.width, 0);
  rCtx.rotate(Math.PI / 2);
  rCtx.drawImage(source, 0, 0);
  return rotated;
}

export async function ocrImageRegions(mainCanvas, textLayerDiv, _verticalLayerDiv, regions, dpr, myGen, pageNum) {
  if (regions.length === 0) return;

  const worker = await ensureTesseractWorker();
  if (!worker || ctx.globalGeneration !== myGen) return;

  for (const region of regions) {
    if (ctx.globalGeneration !== myGen) return;

    const sx = Math.max(0, region.x);
    const sy = Math.max(0, region.y);
    const sw = Math.min(region.width, mainCanvas.width - sx);
    const sh = Math.min(region.height, mainCanvas.height - sy);
    if (sw <= 0 || sh <= 0) continue;

    const regionCssX = sx / dpr;
    const regionCssY = sy / dpr;
    const regionCssW = sw / dpr;
    const regionCssH = sh / dpr;

    const cacheKey = `img-${pageNum}-${Math.round(sx)}-${Math.round(sy)}`;
    const cached = ocrCache.get(cacheKey);

    let data;
    if (cached) {
      data = cached;
    } else {
      const regionCanvas = document.createElement('canvas');
      regionCanvas.width = sw;
      regionCanvas.height = sh;
      regionCanvas.getContext('2d', { willReadFrequently: true }).drawImage(
        mainCanvas, sx, sy, sw, sh, 0, 0, sw, sh
      );

      const fp = fingerprint(regionCanvas);
      if (fp && ocrFingerprints.has(fp)) {
        regionCanvas.width = 0;
        continue;
      }

      if (!likelyContainsText(regionCanvas)) {
        regionCanvas.width = 0;
        if (fp) ocrFingerprints.set(fp, true);
        continue;
      }

      const processed0 = preprocessCanvasForOcr(regionCanvas);
      regionCanvas.width = 0;
      try {
        const result = await worker.recognize(processed0);
        data = result.data;
        processed0.width = 0;
        if (ctx.globalGeneration !== myGen) return;
        ocrCache.set(cacheKey, data);
        if (fp) ocrFingerprints.set(fp, true);
      } catch (err) {
        processed0.width = 0;
        if (ctx.globalGeneration !== myGen) return;
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

    if (ctx.globalGeneration !== myGen) return;
  }
}

export async function ocrImageVertical(mainCanvas, verticalLayerDiv, region, dpr, myGen) {
  const sx = Math.max(0, region.x);
  const sy = Math.max(0, region.y);
  const sw = Math.min(region.width, mainCanvas.width - sx);
  const sh = Math.min(region.height, mainCanvas.height - sy);
  if (sw <= 0 || sh <= 0) return;

  const regionCanvas = document.createElement('canvas');
  regionCanvas.width = sw;
  regionCanvas.height = sh;
  regionCanvas.getContext('2d', { willReadFrequently: true }).drawImage(
    mainCanvas, sx, sy, sw, sh, 0, 0, sw, sh
  );

  const rotated = rotateCanvas90CW(regionCanvas);
  regionCanvas.width = 0;

  const worker = await ensureTesseractWorker();
  if (!worker || ctx.globalGeneration !== myGen) { rotated.width = 0; return; }

  const processed90 = preprocessCanvasForOcr(rotated);
  rotated.width = 0;

  try {
    const { data } = await worker.recognize(processed90);
    processed90.width = 0;
    if (ctx.globalGeneration !== myGen) return;

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
  } catch (e) {
    console.warn('[OCR] Vertical pass failed:', e);
    processed90.width = 0;
  }
}

// ============================================================
// OCR Text Layer Builder
// ============================================================

export function buildOcrTextLayerDirect(container, ocrData, canvasW, canvasH, cssW, cssH) {
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

  let actualDomBottom = 0;
  let logicalReservedBottom = 0;

  for (const line of linesToProcess) {
    const words = (line.words || [])
      .filter(w => w.text && w.text.trim() && w.confidence >= OCR_CONFIDENCE_THRESHOLD && !isOcrArtifact(w.text));

    if (words.length === 0) continue;

    words.sort((a, b) => a.bbox.x0 - b.bbox.x0);

    const wordHeights = words.map(w => (w.bbox.y1 - w.bbox.y0) * scaleY);
    wordHeights.sort((a, b) => a - b);
    const medianHeight = wordHeights[Math.floor(wordHeights.length / 2)];
    const fontSize = medianHeight * 0.85;

    if (fontSize < 1) continue;

    let baselineY;
    if (line.baseline && line.baseline.y0 != null) {
      baselineY = ((line.baseline.y0 + line.baseline.y1) / 2) * scaleY;
    } else {
      const medianY0 = words.reduce((s, w) => s + w.bbox.y0, 0) / words.length;
      baselineY = (medianY0 * scaleY) + medianHeight * 0.78;
    }

    const lineTop = baselineY - fontSize;

    const lineDiv = document.createElement('div');
    lineDiv.className = 'text-line';
    lineDiv.style.fontSize = fontSize + 'px';

    const targetTop = Math.max(logicalReservedBottom, lineTop);

    const margin = targetTop - actualDomBottom;
    lineDiv.style.marginTop = margin + 'px';

    lineDiv.style.height = fontSize + 'px';

    actualDomBottom = targetTop + fontSize;
    logicalReservedBottom = targetTop + medianHeight;

    measureCtx.font = `${fontSize}px sans-serif`;

    let prevWordEnd = 0;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const wordText = normalizeLigatures(word.text);

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

      const wordLeft = word.bbox.x0 * scaleX;
      const wordMargin = wordLeft - prevWordEnd;
      if (Math.abs(wordMargin) > 0.5) {
        span.style.marginLeft = wordMargin + 'px';
      }

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

      prevWordEnd = wordLeft + wordWidth;

      lineDiv.appendChild(span);
    }

    fragment.appendChild(lineDiv);
  }

  container.appendChild(fragment);
}

// ============================================================
// Text Layer Scheduling (bridge between rendering and OCR)
// ============================================================

export function scheduleTextLayer(slot, state, pageNum, page, renderCanvas, textContent, scaledViewport, regions, w, h, dpr, myGen) {
  const cssW = Math.floor(w / dpr);
  const cssH = Math.floor(h / dpr);

  if (ctx.isScannedDocument) {
    const cacheKey = `page-${pageNum}`;
    const cached = ocrCache.get(cacheKey);
    if (cached) {
      // Cache hit — renderCanvas not needed, return it to the pool
      ctx.returnCanvas(renderCanvas);
      buildOcrTextLayerDirect(
        slot.textLayer, cached, cached._canvasW, cached._canvasH, cssW, cssH
      );
    } else {
      state.ocrInProgress = true;
      state._ocrStartTime = Date.now();
      const effectiveScale = ctx.currentScale * dpr;

      enqueueOcrJob({
        id: cacheKey,
        pageNum,
        cancelled: false,
        execute: async () => {
          if (ctx.globalGeneration !== myGen) { ctx.returnCanvas(renderCanvas); return; }

          let ocrCanvas;
          let ocrCanvasIsBorrowed = false;
          if (effectiveScale >= OCR_MIN_SCALE) {
            ocrCanvas = renderCanvas;
            ocrCanvasIsBorrowed = true; // this IS the pool canvas
          } else {
            // Scale too low for OCR — return the borrowed canvas to the pool
            // and create a dedicated high-res canvas for Tesseract.
            ctx.returnCanvas(renderCanvas);
            const ocrViewport = page.getViewport({ scale: OCR_MIN_SCALE });
            ocrCanvas = ctx.createOffscreenCanvas(
              Math.floor(ocrViewport.width),
              Math.floor(ocrViewport.height)
            );
            await page.render({
              canvasContext: ocrCanvas.getContext('2d'),
              viewport: ocrViewport,
            }).promise;
            if (ctx.globalGeneration !== myGen) { ocrCanvas.width = 0; return; }
          }

          const worker = await ensureTesseractWorker();
          if (!worker || ctx.globalGeneration !== myGen) {
            if (ocrCanvasIsBorrowed) ctx.returnCanvas(ocrCanvas);
            else ocrCanvas.width = 0;
            return;
          }

          const processed = preprocessCanvasForOcr(ocrCanvas);
          if (ocrCanvasIsBorrowed) ctx.returnCanvas(ocrCanvas);
          else ocrCanvas.width = 0;

          const { data } = await worker.recognize(processed);
          if (ctx.globalGeneration !== myGen) { processed.width = 0; return; }

          data._canvasW = processed.width;
          data._canvasH = processed.height;
          ocrCache.set(cacheKey, data);

          const currentSlot = ctx.pageSlots.get(pageNum);
          if (currentSlot) {
            buildOcrTextLayerDirect(
              currentSlot.textLayer, data, processed.width, processed.height, cssW, cssH
            );
            ctx.ocrFinished(currentSlot);
          }
        },
      });
    }
    return;
  }

  // Native PDF: build text layer from PDF.js textContent
  ctx.buildTextLayer(slot.textLayer, textContent, scaledViewport, dpr);
  ctx.returnCanvas(renderCanvas);

  // OCR on images within native PDFs
  if (regions.length > 0) {
    const candidates = regions
      .filter(r => r.width >= OCR_IMAGE_MIN_SIZE && r.height >= OCR_IMAGE_MIN_SIZE)
      .sort((a, b) => (b.width * b.height) - (a.width * a.height));

    state.imageRegionsRaw = candidates.map(r => ({ ...r }));
    state.imageRegionsCss = candidates.map(r => ({
      x: Math.max(0, r.x) / dpr,
      y: Math.max(0, r.y) / dpr,
      w: Math.min(r.width, w - Math.max(0, r.x)) / dpr,
      h: Math.min(r.height, h - Math.max(0, r.y)) / dpr,
    }));

    const autoOcr = candidates.slice(0, OCR_IMAGE_BUDGET);
    if (autoOcr.length > 0) {
      state.ocrInProgress = true;
      state._ocrStartTime = Date.now();

      enqueueOcrJob({
        id: `img-${pageNum}`,
        pageNum,
        cancelled: false,
        execute: async () => {
          const currentSlot = ctx.pageSlots.get(pageNum);
          if (!currentSlot) return;
          await ocrImageRegions(
            currentSlot.mainCanvas, currentSlot.textLayer, currentSlot.verticalOcrLayer,
            autoOcr.map(r => ({ ...r })), dpr, myGen, pageNum
          );
          ctx.ocrFinished(currentSlot);
        },
      });
    }
  }
}
