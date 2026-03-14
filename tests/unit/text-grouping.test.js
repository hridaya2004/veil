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
  sanitizeOcrWords,
  filterFlowBreakingItems,
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
  it('is set to 45', () => {
    expect(OCR_CONFIDENCE_THRESHOLD).toBe(45);
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

// ============================================================
// sanitizeOcrWords
// ============================================================

describe('sanitizeOcrWords', () => {
  const mkWord = (text, y0, y1, x0 = 50, x1 = 150, confidence = 90) => ({
    text,
    confidence,
    bbox: { x0, y0, x1, y1 },
  });

  it('returns empty array for empty input', () => {
    expect(sanitizeOcrWords([], 45)).toEqual([]);
  });

  it('filters by confidence threshold', () => {
    const words = [
      mkWord('good', 100, 115, 50, 150, 90),
      mkWord('bad', 200, 215, 50, 150, 20),
    ];
    const result = sanitizeOcrWords(words, 45);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('good');
  });

  it('filters out empty/whitespace text', () => {
    const words = [
      mkWord('valid', 100, 115),
      mkWord('   ', 200, 215),
      mkWord('', 300, 315),
    ];
    const result = sanitizeOcrWords(words, 0);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('valid');
  });

  it('filters out tiny bboxes (< 2px)', () => {
    const words = [
      mkWord('valid', 100, 115, 50, 150),
      mkWord('dot', 200, 201, 50, 51), // 1px × 1px
    ];
    const result = sanitizeOcrWords(words, 0);
    expect(result).toHaveLength(1);
  });

  it('clamps anomalously tall bounding boxes', () => {
    const words = [
      mkWord('normal1', 100, 115), // height 15
      mkWord('normal2', 130, 145), // height 15
      mkWord('normal3', 160, 175), // height 15
      mkWord('tall', 50, 450),     // height 400 — way above 3× median (15)
    ];
    const result = sanitizeOcrWords(words, 0);
    const tall = result.find(w => w.text === 'tall');
    expect(tall).toBeDefined();
    // Clamped: y1 should be y0 + (median * 3) = 50 + 45 = 95
    expect(tall.bbox.y1).toBe(50 + 15 * 3);
    // Original words untouched
    const normal1 = result.find(w => w.text === 'normal1');
    expect(normal1.bbox.y1).toBe(115);
  });

  it('does not clamp heights within 3× median', () => {
    const words = [
      mkWord('small', 100, 110), // height 10
      mkWord('medium', 130, 150), // height 20
      mkWord('large', 160, 190), // height 30 — 3× median (10-20 range)
    ];
    const result = sanitizeOcrWords(words, 0);
    // Median height is 20 (middle of [10, 20, 30])
    // 3× median = 60, all heights are ≤ 60 → no clamping
    expect(result.find(w => w.text === 'large').bbox.y1).toBe(190);
  });

  it('sorts by Y coordinate (top-to-bottom)', () => {
    const words = [
      mkWord('bottom', 300, 315),
      mkWord('top', 100, 115),
      mkWord('middle', 200, 215),
    ];
    const result = sanitizeOcrWords(words, 0);
    expect(result[0].text).toBe('top');
    expect(result[1].text).toBe('middle');
    expect(result[2].text).toBe('bottom');
  });

  it('sorts by X within same Y', () => {
    const words = [
      mkWord('right', 100, 115, 200, 300),
      mkWord('left', 100, 115, 50, 150),
    ];
    const result = sanitizeOcrWords(words, 0);
    expect(result[0].text).toBe('left');
    expect(result[1].text).toBe('right');
  });

  it('does not mutate input array', () => {
    const words = [
      mkWord('tall', 50, 450),
      mkWord('normal', 100, 115),
    ];
    const origY1 = words[0].bbox.y1;
    sanitizeOcrWords(words, 0);
    expect(words[0].bbox.y1).toBe(origY1); // unchanged
    expect(words).toHaveLength(2); // same length
  });

  it('never removes words — only clamps', () => {
    const words = [
      mkWord('a', 100, 115),
      mkWord('|', 50, 500),  // extreme garbage height but valid confidence
      mkWord('b', 200, 215),
    ];
    const result = sanitizeOcrWords(words, 0);
    expect(result).toHaveLength(3); // all three kept
    expect(result.find(w => w.text === '|')).toBeDefined();
  });

  it('handles single word (no median comparison issue)', () => {
    const words = [mkWord('only', 100, 115)];
    const result = sanitizeOcrWords(words, 0);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('only');
  });

  it('real-world scenario: garbage "|" does not poison prevBottom', () => {
    // Simulates the exact bug: a tall "|" at y=50 with height 400,
    // followed by a real line at y=80
    const words = [
      mkWord('|', 50, 450, 10, 15),      // garbage: 400px tall
      mkWord('Frattura', 80, 95, 50, 200), // real text: 15px tall
      mkWord('omero', 80, 95, 210, 300),   // same line
      mkWord('destro', 100, 115, 50, 200), // next line
    ];
    const result = sanitizeOcrWords(words, 0);

    // "|" should be clamped — its height should be ≤ 3× median
    // Median of [15, 15, 15, 400] = 15. Max = 45.
    const pipe = result.find(w => w.text === '|');
    expect(pipe.bbox.y1 - pipe.bbox.y0).toBeLessThanOrEqual(45);

    // Real text untouched
    const frattura = result.find(w => w.text === 'Frattura');
    expect(frattura.bbox.y1).toBe(95);
  });
});

// ============================================================
// filterFlowBreakingItems
// ============================================================

describe('filterFlowBreakingItems', () => {
  // Identity transform function (no-op)
  const identityTransform = (vt, it) => it;
  const identityVP = [1, 0, 0, 1, 0, 0];
  const dpr = 1;

  // Helper: create a textContent item at given position
  const mkItem = (str, top, fontSize = 12) => ({
    str,
    transform: [fontSize, 0, 0, fontSize, 50, top],
    width: 50,
  });

  it('returns all items when 2 or fewer', () => {
    const items = [mkItem('a', 100), mkItem('b', 120)];
    const result = filterFlowBreakingItems(items, identityTransform, identityVP, dpr);
    expect(result.items).toHaveLength(2);
  });

  it('keeps items with consistent spacing', () => {
    // Regular paragraph: 5 lines, 20px apart, height 12
    const items = [
      mkItem('line1', 100),
      mkItem('line2', 120),
      mkItem('line3', 140),
      mkItem('line4', 160),
      mkItem('line5', 180),
    ];
    const result = filterFlowBreakingItems(items, identityTransform, identityVP, dpr);
    expect(result.items).toHaveLength(5); // all kept
  });

  it('removes isolated item with huge gaps on both sides', () => {
    // Normal text block, isolated garbage in the middle, then footer
    const items = [
      mkItem('line1', 100),
      mkItem('line2', 120),
      mkItem('line3', 140),
      mkItem('garbage', 500), // huge gap before AND after
      mkItem('line4', 160),
      mkItem('line5', 180),
      mkItem('footer', 750),  // footer at bottom (kept: last item)
    ];
    const result = filterFlowBreakingItems(items, identityTransform, identityVP, dpr);
    // 'garbage' at 500 is isolated (huge gap before AND after)
    expect(result.items.map(i => i.str)).not.toContain('garbage');
    // footer is kept (last item, protected)
    expect(result.items.map(i => i.str)).toContain('footer');
    expect(result.items.length).toBe(6);
  });

  it('keeps item with large gap only on ONE side (e.g. page number)', () => {
    // Regular text block + page number at bottom
    const items = [
      mkItem('line1', 100),
      mkItem('line2', 120),
      mkItem('line3', 140),
      mkItem('line4', 160),
      mkItem('line5', 180),
      mkItem('pagenum', 700), // large gap before, but it's the LAST item
    ];
    const result = filterFlowBreakingItems(items, identityTransform, identityVP, dpr);
    // pagenum is NOT isolated (it's last — gap only before, not after)
    expect(result.items.map(i => i.str)).toContain('pagenum');
  });

  it('keeps header at top (first item, gap only after)', () => {
    const items = [
      mkItem('HEADER', 10),  // first item, gap only after
      mkItem('line1', 300),
      mkItem('line2', 320),
      mkItem('line3', 340),
      mkItem('line4', 360),
    ];
    const result = filterFlowBreakingItems(items, identityTransform, identityVP, dpr);
    expect(result.items.map(i => i.str)).toContain('HEADER');
  });

  it('does not over-filter (safety: keeps all if >50% would be removed)', () => {
    // All items are isolated from each other
    const items = [
      mkItem('a', 100),
      mkItem('b', 500),
      mkItem('c', 900),
      mkItem('d', 1300),
    ];
    const result = filterFlowBreakingItems(items, identityTransform, identityVP, dpr);
    // Removing >50% would be too aggressive → keep all
    expect(result.items).toHaveLength(4);
  });

  it('does not mutate input array', () => {
    const items = [mkItem('a', 100), mkItem('b', 120), mkItem('c', 140)];
    const original = [...items];
    filterFlowBreakingItems(items, identityTransform, identityVP, dpr);
    expect(items).toEqual(original);
  });

  it('handles empty array', () => {
    const result = filterFlowBreakingItems([], identityTransform, identityVP, dpr);
    expect(result.items).toHaveLength(0);
  });

  it('real scenario: stamp fragment between text lines is removed', () => {
    // Lines at y=100-200 (normal text body)
    // Stamp fragment at y=400 (isolated between body and footer)
    // Footer at y=700
    const items = [
      mkItem('Frattura', 100),
      mkItem('diafisaria', 120),
      mkItem('omero', 140),
      mkItem('destro', 160),
      mkItem('12A1', 180),
      mkItem('del', 200),
      mkItem('|', 400, 6),       // stamp garbage, isolated
      mkItem('footer', 700),     // kept: last item
    ];
    const result = filterFlowBreakingItems(items, identityTransform, identityVP, dpr);
    expect(result.items.map(i => i.str)).not.toContain('|');
    expect(result.items.map(i => i.str)).toContain('Frattura');
    expect(result.items.map(i => i.str)).toContain('destro');
    expect(result.items.map(i => i.str)).toContain('footer');
  });
});
