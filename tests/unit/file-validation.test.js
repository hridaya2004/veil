import { describe, it, expect } from 'vitest';

// ============================================================
// File Validation
//
// Replicated from app.js handleFile() for testability.
// Uses case-insensitive .pdf extension check to handle
// Android/Windows uppercase filenames.
// ============================================================

function isValidPdfFile(file) {
  if (!file) return false;
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) return false;
  if (file.size > 512 * 1024 * 1024) return false;
  if (file.size === 0) return false;
  return true;
}

describe('isValidPdfFile', () => {
  it('valid PDF with correct MIME and extension → true', () => {
    expect(isValidPdfFile({ name: 'doc.pdf', type: 'application/pdf', size: 1000 })).toBe(true);
  });

  it('Android empty MIME but .pdf extension → true', () => {
    expect(isValidPdfFile({ name: 'doc.pdf', type: '', size: 1000 })).toBe(true);
  });

  it('wrong extension and wrong MIME → false', () => {
    expect(isValidPdfFile({ name: 'doc.txt', type: 'text/plain', size: 1000 })).toBe(false);
  });

  it('over 512 MB limit → false', () => {
    expect(isValidPdfFile({ name: 'doc.pdf', type: 'application/pdf', size: 512 * 1024 * 1024 + 1 })).toBe(false);
  });

  it('zero-byte file → false', () => {
    expect(isValidPdfFile({ name: 'doc.pdf', type: 'application/pdf', size: 0 })).toBe(false);
  });

  it('no extension and no MIME → false', () => {
    expect(isValidPdfFile({ name: 'doc', type: '', size: 1000 })).toBe(false);
  });

  it('uppercase .PDF extension → true (case-insensitive)', () => {
    expect(isValidPdfFile({ name: 'DOC.PDF', type: '', size: 1000 })).toBe(true);
  });

  it('filename with spaces → true', () => {
    expect(isValidPdfFile({ name: 'my file.pdf', type: 'application/pdf', size: 1000 })).toBe(true);
  });
});
