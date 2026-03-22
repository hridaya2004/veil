/**
 * E2E: Mixed-size PDF tests.
 *
 * Verifies that PDFs with pages of different dimensions
 * (portrait + landscape) load correctly and render text layers.
 */

import { test, expect } from '@playwright/test';
import { loadPDF, READER_URL, waitForTextLayer } from './helpers.js';

test.describe('Mixed-size PDF', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-mixed-sizes.pdf');
  });

  test('loads mixed-size PDF without crash', async ({ page }) => {
    const reader = page.locator('#reader');
    await expect(reader).toBeVisible();
  });

  // BUG: mixed-size geometry — will be fixed in commit 'fix: mixed-size PDF geometry'
  test.skip('portrait page is narrower than landscape page', async ({ page }) => {
    const widths = await page.evaluate(() => {
      const page1 = document.querySelector('.page-container[data-page-num="1"]');
      const page2 = document.querySelector('.page-container[data-page-num="2"]');
      return {
        page1: page1 ? page1.getBoundingClientRect().width : 0,
        page2: page2 ? page2.getBoundingClientRect().width : 0,
      };
    });

    // Portrait (page 1) should be narrower than landscape (page 2)
    expect(widths.page1).toBeLessThan(widths.page2);
  });

  // BUG: mixed-size geometry — will be fixed in commit 'fix: mixed-size PDF geometry'
  test.skip('page 3 has same width as page 1', async ({ page }) => {
    const widths = await page.evaluate(() => {
      const page1 = document.querySelector('.page-container[data-page-num="1"]');
      const page3 = document.querySelector('.page-container[data-page-num="3"]');
      return {
        page1: page1 ? page1.getBoundingClientRect().width : 0,
        page3: page3 ? page3.getBoundingClientRect().width : 0,
      };
    });

    // Page 1 and page 3 should both be portrait — same width
    expect(Math.abs(widths.page1 - widths.page3)).toBeLessThan(5);
  });

  test('first page has text layer with content', async ({ page }) => {
    // With virtual scrolling, only visible pages are rendered.
    // Page 1 should always be rendered after load.
    await waitForTextLayer(page, 1);

    const spanCount = await page.evaluate(() => {
      const container = document.querySelector('.page-container[data-page-num="1"] .text-layer');
      return container ? container.querySelectorAll('span').length : 0;
    });

    expect(spanCount).toBeGreaterThan(0);
  });

  // BUG: mixed-size geometry — will be fixed in commit 'fix: mixed-size PDF geometry'
  test.skip('scroll to page 3 shows correct page count', async ({ page }) => {
    // Scroll to the bottom of the document
    await page.evaluate(() => {
      const reader = document.getElementById('reader');
      reader.scrollTop = reader.scrollHeight;
    });
    await page.waitForTimeout(500);

    const pageInfo = await page.locator('#page-info').textContent();
    expect(pageInfo).toContain('3');
  });
});
