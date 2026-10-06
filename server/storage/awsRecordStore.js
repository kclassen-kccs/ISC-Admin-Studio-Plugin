/**
 * Phase 4 of the storage-interface plan (see jsonRecordStore.js for Phase 1,
 * sqliteRecordStore.js for Phase 2, index.js for Phase 3): AWS-backed
 * storage with NO in-memory cache. Every read is a live DynamoDB/S3 call and
 * every write goes straight through, which is what makes the server process
 * stateless — restart-safe, and safe to run more than one instance of.
 *
 * Three primitives live here:
 *  - createAwsRecordStore: the async record-store shape (get/all/put/delete)
 *    over one DynamoDB table, partition key `store`, sort key `key`. Values
 *    are stored as native JSON documents. Optional per-item TTL rides the
 *    `expiresAtEpoch` attribute (the table's TTL attribute), and optional
 *    app-layer AES-256-GCM encryption (DATA_ENCRYPTION_KEY) wraps the value
 *    for sensitive stores (sessions) as defense in depth on top of
 *    DynamoDB's own at-rest encryption.
 *  - createS3ObjectStore: one whole JSON document per S3 object — the OAuth
 *    client registry's shape (read-modify-write of a single ~1KB object).
 *  - createS3BlobStore: opaque binary blobs (report PDFs).
 */
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand,
} = require("@aws-sdk/lib-dynamodb");
const {
  S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, NoSuchKey,
} = require("@aws-sdk/client-s3");
const crypto = require("crypto");

const REGION = process.env.AWS_REGION || "us-east-1";

// One client per process — the SDK pools connections internally.
let _ddb = null;
function ddb() {
  if (!_ddb) {
    _ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _ddb;
}

let _s3 = null;
function s3() {
  if (!_s3) _s3 = new S3Client({ region: REGION });
  return _s3;
}

// ─── Value encryption (same scheme as the oauth-clients registry) ────────────

function encryptionKey() {
  const raw = process.env.DATA_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, /^[0-9a-fA-F]{64}$/.test(raw) ? "hex" : "base64");
  return key.length === 32 ? key : null;
}

function encryptValue(value) {
  const key = encryptionKey();
  if (!key) return { plain: value };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    enc: {
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: body.toString("base64"),
    },
  };
}

function decryptValue(stored) {
  if (stored?.enc?.alg === "aes-256-gcm") {
    const key = encryptionKey();
    if (!key) throw new Error("stored value is encrypted but DATA_ENCRYPTION_KEY is not set");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(stored.enc.iv, "base64"));
    decipher.setAuthTag(Buffer.from(stored.enc.tag, "base64"));
    const out = Buffer.concat([
      decipher.update(Buffer.from(stored.enc.data, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(out.toString("utf8"));
  }
  return stored?.plain;
}

// ─── Large-value overflow to S3 ──────────────────────────────────────────────

// DynamoDB rejects any item over 400KB ("Item size has exceeded the maximum
// allowed size"). Mined datasets blow straight past that — a certification
// run carries every planned campaign's members, and every member's every
// access item — so a value that won't fit is written to S3 instead and the
// DynamoDB row keeps only a pointer to it. Call sites see no difference.
//
// The threshold is well under 400KB: this measures the JSON encoding, which
// is close to but not identical to how DynamoDB sizes an item, so the margin
// absorbs the difference (and base64 growth on encrypted stores).
const OVERFLOW_THRESHOLD_BYTES = 300 * 1024;

const overflowKeyFor = (storeName, key) =>
  `record-overflow/${storeName}/${encodeURIComponent(String(key))}.json`;

async function writeOverflow(bucket, objectKey, payload) {
  await s3().send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: JSON.stringify(payload),
    ContentType: "application/json",
  }));
}

async function readOverflow(bucket, objectKey) {
  try {
    const out = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
    return JSON.parse(await out.Body.transformToString("utf8"));
  } catch (err) {
    if (err instanceof NoSuchKey || err.name === "NoSuchKey") return undefined;
    throw err;
  }
}

async function removeOverflow(bucket, objectKey) {
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
  } catch {
    // Already gone is fine.
  }
}

// ─── DynamoDB record store ───────────────────────────────────────────────────

/**
 * The async record-store interface every backend implements:
 *   get(key)            -> value | undefined
 *   all()               -> { [key]: value } (full store contents)
 *   put(key, value, { ttlEpochMs }) -> void
 *   delete(key)         -> void
 * TTL is optional and per-item; DynamoDB deletes expired items in the
 * background (best-effort), so anything correctness-critical must still
 * compare timestamps at read time — TTL replaces cleanup sweeps, not checks.
 */
