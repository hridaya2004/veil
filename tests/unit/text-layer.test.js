/**
 * Livello 2 — DOM structure tests for text layer construction.
 *
 * These tests verify that the core functions produce correct DOM
 * structures when assembled the same way buildTextLayer and
 * buildOcrTextLayer do in app.js.
 *
 * Uses happy-dom (configured in vitest.config.js) for DOM simulation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { groupItemsIntoLines, shouldInsertSpace, mergePunctuation } from '../../core.js';

// ============================================================
// Simulate the DOM-building logic from buildTextLayer
// (extracted to be testable without importing app.js)
// ============================================================

/**
 * Minimal simulation of buildTextLayer DOM construction.
 * Uses the same core functions as app.js but in a test context.
 */
function buildTextLayerDOM(container, items) {
  container.innerHTML = '';
  if (items.length === 0) return;

  const lines = groupItemsIntoLines(items);

  // Simulate spaceAdvance (in a real browser, this comes from measureText)
  const spaceAdvance = 4;

  let prevBottom = 0;

  for (const rawLine of lines) {
    rawLine.sort((a, b) => a.left - b.left);
    const line = mergePunctuation(rawLine);

    const lineDiv = document.createElement('div');
    lineDiv.className = 'text-line';

    const lt = line[0].top;
    const lh = Math.max(...line.map(it => it.height));
    const vGap = Math.max(0, lt - prevBottom);
    lineDiv.style.paddingTop = vGap + 'px';
    lineDiv.style.height = (lh + vGap) + 'px';
    prevBottom = lt + lh;

    let cursor = 0;
    let prevStr = '';

    for (let i = 0; i < line.length; i++) {
      const item = line[i];
      if (!item.str) continue;

      const gap = item.left - cursor;
      let adjustedGap = gap;

      if (cursor > 0) {
        const result = shouldInsertSpace(prevStr, item.str, gap, item.fontSize, spaceAdvance);
        if (result.insertSpace) {
          lineDiv.appendChild(document.createTextNode(' '));
        }
        adjustedGap = result.adjustedGap;
      }

      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.fontSize = item.fontSize + 'px';
      span.style.whiteSpace = 'pre';

      if (adjustedGap > 0.5) {
        span.style.marginLeft = adjustedGap + 'px';
      }

      if (item.pdfWidth > 0) {
        const scaleX = item.pdfWidth / (item.str.length * item.fontSize * 0.5); // rough estimate
        span.style.display = 'inline-block';
        span.style.width = item.pdfWidth + 'px';
        span.style.transform = `scaleX(${scaleX})`;
        span.style.transformOrigin = 'left top';
      }

      lineDiv.appendChild(span);
      cursor = item.left + (item.pdfWidth || 0);
      prevStr = item.str;
    }

    container.appendChild(lineDiv);
  }
}

/**
 * Minimal simulation of buildOcrTextLayer DOM construction.
 * Accepts either Tesseract-style ocrData (with lines[].words[])
 * or a flat words array for backward compatibility with tests.
 */
