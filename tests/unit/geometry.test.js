import { describe, it, expect } from 'vitest';
import { calculateScale } from '../../core.js';

// ============================================================
// Geometry & Scale Calculation
// ============================================================

// Replicated from app.js for testability
function isPresentationMode(geometry) {
  if (geometry.length <= 1) return false;
  const first = geometry[1];
  return first.cssWidth > first.cssHeight;
}

describe('calculateScale — fitToWidth', () => {
  it('fitToWidth=true: ignores height constraint', () => {
    // US Letter in a short viewport — fitToWidth should use only width
    const scale = calculateScale(612, 792, 844, 390, 48, 16, true);
    const expected = (844 - 16) / 612;
    expect(scale).toBeCloseTo(expected, 2);
  });

  it('fitToWidth=true with wide page: still caps at 3', () => {
    // Very small page in a wide viewport
    const scale = calculateScale(50, 100, 5000, 5000, 48, 16, true);
    expect(scale).toBe(3);
  });

  it('fitToWidth=false (default): uses both width and height', () => {
    const scaleFit = calculateScale(612, 792, 844, 390, 48, 16, true);
    const scalePage = calculateScale(612, 792, 844, 390, 48, 16, false);
    // Height constraint should make fitPage smaller
    expect(scalePage).toBeLessThan(scaleFit);
  });
});

describe('calculateScale — edge cases', () => {
  it('pageWidth=0 returns 1', () => {
    expect(calculateScale(0, 792, 1280, 900)).toBe(1);
  });

  it('pageHeight=0 returns 1', () => {
    expect(calculateScale(612, 0, 1280, 900)).toBe(1);
  });

  it('both dimensions 0 returns 1', () => {
    expect(calculateScale(0, 0, 1280, 900)).toBe(1);
  });
});

describe('calculateScale — real device scenarios', () => {
  it('US Letter in 375x667 (iPhone portrait)', () => {
    const scale = calculateScale(612, 792, 375, 667);
    // availW = 375 - 16 = 359, availH = 667 - 48 - 16 = 603
    // widthScale = 359/612 ≈ 0.587, heightScale = 603/792 ≈ 0.761
    // min(0.587, 0.761, 3) ≈ 0.587
    expect(scale).toBeCloseTo(359 / 612, 2);
  });

  it('US Letter in 667x375 (iPhone landscape) with fitToWidth', () => {
    const scale = calculateScale(612, 792, 667, 375, 48, 16, true);
    // availW = 667 - 16 = 651
    // fitToWidth → 651 / 612 ≈ 1.064
    expect(scale).toBeCloseTo(651 / 612, 2);
  });

  it('A4 landscape page in 1280x900', () => {
    // A4 landscape: 842 x 595
    const scale = calculateScale(842, 595, 1280, 900);
    // availW = 1280 - 16 = 1264, availH = 900 - 48 - 16 = 836
    // widthScale = 1264/842 ≈ 1.501, heightScale = 836/595 ≈ 1.405
    // min(1.501, 1.405, 3) ≈ 1.405
    expect(scale).toBeCloseTo(836 / 595, 2);
  });

  it('tiny page scales up but caps at 3', () => {
    const scale = calculateScale(100, 100, 1920, 1080);
    expect(scale).toBe(3);
  });

  it('square page in square viewport', () => {
    const scale = calculateScale(500, 500, 1000, 1000);
    // availW = 984, availH = 936
    // widthScale = 984/500 = 1.968, heightScale = 936/500 = 1.872
    expect(scale).toBeCloseTo(936 / 500, 2);
  });
});

// ============================================================
// isPresentationMode
// ============================================================

describe('isPresentationMode', () => {
  it('portrait page → false', () => {
    const geom = [null, { cssWidth: 612, cssHeight: 792 }];
    expect(isPresentationMode(geom)).toBe(false);
  });

  it('landscape page → true', () => {
    const geom = [null, { cssWidth: 1024, cssHeight: 768 }];
    expect(isPresentationMode(geom)).toBe(true);
  });

  it('empty geometry (length <= 1) → false', () => {
    expect(isPresentationMode([null])).toBe(false);
    expect(isPresentationMode([])).toBe(false);
  });

  it('square page → false (width not greater than height)', () => {
    const geom = [null, { cssWidth: 500, cssHeight: 500 }];
    expect(isPresentationMode(geom)).toBe(false);
  });
});
