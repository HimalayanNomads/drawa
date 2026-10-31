// Binary things too big for localStorage (images on the canvas): IndexedDB, this browser only.
let db: Promise<IDBDatabase> | undefined;
/** The IndexedDB database, opened once (and again after a failed open). */
const open = () =>
  (db ??= new Promise((res, rej) => {
    const r = indexedDB.open('claude-ui', 1); // the name from before the rename to Drawa: renaming would lose pictures kept here
    r.onupgradeneeded = () => r.result.createObjectStore('blobs');
    r.onsuccess = () => res(r.result);
    r.onerror = () => {
      db = undefined;
      rej(r.error);
    }; // try again next time
  }));

/** One request in its own transaction, resolved only once the transaction has completed (a write is kept by then). */
async function run<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const tx = (await open()).transaction('blobs', mode),
    r = f(tx.objectStore('blobs'));
  return new Promise((res, rej) => {
    // a write is only kept once its transaction completes, not when the request succeeds
    tx.oncomplete = () => res(r.result as T);
    tx.onerror = tx.onabort = () => rej(tx.error ?? r.error);
  });
}

/** A stored Blob by key (an image window's picture), or undefined. */
export const getBlob = (key: string) => run<Blob | undefined>('readonly', s => s.get(key));
/** Store a Blob under `key`, replacing what was there. */
export const putBlob = (key: string, b: Blob) => run<void>('readwrite', s => s.put(b, key));
/** Delete a stored Blob (its window is gone for good). */
export const dropBlob = (key: string) => run<void>('readwrite', s => s.delete(key));

/** A Blob's bytes as base64 (what Claude's image blocks carry). */
export const base64 = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });
/** An image content block for a Claude message. */
export const imageBlock = (type: string, data: string) => ({
  type: 'image',
  source: { type: 'base64', media_type: type, data },
});

/** A document content block for a message (PDF). */
export const documentBlock = (type: string, data: string, title?: string) => ({
  type: 'document',
  source: { type: 'base64', media_type: type, data },
  ...(title ? { title } : {}),
});
