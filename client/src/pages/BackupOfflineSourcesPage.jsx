import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Database, Download, Archive } from "lucide-react";
import toast from "react-hot-toast";
import {
  listSources, fetchAllPages, isEditableAccountSourceType, getSourceAccountSchema, exportSourceAccounts, getCredentials,
} from "../lib/sailpoint";
import { buildAccountsCsv, backupFilename, backupZipFilename, buildBackupZip } from "../lib/offlineSourceBackup";
import { TopBar } from "../components/TopBar";
import { BackupRestoreTitleMenu } from "../components/BackupRestoreTitleMenu";
import { SearchBar, SkeletonList, EmptyState, ErrorBox, PrimaryButton, OutlineButton } from "../components/ui";

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadCsv(filename, csv) {
  downloadBlob(filename, new Blob([csv], { type: "text/csv" }));
}

function BackupFilesDialog({ files, tenant, onClose }) {
  const [zipping, setZipping] = useState(false);

  async function downloadAllAsZip() {
    setZipping(true);
    try {
      const blob = await buildBackupZip(files);
      downloadBlob(backupZipFilename(tenant), blob);
    } catch (err) {
      toast.error(err.message || "Failed to build zip");
    } finally {
      setZipping(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center">
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center flex-shrink-0">
            <Archive size={18} className="text-emerald-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-900">
            {files.length} Backup{files.length === 1 ? "" : "s"} Ready
          </h2>
        </div>
        <div className="max-h-64 overflow-y-auto -mx-1 mb-4">
          {files.map((f) => (
            <div key={f.filename} className="flex items-center gap-3 px-1 py-2 border-b border-gray-100 last:border-0">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{f.sourceName}</p>
                <p className="text-xs text-gray-400 truncate">
                  {f.filename} · {f.count} account{f.count === 1 ? "" : "s"}
                </p>
              </div>
              <button
                onClick={() => downloadCsv(f.filename, f.csv)}
                className="flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700 flex-shrink-0 px-2 py-1"
              >
                <Download size={14} />
                Download
              </button>
            </div>
          ))}
        </div>
        {files.length > 1 && (
          <OutlineButton onClick={downloadAllAsZip} loading={zipping} className="mb-2">
            <Archive size={16} />
            Download All as ZIP
          </OutlineButton>
        )}
        <PrimaryButton onClick={onClose}>Done</PrimaryButton>
      </div>
    </div>
  );
}

export default function BackupOfflineSourcesPage() {
  const [selected, setSelected] = useState(() => new Set());
  const [search, setSearch] = useState("");
  const [backupFiles, setBackupFiles] = useState(null);
  const [progressText, setProgressText] = useState("");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["offline-sources"],
    queryFn: () => fetchAllPages((page) => listSources(page)),
  });

  const eligibleSources = (Array.isArray(data) ? data : []).filter((s) => isEditableAccountSourceType(s.type));

  // Defaults every eligible source to selected the first time the list
  // loads — a ref (not state) so this fires exactly once and never
  // overwrites the user's own selection on a later background refetch.
  const defaultedRef = useRef(false);
  useEffect(() => {
    if (defaultedRef.current || !data) return;
    defaultedRef.current = true;
    setSelected(new Set(eligibleSources.map((s) => s.id)));
  }, [data]);
  const q = search.trim().toLowerCase();
  const filteredSources = q ? eligibleSources.filter((s) => s.name.toLowerCase().includes(q)) : eligibleSources;
  const allSelected = filteredSources.length > 0 && filteredSources.every((s) => selected.has(s.id));

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (allSelected) {
        const next = new Set(prev);
        filteredSources.forEach((s) => next.delete(s.id));
        return next;
      }
      const next = new Set(prev);
      filteredSources.forEach((s) => next.add(s.id));
      return next;
    });
  }

  const backupMutation = useMutation({
    mutationFn: async () => {
      const tenant = getCredentials()?.tenant || "tenant";
      const chosen = eligibleSources.filter((s) => selected.has(s.id));
      const now = new Date();
      const files = [];
      for (let i = 0; i < chosen.length; i++) {
        const src = chosen[i];
        setProgressText(`Exporting ${src.name} (${i + 1}/${chosen.length})…`);
        const [schema, accounts] = await Promise.all([getSourceAccountSchema(src.id), exportSourceAccounts(src.id)]);
        const csv = buildAccountsCsv(schema, accounts);
        files.push({ sourceName: src.name, filename: backupFilename(tenant, src.name, now), csv, count: (accounts || []).length });
      }
      return { tenant, files };
    },
    onSuccess: ({ tenant, files }) => {
      setProgressText("");
      setBackupFiles({ tenant, files });
    },
    onError: (err) => {
      setProgressText("");
      toast.error(err.response?.data?.error || err.message);
    },
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<BackupRestoreTitleMenu active="Backup Offline Sources" />} loading={isLoading} />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
              <Archive size={18} className="text-slate-700" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">Backup Offline Sources</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Choose Delimited File / Generic sources to export their accounts as CSV backups.
              </p>
            </div>
          </div>
        </div>

        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={8} />}

        {!isLoading && !error && eligibleSources.length === 0 && (
          <EmptyState
            icon={Database}
            title="No offline sources"
            subtitle="No Delimited File / Generic sources were found in this tenant"
          />
        )}

        {!isLoading && !error && eligibleSources.length > 0 && (
          <>
            <SearchBar value={search} onChange={setSearch} placeholder="Search sources…" />

            {filteredSources.length === 0 && (
              <EmptyState icon={Database} title="No results" subtitle={`No sources match "${search}"`} />
            )}

            {filteredSources.length > 0 && (
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
                    {filteredSources.length} source{filteredSources.length !== 1 ? "s" : ""}{q && " matching"}
                  </p>
                </div>

                {filteredSources.map((s) => (
                  <label
                    key={s.id}
                    className="flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(s.id)}
                      onChange={() => toggleOne(s.id)}
                      className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
                    />
                    <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
                      <Database size={16} className="text-blue-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{s.name}</p>
                      <p className="text-xs text-gray-500 truncate">{s.type}</p>
                    </div>
                  </label>
                ))}
              </>
            )}
          </>
        )}
      </div>

      {!isLoading && !error && eligibleSources.length > 0 && (
        <div className="flex-shrink-0 border-t border-gray-100 bg-white px-4 py-3">
          <PrimaryButton
            onClick={() => backupMutation.mutate()}
            loading={backupMutation.isPending}
            disabled={selected.size === 0}
          >
            <Download size={16} />
            {selected.size > 0 ? `Backup Selected (${selected.size})` : "Select sources to back up"}
          </PrimaryButton>
          {backupMutation.isPending && progressText && (
            <p className="text-xs text-gray-400 mt-2 text-center">{progressText}</p>
          )}
        </div>
      )}

      {backupFiles && (
        <BackupFilesDialog
          files={backupFiles.files}
          tenant={backupFiles.tenant}
          onClose={() => {
            setBackupFiles(null);
            setSelected(new Set());
          }}
        />
      )}
    </div>
  );
}
