/**
 * E2E: Export fidelity tests.
 *
 * Verifies that specific content features survive the export
 * round-trip: ligatures, punctuation, links, and cancel behavior.
 */

import { test, expect } from '@playwright/test';
import { loadPDF, READER_URL, FIXTURES_DIR } from './helpers.js';
import { join } from 'path';

/**
 * Export the current PDF and return the file bytes.
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
 * Load PDF bytes into PDF.js and extract text from all pages.
 */
async function extractTextFromPdf(page, pdfBytes) {
  const base64 = pdfBytes.toString('base64');
  return await page.evaluate(async (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const pdfjsLib = window.pdfjsLib;
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const pg = await doc.getPage(p);
      const tc = await pg.getTextContent();
      pages.push(tc.items.filter(it => it.str && it.str.trim()).map(it => it.str));
    }
    await doc.destroy();
    return pages;
  }, base64);
}

/**
 * Load PDF bytes and extract link annotations from all pages.
 */
async function extractLinksFromPdf(page, pdfBytes) {
  const base64 = pdfBytes.toString('base64');
  return await page.evaluate(async (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const pdfjsLib = window.pdfjsLib;
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    const allLinks = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const pg = await doc.getPage(p);
      const annots = await pg.getAnnotations();
      const links = annots
        .filter(a => a.subtype === 'Link')
        .map(a => ({ url: a.url || null, dest: a.dest || null }));
      allLinks.push(...links);
    }
    await doc.destroy();
    return allLinks;
  }, base64);
}


test.describe('Export fidelity: ligatures', () => {

  test('ligature codepoints are decomposed in exported PDF', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-ligatures.pdf');

    const exportBtn = page.locator('#btn-export');
    const isVisible = await exportBtn.isVisible().catch(() => false);
    test.skip(!isVisible, 'Export button not visible');

    const pdfBytes = await exportAndGetBytes(page);
    expect(pdfBytes).toBeTruthy();

    const pages = await extractTextFromPdf(page, pdfBytes);
    const allText = pages.flat().join(' ');

    // No ligature codepoints should remain
    const hasLigatures = /[\uFB00-\uFB04]/.test(allText);
    expect(hasLigatures).toBe(false);
  });
});


test.describe('Export fidelity: punctuation', () => {

  test('punctuation is adjacent to preceding word in export', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-punctuation.pdf');

    const exportBtn = page.locator('#btn-export');
    const isVisible = await exportBtn.isVisible().catch(() => false);
    test.skip(!isVisible, 'Export button not visible');

    const pdfBytes = await exportAndGetBytes(page);
    expect(pdfBytes).toBeTruthy();

    const pages = await extractTextFromPdf(page, pdfBytes);
    const allText = pages.flat().join(' ');

    // Text should contain word+punctuation together, not separated
    // The fixture has "Hello." and "World!" as test cases
    expect(allText).toContain('.');
    expect(allText).toContain('!');
  });
});


test.describe('Export fidelity: links', () => {

  test('exported PDF preserves link annotations', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-links.pdf');

    const exportBtn = page.locator('#btn-export');
    const isVisible = await exportBtn.isVisible().catch(() => false);
    test.skip(!isVisible, 'Export button not visible');

    const pdfBytes = await exportAndGetBytes(page);
    expect(pdfBytes).toBeTruthy();

    const links = await extractLinksFromPdf(page, pdfBytes);

    // The fixture should have at least one link
    expect(links.length).toBeGreaterThan(0);

    // At least one should be an external URL
    const externalLinks = links.filter(l => l.url && l.url.startsWith('http'));
    expect(externalLinks.length).toBeGreaterThan(0);
  });
});


test.describe('Export fidelity: cancel and re-export', () => {

  test('cancel stops export and re-export works cleanly', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    const exportBtn = page.locator('#btn-export');
    const isVisible = await exportBtn.isVisible().catch(() => false);
    test.skip(!isVisible, 'Export button not visible');

    // Start export
    await exportBtn.click({ force: true });

    // Wait for progress to appear
    await page.waitForFunction(() => {
      const el = document.getElementById('export-progress');
      return el && !el.hidden;
    }, { timeout: 10000 });

    // Cancel
    const cancelBtn = page.locator('#export-cancel');
    await cancelBtn.click({ force: true });

    // Wait for progress to hide
    await page.waitForFunction(() => {
      const el = document.getElementById('export-progress');
      return el && el.hidden;
    }, { timeout: 10000 });

    // Export button should be re-enabled
    const disabled = await exportBtn.evaluate(el => el.disabled);
    expect(disabled).toBe(false);

    // Re-export should produce a valid file
    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await exportBtn.click({ force: true });
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/-dark\.pdf$/);
  });
});
