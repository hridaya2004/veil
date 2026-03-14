// ============================================================
// Smart Dark PDF Reader - Core Module
//
// Pure and testable functions extracted from app.js.
// No global state, no DOM element references.
// Can be imported by both browser (app.js) and Node (Vitest).
// ============================================================

// ============================================================
// Constants
// ============================================================

export const IDENTITY_MATRIX = [1, 0, 0, 1, 0, 0];
export const DARK_LUMINANCE_THRESHOLD = 0.4;
export const SCAN_IMAGE_COVERAGE_THRESHOLD = 0.85;
export const SCAN_TEXT_CHAR_THRESHOLD = 50;
export const OCR_CONFIDENCE_THRESHOLD = 45;
export const OCR_HEIGHT_CLAMP_FACTOR = 3;
export const OCR_GAP_OUTLIER_FACTOR = 5;

// ============================================================
// OCR TextContent Filtering
// ============================================================

/**
 * Filters textContent items to remove those that would poison the
 * flow layout in buildTextLayer.
 *
 * The problem ("Phantom Clamp Theorem"): in a flow layout with
 * paddingTop = max(0, lt - prevBottom), the total DOM advancement
 * for any item is always `y1_scaled` regardless of its height.
 * Clamping heights is mathematically futile — it just redistributes
 * between padding and content, but the sum is invariant.
 *
 * The only effective fix: REMOVE items whose Y positions would
 * create unreasonable gaps in the flow. An item is considered a
 * flow-breaker if the gap it would create is > OCR_GAP_OUTLIER_FACTOR
 * times the median gap of the page.
 *
 * This is a geometric filter (not textual): it doesn't look at
 * word content, only at vertical positioning relative to neighbors.
 *
 * @param {Array} items - textContent.items from PDF.js (each with
 *   .transform [a,b,c,d,e,f], .str, .width)
 * @param {Function} transformFn - pdfjsLib.Util.transform
 * @param {Array} viewportTransform - viewport.transform matrix
 * @param {number} dpr - device pixel ratio
 * @returns {Object} filtered { items: [...] }
 */
export function filterFlowBreakingItems(items, transformFn, viewportTransform, dpr) {
  if (items.length <= 2) return { items: [...items] };

  // Compute screen-space top and height for each item
  const measured = items.map((item, idx) => {
    const tx = transformFn(viewportTransform, item.transform);
    const fontHeight = Math.sqrt(tx[2] * tx[2] + tx[3] * tx[3]);
    const fontSize = fontHeight / dpr;
    const top = tx[5] / dpr;
    return { idx, top, height: fontSize, item };
  });

  // Sort by Y (top) for flow simulation
  measured.sort((a, b) => a.top - b.top);

  // Compute gaps between consecutive items
  const gaps = [];
  for (let i = 1; i < measured.length; i++) {
    const gap = measured[i].top - (measured[i - 1].top + measured[i - 1].height);
    gaps.push(Math.max(0, gap));
  }

  if (gaps.length === 0) return { items: [...items] };

  // Compute median gap (robust to outliers)
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];

  // Threshold: gaps larger than this are considered flow-breakers
  // Use at least 50px as minimum threshold to avoid filtering
  // normal paragraph spacing in documents with tight line spacing
  const maxGap = Math.max(50, medianGap * OCR_GAP_OUTLIER_FACTOR);

  // Simulate flow layout and identify items that create toxic gaps.
  // An item is a flow-breaker if it creates a gap > maxGap AND
  // the NEXT item after it would also create a large gap (meaning
  // the item is isolated — not part of a text block).
  const keepIndices = new Set();

  // First pass: identify items that create large gaps
  const gapBefore = new Array(measured.length).fill(0);
  const gapAfter = new Array(measured.length).fill(0);

  for (let i = 0; i < measured.length; i++) {
    if (i > 0) {
      gapBefore[i] = Math.max(0, measured[i].top - (measured[i - 1].top + measured[i - 1].height));
    }
    if (i < measured.length - 1) {
      gapAfter[i] = Math.max(0, measured[i + 1].top - (measured[i].top + measured[i].height));
    }
  }

  for (let i = 0; i < measured.length; i++) {
    // Keep the item unless it's an isolated outlier:
    // large gap BEFORE it AND large gap AFTER it
    // (meaning it's not part of any text block).
    //
    // First and last items are always kept — they're likely
    // headers, footers, or page numbers (large gap on only one side).
    // Only middle items can be identified as isolated.
    if (i === 0 || i === measured.length - 1) {
      keepIndices.add(measured[i].idx);
      continue;
    }

    const isIsolated = gapBefore[i] > maxGap && gapAfter[i] > maxGap;

    if (isIsolated) {
      continue;
    }
    keepIndices.add(measured[i].idx);
  }

  // If we'd filter too aggressively (>50% removed), keep everything
  if (keepIndices.size < items.length * 0.5) {
    return { items: [...items] };
  }

  return { items: items.filter((_, idx) => keepIndices.has(idx)) };
}

