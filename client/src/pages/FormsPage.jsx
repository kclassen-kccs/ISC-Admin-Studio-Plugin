import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { ClipboardList, Trash2, X, Zap, ChevronLeft } from "lucide-react";
import toast from "react-hot-toast";
import { listFormDefinitions, getFormDefinition, deleteFormDefinition } from "../lib/sailpoint";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import {
  SkeletonList, ErrorBox, EmptyState, SearchBar, ConfirmModal, SelectionActionBar, Spinner, InfoRow,
  SegmentedPill,
} from "../components/ui";
import { useUrlState } from "../hooks/useUrlState";
import { LIST_SORT_OPTIONS, sortList, updatedSuffix } from "../lib/listSort";
import { RawJsonPanel } from "../components/RawJsonPanel";
import { usePagedList } from "../hooks/usePagedList";

// ─── Form preview rendering ─────────────────────────────────────────────────
// Renders a form definition's formElements the way ISC's runtime would lay
// them out: sections with headers, each element type as its native control.
// SELECT/TOGGLE/TEXT are live so formConditions (SHOW/HIDE driven by element
// values) evaluate in the preview exactly as they would for an end user.

// "{{$.form.input.formEmployeeName}}, Please enter..." — interpolation
// tokens become styled chips showing the input name instead of raw syntax.
function InterpolatedText({ text }) {
  const parts = String(text || "").split(/(\{\{[^}]+\}\})/g);
  return parts.map((part, i) => {
    const m = part.match(/^\{\{\s*(?:\$\.form\.input\.)?([^}]+?)\s*\}\}$/);
    if (!m) return <span key={i}>{part}</span>;
    return (
      <span
        key={i}
        className="font-mono text-[11px] font-normal bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-200 rounded px-1 py-0.5"
      >
        {m[1]}
      </span>
    );
  });
}

const INPUT_CLASS = "w-full border border-gray-200 rounded-xl bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-blue-400";

function FieldShell({ config, children }) {
  return (
    <div className="mt-4">
      {config?.label && (
        <label className="block text-xs font-medium text-gray-700 mb-1.5">
          <InterpolatedText text={config.label} />
          {config.required && <span className="text-red-600"> *</span>}
        </label>
      )}
      {children}
      {config?.helpText && <p className="text-[11px] text-gray-400 mt-1 leading-snug">{config.helpText}</p>}
    </div>
  );
}

