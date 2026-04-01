/* DESIGN
   ------
   * This file exports the dark mode PDF. The user drops a PDF, reads it
   * in dark mode, and downloads a new PDF with dark mode baked in.
   * The exported file works in any PDF reader on any device.
   *
   * The approach is a "sandwich PDF": each page is rasterized as a JPEG
   * image (the visible dark mode rendering), with an invisible text layer
   * on top (opacity: 0) so the text remains selectable and searchable.
   * This is the same technique used by professional document scanners.
   *
   * Key decisions:
   *
   * - JPEG at quality 0.85: I chose lossy compression because lossless
   *   (PNG) would produce files 4-5x larger. At 0.85, artifacts are
   *   invisible to the naked eye during normal reading. The trade-off
   *   is that vector text becomes raster, so extreme zoom shows pixels.
   *
   * - Multi-script fonts: the invisible text layer needs fonts that
   *   cover the document's writing system. Noto Sans Regular handles
   *   Latin, Greek, Cyrillic and math symbols. For Arabic, Hebrew, CJK,
   *   Indic and 18 other scripts, I lazy-load the matching Noto Sans
   *   variant from CDN with fontkit for subsetting. detectScript() in
   *   core.js identifies the script per text item. Each font is
   *   downloaded once and cached across exports. Latin-only documents
   *   never trigger any extra download. If a font download fails, the
   *   item falls back silently to Noto Sans Regular.
   *
   * - Width matching: the invisible text in Noto Sans has different
   *   character widths than the original font in the PDF. Without
   *   correction, selecting text in the exported PDF would overshoot
   *   or undershoot. I measure the natural width and adjust the fontSize
   *   so the selection aligns with the visible text in the image.
   *
   * - Link preservation: PDF link annotations (URLs, internal navigation)
   *   are extracted from the original and re-embedded in the exported file
   *   with the same protocol whitelist (http, https, mailto only).
   *   Internal links are deferred until all pages exist in the new PDF,
   *   because page 1 might link to page 50 which hasn't been created yet.
   *
   * - Memory management: each page's JPEG bytes are nulled after
   *   embedding, the outPdf reference is nulled after save(), and
   *   every 5 pages I pause for 100ms to let the browser's GC (garbage
   *   collector) clean up released memory. These techniques were
   *   originally developed for iOS (where the system memory manager,
   *   Jetsam, kills browser tabs that exceed ~300MB), but they benefit
   *   every platform: without them, each successive export gets slower
   *   as the heap fills up with unreleased data from the previous run.
   *   This is a curb cut effect: like sidewalk ramps designed for
   *   wheelchairs that end up helping everyone with strollers, bikes,
   *   and luggage, optimizations born from iOS constraints improve
   *   the experience on every device.
   *
   * - Canvas recycling: two canvases (renderCanvas and finalCanvas) are
   *   created once and reused for every page instead of allocating new
   *   ones per page. This avoids 400+ GPU context allocations on long
   *   documents. Same curb cut: born from iOS, valuable everywhere.
   *
   * - Export generation counter: prevents race conditions when the user
   *   cancels and immediately re-exports. Each export captures its own
   *   generation number and checks it before every async step.
   *
   * The module communicates with app.js through a context object (ctx)
   * passed via initExport(). This avoids circular imports.
   *
   * The file follows this flow:
   *
   * 1. MODULE STATE (line 89)
   * 2. INITIALIZATION AND PUBLIC API (line 139)
   * 3. LAZY LOADERS (line 163)
   * 4. PROGRESS UI (line 246)
   * 5. LINK ANNOTATIONS (line 261)
   * 6. PER-PAGE EXPORT (line 385)
   * 7. MAIN EXPORT ORCHESTRATOR (line 607)
*/

import {
  OCR_CONFIDENCE_THRESHOLD,
  normalizeLigatures,
  isOcrArtifact,
  compositeImageRegions,
  getNavigatorLanguage,
  detectScript,
} from './core.js';

import { preprocessCanvasForOcr } from './ocr.js';


// --- MODULE STATE ---

let pdfLibModule = null;     // pdf-lib module (lazy-loaded on first export)
let fontkitModule = null;    // fontkit for Unicode font embedding (lazy-loaded)
let cachedFontBytes = null;  // Noto Sans Regular TTF bytes (downloaded once, reused)
let exporting = false;
let exportGeneration = 0;    // increments on every export/cancel, never decreases

