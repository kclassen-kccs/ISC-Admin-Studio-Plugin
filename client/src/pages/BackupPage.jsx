import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Archive, Download } from "lucide-react";
import { backupSpConfig } from "../lib/sailpoint";
import { TopBar } from "../components/TopBar";
import { BackupRestoreTitleMenu } from "../components/BackupRestoreTitleMenu";
import { ResultDialog } from "../components/ResultDialog";
import { PrimaryButton } from "../components/ui";

export default function BackupPage() {
  const [result, setResult] = useState(null); // { success, message } | null

  const backupMutation = useMutation({
    mutationFn: () => backupSpConfig(),
    onSuccess: ({ filename, data }) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setResult({ success: true, message: `Downloaded ${filename}.` });
    },
    onError: (err) => {
      setResult({ success: false, message: err.response?.data?.error || err.message });
    },
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<BackupRestoreTitleMenu active="Backup Configuration" />} />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
              <Archive size={18} className="text-slate-700" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">Backup</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Exports this tenant's full configuration from SailPoint ISC (SP-Config) and downloads it as a JSON file.
              </p>
            </div>
          </div>
          <PrimaryButton onClick={() => backupMutation.mutate()} loading={backupMutation.isPending}>
            <Download size={16} />
            Backup Now
          </PrimaryButton>
          {backupMutation.isPending && (
            <p className="text-xs text-gray-400 mt-2">This can take a minute or two for a large tenant…</p>
          )}
        </div>
      </div>

      {result && (
        <ResultDialog
          title={result.success ? "Backup Complete" : "Backup Failed"}
          success={result.success}
          message={result.message}
          onClose={() => setResult(null)}
        />
      )}
    </div>
  );
}
