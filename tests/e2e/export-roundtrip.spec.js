/**
 * E2E: Export round-trip tests.
 *
 * These tests export a PDF, reload the exported file into PDF.js,
 * and verify the text content. This catches regressions that only
 * appear in the exported PDF (line order, character encoding,
 * script support) and cannot be caught by unit tests.
 */

import { test, expect } from '@playwright/test';
import { loadPDF, READER_URL, FIXTURES_DIR } from './helpers.js';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Export the current PDF and return the file bytes.
 * Waits for the download event triggered by the export button.
 */
async function exportAndGetBytes(page) {
  const exportBtn = page.locator('#btn-export');
  const isVisible = await exportBtn.isVisible().catch(() => false);
  if (!isVisible) return null;

  const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
  await exportBtn.click({ force: true });
  const download = await downloadPromise;
  const path = await download.path();
  const fs = await import('fs');
  return fs.readFileSync(path);
}

/**
 * Load a PDF buffer into PDF.js in the browser and extract text
 * content from the first page. Returns an array of text items
 * with str and transform.
 */
async function extractTextFromPdf(page, pdfBytes) {
  const base64 = pdfBytes.toString('base64');

  return await page.evaluate(async (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const pdfjsLib = window.pdfjsLib;
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const numPages = doc.numPages;

    const pages = [];
    for (let p = 1; p <= numPages; p++) {
      const pg = await doc.getPage(p);
      const tc = await pg.getTextContent();
      const items = tc.items
        .filter(it => it.str && it.str.trim())
        .map(it => ({
          str: it.str,
          y: it.transform[5],
          x: it.transform[4],
          dir: it.dir || 'ltr',
        }));
      pages.push(items);
    }

    await doc.destroy();
    return pages;
  }, base64);
}


test.describe('Export round-trip: line order', () => {

  test('exported PDF has lines in top-to-bottom order (English)', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    const exportBtn = page.locator('#btn-export');
    const isVisible = await exportBtn.isVisible().catch(() => false);
    test.skip(!isVisible, 'Export button not visible');

    const pdfBytes = await exportAndGetBytes(page);
    expect(pdfBytes).toBeTruthy();
    expect(pdfBytes.length).toBeGreaterThan(1000);

    const pages = await extractTextFromPdf(page, pdfBytes);
    expect(pages.length).toBeGreaterThan(0);

    const items = pages[0];
    expect(items.length).toBeGreaterThan(1);

    // In PDF space Y increases upward. The first item extracted should
    // have a HIGHER Y value (top of page) than the last item (bottom).
    // This verifies lines are in top-to-bottom reading order
    const firstY = items[0].y;
    const lastY = items[items.length - 1].y;
    expect(firstY).toBeGreaterThan(lastY);
  });
});


