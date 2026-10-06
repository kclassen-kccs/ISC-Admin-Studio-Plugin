#!/usr/bin/env node
// Bumps the patch (third) digit of the version in sync across the root,
// client, and server package.json files — and their lockfiles, which npm
// stamps with the package's own version in two places. Run before each
// deployment.
//
// Pass an explicit version to set one instead of bumping the patch digit,
// for a minor or major release:  npm run version:bump -- 3.3.0

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const manifests = ["package.json", "client/package.json", "server/package.json"];
const lockfiles = ["package-lock.json", "client/package-lock.json", "server/package-lock.json"];

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
// npm writes lockfiles as 2-space JSON, so round-tripping them this way is a
// two-line diff rather than a whole-file reformat.
const writeJson = (f, obj) => fs.writeFileSync(path.join(root, f), JSON.stringify(obj, null, 2) + "\n");

const versions = manifests.map((f) => readJson(f).version);
if (!versions.every((v) => v === versions[0])) {
  console.error(`Version mismatch across package.json files: ${versions.join(", ")}`);
  process.exit(1);
}

const explicit = process.argv[2];
if (explicit && !/^\d+\.\d+\.\d+$/.test(explicit)) {
  console.error(`Not a version: "${explicit}" — expected major.minor.patch, e.g. 3.3.0`);
  process.exit(1);
}
const [major, minor, patch] = versions[0].split(".").map(Number);
const next = explicit || `${major}.${minor}.${patch + 1}`;

for (const f of manifests) {
  writeJson(f, { ...readJson(f), version: next });
}

// Lockfiles carry the package's own version twice: at the top level and in
// the packages[""] self-entry. Leaving these behind is how the root lockfile
// drifted to 3.2.9 while the app shipped 3.2.12.
for (const f of lockfiles) {
  if (!fs.existsSync(path.join(root, f))) continue;
  const lock = readJson(f);
  lock.version = next;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = next;
  writeJson(f, lock);
}

console.log(`Bumped version ${versions[0]} -> ${next} (package.json + package-lock.json, all three)`);