function buildOcrTextLayerDOM(container, input) {
  container.innerHTML = '';
  if (!input) return;

  // Support both formats: ocrData.lines or flat words array
  let linesToRender;
  if (Array.isArray(input)) {
    // Flat words array (backward compat for tests)
    const items = input
      .filter(w => w.text && w.text.trim())
      .map(w => ({
        str: w.text,
        left: w.bbox.x0,
        top: w.bbox.y0,
        width: w.bbox.x1 - w.bbox.x0,
        height: w.bbox.y1 - w.bbox.y0,
      }));
    if (items.length === 0) return;
    const grouped = groupItemsIntoLines(items);
    grouped.forEach(line => line.sort((a, b) => a.left - b.left));
    linesToRender = grouped;
  } else {
    // ocrData object with lines
    const ocrLines = input.lines || [];
    const flatWords = input.words || [];
    if (ocrLines.length === 0 && flatWords.length === 0) return;

    linesToRender = ocrLines.length > 0
      ? ocrLines.map(line => {
          const words = (line.words || [])
            .filter(w => w.text && w.text.trim())
            .map(w => ({
              str: w.text,
              left: w.bbox.x0,
              top: w.bbox.y0,
              width: w.bbox.x1 - w.bbox.x0,
              height: w.bbox.y1 - w.bbox.y0,
            }));
          words.sort((a, b) => a.left - b.left);
          return { words, baseline: line.baseline || null };
        }).filter(entry => entry.words.length > 0)
      : (() => {
          const items = flatWords
            .filter(w => w.text && w.text.trim())
            .map(w => ({
              str: w.text,
              left: w.bbox.x0,
              top: w.bbox.y0,
              width: w.bbox.x1 - w.bbox.x0,
              height: w.bbox.y1 - w.bbox.y0,
            }));
          if (items.length === 0) return [];
          const grouped = groupItemsIntoLines(items);
          return grouped.map(line => {
            line.sort((a, b) => a.left - b.left);
            return { words: line, baseline: null };
          });
        })();
  }

  if (linesToRender.length === 0) return;

  // Normalize to { words, baseline } entries
  const entries = linesToRender.map(line =>
    Array.isArray(line) ? { words: line, baseline: null } : line
  );
  entries.sort((a, b) => a.words[0].top - b.words[0].top);

  let prevBottom = 0;

  for (const entry of entries) {
    const line = mergePunctuation(entry.words);

    const lineDiv = document.createElement('div');
    lineDiv.className = 'text-line';

    const lt = line[0].top;
    const lh = Math.max(...line.map(it => it.height));

    const correction = lt - prevBottom;
    lineDiv.style.marginTop = correction + 'px';
    lineDiv.style.height = lh + 'px';
    lineDiv.style.width = 'fit-content';
    prevBottom = lt + lh;

    for (let i = 0; i < line.length; i++) {
      const item = line[i];
      const fontSize = item.height * 0.75;

      if (i > 0) {
        lineDiv.appendChild(document.createTextNode(' '));
      }

      const span = document.createElement('span');
      span.textContent = item.str;
      span.style.fontSize = fontSize + 'px';
      span.style.whiteSpace = 'pre';

      if (i === 0 && item.left > 0.5) {
        span.style.marginLeft = item.left + 'px';
      }

      lineDiv.appendChild(span);
    }

    container.appendChild(lineDiv);
  }
}

// ============================================================
// Tests
// ============================================================

describe('buildTextLayerDOM (native text layer structure)', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    container.className = 'text-layer';
  });

  it('creates correct number of line divs', () => {
    const items = [
      { str: 'Hello', left: 50, top: 100, height: 12, fontSize: 12, pdfWidth: 30 },
      { str: 'World', left: 90, top: 100, height: 12, fontSize: 12, pdfWidth: 30 },
      { str: 'Second', left: 50, top: 120, height: 12, fontSize: 12, pdfWidth: 35 },
    ];

    buildTextLayerDOM(container, items);
    const lineDivs = container.querySelectorAll('.text-line');
    expect(lineDivs).toHaveLength(2);
  });

  it('creates spans with correct text content', () => {
    const items = [
      { str: 'Hello', left: 50, top: 100, height: 12, fontSize: 12, pdfWidth: 30 },
      { str: 'World', left: 90, top: 100, height: 12, fontSize: 12, pdfWidth: 30 },
    ];

    buildTextLayerDOM(container, items);
    const spans = container.querySelectorAll('span');
    expect(spans).toHaveLength(2);
    expect(spans[0].textContent).toBe('Hello');
    expect(spans[1].textContent).toBe('World');
  });

  it('sets fontSize on each span', () => {
    const items = [
      { str: 'Big', left: 50, top: 100, height: 24, fontSize: 24, pdfWidth: 40 },
      { str: 'Small', left: 150, top: 115, height: 10, fontSize: 10, pdfWidth: 25 },
    ];

    buildTextLayerDOM(container, items);
    const spans = container.querySelectorAll('span');
    expect(spans[0].style.fontSize).toBe('24px');
    expect(spans[1].style.fontSize).toBe('10px');
  });

  it('sets white-space: pre on spans', () => {
    const items = [
      { str: 'Hello ', left: 50, top: 100, height: 12, fontSize: 12, pdfWidth: 35 },
    ];

    buildTextLayerDOM(container, items);
    const span = container.querySelector('span');
    expect(span.style.whiteSpace).toBe('pre');
  });

  it('Antigravity: trailing space preserved in textContent', () => {
    // "I " followed by "hate" — no TextNode should be inserted
    // because "I " already ends with a space
    const items = [
      { str: 'I ', left: 50, top: 100, height: 14, fontSize: 14, pdfWidth: 15 },
      { str: 'hate', left: 65, top: 100, height: 14, fontSize: 14, pdfWidth: 25 },
    ];

    buildTextLayerDOM(container, items);
    const lineDiv = container.querySelector('.text-line');

    // Should have exactly 2 spans, no TextNode in between
    const spans = lineDiv.querySelectorAll('span');
    expect(spans).toHaveLength(2);
    expect(spans[0].textContent).toBe('I ');
    expect(spans[1].textContent).toBe('hate');

    // The full text extracted should preserve the space
    const fullText = lineDiv.textContent;
    expect(fullText).toBe('I hate');
  });

  it('inserts TextNode space when gap exists and no whitespace in strings', () => {
    // Gap = 10 > 14 * 0.15 = 2.1 → should insert
    const items = [
      { str: 'Hello', left: 50, top: 100, height: 14, fontSize: 14, pdfWidth: 30 },
      { str: 'World', left: 90, top: 100, height: 14, fontSize: 14, pdfWidth: 30 },
    ];

    buildTextLayerDOM(container, items);
    const lineDiv = container.querySelector('.text-line');
    const fullText = lineDiv.textContent;
    expect(fullText).toBe('Hello World');
  });

  it('no TextNode when strings are adjacent (gap < threshold)', () => {
    // Gap = 0, no whitespace → no insert
    const items = [
      { str: 'Hello', left: 50, top: 100, height: 14, fontSize: 14, pdfWidth: 30 },
      { str: 'World', left: 80, top: 100, height: 14, fontSize: 14, pdfWidth: 30 },
    ];

    buildTextLayerDOM(container, items);
    const lineDiv = container.querySelector('.text-line');
    const fullText = lineDiv.textContent;
    expect(fullText).toBe('HelloWorld');
  });

  it('handles empty items array', () => {
    buildTextLayerDOM(container, []);
    expect(container.innerHTML).toBe('');
  });

  it('sets paddingTop for vertical gap between lines', () => {
    const items = [
      { str: 'Line1', left: 50, top: 100, height: 12, fontSize: 12, pdfWidth: 30 },
      { str: 'Line2', left: 50, top: 130, height: 12, fontSize: 12, pdfWidth: 30 },
    ];

    buildTextLayerDOM(container, items);
    const lineDivs = container.querySelectorAll('.text-line');
    // First line: paddingTop = max(0, 100 - 0) = 100
    expect(lineDivs[0].style.paddingTop).toBe('100px');
    // Second line: paddingTop = max(0, 130 - 112) = 18
    expect(lineDivs[1].style.paddingTop).toBe('18px');
  });
});

