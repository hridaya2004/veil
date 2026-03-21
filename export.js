// ============================================================
// Veil — Export Module
//
// Renders each page with dark mode, composites original images,
// embeds invisible text layer, and assembles a new PDF via pdf-lib.
//
// Depends on an exportContext object passed via initExport() for
// app state access without circular imports.
// ============================================================

import {
  OCR_CONFIDENCE_THRESHOLD,
  normalizeLigatures,
  isOcrArtifact,
  compositeImageRegions,
  getNavigatorLanguage,
} from './core.js';

import { preprocessCanvasForOcr } from './ocr.js';

// ============================================================
// Module State
// ============================================================

let pdfLibModule = null;
let fontkitModule = null;
let cachedFontBytes = null;
let exporting = false;
let exportGeneration = 0;

let ctx = null;

// ============================================================
// Initialization
// ============================================================

export function initExport(exportContext) {
  ctx = exportContext;
}

// ============================================================
// Public API
// ============================================================

export function cancelExport() {
  exportGeneration++;
  hideExportProgress();
  exporting = false;
  ctx.btnExport.disabled = false;
}

export { exportGeneration };

// ============================================================
// Lazy Loaders
// ============================================================

async function ensurePdfLib() {
  if (pdfLibModule) return pdfLibModule;
  pdfLibModule = await import(ctx.DEPS.PDF_LIB);
  return pdfLibModule;
}

async function ensureUnicodeFont() {
  if (!fontkitModule) {
    try {
      const mod = await import(ctx.DEPS.FONTKIT);
      fontkitModule = mod.default || mod;
    } catch (e) {
      console.warn('Failed to load fontkit:', e);
      return null;
    }
  }

  if (!cachedFontBytes) {
    try {
      const resp = await fetch(ctx.DEPS.NOTO_SANS);
      if (!resp.ok) throw new Error(`Font fetch ${resp.status}`);
      cachedFontBytes = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      console.warn('Failed to load Unicode font:', e);
      return null;
    }
  }

  return { fontkit: fontkitModule, fontBytes: cachedFontBytes };
}

// ============================================================
// Progress UI
// ============================================================

function showExportProgress(current, total) {
  ctx.exportProgressEl.hidden = false;
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  ctx.exportProgressFill.style.width = pct + '%';
  ctx.exportProgressText.textContent = `${current} / ${total}`;
}

export function hideExportProgress() {
  ctx.exportProgressEl.hidden = true;
  ctx.exportProgressFill.style.width = '0%';
}

// ============================================================
// iOS Export Warning
// ============================================================

const IOS_SCANNED_EXPORT_WARN = 150;

function showIosExportWarning(pageCount) {
  return new Promise(resolve => {
    ctx.iosWarnText.innerHTML =
      `<strong>This PDF has ${pageCount} scanned pages.</strong><br>` +
      `iOS browsers limit memory for long OCR exports.<br>` +
      `For best results, use a desktop browser.`;
    ctx.iosWarnEl.hidden = false;

    ctx.exitFocusMode();
    ctx.focusPaused = true;

    function cleanup() {
      ctx.iosWarnEl.hidden = true;
      ctx.focusPaused = false;
      ctx.resetFocusTimer();
      ctx.iosWarnTry.removeEventListener('click', onTry);
      ctx.iosWarnCancel.removeEventListener('click', onCancel);
    }
    function onTry() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }

    ctx.iosWarnTry.addEventListener('click', onTry);
    ctx.iosWarnCancel.addEventListener('click', onCancel);
  });
}

