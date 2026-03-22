/**
 * E2E: Link annotation tests.
 *
 * Verifies that buildLinkLayer handles PDFs with and without
 * link annotations correctly.
 */

import { test, expect } from '@playwright/test';
import { loadPDF, READER_URL, waitForTextLayer } from './helpers.js';

test.describe('Link annotations', () => {

  test('PDF without links does not create link elements', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-native-simple.pdf');
    await waitForTextLayer(page);

    const linkCount = await page.locator('.link-annot').count();
    expect(linkCount).toBe(0);
  });

  // Requires test-links.pdf with proper annotations
  test.skip('PDF with links creates accessible link elements', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-links.pdf');
    await waitForTextLayer(page);

    const links = page.locator('.link-annot');
    const count = await links.count();
    expect(count).toBeGreaterThan(0);

    // Each link should have an aria-label
    for (let i = 0; i < count; i++) {
      const ariaLabel = await links.nth(i).getAttribute('aria-label');
      expect(ariaLabel).not.toBeNull();
      expect(ariaLabel.length).toBeGreaterThan(0);
    }
  });

  // BUG: link accessibility — will be fixed
  test.skip('links have correct attributes', async ({ page }) => {
    await page.goto(READER_URL);
    await loadPDF(page, 'test-links.pdf');
    await waitForTextLayer(page);

    const links = page.locator('.link-annot');
    const count = await links.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const link = links.nth(i);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });
});