// ============================================================
// OCR Word Sanitization
// ============================================================

/**
 * Sanitizes OCR word bounding boxes to prevent "prevBottom poisoning"
 * in flow-based text layer layout.
 *
 * The problem: Tesseract sometimes returns bounding boxes with
 * abnormally tall heights (e.g. a `|` classified as 400px tall).
 * In a flow layout that uses paddingTop = max(0, lineTop - prevBottom),
 * a single tall item advances prevBottom far ahead, causing all
 * subsequent lines to collapse with zero padding or accumulate
 * massive offsets. The error cascades through the entire page.
 *
 * The fix: clamp bounding box heights to OCR_HEIGHT_CLAMP_FACTOR
 * times the median height of all words on the page. This is:
 *   - Geometric (not textual): doesn't look at word content
 *   - Median-based: robust to outliers
 *   - Conservative: clamps heights, never removes words
 *   - Safe for edge cases: page numbers, footnotes, headers
 *     all have normal bbox heights — only anomalous items are affected
 *
 * Also sorts words by Y coordinate for correct top-to-bottom flow.
 *
 * @param {Array} words - Tesseract word objects with .bbox, .text, .confidence
 * @param {number} confidenceThreshold - minimum confidence to keep
 * @returns {Array} sanitized words (new array, does not mutate input)
 */
export function sanitizeOcrWords(words, confidenceThreshold) {
  // Filter by confidence and validity
  const valid = words.filter(w =>
    w.text && w.text.trim() &&
    w.confidence >= confidenceThreshold &&
    (w.bbox.y1 - w.bbox.y0) >= 2 &&
    (w.bbox.x1 - w.bbox.x0) >= 2
  );

  if (valid.length === 0) return [];

  // Compute median bbox height (robust to outliers)
  const heights = valid.map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)];
  const maxHeight = medianHeight * OCR_HEIGHT_CLAMP_FACTOR;

  // Clamp anomalous heights and sort by Y
  const sanitized = valid.map(w => {
    const bboxH = w.bbox.y1 - w.bbox.y0;
    if (bboxH <= maxHeight) return w;

    // Clamp: keep the top of the bbox, shrink the bottom
    return {
      ...w,
      bbox: {
        ...w.bbox,
        y1: w.bbox.y0 + maxHeight,
      },
    };
  });

  // Sort by Y coordinate for correct top-to-bottom flow order
  sanitized.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);

  return sanitized;
}

// ============================================================
// Matrix Utilities
// ============================================================

export function multiplyMatrices(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function transformPoint(matrix, x, y) {
  return [
    matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5],
  ];
}