// ============================================================
// Link Annotations
// ============================================================

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
        const actionDict = context.obj({
          Type: 'Action',
          S: 'URI',
          URI: PDFString.of(url),
        });
        annotDict.set(PDFName.of('A'), context.register(actionDict));
      } else if (dest) {
        let explicitDest = null;

        try {
          if (typeof dest === 'string') {
            explicitDest = await ctx.pdfDoc.getDestination(dest);
          } else if (Array.isArray(dest) && dest.length > 0) {
            explicitDest = dest;
          }
        } catch (e) {
          console.warn('[LinkExport] Failed to resolve dest:', dest, e);
          continue;
        }

        if (!explicitDest || !Array.isArray(explicitDest) || explicitDest.length === 0) {
          continue;
        }

        try {
          const pageIndex = await ctx.pdfDoc.getPageIndex(explicitDest[0]);

          if (pageIndex >= outPdf.getPageCount()) continue;

          const targetPageRef = outPdf.getPage(pageIndex).ref;

          const destValues = [targetPageRef];

          for (let d = 1; d < explicitDest.length; d++) {
            const v = explicitDest[d];

            if (v === null || v === undefined) {
              destValues.push(context.obj(null));
            } else if (typeof v === 'object' && v.name) {
              destValues.push(PDFName.of(v.name));
            } else if (typeof v === 'string') {
              const name = v.startsWith('/') ? v.slice(1) : v;
              destValues.push(PDFName.of(name));
            } else if (typeof v === 'number') {
              destValues.push(context.obj(v));
            } else {
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

// ============================================================
// Per-Page Export
// ============================================================

async function exportPage(pageNum, outPdf, font, exportWorker, exportScale, renderCanvas, finalCanvas, deferredAnnotations, myExportGen, totalPages) {
  const page = await ctx.pdfDoc.getPage(pageNum);
  const origVp = page.getViewport({ scale: 1 });
  const renderVp = page.getViewport({ scale: exportScale });
  const w = Math.floor(renderVp.width);
  const h = Math.floor(renderVp.height);

  renderCanvas.width = w;
  renderCanvas.height = h;
  finalCanvas.width = w;
  finalCanvas.height = h;

  const tasks = [
    page.render({
      canvasContext: renderCanvas.getContext('2d'),
      viewport: renderVp,
    }).promise,
    page.getOperatorList(),
    page.getAnnotations(),
  ];
  if (!ctx.isScannedDocument) {
    tasks.push(page.getTextContent());
  }

  const results = await Promise.all(tasks);
  if (exportGeneration !== myExportGen) return;

  const opList = results[1];
  const annotations = results[2];
  const textContent = ctx.isScannedDocument ? null : results[3];

  const isDarkBg = ctx.detectAlreadyDark(renderCanvas);
  const override = ctx.pageDarkOverride.get(pageNum);
  let applyDark;
  if (override === 'dark') applyDark = true;
  else if (override === 'light') applyDark = false;
  else applyDark = !isDarkBg;

  const fCtx = finalCanvas.getContext('2d');

  if (applyDark) {
    if (ctx.supportsCtxFilter) {
      fCtx.filter = 'invert(0.86) hue-rotate(180deg)';
      fCtx.drawImage(renderCanvas, 0, 0);
      fCtx.filter = 'none';
    } else {
      fCtx.drawImage(renderCanvas, 0, 0);
      const imgData = fCtx.getImageData(0, 0, w, h);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i]   + 0.86 * (255 - 2 * d[i]);
        let g = d[i+1] + 0.86 * (255 - 2 * d[i+1]);
        let b = d[i+2] + 0.86 * (255 - 2 * d[i+2]);
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = 2 * lum - r;
        g = 2 * lum - g;
        b = 2 * lum - b;
        d[i]   = Math.max(0, Math.min(255, r));
        d[i+1] = Math.max(0, Math.min(255, g));
        d[i+2] = Math.max(0, Math.min(255, b));
      }
      fCtx.putImageData(imgData, 0, 0);
    }

    if (!ctx.isScannedDocument) {
      const regions = ctx.extractImageRegions(opList, renderVp.transform);
      if (regions.length > 0) {
        compositeImageRegions(fCtx, renderCanvas, regions, w, h);
      }
    }
  } else {
    fCtx.drawImage(renderCanvas, 0, 0);
  }

  const jpegBlob = await new Promise(r =>
    finalCanvas.toBlob(r, 'image/jpeg', 0.85)
  );
  let jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());

  const jpegImage = await outPdf.embedJpg(jpegBytes);
  jpegBytes = null; // pdf-lib copied the bytes internally
  const outPage = outPdf.addPage([origVp.width, origVp.height]);
  outPage.drawImage(jpegImage, {
    x: 0,
    y: 0,
    width: origVp.width,
    height: origVp.height,
  });

  if (textContent) {
    for (const item of textContent.items) {
      if (!item.str || !item.str.trim()) continue;
      const itemText = normalizeLigatures(item.str);
      const tx = item.transform;
      const baseFontSize = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
      if (baseFontSize < 1) continue;

      try {
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
      } catch (_) {}
    }

  } else if (ctx.isScannedDocument && exportWorker) {
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

  if (annotations.length > 0) {
    deferredAnnotations.push({ outPage, annotations });
  }

  page.cleanup();
  renderCanvas.getContext('2d').clearRect(0, 0, w, h);
  finalCanvas.getContext('2d').clearRect(0, 0, w, h);

  if (exportGeneration === myExportGen) {
    showExportProgress(pageNum, totalPages);
  }

  if (pageNum % 5 === 0) {
    await new Promise(r => setTimeout(r, 100));
  } else {
    await ctx.yieldToUI();
  }
}

// ============================================================
// Main Export Orchestrator
// ============================================================

export async function exportDarkPdf() {
  if (!ctx.pdfDoc || exporting) return;

  if (ctx.isIOS && ctx.isScannedDocument && ctx.pdfDoc.numPages > IOS_SCANNED_EXPORT_WARN) {
    const proceed = await showIosExportWarning(ctx.pdfDoc.numPages);
    if (!proceed) return;
  }

  exporting = true;
  const myExportGen = ++exportGeneration;
  ctx.btnExport.disabled = true;

  try {
    const { PDFDocument, StandardFonts } = await ensurePdfLib();

    let outPdf = await PDFDocument.create();

    let font;
    const fontResources = await ensureUnicodeFont();
    if (fontResources) {
      try {
        outPdf.registerFontkit(fontResources.fontkit);
        font = await outPdf.embedFont(fontResources.fontBytes, { subset: true });
      } catch (e) {
        console.warn('[Export] Failed to embed Unicode font, falling back to Helvetica:', e);
        font = await outPdf.embedFont(StandardFonts.Helvetica);
      }
    } else {
      font = await outPdf.embedFont(StandardFonts.Helvetica);
    }

    const totalPages = ctx.pdfDoc.numPages;

    const isMobile = window.matchMedia('(pointer: coarse)').matches;
    const minExportScale = isMobile ? 2 : 3;
    const exportScale = Math.max(ctx.currentScale * 2, minExportScale);

    showExportProgress(0, totalPages);
    const deferredAnnotations = [];

    let exportWorker = null;
    if (ctx.isScannedDocument) {
      try {
        const mod = await import(ctx.DEPS.TESSERACT);
        const createWorker = mod.createWorker || (mod.default && mod.default.createWorker);
        const navLang = getNavigatorLanguage();
        const langs = navLang ? 'eng+' + navLang : 'eng';
        exportWorker = await createWorker(langs, 1, { logger: () => {} });
      } catch (err) {
        console.warn('[Export] Failed to create OCR worker:', err);
      }
    }

    const renderCanvas = document.createElement('canvas');
    const finalCanvas = document.createElement('canvas');

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      if (exportGeneration !== myExportGen) break;
      await exportPage(pageNum, outPdf, font, exportWorker, exportScale, renderCanvas, finalCanvas, deferredAnnotations, myExportGen, totalPages);
    }

    renderCanvas.width = 0;
    finalCanvas.width = 0;

    if (exportGeneration !== myExportGen) {
      if (exportWorker) exportWorker.terminate().catch(() => {});
      return;
    }

    if (exportWorker) {
      await exportWorker.terminate();
    }

    for (const { outPage, annotations } of deferredAnnotations) {
      await embedLinkAnnotations(outPdf, outPage, annotations);
    }
    deferredAnnotations.length = 0; // release annotation refs before heavy save()

    outPdf.setProducer('veil (https://veil.simoneamico.com)');
    outPdf.setCreator('veil');
    let pdfBytes = await outPdf.save();
    hideExportProgress();

    const filename = `${ctx.originalFileName}-dark.pdf`;
    let blob = new Blob([pdfBytes], { type: 'application/pdf' });
    pdfBytes = null;
    outPdf = null; // release ~300MB of embedded JPEGs and page dictionaries

    if (navigator.share && ctx.isIOS) {
      try {
        const file = new File([blob], filename, { type: 'application/pdf' });
        blob = null;
        await navigator.share({ files: [file] });
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('Share failed:', e);
      }
    } else {
      const url = URL.createObjectURL(blob);
      blob = null;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    ctx.announce('Export complete');

  } catch (err) {
    console.error('Export failed:', err);
    hideExportProgress();
    if (exportGeneration === myExportGen) ctx.showError('Export failed. Please try again.');
  } finally {
    exporting = false;
    ctx.btnExport.disabled = false;
  }
}
