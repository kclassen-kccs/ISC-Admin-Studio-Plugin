const { createJsonRecordStore } = require("./jsonRecordStore");
const { createSqliteRecordStore } = require("./sqliteRecordStore");
const { createAwsRecordStore, createS3ObjectStore, createS3BlobStore } = require("./awsRecordStore");

// Phase 3 of the storage-interface plan, reworked for Phase 4 (aws): the one
// place a store's backend is chosen. Every backend now presents the SAME
// fully-async interface — get/all/put/delete — so call sites never know or
// care what's behind it:
//   json / sqlite : the original { data, save() } stores wrapped in an async
//                   adapter. Still cached in memory (fine for local dev —
//                   single process by definition).
//   aws           : DynamoDB + S3 with NO cache of any kind — every call is
//                   a live request. This is the production backend; it's what
//                   makes the server stateless and multi-instance-safe.
const STORAGE_BACKEND = (process.env.STORAGE_BACKEND || "json").toLowerCase();
const AWS_TABLE = process.env.DYNAMO_TABLE || "admin-studio-prod";
const AWS_BUCKET = process.env.S3_BUCKET || "";

function isAws() {
  return STORAGE_BACKEND === "aws";
}

// The original synchronous { data, save() } stores, adapted to the async
// shape. TTL is accepted and ignored — local stores are pruned by the same
// explicit sweeps the app has always run.
function wrapSyncStore(store) {
  return {
    async get(key) {
      return store.data[key];
    },
    async all() {
      return { ...store.data };
    },
    async put(key, value) {
      store.data[key] = value;
      store.save();
    },
    async delete(key) {
      delete store.data[key];
      store.save();
    },
  };
}

function createRecordStore(dataDir, filename, opts = {}) {
  const storeName = filename.replace(/\.json$/, "");
  if (STORAGE_BACKEND === "aws") {
    // The bucket lets a value too big for a DynamoDB item (400KB) spill to
    // S3 transparently — see the overflow note in awsRecordStore.js.
    return createAwsRecordStore(AWS_TABLE, storeName, { encrypt: !!opts.encrypt, bucket: AWS_BUCKET });
  }
  if (STORAGE_BACKEND === "sqlite") {
    return wrapSyncStore(createSqliteRecordStore(dataDir, storeName, opts));
  }
  return wrapSyncStore(createJsonRecordStore(dataDir, filename, opts));
}

console.log(
  `[storage] backend = ${STORAGE_BACKEND}` +
  (isAws() ? ` (table=${AWS_TABLE}, bucket=${AWS_BUCKET || "NOT SET"})` : "")
);
if (isAws() && !AWS_BUCKET) {
  console.error("[storage] STORAGE_BACKEND=aws requires S3_BUCKET to be set.");
}

module.exports = {
  createRecordStore,
  createS3ObjectStore,
  createS3BlobStore,
  STORAGE_BACKEND,
  isAws,
  AWS_TABLE,
  AWS_BUCKET,
};
