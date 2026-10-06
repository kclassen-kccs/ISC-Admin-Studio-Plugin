import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, Trash2, PencilLine, FileEdit, ChevronRight } from "lucide-react";
import toast from "react-hot-toast";
import {
  getSource, getSourceAccountSchema, exportSourceAccounts, loadAccountsFile,
} from "../lib/sailpoint";
import { toCsv } from "../lib/csv";
import { TopBar } from "../components/TopBar";
import {
  SkeletonList, ErrorBox, EmptyState, IconButton, PrimaryButton, ConfirmModal, SearchBar,
} from "../components/ui";
import { SourceAccountFormModal } from "../components/SourceAccountFormModal";
import { SourceAccountBatchEditModal } from "../components/SourceAccountBatchEditModal";

let _nextLocalKey = 1;

// ISC injects this into every aggregated account's attributes — it's a
// synthetic hash, never a real source-file column (confirmed live: it's
// absent from the schema's own attribute list for every source checked), so
// it must never round-trip into the re-uploaded CSV.
const ALWAYS_EXCLUDED_ATTRS = new Set(["idNowDescription"]);

// There's no ISC API to download a ready-made accounts CSV template for a
// Delimited File / Generic source, so the schema (GET .../account-schema) IS
// the template — verified live that a Delimited File source's
// connectorAttributes carries no separate account-level columnNames/
// indexColumn override (only a group.* one, for the entitlements file), so
// the account schema's own attribute list, in its own order, is the
// authoritative column layout ISC expects back. That MUST include the
// schema's identityAttribute column (e.g. "id") — omitting it breaks ISC's
// ability to correlate uploaded rows to existing accounts, which is exactly
// what makes the file uploadable in the first place. Only idNowDescription
// is filtered, since it was never a real schema attribute to begin with.
function exportableAttributes(schema) {
  if (!schema) return [];
  return schema.attributes.filter((a) => !ALWAYS_EXCLUDED_ATTRS.has(a.name));
}

// Seeds the in-memory editable record list from the exported accounts —
// each account's own `attributes` object already matches the schema's field
// names, since that's what a Delimited File / Generic connector's account
// attributes actually are (the file's own columns).
function recordsFromAccounts(accounts) {
  return (accounts || []).map((acct) => ({
    _key: acct.id || `existing-${_nextLocalKey++}`,
    isNew: false,
    attributes: { ...(acct.attributes || {}) },
  }));
}

function blankRecord(attrs) {
  const attributes = {};
  for (const attr of attrs) attributes[attr.name] = attr.isMulti ? [] : "";
  return { _key: `new-${_nextLocalKey++}`, isNew: true, attributes };
}

// Plain substring ("contains") match across every attribute value on the
// record — this list is entirely local (already fully exported into memory),
// so search is just an in-memory filter, not a server round-trip.
function recordMatches(record, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return Object.values(record.attributes).some((v) => {
    const s = Array.isArray(v) ? v.join(", ") : v;
    return s != null && String(s).toLowerCase().includes(needle);
  });
}

