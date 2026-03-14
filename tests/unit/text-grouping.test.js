import { describe, it, expect } from 'vitest';
import {
  groupItemsIntoLines,
  shouldInsertSpace,
  calculateScale,
  shouldApplyDark,
  isScannedPattern,
} from '../../core.js';

// ============================================================
// groupItemsIntoLines
// ============================================================

describe('groupItemsIntoLines', () => {
  it('returns empty for empty input', () => {
    expect(groupItemsIntoLines([])).toEqual([]);
  });

  it('single item → one line with one item', () => {
    const items = [{ top: 100, left: 50, height: 12 }];
    const lines = groupItemsIntoLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(1);
  });

  it('items on same line (within threshold)', () => {
    const items = [
      { top: 100, left: 50, height: 12 },
      { top: 101, left: 100, height: 12 }, // 1px diff < 6px threshold (50% of 12)
      { top: 99, left: 150, height: 12 },
    ];
    const lines = groupItemsIntoLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(3);
  });

  it('items on different lines', () => {
    const items = [
      { top: 100, left: 50, height: 12 },
      { top: 120, left: 50, height: 12 }, // 20px diff > 6px threshold
      { top: 140, left: 50, height: 12 },
    ];
    const lines = groupItemsIntoLines(items);
    expect(lines).toHaveLength(3);
  });

  it('sorts by top then left', () => {
    const items = [
      { top: 120, left: 200, height: 12 },
      { top: 100, left: 100, height: 12 },
      { top: 100, left: 50, height: 12 },
    ];
    const lines = groupItemsIntoLines(items);
    expect(lines).toHaveLength(2);
    // First line should have items at top=100, sorted by left
    expect(lines[0][0].left).toBe(50);
    expect(lines[0][1].left).toBe(100);
    // Second line at top=120
    expect(lines[1][0].left).toBe(200);
  });

  it('handles items with different heights on same line', () => {
    const items = [
      { top: 100, left: 50, height: 12 },
      { top: 102, left: 100, height: 20 }, // larger font on same line
    ];
    const lines = groupItemsIntoLines(items);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(2);
  });

  it('threshold adapts to line height', () => {
    // Large font: height = 48, threshold = 24
    const items = [
      { top: 100, left: 50, height: 48 },
      { top: 120, left: 100, height: 48 }, // 20px diff < 24px threshold → same line
    ];
    const lines = groupItemsIntoLines(items);
    expect(lines).toHaveLength(1);
  });

  it('many lines with multiple items each', () => {
    const items = [];
    for (let line = 0; line < 5; line++) {
      for (let word = 0; word < 4; word++) {
        items.push({ top: 100 + line * 20, left: 50 + word * 80, height: 12 });
      }
    }
    const lines = groupItemsIntoLines(items);
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(line).toHaveLength(4);
    }
  });
});

// ============================================================
// shouldInsertSpace
// ============================================================

describe('shouldInsertSpace', () => {
  const spaceAdvance = 4; // typical space width in px

  it('returns false when no previous string', () => {
    const result = shouldInsertSpace('', 'hello', 10, 12, spaceAdvance);
    expect(result.insertSpace).toBe(false);
  });

  it('returns false when null previous string', () => {
    const result = shouldInsertSpace(null, 'hello', 10, 12, spaceAdvance);
    expect(result.insertSpace).toBe(false);
  });

  it('Scenario A: prevStr ends with space → no insert needed', () => {
    const result = shouldInsertSpace('hello ', 'world', 0, 12, spaceAdvance);
    expect(result.insertSpace).toBe(false);
  });

  it('Scenario A variant: prevStr ends with tab → no insert needed', () => {
    const result = shouldInsertSpace('hello\t', 'world', 5, 12, spaceAdvance);
    expect(result.insertSpace).toBe(false);
  });

  it('Scenario B: itemStr starts with space → no insert needed', () => {
    const result = shouldInsertSpace('hello', ' world', 0, 12, spaceAdvance);
    expect(result.insertSpace).toBe(false);
  });

  it('Scenario C: no whitespace, large gap → insert space', () => {
    // gap = 3 > fontSize * 0.15 = 12 * 0.15 = 1.8
    const result = shouldInsertSpace('hello', 'world', 3, 12, spaceAdvance);
    expect(result.insertSpace).toBe(true);
    expect(result.adjustedGap).toBe(3 - spaceAdvance);
  });

  it('no whitespace, small gap → no insert', () => {
    // gap = 1 < fontSize * 0.15 = 1.8
    const result = shouldInsertSpace('hello', 'world', 1, 12, spaceAdvance);
    expect(result.insertSpace).toBe(false);
    expect(result.adjustedGap).toBe(1);
  });

  it('Antigravity: italic boundary with pdfWidth eating space', () => {
    // "I " → "hate": prevStr ends with space, gap ≈ 0
    // The CSS white-space:pre preserves the trailing space → no insert
    const result = shouldInsertSpace('I ', 'hate', 0, 14, spaceAdvance);
    expect(result.insertSpace).toBe(false);
  });

  it('Antigravity: no whitespace in either, gap = 0', () => {
    // Neither has whitespace, gap = 0 → below threshold → no insert
    // This case would produce "hatetalking" → white-space:pre is the fix
    const result = shouldInsertSpace('hate', 'talking', 0, 14, spaceAdvance);
    expect(result.insertSpace).toBe(false);
  });
});

