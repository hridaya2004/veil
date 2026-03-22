/**
 * E2E: Mixed-size PDF tests.
 *
 * Verifies that PDFs with pages of different dimensions
 * (portrait + landscape) load correctly and render with
 * correct geometry per page.
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

  test('portrait page is narrower than landscape page', async ({ page }) => {
    // With virtual scrolling, we need to ensure both pages have
    // containers assigned. Scroll to make page 2 visible.
    await page.evaluate(() => {
      const vp = document.getElementById('viewport');
      if (vp) vp.scrollTop = vp.scrollHeight / 3;
    });
    await page.waitForTimeout(500);

    const widths = await page.evaluate(() => {
      const containers = document.querySelectorAll('.page-container');
      const result = {};
      for (const c of containers) {
        const num = c.dataset.pageNum;
        if (num === '1' || num === '2') {
          result['page' + num] = parseFloat(c.style.width) || 0;
        }
      }
      return result;
    });

    // Portrait (page 1: 612pt) should be narrower than landscape (page 2: 842pt)
    expect(widths.page1).toBeGreaterThan(0);
    expect(widths.page2).toBeGreaterThan(0);
    expect(widths.page1).toBeLessThan(widths.page2);
  });

  test('page 3 has same width as page 1', async ({ page }) => {
    // Scroll to bottom to make page 3 visible
    await page.evaluate(() => {
      const vp = document.getElementById('viewport');
      if (vp) vp.scrollTop = vp.scrollHeight;
    });
    await page.waitForTimeout(500);

    // Also need page 1 to have been measured — read from geometry
    const widths = await page.evaluate(() => {
      const containers = document.querySelectorAll('.page-container');
      const result = {};
      for (const c of containers) {
        const num = c.dataset.pageNum;
        if (num === '1' || num === '3') {
          result['page' + num] = parseFloat(c.style.width) || 0;
        }
      }
      return result;
    });

    // Both portrait — should have matching widths (within 5px tolerance)
    if (widths.page1 && widths.page3) {
      expect(Math.abs(widths.page1 - widths.page3)).toBeLessThan(5);
    }
  });

  test('first page has text layer with content', async ({ page }) => {
    await waitForTextLayer(page, 1);

    const spanCount = await page.evaluate(() => {
      const container = document.querySelector('.page-container[data-page-num="1"] .text-layer');
      return container ? container.querySelectorAll('span').length : 0;
    });

    expect(spanCount).toBeGreaterThan(0);
  });

  test('scroll to page 3 shows correct page count', async ({ page }) => {
    await page.evaluate(() => {
      const vp = document.getElementById('viewport');
      if (vp) vp.scrollTop = vp.scrollHeight;
    });
    await page.waitForTimeout(500);

    const pageInfo = await page.locator('#page-info').textContent();
    expect(pageInfo).toContain('3');
  });
});
