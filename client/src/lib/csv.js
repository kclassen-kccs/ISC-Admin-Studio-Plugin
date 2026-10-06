// Minimal RFC-4180-ish CSV writer — quotes every field and doubles internal
// quotes, which is always safe (if occasionally more verbose than necessary)
// regardless of whether a given field actually needs quoting.
function csvField(value) {
  const s = value == null ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvField(row[h])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// Minimal RFC-4180 reader — the counterpart to toCsv above. Handles quoted
// fields, doubled-quote escapes, embedded commas/newlines inside quotes, and
// both \r\n and \n line endings. Every value comes back as a plain string
// (matching how toCsv writes multi-valued attributes: already comma-joined
// into one string by the caller, not as a JS array) so a parsed row can be
// fed straight back into toCsv without any reshaping.
export function parseCsv(text) {
  const src = String(text || "").replace(/^﻿/, ""); // strip a UTF-8 BOM if present
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += c;
        i += 1;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
    } else if (c === ",") {
      row.push(field);
      field = "";
      i += 1;
    } else if (c === "\r") {
      i += 1;
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return { headers: [], rows: [] };
  const [headers, ...dataRows] = rows;
  const trimmed = dataRows.filter((r) => !(r.length === 1 && r[0] === ""));
  const objRows = trimmed.map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = r[idx] !== undefined ? r[idx] : "";
    });
    return obj;
  });
  return { headers, rows: objRows };
}
