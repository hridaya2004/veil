/**
 * E2E: Text layer alignment tests.
 *
 * Loads test-native-simple.pdf, verifies that text layer spans
 * exist and their bounding rects are in the correct approximate
 * positions relative to the rendered page.
 */

import { test, expect } from '@playwright/test';
import { loadPDF, waitForTextLayer, READER_URL } from './helpers.js';

test.describe('Text layer alignment (native PDF)', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');
    await waitForTextLayer(page);
  });

  test('text layer contains spans with expected text', async ({ page }) => {
    const spans = await page.locator('.page-container[data-page-num="1"] .text-layer span').all();
    expect(spans.length).toBeGreaterThan(0);

    // Collect all span text
    const texts = [];
    for (const span of spans) {
      texts.push(await span.textContent());
    }
    const fullText = texts.join(' ').replace(/\s+/g, ' ').trim();

    // The PDF contains "Hello World" and "The quick brown fox..."
    expect(fullText).toContain('Hello');
    expect(fullText).toContain('World');
    expect(fullText).toContain('quick');
    expect(fullText).toContain('brown');
    expect(fullText).toContain('fox');
  });

  test('text layer has multiple .text-line divs', async ({ page }) => {
    const lines = await page.locator('.page-container[data-page-num="1"] .text-layer .text-line').count();
    // At least 2 lines: title + paragraph (possibly 3 with second paragraph line)
    expect(lines).toBeGreaterThanOrEqual(2);
  });

  test('spans have non-zero bounding rects within page bounds', async ({ page }) => {
    const results = await page.evaluate(() => {
      const container = document.querySelector('.page-container[data-page-num="1"]');
      const containerRect = container.getBoundingClientRect();
      const spans = container.querySelectorAll('.text-layer span');

      return Array.from(spans).slice(0, 10).map(span => {
        const rect = span.getBoundingClientRect();
        return {
          text: span.textContent,
          width: rect.width,
          height: rect.height,
          // Position relative to page container
          relLeft: rect.left - containerRect.left,
          relTop: rect.top - containerRect.top,
          containerWidth: containerRect.width,
          containerHeight: containerRect.height,
        };
      });
    });

    for (const r of results) {
      // Each span should have non-zero dimensions
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);

      // Each span should be within the page container bounds (with some tolerance)
      expect(r.relLeft).toBeGreaterThanOrEqual(-5);
      expect(r.relTop).toBeGreaterThanOrEqual(-5);
      expect(r.relLeft).toBeLessThan(r.containerWidth + 5);
      expect(r.relTop).toBeLessThan(r.containerHeight + 5);
    }
  });

  test('title text appears above paragraph text', async ({ page }) => {
    const positions = await page.evaluate(() => {
      const container = document.querySelector('.page-container[data-page-num="1"]');
      const spans = container.querySelectorAll('.text-layer span');

      let titleTop = null;
      let paraTop = null;

      for (const span of spans) {
        const text = span.textContent.trim();
        const rect = span.getBoundingClientRect();
        if (text === 'Hello' || text.startsWith('Hello')) {
          titleTop = rect.top;
        }
        if (text === 'The' || text === 'quick') {
          paraTop = rect.top;
        }
      }
      return { titleTop, paraTop };
    });

    // Title should be above the paragraph (smaller top value)
    expect(positions.titleTop).not.toBeNull();
    expect(positions.paraTop).not.toBeNull();
    expect(positions.titleTop).toBeLessThan(positions.paraTop);
  });

  test('spans within same line have consistent vertical position', async ({ page }) => {
    const lineSpans = await page.evaluate(() => {
      const lines = document.querySelectorAll('.page-container[data-page-num="1"] .text-layer .text-line');
      // Find a line with multiple spans
      for (const line of lines) {
        const spans = line.querySelectorAll('span');
        if (spans.length >= 2) {
          return Array.from(spans).map(s => {
            const rect = s.getBoundingClientRect();
            return { text: s.textContent, top: rect.top, bottom: rect.bottom };
          });
        }
      }
      return null;
    });

    expect(lineSpans).not.toBeNull();
    // All spans in the same line should have tops within 5px of each other
    const tops = lineSpans.map(s => s.top);
    const maxTop = Math.max(...tops);
    const minTop = Math.min(...tops);
    expect(maxTop - minTop).toBeLessThan(10);
  });
});