export function computeImageBounds(ctm, viewportTransform) {
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
// Image Region Extraction
//
// Walks a PDF.js operator list and tracks the CTM stack to
// find all raster image positions on the page.
//
// `opsMap` must provide numeric codes for:
//   save, restore, transform, paintFormXObjectBegin,
//   paintFormXObjectEnd, paintImageXObject,
//   paintInlineImageXObject, paintImageXObjectRepeat
// ============================================================

export function extractImageRegions(opList, viewportTransform, opsMap) {
  const regions = [];
  const ctmStack = [];
  let ctm = [...IDENTITY_MATRIX];

  const fnArray = opList.fnArray;
  const argsArray = opList.argsArray;

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const args = argsArray[i];

    if (op === opsMap.save) {
      ctmStack.push([...ctm]);
    } else if (op === opsMap.restore) {
      ctm = ctmStack.pop() || [...IDENTITY_MATRIX];
    } else if (op === opsMap.transform) {
      ctm = multiplyMatrices(ctm, args);
    } else if (op === opsMap.paintFormXObjectBegin) {
      ctmStack.push([...ctm]);
      if (args[0]) {
        ctm = multiplyMatrices(ctm, args[0]);
      }
    } else if (op === opsMap.paintFormXObjectEnd) {
      ctm = ctmStack.pop() || [...IDENTITY_MATRIX];
    } else if (op === opsMap.paintImageXObject || op === opsMap.paintInlineImageXObject) {
      regions.push(computeImageBounds(ctm, viewportTransform));
    } else if (op === opsMap.paintImageXObjectRepeat) {
      if (args.length > 3) {
        for (let j = 3; j < args.length; j += 2) {
          const repeatCtm = multiplyMatrices(ctm, [1, 0, 0, 1, args[j], args[j + 1]]);
          regions.push(computeImageBounds(repeatCtm, viewportTransform));
        }
      } else {
        regions.push(computeImageBounds(ctm, viewportTransform));
      }
    }
  }

  return regions;
}

// ============================================================
// Overlay Composition
// ============================================================

export function compositeImageRegions(ctx, sourceCanvas, regions, canvasW, canvasH) {
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
// Already-Dark Detection
//
// Accepts raw pixel data (Uint8ClampedArray from getImageData)
// and canvas dimensions. Returns true if the page background
// is already dark (luminance below threshold).
// ============================================================

export function detectAlreadyDark(pixelData, width, height) {
  const samplePoints = [];
  const margin = Math.max(5, Math.floor(Math.min(width, height) * 0.02));
  const step = Math.max(1, Math.floor(Math.min(width, height) * 0.05));

  // Corners
  samplePoints.push(
    [margin, margin], [width - margin, margin],
    [margin, height - margin], [width - margin, height - margin],
  );

  // Edges
  for (let x = margin; x < width - margin; x += step) {
    samplePoints.push([x, margin], [x, height - margin]);
  }
  for (let y = margin; y < height - margin; y += step) {
    samplePoints.push([margin, y], [width - margin, y]);
  }

  let totalLuminance = 0;
  let count = 0;

  for (const [sx, sy] of samplePoints) {
    const idx = (sy * width + sx) * 4;
    if (idx + 2 >= pixelData.length) continue;
    const luminance = (0.299 * pixelData[idx] + 0.587 * pixelData[idx + 1] + 0.114 * pixelData[idx + 2]) / 255;
    totalLuminance += luminance;
    count++;
  }

  const avgLuminance = count > 0 ? totalLuminance / count : 1;
  return avgLuminance < DARK_LUMINANCE_THRESHOLD;
}

// ============================================================
// Dark Mode State Resolution
// ============================================================

export function shouldApplyDark(pageNum, pageDarkOverride, pageAlreadyDark) {
  const override = pageDarkOverride.get(pageNum);
  if (override === 'dark') return true;
  if (override === 'light') return false;
  if (pageAlreadyDark.get(pageNum)) return false;
  return true;
}

// ============================================================
// Text Normalization
// ============================================================

/**
 * Normalizes a string using NFKD (Compatibility Decomposition) to
 * decompose typographic ligatures into their constituent characters.
 *
 * Examples:  ﬁ (U+FB01) → fi,  ﬂ (U+FB02) → fl,  ﬀ (U+FB00) → ff
 *
 * This is safe for all text — strings without ligatures pass through
 * unchanged. NFKD also decomposes other compatibility characters
 * (e.g. superscripts, fractions) which improves copy/paste fidelity.
 */
export function normalizeLigatures(str) {
  if (!str) return str;
  return str.normalize('NFKD');
}

// ============================================================
// Punctuation Merging
// ============================================================

/**
 * Merges trailing punctuation items into the preceding word.
 *
 * In many PDFs, punctuation marks (., !, ?, ;, :, etc.) are
 * emitted as separate text items with tiny bounding boxes (3-4px).
 * This makes them nearly impossible to select with the mouse.
 *
 * This function scans a line (array of items sorted left-to-right)
 * and merges any item that consists solely of trailing punctuation
 * into the previous item, extending its width to cover both.
 *
 * Items at position 0 (line start) are never merged — punctuation
 * at the start of a line is unusual and may be intentional (e.g.
 * bullet points, opening quotes).
 *
 * Each item must have at least: { str, left, width }
 * Items may also have: { pdfWidth } (used in native text layer)
 *
 * Returns a new array (does not mutate the input).
 */
const TRAILING_PUNCT_RE = /^[.!?,;:)\]}"'»›\u2019\u201D]+$/;