function FormElement({ el, values, setValue, hiddenIds }) {
  if (hiddenIds.has(el.id)) return null;
  const cfg = el.config || {};
  const val = values[el.key] ?? cfg.default ?? "";

  switch (el.elementType) {
    case "SECTION":
      return (
        <div className="mt-2">
          {(cfg.label || cfg.description) && (
            <p className="text-sm font-semibold text-gray-900 mt-3">
              <InterpolatedText text={cfg.label || cfg.description} />
            </p>
          )}
          {(cfg.formElements || []).map((child) => (
            <FormElement key={child.id} el={child} values={values} setValue={setValue} hiddenIds={hiddenIds} />
          ))}
        </div>
      );
    case "DESCRIPTION":
      return (
        <div className="mt-3 text-xs text-gray-500 leading-relaxed">
          {/* description bodies can carry HTML — shown as text, not injected */}
          <InterpolatedText text={(cfg.description || cfg.label || "").replace(/<[^>]+>/g, " ")} />
        </div>
      );
    case "TEXT":
      return (
        <FieldShell config={cfg}>
          <input className={INPUT_CLASS} value={val} placeholder={cfg.placeholder || ""} onChange={(e) => setValue(el.key, e.target.value)} />
        </FieldShell>
      );
    case "TEXTAREA":
      return (
        <FieldShell config={cfg}>
          <textarea className={INPUT_CLASS} rows={3} value={val} placeholder={cfg.placeholder || ""} onChange={(e) => setValue(el.key, e.target.value)} />
        </FieldShell>
      );
    case "PHONE":
      return (
        <FieldShell config={cfg}>
          <input className={INPUT_CLASS} value={val} placeholder={cfg.placeholder || "+1 (555) 000-0000"} onChange={(e) => setValue(el.key, e.target.value)} />
        </FieldShell>
      );
    case "DATE":
      return (
        <FieldShell config={cfg}>
          <input type="date" className={INPUT_CLASS} value={val} onChange={(e) => setValue(el.key, e.target.value)} />
        </FieldShell>
      );
    case "SELECT": {
      const options = cfg.dataSource?.dataSourceType === "STATIC" ? cfg.dataSource?.config?.options || [] : null;
      return (
        <FieldShell config={cfg}>
          {options ? (
            <select className={INPUT_CLASS} value={val} onChange={(e) => setValue(el.key, e.target.value)}>
              <option value="">{cfg.placeholder || "Choose…"}</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          ) : (
            <div className={`${INPUT_CLASS} text-gray-400 flex justify-between items-center`}>
              <span>
                {cfg.placeholder || `From ${cfg.dataSource?.dataSourceType === "FORM_INPUT" ? `input "${cfg.dataSource?.config?.formInputId}"` : cfg.dataSource?.dataSourceType || "data source"}`}
              </span>
              <span>▾</span>
            </div>
          )}
        </FieldShell>
      );
    }
    case "TOGGLE": {
      const on = val === true || val === "true";
      return (
        <div className="mt-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-gray-700">
              <InterpolatedText text={cfg.label} />
              {cfg.required && <span className="text-red-600"> *</span>}
            </p>
            {cfg.helpText && <p className="text-[11px] text-gray-400 mt-1 leading-snug">{cfg.helpText}</p>}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            onClick={() => setValue(el.key, !on)}
            className={`relative w-10 h-6 rounded-full flex-shrink-0 transition-colors ${on ? "bg-blue-600" : "bg-gray-300"}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : ""}`} />
          </button>
        </div>
      );
    }
    case "CHECKBOX":
      return (
        <div className="mt-4 flex items-center gap-2">
          <input
            type="checkbox"
            checked={val === true || val === "true"}
            onChange={(e) => setValue(el.key, e.target.checked)}
            className="w-4 h-4 rounded border-gray-300 accent-blue-600"
          />
          <span className="text-xs font-medium text-gray-700"><InterpolatedText text={cfg.label} /></span>
        </div>
      );
    default:
      return (
        <FieldShell config={cfg}>
          <div className={`${INPUT_CLASS} text-gray-400 text-xs`}>{el.elementType}</div>
        </FieldShell>
      );
  }
}

// SHOW effects hide their targets until the condition is met; HIDE effects
// do the opposite. EQ/NE are the operators the tenant's forms actually use;
// anything else counts as unmet rather than guessing.
function computeHiddenIds(conditions, values) {
  const hidden = new Set();
  for (const cond of conditions || []) {
    const results = (cond.rules || []).map((r) => {
      const actual = values[r.source];
      const expect = r.value;
      if (r.operator === "EQ") return String(actual ?? "") === String(expect);
      if (r.operator === "NE") return String(actual ?? "") !== String(expect);
      return false;
    });
    const met = cond.ruleOperator === "OR" ? results.some(Boolean) : results.every(Boolean);
    for (const effect of cond.effects || []) {
      const target = effect.config?.element;
      if (!target) continue;
      if (effect.effectType === "SHOW" && !met) hidden.add(target);
      if (effect.effectType === "HIDE" && met) hidden.add(target);
    }
  }
  return hidden;
}

// Counts every element (recursing into sections) for the Details tab.
function countElements(els) {
  let n = 0;
  for (const e of els || []) {
    n += 1;
    n += countElements(e.config?.formElements);
  }
  return n;
}

const MODAL_TABS = ["Details", "Preview", "Inputs", "JSON"];

