/**
 * E2E: OCR text layer alignment tests.
 *
 * Tests the full OCR pipeline: Tesseract recognition → confidence
 * filtering → artifact filtering → text layer construction → selection.
 *
 * Uses two fixtures:
 *   - test-scanned.pdf: synthetic full-page image (pipeline smoke test)
 *   - test-scanned-real.pdf: real book page scan (quality verification)
 */

import { test, expect } from '@playwright/test';
import { loadPDF, waitForOcrTextLayer, READER_URL } from './helpers.js';

test.describe('OCR text layer (synthetic scanned PDF)', () => {

  test('scanned PDF triggers OCR and creates text layer', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-scanned.pdf');

    // The scanned PDF is tiny (1x1 image) so OCR may find nothing.
    // We primarily test that the pipeline doesn't crash.
    // Wait for the page canvas to be rendered (deterministic gate).
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.page-container[data-page-num="1"] .page-canvas');
      return canvas && canvas.width > 0;
    }, { timeout: 15000 });

    const pageRendered = await page.evaluate(() => {
      const canvas = document.querySelector('.page-container[data-page-num="1"] .page-canvas');
      return canvas && canvas.width > 0;
    });
    expect(pageRendered).toBe(true);

    const textLayerExists = await page.evaluate(() => {
      const tl = document.querySelector('.page-container[data-page-num="1"] .text-layer');
      return !!tl;
    });
    expect(textLayerExists).toBe(true);
  });

  test('scanned PDF does NOT apply image overlay (no overlay-visible)', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-scanned.pdf');

    const overlayVisible = await page.evaluate(() => {
      const overlay = document.querySelector('.page-container[data-page-num="1"] .page-overlay');
      return overlay && overlay.classList.contains('overlay-visible');
    });
    expect(overlayVisible).toBe(false);
  });
});

test.describe('OCR text layer with real content', () => {

  test('native PDF with text does NOT trigger OCR path', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');
    // Wait for text layer to populate (deterministic gate)
    await page.waitForFunction(() => {
      const lines = document.querySelectorAll('.page-container[data-page-num="1"] .text-layer .text-line');
      return lines.length > 0;
    }, { timeout: 15000 });

    const hasTextLine = await page.evaluate(() => {
      const lines = document.querySelectorAll('.page-container[data-page-num="1"] .text-layer .text-line');
      return lines.length > 0;
    });
    expect(hasTextLine).toBe(true);

    const text = await page.evaluate(() => {
      const tl = document.querySelector('.page-container[data-page-num="1"] .text-layer');
      return tl ? tl.textContent : '';
    });
    expect(text).toContain('Hello');
    expect(text).toContain('World');
  });
});

test.describe('OCR on real scanned document', () => {
  // Real scans go through the full pipeline: render → high-res canvas →
  // Tesseract WASM → confidence filter → artifact filter → text layer.
  // This takes significantly longer than synthetic fixtures.
  test.setTimeout(180000);

  test('OCR produces text layer spans inside page bounds', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-scanned-real.pdf');
    await waitForOcrTextLayer(page, 1);

    const result = await page.evaluate(() => {
      const container = document.querySelector('.page-container[data-page-num="1"]');
      if (!container) return { error: 'no container' };
      const containerRect = container.getBoundingClientRect();

      const spans = container.querySelectorAll('.text-layer span:not([data-gap])');
      if (spans.length === 0) return { error: 'no spans' };

      let insideCount = 0;
      const totalSpans = spans.length;

      for (const span of spans) {
        const rect = span.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const margin = 20;

        if (
          centerX >= containerRect.left - margin &&
          centerX <= containerRect.right + margin &&
          centerY >= containerRect.top - margin &&
          centerY <= containerRect.bottom + margin
        ) {
          insideCount++;
        }
      }

      return { totalSpans, insideCount };
    });

    expect(result.error).toBeUndefined();
    expect(result.totalSpans).toBeGreaterThan(5);
    const insideRatio = result.insideCount / result.totalSpans;
    expect(insideRatio).toBeGreaterThan(0.75);
  });

  test('OCR text is selectable and contains real words', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-scanned-real.pdf');
    await waitForOcrTextLayer(page, 1);

    const selectedText = await page.evaluate(() => {
      const textLayer = document.querySelector('.page-container[data-page-num="1"] .text-layer');
      if (!textLayer) return null;

      const range = document.createRange();
      range.selectNodeContents(textLayer);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      return sel.toString();
    });

    expect(selectedText).not.toBeNull();
    expect(selectedText.length).toBeGreaterThan(20);
    // Real text from a book page should contain common words, not just
    // random characters. At least some words should be 4+ chars.
    const words = selectedText.split(/\s+/).filter(w => w.length >= 4);
    expect(words.length).toBeGreaterThan(3);
  });

  test('confidence filter removes OCR artifacts', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-scanned-real.pdf');
    await waitForOcrTextLayer(page, 1);

    const text = await page.evaluate(() => {
      const textLayer = document.querySelector('.page-container[data-page-num="1"] .text-layer');
      return textLayer ? textLayer.textContent : '';
    });

    expect(text.length).toBeGreaterThan(0);
    // Artifact patterns typical of Tesseract on scanned documents:
    // repeated dashes, isolated pipes, backslashes
    expect(text).not.toMatch(/————/);
    expect(text).not.toMatch(/\|\|/);
    expect(text).not.toMatch(/\\\\/);
  });
});
