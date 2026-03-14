import { describe, it, expect } from 'vitest';
import {
  multiplyMatrices,
  transformPoint,
  computeImageBounds,
  IDENTITY_MATRIX,
} from '../../core.js';

// ============================================================
// multiplyMatrices
// ============================================================

describe('multiplyMatrices', () => {
  it('identity * identity = identity', () => {
    const result = multiplyMatrices(IDENTITY_MATRIX, IDENTITY_MATRIX);
    expect(result).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('identity * M = M', () => {
    const m = [2, 3, 4, 5, 10, 20];
    expect(multiplyMatrices(IDENTITY_MATRIX, m)).toEqual(m);
  });

  it('M * identity = M', () => {
    const m = [2, 3, 4, 5, 10, 20];
    expect(multiplyMatrices(m, IDENTITY_MATRIX)).toEqual(m);
  });

  it('translation * translation = composed translation', () => {
    const t1 = [1, 0, 0, 1, 10, 20];
    const t2 = [1, 0, 0, 1, 30, 40];
    const result = multiplyMatrices(t1, t2);
    expect(result).toEqual([1, 0, 0, 1, 40, 60]);
  });

  it('scale * scale = composed scale', () => {
    const s1 = [2, 0, 0, 3, 0, 0];
    const s2 = [4, 0, 0, 5, 0, 0];
    const result = multiplyMatrices(s1, s2);
    expect(result[0]).toBe(8);  // 2*4
    expect(result[3]).toBe(15); // 3*5
  });

  it('scale then translate applies scale to translation', () => {
    // Scale by 2, then translate by (10, 10)
    const scale = [2, 0, 0, 2, 0, 0];
    const translate = [1, 0, 0, 1, 10, 10];
    const result = multiplyMatrices(scale, translate);
    // The translation in the result is scaled: 2*10 = 20
    expect(result[4]).toBe(20);
    expect(result[5]).toBe(20);
  });

  it('90-degree rotation produces correct matrix', () => {
    // Rotate 90 degrees: [cos90, sin90, -sin90, cos90, 0, 0]
    const rot90 = [0, 1, -1, 0, 0, 0];
    const result = multiplyMatrices(rot90, rot90);
    // 180 degree rotation: [-1, 0, 0, -1, 0, 0]
    expect(result[0]).toBeCloseTo(-1);
    expect(result[1]).toBeCloseTo(0);
    expect(result[2]).toBeCloseTo(0);
    expect(result[3]).toBeCloseTo(-1);
  });
});

// ============================================================
// transformPoint
// ============================================================

describe('transformPoint', () => {
  it('identity preserves point', () => {
    expect(transformPoint(IDENTITY_MATRIX, 5, 7)).toEqual([5, 7]);
  });

  it('translation shifts point', () => {
    const t = [1, 0, 0, 1, 100, 200];
    expect(transformPoint(t, 5, 7)).toEqual([105, 207]);
  });

  it('scale doubles point', () => {
    const s = [2, 0, 0, 2, 0, 0];
    expect(transformPoint(s, 5, 7)).toEqual([10, 14]);
  });

  it('scale + translate', () => {
    const m = [2, 0, 0, 3, 10, 20];
    expect(transformPoint(m, 5, 7)).toEqual([20, 41]);
    // x: 2*5 + 0*7 + 10 = 20
    // y: 0*5 + 3*7 + 20 = 41
  });

  it('origin transforms to translation only', () => {
    const m = [2, 3, 4, 5, 10, 20];
    expect(transformPoint(m, 0, 0)).toEqual([10, 20]);
  });

  it('90-degree rotation', () => {
    const rot90 = [0, 1, -1, 0, 0, 0];
    const [x, y] = transformPoint(rot90, 1, 0);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1);
  });
});

// ============================================================
// computeImageBounds
// ============================================================

describe('computeImageBounds', () => {
  it('unit square at origin with identity transforms', () => {
    const bounds = computeImageBounds(IDENTITY_MATRIX, IDENTITY_MATRIX);
    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(0);
    expect(bounds.width).toBe(1);
    expect(bounds.height).toBe(1);
  });

  it('translated image', () => {
    const ctm = [1, 0, 0, 1, 100, 200];
    const bounds = computeImageBounds(ctm, IDENTITY_MATRIX);
    expect(bounds.x).toBe(100);
    expect(bounds.y).toBe(200);
    expect(bounds.width).toBe(1);
    expect(bounds.height).toBe(1);
  });

  it('scaled image', () => {
    const ctm = [200, 0, 0, 300, 50, 60];
    const bounds = computeImageBounds(ctm, IDENTITY_MATRIX);
    expect(bounds.x).toBe(50);
    expect(bounds.y).toBe(60);
    expect(bounds.width).toBe(200);
    expect(bounds.height).toBe(300);
  });

  it('viewport transform applies correctly', () => {
    // CTM places image at (100, 200) with size 50x50
    const ctm = [50, 0, 0, 50, 100, 200];
    // Viewport doubles everything
    const vp = [2, 0, 0, 2, 0, 0];
    const bounds = computeImageBounds(ctm, vp);
    expect(bounds.x).toBe(200);
    expect(bounds.y).toBe(400);
    expect(bounds.width).toBe(100);
    expect(bounds.height).toBe(100);
  });

  it('handles negative scale (flipped image)', () => {
    // Flipped horizontally: scale = [-200, 0, 0, 300, 250, 60]
    // Unit square corners map to:
    //   (0,0)->250,60  (1,0)->50,60  (1,1)->50,360  (0,1)->250,360
    const ctm = [-200, 0, 0, 300, 250, 60];
    const bounds = computeImageBounds(ctm, IDENTITY_MATRIX);
    expect(bounds.x).toBe(50);
    expect(bounds.y).toBe(60);
    expect(bounds.width).toBe(200);
    expect(bounds.height).toBe(300);
  });
});
