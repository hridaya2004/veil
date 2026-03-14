import { describe, it, expect } from 'vitest';
import { detectAlreadyDark, DARK_LUMINANCE_THRESHOLD } from '../../core.js';

/**
 * Creates a Uint8ClampedArray of RGBA pixel data filled with a single color.
 */
function makePixels(width, height, r, g, b, a = 255) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return data;
}

/**
 * Creates pixel data with different edge/center colors.
 * Edges get edgeColor, center gets centerColor.
 */
function makePixelsWithEdges(width, height, edgeR, edgeG, edgeB, centerR, centerG, centerB) {
  const data = new Uint8ClampedArray(width * height * 4);
  const margin = Math.max(5, Math.floor(Math.min(width, height) * 0.05));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const isEdge = x < margin || x >= width - margin || y < margin || y >= height - margin;

      if (isEdge) {
        data[idx] = edgeR;
        data[idx + 1] = edgeG;
        data[idx + 2] = edgeB;
      } else {
        data[idx] = centerR;
        data[idx + 1] = centerG;
        data[idx + 2] = centerB;
      }
      data[idx + 3] = 255;
    }
  }
  return data;
}

describe('detectAlreadyDark', () => {
  const W = 200;
  const H = 300;

  it('all white pixels → not dark', () => {
    const pixels = makePixels(W, H, 255, 255, 255);
    expect(detectAlreadyDark(pixels, W, H)).toBe(false);
  });

  it('all black pixels → dark', () => {
    const pixels = makePixels(W, H, 0, 0, 0);
    expect(detectAlreadyDark(pixels, W, H)).toBe(true);
  });

  it('dark gray edges → dark (below threshold)', () => {
    // Luminance of (30, 30, 30) = 0.118 → well below 0.4
    const pixels = makePixels(W, H, 30, 30, 30);
    expect(detectAlreadyDark(pixels, W, H)).toBe(true);
  });

  it('medium gray → not dark (above threshold)', () => {
    // Luminance of (140, 140, 140) = 0.549 → above 0.4
    const pixels = makePixels(W, H, 140, 140, 140);
    expect(detectAlreadyDark(pixels, W, H)).toBe(false);
  });

  it('dark edges with light center → dark (algorithm samples edges)', () => {
    // The algorithm specifically samples edges and corners.
    // Dark edges should make it detect as dark, regardless of center.
    const pixels = makePixelsWithEdges(W, H, 20, 20, 20, 240, 240, 240);
    expect(detectAlreadyDark(pixels, W, H)).toBe(true);
  });

  it('light edges with dark center → not dark (algorithm samples edges)', () => {
    const pixels = makePixelsWithEdges(W, H, 240, 240, 240, 20, 20, 20);
    expect(detectAlreadyDark(pixels, W, H)).toBe(false);
  });

  it('pure red has correct luminance (red contributes 0.299)', () => {
    // Pure red (255,0,0): luminance = 0.299 * 255 / 255 = 0.299 → below 0.4 → dark
    const pixels = makePixels(W, H, 255, 0, 0);
    expect(detectAlreadyDark(pixels, W, H)).toBe(true);
  });

  it('pure green has correct luminance (green contributes 0.587)', () => {
    // Pure green (0,255,0): luminance = 0.587 → above 0.4 → not dark
    const pixels = makePixels(W, H, 0, 255, 0);
    expect(detectAlreadyDark(pixels, W, H)).toBe(false);
  });

  it('handles very small canvas', () => {
    const pixels = makePixels(10, 10, 0, 0, 0);
    expect(detectAlreadyDark(pixels, 10, 10)).toBe(true);
  });

  it('threshold boundary: luminance just below 0.4 → dark', () => {
    // Target luminance = 0.39
    // Gray value where 0.299*g + 0.587*g + 0.114*g = 0.39*255
    // g = 0.39 * 255 = 99.45 ≈ 99
    const pixels = makePixels(W, H, 99, 99, 99);
    expect(detectAlreadyDark(pixels, W, H)).toBe(true);
  });

  it('threshold boundary: luminance just above 0.4 → not dark', () => {
    // Target luminance = 0.41
    // g = 0.41 * 255 = 104.55 ≈ 105
    const pixels = makePixels(W, H, 105, 105, 105);
    expect(detectAlreadyDark(pixels, W, H)).toBe(false);
  });
});
