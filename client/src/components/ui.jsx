import { Loader2, AlertCircle, AlertTriangle, CheckCircle2, XCircle, Clock, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

// ─── Spinner ──────────────────────────────────────────────────────────────────
export function Spinner({ size = 18, className = "" }) {
  return (
    <Loader2
      size={size}
      className={`animate-spin text-blue-500 ${className}`}
    />
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────
const STATUS_MAP = {
  PENDING_APPROVAL: { label: "Pending", color: "bg-amber-50 text-amber-800 border-amber-200" },
  PENDING: { label: "Pending", color: "bg-amber-50 text-amber-800 border-amber-200" },
  APPROVED: { label: "Approved", color: "bg-green-50 text-green-800 border-green-200" },
  REJECTED: { label: "Rejected", color: "bg-red-50 text-red-800 border-red-200" },
  DENIED: { label: "Denied", color: "bg-red-50 text-red-800 border-red-200" },
  CANCELLED: { label: "Cancelled", color: "bg-gray-100 text-gray-600 border-gray-200" },
  COMPLETED: { label: "Completed", color: "bg-green-50 text-green-800 border-green-200" },
  REQUEST_COMPLETED: { label: "Completed", color: "bg-green-50 text-green-800 border-green-200" },
  EXECUTING: { label: "Pending", color: "bg-amber-50 text-amber-800 border-amber-200" },
  TERMINATED: { label: "Terminated", color: "bg-gray-100 text-gray-600 border-gray-200" },
  PROVISIONING_VERIFICATION_PENDING: { label: "Verifying", color: "bg-amber-50 text-amber-800 border-amber-200" },
  PROVISIONING_FAILED: { label: "Failed", color: "bg-red-50 text-red-800 border-red-200" },
  NOT_ALL_ITEMS_PROVISIONED: { label: "Partial", color: "bg-amber-50 text-amber-800 border-amber-200" },
  ERROR: { label: "Error", color: "bg-red-50 text-red-800 border-red-200" },
  ACTIVE: { label: "Active", color: "bg-blue-50 text-blue-800 border-blue-200" },
  INACTIVE: { label: "Inactive", color: "bg-gray-100 text-gray-500 border-gray-200" },
};

export function StatusBadge({ status }) {
  const s = STATUS_MAP[status?.toUpperCase()] || {
    label: status || "Unknown",
    color: "bg-gray-100 text-gray-500 border-gray-200",
  };
  return (
    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full border ${s.color}`}>
      {s.label}
    </span>
  );
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
const AVATAR_COLORS = [
  "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-violet-100 text-violet-700",
  "bg-amber-100 text-amber-800",
  "bg-rose-100 text-rose-700",
  "bg-cyan-100 text-cyan-700",
];

export function Avatar({ name = "?", size = "md" }) {
  const initials = name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  let hash = 0;
  for (const ch of name) hash = (hash << 5) - hash + ch.charCodeAt(0);
  const color = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  const sz =
    size === "lg"
      ? "w-14 h-14 text-xl"
      : size === "sm"
      ? "w-8 h-8 text-xs"
      : "w-10 h-10 text-sm";
  return (
    <div className={`${sz} ${color} rounded-full flex items-center justify-center font-semibold flex-shrink-0`}>
      {initials}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────
export function EmptyState({ icon: Icon, title, subtitle, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      {Icon && <Icon size={40} className="text-gray-300 mb-4" />}
      <p className="text-gray-500 font-medium">{title}</p>
      {subtitle && <p className="text-gray-400 text-sm mt-1">{subtitle}</p>}
      {action}
    </div>
  );
}

// ─── Error box ────────────────────────────────────────────────────────────────
export function ErrorBox({ message, onRetry }) {
  return (
    <div className="mx-4 mt-4 bg-red-50 border border-red-200 rounded-xl p-4 flex gap-3">
      <AlertCircle size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-red-700">{message}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="mt-2 text-xs text-red-600 underline"
          >
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Loading placeholder rows ─────────────────────────────────────────────────
export function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 p-4 border-b border-gray-100 animate-pulse">
      <div className="w-10 h-10 rounded-full bg-gray-100 flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-3 bg-gray-100 rounded w-2/3" />
        <div className="h-3 bg-gray-100 rounded w-1/2" />
      </div>
    </div>
  );
}

export function SkeletonList({ rows = 5 }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

// ─── Section header ───────────────────────────────────────────────────────────
// bold: heavier weight AND a darker color for screens that want their
// section titles to stand out more (the Studio Settings config screens)
// without changing every other list/detail screen already using this
// component. font-bold alone on the default text-gray-400 barely reads as
// different at this size — the color needs to move too, or it still looks
// just as dim.
export function SectionLabel({ children, bold = false }) {
  return (
    <p
      className={`text-xs uppercase tracking-wider px-4 pt-5 pb-2 ${
        bold ? "font-bold text-gray-700" : "font-semibold text-gray-400"
      }`}
    >
      {children}
    </p>
  );
}

// ─── Metric card ─────────────────────────────────────────────────────────────
export function MetricCard({ label, value, sub, accent, onClick }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={`bg-gray-50 rounded-xl p-4 text-left w-full ${onClick ? "hover:bg-gray-100 active:bg-gray-200 transition-colors" : ""}`}
    >
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-3xl font-semibold ${accent || "text-gray-900"}`}>
        {value ?? <Spinner size={20} />}
      </p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </Tag>
  );
}

// ─── Info row (key/value pair in a detail card) ───────────────────────────────
export function InfoRow({ label, value }) {
  if (!value) return null;
  return (
    <div className="flex justify-between items-center py-3 border-b border-gray-100 last:border-0 gap-4">
      <span className="text-sm text-gray-500 flex-shrink-0">{label}</span>
      {/* flex-1 min-w-0 is what actually lets truncate bite — without it a
          flex item with no explicit width sizes to its own content (a long
          unbroken value, e.g. a joined list of role names) and forces the
          row, and the page, wider instead of clipping. title keeps the
          full value reachable on hover since it's now cut off visually. */}
      <span className="text-sm text-gray-900 font-medium text-right truncate flex-1 min-w-0" title={String(value)}>
        {value}
      </span>
    </div>
  );
}

// ─── Approval action icons ────────────────────────────────────────────────────
export function ApprovalStatusIcon({ status }) {
  const s = (status || "").toUpperCase();
  if (s === "APPROVED") return <CheckCircle2 size={16} className="text-green-500" />;
  if (s === "REJECTED" || s === "DENIED") return <XCircle size={16} className="text-red-400" />;
  return <Clock size={16} className="text-amber-500" />;
}

// ─── Mobile page wrapper ──────────────────────────────────────────────────────
export function PageWrapper({ children }) {
  return (
    <div className="flex-1 overflow-y-auto pb-24 bg-white">{children}</div>
  );
}

// ─── List row ────────────────────────────────────────────────────────────────
export function ListRow({ left, title, subtitle, right, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
    >
      {left}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{title}</p>
        {subtitle && <p className="text-xs text-gray-500 truncate mt-0.5">{subtitle}</p>}
      </div>
      {right}
    </button>
  );
}

// ─── Filter pill bar ──────────────────────────────────────────────────────────
// Wraps onto a second line instead of scrolling horizontally — this used to
// be `overflow-x-auto scrollbar-hide` (a horizontally-scrollable row with no
// visible scrollbar), which on a narrow viewport made any `right`-side
// content that didn't fit next to the left pills reachable only via an
// invisible swipe: it looked identical to content being cut off, since
// there was no scrollbar and the page itself doesn't scroll sideways
// (`overflow-x: hidden` on body — see index.css). Wrapping keeps every
// control visible and reachable with no hidden gesture required.
export function FilterBar({ options, active, onChange, right }) {
  return (
    <div className="flex items-center flex-wrap gap-2 px-4 py-3 border-b border-gray-100">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`flex-shrink-0 text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${
            active === opt.value
              ? "bg-blue-600 text-white border-blue-600"
              : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
          }`}
        >
          {opt.label}
        </button>
      ))}
      {right && <div className="ml-auto flex-shrink-0 pl-2">{right}</div>}
    </div>
  );
}

