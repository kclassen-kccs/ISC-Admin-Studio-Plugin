import { Loader2, CheckCircle2, XCircle, ChevronRight } from "lucide-react";

export const STATUS_META = {
  running: { icon: Loader2, className: "text-blue-600 animate-spin", label: "Running" },
  completed: { icon: CheckCircle2, className: "text-emerald-600", label: "Completed" },
  failed: { icon: XCircle, className: "text-red-600", label: "Failed" },
  cancelled: { icon: XCircle, className: "text-gray-400", label: "Cancelled" },
};

export function ScanListItem({ scan: s, onOpen, onCancel, cancelPending, onRemove, removePending, detail }) {
  const meta = STATUS_META[s.status] || STATUS_META.running;
  const StatusIcon = meta.icon;
  return (
    <div
      className={`w-full flex items-center gap-3 px-4 py-3 border-b border-gray-100 transition-colors ${
        s.status === "running" ? "bg-emerald-50 hover:bg-emerald-100" : "hover:bg-gray-50"
      }`}
    >
      <button onClick={onOpen} className="flex-1 min-w-0 flex items-center gap-3 text-left">
        <StatusIcon size={16} className={`${meta.className} flex-shrink-0`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900">
            {s.tenant ? `${s.tenant} — ` : ""}{new Date(s.startedAt).toLocaleString()}
          </p>
          <p className="text-xs text-gray-500">
            {meta.label} · {detail}
          </p>
        </div>
      </button>
      {s.status === "running" ? (
        <button
          onClick={onCancel}
          disabled={cancelPending}
          className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50 flex-shrink-0"
        >
          Cancel
        </button>
      ) : (
        <>
          {onRemove && (
            <button
              onClick={onRemove}
              disabled={removePending}
              className="text-xs font-medium text-red-600 hover:text-red-700 disabled:opacity-50 flex-shrink-0"
            >
              Remove
            </button>
          )}
          <button onClick={onOpen} className="flex-shrink-0">
            <ChevronRight size={16} className="text-gray-300" />
          </button>
        </>
      )}
    </div>
  );
}

// ─── Two-pane scan report ─────────────────────────────────────────────────────
// The mining scan reports (Role Model Draft, Role Evaluation, Data Segments
// Draft) all have the same shape: a long list of proposal cards, each far
// too tall to scan through. From md up they become a picker on the left and
// the selected item's full card on the right. Below md there isn't room for
// two panes, so `single` renders the original one-column report instead —
// unchanged, no selection step, nothing hidden behind a tap.
export function ScanMasterDetail({ listTitle, single, list, detail }) {
  return (
    <>
      <div className="md:hidden">{single}</div>
      <div className="hidden md:grid md:grid-cols-[17rem_minmax(0,1fr)] md:items-start">
        <div className="md:sticky md:top-0 md:self-start md:max-h-[calc(100vh_-_4rem)] md:overflow-y-auto md:border-r md:border-gray-100">
          {listTitle && (
            <p className="px-4 pt-3 pb-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">
              {listTitle}
            </p>
          )}
          {list}
        </div>
        <div className="min-w-0">{detail}</div>
      </div>
    </>
  );
}

// One row of a ScanMasterDetail picker. `leading` is a slot ahead of the
// button for anything that must stay independently clickable — the segment
// report's bulk-select checkbox — since nesting that inside the row button
// would be invalid markup and would swallow its clicks.
export function ScanListRow({ active, onClick, icon: Icon, iconClass = "text-violet-600", title, subtitle, tag, leading }) {
  return (
    <div
      className={`flex items-start gap-2 px-4 py-3 border-b border-gray-100 border-l-2 transition-colors ${
        active ? "bg-violet-50 border-l-violet-500" : "border-l-transparent hover:bg-gray-50"
      }`}
    >
      {leading}
      <button onClick={onClick} className="flex items-start gap-2 min-w-0 flex-1 text-left">
        {Icon && <Icon size={14} className={`${iconClass} flex-shrink-0 mt-0.5`} />}
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-medium truncate ${active ? "text-violet-900" : "text-gray-900"}`}>
            {title}
          </p>
          {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
          {tag && (
            <span className="inline-block mt-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              {tag}
            </span>
          )}
        </div>
      </button>
    </div>
  );
}
