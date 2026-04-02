/**
 * E2E: Viewer robustness tests.
 *
 * Verifies edge cases in the viewer: dark mode persistence,
 * file validation, focus mode, and ctx.filter support.
 */

import { test, expect } from '@playwright/test';
import { loadPDF, READER_URL, FIXTURES_DIR } from './helpers.js';
import { join } from 'path';


test.describe('Dark mode persistence', () => {

  test('dark mode is on by default and toggle switches it off', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    // Dark mode on by default
    const hasDark = await page.evaluate(() => {
      const canvas = document.querySelector('.page-canvas');
      return canvas && canvas.classList.contains('dark-active');
    });
    expect(hasDark).toBe(true);

    // Toggle off via keyboard shortcut (avoids toolbar visibility issues)
    await page.keyboard.press('d');

    // Wait for the class to be removed
    const darkOff = await page.waitForFunction(() => {
      const canvas = document.querySelector('.page-canvas');
      return canvas && !canvas.classList.contains('dark-active');
    }, { timeout: 5000 }).catch(() => false);
    expect(darkOff).toBeTruthy();

    // Toggle back on
    await page.keyboard.press('d');
    const darkOn = await page.waitForFunction(() => {
      const canvas = document.querySelector('.page-canvas');
      return canvas && canvas.classList.contains('dark-active');
    }, { timeout: 5000 }).catch(() => false);
    expect(darkOn).toBeTruthy();
  });
});


test.describe('Focus mode', () => {

  test('toolbar hides after inactivity', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    // Ensure toolbar is visible first
    await page.mouse.move(640, 20);
    await page.waitForFunction(() => {
      const toolbar = document.getElementById('toolbar');
      return toolbar && !toolbar.classList.contains('toolbar-hidden');
    }, { timeout: 5000 });

    // Move mouse away from toolbar zone
    await page.mouse.move(640, 450);

    // Wait for auto-hide (1.5s on desktop)
    const hidden = await page.waitForFunction(() => {
      const toolbar = document.getElementById('toolbar');
      return toolbar && toolbar.classList.contains('toolbar-hidden');
    }, { timeout: 5000 }).catch(() => false);
    expect(hidden).toBeTruthy();
  });

  test('toolbar reappears when mouse moves to top zone', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    // Trigger auto-hide
    await page.mouse.move(640, 450);
    await page.waitForFunction(() => {
      const toolbar = document.getElementById('toolbar');
      return toolbar && toolbar.classList.contains('toolbar-hidden');
    }, { timeout: 5000 });

    // Move to top zone and dwell
    await page.mouse.move(640, 15);

    const visible = await page.waitForFunction(() => {
      const toolbar = document.getElementById('toolbar');
      return toolbar && !toolbar.classList.contains('toolbar-hidden');
    }, { timeout: 5000 }).catch(() => false);
    expect(visible).toBeTruthy();
  });
});


test.describe('ctx.filter support', () => {

  test('Chromium supports ctx.filter for dark mode rendering', async ({ page }) => {
    await page.goto(READER_URL);
    await page.waitForFunction(
      () => document.documentElement.dataset.appReady === 'true',
      { timeout: 15000 }
    );

    // Reproduce the same feature detection the app uses:
    // render a red pixel, apply invert(1), check if it becomes cyan
    const works = await page.evaluate(() => {
      const src = document.createElement('canvas');
      src.width = 1; src.height = 1;
      const sCtx = src.getContext('2d');
      sCtx.fillStyle = '#ff0000';
      sCtx.fillRect(0, 0, 1, 1);

      const dst = document.createElement('canvas');
      dst.width = 1; dst.height = 1;
      const dCtx = dst.getContext('2d');
      dCtx.filter = 'invert(1)';
      dCtx.drawImage(src, 0, 0);
      dCtx.filter = 'none';

      const p = dCtx.getImageData(0, 0, 1, 1).data;
      return p[0] < 128 && p[1] > 128; // red became cyan
    });

    // Playwright uses Chromium which supports ctx.filter
    expect(works).toBe(true);
  });
});


test.describe('Canvas pool integrity', () => {

  test('export cancel does not leak canvas resources', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');

    const exportBtn = page.locator('#btn-export');
    const isVisible = await exportBtn.isVisible().catch(() => false);
    test.skip(!isVisible, 'Export button not visible');

    // Start export
    await exportBtn.click({ force: true });

    // Wait for progress
    await page.waitForFunction(() => {
      const el = document.getElementById('export-progress');
      return el && !el.hidden;
    }, { timeout: 10000 });

    // Cancel
    const cancelBtn = page.locator('#export-cancel');
    await cancelBtn.click({ force: true });

    // Wait for cleanup
    await page.waitForFunction(() => {
      const el = document.getElementById('export-progress');
      return el && el.hidden;
    }, { timeout: 10000 });

    // Export button should be enabled (not stuck in disabled state)
    const disabled = await exportBtn.evaluate(el => el.disabled);
    expect(disabled).toBe(false);

    // Page should still be visible and functional
    const canvasVisible = await page.evaluate(() => {
      const canvas = document.querySelector('.page-canvas');
      return canvas && canvas.width > 0;
    });
    expect(canvasVisible).toBe(true);
  });
});