// "Page 2 of 7 (656 entitlements)" — where a pager stands, for every paged
// list. `total` is the whole result set, not the page; when ISC hasn't given
// one (null / undefined) it falls back to just "Page 2" rather than guessing.
// `noun` is the singular ("entitlement", "member"); "y" endings pluralize to
// "ies", everything else takes an "s".
// ISC's offset APIs (and its Search) refuse offset + limit beyond 10,000
// ("count exceeded max limit of offset and limit", verified live on a tenant
// with ~148,000 entitlements). Server-paged lists pass this as maxOffset so
// the pager never offers a page ISC would reject.
export const ISC_MAX_PAGING_WINDOW = 10000;
export const iscMaxOffset = (pageSize) => Math.max(0, ISC_MAX_PAGING_WINDOW - pageSize);

const pluralize = (noun, n) => (n === 1 ? noun : /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`);

export function PageIndicator({ offset, pageSize, total, noun = "item", maxOffset }) {
  const page = Math.floor(offset / pageSize) + 1;
  if (typeof total !== "number") return <p className="text-xs text-gray-400">Page {page.toLocaleString()}</p>;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // When the result set is bigger than the API will page through, count the
  // pages that are actually reachable rather than advertising a page number
  // that would come back 400. The red line below says why the rest are gone.
  const reachablePages = maxOffset != null ? Math.min(pages, Math.floor(maxOffset / pageSize) + 1) : pages;
  const reachable = Math.min(total, reachablePages * pageSize);
  return (
    <div className="min-w-0">
      <p className="text-xs text-gray-400">
        Page {Math.min(page, reachablePages).toLocaleString()} of {reachablePages.toLocaleString()} ({total.toLocaleString()} {pluralize(noun, total)})
      </p>
      {reachablePages < pages && (
        <p className="flex items-center gap-1 text-xs font-medium text-red-600 mt-0.5">
          <AlertTriangle size={12} className="flex-shrink-0" />
          <span>
            ISC returns at most {ISC_MAX_PAGING_WINDOW.toLocaleString()} results — the {(total - reachable).toLocaleString()} {pluralize(noun, total - reachable)}{" "}
            past page {reachablePages.toLocaleString()} can only be reached by narrowing the search or filters.
          </span>
        </p>
      )}
    </div>
  );
}

// A paged list's pager: the PageIndicator plus previous / next arrows. Shown
// above AND below the list it pages — on a 100-row page the bottom one is a
// long scroll away, and the top one alone strands you at the end of the page.
// onOffsetChange(newOffset). `hasNext` is only needed when it isn't simply
// "there are rows beyond this page" (e.g. no total known). `compact` is the
// small inline variant for a list nested inside a card.
export function Pager({ offset, pageSize, total, noun, onOffsetChange, hasNext, busy = false, compact = false, className = "", maxOffset }) {
  const canPrev = offset > 0;
  const atCap = maxOffset != null && offset >= maxOffset;
  const canNext = (hasNext ?? (typeof total === "number" ? offset + pageSize < total : true)) && !atCap;
  // First/Last jumps. Last needs a known total to work out where the end is;
  // without one (a server-paged list whose count ISC didn't give) it stays
  // disabled rather than guessing at an offset. maxOffset clamps it to the
  // last page the API will actually serve.
  const trueLast = typeof total === "number" ? Math.max(0, Math.floor(Math.max(total - 1, 0) / pageSize) * pageSize) : null;
  const lastOffset = trueLast == null ? null : maxOffset != null ? Math.min(trueLast, maxOffset) : trueLast;
  const canLast = lastOffset != null && offset < lastOffset;
  const small = compact ? "!w-6 !h-6" : "";
  return (
    <div className={`flex items-center justify-between ${compact ? "py-1" : "px-4 py-3"} ${className}`}>
      <PageIndicator offset={offset} pageSize={pageSize} total={total} noun={noun} maxOffset={maxOffset} />
      <div className={`flex flex-shrink-0 ${compact ? "gap-1" : "gap-2"}`}>
        <IconButton icon={ChevronsLeft} title="First page" onClick={() => onOffsetChange(0)} disabled={!canPrev || busy} className={small} />
        <IconButton icon={ChevronLeft} title="Previous page" onClick={() => onOffsetChange(Math.max(0, offset - pageSize))} disabled={!canPrev || busy} className={small} />
        <IconButton icon={ChevronRight} title="Next page" onClick={() => onOffsetChange(offset + pageSize)} disabled={!canNext || busy} className={small} />
        <IconButton
          icon={ChevronsRight}
          title={lastOffset == null ? "Last page — unavailable until the total is known" : lastOffset < trueLast ? "Last page ISC will serve — search to reach beyond it" : "Last page"}
          onClick={() => onOffsetChange(lastOffset)}
          disabled={!canLast || busy}
          className={small}
        />
      </div>
    </div>
  );
}

// One pill holding every choice of a single-select filter, the active one
// filled — for putting several filters side by side on one line, where a
// FilterBar's separate pills would run together. `label` names the filter
// for screen readers (the choices alone — "All" — don't say what they filter).
export function SegmentedPill({ options, active, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-shrink-0 items-center rounded-full border border-gray-200 bg-white p-0.5">
      {options.map((opt) => (
        <button
          key={opt.value}
          role="radio"
          aria-checked={active === opt.value}
          onClick={() => onChange(opt.value)}
          className={`text-xs font-medium px-3 py-1 rounded-full transition-colors ${
            active === opt.value ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── Search bar ───────────────────────────────────────────────────────────────
export function SearchBar({ value, onChange, placeholder = "Search…" }) {
  return (
    <div className="flex items-center gap-2 mx-4 my-3 bg-gray-100 rounded-xl px-3 py-2.5">
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="text-gray-400 flex-shrink-0">
        <path d="M10 6.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Zm-.794 3.5 2.647 2.646-.707.708L8.5 10.206A4.5 4.5 0 1 1 9.206 10Z" fill="currentColor" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-transparent text-sm text-gray-900 placeholder-gray-400 outline-none"
      />
      {value && (
        <button onClick={() => onChange("")} className="text-gray-400 hover:text-gray-600">
          <XCircle size={15} />
        </button>
      )}
    </div>
  );
}

// ─── Icon button with hover tooltip ────────────────────────────────────────────
// A small circular icon-only button that shows its purpose as a custom
// tooltip bubble on hover — native title/aria-label kept as a fallback, but
// the visible bubble is easier to notice than the browser default.
export function IconButton({ icon: Icon, title, onClick, loading, disabled, className = "" }) {
  return (
    <div className="relative group flex-shrink-0">
      <button
        onClick={onClick}
        disabled={disabled || loading}
        title={title}
        aria-label={title}
        className={`w-9 h-9 rounded-full border border-gray-200 flex items-center justify-center text-gray-600 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-40 transition-colors ${className}`}
      >
        {loading ? <Spinner size={15} /> : <Icon size={16} />}
      </button>
      {/* Right-anchored, not centered: these buttons routinely sit flush
          against the right edge of a toolbar (TopBar's action row, a
          SelectionActionBar), just px-4 from the actual window edge — a
          centered tooltip on a long title extended past the window and
          forced a horizontal scrollbar on the whole page even at rest
          (opacity-0 still occupies layout space). Extending left instead
          of right avoids that regardless of where the button sits. */}
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full mt-1.5 max-w-[12rem] text-right rounded-md bg-gray-900 px-2 py-1 text-[11px] font-medium text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 z-10"
      >
        {title}
      </span>
    </div>
  );
}

// ─── Selection action bar ──────────────────────────────────────────────────────
// The row shown under a list's "Select all" header once selected.size > 0 —
// a compact row of IconButtons (not full-width labeled buttons) for
// whatever bulk actions apply to the current selection, same shape reused
// across every list screen (Roles/Access Profiles/Data Segments/
// Applications/Sources) instead of each page hand-rolling its own bulk
// action bar. `actions` is [{icon, title, onClick, loading?, disabled?,
// danger?}] — `danger: true` (e.g. Delete) gets the red outline treatment;
// `title` is also the tooltip text, so it should name the action AND how
// many it applies to (e.g. "Enable (3)").
export function SelectionActionBar({ count, label = "selected", progressText, actions }) {
  return (
    <div className="px-4 pb-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs text-gray-400 flex-shrink-0">{count} {label}</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          {actions.map((a, i) => (
            <IconButton
              key={i}
              icon={a.icon}
              title={a.title}
              onClick={a.onClick}
              loading={a.loading}
              disabled={a.disabled}
              className={a.danger ? "!border-red-200 !text-red-600 hover:!bg-red-50" : ""}
            />
          ))}
        </div>
      </div>
      {progressText && <p className="text-xs text-gray-500 mt-1.5">{progressText}</p>}
    </div>
  );
}

// ─── Primary button ───────────────────────────────────────────────────────────
export function PrimaryButton({ children, onClick, loading, disabled, className = "" }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`w-full flex items-center justify-center gap-2 bg-blue-600 text-white font-medium text-sm py-3.5 rounded-xl hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${className}`}
    >
      {loading && <Spinner size={16} className="text-white" />}
      {children}
    </button>
  );
}

