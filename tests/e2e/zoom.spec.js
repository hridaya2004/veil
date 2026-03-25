/**
 * E2E: Zoom tests.
 *
 * Verifies zoom in/out buttons update the displayed zoom level.
 */

import { test, expect } from '@playwright/test';
import { loadPDF, READER_URL } from './helpers.js';

async function waitForZoomChange(page, previousText) {
  await page.waitForFunction(
    (prev) => {
      const el = document.getElementById('zoom-level');
      return el && el.textContent !== prev;
    },
    previousText,
    { timeout: 10000 }
  );
}

test.describe('Zoom controls', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');
  });

  test('zoom in increases zoom level', async ({ page }) => {
    const initialZoom = await page.locator('#zoom-level').textContent();
    const initialValue = parseInt(initialZoom, 10);

    await page.locator('#btn-zoom-in').click({ force: true });
    await waitForZoomChange(page, initialZoom);

    const newZoom = await page.locator('#zoom-level').textContent();
    const newValue = parseInt(newZoom, 10);

    expect(newValue).toBeGreaterThan(initialValue);
  });

  test('zoom out decreases zoom level', async ({ page }) => {
    // Zoom in first to ensure we can zoom out
    const beforeZoomIn = await page.locator('#zoom-level').textContent();
    await page.locator('#btn-zoom-in').click({ force: true });
    await waitForZoomChange(page, beforeZoomIn);

    const afterZoomIn = await page.locator('#zoom-level').textContent();
    const zoomInValue = parseInt(afterZoomIn, 10);

    await page.locator('#btn-zoom-out').click({ force: true });
    await waitForZoomChange(page, afterZoomIn);

    const afterZoomOut = await page.locator('#zoom-level').textContent();
    const zoomOutValue = parseInt(afterZoomOut, 10);

    expect(zoomOutValue).toBeLessThan(zoomInValue);
  });

  test('zoom level is displayed', async ({ page }) => {
    const zoomText = await page.locator('#zoom-level').textContent();
    expect(zoomText).toContain('%');
  });
});
