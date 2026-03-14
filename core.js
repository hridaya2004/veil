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
