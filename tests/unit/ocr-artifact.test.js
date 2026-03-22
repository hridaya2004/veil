import { describe, it, expect } from 'vitest';
import { isOcrArtifact } from '../../core.js';

describe('isOcrArtifact', () => {

  describe('filters empty/null input', () => {
    it('null → artifact', () => expect(isOcrArtifact(null)).toBe(true));
    it('empty string → artifact', () => expect(isOcrArtifact('')).toBe(true));
    it('whitespace only → artifact', () => expect(isOcrArtifact('   ')).toBe(true));
  });

  describe('filters border/line artifacts (sequences of 2+ chars)', () => {
    it('"————" → artifact (horizontal line)', () => expect(isOcrArtifact('————')).toBe(true));
    it('"———" → artifact', () => expect(isOcrArtifact('———')).toBe(true));
    it('"--" → artifact', () => expect(isOcrArtifact('--')).toBe(true));
    it('"___" → artifact (underscores)', () => expect(isOcrArtifact('___')).toBe(true));
    it('"_—" → artifact (mixed)', () => expect(isOcrArtifact('_—')).toBe(true));
    it('"||" → artifact (double pipe)', () => expect(isOcrArtifact('||')).toBe(true));
    it('"//" → artifact', () => expect(isOcrArtifact('//')).toBe(true));
    it('"==" → artifact', () => expect(isOcrArtifact('==')).toBe(true));
    it('"~~" → artifact', () => expect(isOcrArtifact('~~')).toBe(true));
    it('"—_|" → artifact (mixed line chars)', () => expect(isOcrArtifact('—_|')).toBe(true));
  });

  describe('filters single "never standalone" characters', () => {
    it('"|" → artifact (pipe from border)', () => expect(isOcrArtifact('|')).toBe(true));
    it('"\\" → artifact (backslash from border)', () => expect(isOcrArtifact('\\')).toBe(true));
    it('"€" → artifact (isolated currency)', () => expect(isOcrArtifact('€')).toBe(true));
    it('"©" → artifact', () => expect(isOcrArtifact('©')).toBe(true));
    it('"®" → artifact', () => expect(isOcrArtifact('®')).toBe(true));
    it('"™" → artifact', () => expect(isOcrArtifact('™')).toBe(true));
    it('"°" → artifact', () => expect(isOcrArtifact('°')).toBe(true));
    it('"~" → artifact', () => expect(isOcrArtifact('~')).toBe(true));
    it('"^" → artifact', () => expect(isOcrArtifact('^')).toBe(true));
    it('"*" → artifact', () => expect(isOcrArtifact('*')).toBe(true));
    it('"_" → artifact', () => expect(isOcrArtifact('_')).toBe(true));
    it('"{|" → artifact (brace + pipe)', () => expect(isOcrArtifact('{|')).toBe(true));
    it('"<>" → artifact', () => expect(isOcrArtifact('<>')).toBe(true));
  });

  describe('preserves real content (words with letters/digits)', () => {
    it('"Hello" → real', () => expect(isOcrArtifact('Hello')).toBe(false));
    it('"12A1" → real', () => expect(isOcrArtifact('12A1')).toBe(false));
    it('"€50" → real (currency with number)', () => expect(isOcrArtifact('€50')).toBe(false));
    it('"#include" → real (code)', () => expect(isOcrArtifact('#include')).toBe(false));
    it('"C++" → real (programming language)', () => expect(isOcrArtifact('C++')).toBe(false));
    it('"a|b" → real (table content)', () => expect(isOcrArtifact('a|b')).toBe(false));
    it('"Dr." → real (abbreviation)', () => expect(isOcrArtifact('Dr.')).toBe(false));
    it('"3" → real (number)', () => expect(isOcrArtifact('3')).toBe(false));
    it('"A" → real (letter)', () => expect(isOcrArtifact('A')).toBe(false));
    it('"è" → real (Italian word "is")', () => expect(isOcrArtifact('è')).toBe(false));
    it('"ñ" → real (Spanish letter)', () => expect(isOcrArtifact('ñ')).toBe(false));
    it('"ü" → real (German letter)', () => expect(isOcrArtifact('ü')).toBe(false));
    it('"RUGGIERI" → real (name)', () => expect(isOcrArtifact('RUGGIERI')).toBe(false));
    it('"9/7.5" → real (measurement)', () => expect(isOcrArtifact('9/7.5')).toBe(false));
  });

  describe('preserves legitimate punctuation', () => {
    it('"-" → real (bullet point)', () => expect(isOcrArtifact('-')).toBe(false));
    it('"—" → real (em dash)', () => expect(isOcrArtifact('—')).toBe(false));
    it('"." → real (period)', () => expect(isOcrArtifact('.')).toBe(false));
    it('":" → real (colon)', () => expect(isOcrArtifact(':')).toBe(false));
    it('";" → real (semicolon)', () => expect(isOcrArtifact(';')).toBe(false));
    it('"!" → real (exclamation)', () => expect(isOcrArtifact('!')).toBe(false));
    it('"?" → real (question mark)', () => expect(isOcrArtifact('?')).toBe(false));
    it('"," → real (comma)', () => expect(isOcrArtifact(',')).toBe(false));
  });

  describe('preserves non-Latin scripts', () => {
    it('"患者" → real (Chinese)', () => expect(isOcrArtifact('患者')).toBe(false));
    it('"Пациент" → real (Russian)', () => expect(isOcrArtifact('Пациент')).toBe(false));
    it('"مريض" → real (Arabic)', () => expect(isOcrArtifact('مريض')).toBe(false));
  });

  describe('handles real artifacts from our diagnostic data', () => {
    // These were actually observed in real scanned medical document OCR output
    it('"_—" from page border', () => expect(isOcrArtifact('_—')).toBe(true));
    it('"{|" from form border', () => expect(isOcrArtifact('{|')).toBe(true));
    it('"————" from horizontal rule', () => expect(isOcrArtifact('————')).toBe(true));
    // These are garbled but contain letters → should NOT be filtered
    it('"BbA" garbled stamp → real (has letters)', () => expect(isOcrArtifact('BbA')).toBe(false));
    it('"TTT" garbled stamp → real (has letters)', () => expect(isOcrArtifact('TTT')).toBe(false));
    it('"SE" garbled → real (has letters)', () => expect(isOcrArtifact('SE')).toBe(false));
  });
});
