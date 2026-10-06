import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Mail, Play, Download, CheckCircle2, Layers, Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { listSources, listAdOus, startDlScan, getDlScan, createDlGroups, addDlGroupsToRoles } from "../../lib/sailpoint";
import { TopBar } from "../../components/TopBar";
import { RoleMiningTitleMenu } from "../../components/RoleMiningTitleMenu";
import { Field, PrimaryButton, SkeletonList, ErrorBox, EmptyState, Spinner, IconButton } from "../../components/ui";

// Mail Distribution Group mining — the same peer-group discovery as role
// mining, but each peer group becomes a proposed mail DL. ISC's public API
// can't create groups on AD/Entra sources (verified live), so Create emits
// a ready-to-run Exchange PowerShell provisioning script instead.
const SELECT_CLASS = "w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-blue-400";

function matchesTarget(source, targetType) {
  const label = `${source.connectorName || ""} ${source.type || ""}`;
  return targetType === "ad" ? /active directory/i.test(label) : /entra|azure/i.test(label);
}

export default function DistributionGroupsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [targetType, setTargetType] = useState("ad");
  const [sourceId, setSourceId] = useState("");
  const [ou, setOu] = useState("");
  const [scanId, setScanId] = useState(null);
  const [selected, setSelected] = useState(new Set());

  const sourcesQuery = useQuery({ queryKey: ["sources-all"], queryFn: () => listSources({ limit: 250 }) });
  const sources = (Array.isArray(sourcesQuery.data) ? sourcesQuery.data : []).filter((s) => matchesTarget(s, targetType));
  const source = sources.find((s) => s.id === sourceId);

  const ousQuery = useQuery({
    queryKey: ["ad-ous", sourceId],
    queryFn: () => listAdOus(sourceId),
    enabled: targetType === "ad" && !!sourceId,
  });
  const ous = ousQuery.data?.ous || [];

  // Reset dependent picks when the ones above them change.
  useEffect(() => { setSourceId(""); setOu(""); }, [targetType]);
  useEffect(() => { setOu(""); }, [sourceId]);

  const scanQuery = useQuery({
    queryKey: ["dl-scan", scanId],
    queryFn: () => getDlScan(scanId),
    enabled: !!scanId,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 2500 : false),
  });
  const scan = scanQuery.data;
  const suggestions = (scan?.suggestions || []).slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base", numeric: true }));

  const start = useMutation({
    mutationFn: () => startDlScan({ targetType, sourceId, sourceName: source?.name, ou: ou || undefined }),
    onSuccess: ({ scanId: id }) => { setScanId(id); setSelected(new Set()); },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const addToRoles = useMutation({
    mutationFn: () => addDlGroupsToRoles(scanId, [...selected]),
    onSuccess: ({ results }) => {
      const ok = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        toast.success(`Added ${ok.length} group${ok.length === 1 ? "" : "s"} to their roles`);
      } else {
        toast.error(`Added ${ok.length} of ${results.length} — first failure: ${failed[0].error}`, { duration: 9000 });
      }
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["dl-scan", scanId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const create = useMutation({
    mutationFn: () => createDlGroups(scanId, [...selected]),
    onSuccess: (result) => {
      const blob = new Blob([result.script], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `distribution-groups-${targetType}.ps1`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast.success(`Provisioning script for ${result.count} group${result.count === 1 ? "" : "s"} downloaded`, { duration: 6000 });
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["dl-scan", scanId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const canScan = !!sourceId && (targetType === "entra" || !!ou) && !start.isPending && scan?.status !== "running";
  const allSelected = suggestions.length > 0 && suggestions.every((g) => selected.has(g.id));

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<RoleMiningTitleMenu active="Mail Distribution Groups" />}
        loading={scan?.status === "running"}
        action={
          <IconButton
            icon={Settings}
            title="Mining Config"
            onClick={() => navigate("/studio-settings/scanning-config")}
          />
        }
      />
      <div className="flex-1 overflow-y-auto pb-24 px-4 py-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-sky-50 flex items-center justify-center flex-shrink-0">
            <Mail size={18} className="text-sky-600" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-gray-900">Mail Distribution Groups</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Mines peer groups with the same logic as role mining. Create downloads an Exchange PowerShell
              script that creates the groups EMPTY (ISC's API can't create AD/Entra groups directly); after
              running it and aggregating entitlements, Add to Roles attaches each DL to its matching mined role —
              the role's membership then provisions the DL members through the connector.
            </p>
          </div>
        </div>

        <Field label="Create in">
          <select value={targetType} onChange={(e) => setTargetType(e.target.value)} className={SELECT_CLASS}>
            <option value="ad">Active Directory</option>
            <option value="entra">Entra</option>
          </select>
        </Field>

        <Field label="Source">
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)} className={SELECT_CLASS}>
            <option value="">{sourcesQuery.isLoading ? "Loading sources…" : `Choose a${targetType === "ad" ? "n Active Directory" : "n Entra"} source…`}</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>

        {targetType === "ad" && sourceId && (
          <Field label="Create groups in OU">
            <select value={ou} onChange={(e) => setOu(e.target.value)} className={SELECT_CLASS}>
              <option value="">{ousQuery.isLoading ? "Reading OU structure…" : "Choose an OU…"}</option>
              {ous.map((o) => (
                <option key={o.dn} value={o.dn}>{o.dn}</option>
              ))}
            </select>
            {!ousQuery.isLoading && sourceId && ous.length === 0 && (
              <p className="text-xs text-amber-600 mt-1">
                No OUs found in this source's aggregated data — aggregate accounts/entitlements first.
              </p>
            )}
          </Field>
        )}

        <PrimaryButton onClick={() => start.mutate()} loading={start.isPending || scan?.status === "running"} disabled={!canScan}>
          <Play size={16} />
          {scan?.status === "running" ? `Scanning… (${scan.scanned || 0} identities)` : "Scan for Distribution Groups"}
        </PrimaryButton>

        {scan?.status === "error" && <div className="mt-4"><ErrorBox message={scan.error} /></div>}

        {scan?.status === "complete" && (
          <div className="mt-5">
            <div className="flex items-center justify-between gap-3 mb-2">
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(suggestions.map((g) => g.id)))}
                  className="w-4 h-4 rounded border-gray-300"
                />
                Select all ({suggestions.length} group{suggestions.length === 1 ? "" : "s"})
              </label>
              <div className="flex items-center gap-2">
                <PrimaryButton
                  onClick={() => create.mutate()}
                  loading={create.isPending}
                  disabled={selected.size === 0}
                  className="!w-auto px-4"
                >
                  <Download size={15} />
                  Create {selected.size > 0 ? `(${selected.size})` : ""}
                </PrimaryButton>
                <PrimaryButton
                  onClick={() => addToRoles.mutate()}
                  loading={addToRoles.isPending}
                  disabled={selected.size === 0}
                  className="!w-auto px-4 !bg-emerald-600 hover:!bg-emerald-700"
                >
                  <Layers size={15} />
                  Add to Roles {selected.size > 0 ? `(${selected.size})` : ""}
                </PrimaryButton>
              </div>
            </div>

            {suggestions.length === 0 && (
              <EmptyState icon={Mail} title="No groups found" subtitle="The scan produced no peer groups — check the Mining Config attributes" />
            )}

            <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
              {suggestions.map((g) => (
                <label key={g.id} className="flex items-center gap-3 px-3 py-3 hover:bg-gray-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(g.id)}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(g.id)) next.delete(g.id); else next.add(g.id);
                        return next;
                      })
                    }
                    className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{g.name}</p>
                    <p className="text-xs text-gray-500 truncate mt-0.5">
                      {g.attributeCriteria.map((c) => `${c.key}: ${c.value}`).join(" · ")}
                    </p>
                  </div>
                  <span className="text-xs text-gray-400 flex-shrink-0">{g.memberCount} member{g.memberCount === 1 ? "" : "s"}</span>
                  {g.addedToRole && (
                    <span
                      title={`Added to role ${g.addedToRole.roleName}`}
                      className="text-xs font-medium px-2 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200 flex-shrink-0 truncate max-w-[10rem]"
                    >
                      {g.addedToRole.roleName}
                    </span>
                  )}
                  {g.created && (
                    <span title={`Script generated ${g.created.at}`} className="text-emerald-600 flex-shrink-0">
                      <CheckCircle2 size={15} />
                    </span>
                  )}
                </label>
              ))}
            </div>
          </div>
        )}

        {scanQuery.isFetching && scan?.status === "running" && (
          <div className="flex items-center justify-center py-6"><Spinner size={18} /></div>
        )}
      </div>
    </div>
  );
}
