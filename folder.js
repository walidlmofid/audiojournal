// Recordings as normal files in a folder of the phone, chosen once by the
// user, instead of inside the browser's hidden storage.
//
// The browser remembers which folder was chosen, but the phone may ask again
// for permission to use it each time the app is opened.

import * as db from "./db.js";

const RW = { mode: "readwrite" };

let dir = null;       // the chosen folder
let granted = false;  // may it be used right now?

export const supported = () => typeof window.showDirectoryPicker === "function";
export const chosen = () => !!dir;
export const ready = () => !!dir && granted;
export const name = () => dir?.name || "";

// Having permission is not enough on every phone: check the folder answers.
async function answers() {
  try {
    for await (const key of dir.keys()) { void key; break; }
    return true;
  } catch {
    return false;
  }
}

// At startup: is there a chosen folder, and can it be used without asking?
export async function load() {
  const row = await db.get("meta", "folder").catch(() => null);
  dir = row?.handle || null;
  granted = false;
  if (!dir) return;
  try { granted = (await dir.queryPermission(RW)) === "granted" && (await answers()); } catch { granted = false; }
}

// Lets the user pick a folder (must be started by a tap).
export async function pick() {
  const picked = await window.showDirectoryPicker({ id: "audiojournal", mode: "readwrite" });
  let ok = false;
  try { ok = (await picked.queryPermission(RW)) === "granted" || (await picked.requestPermission(RW)) === "granted"; } catch { ok = false; }
  dir = picked;
  granted = ok && (await answers());
  await db.put("meta", { key: "folder", handle: picked, name: picked.name });
  return granted;
}

// Asks the phone for permission to use the remembered folder again (must be
// started by a tap).
export async function reconnect() {
  if (!dir) return false;
  try { granted = (await dir.requestPermission(RW)) === "granted" && (await answers()); } catch { granted = false; }
  return granted;
}

// Size of a file in the folder, or null if there is no such file.
export async function sizeOf(fileName) {
  try { return (await (await dir.getFileHandle(fileName)).getFile()).size; } catch { return null; }
}

export async function read(fileName) {
  return (await dir.getFileHandle(fileName)).getFile();
}

export async function readText(fileName) {
  try { return await (await read(fileName)).text(); } catch { return null; }
}

// Writes a file and reads its size back to make sure all of it arrived.
// Returns the name the file really got.
export async function write(fileName, data) {
  const blob = typeof data === "string" ? new Blob([data], { type: "application/json" }) : data;
  const handle = await dir.getFileHandle(fileName, { create: true });
  const out = await handle.createWritable();
  try {
    await out.write(blob);
    await out.close();
  } catch (err) {
    try { await out.abort(); } catch { /* already closed */ }
    throw err;
  }
  const size = (await handle.getFile()).size;
  if (size !== blob.size) throw new Error(`“${fileName}” was not written completely (${size} of ${blob.size} bytes).`);
  return handle.name;
}

// A name that is not used yet: "a.m4a", then "a (2).m4a", "a (3).m4a"...
export async function freeName(wanted) {
  const dot = wanted.lastIndexOf(".");
  const base = dot > 0 ? wanted.slice(0, dot) : wanted;
  const ext = dot > 0 ? wanted.slice(dot) : "";
  let candidate = wanted;
  for (let i = 2; (await sizeOf(candidate)) !== null; i++) candidate = `${base} (${i})${ext}`;
  return candidate;
}

export async function remove(fileName) {
  await dir.removeEntry(fileName);
}

// Names of the files directly in the folder.
export async function list() {
  const out = [];
  for await (const [fileName, handle] of dir.entries()) if (handle.kind === "file") out.push(fileName);
  return out;
}
