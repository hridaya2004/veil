import { describe, it, expect } from 'vitest';
import { extractImageRegions, IDENTITY_MATRIX } from '../../core.js';

// Mock OPS codes — same numeric values as PDF.js
const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageXObjectRepeat: 88,
};

function makeOpList(entries) {
  const fnArray = [];
  const argsArray = [];
  for (const [op, args] of entries) {
    fnArray.push(op);
    argsArray.push(args || []);
  }
  return { fnArray, argsArray };
}

describe('extractImageRegions', () => {
  it('returns empty for empty operator list', () => {
    const opList = makeOpList([]);
    const result = extractImageRegions(opList, IDENTITY_MATRIX, OPS);
    expect(result).toEqual([]);
  });

  it('returns empty when no image ops present', () => {
    const opList = makeOpList([
      [OPS.save, []],
      [OPS.transform, [2, 0, 0, 2, 0, 0]],
      [OPS.restore, []],
    ]);
    const result = extractImageRegions(opList, IDENTITY_MATRIX, OPS);
    expect(result).toEqual([]);
  });

  it('detects paintImageXObject at identity', () => {
    const opList = makeOpList([
      [OPS.paintImageXObject, ['img_0', 100, 100]],
    ]);
    const result = extractImageRegions(opList, IDENTITY_MATRIX, OPS);
    expect(result).toHaveLength(1);
    expect(result[0].x).toBe(0);
    expect(result[0].y).toBe(0);
    expect(result[0].width).toBe(1);
    expect(result[0].height).toBe(1);
  });

  it('applies CTM from transform op', () => {
    const opList = makeOpList([
      [OPS.save, []],
      [OPS.transform, [200, 0, 0, 300, 50, 60]],
      [OPS.paintImageXObject, ['img_0', 200, 300]],
      [OPS.restore, []],
    ]);
    const result = extractImageRegions(opList, IDENTITY_MATRIX, OPS);
    expect(result).toHaveLength(1);
    expect(result[0].x).toBe(50);
    expect(result[0].y).toBe(60);
    expect(result[0].width).toBe(200);
    expect(result[0].height).toBe(300);
  });

  it('restores CTM after save/restore', () => {
    const opList = makeOpList([
      [OPS.save, []],
      [OPS.transform, [200, 0, 0, 300, 50, 60]],
      [OPS.paintImageXObject, ['img_0']],
      [OPS.restore, []],
      // After restore, CTM is back to identity
      [OPS.paintImageXObject, ['img_1']],
    ]);
    const result = extractImageRegions(opList, IDENTITY_MATRIX, OPS);
    expect(result).toHaveLength(2);
    // First image: transformed
    expect(result[0].x).toBe(50);
    expect(result[0].width).toBe(200);
    // Second image: identity
    expect(result[1].x).toBe(0);
    expect(result[1].width).toBe(1);
  });

  it('handles paintInlineImageXObject', () => {
    const opList = makeOpList([
      [OPS.transform, [100, 0, 0, 50, 10, 20]],
      [OPS.paintInlineImageXObject, [{}]],
    ]);
    const result = extractImageRegions(opList, IDENTITY_MATRIX, OPS);
    expect(result).toHaveLength(1);
    expect(result[0].x).toBe(10);
    expect(result[0].y).toBe(20);
    expect(result[0].width).toBe(100);
    expect(result[0].height).toBe(50);
  });

  it('handles paintImageXObjectRepeat with offsets', () => {
    const opList = makeOpList([
      // args: [name, width, height, dx1, dy1, dx2, dy2, ...]
      [OPS.paintImageXObjectRepeat, ['img_0', 10, 10, 100, 0, 200, 0]],
    ]);
    const result = extractImageRegions(opList, IDENTITY_MATRIX, OPS);
    // Should produce 2 regions (one per offset pair starting at index 3)
    expect(result).toHaveLength(2);
    expect(result[0].x).toBe(100);
    expect(result[1].x).toBe(200);
  });

  it('handles paintImageXObjectRepeat without offsets', () => {
    const opList = makeOpList([
      [OPS.paintImageXObjectRepeat, ['img_0', 10, 10]],
    ]);
    const result = extractImageRegions(opList, IDENTITY_MATRIX, OPS);
    expect(result).toHaveLength(1);
  });

  it('handles paintFormXObjectBegin/End with transform', () => {
    const opList = makeOpList([
      [OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 50, 100]]],
      [OPS.paintImageXObject, ['img_in_form']],
      [OPS.paintFormXObjectEnd, []],
      // After form end, CTM should be restored
      [OPS.paintImageXObject, ['img_after_form']],
    ]);
    const result = extractImageRegions(opList, IDENTITY_MATRIX, OPS);
    expect(result).toHaveLength(2);
    // Image inside form: translated by (50, 100)
    expect(result[0].x).toBe(50);
    expect(result[0].y).toBe(100);
    // Image after form: back to identity
    expect(result[1].x).toBe(0);
    expect(result[1].y).toBe(0);
  });

  it('applies viewport transform to all results', () => {
    const vpTransform = [2, 0, 0, 2, 10, 20];
    const opList = makeOpList([
      [OPS.transform, [100, 0, 0, 50, 30, 40]],
      [OPS.paintImageXObject, ['img_0']],
    ]);
    const result = extractImageRegions(opList, vpTransform, OPS);
    expect(result).toHaveLength(1);
    // CTM maps unit square to (30,40)-(130,90)
    // VP then doubles and translates: x = 2*30+10=70, y = 2*40+20=100
    expect(result[0].x).toBe(70);
    expect(result[0].y).toBe(100);
    expect(result[0].width).toBe(200); // 100*2
    expect(result[0].height).toBe(100);  // 50*2
  });

  it('handles nested save/restore correctly', () => {
    const opList = makeOpList([
      [OPS.save, []],
      [OPS.transform, [1, 0, 0, 1, 10, 0]],
      [OPS.save, []],
      [OPS.transform, [1, 0, 0, 1, 20, 0]],
      [OPS.paintImageXObject, ['img_inner']],
      [OPS.restore, []],
      // After inner restore: back to translate(10,0)
      [OPS.paintImageXObject, ['img_outer']],
      [OPS.restore, []],
      // After outer restore: identity
      [OPS.paintImageXObject, ['img_base']],
    ]);
    const result = extractImageRegions(opList, IDENTITY_MATRIX, OPS);
    expect(result).toHaveLength(3);
    expect(result[0].x).toBe(30); // 10 + 20
    expect(result[1].x).toBe(10); // only 10
    expect(result[2].x).toBe(0);  // identity
  });
});
