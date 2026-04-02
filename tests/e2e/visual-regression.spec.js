/**
 * E2E: Visual regression tests.
 *
 * These tests capture screenshots of specific UI elements and
 * compare them against golden reference images. They catch
 * rendering bugs that functional tests miss: wrong filter values,
 * z-index issues, broken overlay composition, CSS corruption.
 *
 * On first run, Playwright creates the golden screenshots in
 * the snapshots folder. Subsequent runs compare against them.
 * If a visual change is intentional, regenerate with:
 *   npx playwright test visual-regression --update-snapshots
 */

import { test, expect } from '@playwright/test';
import { loadPDF, READER_URL } from './helpers.js';


test.describe('Visual regression: dark mode', () => {

  test('dark mode ON renders correctly', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    // Wait for rendering to fully complete
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.page-canvas');
      const overlay = document.querySelector('.page-overlay');
      return canvas && canvas.width > 0 &&
             overlay && overlay.classList.contains('overlay-visible');
    }, { timeout: 15000 });

    // Screenshot just the page container (not the toolbar or chrome)
    const container = page.locator('.page-container').first();
    await expect(container).toHaveScreenshot('dark-mode-on.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('dark mode OFF renders correctly', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    await page.waitForFunction(() => {
      const canvas = document.querySelector('.page-canvas');
      return canvas && canvas.width > 0;
    }, { timeout: 15000 });

    // Toggle dark mode off
    await page.keyboard.press('d');
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.page-canvas');
      return canvas && !canvas.classList.contains('dark-active');
    }, { timeout: 5000 });

    const container = page.locator('.page-container').first();
    await expect(container).toHaveScreenshot('dark-mode-off.png', {
      maxDiffPixelRatio: 0.02,
    });
  });
});


test.describe('Visual regression: Paper Capture', () => {

  test('Paper Capture scan renders in dark mode', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'paper-capture.pdf');

    await page.waitForFunction(() => {
      const canvas = document.querySelector('.page-canvas');
      return canvas && canvas.width > 0;
    }, { timeout: 15000 });

    // Give a moment for the Paper Capture detection and rendering
    await page.waitForTimeout(1000);

    const container = page.locator('.page-container').first();
    await expect(container).toHaveScreenshot('paper-capture-dark.png', {
      maxDiffPixelRatio: 0.03,
    });
  });
});


test.describe('Visual regression: already-dark page', () => {

  test('already-dark page is NOT inverted', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-already-dark.pdf');

    await page.waitForFunction(() => {
      const canvas = document.querySelector('.page-canvas');
      return canvas && canvas.width > 0;
    }, { timeout: 15000 });

    const container = page.locator('.page-container').first();
    await expect(container).toHaveScreenshot('already-dark-preserved.png', {
      maxDiffPixelRatio: 0.02,
    });
  });
});


test.describe('Visual regression: drop zone', () => {

  test('drop zone renders correctly', async ({ page }) => {
    await page.goto(READER_URL);
    await page.waitForFunction(
      () => document.documentElement.dataset.appReady === 'true',
      { timeout: 15000 }
    );

    // Wait for fonts to load and layout to stabilize
    await page.waitForTimeout(500);

    const dropZone = page.locator('#drop-zone');
    await expect(dropZone).toHaveScreenshot('drop-zone.png', {
      maxDiffPixelRatio: 0.02,
    });
  });
});


test.describe('Visual regression: image protection', () => {

  test('protected image retains original colors in dark mode', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    await page.waitForFunction(() => {
      const canvas = document.querySelector('.page-canvas');
      const overlay = document.querySelector('.page-overlay');
      return canvas && canvas.width > 0 &&
             overlay && overlay.classList.contains('overlay-visible');
    }, { timeout: 15000 });

    // Screenshot the overlay canvas specifically to verify
    // the image pixels are original (not inverted)
    const overlay = page.locator('.page-overlay').first();
    await expect(overlay).toHaveScreenshot('image-protected-overlay.png', {
      maxDiffPixelRatio: 0.02,
    });
  });
});
