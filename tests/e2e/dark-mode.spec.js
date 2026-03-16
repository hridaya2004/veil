/**
 * E2E: Dark mode tests.
 *
 * Verifies dark mode toggle, CSS filter application,
 * and already-dark page detection.
 */

import { test, expect } from '@playwright/test';
import { loadPDF, waitForTextLayer, READER_URL } from './helpers.js';

test.describe('Dark mode (normal PDF)', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');
    await waitForTextLayer(page);
  });

  test('page canvas starts with dark-active class (dark mode on by default)', async ({ page }) => {
    const hasDarkActive = await page.evaluate(() => {
      const canvas = document.querySelector('.page-container[data-page-num="1"] .page-canvas');
      return canvas && canvas.classList.contains('dark-active');
    });
    expect(hasDarkActive).toBe(true);
  });

  test('page canvas has invert filter when dark mode is active', async ({ page }) => {
    const filter = await page.evaluate(() => {
      const canvas = document.querySelector('.page-container[data-page-num="1"] .page-canvas');
      return window.getComputedStyle(canvas).filter;
    });
    // Should contain "invert" in the filter
    expect(filter).toContain('invert');
  });

  test('overlay canvas is visible when dark mode is active', async ({ page }) => {
    const hasOverlayVisible = await page.evaluate(() => {
      const overlay = document.querySelector('.page-container[data-page-num="1"] .page-overlay');
      return overlay && overlay.classList.contains('overlay-visible');
    });
    expect(hasOverlayVisible).toBe(true);
  });

  test('toggle button switches dark mode off', async ({ page }) => {
    // Click the toggle button
    await page.locator('#btn-toggle').click();

    // Canvas should lose dark-active class
    const hasDarkActive = await page.evaluate(() => {
      const canvas = document.querySelector('.page-container[data-page-num="1"] .page-canvas');
      return canvas && canvas.classList.contains('dark-active');
    });
    expect(hasDarkActive).toBe(false);
  });

  test('toggle button cycles: dark → light → dark', async ({ page }) => {
    const btnToggle = page.locator('#btn-toggle');

    // Initial: dark mode on
    let dark = await page.evaluate(() =>
      document.querySelector('.page-canvas').classList.contains('dark-active')
    );
    expect(dark).toBe(true);

    // Toggle off
    await btnToggle.click();
    dark = await page.evaluate(() =>
      document.querySelector('.page-canvas').classList.contains('dark-active')
    );
    expect(dark).toBe(false);

    // Toggle back on
    await btnToggle.click();
    dark = await page.evaluate(() =>
      document.querySelector('.page-canvas').classList.contains('dark-active')
    );
    expect(dark).toBe(true);
  });
});

test.describe('Dark mode (already-dark PDF)', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-already-dark.pdf');
    await waitForTextLayer(page);
  });

  test('already-dark page does NOT have dark-active class (auto mode skips inversion)', async ({ page }) => {
    const hasDarkActive = await page.evaluate(() => {
      const canvas = document.querySelector('.page-container[data-page-num="1"] .page-canvas');
      return canvas && canvas.classList.contains('dark-active');
    });
    // Already-dark pages should NOT be inverted (they're already dark)
    expect(hasDarkActive).toBe(false);
  });

  test('force dark override still works on already-dark page', async ({ page }) => {
    // Click toggle to force dark mode on (it starts off because auto-detected as dark)
    await page.locator('#btn-toggle').click();

    const hasDarkActive = await page.evaluate(() => {
      const canvas = document.querySelector('.page-container[data-page-num="1"] .page-canvas');
      return canvas && canvas.classList.contains('dark-active');
    });
    expect(hasDarkActive).toBe(true);
  });
});