// backLabel: set when the dialog was opened from another screen's link
// (e.g. a Launcher's Forms tab) — shows a "Back to …" link, and closing
// returns there too.
export function FormPreviewModal({ formId, onClose, backLabel }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["form-definition", formId],
    queryFn: () => getFormDefinition(formId),
  });
  const [tab, setTab] = useState("Preview");
  const [values, setValues] = useState({});
  const setValue = (key, value) => setValues((prev) => ({ ...prev, [key]: value }));
  const hiddenIds = computeHiddenIds(data?.formConditions, values);
  const conditionCount = (data?.formConditions || []).length;

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[85vh] overflow-y-auto">
        <div className="sticky top-0 bg-white z-10">
          <div className="flex items-center justify-between px-5 pt-5 pb-2">
            <div className="min-w-0">
              {backLabel && (
                <button onClick={onClose} className="inline-flex items-center gap-0.5 text-xs font-medium text-blue-600 hover:text-blue-700 mb-1">
                  <ChevronLeft size={14} /> Back to {backLabel}
                </button>
              )}
              <h2 className="text-base font-semibold text-gray-900 truncate">{data?.name || "Form"}</h2>
              {data?.description && <p className="text-xs text-gray-500 truncate">{data.description}</p>}
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0 ml-3">
              <X size={18} />
            </button>
          </div>
          <div className="flex border-b border-gray-100">
            {MODAL_TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 text-center text-xs font-medium py-2.5 border-b-2 transition-colors ${
                  tab === t ? "text-blue-600 border-blue-600 bg-blue-50" : "text-gray-400 border-transparent hover:text-gray-600"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="px-5 pb-5">
          {isLoading && <SkeletonList rows={4} />}
          {error && <ErrorBox message={error.message} />}

          {data && tab === "Details" && (
            <div className="border border-gray-100 rounded-xl overflow-hidden mt-4">
              <InfoRow label="Name" value={data.name} />
              <InfoRow label="Description" value={data.description || undefined} />
              <InfoRow label="Owner" value={data.owner?.fullName || data.owner?.id} />
              <InfoRow
                label="Used by"
                value={data.usedBy?.length ? data.usedBy.map((u) => u.type.toLowerCase()).join(", ") + ` (${data.usedBy.length})` : "Nothing — unused"}
              />
              <InfoRow label="Elements" value={String(countElements(data.formElements))} />
              <InfoRow label="Inputs" value={String((data.formInput || []).length)} />
              <InfoRow label="Conditions" value={String(conditionCount)} />
              <InfoRow label="Created" value={data.created ? new Date(data.created).toLocaleString() : undefined} />
              <InfoRow label="Modified" value={data.modified ? new Date(data.modified).toLocaleString() : undefined} />
            </div>
          )}

          {data && tab === "Preview" && (
            <>
              {(data.formElements || []).map((el) => (
                <FormElement key={el.id} el={el} values={values} setValue={setValue} hiddenIds={hiddenIds} />
              ))}

              {conditionCount > 0 && (
                <div className="mt-4 flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                  <Zap size={12} className="flex-shrink-0 mt-0.5" />
                  <span>
                    {conditionCount} condition{conditionCount === 1 ? "" : "s"} — the controls above drive
                    show/hide live, exactly as ISC's runtime evaluates them.
                  </span>
                </div>
              )}

              <button
                type="button"
                disabled
                title="Preview only — forms are submitted by their workflow, not from here"
                className="w-full mt-4 bg-blue-600 text-white rounded-xl py-2.5 text-sm font-semibold opacity-50 cursor-not-allowed"
              >
                Submit
              </button>
              <p className="text-[11px] text-gray-400 text-center mt-2">
                Preview only — this form is submitted through {data.usedBy?.length ? "its workflow" : "a workflow"}, not from here.
              </p>
            </>
          )}

          {data && tab === "Inputs" && (
            (data.formInput || []).length === 0 ? (
              <p className="text-xs text-gray-400 mt-4">This form declares no inputs.</p>
            ) : (
              <div className="space-y-2 mt-4">
                {/* formInput: the values the launching workflow passes in —
                    what {{interpolation}} tokens and FORM_INPUT data sources
                    resolve against. */}
                {(data.formInput || []).map((i) => (
                  <div key={i.id} className="border border-gray-100 rounded-xl px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-900">{i.label || i.id}</p>
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-200">{i.type}</span>
                    </div>
                    <p className="text-xs text-gray-400 font-mono mt-0.5">{i.id}</p>
                    {i.description && <p className="text-xs text-gray-500 mt-1">{i.description}</p>}
                  </div>
                ))}
              </div>
            )
          )}

          {data && tab === "JSON" && (
            // Same view/pencil-edit contract as every other JSON tab — the
            // diff goes out as JSON-Patch via /api/json-edit, so only
            // changed top-level fields are sent.
            <div className="-mx-4">
              <RawJsonPanel
                data={data}
                resource="form-definitions"
                objectId={formId}
                invalidateKeys={[["form-definition", formId], ["form-definitions"]]}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Forms list ─────────────────────────────────────────────────────────────

export default function FormsPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  // URL-backed (?form=<id>) so other screens can link straight to a form's
  // details, e.g. the Launcher detail's Forms tab.
  const [previewId, setPreviewId] = useUrlState("form", "");
  const location = useLocation();
  const navigate = useNavigate();
  // { label } when another screen linked here (router state, so a plain
  // visit or a refresh after closing doesn't carry it).
  const linkedFrom = previewId && location.state?.returnLabel ? { label: location.state.returnLabel } : null;
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["form-definitions"], queryFn: listFormDefinitions });
  const all = Array.isArray(data) ? data : [];
  // URL-backed, so it survives opening a form and coming back. A–Z by default.
  const [sortBy, setSortBy] = useUrlState("sort", "name");
  const list = sortList(all.filter((f) => !search || (f.name || "").toLowerCase().includes(search.toLowerCase())), sortBy);
  const { page, pager } = usePagedList(list, { noun: "form", resetKey: `${search}|${sortBy}` });
  const allSelected = list.length > 0 && list.every((f) => selected.has(f.id));

  const deleteSelected = useMutation({
    mutationFn: async () => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await deleteFormDefinition(id);
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err.response?.data?.error || err.message });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      const failed = results.filter((r) => !r.ok);
      if (failed.length) toast.error(`Deleted ${results.length - failed.length} of ${results.length} forms — ${failed.length} failed`);
      else toast.success(`Deleted ${results.length} form${results.length === 1 ? "" : "s"}`);
      setSelected(new Set());
      setConfirmDelete(false);
      queryClient.invalidateQueries({ queryKey: ["form-definitions"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title={<BrowseTitleMenu active="Forms" />} loading={isLoading} />
      <div className="flex-1 overflow-y-auto pb-24">
        <SearchBar value={search} onChange={setSearch} placeholder="Search forms by name…" />
        <div className="flex items-center px-4 pb-2">
          <SegmentedPill label="Sort by" options={LIST_SORT_OPTIONS} active={sortBy} onChange={setSortBy} />
        </div>

        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={6} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={ClipboardList}
            title={search ? "No results" : "No forms"}
            subtitle={search ? `No forms match "${search}"` : "This tenant has no form definitions"}
          />
        )}

        {!isLoading && list.length > 0 && (
          <>
            <div className="flex items-center justify-between px-4 py-2 gap-3">
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(list.map((f) => f.id)))}
                  className="w-4 h-4 rounded border-gray-300"
                />
                Select all shown
              </label>
              <p className="text-xs text-gray-400">{list.length} form{list.length === 1 ? "" : "s"}</p>
            </div>

            {selected.size > 0 && (
              <SelectionActionBar
                count={selected.size}
                actions={[
                  {
                    icon: Trash2,
                    title: `Delete (${selected.size})`,
                    onClick: () => setConfirmDelete(true),
                    disabled: deleteSelected.isPending,
                  },
                ]}
              />
            )}

            {pager}
            {page.map((f) => (
              <div key={f.id} className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors">
                <input
                  type="checkbox"
                  checked={selected.has(f.id)}
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
                      return next;
                    })
                  }
                  className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
                />
                <button
                  onClick={() => setPreviewId(f.id)}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left active:bg-gray-100"
                >
                  <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center flex-shrink-0">
                    <ClipboardList size={16} className="text-indigo-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{f.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">
                      {[f.owner?.fullName, f.description].filter(Boolean).join(" · ") || "—"}{updatedSuffix(f, sortBy)}
                    </p>
                  </div>
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 ${
                      f.usedBy?.length
                        ? "bg-blue-50 text-blue-700 border-blue-200"
                        : "bg-gray-50 text-gray-500 border-gray-200"
                    }`}
                  >
                    {f.usedBy?.length ? `Used by ${f.usedBy.length}` : "Unused"}
                  </span>
                </button>
              </div>
            ))}
            {pager}
          </>
        )}

        {deleteSelected.isPending && (
          <div className="flex items-center justify-center py-4"><Spinner size={16} /></div>
        )}
      </div>

      {previewId && (
        <FormPreviewModal
          formId={previewId}
          backLabel={linkedFrom?.label}
          // Opened from another screen's link: closing goes back there
          // rather than leaving you on the Forms list.
          onClose={() => (linkedFrom ? navigate(-1) : setPreviewId(null))}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title={`Delete ${selected.size} form${selected.size === 1 ? "" : "s"}?`}
          message="This permanently deletes the selected form definitions from the tenant. A workflow that references a deleted form will fail at that step. This cannot be undone."
          confirmLabel="Delete"
          danger
          pending={deleteSelected.isPending}
          onConfirm={() => deleteSelected.mutate()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
