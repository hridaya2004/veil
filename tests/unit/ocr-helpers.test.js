import { describe, it, expect } from 'vitest';
import { OCR_CONFIDENCE_THRESHOLD, isOcrArtifact } from '../../core.js';

// ============================================================
// OCR Helpers
//
// hasValidOcrWords is private in ocr.js — replicated here for
// testability. resetOcrState logic is also replicated.
// ============================================================

function hasValidOcrWords(data) {
  return (data.words || []).some(
    w => w.text && w.text.trim() &&
         w.confidence >= OCR_CONFIDENCE_THRESHOLD &&
         !isOcrArtifact(w.text)
  );
}

function resetOcrState(queue, cache, fingerprints, preserveCache = false) {
  queue.forEach(j => { j.cancelled = true; });
  queue.length = 0;
  if (!preserveCache) {
    cache.clear();
    fingerprints.clear();
  }
}

// ============================================================
// hasValidOcrWords
// ============================================================

describe('hasValidOcrWords', () => {
  it('words with high confidence real text → true', () => {
    const data = { words: [
      { text: 'Hello', confidence: 90 },
      { text: 'World', confidence: 85 },
    ]};
    expect(hasValidOcrWords(data)).toBe(true);
  });

  it('all words below threshold → false', () => {
    const data = { words: [
      { text: 'Hello', confidence: 30 },
      { text: 'World', confidence: 20 },
    ]};
    expect(hasValidOcrWords(data)).toBe(false);
  });

  it('mixed: some above, some below → true', () => {
    const data = { words: [
      { text: 'noise', confidence: 10 },
      { text: 'Frattura', confidence: 92 },
      { text: 'junk', confidence: 5 },
    ]};
    expect(hasValidOcrWords(data)).toBe(true);
  });

  it('artifact words even with high confidence → false', () => {
    const data = { words: [
      { text: '|', confidence: 95 },
      { text: '——', confidence: 90 },
    ]};
    expect(hasValidOcrWords(data)).toBe(false);
  });

  it('empty words array → false', () => {
    expect(hasValidOcrWords({ words: [] })).toBe(false);
  });

  it('null data.words → false', () => {
    expect(hasValidOcrWords({ words: null })).toBe(false);
    expect(hasValidOcrWords({})).toBe(false);
  });

  it('single word at exactly threshold (45) → true', () => {
    const data = { words: [{ text: 'borderline', confidence: 45 }] };
    expect(hasValidOcrWords(data)).toBe(true);
  });

  it('single word at 44 → false', () => {
    const data = { words: [{ text: 'borderline', confidence: 44 }] };
    expect(hasValidOcrWords(data)).toBe(false);
  });
});

// ============================================================
// resetOcrState
// ============================================================

describe('resetOcrState', () => {
  it('clears queue and cancels jobs', () => {
    const queue = [{ cancelled: false }, { cancelled: false }];
    const cache = new Map([['key', 'val']]);
    const fingerprints = new Map([['fp', true]]);

    resetOcrState(queue, cache, fingerprints);

    expect(queue).toHaveLength(0);
    expect(queue.length).toBe(0);
  });

  it('marks all jobs as cancelled', () => {
    const job1 = { cancelled: false };
    const job2 = { cancelled: false };
    const queue = [job1, job2];

    resetOcrState(queue, new Map(), new Map());

    expect(job1.cancelled).toBe(true);
    expect(job2.cancelled).toBe(true);
  });

  it('clears cache and fingerprints by default', () => {
    const cache = new Map([['p1', 'data1'], ['p2', 'data2']]);
    const fingerprints = new Map([['fp1', true]]);

    resetOcrState([], cache, fingerprints);

    expect(cache.size).toBe(0);
    expect(fingerprints.size).toBe(0);
  });

  it('preserveCache=true keeps cache and fingerprints', () => {
    const cache = new Map([['p1', 'data1']]);
    const fingerprints = new Map([['fp1', true]]);

    resetOcrState([], cache, fingerprints, true);

    expect(cache.size).toBe(1);
    expect(fingerprints.size).toBe(1);
    expect(cache.get('p1')).toBe('data1');
  });

  it('empty inputs do not throw', () => {
    expect(() => resetOcrState([], new Map(), new Map())).not.toThrow();
    expect(() => resetOcrState([], new Map(), new Map(), true)).not.toThrow();
  });
});