/*
 * Multi-script font registry. The export needs different Noto Sans
 * variants for different writing systems (Arabic text needs Noto Sans
 * Arabic, Chinese needs Noto Sans SC, etc.). Each font is downloaded
 * once and cached in fontBytesCache, then embedded once per export
 * into fontRegistry. Latin-only documents never trigger any download.
 *
 * The map keys match the script names returned by detectScript() in
 * core.js. The values are DEPS keys in app.js. Scripts not listed
 * here fall through to the latin font (Noto Sans Regular)
 */
const SCRIPT_FONT_MAP = {
  arabic:     'NOTO_SANS_ARABIC',
  hebrew:     'NOTO_SANS_HEBREW',
  devanagari: 'NOTO_SANS_DEVANAGARI',
  bengali:    'NOTO_SANS_BENGALI',
  gurmukhi:   'NOTO_SANS_GURMUKHI',
  gujarati:   'NOTO_SANS_GUJARATI',
  tamil:      'NOTO_SANS_TAMIL',
  telugu:     'NOTO_SANS_TELUGU',
  kannada:    'NOTO_SANS_KANNADA',
  malayalam:  'NOTO_SANS_MALAYALAM',
  sinhala:    'NOTO_SANS_SINHALA',
  thai:       'NOTO_SANS_THAI',
  lao:        'NOTO_SANS_LAO',
  tibetan:    'NOTO_SANS_TIBETAN',
  myanmar:    'NOTO_SANS_MYANMAR',
  georgian:   'NOTO_SANS_GEORGIAN',
  armenian:   'NOTO_SANS_ARMENIAN',
  ethiopic:   'NOTO_SANS_ETHIOPIC',
  khmer:      'NOTO_SANS_KHMER',
  japanese:   'NOTO_SANS_JP',
  korean:     'NOTO_SANS_KR',
  cjk:        'NOTO_SANS_SC',
};

const fontBytesCache = {};   // { arabic: Uint8Array, ... } persists across exports
const fontRegistry = {};     // { arabic: PDFFont, ... } reset per export (tied to outPdf)

let ctx = null;


// --- INITIALIZATION AND PUBLIC API ---

export function initExport(exportContext) {
  ctx = exportContext;
}

/*
 * Cancellation feels instant even though the export can't actually
 * stop mid-render. The UI hides the progress bar and re-enables the
 * button immediately. Behind the scenes, the running export continues
 * until it reaches its next generation check and discovers the
 * mismatch. The user perceives a fast, responsive cancel while the
 * system quietly finishes its current step and exits
 */
export function cancelExport() {
  exportGeneration++;
  hideExportProgress();
  exporting = false;
  ctx.btnExport.disabled = false;
}

export { exportGeneration };


// --- LAZY LOADERS ---

// Both pdf-lib and fontkit are loaded from CDN only when the user
// clicks export for the first time. This keeps the initial page
// load fast (zero export code downloaded until needed)

async function ensurePdfLib() {
  if (pdfLibModule) return pdfLibModule;
  pdfLibModule = await import(ctx.DEPS.PDF_LIB);
  return pdfLibModule;
}

// Loads fontkit (font parser) and Noto Sans (Unicode font).
// See DESIGN block for why both are needed
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

/*
 * Returns the correct font for a given script. On the first call for
 * each script, downloads the font from CDN and embeds it in the PDF.
 * Subsequent calls for the same script return the cached PDFFont.
 *
 * The font bytes are cached across exports (fontBytesCache) so a
 * second export of the same document skips the download entirely.
 * The PDFFont objects (fontRegistry) are reset per export because
 * they are tied to a specific PDFDocument instance.
 *
 * Latin falls through to the main Noto Sans Regular font passed as
 * latinFont. Scripts without a DEPS entry also fall through
 */
