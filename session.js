// ============================================================
// veil — Session Persistence (Pure Storage Layer)
//
// IndexedDB operations for saving/loading PDF sessions.
// No DOM dependencies — pure data storage.
//
// The UI layer (restoreSession, showResumeButton) stays in
// app.js because it creates DOM elements and manages focus.
// ============================================================

const SESSION_DB_NAME = 'veil-session';
const SESSION_DB_VERSION = 1;
const SESSION_STORE = 'pdf';
export const SESSION_MAX_SIZE = 120 * 1024 * 1024; // 120MB
export const hasFileSystemAccess = 'showOpenFilePicker' in window;

function openSessionDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SESSION_DB_NAME, SESSION_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSession(data) {
  try {
    const db = await openSessionDB();
    const tx = db.transaction(SESSION_STORE, 'readwrite');
    const store = tx.objectStore(SESSION_STORE);
    store.clear();
    store.put(data, 'current');
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  } catch (e) { console.warn('[Session] saveSession failed:', e); }
}

export async function loadSession() {
  try {
    const db = await openSessionDB();
    const tx = db.transaction(SESSION_STORE, 'readonly');
    const store = tx.objectStore(SESSION_STORE);
    const req = store.get('current');
    const result = await new Promise((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = rej;
    });
    db.close();
    return result || null;
  } catch (e) {
    console.warn('[Session] loadSession failed:', e);
    return null;
  }
}

export async function clearSession() {
  try {
    const db = await openSessionDB();
    const tx = db.transaction(SESSION_STORE, 'readwrite');
    tx.objectStore(SESSION_STORE).clear();
    await new Promise((res) => { tx.oncomplete = res; });
    db.close();
  } catch (e) { console.warn('[Session] clearSession failed:', e); }
  localStorage.removeItem('veil-filename');
  localStorage.removeItem('veil-page');
  localStorage.removeItem('veil-dark-overrides');
}
