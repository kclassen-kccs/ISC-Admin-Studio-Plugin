import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, BarChart3, ChevronUp, ChevronDown, X, Plus, RotateCcw } from "lucide-react";
import toast from "react-hot-toast";
import { runSchemaAnalysis, getSchemaAnalysis, setSchemaTopAttributes, setSchemaRoleBoundary } from "../../lib/sailpoint";
import { TopBar } from "../../components/TopBar";
import { StudioSettingsTitleMenu } from "../../components/StudioSettingsTitleMenu";
import { PrimaryButton, ErrorBox, EmptyState, Spinner, SectionLabel } from "../../components/ui";

const AVAILABLE_ATTRIBUTES_LIMIT = 10;

export default function SchemaAnalysisPage() {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["schema-analysis"],
    queryFn: getSchemaAnalysis,
  });

  // Locally-edited priority order — synced from the persisted result whenever
  // a new analysis is loaded or run, but left alone in between so reordering
  // isn't clobbered by anything else touching the query cache.
  const [selected, setSelected] = useState([]);
  // Same idea as `selected` above, for the Multi-Company/Division Boundary's
  // own attribute list — synced from the persisted result, then left alone
  // until saved. Enable/Create Data Segments are edited on the Mining Config
  // screen now (immediate-save toggles, not part of this page's own dirty
  // state), so only the attribute list is tracked here.
  const [boundarySelected, setBoundarySelected] = useState([]);
  const computedAt = data?.computedAt;
  useEffect(() => {
    if (computedAt) {
      setSelected(data.topAttributes);
      setBoundarySelected(data.roleBoundaryAttributes || []);
    }
  }, [computedAt]);

  const analyze = useMutation({
    mutationFn: runSchemaAnalysis,
    onSuccess: (result) => {
      queryClient.setQueryData(["schema-analysis"], result);
      toast.success("Schema analysis complete");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const saveSelection = useMutation({
    mutationFn: setSchemaTopAttributes,
    onSuccess: (result) => {
      queryClient.setQueryData(["schema-analysis"], result);
      toast.success("Priority order saved");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const saveBoundary = useMutation({
    mutationFn: () =>
      setSchemaRoleBoundary({
        enabled: !!data.roleBoundaryEnabled,
        attributes: boundarySelected,
        createDataSegments: !!data.createDataSegments,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(["schema-analysis"], result);
      toast.success("Role Boundary saved");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const candidates = data?.candidates || [];
  // An attribute picked for one list isn't offered for the other — each is
  // meant to be a distinct dimension, not shared between the two.
  const available = candidates
    .filter((c) => !selected.includes(c.key) && !boundarySelected.includes(c.key))
    .slice(0, AVAILABLE_ATTRIBUTES_LIMIT);
  const dirty = data && JSON.stringify(selected) !== JSON.stringify(data.topAttributes);
  const boundaryDirty =
    data && JSON.stringify(boundarySelected) !== JSON.stringify(data.roleBoundaryAttributes || []);

  function addAttribute(key) {
    if (selected.length >= 2) return;
    setSelected([...selected, key]);
  }
  function removeAttribute(key) {
    setSelected(selected.filter((k) => k !== key));
  }
  function move(index, dir) {
    const next = [...selected];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setSelected(next);
  }

  function addBoundaryAttribute(key) {
    if (boundarySelected.length >= 2) return;
    setBoundarySelected([...boundarySelected, key]);
  }
  function removeBoundaryAttribute(key) {
    setBoundarySelected(boundarySelected.filter((k) => k !== key));
  }
  function moveBoundary(index, dir) {
    const next = [...boundarySelected];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setBoundarySelected(next);
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<StudioSettingsTitleMenu active="Schema Analysis" />} />
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
              <BarChart3 size={18} className="text-violet-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">Schema Analysis</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Scores every identity attribute by how well it divides the tenant into peer
                groups — evenly-spread, well-populated attributes score highest. Pick and
                reorder which 2 actually get used.
              </p>
            </div>
          </div>
          <PrimaryButton onClick={() => analyze.mutate()} loading={analyze.isPending}>
            <Sparkles size={16} />
            {data ? "Re-run analysis" : "Run analysis"}
          </PrimaryButton>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-10">
            <Spinner size={20} />
          </div>
        )}
        {error && <ErrorBox message={error.message} />}

        {!isLoading && !error && !data && !analyze.isPending && (
          <EmptyState
            icon={BarChart3}
            title="No analysis yet"
            subtitle="Run analysis to find this tenant's top peer-grouping attributes"
          />
        )}

        {data && (
          <>
            <div className="px-4 pt-5 pb-2 flex items-center justify-between">
              <p className="text-xs font-bold text-gray-700 uppercase tracking-wider">
                Multi-Company or Division Boundary attributes used for Data Segments and Roles
              </p>
              {!data.roleBoundaryEnabled && (
                <span className="text-xs text-amber-600">Disabled — enable in Mining Config</span>
              )}
            </div>
            <p className="text-xs text-gray-500 px-4 pb-2">
              Pick up to 2 attributes below. Enable the boundary itself, and whether it also
              creates Data Segments, from the Role Mining section of Mining Config.
            </p>

            <div className={`px-4 flex flex-col gap-2 ${data.roleBoundaryEnabled ? "" : "opacity-40 pointer-events-none"}`}>
              {boundarySelected.length === 0 && (
                <p className="text-sm text-gray-400 pb-2">
                  No attributes selected — add up to 2 below.
                </p>
              )}
              {boundarySelected.map((key, i) => (
                <div
                  key={key}
                  className="flex items-center gap-3 border border-gray-100 rounded-xl px-3 py-2.5"
                >
                  <span className="w-6 h-6 rounded-full bg-amber-50 text-amber-600 text-xs font-semibold flex items-center justify-center flex-shrink-0">
                    {i + 1}
                  </span>
                  <span className="text-sm font-medium text-gray-900 flex-1 truncate">{key}</span>
                  <button
                    onClick={() => moveBoundary(i, -1)}
                    disabled={i === 0}
                    className="text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:hover:text-gray-400"
                  >
                    <ChevronUp size={16} />
                  </button>
                  <button
                    onClick={() => moveBoundary(i, 1)}
                    disabled={i === boundarySelected.length - 1}
                    className="text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:hover:text-gray-400"
                  >
                    <ChevronDown size={16} />
                  </button>
                  <button onClick={() => removeBoundaryAttribute(key)} className="text-gray-400 hover:text-red-500">
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>

            {boundaryDirty && (
              <div className="px-4 pt-3">
                <PrimaryButton onClick={() => saveBoundary.mutate()} loading={saveBoundary.isPending}>
                  Save Role Boundary
                </PrimaryButton>
              </div>
            )}

            <div className="flex items-center justify-between px-4 pt-5 pb-2">
              <p className="text-xs font-bold text-gray-700 uppercase tracking-wider">
                Role Creation Priority order
              </p>
              {JSON.stringify(selected) !== JSON.stringify(data.suggestedTopAttributes) && (
                <button
                  onClick={() => setSelected(data.suggestedTopAttributes)}
                  className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
                >
                  <RotateCcw size={12} />
                  Reset to suggested
                </button>
              )}
            </div>

            <div className="px-4 flex flex-col gap-2">
              {selected.length === 0 && (
                <p className="text-sm text-gray-400 pb-2">
                  No attributes selected — add up to 2 below.
                </p>
              )}
              {selected.map((key, i) => (
                <div
                  key={key}
                  className="flex items-center gap-3 border border-gray-100 rounded-xl px-3 py-2.5"
                >
                  <span className="w-6 h-6 rounded-full bg-violet-50 text-violet-600 text-xs font-semibold flex items-center justify-center flex-shrink-0">
                    {i + 1}
                  </span>
                  <span className="text-sm font-medium text-gray-900 flex-1 truncate">{key}</span>
                  <button
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                    className="text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:hover:text-gray-400"
                  >
                    <ChevronUp size={16} />
                  </button>
                  <button
                    onClick={() => move(i, 1)}
                    disabled={i === selected.length - 1}
                    className="text-gray-400 hover:text-gray-700 disabled:opacity-30 disabled:hover:text-gray-400"
                  >
                    <ChevronDown size={16} />
                  </button>
                  <button onClick={() => removeAttribute(key)} className="text-gray-400 hover:text-red-500">
                    <X size={16} />
                  </button>
                </div>
              ))}
            </div>

            {dirty && (
              <div className="px-4 pt-3">
                <PrimaryButton
                  onClick={() => saveSelection.mutate(selected)}
                  loading={saveSelection.isPending}
                  disabled={selected.length === 0}
                >
                  Save priority order
                </PrimaryButton>
              </div>
            )}

            <p className="text-xs text-gray-400 px-4 pt-3">
              {data.totalIdentities} identities analyzed · {new Date(data.computedAt).toLocaleString()}
              {" "}· scoped to{" "}
              {data.scopeQuery ? <span className="font-mono">{data.scopeQuery}</span> : "(No Scope Defined)"}
            </p>

            <SectionLabel bold>Available attributes</SectionLabel>
            <div className="border-t border-gray-100">
              {available.map((c) => (
                <div key={c.key} className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <p className="text-sm font-medium text-gray-900 truncate">{c.key}</p>
                      <p className="text-xs text-gray-500 flex-shrink-0">score {c.score.toFixed(3)}</p>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {c.distinctValues} values · avg group {c.avgGroupSize} · {Math.round(c.coverage * 100)}% coverage
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5 flex-shrink-0">
                    <button
                      type="button"
                      onClick={() => addAttribute(c.key)}
                      disabled={selected.length >= 2}
                      className="flex items-center gap-1 text-xs font-medium text-blue-600 border border-blue-200 rounded-lg px-2.5 py-1.5 hover:bg-blue-50 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                    >
                      <Plus size={14} />
                      Add to Priority List
                    </button>
                    <button
                      type="button"
                      onClick={() => addBoundaryAttribute(c.key)}
                      disabled={!data.roleBoundaryEnabled || boundarySelected.length >= 2}
                      className="flex items-center gap-1 text-xs font-medium text-amber-600 border border-amber-200 rounded-lg px-2.5 py-1.5 hover:bg-amber-50 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
                    >
                      <Plus size={14} />
                      Add to Boundary List
                    </button>
                  </div>
                </div>
              ))}
              {available.length === 0 && candidates.length > 0 && (
                <p className="text-sm text-gray-400 px-4 py-4">All candidates are selected.</p>
              )}
              {candidates.length === 0 && (
                <p className="text-sm text-gray-400 px-4 py-4">
                  No attribute in this tenant divides users into groups of 3 or more.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