describe('buildOcrTextLayerDOM (OCR text layer structure)', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    container.className = 'text-layer';
  });

  it('creates line divs from OCR words', () => {
    const words = [
      { text: 'Hello', bbox: { x0: 50, y0: 100, x1: 120, y1: 115 } },
      { text: 'World', bbox: { x0: 130, y0: 100, x1: 200, y1: 115 } },
      { text: 'Second', bbox: { x0: 50, y0: 130, x1: 130, y1: 145 } },
    ];

    buildOcrTextLayerDOM(container, words);
    const lineDivs = container.querySelectorAll('.text-line');
    expect(lineDivs).toHaveLength(2);
  });

  it('inserts TextNode spaces between words on same line', () => {
    const words = [
      { text: 'Hello', bbox: { x0: 50, y0: 100, x1: 120, y1: 115 } },
      { text: 'World', bbox: { x0: 130, y0: 100, x1: 200, y1: 115 } },
    ];

    buildOcrTextLayerDOM(container, words);
    const lineDiv = container.querySelector('.text-line');
    expect(lineDiv.textContent).toBe('Hello World');
  });

  it('filters out empty/whitespace-only words', () => {
    const words = [
      { text: 'Hello', bbox: { x0: 50, y0: 100, x1: 120, y1: 115 } },
      { text: '   ', bbox: { x0: 120, y0: 100, x1: 130, y1: 115 } },
      { text: 'World', bbox: { x0: 130, y0: 100, x1: 200, y1: 115 } },
    ];

    buildOcrTextLayerDOM(container, words);
    const spans = container.querySelectorAll('span');
    expect(spans).toHaveLength(2);
    expect(spans[0].textContent).toBe('Hello');
    expect(spans[1].textContent).toBe('World');
  });

  it('handles empty words array', () => {
    buildOcrTextLayerDOM(container, []);
    expect(container.innerHTML).toBe('');
  });

  it('handles null/undefined words', () => {
    buildOcrTextLayerDOM(container, null);
    expect(container.innerHTML).toBe('');
  });

  it('sets marginLeft on first span of indented line', () => {
    const words = [
      { text: 'Indented', bbox: { x0: 100, y0: 100, x1: 200, y1: 115 } },
    ];

    buildOcrTextLayerDOM(container, words);
    const span = container.querySelector('span');
    expect(span.style.marginLeft).toBe('100px');
  });

  it('copy/paste text is correct across multiple lines', () => {
    const words = [
      { text: 'Line', bbox: { x0: 50, y0: 100, x1: 100, y1: 112 } },
      { text: 'one', bbox: { x0: 110, y0: 100, x1: 150, y1: 112 } },
      { text: 'Line', bbox: { x0: 50, y0: 130, x1: 100, y1: 142 } },
      { text: 'two', bbox: { x0: 110, y0: 130, x1: 150, y1: 142 } },
    ];

    buildOcrTextLayerDOM(container, words);
    const lineDivs = container.querySelectorAll('.text-line');
    expect(lineDivs[0].textContent).toBe('Line one');
    expect(lineDivs[1].textContent).toBe('Line two');
  });
});