function createAwsRecordStore(tableName, storeName, { encrypt = false, bucket = "" } = {}) {
  const wrap = (value, ttlEpochMs) => ({
    ...(encrypt ? encryptValue(value) : { plain: value }),
    ...(ttlEpochMs ? { expiresAtEpoch: Math.ceil(ttlEpochMs / 1000) } : {}),
  });

  // A row is either the value itself or a pointer to it in S3.
  const hydrate = async (item) => {
    if (!item.overflowKey) return decryptValue(item);
    const stored = await readOverflow(bucket, item.overflowKey);
    return stored === undefined ? undefined : decryptValue(stored);
  };

  return {
    async get(key) {
      const out = await ddb().send(new GetCommand({
        TableName: tableName,
        Key: { store: storeName, key: String(key) },
      }));
      if (!out.Item) return undefined;
      return hydrate(out.Item);
    },

    async all() {
      const result = {};
      let lastKey;
      do {
        const out = await ddb().send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: "#s = :s",
          ExpressionAttributeNames: { "#s": "store" },
          ExpressionAttributeValues: { ":s": storeName },
          ExclusiveStartKey: lastKey,
        }));
        // Overflowed rows each need an S3 read; do them together rather
        // than one after another so a store of large records still lists
        // in roughly the time of a single fetch.
        await Promise.all((out.Items || []).map(async (item) => {
          result[item.key] = await hydrate(item);
        }));
        lastKey = out.LastEvaluatedKey;
      } while (lastKey);
      return result;
    },

    async put(key, value, { ttlEpochMs } = {}) {
      const wrapped = wrap(value, ttlEpochMs);
      const item = { store: storeName, key: String(key), ...wrapped };

      if (bucket && Buffer.byteLength(JSON.stringify(item), "utf8") > OVERFLOW_THRESHOLD_BYTES) {
        // Payload to S3, pointer to DynamoDB. The wrapped form goes to S3, so
        // an encrypted store's value stays encrypted there too.
        const objectKey = overflowKeyFor(storeName, key);
        await writeOverflow(bucket, objectKey, wrapped);
        await ddb().send(new PutCommand({
          TableName: tableName,
          Item: {
            store: storeName,
            key: String(key),
            overflowKey: objectKey,
            ...(ttlEpochMs ? { expiresAtEpoch: Math.ceil(ttlEpochMs / 1000) } : {}),
          },
        }));
        return;
      }

      // Fits inline. ALL_OLD costs nothing extra and tells us whether this key
      // used to overflow, so a record that shrank doesn't strand its object.
      const prev = await ddb().send(new PutCommand({
        TableName: tableName, Item: item, ReturnValues: "ALL_OLD",
      }));
      if (prev.Attributes?.overflowKey) await removeOverflow(bucket, prev.Attributes.overflowKey);
    },

    async delete(key) {
      const prev = await ddb().send(new DeleteCommand({
        TableName: tableName,
        Key: { store: storeName, key: String(key) },
        ReturnValues: "ALL_OLD",
      }));
      if (prev.Attributes?.overflowKey) await removeOverflow(bucket, prev.Attributes.overflowKey);
    },
  };
}

// ─── S3 whole-object JSON store (OAuth client registry) ──────────────────────

function createS3ObjectStore(bucket, objectKey) {
  return {
    /** The stored JSON string exactly as written, or null if absent. */
    async readRaw() {
      try {
        const out = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
        return await out.Body.transformToString("utf8");
      } catch (err) {
        if (err instanceof NoSuchKey || err.name === "NoSuchKey") return null;
        throw err;
      }
    },
    async writeRaw(content) {
      await s3().send(new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: content,
        ContentType: "application/json",
      }));
    },
  };
}

// ─── S3 blob store (report PDFs) ─────────────────────────────────────────────

function createS3BlobStore(bucket, prefix) {
  return {
    async put(name, buffer, contentType = "application/pdf") {
      await s3().send(new PutObjectCommand({
        Bucket: bucket,
        Key: `${prefix}/${name}`,
        Body: buffer,
        ContentType: contentType,
      }));
    },
    /** Node Readable stream of the blob, or null if it doesn't exist. */
    async getStream(name) {
      try {
        const out = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}/${name}` }));
        return out.Body;
      } catch (err) {
        if (err instanceof NoSuchKey || err.name === "NoSuchKey") return null;
        throw err;
      }
    },
    async delete(name) {
      try {
        await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: `${prefix}/${name}` }));
      } catch {
        // Deleting a blob that's already gone is fine.
      }
    },
  };
}

module.exports = { createAwsRecordStore, createS3ObjectStore, createS3BlobStore };
