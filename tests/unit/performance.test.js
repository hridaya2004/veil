/**
 * Performance benchmarks for core functions.
 *
 * Run with: npx vitest bench
 *
 * These benchmarks establish baseline performance for critical
 * functions. If a refactoring makes any function significantly
 * slower, the benchmark results will show the regression.
 *
 * Thresholds are generous (3-5x current) to avoid flaky failures
 * on CI, but tight enough to catch a 10x slowdown.
 */

import { describe, it, expect } from 'vitest';
import {
  extractImageRegions,
  detectAlreadyDark,
  groupItemsIntoLines,
  isOcrArtifact,
  normalizeLigatures,
  mergePunctuation,
  shouldInsertSpace,
  calculateScale,
  detectLanguageFromText,
  isScannedPattern,
  IDENTITY_MATRIX,
} from '../../core.js';

// ============================================================
// Helpers — generate large inputs
// ============================================================

function makeOperatorList(count) {
  // Simulate a PDF page with many images
  const fnArray = [];
  const argsArray = [];
  const opsMap = {
    save: 10, restore: 11, transform: 12,
    paintFormXObjectBegin: 74, paintFormXObjectEnd: 75,
    paintImageXObject: 85, paintInlineImageXObject: 86,
    paintImageXObjectRepeat: 88,
  };

  for (let i = 0; i < count; i++) {
    fnArray.push(opsMap.save);
    argsArray.push([]);
    fnArray.push(opsMap.transform);
    argsArray.push([1, 0, 0, 1, i * 10, i * 10]);
    fnArray.push(opsMap.paintImageXObject);
    argsArray.push([`img_${i}`, 100, 100]);
    fnArray.push(opsMap.restore);
    argsArray.push([]);
  }

  return { fnArray, argsArray, opsMap };
}

function makePixels(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.random() * 255;
    data[i + 1] = Math.random() * 255;
    data[i + 2] = Math.random() * 255;
    data[i + 3] = 255;
  }
  return data;
}

function makeTextItems(count) {
  const items = [];
  let y = 0;
  for (let i = 0; i < count; i++) {
    if (i % 10 === 0) y += 20; // new line every 10 words
    items.push({
      str: `word${i}`,
      left: (i % 10) * 60,
      top: y,
      height: 14,
      fontSize: 14,
      pdfWidth: 40,
      width: 40,
    });
  }
  return items;
}

function makeOcrWords(count) {
  const words = [];
  for (let i = 0; i < count; i++) {
    // Mix real words and artifacts
    const isArtifact = i % 20 === 0;
    words.push(isArtifact ? '|' : `word${i}`);
  }
  return words;
}

// Replicated from app.js
function binarySearchFirstVisible(geometry, viewTop) {
  let lo = 1, hi = geometry.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const pg = geometry[mid];
    if (pg.offsetTop + pg.cssHeight < viewTop) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function makeGeometry(pageCount) {
  const geom = [null];
  let top = 0;
  for (let i = 1; i <= pageCount; i++) {
    geom.push({ offsetTop: top, cssHeight: 800, cssWidth: 600 });
    top += 840;
  }
  return geom;
}

// Replicated fingerprint logic
function fingerprint(data, width, height) {
  if (width < 8 || height < 8) return null;
  const stepX = Math.floor(width / 8);
  const stepY = Math.floor(height / 8);
  let hash = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const idx = ((y * stepY) * width + (x * stepX)) * 4;
      hash += ((data[idx] >> 4) << 8 | (data[idx + 1] >> 4) << 4 | (data[idx + 2] >> 4)).toString(36);
    }
  }
  return hash;
}

// ============================================================
// Performance threshold tests
//
// Each test runs the function once, measures time, and asserts
// it completes within a generous threshold. This catches 10x+
// regressions without being flaky on slow CI.
// ============================================================

