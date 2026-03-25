import { describe, it, expect } from 'vitest';
import {
  groupItemsIntoLines,
  shouldInsertSpace,
  mergePunctuation,
  calculateScale,
  shouldApplyDark,
  isScannedPattern,
  normalizeLigatures,
  OCR_CONFIDENCE_THRESHOLD,
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
    // availW = 1280 - 16 = 1264, availH = 900 - 48 - 16 = 836
    // widthScale = 1264/612 ≈ 2.065
    // heightScale = 836/792 ≈ 1.056
    // min(2.065, 1.056, 3) ≈ 1.056
    expect(scale).toBeCloseTo(836 / 792, 2);
  });

  it('never exceeds 3x', () => {
    // Tiny page in huge window
    const scale = calculateScale(100, 100, 5000, 5000);
    expect(scale).toBe(3);
  });

  it('handles landscape page', () => {
    const scale = calculateScale(792, 612, 1280, 900);
    // availW = 1264, availH = 836
    // widthScale = 1264/792 ≈ 1.596
    // heightScale = 836/612 ≈ 1.366
    // min(1.596, 1.366, 3) ≈ 1.366
    expect(scale).toBeCloseTo(836 / 612, 2);
  });

  it('fitToWidth ignores height constraint', () => {
    // Simulate mobile landscape: wide but very short screen
    // US Letter (612x792) in a 844x390 viewport (iPhone landscape)
    const scale = calculateScale(612, 792, 844, 390, 48, 16, true);
    // availW = 844 - 16 = 828
    // fitToWidth → only width matters: 828 / 612 ≈ 1.353
    const expected = (844 - 16) / 612;
    expect(scale).toBeCloseTo(expected, 2);
    // Without fitToWidth, height would constrain: (390-48-16)/792 ≈ 0.411
    const fitPage = calculateScale(612, 792, 844, 390, 48, 16, false);
    expect(fitPage).toBeLessThan(scale);
  });

  it('fitToWidth still respects 3x cap', () => {
    const scale = calculateScale(100, 100, 844, 390, 48, 16, true);
    expect(scale).toBe(3);
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

// ============================================================
// mergePunctuation
// ============================================================

describe('mergePunctuation', () => {
  it('merges trailing period into previous word', () => {
    const line = [
      { str: 'Hello', left: 50, width: 30, pdfWidth: 30 },
      { str: '.', left: 80, width: 4, pdfWidth: 4 },
    ];
    const result = mergePunctuation(line);
    expect(result).toHaveLength(1);
    expect(result[0].str).toBe('Hello.');
    expect(result[0].width).toBe(34); // 80 + 4 - 50
    expect(result[0].pdfWidth).toBe(34);
  });

  it('merges trailing exclamation mark', () => {
    const line = [
      { str: 'Wow', left: 50, width: 25 },
      { str: '!', left: 75, width: 4 },
    ];
    const result = mergePunctuation(line);
    expect(result).toHaveLength(1);
    expect(result[0].str).toBe('Wow!');
  });

  it('merges trailing question mark', () => {
    const line = [
      { str: 'Really', left: 50, width: 40 },
      { str: '?', left: 90, width: 5 },
    ];
    const result = mergePunctuation(line);
    expect(result).toHaveLength(1);
    expect(result[0].str).toBe('Really?');
  });

  it('merges multiple consecutive punctuation (e.g. "...")', () => {
    const line = [
      { str: 'Wait', left: 50, width: 30 },
      { str: '...', left: 80, width: 10 },
    ];
    const result = mergePunctuation(line);
    expect(result).toHaveLength(1);
    expect(result[0].str).toBe('Wait...');
  });

  it('does NOT merge punctuation at position 0 (start of line)', () => {
    const line = [
      { str: '.', left: 50, width: 4 },
      { str: 'Hello', left: 60, width: 30 },
    ];
    const result = mergePunctuation(line);
    expect(result).toHaveLength(2);
    expect(result[0].str).toBe('.');
    expect(result[1].str).toBe('Hello');
  });

  it('does NOT merge items with real text content', () => {
    const line = [
      { str: 'Hello', left: 50, width: 30 },
      { str: 'World', left: 85, width: 30 },
    ];
    const result = mergePunctuation(line);
    expect(result).toHaveLength(2);
    expect(result[0].str).toBe('Hello');
    expect(result[1].str).toBe('World');
  });

  it('returns copy of single-item line unchanged', () => {
    const line = [{ str: 'Hello', left: 50, width: 30 }];
    const result = mergePunctuation(line);
    expect(result).toHaveLength(1);
    expect(result[0].str).toBe('Hello');
    expect(result[0]).not.toBe(line[0]); // should be a copy
  });

  it('returns empty array for empty input', () => {
    expect(mergePunctuation([])).toEqual([]);
  });

  it('handles closing parenthesis and bracket', () => {
    const line = [
      { str: 'end', left: 50, width: 20 },
      { str: ')', left: 70, width: 4 },
    ];
    const result = mergePunctuation(line);
    expect(result).toHaveLength(1);
    expect(result[0].str).toBe('end)');
  });

  it('handles closing quote marks', () => {
    const line = [
      { str: 'said', left: 50, width: 25 },
      { str: '"', left: 75, width: 4 },
    ];
    const result = mergePunctuation(line);
    expect(result).toHaveLength(1);
    expect(result[0].str).toBe('said"');
  });

  it('merges comma and semicolon', () => {
    const line = [
      { str: 'item', left: 50, width: 25 },
      { str: ',', left: 75, width: 4 },
      { str: 'next', left: 85, width: 25 },
      { str: ';', left: 110, width: 4 },
    ];
    const result = mergePunctuation(line);
    expect(result).toHaveLength(2);
    expect(result[0].str).toBe('item,');
    expect(result[1].str).toBe('next;');
  });

  it('does not mutate original array', () => {
    const line = [
      { str: 'Hello', left: 50, width: 30, pdfWidth: 30 },
      { str: '.', left: 80, width: 4, pdfWidth: 4 },
    ];
    const originalStr = line[0].str;
    mergePunctuation(line);
    expect(line[0].str).toBe(originalStr);
    expect(line).toHaveLength(2);
  });

  it('preserves pdfWidth when present', () => {
    const line = [
      { str: 'word', left: 50, width: 30, pdfWidth: 30 },
      { str: '.', left: 80, width: 4, pdfWidth: 4 },
    ];
    const result = mergePunctuation(line);
    expect(result[0].pdfWidth).toBe(34);
  });

  it('does not add pdfWidth when not present in original', () => {
    const line = [
      { str: 'word', left: 50, width: 30 },
      { str: '.', left: 80, width: 4 },
    ];
    const result = mergePunctuation(line);
    expect('pdfWidth' in result[0]).toBe(false);
  });
});

// ============================================================
// normalizeLigatures
// ============================================================

describe('normalizeLigatures', () => {
  it('decomposes fi ligature (U+FB01) to f + i', () => {
    expect(normalizeLigatures('\uFB01')).toBe('fi');
  });

  it('decomposes fl ligature (U+FB02) to f + l', () => {
    expect(normalizeLigatures('\uFB02')).toBe('fl');
  });

  it('decomposes ff ligature (U+FB00) to f + f', () => {
    expect(normalizeLigatures('\uFB00')).toBe('ff');
  });

  it('decomposes ffi ligature (U+FB03) to f + f + i', () => {
    expect(normalizeLigatures('\uFB03')).toBe('ffi');
  });

  it('decomposes ffl ligature (U+FB04) to f + f + l', () => {
    expect(normalizeLigatures('\uFB04')).toBe('ffl');
  });

  it('decomposes ligature within a word: e\uFB03cient → efficient', () => {
    expect(normalizeLigatures('e\uFB03cient')).toBe('efficient');
  });

  it('decomposes multiple ligatures in one string', () => {
    expect(normalizeLigatures('\uFB01re\uFB02y')).toBe('firefly');
  });

  it('leaves plain ASCII text unchanged', () => {
    expect(normalizeLigatures('Hello World')).toBe('Hello World');
  });

  it('leaves already-decomposed text unchanged', () => {
    expect(normalizeLigatures('efficient firefly')).toBe('efficient firefly');
  });

  it('handles empty string', () => {
    expect(normalizeLigatures('')).toBe('');
  });

  it('handles null/undefined gracefully', () => {
    expect(normalizeLigatures(null)).toBe(null);
    expect(normalizeLigatures(undefined)).toBe(undefined);
  });
});

// ============================================================
// OCR_CONFIDENCE_THRESHOLD
// ============================================================

describe('OCR_CONFIDENCE_THRESHOLD', () => {
  it('acts as a boundary: words at threshold are kept, words below are dropped', () => {
    const words = [
      { text: 'kept', confidence: OCR_CONFIDENCE_THRESHOLD },
      { text: 'dropped', confidence: OCR_CONFIDENCE_THRESHOLD - 1 },
    ];
    const filtered = words.filter(w => w.confidence >= OCR_CONFIDENCE_THRESHOLD);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].text).toBe('kept');
  });

  it('filters low-confidence words correctly (simulation)', () => {
    // Simulate Tesseract output with mixed confidence
    const words = [
      { text: 'Frattura', confidence: 92, bbox: { x0: 50, y0: 100, x1: 150, y1: 115 } },
      { text: 'JR', confidence: 12, bbox: { x0: 200, y0: 100, x1: 220, y1: 115 } },
      { text: 'omero', confidence: 88, bbox: { x0: 160, y0: 100, x1: 230, y1: 115 } },
      { text: 'EE', confidence: 8, bbox: { x0: 240, y0: 100, x1: 260, y1: 115 } },
      { text: 'Rk', confidence: 15, bbox: { x0: 270, y0: 100, x1: 285, y1: 115 } },
      { text: 'destro', confidence: 91, bbox: { x0: 240, y0: 100, x1: 300, y1: 115 } },
    ];

    const filtered = words.filter(w => w.confidence >= OCR_CONFIDENCE_THRESHOLD);
    expect(filtered).toHaveLength(3);
    expect(filtered.map(w => w.text)).toEqual(['Frattura', 'omero', 'destro']);
  });

  it('keeps words at exactly the threshold', () => {
    const words = [
      { text: 'borderline', confidence: 45, bbox: { x0: 0, y0: 0, x1: 100, y1: 15 } },
      { text: 'garbage', confidence: 44, bbox: { x0: 0, y0: 0, x1: 100, y1: 15 } },
    ];

    const filtered = words.filter(w => w.confidence >= OCR_CONFIDENCE_THRESHOLD);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].text).toBe('borderline');
  });
});

