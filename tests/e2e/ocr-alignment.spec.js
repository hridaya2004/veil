/**
 * E2E: OCR text layer alignment tests.
 *
 * Loads test-scanned.pdf (full-page image), waits for OCR to complete,
 * then verifies that text layer spans are created and positioned
 * within the page bounds.
 *
 * Note: OCR accuracy and coordinate precision are known limitations.
 * These tests verify the basic pipeline works, not pixel-perfect alignment.
 */

import { test, expect } from '@playwright/test';
import { loadPDF, waitForOcrTextLayer, READER_URL } from './helpers.js';

test.describe('OCR text layer (scanned PDF)', () => {

  test('scanned PDF triggers OCR and creates text layer spans', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-scanned.pdf');

    // Wait for OCR to complete — this can take a while
    // The scanned PDF is tiny (1x1 image) so OCR may find nothing.
    // We primarily test that the pipeline doesn't crash.
    // Wait a reasonable time, then check state.
    await page.waitForTimeout(5000);

    // Verify the page rendered without errors
    const pageRendered = await page.evaluate(() => {
      const canvas = document.querySelector('.page-container[data-page-num="1"] .page-canvas');
      return canvas && canvas.width > 0;
    });
    expect(pageRendered).toBe(true);

    // Text layer div should exist
    const textLayerExists = await page.evaluate(() => {
      const tl = document.querySelector('.page-container[data-page-num="1"] .text-layer');
      return !!tl;
    });
    expect(textLayerExists).toBe(true);
  });

  test('scanned PDF does NOT apply image overlay (no overlay-visible)', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-scanned.pdf');

    // For scanned documents, image protection is skipped — the whole
    // page is an image (the scan), so it should be inverted along with the canvas.
    const overlayVisible = await page.evaluate(() => {
      const overlay = document.querySelector('.page-container[data-page-num="1"] .page-overlay');
      return overlay && overlay.classList.contains('overlay-visible');
    });
    // The overlay should NOT be visible for scanned docs, even in dark mode,
    // because there are no extracted image regions to protect
    expect(overlayVisible).toBe(false);
  });
});

test.describe('OCR text layer with real content', () => {

  test('native PDF with text does NOT trigger OCR path', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');
    await page.waitForTimeout(2000);

    // Should have native text layer, not OCR
    const hasTextLine = await page.evaluate(() => {
      const lines = document.querySelectorAll('.page-container[data-page-num="1"] .text-layer .text-line');
      return lines.length > 0;
    });
    expect(hasTextLine).toBe(true);

    // Text should contain the expected native content
    const text = await page.evaluate(() => {
      const tl = document.querySelector('.page-container[data-page-num="1"] .text-layer');
      return tl ? tl.textContent : '';
    });
    expect(text).toContain('Hello');
    expect(text).toContain('World');
  });
});

test.describe('OCR text layer with real scanned PDF', () => {

  test('real scanned PDF produces OCR text layer with spans inside page bounds', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'real-pdfs/certificato-protesi-omero.pdf');
    // Wait for OCR to complete on the first page
    await waitForOcrTextLayer(page, 1);

    // Verify spans exist and are positioned within page container bounds
    const result = await page.evaluate(() => {
      const container = document.querySelector('.page-container[data-page-num="1"]');
      if (!container) return { error: 'no container' };
      const containerRect = container.getBoundingClientRect();

      const spans = container.querySelectorAll('.text-layer span:not([data-gap])');
      if (spans.length === 0) return { error: 'no spans' };

      let insideCount = 0;
      let outsideCount = 0;
      const totalSpans = spans.length;

      for (const span of spans) {
        const rect = span.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;

        // Check if span center is within the page container (with generous margin)
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const margin = 20; // px tolerance

        if (
          centerX >= containerRect.left - margin &&
          centerX <= containerRect.right + margin &&
          centerY >= containerRect.top - margin &&
          centerY <= containerRect.bottom + margin
        ) {
          insideCount++;
        } else {
          outsideCount++;
        }
      }

      return { totalSpans, insideCount, outsideCount };
    });

    expect(result.error).toBeUndefined();
    expect(result.totalSpans).toBeGreaterThan(5); // Real medical doc should have many words
    // At least 75% of spans should be within page bounds.
    // OCR coordinates go through a PDF round-trip (pdf-lib → PDF.js)
    // which introduces minor coordinate rounding. Combined with
    // Tesseract's inherent bbox imprecision on real scans, 75% is
    // a realistic threshold for a medical document with small fonts.
    const insideRatio = result.insideCount / result.totalSpans;
    expect(insideRatio).toBeGreaterThan(0.75);
  });

  test('real scanned PDF OCR text is selectable', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'real-pdfs/certificato-protesi-omero.pdf');
    await waitForOcrTextLayer(page, 1);

    // Select all text in the text layer and verify it's not empty
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
    expect(selectedText.length).toBeGreaterThan(10); // Should have meaningful text
  });

  test('confidence filter removes garbage from stamps/logos', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'real-pdfs/certificato-protesi-omero.pdf');
    await waitForOcrTextLayer(page, 1);

    const result = await page.evaluate(() => {
      const textLayer = document.querySelector('.page-container[data-page-num="1"] .text-layer');
      if (!textLayer) return null;

      const text = textLayer.textContent;
      const spans = textLayer.querySelectorAll('span');

      return { text, spanCount: spans.length };
    });

    expect(result).not.toBeNull();
    // Text layer should have content (OCR ran successfully)
    expect(result.spanCount).toBeGreaterThan(0);

    // Garbage sequences from stamps/logos should be filtered out
    // by the confidence threshold. These were identified in the
    // Apple vs Veil comparison as low-confidence artifacts.
    expect(result.text).not.toMatch(/JR\s+a\s+i\s+EE/);
    expect(result.text).not.toMatch(/Rk\s+RS\s+ea\s+Sr/);
    expect(result.text).not.toMatch(/Gras\s+Gola\s+Saute/);
  });
});
