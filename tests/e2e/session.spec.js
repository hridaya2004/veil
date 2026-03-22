/**
 * E2E: Session persistence tests.
 *
 * Verifies that filename, page position, and resume state
 * are saved to and restored from localStorage.
 */

import { test, expect } from '@playwright/test';
import { loadPDF, READER_URL, FIXTURES_DIR } from './helpers.js';
import { join } from 'path';

test.describe('Session persistence', () => {

  test('saves filename to localStorage', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    const storedName = await page.evaluate(() =>
      localStorage.getItem('veil-filename')
    );
    expect(storedName).not.toBeNull();
    expect(storedName).toContain('test-native-simple');
  });

  test('saves page position on scroll', async ({ page }) => {
    await page.goto(READER_URL);
    // Use test-mixed-sizes.pdf which has 3 pages
    await loadPDF(page, 'test-mixed-sizes.pdf');

    // Scroll viewport to the bottom to trigger page change
    await page.evaluate(() => {
      const vp = document.getElementById('viewport');
      if (vp) vp.scrollTop = vp.scrollHeight;
    });

    // Wait for scroll debounce (1s) + margin
    await page.waitForTimeout(2000);

    const storedPage = await page.evaluate(() =>
      localStorage.getItem('veil-page')
    );
    expect(storedPage).not.toBeNull();
    expect(Number(storedPage)).toBeGreaterThan(1);
  });

  test('corrupted file does not poison session', async ({ page }) => {
    await page.goto(READER_URL);

    await page.waitForFunction(
      () => document.documentElement.dataset.appReady === 'true',
      { timeout: 30000 }
    );

    // Clear any pre-existing session data
    await page.evaluate(() => {
      localStorage.removeItem('veil-filename');
      localStorage.removeItem('veil-page');
    });

    // Load a fake PDF (valid name/MIME but invalid content)
    const fileInput = page.locator('#file-input');
    await fileInput.setInputFiles({
      name: 'corrupted.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('not a real PDF file content'),
    });

    // Wait for the error banner to appear (loadPDF failed)
    await page.waitForFunction(() => {
      const banner = document.getElementById('error-banner');
      return banner && !banner.hidden;
    }, { timeout: 15000 });

    // Verify filename was NOT saved to localStorage
    const savedName = await page.evaluate(() =>
      localStorage.getItem('veil-filename')
    );
    expect(savedName).toBeNull();
  });

  test('resume state exists after loading PDF', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    // After loading, localStorage should have the filename and page
    const data = await page.evaluate(() => ({
      filename: localStorage.getItem('veil-filename'),
      pageNum: localStorage.getItem('veil-page'),
    }));

    expect(data.filename).toBeTruthy();
    expect(data.pageNum).toBeTruthy();
  });
});
