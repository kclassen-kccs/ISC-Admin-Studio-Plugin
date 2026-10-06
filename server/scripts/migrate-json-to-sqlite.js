#!/usr/bin/env node
// One-time import of every JSON-file store's current data into the SQLite
// backend (server/data/app.sqlite) — run this once before switching
// STORAGE_BACKEND=sqlite on a server that already has real JSON data.
// Safe to re-run: it overwrites matching keys in SQLite with whatever is
// currently in the JSON files, it doesn't touch the JSON files themselves.

require("dotenv").config();
const path = require("path");
const { createJsonRecordStore } = require("../storage/jsonRecordStore");
const { createSqliteRecordStore } = require("../storage/sqliteRecordStore");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");

const STORE_FILES = [
  "flagged-common-access-roles.json",
  "sod-mitigations.json",
  "role-scans.json",
  "skeleton-scans.json",
  "tenant-settings.json",
  "studio-preferences.json",
  "user-preferences.json",
  "schema-analysis.json",
  "role-eval-scans.json",
];

console.log(`[migrate] reading JSON stores from ${DATA_DIR}, writing to ${path.join(DATA_DIR, "app.sqlite")}`);

for (const filename of STORE_FILES) {
  const storeName = filename.replace(/\.json$/, "");
  const json = createJsonRecordStore(DATA_DIR, filename);
  const sqlite = createSqliteRecordStore(DATA_DIR, storeName);

  const keys = Object.keys(json.data);
  for (const key of keys) sqlite.data[key] = json.data[key];
  sqlite.save();

  console.log(`[migrate] ${filename}: ${keys.length} record(s) migrated`);
}

console.log("[migrate] done — set STORAGE_BACKEND=sqlite to use it.");
