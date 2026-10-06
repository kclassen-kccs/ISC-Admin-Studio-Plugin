import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Upload, FileText, Database } from "lucide-react";
import toast from "react-hot-toast";
import { listSources, fetchAllPages, isEditableAccountSourceType, loadAccountsFile } from "../lib/sailpoint";
import { parseCsv, toCsv } from "../lib/csv";
import { matchSourceFromFilename, csvToBase64 } from "../lib/offlineSourceBackup";
import { TopBar } from "../components/TopBar";
import { BackupRestoreTitleMenu } from "../components/BackupRestoreTitleMenu";
import { OutlineButton, EmptyState, PrimaryButton, Field, Select } from "../components/ui";

export default function RestoreOfflineSourcePage() {
  const fileInputRef = useRef(null);
  const [fileName, setFileName] = useState(null);
  const [parsed, setParsed] = useState(null); // { headers, rows }
  const [selected, setSelected] = useState(() => new Set()); // row indices, default all
  const [sourceId, setSourceId] = useState("");

  const { data: sourcesData, isLoading: sourcesLoading } = useQuery({
    queryKey: ["offline-sources"],
    queryFn: () => fetchAllPages((page) => listSources(page)),
  });
  const eligibleSources = (Array.isArray(sourcesData) ? sourcesData : []).filter((s) => isEditableAccountSourceType(s.type));
  const selectedSource = eligibleSources.find((s) => s.id === sourceId) || null;

  const rows = parsed?.rows || [];
  const allSelected = rows.length > 0 && selected.size === rows.length;

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const { headers, rows: parsedRows } = parseCsv(reader.result);
      if (headers.length === 0) {
        toast.error("That file has no columns — is it a valid CSV export?");
        return;
      }
      setParsed({ headers, rows: parsedRows });
      setFileName(file.name);
      setSelected(new Set(parsedRows.map((_, i) => i)));
      const match = matchSourceFromFilename(file.name, eligibleSources);
      if (match) setSourceId(match.id);
    };
    reader.onerror = () => toast.error("Couldn't read that file.");
    reader.readAsText(file);
    e.target.value = ""; // allow re-selecting the same file after a reset
  }

  function toggleOne(i) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (allSelected ? new Set() : new Set(rows.map((_, i) => i))));
  }

  function reset() {
    setParsed(null);
    setFileName(null);
    setSelected(new Set());
    setSourceId("");
  }

  const aggregateMutation = useMutation({
    mutationFn: () => {
      const selectedRows = rows.filter((_, i) => selected.has(i));
      const csv = toCsv(parsed.headers, selectedRows);
      return loadAccountsFile(sourceId, { filename: fileName || "restore.csv", csvBase64: csvToBase64(csv) });
    },
    onSuccess: () => {
      toast.success(
        "Account aggregation started from the restored file. Updates won't appear immediately — ISC processes the file asynchronously, so expect a short delay before changes show up here.",
        { duration: 8000 }
      );
      reset();
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col h-screen bg-white">
      <TopBar title={<BackupRestoreTitleMenu active="Restore Offline Source" />} />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
              <Upload size={18} className="text-slate-700" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">Restore Offline Source</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Upload a previous accounts backup CSV, choose which rows to restore, then re-aggregate them into ISC.
              </p>
            </div>
          </div>

          <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleFile} className="hidden" />
          <OutlineButton onClick={() => fileInputRef.current?.click()} className="!w-auto">
            <FileText size={16} />
            {fileName ? "Choose a Different File" : "Choose Backup CSV"}
          </OutlineButton>
          {fileName && <p className="text-xs text-gray-400 mt-2">{fileName}</p>}

          {parsed && (
            <div className="mt-4">
              <Field label="Target Source">
                <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)} disabled={sourcesLoading}>
                  <option value="">{sourcesLoading ? "Loading sources…" : "Select a source…"}</option>
                  {eligibleSources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {selectedSource && (
                <p className="text-xs text-gray-400 -mt-2 flex items-center gap-1">
                  <Database size={12} /> Restoring into {selectedSource.name}
                </p>
              )}
            </div>
          )}
        </div>

        {!parsed && (
          <EmptyState icon={FileText} title="No file loaded" subtitle="Choose a backup CSV file to browse its contents" />
        )}

        {parsed && rows.length === 0 && (
          <EmptyState icon={FileText} title="Empty file" subtitle="This CSV has a header row but no data rows" />
        )}

        {parsed && rows.length > 0 && (
          <>
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
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
                {selected.size} of {rows.length} row{rows.length !== 1 ? "s" : ""} selected
              </p>
            </div>
            <div className="overflow-x-auto px-4 pb-2">
              <table className="text-xs border-collapse min-w-full">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="text-left py-2 pr-2 w-8" />
                    {parsed.headers.map((h) => (
                      <th key={h} className="text-left py-2 pr-4 font-medium text-gray-500 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          checked={selected.has(i)}
                          onChange={() => toggleOne(i)}
                          className="w-4 h-4 rounded border-gray-300"
                        />
                      </td>
                      {parsed.headers.map((h) => (
                        <td key={h} className="py-2 pr-4 text-gray-800 whitespace-nowrap max-w-xs truncate">
                          {r[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {parsed && rows.length > 0 && (
        <div className="flex-shrink-0 border-t border-gray-100 bg-white px-4 py-3">
          <PrimaryButton
            onClick={() => aggregateMutation.mutate()}
            loading={aggregateMutation.isPending}
            disabled={selected.size === 0 || !sourceId}
          >
            <Upload size={16} />
            {!sourceId
              ? "Choose a target source"
              : selected.size > 0
              ? `Aggregate Selected (${selected.size})`
              : "Select rows to aggregate"}
          </PrimaryButton>
        </div>
      )}
    </div>
  );
}