export function mergePunctuation(line) {
  if (line.length <= 1) return line.map(item => ({ ...item }));

  const merged = [];

  for (let i = 0; i < line.length; i++) {
    const item = line[i];

    // Check if this item is purely trailing punctuation and
    // there is a preceding item to merge into
    if (i > 0 && item.str && TRAILING_PUNCT_RE.test(item.str)) {
      const prev = merged[merged.length - 1];
      if (prev) {
        // Extend the previous item to cover this punctuation
        const newWidth = (item.left + item.width) - prev.left;
        const newItem = {
          ...prev,
          str: prev.str + item.str,
          width: newWidth,
        };
        // Also update pdfWidth if present (native text layer)
        if ('pdfWidth' in prev) {
          newItem.pdfWidth = newWidth;
        }
        merged[merged.length - 1] = newItem;
        continue;
      }
    }

    merged.push({ ...item });
  }

  return merged;
}

// ============================================================
// Text Layer Utilities
//
// Shared logic for grouping text items into lines and
// determining word boundary spacing.
// ============================================================

/**
 * Groups an array of items (each with `top` and `height`)
 * into lines based on vertical proximity. Items whose `top`
 * differs by less than 50% of the current line height are
 * considered part of the same line.
 *
 * Returns array of arrays (each sub-array is a line).
 * Items are pre-sorted by top then left.
 */
export function groupItemsIntoLines(items) {
  if (items.length === 0) return [];

  const sorted = [...items].sort((a, b) => a.top - b.top || a.left - b.left);

  const lines = [];
  let currentLine = [sorted[0]];
  let lineTop = sorted[0].top;
  let lineHeight = sorted[0].height;

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
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

  return lines;
}

/**
 * Determines whether a TextNode space should be inserted
 * between two adjacent text items at a style boundary.
 *
 * Returns { insertSpace: boolean, adjustedGap: number }
 *
 * Three scenarios (Antigravity fix):
 *   1. prevStr ends with whitespace → space in DOM, preserved
 *      by white-space:pre. No TextNode needed.
 *   2. item.str starts with whitespace → same.
 *   3. Neither has whitespace but geometric gap > 15% of
 *      fontSize → insert TextNode(' '), adjust gap by
 *      subtracting spaceAdvance.
 */
export function shouldInsertSpace(prevStr, itemStr, gap, fontSize, spaceAdvance) {
  if (!prevStr) return { insertSpace: false, adjustedGap: gap };

  const prevEndsSpace = /\s$/.test(prevStr);
  const currStartsSpace = /^\s/.test(itemStr);

  if (!prevEndsSpace && !currStartsSpace && gap > fontSize * 0.15) {
    return { insertSpace: true, adjustedGap: gap - spaceAdvance };
  }

  return { insertSpace: false, adjustedGap: gap };
}

// ============================================================
// Scale Calculation
// ============================================================

export function calculateScale(pageWidth, pageHeight, windowWidth, windowHeight, toolbarHeight = 48, padding = 48) {
  const availW = windowWidth - padding;
  const availH = windowHeight - toolbarHeight - padding;
  return Math.min(availW / pageWidth, availH / pageHeight, 3);
}

// ============================================================
// Scanned Document Detection (logic only)
//
// Given arrays of { charCount, maxImageCoverage } from sampled
// pages, returns true if ALL pages match the scanned pattern.
// ============================================================

export function isScannedPattern(pageSamples) {
  if (pageSamples.length === 0) return false;

  for (const sample of pageSamples) {
    if (sample.charCount >= SCAN_TEXT_CHAR_THRESHOLD) return false;
    if (sample.maxImageCoverage < SCAN_IMAGE_COVERAGE_THRESHOLD) return false;
  }

  return true;
}