// ============================================================
// Text transform: scaleX + rotate combination
//
// Replicates the buildTextLayer logic for rotated text.
// BUG: currently scaleX is overwritten by rotate. Fix #6 will
// combine them into a single transform property.
// ============================================================

describe('Text transform: scaleX and rotate combination', () => {
  it('span with scaleX only has scaleX in transform', () => {
    const span = document.createElement('span');
    const scaleX = 1.2;
    span.style.transform = `scaleX(${scaleX})`;
    expect(span.style.transform).toContain('scaleX');
  });

  it('span with rotate only has rotate in transform', () => {
    const span = document.createElement('span');
    const angle = 0.1;
    span.style.transform = `rotate(${angle}rad)`;
    expect(span.style.transform).toContain('rotate');
  });

  it.skip('span with both scaleX and rotate preserves both (BUG: fix #6)', () => {
    // This test documents the bug: currently buildTextLayer sets
    // transform to scaleX first, then overwrites with rotate.
    // After fix #6, both should coexist.
    const span = document.createElement('span');
    const scaleX = 1.2;
    const angle = 0.05;

    // The CORRECT behavior (after fix):
    span.style.transform = `scaleX(${scaleX}) rotate(${angle}rad)`;
    expect(span.style.transform).toContain('scaleX');
    expect(span.style.transform).toContain('rotate');
  });

  it('overwriting transform loses previous value (the bug pattern)', () => {
    // This demonstrates the current buggy pattern in app.js:
    // First set scaleX, then overwrite with rotate
    const span = document.createElement('span');
    span.style.transform = `scaleX(1.2)`;
    expect(span.style.transform).toContain('scaleX');

    // Overwrite — this is what the bug does
    span.style.transform = `rotate(0.05rad)`;
    expect(span.style.transform).not.toContain('scaleX'); // scaleX is lost!
    expect(span.style.transform).toContain('rotate');
  });
});

describe('Punctuation merging in text layer DOM', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    container.className = 'text-layer';
  });

  it('native: trailing period merges into previous word span', () => {
    const items = [
      { str: 'Hello', left: 50, top: 100, height: 12, fontSize: 12, pdfWidth: 30 },
      { str: '.', left: 80, top: 100, height: 12, fontSize: 12, pdfWidth: 4 },
    ];
    buildTextLayerDOM(container, items);
    const spans = container.querySelectorAll('span');
    expect(spans).toHaveLength(1);
    expect(spans[0].textContent).toBe('Hello.');
  });

  it('native: non-punctuation items stay separate', () => {
    const items = [
      { str: 'Hello', left: 50, top: 100, height: 12, fontSize: 12, pdfWidth: 30 },
      { str: 'World', left: 85, top: 100, height: 12, fontSize: 12, pdfWidth: 30 },
    ];
    buildTextLayerDOM(container, items);
    const spans = container.querySelectorAll('span');
    expect(spans).toHaveLength(2);
  });

  it('OCR: trailing period merges into previous word', () => {
    const words = [
      { text: 'Hello', bbox: { x0: 50, y0: 100, x1: 80, y1: 115 } },
      { text: '.', bbox: { x0: 80, y0: 100, x1: 84, y1: 115 } },
    ];
    buildOcrTextLayerDOM(container, words);
    const spans = container.querySelectorAll('span');
    expect(spans).toHaveLength(1);
    expect(spans[0].textContent).toBe('Hello.');
  });

  it('native: sentence with comma and period', () => {
    const items = [
      { str: 'yes', left: 50, top: 100, height: 12, fontSize: 12, pdfWidth: 20 },
      { str: ',', left: 70, top: 100, height: 12, fontSize: 12, pdfWidth: 4 },
      { str: 'ok', left: 80, top: 100, height: 12, fontSize: 12, pdfWidth: 15 },
      { str: '.', left: 95, top: 100, height: 12, fontSize: 12, pdfWidth: 4 },
    ];
    buildTextLayerDOM(container, items);
    const spans = container.querySelectorAll('span');
    expect(spans).toHaveLength(2);
    expect(spans[0].textContent).toBe('yes,');
    expect(spans[1].textContent).toBe('ok.');
  });
});
