/* DESIGN
   ------
   * This file handles saving and loading PDF sessions in IndexedDB.
   * No DOM, no UI, just pure storage operations.
   *
   * I chose IndexedDB over localStorage because localStorage has a ~5MB
   * limit and a PDF can be 100MB+. IndexedDB can store large binary
   * blobs (ArrayBuffers) without serialization overhead.
   *
   * Only one PDF is stored at a time: every save clears the previous
   * entry first. I chose this over keeping multiple PDFs because on
   * mobile each stored PDF must be deserialized into RAM at boot.
   * Two 60MB PDFs would spike the heap to 120MB+ before the UI even
   * renders, risking a Jetsam kill on budget devices.
   *
   * The 120MB cap exists for the same reason: deserializing a 350MB
   * PDF from IndexedDB at startup would exhaust a tablet's memory
   * before the first paint. Files above this limit are simply not
   * persisted, and the user sees the drop zone on next launch.
   *
   * Desktop uses a different approach entirely: the File System Access
   * API stores a lightweight file handle (~30 bytes) instead of the
   * full ArrayBuffer. The browser asks permission to re-read the
   * original file from disk, so there's zero duplication.
   *
   * The UI layer (restoreSession, showResumeButton) stays in app.js
   * because it creates DOM elements and manages focus. This file is
   * the storage engine only.
   *
   *
   * The file follows this flow:
   *
   * 1. CONSTANTS (lines 41-47)
   * 2. OPEN SESSION DB (lines 50-64)
   * 3. SAVE SESSION (lines 67-83)
   * 4. LOAD SESSION (lines 86-104)
   * 5. CLEAR SESSION (lines 107-123)
*/


// --- CONSTANTS ---

const SESSION_DB_NAME = 'veil-session';
const SESSION_DB_VERSION = 1;
const SESSION_STORE = 'pdf';
export const SESSION_MAX_SIZE = 120 * 1024 * 1024; // 120MB, see DESIGN block
export const hasFileSystemAccess = 'showOpenFilePicker' in window;


// --- OPEN SESSION DB ---

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


// --- SAVE SESSION ---

// Only one PDF is stored at a time: each save clears the previous one.
// I considered keeping multiple PDFs for quick switching, but each
// stored PDF must be loaded into RAM at boot. Two 60MB PDFs would
// spike memory to 120MB+ before the UI even renders
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


// --- LOAD SESSION ---

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


// --- CLEAR SESSION ---

// Clears both IndexedDB (the PDF bytes) and localStorage (filename,
// page number, dark overrides). Called on file switch and when the
// user opens a file larger than SESSION_MAX_SIZE
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