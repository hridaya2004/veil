import { describe, it, expect } from 'vitest';

// ============================================================
// Link Sanitization
//
// Replicated from app.js for testability. Validates that URLs
// use only safe protocols before rendering as clickable links.
// ============================================================

const ALLOWED_PROTOCOLS = ['http:', 'https:', 'mailto:'];

function isAllowedUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ALLOWED_PROTOCOLS.includes(parsed.protocol);
  } catch { return false; }
}

describe('isAllowedUrl', () => {
  it('http://example.com → true', () => {
    expect(isAllowedUrl('http://example.com')).toBe(true);
  });

  it('https://example.com → true', () => {
    expect(isAllowedUrl('https://example.com')).toBe(true);
  });

  it('mailto:test@test.com → true', () => {
    expect(isAllowedUrl('mailto:test@test.com')).toBe(true);
  });

  it('javascript:alert(1) → false', () => {
    expect(isAllowedUrl('javascript:alert(1)')).toBe(false);
  });

  it('data:text/html,<h1>hi</h1> → false', () => {
    expect(isAllowedUrl('data:text/html,<h1>hi</h1>')).toBe(false);
  });

  it('custom-scheme://foo → false', () => {
    expect(isAllowedUrl('custom-scheme://foo')).toBe(false);
  });

  it('empty string → false', () => {
    expect(isAllowedUrl('')).toBe(false);
  });

  it('null → false', () => {
    expect(isAllowedUrl(null)).toBe(false);
  });

  it('not a url at all → false', () => {
    expect(isAllowedUrl('not a url at all')).toBe(false);
  });

  it('https://example.com/path?q=1#hash → true (complex URL)', () => {
    expect(isAllowedUrl('https://example.com/path?q=1#hash')).toBe(true);
  });
});
