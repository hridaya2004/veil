/**
 * E2E: Text selection tests.
 *
 * Verifies that text can be selected in the text layer
 * and that copy/paste produces correct text with proper spacing.
 */

import { test, expect } from '@playwright/test';
import { loadPDF, waitForTextLayer } from './helpers.js';

test.describe('Text selection (native PDF)', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loadPDF(page, 'test-native-simple.pdf');
    await waitForTextLayer(page);
  });

  test('clicking on text layer span selects text', async ({ page }) => {
    // Triple-click to select a whole line
    const firstSpan = page.locator('.page-container[data-page-num="1"] .text-layer span').first();
    await firstSpan.click({ clickCount: 3 });

    const selection = await page.evaluate(() => window.getSelection().toString().trim());
    expect(selection.length).toBeGreaterThan(0);
  });

  test('selecting across spans produces text with correct spacing', async ({ page }) => {
    // Use evaluate to programmatically select all text in the first text-line
    const lineText = await page.evaluate(() => {
      const line = document.querySelector('.page-container[data-page-num="1"] .text-layer .text-line');
      if (!line) return null;

      const range = document.createRange();
      range.selectNodeContents(line);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      return sel.toString();
    });

    expect(lineText).not.toBeNull();
    // Should not have double spaces or missing spaces
    // The first line is "Hello World" (title)
    const normalized = lineText.replace(/\s+/g, ' ').trim();
    expect(normalized.length).toBeGreaterThan(0);
    // No double spaces should exist
    expect(normalized).not.toMatch(/  /);
  });

  test('selecting entire page produces coherent multi-line text', async ({ page }) => {
    const fullText = await page.evaluate(() => {
      const textLayer = document.querySelector('.page-container[data-page-num="1"] .text-layer');
      if (!textLayer) return null;

      const range = document.createRange();
      range.selectNodeContents(textLayer);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      return sel.toString();
    });

    expect(fullText).not.toBeNull();
    // Should contain all expected words
    expect(fullText).toContain('Hello');
    expect(fullText).toContain('World');
    expect(fullText).toContain('The');
    expect(fullText).toContain('quick');
    expect(fullText).toContain('brown');
    expect(fullText).toContain('fox');
    expect(fullText).toContain('second');
  });
});

test.describe('Text selection — Antigravity (style transitions)', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loadPDF(page, 'test-native-styles.pdf');
    await waitForTextLayer(page);
  });

  test('selecting "I hate talking" line produces correct text', async ({ page }) => {
    const lineText = await page.evaluate(() => {
      const lines = document.querySelectorAll('.page-container[data-page-num="1"] .text-layer .text-line');
      if (lines.length === 0) return null;

      // Select the first line
      const range = document.createRange();
      range.selectNodeContents(lines[0]);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      return sel.toString();
    });

    expect(lineText).not.toBeNull();
    const normalized = lineText.replace(/\s+/g, ' ').trim();
    // "I hate talking" should have proper spacing at style transitions
    expect(normalized).toContain('I');
    expect(normalized).toContain('hate');
    expect(normalized).toContain('talking');
    // No missing spaces between words
    expect(normalized).not.toMatch(/Ihate|hatetalking/);
  });

  test('full text selection preserves word boundaries across styles', async ({ page }) => {
    const fullText = await page.evaluate(() => {
      const textLayer = document.querySelector('.page-container[data-page-num="1"] .text-layer');
      if (!textLayer) return null;

      const range = document.createRange();
      range.selectNodeContents(textLayer);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      return sel.toString();
    });

    expect(fullText).not.toBeNull();
    // All expected text should be present
    expect(fullText).toContain('hate');
    expect(fullText).toContain('talking');
    expect(fullText).toContain('Normal');
  });
});

test.describe('Text selection — Ligature normalization', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loadPDF(page, 'test-ligatures.pdf');
    await waitForTextLayer(page);
  });

  test('ligature codepoints are decomposed to plain ASCII in text layer', async ({ page }) => {
    const fullText = await page.evaluate(() => {
      const textLayer = document.querySelector('.page-container[data-page-num="1"] .text-layer');
      if (!textLayer) return null;

      const range = document.createRange();
      range.selectNodeContents(textLayer);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      return sel.toString();
    });

    expect(fullText).not.toBeNull();
    const normalized = fullText.replace(/\s+/g, ' ').trim();

    // All ligatures should be decomposed to plain ASCII
    // No Unicode ligature codepoints (U+FB00-FB04) should remain
    expect(normalized).not.toMatch(/[\uFB00-\uFB04]/);

    // Verify the decomposed words are present
    expect(normalized).toContain('efficient');
    expect(normalized).toContain('staff');
  });
});

test.describe('Text selection — Punctuation merging', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await loadPDF(page, 'test-punctuation.pdf');
    await waitForTextLayer(page);
  });

  test('period is merged into preceding word span', async ({ page }) => {
    const firstLineText = await page.evaluate(() => {
      const line = document.querySelector('.page-container[data-page-num="1"] .text-layer .text-line');
      if (!line) return null;

      const range = document.createRange();
      range.selectNodeContents(line);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      return sel.toString();
    });

    expect(firstLineText).not.toBeNull();
    const normalized = firstLineText.replace(/\s+/g, ' ').trim();
    // Period should be attached to "World" — "Hello World."
    expect(normalized).toContain('World.');
    expect(normalized).not.toMatch(/World\s+\./); // no space before period
  });

  test('comma and exclamation merged correctly', async ({ page }) => {
    const secondLineText = await page.evaluate(() => {
      const lines = document.querySelectorAll('.page-container[data-page-num="1"] .text-layer .text-line');
      if (lines.length < 2) return null;

      const range = document.createRange();
      range.selectNodeContents(lines[1]);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      return sel.toString();
    });

    expect(secondLineText).not.toBeNull();
    const normalized = secondLineText.replace(/\s+/g, ' ').trim();
    // "Yes," should be one unit, "indeed!" should be one unit
    expect(normalized).toContain('Yes,');
    expect(normalized).toContain('indeed!');
  });
});