describe('Performance: core function thresholds', () => {

  it('extractImageRegions — 1000 operators < 50ms', () => {
    const { fnArray, argsArray, opsMap } = makeOperatorList(250); // 250 images = 1000 ops
    const vt = [1, 0, 0, -1, 0, 800]; // typical viewport transform

    const start = performance.now();
    const regions = extractImageRegions({ fnArray, argsArray }, vt, opsMap);
    const elapsed = performance.now() - start;

    expect(regions.length).toBe(250);
    expect(elapsed).toBeLessThan(50);
  });

  it('detectAlreadyDark — 1000x1000 pixels < 20ms', () => {
    const pixels = makePixels(1000, 1000);

    const start = performance.now();
    detectAlreadyDark(pixels, 1000, 1000);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(20);
  });

  it('groupItemsIntoLines — 500 items < 30ms', () => {
    const items = makeTextItems(500);

    const start = performance.now();
    const lines = groupItemsIntoLines(items);
    const elapsed = performance.now() - start;

    expect(lines.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(30);
  });

  it('isOcrArtifact — 10000 words < 50ms', () => {
    const words = makeOcrWords(10000);

    const start = performance.now();
    let artifactCount = 0;
    for (const w of words) {
      if (isOcrArtifact(w)) artifactCount++;
    }
    const elapsed = performance.now() - start;

    expect(artifactCount).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(50);
  });

  it('normalizeLigatures — 10000 strings < 30ms', () => {
    const strings = Array.from({ length: 10000 }, (_, i) =>
      i % 100 === 0 ? 'e\uFB03cient' : `word${i}`
    );

    const start = performance.now();
    for (const s of strings) normalizeLigatures(s);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(30);
  });

  it('mergePunctuation — 200 lines of 10 items < 20ms', () => {
    const lines = [];
    for (let i = 0; i < 200; i++) {
      const line = [];
      for (let j = 0; j < 9; j++) {
        line.push({ str: `word${j}`, left: j * 60, width: 40, pdfWidth: 40 });
      }
      line.push({ str: '.', left: 540, width: 4, pdfWidth: 4 });
      lines.push(line);
    }

    const start = performance.now();
    for (const line of lines) mergePunctuation(line);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(20);
  });

  it('shouldInsertSpace — 50000 calls < 30ms', () => {
    const start = performance.now();
    for (let i = 0; i < 50000; i++) {
      shouldInsertSpace('Hello', 'World', 5, 14, 4);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(30);
  });

  it('calculateScale — 10000 calls < 10ms', () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      calculateScale(612, 792, 1280, 900, 48, 16, false);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(10);
  });

  it('binarySearchFirstVisible — 10000 pages < 5ms', () => {
    const geom = makeGeometry(10000);

    const start = performance.now();
    // Search 100 times at different positions
    for (let i = 0; i < 100; i++) {
      binarySearchFirstVisible(geom, i * 84000);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(5);
  });

  it('detectLanguageFromText — 100 texts < 30ms', () => {
    const texts = [
      'Il progetto è stato completato con successo nella giornata di ieri',
      'Le rapport a été soumis au comité de direction pour examen',
      'Die Ergebnisse der Studie wurden in der Fachzeitschrift veröffentlicht',
      'The results of the experiment were published in the journal',
      'Los resultados del estudio fueron publicados en la revista científica',
    ];

    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      detectLanguageFromText(texts[i % texts.length]);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(30);
  });

  it('fingerprint — 500x500 image from array < 5ms', () => {
    const pixels = makePixels(500, 500);

    const start = performance.now();
    const hash = fingerprint(pixels, 500, 500);
    const elapsed = performance.now() - start;

    expect(hash).toBeTruthy();
    expect(elapsed).toBeLessThan(5);
  });

  it('isScannedPattern — 1000 page samples < 5ms', () => {
    const samples = Array.from({ length: 1000 }, () => ({
      charCount: 10,
      maxImageCoverage: 0.9,
    }));

    const start = performance.now();
    isScannedPattern(samples);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(5);
  });
});