test.describe('Export round-trip: Arabic text', () => {

  test('exported Arabic PDF has correct characters (not replacement)', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'arabic.pdf');

    const exportBtn = page.locator('#btn-export');
    const isVisible = await exportBtn.isVisible().catch(() => false);
    test.skip(!isVisible, 'Export button not visible');

    const pdfBytes = await exportAndGetBytes(page);
    expect(pdfBytes).toBeTruthy();

    const pages = await extractTextFromPdf(page, pdfBytes);
    expect(pages.length).toBeGreaterThan(0);

    const allText = pages[0].map(it => it.str).join(' ');

    // Verify Arabic characters are present (not replacement characters)
    const hasArabic = /[\u0600-\u06FF]/.test(allText);
    expect(hasArabic).toBe(true);

    // Verify no replacement characters (U+FFFD)
    const hasReplacement = /\uFFFD/.test(allText);
    expect(hasReplacement).toBe(false);
  });

  test('exported Arabic PDF has lines in top-to-bottom order', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'arabic.pdf');

    const exportBtn = page.locator('#btn-export');
    const isVisible = await exportBtn.isVisible().catch(() => false);
    test.skip(!isVisible, 'Export button not visible');

    const pdfBytes = await exportAndGetBytes(page);
    expect(pdfBytes).toBeTruthy();

    const pages = await extractTextFromPdf(page, pdfBytes);
    expect(pages.length).toBeGreaterThan(0);

    const items = pages[0];
    expect(items.length).toBeGreaterThan(1);

    // Same check as English: first item Y > last item Y
    const firstY = items[0].y;
    const lastY = items[items.length - 1].y;
    expect(firstY).toBeGreaterThan(lastY);
  });

  test('exported Arabic PDF has lines not fragmented (runs not single words)', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'arabic.pdf');

    const exportBtn = page.locator('#btn-export');
    const isVisible = await exportBtn.isVisible().catch(() => false);
    test.skip(!isVisible, 'Export button not visible');

    const pdfBytes = await exportAndGetBytes(page);
    expect(pdfBytes).toBeTruthy();

    const pages = await extractTextFromPdf(page, pdfBytes);
    const items = pages[0];

    // At least some items should contain spaces (multi-word runs)
    const multiWordItems = items.filter(it => it.str.includes(' '));
    expect(multiWordItems.length).toBeGreaterThan(0);
  });

  test('exported Arabic PDF has correct word content (not reversed)', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'arabic.pdf');

    const exportBtn = page.locator('#btn-export');
    const isVisible = await exportBtn.isVisible().catch(() => false);
    test.skip(!isVisible, 'Export button not visible');

    const pdfBytes = await exportAndGetBytes(page);
    expect(pdfBytes).toBeTruthy();

    const pages = await extractTextFromPdf(page, pdfBytes);
    const allText = pages[0].map(it => it.str).join(' ');

    // These Arabic words should appear in the correct form, not reversed.
    // If characters were reversed, "المقال" would become "لاقملا"
    expect(allText).toContain('المقال');
    expect(allText).toContain('العلمية');

    // Reversed forms should NOT be present
    expect(allText).not.toContain('لاقملا');
    expect(allText).not.toContain('ةيملعلا');
  });

  test('exported Arabic PDF handles mixed Arabic/Latin lines correctly', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'arabic.pdf');

    const exportBtn = page.locator('#btn-export');
    const isVisible = await exportBtn.isVisible().catch(() => false);
    test.skip(!isVisible, 'Export button not visible');

    const pdfBytes = await exportAndGetBytes(page);
    expect(pdfBytes).toBeTruthy();

    const pages = await extractTextFromPdf(page, pdfBytes);
    const allText = pages[0].map(it => it.str).join(' ');

    // The document contains mixed Arabic/Latin content (IMRAD, title, etc.)
    // Both scripts should be present and not corrupted
    const hasArabic = /[\u0600-\u06FF]/.test(allText);
    const hasLatin = /[a-zA-Z]/.test(allText);
    expect(hasArabic).toBe(true);
    expect(hasLatin).toBe(true);
  });
});


test.describe('Export round-trip: Paper Capture detection', () => {

  test('Paper Capture PDF has text content after export', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'paper-capture.pdf');

    const exportBtn = page.locator('#btn-export');
    const isVisible = await exportBtn.isVisible().catch(() => false);
    test.skip(!isVisible, 'Export button not visible');

    const pdfBytes = await exportAndGetBytes(page);
    expect(pdfBytes).toBeTruthy();

    const pages = await extractTextFromPdf(page, pdfBytes);
    expect(pages.length).toBe(2);

    // Both pages should have text (the OCR text layer from the scan)
    expect(pages[0].length).toBeGreaterThan(0);
    expect(pages[1].length).toBeGreaterThan(0);

    // Text should contain actual words, not just symbols
    const allText = pages[0].map(it => it.str).join(' ');
    expect(allText.length).toBeGreaterThan(50);
  });

  test('Paper Capture export has lines in top-to-bottom order', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'paper-capture.pdf');

    const exportBtn = page.locator('#btn-export');
    const isVisible = await exportBtn.isVisible().catch(() => false);
    test.skip(!isVisible, 'Export button not visible');

    const pdfBytes = await exportAndGetBytes(page);
    expect(pdfBytes).toBeTruthy();

    const pages = await extractTextFromPdf(page, pdfBytes);
    const items = pages[0];
    expect(items.length).toBeGreaterThan(1);

    // First item Y > last item Y (top-to-bottom in PDF space)
    const firstY = items[0].y;
    const lastY = items[items.length - 1].y;
    expect(firstY).toBeGreaterThan(lastY);
  });
});


test.describe('Export round-trip: image protection', () => {

  test('native PDF with images keeps overlay visible (images protected)', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    // Wait for rendering to complete
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.page-canvas');
      return canvas && canvas.width > 0;
    }, { timeout: 15000 });

    // The overlay should be visible (image is protected from inversion)
    const overlayVisible = await page.evaluate(() => {
      const overlay = document.querySelector('.page-overlay');
      if (!overlay) return false;
      return overlay.classList.contains('overlay-visible');
    });
    expect(overlayVisible).toBe(true);
  });
});
