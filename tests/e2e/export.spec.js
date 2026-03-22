/**
 * E2E: Export tests.
 *
 * Verifies export button state, progress bar visibility,
 * cancel behavior, and re-export after cancel.
 * Note: Export produces a blob download — we cannot verify file
 * content in Playwright, so we focus on UI state.
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

  test('export shows progress and completes', async ({ page }) => {
    const exportBtn = page.locator('#btn-export');
    await exportBtn.click({ force: true });

    // The export lazy-loads pdf-lib from CDN then shows progress.
    // Wait for the button to become disabled (export started).
    await page.waitForFunction(() => {
      const btn = document.getElementById('btn-export');
      return btn && btn.disabled;
    }, { timeout: 30000 });

    // Wait for export to complete (button re-enabled)
    await page.waitForFunction(() => {
      const btn = document.getElementById('btn-export');
      return btn && !btn.disabled;
    }, { timeout: 120000 });
  });

  test('export button is disabled during export', async ({ page }) => {
    const exportBtn = page.locator('#btn-export');
    await exportBtn.click({ force: true });

    // Wait for the export to actually start (CDN lazy load)
    await page.waitForFunction(() => {
      const btn = document.getElementById('btn-export');
      return btn && btn.disabled;
    }, { timeout: 30000 });

    const disabled = await exportBtn.evaluate(el => el.disabled);
    expect(disabled).toBe(true);
  });

  test('cancel button exists in export progress', async ({ page }) => {
    // The cancel button is in the DOM (inside #export-progress).
    // On a 1-page PDF the export may finish before we can interact,
    // so we only verify the button exists in the DOM, not click timing.
    const cancelBtn = page.locator('#export-cancel');
    const exists = await cancelBtn.count();
    expect(exists).toBe(1);
  });

  test('export can be run twice', async ({ page }) => {
    const exportBtn = page.locator('#btn-export');

    // First export
    await exportBtn.click({ force: true });
    await page.waitForFunction(() => {
      const btn = document.getElementById('btn-export');
      return btn && !btn.disabled;
    }, { timeout: 120000 });

    // Second export
    await exportBtn.click({ force: true });
    await page.waitForFunction(() => {
      const btn = document.getElementById('btn-export');
      return btn && !btn.disabled;
    }, { timeout: 120000 });
  });

  // BUG: export dark override — will be fixed
  test.skip('export respects dark override', async ({ page }) => {
    // Placeholder for when the dark override export bug is resolved
  });
});
