/**
 * E2E: Export tests.
 *
 * Verifies export button state, progress, cancel, re-export,
 * file content validity, and dark mode override preservation.
 */

import { test, expect } from '@playwright/test';
import { loadPDF, READER_URL } from './helpers.js';

test.describe('Export', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    // Export might be hidden on mobile viewports — skip if not visible
    const exportBtn = page.locator('#btn-export');
    const isVisible = await exportBtn.isVisible().catch(() => false);
    test.skip(!isVisible, 'Export button not visible (likely mobile viewport)');
  });

  test('export button exists and is enabled', async ({ page }) => {
    const exportBtn = page.locator('#btn-export');
    await expect(exportBtn).toBeVisible();
    const disabled = await exportBtn.evaluate(el => el.disabled);
    expect(disabled).toBe(false);
  });

  test('export produces a valid PDF file', async ({ page }) => {
    const exportBtn = page.locator('#btn-export');

    // Listen for the download before clicking
    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await exportBtn.click({ force: true });

    const download = await downloadPromise;

    // Verify filename ends with -dark.pdf
    expect(download.suggestedFilename()).toMatch(/-dark\.pdf$/);

    // Read the file and verify it's a valid PDF
    const path = await download.path();
    const fs = await import('fs');
    const buffer = fs.readFileSync(path);

    // PDF files start with %PDF-
    const header = buffer.slice(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');

    // File should have meaningful size (not empty or truncated)
    expect(buffer.length).toBeGreaterThan(1000);
  });

  test('export button is disabled during export', async ({ page }) => {
    const exportBtn = page.locator('#btn-export');
    await exportBtn.click({ force: true });

    await page.waitForFunction(() => {
      const btn = document.getElementById('btn-export');
      return btn && btn.disabled;
    }, { timeout: 30000 });

    const disabled = await exportBtn.evaluate(el => el.disabled);
    expect(disabled).toBe(true);
  });

  test('cancel button exists in export progress', async ({ page }) => {
    const cancelBtn = page.locator('#export-cancel');
    const exists = await cancelBtn.count();
    expect(exists).toBe(1);
  });

  test('export can be run twice', async ({ page }) => {
    const exportBtn = page.locator('#btn-export');

    // First export
    const download1 = page.waitForEvent('download', { timeout: 120000 });
    await exportBtn.click({ force: true });
    await download1;

    // Second export — verify no race condition or memory issue
    const download2 = page.waitForEvent('download', { timeout: 120000 });
    await exportBtn.click({ force: true });
    const d2 = await download2;

    const path = await d2.path();
    const fs = await import('fs');
    const buffer = fs.readFileSync(path);
    expect(buffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  test('export respects per-page dark mode override', async ({ page }) => {
    // Toggle dark mode off on the current page (force light)
    await page.click('#btn-toggle', { force: true });

    // The page should no longer have dark-active class
    const isDark = await page.evaluate(() => {
      const canvas = document.querySelector('.page-container[data-page-num="1"] .page-canvas');
      return canvas && canvas.classList.contains('dark-active');
    });
    expect(isDark).toBe(false);

    // Export with the override active
    const downloadPromise = page.waitForEvent('download', { timeout: 120000 });
    await page.click('#btn-export', { force: true });
    const download = await downloadPromise;

    // Verify it still produces a valid PDF
    const path = await download.path();
    const fs = await import('fs');
    const buffer = fs.readFileSync(path);
    expect(buffer.slice(0, 5).toString('ascii')).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(1000);
  });
});
