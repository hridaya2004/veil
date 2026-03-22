import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================
// Session Persistence
//
// happy-dom does not provide IndexedDB, so we polyfill a
// minimal in-memory implementation for testing.
// ============================================================

// ---- Minimal IndexedDB polyfill ----

function createFakeIndexedDB() {
  const databases = new Map();

  function open(name, version) {
    const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };

    setTimeout(() => {
      let db = databases.get(name);
      const isNew = !db;
      if (!db) {
        db = { stores: new Map(), name, version, objectStoreNames: { contains: (n) => db.stores.has(n) } };
        databases.set(name, db);
      }

      db.createObjectStore = (storeName) => {
        db.stores.set(storeName, new Map());
      };

      req.result = db;

      if (isNew && req.onupgradeneeded) {
        req.onupgradeneeded();
      }

      // Build the DB facade with transaction support
      req.result = {
        ...db,
        objectStoreNames: { contains: (n) => db.stores.has(n) },
        close() {},
        transaction(storeName, mode) {
          const store = db.stores.get(storeName) || new Map();
          db.stores.set(storeName, store);
          const tx = {
            oncomplete: null,
            onerror: null,
            objectStore() {
              return {
                get(key) {
                  const getReq = { result: undefined, onsuccess: null, onerror: null };
                  setTimeout(() => {
                    getReq.result = store.get(key);
                    if (getReq.onsuccess) getReq.onsuccess();
                  }, 0);
                  return getReq;
                },
                put(value, key) {
                  store.set(key, structuredClone(value));
                },
                clear() {
                  store.clear();
                },
              };
            },
          };
          // Auto-complete transaction on next tick
          setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 0);
          return tx;
        },
      };

      if (req.onsuccess) req.onsuccess();
    }, 0);

    return req;
  }

  return { open };
}

// Install the polyfill before importing session.js
globalThis.indexedDB = createFakeIndexedDB();

// Now import session functions (they reference indexedDB at call time)
const { saveSession, loadSession, clearSession, SESSION_MAX_SIZE, hasFileSystemAccess } = await import('../../session.js');

// ============================================================
// Tests
// ============================================================

describe('SESSION_MAX_SIZE', () => {
  it('equals 120 * 1024 * 1024 (120 MB)', () => {
    expect(SESSION_MAX_SIZE).toBe(120 * 1024 * 1024);
  });
});

describe('hasFileSystemAccess', () => {
  it('is a boolean', () => {
    expect(typeof hasFileSystemAccess).toBe('boolean');
  });
});

describe('session persistence (IndexedDB)', () => {
  beforeEach(async () => {
    await clearSession();
  });

  it('loadSession() on empty DB returns null', async () => {
    const result = await loadSession();
    expect(result).toBeNull();
  });

  it('saveSession() then loadSession() returns the data', async () => {
    const data = { type: 'buffer', buffer: new ArrayBuffer(10) };
    await saveSession(data);
    const result = await loadSession();
    expect(result).not.toBeNull();
    expect(result.type).toBe('buffer');
    expect(result.buffer.byteLength).toBe(10);
  });

  it('clearSession() then loadSession() returns null', async () => {
    await saveSession({ type: 'buffer', buffer: new ArrayBuffer(10) });
    await clearSession();
    const result = await loadSession();
    expect(result).toBeNull();
  });

  it('saveSession() twice overwrites (LRU 1 slot)', async () => {
    await saveSession({ type: 'first', buffer: new ArrayBuffer(5) });
    await saveSession({ type: 'second', buffer: new ArrayBuffer(8) });
    const result = await loadSession();
    expect(result).not.toBeNull();
    expect(result.type).toBe('second');
    expect(result.buffer.byteLength).toBe(8);
  });

  it('clearSession() also clears localStorage keys', async () => {
    localStorage.setItem('veil-filename', 'test.pdf');
    localStorage.setItem('veil-page', '5');
    localStorage.setItem('veil-dark-overrides', '{}');

    await clearSession();

    expect(localStorage.getItem('veil-filename')).toBeNull();
    expect(localStorage.getItem('veil-page')).toBeNull();
    expect(localStorage.getItem('veil-dark-overrides')).toBeNull();
  });

  it('saveSession() with string data round-trips', async () => {
    await saveSession({ type: 'handle', name: 'report.pdf' });
    const result = await loadSession();
    expect(result.type).toBe('handle');
    expect(result.name).toBe('report.pdf');
  });

  it('loadSession() after multiple clear+save cycles returns latest', async () => {
    await saveSession({ v: 1 });
    await clearSession();
    await saveSession({ v: 2 });
    await clearSession();
    await saveSession({ v: 3 });
    const result = await loadSession();
    expect(result.v).toBe(3);
  });

  it('clearSession() on empty DB does not throw', async () => {
    await clearSession();
    await clearSession();
    const result = await loadSession();
    expect(result).toBeNull();
  });

  it('saveSession() with nested object preserves structure', async () => {
    const data = { type: 'buffer', meta: { pages: 10, title: 'Test' } };
    await saveSession(data);
    const result = await loadSession();
    expect(result.meta.pages).toBe(10);
    expect(result.meta.title).toBe('Test');
  });

  it('clearSession() does not remove unrelated localStorage keys', async () => {
    localStorage.setItem('other-key', 'keep-me');
    await clearSession();
    expect(localStorage.getItem('other-key')).toBe('keep-me');
    localStorage.removeItem('other-key');
  });
});