async function getFontForScript(script, outPdf, latinFont) {
  if (script === 'latin' || !SCRIPT_FONT_MAP[script]) return latinFont;
  if (fontRegistry[script]) return fontRegistry[script];

  const depKey = SCRIPT_FONT_MAP[script];
  const url = ctx.DEPS[depKey];
  if (!url) return latinFont;

  // Download font bytes (once per script, cached across exports)
  if (!fontBytesCache[script]) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Font fetch ${resp.status}`);
      fontBytesCache[script] = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      console.warn(`[Export] Failed to load font for ${script}:`, e);
      return latinFont;
    }
  }

  // Embed in this PDF (once per script per export)
  try {
    fontRegistry[script] = await outPdf.embedFont(fontBytesCache[script], { subset: true });
    return fontRegistry[script];
  } catch (e) {
    console.warn(`[Export] Failed to embed font for ${script}:`, e);
    return latinFont;
  }
}


// --- PROGRESS UI ---

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


// --- LINK ANNOTATIONS ---

/*
 * Re-embeds link annotations from the original PDF into the exported one.
 * External links (URLs) get an action dictionary with the sanitized URI.
 * Internal links (page navigation) need special handling: the destination
 * page might not exist yet when the source page is processed (page 1
 * linking to page 50), so all annotations are collected during the page
 * loop and embedded at the end when all pages exist.
 *
 * I use pdf-lib's low-level API here because the friendly high-level
 * methods (page.drawText, page.drawImage) don't support link annotations.
 * The low-level API builds PDF objects manually: PDFName for keywords
 * like /Link and /URI, PDFString for text values, and context.obj()
 * to create dictionaries that get written directly into the PDF file
 */
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
        // Sanitize URL protocol, same whitelist as the viewer.
        // Without this, a malicious PDF could export javascript: URIs
        // that the viewer correctly blocks but the exported PDF wouldn't.
        try {
          const parsed = new URL(url);
          if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) continue;
        } catch (_) { continue; }

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


// --- PER-PAGE EXPORT ---

/*
 * Processes a single page: render to canvas, apply dark mode inversion,
 * composite original images back, convert to JPEG, embed in pdf-lib,
 * add invisible text layer, collect link annotations.
 *
 * The dark mode application mirrors the browser exactly: ctx.filter
 * 'invert(0.86) hue-rotate(180deg)' on browsers that support it,
 * manual pixel manipulation on Safari where ctx.filter doesn't work.
 * This means the exported PDF looks identical to what the user sees
 * in the viewer.
 *
 * For scanned documents, OCR runs during export with a dedicated
 * Tesseract worker (separate from the viewer's worker). The recognized
 * text is embedded as invisible text positioned over each word
 */
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
        // Manual invert(0.86) + hue-rotate(180deg) for Safari.
        // Step 1: invert by 86% (not 100%, which would be harsh)
        let r = d[i]   + 0.86 * (255 - 2 * d[i]);
        let g = d[i+1] + 0.86 * (255 - 2 * d[i+1]);
        let b = d[i+2] + 0.86 * (255 - 2 * d[i+2]);
        // Step 2: hue-rotate 180deg by negating chroma around luminance
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

      // Select the font that covers this item's writing system.
      // Arabic text gets Noto Sans Arabic, Chinese gets Noto Sans SC,
      // Latin stays on Noto Sans Regular. The font is downloaded once
      // per script and cached for subsequent items and exports
      const script = detectScript(itemText);
      const itemFont = await getFontForScript(script, outPdf, font);

      try {
        // Width matching: the invisible text may use a different font
        // than the original PDF. I adjust the fontSize so the rendered
        // width matches, making the selection align with the visible
        // text in the JPEG image underneath
        let drawSize = baseFontSize;
        if (item.width > 0) {
          const naturalWidth = itemFont.widthOfTextAtSize(itemText, baseFontSize);
          if (naturalWidth > 0) {
            drawSize = baseFontSize * (item.width / naturalWidth);
          }
        }

        outPage.drawText(itemText, {
          x: tx[4],
          y: tx[5],
          size: drawSize,
          font: itemFont,
          opacity: 0, // invisible text, only for selection and search
        });
      } catch (_) {} // skip characters not in the font's encoding
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
        // 0.85 compensates for Tesseract's bbox padding (see ocr.js)
        const baseFontSize = (word.bbox.y1 - word.bbox.y0) * sy * 0.85;
        if (baseFontSize < 1) continue;

        const script = detectScript(wordText);
        const wordFont = await getFontForScript(script, outPdf, font);

        try {
          const targetWidth = (word.bbox.x1 - word.bbox.x0) * sx;
          let drawSize = baseFontSize;
          if (targetWidth > 0) {
            const naturalWidth = wordFont.widthOfTextAtSize(wordText, baseFontSize);
            if (naturalWidth > 0) {
              drawSize = baseFontSize * (targetWidth / naturalWidth);
            }
          }

          outPage.drawText(wordText, {
            x: word.bbox.x0 * sx,
            y: origVp.height - word.bbox.y1 * sy,
            size: drawSize,
            font: wordFont,
            opacity: 0,
          });
        } catch (_) {}
      }
    }
  }

  // Defer link annotations until all pages exist (see DESIGN block)
  if (annotations.length > 0) {
    deferredAnnotations.push({ outPage, annotations });
  }

  // Release per-page resources. page.cleanup() frees PDF.js internal
  // caches (decoded images, font programs). clearRect releases the
  // canvas pixel data while keeping the element for reuse next page
  page.cleanup();
  renderCanvas.getContext('2d').clearRect(0, 0, w, h);
  finalCanvas.getContext('2d').clearRect(0, 0, w, h);

  if (exportGeneration === myExportGen) {
    showExportProgress(pageNum, totalPages);
  }

  // Every 5 pages, I pause for 100ms to let the browser's garbage
  // collector clean up the JPEG bytes and canvas data I've released.
  // On other pages, I yield via MessageChannel (faster, but only gives
  // the browser a micro-instant). Without these periodic pauses,
  // each successive export gets slower as unreleased memory accumulates
  if (pageNum % 5 === 0) {
    await new Promise(r => setTimeout(r, 100));
  } else {
    await ctx.yieldToUI();
  }
}


// --- MAIN EXPORT ORCHESTRATOR ---

/*
 * The entry point for export. Creates a new PDF, processes every page
 * sequentially (parallel would spike memory), embeds all deferred link
 * annotations at the end, and triggers the download.
 *
 * For scanned documents, a dedicated Tesseract worker is created for
 * the export (separate from the viewer's worker) so the viewer's OCR
 * isn't disrupted. This worker uses the user's language from
 * navigator.languages, same as the viewer
 */
export async function exportDarkPdf() {
  if (!ctx.pdfDoc || exporting) return;

  exporting = true;
  const myExportGen = ++exportGeneration;
  ctx.btnExport.disabled = true;

  try {
    const { PDFDocument, StandardFonts } = await ensurePdfLib();

    let outPdf = await PDFDocument.create();

    // Try Noto Sans (Unicode coverage) first, fall back to Helvetica
    // (256 chars only). The fallback is silent because the text is
    // invisible anyway, just missing some special characters
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

    // Export at higher resolution than the display for sharper text.
    // Desktop renders at 3x (216 DPI). The mobile path exists as a
    // safety net but the export button is currently hidden on mobile
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
    deferredAnnotations.length = 0; // release refs before the heavy save() call

    outPdf.setProducer('veil (https://veil.simoneamico.com)');
    outPdf.setCreator('veil');
    let pdfBytes = await outPdf.save();
    hideExportProgress();

    // Reset per-export font registry. The PDFFont objects are tied to
    // this specific outPdf instance and can't be reused. The font bytes
    // stay in fontBytesCache for the next export
    for (const key of Object.keys(fontRegistry)) delete fontRegistry[key];

    // Aggressive memory release: a 200-page export accumulates ~300MB
    // of embedded JPEGs inside pdf-lib. Without nulling these references,
    // the GC can't collect them and the next export would start with a
    // dirty heap, getting progressively slower
    const filename = `${ctx.originalFileName}-dark.pdf`;
    let blob = new Blob([pdfBytes], { type: 'application/pdf' });
    pdfBytes = null;
    outPdf = null;

    const url = URL.createObjectURL(blob);
    blob = null;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // createObjectURL reserves the PDF bytes in RAM. revokeObjectURL
    // tells the browser it can free that memory. If I revoked immediately
    // after a.click(), the browser might not have started copying to disk
    // yet and the save would fail. If I never revoked, the memory would
    // stay occupied until the tab closes. 5 seconds is more than enough
    // for a RAM-to-disk copy, then the memory is released
    setTimeout(() => URL.revokeObjectURL(url), 5000);
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