import JSZip from "jszip";
import { toCsv } from "./csv";

// Same exclusion as SourceEditAccountsPage's own ALWAYS_EXCLUDED_ATTRS —
// ISC injects idNowDescription into every aggregated account's attributes,
// it's never a real source-file column, and must never round-trip into a
// re-uploaded CSV.
const ALWAYS_EXCLUDED_ATTRS = new Set(["idNowDescription"]);

export function exportableAttributes(schema) {
  if (!schema) return [];
  return schema.attributes.filter((a) => !ALWAYS_EXCLUDED_ATTRS.has(a.name));
}

export function buildAccountsCsv(schema, accounts) {
  const headers = exportableAttributes(schema).map((a) => a.name);
  const rows = (accounts || []).map((a) => a.attributes || {});
  return toCsv(headers, rows);
}

function slugify(s) {
  return (
    String(s || "")
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unnamed"
  );
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function timestamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(
    date.getMinutes()
  )}${pad(date.getSeconds())}`;
}

// {tenant}__{source}__{YYYYMMDD-HHmmss}.csv — double underscores as the
// delimiter (unlikely to occur inside a slugified tenant/source name) so
// matchSourceFromFilename below can split it back apart unambiguously.
export function backupFilename(tenant, sourceName, date = new Date()) {
  return `${slugify(tenant)}__${slugify(sourceName)}__${timestamp(date)}.csv`;
}

export function backupZipFilename(tenant, date = new Date()) {
  return `${slugify(tenant)}__backup__${timestamp(date)}.zip`;
}

// Bundles already-generated backup CSVs into a single in-browser zip, so a
// multi-source backup can be downloaded as one file instead of one-by-one.
export async function buildBackupZip(files) {
  const zip = new JSZip();
  files.forEach((f) => zip.file(f.filename, f.csv));
  return zip.generateAsync({ type: "blob" });
}

// Best-effort match of a previously generated backupFilename back to one of
// the given sources, by comparing the filename's slugified source segment
// against each candidate's own slugified name. Lets Restore Offline Source
// auto-select the right source when the file came from Backup Offline
// Sources and wasn't renamed; returns null (requiring a manual pick)
// otherwise.
export function matchSourceFromFilename(filename, sources) {
  const base = String(filename || "").replace(/\.csv$/i, "");
  const parts = base.split("__");
  if (parts.length !== 3) return null;
  const [, sourceSlug] = parts;
  return (sources || []).find((s) => slugify(s.name) === sourceSlug) || null;
}

export function csvToBase64(csv) {
  return btoa(unescape(encodeURIComponent(csv)));
}
