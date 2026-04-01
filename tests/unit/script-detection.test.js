import { describe, it, expect } from 'vitest';
import { detectScript, SCRIPT_RANGES } from '../../core.js';

describe('detectScript', () => {

  describe('returns latin for basic cases', () => {
    it('English text', () => expect(detectScript('Hello World')).toBe('latin'));
    it('French accents', () => expect(detectScript('café résumé')).toBe('latin'));
    it('German umlauts', () => expect(detectScript('über straße')).toBe('latin'));
    it('numbers only', () => expect(detectScript('12345')).toBe('latin'));
    it('empty string', () => expect(detectScript('')).toBe('latin'));
    it('null', () => expect(detectScript(null)).toBe('latin'));
    it('undefined', () => expect(detectScript(undefined)).toBe('latin'));
  });

  describe('Arabic', () => {
    it('base forms', () => expect(detectScript('بسم الله')).toBe('arabic'));
    it('presentation form A', () => expect(detectScript('\uFB50')).toBe('arabic'));
    it('presentation form B', () => expect(detectScript('\uFE70')).toBe('arabic'));
    it('mixed with latin', () => expect(detectScript('PDF بسم')).toBe('arabic'));
  });

  describe('Hebrew', () => {
    it('base forms', () => expect(detectScript('שלום עולם')).toBe('hebrew'));
    it('presentation forms', () => expect(detectScript('\uFB1D')).toBe('hebrew'));
  });

  describe('Indic scripts', () => {
    it('Devanagari (Hindi)', () => expect(detectScript('नमस्ते')).toBe('devanagari'));
    it('Bengali', () => expect(detectScript('বাংলা')).toBe('bengali'));
    it('Gurmukhi (Punjabi)', () => expect(detectScript('ਪੰਜਾਬੀ')).toBe('gurmukhi'));
    it('Gujarati', () => expect(detectScript('ગુજરાતી')).toBe('gujarati'));
    it('Tamil', () => expect(detectScript('தமிழ்')).toBe('tamil'));
    it('Telugu', () => expect(detectScript('తెలుగు')).toBe('telugu'));
    it('Kannada', () => expect(detectScript('ಕನ್ನಡ')).toBe('kannada'));
    it('Malayalam', () => expect(detectScript('മലയാളം')).toBe('malayalam'));
    it('Sinhala', () => expect(detectScript('සිංහල')).toBe('sinhala'));
  });

  describe('Southeast Asian', () => {
    it('Thai', () => expect(detectScript('สวัสดี')).toBe('thai'));
    it('Lao', () => expect(detectScript('ສະບາຍດີ')).toBe('lao'));
    it('Khmer', () => expect(detectScript('ខ្មែរ')).toBe('khmer'));
    it('Myanmar', () => expect(detectScript('မြန်မာ')).toBe('myanmar'));
  });

  describe('East Asian (CJK)', () => {
    it('Japanese hiragana', () => expect(detectScript('こんにちは')).toBe('japanese'));
    it('Japanese katakana', () => expect(detectScript('カタカナ')).toBe('japanese'));
    it('Korean hangul', () => expect(detectScript('한국어')).toBe('korean'));
    it('Chinese characters', () => expect(detectScript('中文测试')).toBe('cjk'));
  });

  describe('Other scripts', () => {
    it('Georgian', () => expect(detectScript('ქართული')).toBe('georgian'));
    it('Armenian', () => expect(detectScript('Հայերեն')).toBe('armenian'));
    it('Ethiopic', () => expect(detectScript('አማርኛ')).toBe('ethiopic'));
    it('Tibetan', () => expect(detectScript('བོད་སྐད')).toBe('tibetan'));
  });

  describe('priority: first non-latin script wins', () => {
    it('Arabic before latin', () => expect(detectScript('Hello بسم World')).toBe('arabic'));
    it('CJK in mixed text', () => expect(detectScript('Page 1: 中文')).toBe('cjk'));
  });

  describe('SCRIPT_RANGES has all 22 entries', () => {
    it('22 scripts defined', () => expect(SCRIPT_RANGES.length).toBe(22));
    it('each has name and test', () => {
      for (const r of SCRIPT_RANGES) {
        expect(r.name).toBeTruthy();
        expect(r.test).toBeInstanceOf(RegExp);
      }
    });
  });
});
