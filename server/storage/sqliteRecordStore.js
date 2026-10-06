const fs = require("fs");
const path = require("path");
let Database;
try {
  Database = require("better-sqlite3");
} catch {
  Database = null;
}

// All stores in a process share one SQLite file/connection, keyed by
// dataDir (in practice there's only ever one DATA_DIR per running server).
const dbCache = new Map();

function getDb(dataDir) {
  if (!Database) {
    throw new Error(
      "better-sqlite3 isn't installed — run `npm install` in server/, or set STORAGE_BACKEND=json to use the JSON-file backend instead."
    );
  }
  if (!dbCache.has(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, "app.sqlite"));
    db.pragma("journal_mode = WAL");
    // One generic table for every store, keyed by (store, key) — matches
    // the { [key]: record } object shape every store already used under
    // the JSON backend, so no per-store schema is needed. `value` is the
    // record serialized as JSON; only its shape is store-specific, and
    // nothing here needs to know it.
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        store TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (store, key)
      )
    `);
    dbCache.set(dataDir, db);
  }
  return dbCache.get(dataDir);
}

/**
 * Phase 2 of the storage-interface plan: a second implementation of the
 * same { data, save() } shape jsonRecordStore exposes (see that file) —
 * this one backed by SQLite instead of a single JSON file. `data` is still
 * a live in-memory POJO callers read/mutate directly, completely unchanged
 * from Phase 1 (roleScans[id], delete roleScans[id], Object.values(...)
 * all keep working). The difference is save(): instead of re-serializing
 * and rewriting the ENTIRE store on every change (the original bottleneck
 * — see the scalability discussion this was built from), it diffs `data`
 * against what was last written and only touches the keys that actually
 * changed, in one transaction. A crash mid-write can't corrupt the store
 * either way — SQLite's transaction either fully applies or fully rolls
 * back, unlike a partially-written JSON file.
 */
function createSqliteRecordStore(dataDir, storeName, { defaultValue = {} } = {}) {
  const db = getDb(dataDir);
  const selectAll = db.prepare("SELECT key, value FROM kv_store WHERE store = ?");
  const upsert = db.prepare(
    "INSERT INTO kv_store (store, key, value) VALUES (@store, @key, @value) " +
    "ON CONFLICT(store, key) DO UPDATE SET value = excluded.value"
  );
  const del = db.prepare("DELETE FROM kv_store WHERE store = ? AND key = ?");

  const initial = typeof defaultValue === "function" ? defaultValue() : { ...defaultValue };
  const data = { ...initial };
  // key -> last-written JSON string, so save() can tell which keys actually
  // changed instead of re-writing everything every time.
  const lastWritten = new Map();

  for (const row of selectAll.all(storeName)) {
    data[row.key] = JSON.parse(row.value);
    lastWritten.set(row.key, row.value);
  }

  const store = {
    data,
    save() {
      const currentKeys = new Set(Object.keys(store.data));
      const applyChanges = db.transaction(() => {
        for (const key of currentKeys) {
          const json = JSON.stringify(store.data[key]);
          if (lastWritten.get(key) !== json) {
            upsert.run({ store: storeName, key, value: json });
            lastWritten.set(key, json);
          }
        }
        for (const key of lastWritten.keys()) {
          if (!currentKeys.has(key)) {
            del.run(storeName, key);
            lastWritten.delete(key);
          }
        }
      });
      applyChanges();
    },
  };

  return store;
}

module.exports = { createSqliteRecordStore };