// ============================================================
// calculateScale
// ============================================================

describe('calculateScale', () => {
  it('fits a US Letter page in a 1280x900 window', () => {
    const scale = calculateScale(612, 792, 1280, 900);
    // availW = 1280 - 48 = 1232, availH = 900 - 48 - 48 = 804
    // widthScale = 1232/612 ≈ 2.013
    // heightScale = 804/792 ≈ 1.015
    // min(2.013, 1.015, 3) = 1.015
    expect(scale).toBeCloseTo(804 / 792, 2);
  });

  it('never exceeds 3x', () => {
    // Tiny page in huge window
    const scale = calculateScale(100, 100, 5000, 5000);
    expect(scale).toBe(3);
  });

  it('handles landscape page', () => {
    const scale = calculateScale(792, 612, 1280, 900);
    // availW = 1232, availH = 804
    // widthScale = 1232/792 ≈ 1.555
    // heightScale = 804/612 ≈ 1.314
    // min(1.555, 1.314, 3) ≈ 1.314
    expect(scale).toBeCloseTo(804 / 612, 2);
  });
});

// ============================================================
// shouldApplyDark
// ============================================================

describe('shouldApplyDark', () => {
  it('default: returns true (apply dark mode)', () => {
    const overrides = new Map();
    const alreadyDark = new Map();
    expect(shouldApplyDark(1, overrides, alreadyDark)).toBe(true);
  });

  it('force dark override → true', () => {
    const overrides = new Map([[1, 'dark']]);
    const alreadyDark = new Map([[1, true]]);
    // Even though page is already dark, override wins
    expect(shouldApplyDark(1, overrides, alreadyDark)).toBe(true);
  });

  it('force light override → false', () => {
    const overrides = new Map([[1, 'light']]);
    const alreadyDark = new Map();
    expect(shouldApplyDark(1, overrides, alreadyDark)).toBe(false);
  });

  it('auto mode + already dark → false (skip inversion)', () => {
    const overrides = new Map();
    const alreadyDark = new Map([[1, true]]);
    expect(shouldApplyDark(1, overrides, alreadyDark)).toBe(false);
  });

  it('auto mode + not already dark → true', () => {
    const overrides = new Map();
    const alreadyDark = new Map([[1, false]]);
    expect(shouldApplyDark(1, overrides, alreadyDark)).toBe(true);
  });

  it('different pages have independent state', () => {
    const overrides = new Map([[1, 'light']]);
    const alreadyDark = new Map([[2, true]]);
    expect(shouldApplyDark(1, overrides, alreadyDark)).toBe(false);
    expect(shouldApplyDark(2, overrides, alreadyDark)).toBe(false);
    expect(shouldApplyDark(3, overrides, alreadyDark)).toBe(true);
  });
});

// ============================================================
// isScannedPattern
// ============================================================

describe('isScannedPattern', () => {
  it('returns false for empty samples', () => {
    expect(isScannedPattern([])).toBe(false);
  });

  it('returns true when all pages match scanned pattern', () => {
    const samples = [
      { charCount: 0, maxImageCoverage: 0.95 },
      { charCount: 10, maxImageCoverage: 0.90 },
    ];
    expect(isScannedPattern(samples)).toBe(true);
  });

  it('returns false when a page has substantial text', () => {
    const samples = [
      { charCount: 0, maxImageCoverage: 0.95 },
      { charCount: 200, maxImageCoverage: 0.90 }, // too much text
    ];
    expect(isScannedPattern(samples)).toBe(false);
  });

  it('returns false when a page has no dominant image', () => {
    const samples = [
      { charCount: 5, maxImageCoverage: 0.95 },
      { charCount: 5, maxImageCoverage: 0.50 }, // no full-page image
    ];
    expect(isScannedPattern(samples)).toBe(false);
  });

  it('single page matching → true', () => {
    expect(isScannedPattern([{ charCount: 0, maxImageCoverage: 0.99 }])).toBe(true);
  });

  it('threshold: charCount = 49 (just under 50) → true', () => {
    expect(isScannedPattern([{ charCount: 49, maxImageCoverage: 0.90 }])).toBe(true);
  });

  it('threshold: charCount = 50 (at threshold) → false', () => {
    expect(isScannedPattern([{ charCount: 50, maxImageCoverage: 0.90 }])).toBe(false);
  });

  it('threshold: coverage = 0.84 (just under 0.85) → false', () => {
    expect(isScannedPattern([{ charCount: 0, maxImageCoverage: 0.84 }])).toBe(false);
  });

  it('threshold: coverage = 0.85 (at threshold) → true', () => {
    expect(isScannedPattern([{ charCount: 0, maxImageCoverage: 0.85 }])).toBe(true);
  });
});
