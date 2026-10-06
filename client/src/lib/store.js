/**
 * store.js
 * Persistent record store for the plugin, replacing the server's JSON /
 * SQLite / DynamoDB stores. Same shape as the server's record-store
 * interface: get(key) / all() / put(key, value, {ttlEpochMs}) / delete(key).
 *
 * Backed by IndexedDB in the plugin iframe's own origin storage. Records are
 * namespaced by tenant (from lib/sailpoint credentials) so one browser used
 * against several tenants never mixes data. Falls back to an in-memory map
 * when IndexedDB is unavailable (e.g. storage blocked), so the app still runs
 * but nothing persists.
 *
 *   const scans = recordStore("role-scans");
 *   await scans.put(id, { ... });
 */

import { getCredentials } from "./sailpoint";

const DB_NAME = "admin-studio";
const OBJECTS = "records";
let _dbPromise = null;
const _memory = new Map();

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(OBJECTS);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return _dbPromise;
}

function tenantKey() {
  return getCredentials()?.tenant || "_";
}
const fullKey = (store, key) => `${tenantKey()}\u0000${store}\u0000${key}`;
const prefixOf = (store) => `${tenantKey()}\u0000${store}\u0000`;

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(OBJECTS, mode);
    const out = fn(t.objectStore(OBJECTS));
    t.oncomplete = () => resolve(out?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const expired = (rec) => rec && rec.ttlEpochMs && rec.ttlEpochMs < Date.now();

export function recordStore(name) {
  return {
    async get(key) {
      const db = await openDb();
      const k = fullKey(name, key);
      const rec = db ? await tx(db, "readonly", (s) => s.get(k)) : _memory.get(k);
      if (!rec || expired(rec)) return undefined;
      return rec.value;
    },
    async all() {
      const db = await openDb();
      const prefix = prefixOf(name);
      const out = {};
      if (db) {
        await new Promise((resolve, reject) => {
          const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
          const t = db.transaction(OBJECTS, "readonly");
          const req = t.objectStore(OBJECTS).openCursor(range);
          req.onsuccess = () => {
            const c = req.result;
            if (!c) return resolve();
            if (!expired(c.value)) out[c.key.slice(prefix.length)] = c.value.value;
            c.continue();
          };
          req.onerror = () => reject(req.error);
        });
      } else {
        for (const [k, rec] of _memory) if (k.startsWith(prefix) && !expired(rec)) out[k.slice(prefix.length)] = rec.value;
      }
      return out;
    },
    async put(key, value, { ttlEpochMs } = {}) {
      const db = await openDb();
      const k = fullKey(name, key);
      const rec = { value, ...(ttlEpochMs ? { ttlEpochMs } : {}) };
      if (db) await tx(db, "readwrite", (s) => s.put(rec, k));
      else _memory.set(k, rec);
      return value;
    },
    async delete(key) {
      const db = await openDb();
      const k = fullKey(name, key);
      if (db) await tx(db, "readwrite", (s) => s.delete(k));
      else _memory.delete(k);
    },
  };
}
