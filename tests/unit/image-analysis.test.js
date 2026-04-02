import { describe, it, expect } from 'vitest';
import {
  isBlankPaper,
  IMAGE_BLANK_PAPER_THRESHOLD,
  OCR_OVERLAY_COVERAGE_THRESHOLD,
  OCR_OVERLAY_CHAR_THRESHOLD,
} from '../../core.js';

// Helper: create a pixel array filled with a single RGB color
function solidPixels(w, h, r, g, b) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i+1] = g; data[i+2] = b; data[i+3] = 255;
  }
  return data;
}

// Helper: create pixels with a mix of two colors
function mixedPixels(w, h, r1, g1, b1, r2, g2, b2, ratio1) {
  const data = new Uint8ClampedArray(w * h * 4);
  const threshold = Math.floor(w * h * ratio1);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (count < threshold) {
      data[i] = r1; data[i+1] = g1; data[i+2] = b1;
    } else {
      data[i] = r2; data[i+1] = g2; data[i+2] = b2;
    }
    data[i+3] = 255;
    count++;
  }
  return data;
}


describe('isBlankPaper', () => {
  it('null input returns false', () => {
    expect(isBlankPaper(null, 0, 0)).toBe(false);
  });

  it('all white pixels = blank paper', () => {
    expect(isBlankPaper(solidPixels(100, 100, 255, 255, 255), 100, 100)).toBe(true);
  });

  it('all black pixels = not blank paper', () => {
    expect(isBlankPaper(solidPixels(100, 100, 0, 0, 0), 100, 100)).toBe(false);
  });

  it('90% white + 10% black = blank paper (scanned document)', () => {
    expect(isBlankPaper(mixedPixels(100, 100, 240, 240, 240, 20, 20, 20, 0.90), 100, 100)).toBe(true);
  });

  it('70% white + 30% black = not blank paper', () => {
    expect(isBlankPaper(mixedPixels(100, 100, 240, 240, 240, 20, 20, 20, 0.70), 100, 100)).toBe(false);
  });

  it('medium grey = not blank paper', () => {
    expect(isBlankPaper(solidPixels(100, 100, 128, 128, 128), 100, 100)).toBe(false);
  });

  it('bright photo (light blue sky) = not blank paper', () => {
    expect(isBlankPaper(solidPixels(100, 100, 180, 200, 230), 100, 100)).toBe(false);
  });

  it('colorful photo = not blank paper', () => {
    const pixels = new Uint8ClampedArray(100 * 100 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = (i * 7) % 256;
      pixels[i+1] = (i * 13) % 256;
      pixels[i+2] = (i * 19) % 256;
      pixels[i+3] = 255;
    }
    expect(isBlankPaper(pixels, 100, 100)).toBe(false);
  });

  it('boundary: 76% bright = blank paper', () => {
    expect(isBlankPaper(mixedPixels(100, 100, 210, 210, 210, 50, 50, 50, 0.76), 100, 100)).toBe(true);
  });

  it('boundary: 74% bright = not blank paper', () => {
    expect(isBlankPaper(mixedPixels(100, 100, 210, 210, 210, 50, 50, 50, 0.74), 100, 100)).toBe(false);
  });
});


describe('OCR overlay threshold constants', () => {
  it('coverage threshold', () => expect(OCR_OVERLAY_COVERAGE_THRESHOLD).toBe(0.40));
  it('char threshold', () => expect(OCR_OVERLAY_CHAR_THRESHOLD).toBe(200));
  it('blank paper threshold', () => expect(IMAGE_BLANK_PAPER_THRESHOLD).toBe(0.75));
});
