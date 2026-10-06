const fs = require("fs");
const path = require("path");

/**
 * Phase 1 of the storage-interface plan: every store in this app used to
 * inline its own copy of "read the whole JSON file into memory once at
 * startup, mutate the in-memory object, write the whole thing back to disk
 * on every change." This factory is that same pattern extracted to one
 * place instead of duplicated ~9 times — behavior, on-disk format, and
 * performance characteristics are all unchanged from before. It's also now
 * the ONE seam a future backend (e.g. SQLite) plugs into: everything else
 * in the app keeps calling the same store methods, unaware of what's on
 * the other side of them.
 *
 * `data` is the live in-memory object — callers that used to do
 * `const roleScans = loadRoleScans()` and then freely read/mutate that
 * object (roleScans[id], delete roleScans[id], Object.values(roleScans))
 * keep doing exactly that against `store.data`. `save()` is what used to
 * be `saveRoleScans(roleScans)` — flushes the current in-memory state to
 * disk synchronously.
 */
function createJsonRecordStore(dataDir, filename, { defaultValue = {} } = {}) {
  const filePath = path.join(dataDir, filename);

  function readFromDisk() {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return typeof defaultValue === "function" ? defaultValue() : { ...defaultValue };
    }
  }

  const store = {
    data: readFromDisk(),
    save() {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(store.data, null, 2));
    },
  };

  return store;
}

module.exports = { createJsonRecordStore };