export default function SourceEditAccountsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [records, setRecords] = useState(null); // null until seeded from the export
  const [editingKey, setEditingKey] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [batchEditOpen, setBatchEditOpen] = useState(false);
  const [search, setSearch] = useState("");

  const source = useQuery({ queryKey: ["source", id], queryFn: () => getSource(id) });
  const schema = useQuery({ queryKey: ["source-account-schema", id], queryFn: () => getSourceAccountSchema(id) });
  const exportQuery = useQuery({ queryKey: ["source-accounts-export", id], queryFn: () => exportSourceAccounts(id) });

  // Seed the editable list exactly once, when both the export and the
  // schema (needed for blank-record shape) have arrived — a plain
  // useState(exportQuery.data) initializer would miss the data since both
  // queries resolve after this component's first render.
  useEffect(() => {
    if (records === null && exportQuery.data && schema.data) {
      setRecords(recordsFromAccounts(exportQuery.data));
    }
  }, [records, exportQuery.data, schema.data]);

  const editingRecord = records?.find((r) => r._key === editingKey) || null;
  const exportAttrs = schema.data ? exportableAttributes(schema.data) : [];

  const saveMutation = useMutation({
    mutationFn: async () => {
      const headers = exportAttrs.map((a) => a.name);
      const rows = records.map((r) => r.attributes);
      const csv = toCsv(headers, rows);
      const csvBase64 = btoa(unescape(encodeURIComponent(csv)));
      const filename = `${source.data?.name || "accounts"}-edited.csv`;
      return loadAccountsFile(id, { filename, csvBase64 });
    },
    onSuccess: () => {
      toast.success(
        "Account aggregation started from the edited file. Updates won't appear immediately — ISC processes the file asynchronously, so expect a short delay before changes show up here.",
        { duration: 8000 }
      );
      navigate(-1);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  function handleAddRecord() {
    if (!schema.data) return;
    const rec = blankRecord(exportAttrs);
    setRecords((prev) => [rec, ...(prev || [])]);
    setEditingKey(rec._key);
  }

  function handleSaveRecord(values) {
    setRecords((prev) => prev.map((r) => (r._key === editingKey ? { ...r, attributes: values } : r)));
    setEditingKey(null);
  }

  function handleDiscardNewRecord() {
    setRecords((prev) => prev.filter((r) => r._key !== editingKey));
    setEditingKey(null);
  }

  function toggleOne(key) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      filteredRecords.length > 0 && prev.size === filteredRecords.length
        ? new Set()
        : new Set(filteredRecords.map((r) => r._key))
    );
  }

  function handleDeleteSelected() {
    setRecords((prev) => prev.filter((r) => !selected.has(r._key)));
    setSelected(new Set());
    setDeleteConfirmOpen(false);
  }

  // `changes` holds only the fields the batch form set or cleared — spread
  // over each selected record, so every other field keeps its own value.
  function handleBatchEdit(changes) {
    const names = Object.keys(changes);
    if (names.length === 0) return;
    const count = selected.size;
    setRecords((prev) =>
      prev.map((r) => (selected.has(r._key) ? { ...r, attributes: { ...r.attributes, ...changes } } : r))
    );
    setBatchEditOpen(false);
    toast.success(`Updated ${names.length} field${names.length === 1 ? "" : "s"} on ${count} record${count === 1 ? "" : "s"} — not saved to ISC until you Save & Run Aggregation.`);
  }

  const loading = source.isLoading || schema.isLoading || exportQuery.isLoading || records === null;
  const error = source.error || schema.error || exportQuery.error;
  const firstThreeAttrNames = exportAttrs.slice(0, 3).map((a) => a.name);
  // Alphabetical by the account's display name (falling back to its id),
  // like every other list — rather than the CSV export's own row order.
  const recordLabel = (r) => String(r.attributes?.name ?? r.attributes?.displayName ?? r.attributes?.id ?? "");
  const filteredRecords = (records || [])
    .filter((r) => recordMatches(r, search))
    .sort((a, b) => recordLabel(a).localeCompare(recordLabel(b), undefined, { sensitivity: "base", numeric: true }));
  const allSelected = filteredRecords.length > 0 && selected.size === filteredRecords.length;

  return (
    <div className="flex flex-col h-screen bg-white">
      <TopBar
        title="Edit Accounts"
        subtitle={source.data?.name}
        onBack={() => navigate(-1)}
        loading={loading}
        action={
          !loading &&
          !error && (
            <div className="flex items-center gap-2">
              <IconButton
                icon={PencilLine}
                title={`Edit selected (${selected.size})`}
                onClick={() => setBatchEditOpen(true)}
                disabled={selected.size === 0 || saveMutation.isPending}
              />
              <IconButton
                icon={Trash2}
                title={`Delete selected (${selected.size})`}
                onClick={() => setDeleteConfirmOpen(true)}
                disabled={selected.size === 0 || saveMutation.isPending}
              />
              <IconButton icon={Plus} title="Add record" onClick={handleAddRecord} disabled={saveMutation.isPending} />
            </div>
          )
        }
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {error && <ErrorBox message={error.message} />}
        {loading && <SkeletonList rows={8} />}

        {!loading && !error && records.length > 0 && (
          <SearchBar value={search} onChange={setSearch} placeholder="Search records…" />
        )}

        {!loading && !error && records.length === 0 && (
          <EmptyState
            icon={FileEdit}
            title="No records"
            subtitle="Use the + icon above to add the first record"
          />
        )}

        {!loading && !error && records.length > 0 && filteredRecords.length === 0 && (
          <EmptyState icon={FileEdit} title="No results" subtitle={`No records match "${search}"`} />
        )}

        {!loading && !error && filteredRecords.length > 0 && (
          <>
            <div className="flex items-center justify-between px-4 py-2 gap-3">
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="w-4 h-4 rounded border-gray-300"
                />
                Select all
              </label>
              <p className="text-xs text-gray-400">
                {filteredRecords.length} record{filteredRecords.length !== 1 ? "s" : ""}{search && " matching"}
              </p>
            </div>
            {filteredRecords.map((r) => {
              const [f1, f2, f3] = firstThreeAttrNames.map((name) => {
                const v = r.attributes[name];
                return Array.isArray(v) ? v.join(", ") : v;
              });
              return (
                <div
                  key={r._key}
                  className="flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(r._key)}
                    onChange={() => toggleOne(r._key)}
                    className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
                  />
                  <button
                    type="button"
                    onClick={() => setEditingKey(r._key)}
                    className="flex-1 min-w-0 flex items-center gap-3 text-left"
                  >
                    <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                      <FileEdit size={14} className="text-gray-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{f1 || "(blank)"}</p>
                      {(f2 || f3) && (
                        <p className="text-xs text-gray-500 truncate mt-0.5">{[f2, f3].filter(Boolean).join(" · ")}</p>
                      )}
                    </div>
                    {r.isNew && <span className="text-xs font-medium text-blue-600 flex-shrink-0">New</span>}
                    <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
                  </button>
                </div>
              );
            })}
          </>
        )}
      </div>

      {!loading && !error && (
        <div className="flex-shrink-0 border-t border-gray-100 bg-white px-4 py-3">
          <PrimaryButton onClick={() => saveMutation.mutate()} loading={saveMutation.isPending} disabled={records.length === 0}>
            Save &amp; Run Aggregation
          </PrimaryButton>
        </div>
      )}

      {editingRecord && (
        <SourceAccountFormModal
          schema={{ attributes: exportAttrs }}
          record={editingRecord}
          onSave={handleSaveRecord}
          onClose={() => setEditingKey(null)}
          onDiscardNew={editingRecord.isNew ? handleDiscardNewRecord : undefined}
        />
      )}

      {deleteConfirmOpen && (
        <ConfirmModal
          title={`Delete ${selected.size} record${selected.size === 1 ? "" : "s"}?`}
          message="This removes the selected record(s) from this edit session only — nothing is deleted in ISC unless you Save & Run Aggregation afterward without them."
          confirmLabel="Delete"
          danger
          onConfirm={handleDeleteSelected}
          onCancel={() => setDeleteConfirmOpen(false)}
        />
      )}

      {batchEditOpen && (
        <SourceAccountBatchEditModal
          schema={{ attributes: exportAttrs }}
          identityAttribute={schema.data?.identityAttribute}
          count={selected.size}
          onApply={handleBatchEdit}
          onClose={() => setBatchEditOpen(false)}
        />
      )}
    </div>
  );
}
