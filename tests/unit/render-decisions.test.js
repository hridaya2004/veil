/**
 * Unit tests for renderPageIfNeeded decision logic.
 *
 * These replicate the guard conditions and branching decisions
 * from renderPageIfNeeded (app.js) as pure functions, testing
 * the decision tree without requiring browser DOM or PDF.js.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldApplyDark,
  extractImageRegions,
  isScannedPattern,
  IDENTITY_MATRIX,
} from '../../core.js';

// ============================================================
// Guard conditions (replicated from renderPageIfNeeded)
// ============================================================

function shouldSkipRender(state, pageNum, numPages, hasSlot) {
  if (pageNum < 1 || pageNum > numPages) return true;
  if (!hasSlot) return true;
  if (state.rendered || state.rendering) return true;
  return false;
}

function isGenerationStale(currentGen, myGen) {
  return currentGen !== myGen;
}

describe('renderPageIfNeeded — guard conditions', () => {
  const freshState = { rendered: false, rendering: false };

  it('skips when pageNum < 1', () => {
    expect(shouldSkipRender(freshState, 0, 10, true)).toBe(true);
    expect(shouldSkipRender(freshState, -1, 10, true)).toBe(true);
  });

  it('skips when pageNum > numPages', () => {
    expect(shouldSkipRender(freshState, 11, 10, true)).toBe(true);
  });

  it('skips when no slot assigned', () => {
    expect(shouldSkipRender(freshState, 5, 10, false)).toBe(true);
  });

  it('skips when already rendered', () => {
    expect(shouldSkipRender({ rendered: true, rendering: false }, 5, 10, true)).toBe(true);
  });

  it('skips when currently rendering', () => {
    expect(shouldSkipRender({ rendered: false, rendering: true }, 5, 10, true)).toBe(true);
  });

  it('proceeds when all conditions are met', () => {
    expect(shouldSkipRender(freshState, 5, 10, true)).toBe(false);
  });

  it('proceeds for page 1 (boundary)', () => {
    expect(shouldSkipRender(freshState, 1, 10, true)).toBe(false);
  });

  it('proceeds for last page (boundary)', () => {
    expect(shouldSkipRender(freshState, 10, 10, true)).toBe(false);
  });
});

describe('renderPageIfNeeded — generation staleness', () => {
  it('detects stale when generation changed', () => {
    expect(isGenerationStale(5, 4)).toBe(true);
  });

  it('not stale when generation matches', () => {
    expect(isGenerationStale(4, 4)).toBe(false);
  });

  it('detects stale when generation jumped by more than 1', () => {
    expect(isGenerationStale(10, 3)).toBe(true);
  });
});

// ============================================================
// Content decisions (scanned vs native)
// ============================================================

function shouldFetchTextContent(isScanned) {
  return !isScanned;
}

function getImageRegionsForPage(isScanned, opList, transform, opsMap) {
  return isScanned ? [] : extractImageRegions(opList, transform, opsMap);
}

describe('renderPageIfNeeded — content decisions', () => {
  it('fetches textContent for native PDFs', () => {
    expect(shouldFetchTextContent(false)).toBe(true);
  });

  it('skips textContent for scanned PDFs', () => {
    expect(shouldFetchTextContent(true)).toBe(false);
  });

  it('returns empty regions for scanned PDFs', () => {
    const mockOps = { save: 10, restore: 11, transform: 12, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, paintImageXObject: 85, paintInlineImageXObject: 86, paintImageXObjectRepeat: 88 };
    const opList = {
      fnArray: [mockOps.paintImageXObject],
      argsArray: [['img_0']],
    };
    // Scanned: always empty, even if operator list has images
    expect(getImageRegionsForPage(true, opList, IDENTITY_MATRIX, mockOps)).toEqual([]);
  });

  it('extracts regions for native PDFs with images', () => {
    const mockOps = { save: 10, restore: 11, transform: 12, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, paintImageXObject: 85, paintInlineImageXObject: 86, paintImageXObjectRepeat: 88 };
    const opList = {
      fnArray: [mockOps.paintImageXObject],
      argsArray: [['img_0']],
    };
    const regions = getImageRegionsForPage(false, opList, IDENTITY_MATRIX, mockOps);
    expect(regions).toHaveLength(1);
  });
});

// ============================================================
// Memory management decisions
// ============================================================

function shouldCleanupPage(isMemoryConstrained) {
  return isMemoryConstrained;
}

function shouldReturnCanvasOnError(renderCanvas) {
  return renderCanvas !== null;
}

describe('renderPageIfNeeded — memory management', () => {
  it('cleans up page on memory-constrained devices', () => {
    expect(shouldCleanupPage(true)).toBe(true);
  });

  it('skips cleanup on desktop', () => {
    expect(shouldCleanupPage(false)).toBe(false);
  });

  it('returns canvas to pool on error when canvas was borrowed', () => {
    expect(shouldReturnCanvasOnError({ width: 100 })).toBe(true);
  });

  it('does not return canvas when none was borrowed', () => {
    expect(shouldReturnCanvasOnError(null)).toBe(false);
  });
});

// ============================================================
// Dark mode application (integration of multiple decisions)
// ============================================================

describe('renderPageIfNeeded — dark mode composition', () => {
  it('native PDF with images: dark mode + overlay', () => {
    const overrides = new Map();
    const alreadyDark = new Map();
    const isScanned = false;
    const hasImages = true;

    const applyDark = shouldApplyDark(1, overrides, alreadyDark);
    const regions = hasImages ? [{ x: 0, y: 0, width: 100, height: 100 }] : [];

    expect(applyDark).toBe(true);
    expect(regions.length).toBeGreaterThan(0);
    // Both dark mode and overlay should be active
  });

  it('native PDF without images: dark mode, no overlay', () => {
    const overrides = new Map();
    const alreadyDark = new Map();
    const hasImages = false;

    const applyDark = shouldApplyDark(1, overrides, alreadyDark);
    const regions = hasImages ? [{ x: 0, y: 0, width: 100, height: 100 }] : [];

    expect(applyDark).toBe(true);
    expect(regions).toHaveLength(0);
    // Dark mode active but no overlay needed
  });

  it('already-dark page: no dark mode, no overlay', () => {
    const overrides = new Map();
    const alreadyDark = new Map([[1, true]]);

    const applyDark = shouldApplyDark(1, overrides, alreadyDark);
    expect(applyDark).toBe(false);
    // Page renders as-is
  });

  it('scanned PDF: dark mode applies to entire page (no image protection)', () => {
    const overrides = new Map();
    const alreadyDark = new Map();
    const isScanned = true;

    const applyDark = shouldApplyDark(1, overrides, alreadyDark);
    const regions = isScanned ? [] : [{ x: 0, y: 0, width: 100, height: 100 }];

    expect(applyDark).toBe(true);
    expect(regions).toHaveLength(0);
    // CSS invert covers entire page, no overlay
  });

  it('user forces light on scanned page: respects override', () => {
    const overrides = new Map([[1, 'light']]);
    const alreadyDark = new Map();

    const applyDark = shouldApplyDark(1, overrides, alreadyDark);
    expect(applyDark).toBe(false);
  });
});
