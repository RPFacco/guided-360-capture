// Previews of captures already sent, kept on this phone until their final stitch is
// ready, so the library can offer "Ver prévia" while the panorama waits in the queue.
// Keyed by the server's panorama id. A database of its own: the capture's photo store
// (storage.js) is never touched. Every call resolves, to null when storage fails.
const DB_NAME = "guided-360-previews";
const STORE = "previews";
let dbPromise = null;

function openDB() {
  dbPromise ??= new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch (_) { return resolve(null); }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

async function run(mode, op) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    let req;
    try {
      const tx = db.transaction(STORE, mode);
      req = op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result ?? null);
      tx.onerror = tx.onabort = () => resolve(null);
    } catch (_) {
      resolve(null);
    }
  });
}

export const savePreview = (id, blob) => run("readwrite", (s) => s.put(blob, id));
export const loadPreview = (id) => run("readonly", (s) => s.get(id));
export const dropPreview = (id) => run("readwrite", (s) => s.delete(id));
export const previewIds = async () => new Set((await run("readonly", (s) => s.getAllKeys())) || []);
