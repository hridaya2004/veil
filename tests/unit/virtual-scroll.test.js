import { describe, it, expect } from 'vitest';

// ============================================================
// Virtual Scroll — Pure Logic
//
// Replicated from app.js for testability (app.js has browser
// dependencies that prevent direct import in Node/Vitest).
// ============================================================

// Replicated from app.js for testability
function binarySearchFirstVisible(geometry, viewTop) {
  let lo = 1, hi = geometry.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const pg = geometry[mid];
    if (pg.offsetTop + pg.cssHeight < viewTop) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function hitTestImageRegion(regions, x, y) {
  for (const r of regions) {
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
  }
  return null;
}

// Replicated from app.js
function getEngineResetThreshold(largeDocConstrained) {
  if (largeDocConstrained) return 15;
  return 40;
}

// Replicated from app.js
function getDpr(raw, isConstrained) {
  if (isConstrained) return Math.min(raw, 2);
  return raw;
}

/**
 * Builds a mock geometry array. Index 0 is a placeholder (pages are 1-indexed).
 * Each page has offsetTop and cssHeight.
 */
function makeGeometry(pageCount, pageHeight, gap = 16) {
  const geom = [null]; // index 0 placeholder
  let top = 0;
  for (let i = 1; i <= pageCount; i++) {
    geom.push({ offsetTop: top, cssHeight: pageHeight });
    top += pageHeight + gap;
  }
  return geom;
}

// ============================================================
// binarySearchFirstVisible
// ============================================================

describe('binarySearchFirstVisible', () => {
  it('single page: returns 1', () => {
    const geom = makeGeometry(1, 800);
    expect(binarySearchFirstVisible(geom, 0)).toBe(1);
  });

  it('5 pages, viewTop=0: returns 1', () => {
    const geom = makeGeometry(5, 800);
    expect(binarySearchFirstVisible(geom, 0)).toBe(1);
  });

  it('5 pages, viewTop at middle page: returns correct page', () => {
    // Pages: 0-800, 816-1616, 1632-2432, 2448-3248, 3264-4064
    const geom = makeGeometry(5, 800);
    // viewTop = 1700 → page 2 ends at 1616, page 3 starts at 1632
    expect(binarySearchFirstVisible(geom, 1700)).toBe(3);
  });

  it('5 pages, viewTop past last page: returns last', () => {
    const geom = makeGeometry(5, 800);
    // viewTop way past the end
    expect(binarySearchFirstVisible(geom, 99999)).toBe(5);
  });

  it('10 pages with gaps: finds correct page in the middle', () => {
    const geom = makeGeometry(10, 500, 20);
    // Page 5: offsetTop = 4 * (500 + 20) = 2080, ends at 2580
    // Page 6: offsetTop = 5 * (500 + 20) = 2600
    // viewTop = 2600 → page 5 ends at 2580, so first visible is page 6
    expect(binarySearchFirstVisible(geom, 2600)).toBe(6);
  });

  it('viewTop exactly at page boundary', () => {
    const geom = makeGeometry(5, 800, 16);
    // Page 1 ends at 800, page 2 starts at 816
    // viewTop = 800 → page 1 bottom = 0 + 800 = 800, which is NOT < 800
    expect(binarySearchFirstVisible(geom, 800)).toBe(1);
  });

  it('viewTop just past page 1 bottom', () => {
    const geom = makeGeometry(5, 800, 16);
    // viewTop = 801 → page 1 bottom is 800, which IS < 801
    expect(binarySearchFirstVisible(geom, 801)).toBe(2);
  });
});

// ============================================================
// hitTestImageRegion
// ============================================================

describe('hitTestImageRegion', () => {
  it('empty array: returns null', () => {
    expect(hitTestImageRegion([], 50, 50)).toBeNull();
  });

  it('point inside region: returns region', () => {
    const regions = [{ x: 10, y: 10, w: 100, h: 100 }];
    expect(hitTestImageRegion(regions, 50, 50)).toBe(regions[0]);
  });

  it('point outside all regions: returns null', () => {
    const regions = [{ x: 10, y: 10, w: 100, h: 100 }];
    expect(hitTestImageRegion(regions, 200, 200)).toBeNull();
  });

  it('point on exact border: returns region', () => {
    const regions = [{ x: 10, y: 10, w: 100, h: 100 }];
    // Exact top-left corner
    expect(hitTestImageRegion(regions, 10, 10)).toBe(regions[0]);
    // Exact bottom-right corner
    expect(hitTestImageRegion(regions, 110, 110)).toBe(regions[0]);
  });

  it('multiple regions, hits second: returns second', () => {
    const regions = [
      { x: 0, y: 0, w: 50, h: 50 },
      { x: 100, y: 100, w: 50, h: 50 },
    ];
    expect(hitTestImageRegion(regions, 120, 120)).toBe(regions[1]);
  });

  it('point between regions: returns null', () => {
    const regions = [
      { x: 0, y: 0, w: 50, h: 50 },
      { x: 100, y: 100, w: 50, h: 50 },
    ];
    expect(hitTestImageRegion(regions, 75, 75)).toBeNull();
  });
});

// ============================================================
// getEngineResetThreshold
// ============================================================

describe('getEngineResetThreshold', () => {
  it('largeDocConstrained=true returns 15', () => {
    expect(getEngineResetThreshold(true)).toBe(15);
  });

  it('largeDocConstrained=false returns 40', () => {
    expect(getEngineResetThreshold(false)).toBe(40);
  });
});

// ============================================================
// getDpr
// ============================================================

describe('getDpr', () => {
  it('raw DPR 1 → 1', () => {
    expect(getDpr(1, false)).toBe(1);
  });

  it('raw DPR 2 → 2', () => {
    expect(getDpr(2, false)).toBe(2);
  });

  it('raw DPR 3 on constrained → 2', () => {
    expect(getDpr(3, true)).toBe(2);
  });

  it('raw DPR 2.625 on constrained → 2', () => {
    expect(getDpr(2.625, true)).toBe(2);
  });

  it('raw DPR 1 on constrained → 1 (no upscaling)', () => {
    expect(getDpr(1, true)).toBe(1);
  });

  it('raw DPR 2 on constrained → 2 (at cap)', () => {
    expect(getDpr(2, true)).toBe(2);
  });
});

// ============================================================
// Canvas Pool — Borrow/Return Balance
//
// Replicated pool logic from app.js. The pool is a simple array
// of reusable canvases. borrowCanvas() pops one (or creates new),
// returnCanvas() pushes it back. If a canvas is borrowed but never
// returned (exception, generation change), the pool shrinks — this
// is the bug that fix #3 addresses.
// ============================================================

function createCanvasPool(initialSize) {
  const pool = [];
  for (let i = 0; i < initialSize; i++) {
    pool.push({ id: i, inUse: false });
  }
  return pool;
}

function borrowCanvas(pool) {
  if (pool.length > 0) return pool.pop();
  return { id: -1, inUse: false }; // fallback: create new
}

function returnCanvas(pool, canvas) {
  pool.push(canvas);
}

describe('Canvas pool borrow/return balance', () => {
  it('borrow reduces pool size', () => {
    const pool = createCanvasPool(5);
    expect(pool.length).toBe(5);
    borrowCanvas(pool);
    expect(pool.length).toBe(4);
  });

  it('return restores pool size', () => {
    const pool = createCanvasPool(5);
    const c = borrowCanvas(pool);
    expect(pool.length).toBe(4);
    returnCanvas(pool, c);
    expect(pool.length).toBe(5);
  });

  it('borrow without return leaks (the bug)', () => {
    const pool = createCanvasPool(3);
    borrowCanvas(pool); // simulates a render that throws
    borrowCanvas(pool); // another leak
    expect(pool.length).toBe(1); // pool is draining
  });

  it('try/finally pattern prevents leak', () => {
    const pool = createCanvasPool(3);
    // Simulates the fix: always return in finally
    let canvas;
    try {
      canvas = borrowCanvas(pool);
      throw new Error('simulated render failure');
    } catch (_) {
      // error handled
    } finally {
      if (canvas) returnCanvas(pool, canvas);
    }
    expect(pool.length).toBe(3); // pool restored
  });
});