// ─── Outline button ───────────────────────────────────────────────────────────
export function OutlineButton({ children, onClick, loading, disabled, className = "" }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`w-full flex items-center justify-center gap-2 border border-gray-200 text-gray-700 font-medium text-sm py-3 rounded-xl hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${className}`}
    >
      {loading && <Spinner size={16} />}
      {children}
    </button>
  );
}

// ─── Confirm modal ────────────────────────────────────────────────────────────
// Generic "are you sure" overlay for destructive/impactful actions — a title,
// a message, an optional in-progress line (for bulk actions with a counter),
// and Confirm/Cancel. `danger` swaps Confirm to red for destructive actions.
export function ConfirmModal({ title, message, confirmLabel = "Confirm", danger, pending, progressText, onConfirm, onCancel, children }) {
  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onCancel()}
    >
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${danger ? "bg-red-50" : "bg-blue-50"}`}>
            <AlertTriangle size={18} className={danger ? "text-red-600" : "text-blue-600"} />
          </div>
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
        </div>
        {message && <p className="text-sm text-gray-600 mb-4">{message}</p>}
        {children}
        {pending && progressText && (
          <p className="text-xs text-gray-500 mb-3">{progressText}</p>
        )}
        <div className="flex gap-2">
          <PrimaryButton
            onClick={onConfirm}
            loading={pending}
            className={danger ? "!bg-red-600 hover:!bg-red-700 active:!bg-red-800" : ""}
          >
            {confirmLabel}
          </PrimaryButton>
          <OutlineButton onClick={onCancel} disabled={pending}>
            Cancel
          </OutlineButton>
        </div>
      </div>
    </div>
  );
}

// ─── Form field ───────────────────────────────────────────────────────────────
export function Field({ label, children }) {
  return (
    <div className="mb-4">
      <label className="block text-xs font-medium text-gray-500 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

export function Input({ type = "text", ...props }) {
  return (
    <input
      type={type}
      className="w-full bg-white border border-gray-200 rounded-xl px-3 py-3 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition"
      {...props}
    />
  );
}

export function Select({ children, ...props }) {
  return (
    <select
      className="w-full border border-gray-200 rounded-xl px-3 py-3 text-sm text-gray-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition bg-white"
      {...props}
    >
      {children}
    </select>
  );
}

export function Textarea({ ...props }) {
  return (
    <textarea
      rows={4}
      className="w-full bg-white border border-gray-200 rounded-xl px-3 py-3 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition resize-none"
      {...props}
    />
  );
}
