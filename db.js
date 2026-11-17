// The app's own storage inside the browser (IndexedDB).
//   recordings : one small record per recording (date, title, tags, lock...)
//   audio      : the sound of recordings that are not (yet) files in the
//                phone folder — see folder.js
//   chunks     : pieces of a recording in progress, saved every few seconds,
//                so nothing is lost if the app is closed while recording
//   tags       : B / I and the tags you wrote
//   meta       : data version and small settings (microphone, chosen folder)

const DB_NAME = "audio-journal";
const DB_VERSION = 1;

// Bump when the saved data changes shape. An older app that finds newer data
// refuses to write instead of damaging it.
export const DATA_VERSION = 3;

let dbPromise = null;
let readOnly = false;
let onWrite = null;

export function setReadOnly(v) { readOnly = v; }
export function isReadOnly() { return readOnly; }

// fn(store) is called after every change, so the app can copy it elsewhere.
export function setOnWrite(fn) { onWrite = fn; }
function wrote(store) { try { onWrite?.(store); } catch { /* never blocks saving */ } }

function guard() {
  if (readOnly) throw new Error("This data was saved by a newer version of the app. Reload the app to update it.");
}

export function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("recordings")) db.createObjectStore("recordings", { keyPath: "id" });
        if (!db.objectStoreNames.contains("audio")) db.createObjectStore("audio", { keyPath: "id" });
        if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks", { keyPath: ["recId", "seq"] });
        if (!db.objectStoreNames.contains("tags")) db.createObjectStore("tags", { keyPath: "id" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("The app is open in another tab. Close it and reload."));
    });
  }
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Saving was cancelled."));
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(store) {
  const db = await openDB();
  return result(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await openDB();
  return result(db.transaction(store).objectStore(store).get(key));
}

export async function put(store, value) {
  guard();
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value);
  await done(tx);
  wrote(store);
}

export async function putMany(store, values) {
  guard();
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  for (const v of values) tx.objectStore(store).put(v);
  await done(tx);
  wrote(store);
}

export async function del(store, key) {
  guard();
  const db = await openDB();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).delete(key);
  await done(tx);
  wrote(store);
}

// A copy without functions/undefined, safe to store.
const plain = o => JSON.parse(JSON.stringify(o));

// Saves one piece of a recording in progress, together with its latest info
// (duration, marks), in a single step.
export async function putChunk(rec, seq, blob) {
  guard();
  const db = await openDB();
  const tx = db.transaction(["chunks", "recordings"], "readwrite");
  tx.objectStore("chunks").put({ recId: rec.id, seq, blob });
  tx.objectStore("recordings").put(plain(rec));
  return done(tx);
}

function chunkRange(id) {
  return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
}

// Joins the saved pieces into one audio file and stores it. The pieces are
// only removed in the same step that stores the finished file.
// Returns the finished recording, or null if nothing had been recorded.
export async function finishRecording(rec) {
  guard();
  const db = await openDB();
  const chunks = await result(db.transaction("chunks").objectStore("chunks").getAll(chunkRange(rec.id)));
  chunks.sort((a, b) => a.seq - b.seq);
  if (!chunks.length) {
    const tx = db.transaction("recordings", "readwrite");
    tx.objectStore("recordings").delete(rec.id);
    await done(tx);
    return null;
  }
  const blob = new Blob(chunks.map(c => c.blob), { type: rec.mimeType || chunks[0].blob.type });
  rec.size = blob.size;
  rec.status = "saved";
  rec.updatedAt = Date.now();
  const tx = db.transaction(["audio", "recordings", "chunks"], "readwrite");
  tx.objectStore("audio").put({ id: rec.id, blob });
  tx.objectStore("recordings").put(plain(rec));
  tx.objectStore("chunks").delete(chunkRange(rec.id));
  await done(tx);
  wrote("recordings");
  return rec;
}

export async function addImported(rec, blob) {
  guard();
  const db = await openDB();
  const tx = db.transaction(["audio", "recordings"], "readwrite");
  tx.objectStore("audio").put({ id: rec.id, blob });
  tx.objectStore("recordings").put(plain(rec));
  await done(tx);
  wrote("recordings");
}

export async function getAudio(id) {
  const row = await get("audio", id);
  return row ? row.blob : null;
}

// The recording's audio now lives in the phone folder (rec.file): remember
// that and drop the copy kept here, in a single step.
export async function linkFile(rec) {
  guard();
  const db = await openDB();
  rec.updatedAt = Date.now();
  const tx = db.transaction(["audio", "recordings"], "readwrite");
  tx.objectStore("recordings").put(plain(rec));
  tx.objectStore("audio").delete(rec.id);
  await done(tx);
  wrote("recordings");
}

export async function deleteRecording(id) {
  guard();
  const db = await openDB();
  const tx = db.transaction(["audio", "recordings", "chunks"], "readwrite");
  tx.objectStore("audio").delete(id);
  tx.objectStore("recordings").delete(id);
  tx.objectStore("chunks").delete(chunkRange(id));
  await done(tx);
  wrote("recordings");
}

export async function saveRecording(rec) {
  rec.updatedAt = Date.now();
  return put("recordings", plain(rec));
}
