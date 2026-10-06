import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Minus, Users, X, Sparkles, AlertTriangle, ShieldCheck, Search, ChevronDown, ChevronRight, RefreshCw, Boxes, Layers } from "lucide-react";
import toast from "react-hot-toast";
import {
  getRoleComposition, suggestRoleComposition, updateRoleEntitlements, updateDimensionEntitlements, searchEntitlements,
} from "../lib/sailpoint";
import { describeMembership } from "../lib/roleMembership";
import { Spinner, ErrorBox, EmptyState, PrimaryButton, OutlineButton, Input } from "./ui";

// Role > Composition. The role measured against the people it actually
// covers: its membership rule and members, the Common Access roles in scope,
// and — for the base role and every dimension — each entitlement's
// commonality among that level's population, split into what the level grants
// (Included) and what its people hold that it doesn't (Excluded), grouped by
// source. Items can be moved in and out from here, added by search, inspected
// down to who holds them, and the whole role can be re-proposed from the
// tenant's commonality threshold with an AI review.
//
// "Level" throughout = { kind: "base" } or { kind: "dimension", id, name }.

const pct = (n) => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;
const UNKNOWN_SOURCE = "Unknown source";

// Shading for a source's band in the access item lists. Only tints that have
// a dark-mode override in index.css, and none of the colours this screen
// already gives a meaning to (amber = Common Access, red = remove). Written
// out in full because Tailwind only ships class names it can see literally.
const SOURCE_TONES = [
  "bg-blue-100 border-blue-200",
  "bg-violet-100 border-violet-200",
  "bg-cyan-100 border-gray-200",
  "bg-emerald-100 border-emerald-200",
];
const UNKNOWN_SOURCE_TONE = "bg-gray-100 border-gray-200";

/**
 * source name -> shading, assigned once over EVERY source the role touches
 * (alphabetically), so a source keeps the same shade in the base role, in
 * each dimension, and in both the included and excluded lists — the colour
 * identifies the source, it doesn't just alternate.
 */
function sourceTonesFor(comp) {
  const names = new Set();
  const take = (list) => { for (const it of list) names.add(it.source?.name || UNKNOWN_SOURCE); };
  take(comp.base.included); take(comp.base.excluded);
  for (const d of comp.dimensions) { take(d.included); take(d.excluded); }
  const tones = new Map();
  [...names].filter((n) => n !== UNKNOWN_SOURCE).sort((a, b) => a.localeCompare(b)).forEach((n, i) => tones.set(n, SOURCE_TONES[i % SOURCE_TONES.length]));
  tones.set(UNKNOWN_SOURCE, UNKNOWN_SOURCE_TONE);
  return tones;
}

function groupBySource(items) {
  const groups = new Map();
  for (const it of items) {
    const key = it.source?.name || UNKNOWN_SOURCE;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups.entries()].sort((a, b) => (a[0] === UNKNOWN_SOURCE) - (b[0] === UNKNOWN_SOURCE) || a[0].localeCompare(b[0]));
}

function Modal({ title, onClose, children, wide, busy }) {
  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className={`bg-white w-full ${wide ? "max-w-2xl" : "max-w-lg"} md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[88vh] overflow-y-auto`}>
        <div className="flex items-center justify-between px-5 pt-5 gap-3">
          <h2 className="text-base font-semibold text-gray-900 min-w-0">{title}</h2>
          <button onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-600 disabled:opacity-50 flex-shrink-0"><X size={18} /></button>
        </div>
        <div className="px-5 pt-3 pb-5">{children}</div>
      </div>
    </div>
  );
}

function PercentBar({ percent, threshold }) {
  const tone = percent >= threshold ? "bg-emerald-500" : percent >= threshold / 2 ? "bg-amber-400" : "bg-gray-300";
  return (
    <div className="w-16 h-1.5 rounded-full bg-gray-100 overflow-hidden flex-shrink-0" title={`${pct(percent)} — threshold ${threshold}%`}>
      <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

function MemberRow({ m, navigate, right }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <button type="button" onClick={() => navigate(`/identities/${m.id}`)} className="flex-1 min-w-0 text-left hover:underline" title="Open this identity">
        <p className="text-sm font-medium text-gray-900 truncate">{m.displayName}</p>
        <p className="text-xs text-gray-500 truncate">
          {[m.jobTitle, m.department, m.email].filter(Boolean).join(" · ") || "—"}
          {m.manager ? ` · manager ${m.manager}` : ""}
        </p>
      </button>
      {right}
    </div>
  );
}

// The members pill's dialog: everyone at this level, with their details.
function MembersDialog({ title, members, navigate, onClose }) {
  const [q, setQ] = useState("");
  const shown = members.filter((m) => !q.trim() || [m.displayName, m.email, m.jobTitle, m.department].some((v) => v && String(v).toLowerCase().includes(q.trim().toLowerCase())));
  return (
    <Modal title={title} onClose={onClose}>
      {members.length > 8 && <div className="mb-2"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, title, department or email…" /></div>}
      <p className="text-xs text-gray-500 mb-2">{shown.length} of {members.length} member{members.length === 1 ? "" : "s"} — everyone who matches the membership rule right now. Click a name to open the identity.</p>
      <div className="border border-gray-100 rounded-xl divide-y divide-gray-100 max-h-[55vh] overflow-y-auto">
        {shown.length === 0 && <p className="text-sm text-gray-400 px-3 py-3">No one matches.</p>}
        {shown.map((m) => (
          <MemberRow key={m.id} m={m} navigate={navigate} right={<span className="text-[10px] text-gray-400 flex-shrink-0">{m.entitlementCount} entitlements{m.lifecycleState ? ` · ${m.lifecycleState}` : ""}</span>} />
        ))}
      </div>
    </Modal>
  );
}

// One access item: who at this level holds it, who doesn't, and the numbers.
function ItemHoldersDialog({ item, levelLabel, levelMembers, navigate, onClose }) {
  const holderIds = new Set(item.holderMembers.map((m) => m.id));
  const without = levelMembers.filter((m) => !holderIds.has(m.id));
  const [tab, setTab] = useState("with");
  const list = tab === "with" ? item.holderMembers : without;
  return (
    <Modal title={item.name} onClose={onClose}>
      <p className="text-xs text-gray-500">{item.source?.name || UNKNOWN_SOURCE} · {levelLabel}</p>
      <p className="text-sm text-gray-800 mt-2">
        <span className="font-semibold">{item.holders} of {levelMembers.length}</span> {levelMembers.length === 1 ? "person has" : "people have"} this, for{" "}
        <span className="font-semibold">{pct(item.percent)}</span> commonality.
      </p>
      {item.inCommonAccess?.length > 0 && <p className="text-xs text-amber-700 mt-1">Already granted by Common Access role {item.inCommonAccess.join(", ")}.</p>}
      <div className="flex gap-2 mt-3 mb-2">
        {[["with", `Have it (${item.holderMembers.length})`], ["without", `Don't have it (${without.length})`]].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)} className={`text-xs font-medium px-3 py-1.5 rounded-full border transition-colors ${tab === k ? "bg-blue-600 text-white border-blue-600" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>{label}</button>
        ))}
      </div>
      <div className="border border-gray-100 rounded-xl divide-y divide-gray-100 max-h-[45vh] overflow-y-auto">
        {list.length === 0 && <p className="text-sm text-gray-400 px-3 py-3">{tab === "with" ? "Nobody at this level holds it." : "Everyone at this level holds it."}</p>}
        {list.map((m) => <MemberRow key={m.id} m={m} navigate={navigate} />)}
      </div>
    </Modal>
  );
}

function ItemRow({ item, threshold, side, onOpen, onMove, busy }) {
  const flags = [];
  if (item.inCommonAccess?.length) flags.push({ text: `Common Access: ${item.inCommonAccess.join(", ")}`, tone: "bg-amber-50 text-amber-700 border-amber-200" });
  if (item.inBase) flags.push({ text: "In base role", tone: "bg-violet-50 text-violet-700 border-violet-200" });
  if (item.inDimensions?.length) flags.push({ text: `On dimension${item.inDimensions.length === 1 ? "" : "s"}: ${item.inDimensions.join(", ")}`, tone: "bg-sky-50 text-sky-700 border-sky-200" });
  return (
    <div className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50">
      <button type="button" onClick={onOpen} className="flex-1 min-w-0 text-left" title="See who has this">
        <p className="text-sm text-gray-900 truncate">{item.name}</p>
        {flags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {flags.map((f, i) => <span key={i} className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${f.tone}`}>{f.text}</span>)}
          </div>
        )}
      </button>
      <PercentBar percent={item.percent} threshold={threshold} />
      <button type="button" onClick={onOpen} className="text-xs tabular-nums text-gray-600 w-24 text-right flex-shrink-0 hover:underline" title="See who has this">
        {item.holders} · {pct(item.percent)}
      </button>
      <button
        type="button"
        onClick={onMove}
        disabled={busy}
        title={side === "included" ? "Remove this item from this level" : "Add this item to this level"}
        aria-label={side === "included" ? `Remove ${item.name}` : `Add ${item.name}`}
        className={`w-7 h-7 rounded-lg border flex items-center justify-center flex-shrink-0 disabled:opacity-40 transition-colors ${
          side === "included" ? "border-red-200 text-red-600 hover:bg-red-50" : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"
        }`}
      >
        {side === "included" ? <Minus size={14} /> : <Plus size={14} />}
      </button>
    </div>
  );
}

function ItemList({ title, help, items, side, threshold, onOpen, onMove, busy, sourceTones }) {
  // Contracted by default at every level — the header carries the count, and
  // a role with several dimensions is unreadable with every list open.
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Excluded lists can be long tails of one-off access; start with what's
  // meaningfully common and let the rest be asked for.
  const MIN = 10;
  const visible = side === "excluded" && !showAll ? items.filter((i) => i.percent >= MIN) : items;
  const hidden = items.length - visible.length;
  return (
    <div className="mt-3">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-xs font-semibold text-gray-700 uppercase tracking-wide">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {title} <span className="text-gray-400 font-normal normal-case">· {items.length}</span>
      </button>
      {open && (
        <>
          <p className="text-xs text-gray-500 mt-1 mb-2">{help}</p>
          {items.length === 0 ? (
            <p className="text-sm text-gray-400">None.</p>
          ) : (
            <div className="space-y-2">
              {groupBySource(visible).map(([source, list]) => (
                <div key={source} className="border border-gray-200 rounded-xl overflow-hidden">
                  <p className={`text-xs font-semibold text-gray-800 px-3 py-2 border-b ${sourceTones?.get(source) || UNKNOWN_SOURCE_TONE}`}>
                    {source} <span className="font-normal text-gray-600">· {list.length} item{list.length === 1 ? "" : "s"}</span>
                  </p>
                  <div className="divide-y divide-gray-100">
                    {list.map((it) => <ItemRow key={it.id} item={it} threshold={threshold} side={side} busy={busy} onOpen={() => onOpen(it)} onMove={() => onMove(it)} />)}
                  </div>
                </div>
              ))}
              {hidden > 0 && (
                <button type="button" onClick={() => setShowAll(true)} className="text-xs text-blue-600 hover:underline">
                  Show {hidden} more held by fewer than {MIN}% of members
                </button>
              )}
              {showAll && side === "excluded" && items.some((i) => i.percent < MIN) && (
                <button type="button" onClick={() => setShowAll(false)} className="text-xs text-blue-600 hover:underline">Hide items under {MIN}%</button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Add by search — the + beside a role or dimension name.
function AddItemsDialog({ levelLabel, isBase, comp, level, onClose, onConfirm }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState(() => new Map());
  const search = useQuery({
    queryKey: ["composition-ent-search", q.trim()],
    queryFn: () => searchEntitlements({ query: q.trim(), limit: 25 }),
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });
  const levelData = level.kind === "base" ? comp.base : comp.dimensions.find((d) => d.id === level.id);
  const already = new Set(levelData.included.map((i) => i.id));
  const results = (Array.isArray(search.data) ? search.data : []).filter((e) => !already.has(e.id));
  const toggle = (e) => setPicked((prev) => {
    const next = new Map(prev);
    if (next.has(e.id)) next.delete(e.id); else next.set(e.id, { id: e.id, name: e.name, source: e.source ? { id: e.source.id, name: e.source.name } : null });
    return next;
  });
  return (
    <Modal title={`Add access items to ${levelLabel}`} onClose={onClose}>
      <div className="relative mb-2">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search entitlements by name…" style={{ paddingLeft: "2rem" }} autoFocus />
      </div>
      {q.trim().length < 2 && <p className="text-xs text-gray-500">Type at least 2 characters. Items {isBase ? "the base role" : "this dimension"} already grants aren't listed.</p>}
      {search.isLoading && <div className="py-4 flex justify-center"><Spinner size={18} /></div>}
      {search.error && <p className="text-xs text-red-600">{search.error.response?.data?.error || search.error.message}</p>}
      {q.trim().length >= 2 && !search.isLoading && results.length === 0 && <p className="text-sm text-gray-400">No entitlements match that aren't already here.</p>}
      {results.length > 0 && (
        <div className="border border-gray-100 rounded-xl divide-y divide-gray-100 max-h-[40vh] overflow-y-auto">
          {results.map((e) => (
            <label key={e.id} className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-gray-50">
              <input type="checkbox" checked={picked.has(e.id)} onChange={() => toggle(e)} className="w-4 h-4 rounded border-gray-300 flex-shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-sm text-gray-900 truncate">{e.name}</span>
                <span className="block text-xs text-gray-500 truncate">{e.source?.name || UNKNOWN_SOURCE}{e.attribute ? ` · ${e.attribute}` : ""}</span>
              </span>
            </label>
          ))}
        </div>
      )}
      {picked.size > 0 && <p className="text-xs text-gray-600 mt-2">Selected: {[...picked.values()].map((p) => p.name).join(", ")}</p>}
      <PrimaryButton onClick={() => onConfirm([...picked.values()])} disabled={picked.size === 0} className="mt-3">
        Review {picked.size || ""} item{picked.size === 1 ? "" : "s"} to add
      </PrimaryButton>
      <OutlineButton onClick={onClose} className="mt-2">Cancel</OutlineButton>
    </Modal>
  );
}

/**
 * Everything worth knowing before a change is applied. Pure, so the checks
 * are the same whichever path (+, −, search) asked for the change.
 *  - blocked:  base-role adds a Common Access role already grants. The server
 *              drops those by design (roles never repeat Common Access), so
 *              they're shown as "won't be added" rather than pretending.
 *  - warnings: anything the user should see but may still do.
 *  - dimensionOverlap: for a base add, the dimensions that also grant it.
 */
export function reviewChange(comp, level, action, items) {
  // Seeded from the server's full Common Access map, so an item found by
  // search — one nobody holds and no level grants — is still checked.
  const commonOf = new Map(Object.entries(comp.commonAccessByEntitlement || {}));
  const note = (list) => { for (const i of list) if (i.inCommonAccess?.length) commonOf.set(i.id, i.inCommonAccess); };
  note(comp.base.included); note(comp.base.excluded);
  for (const d of comp.dimensions) { note(d.included); note(d.excluded); }
  const baseIds = new Set(comp.base.included.map((i) => i.id));
  const warnings = [];
  const blocked = [];
  const dimensionOverlap = []; // [{ dimension, items }]
  if (action === "add") {
    for (const it of items) {
      const common = commonOf.get(it.id);
      if (common && level.kind === "base") blocked.push({ item: it, reason: `Common Access role ${common.join(", ")} already grants it to everyone this role covers, so it won't be added to the base role.` });
      else if (common) warnings.push(`"${it.name}" is already granted by Common Access role ${common.join(", ")}.`);
      if (level.kind === "dimension" && baseIds.has(it.id)) warnings.push(`"${it.name}" is already granted by the base role, so every member of this dimension has it anyway.`);
    }
    if (level.kind === "base") {
      const adding = new Set(items.filter((it) => !blocked.some((b) => b.item.id === it.id)).map((it) => it.id));
      for (const d of comp.dimensions) {
        const hits = d.included.filter((i) => adding.has(i.id));
        if (hits.length) dimensionOverlap.push({ dimension: { id: d.id, name: d.name }, items: hits.map((i) => ({ id: i.id, name: i.name })) });
      }
    }
  }
  return { warnings, blocked, dimensionOverlap };
}

export default function RoleCompositionPanel({ roleId }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: comp, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["role-composition", roleId],
    queryFn: () => getRoleComposition(roleId),
    staleTime: 60_000,
  });

  const [membersFor, setMembersFor] = useState(null); // { title, members }
  const [itemFor, setItemFor] = useState(null); // { item, levelLabel, levelMembers }
  const [addFor, setAddFor] = useState(null); // level
  const [pending, setPending] = useState(null); // { level, action, items, review, alsoRemoveFromDimensions }
  const [suggestion, setSuggestion] = useState(null);
  // Dimensions start rolled up to a one-line summary; each expands on its
  // own, and Expand all / Collapse all act on the lot.
  const [openDims, setOpenDims] = useState(() => new Set());
  const toggleDim = (dimId) => setOpenDims((prev) => { const next = new Set(prev); if (next.has(dimId)) next.delete(dimId); else next.add(dimId); return next; });

  const levelLabel = (level) => (level.kind === "base" ? `${comp.role.name} (base role)` : `dimension "${level.name}"`);
  const membersOf = (idxList) => idxList.map((i) => comp.members[i]).filter(Boolean);
  const withHolders = (item) => ({ ...item, holderMembers: membersOf(item.holderIdx) });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["role-composition", roleId] });
    queryClient.invalidateQueries({ queryKey: ["role", roleId] });
    queryClient.invalidateQueries({ queryKey: ["role-dimensions", roleId] });
    queryClient.invalidateQueries({ queryKey: ["roles"] });
  };
  const slim = (items) => items.map((i) => ({ id: i.id, name: i.name }));

  // One place applies a change, however it was asked for.
  const apply = useMutation({
    mutationFn: async ({ level, action, items, alsoRemoveFromDimensions = [] }) => {
      const body = action === "add" ? { add: slim(items) } : { remove: items.map((i) => i.id) };
      if (level.kind === "base") await updateRoleEntitlements(roleId, body);
      else await updateDimensionEntitlements(roleId, level.id, body);
      const dimFailures = [];
      for (const o of alsoRemoveFromDimensions) {
        try { await updateDimensionEntitlements(roleId, o.dimension.id, { remove: o.items.map((i) => i.id) }); } catch (err) {
          dimFailures.push(`${o.dimension.name}: ${err.response?.data?.error || err.message}`);
        }
      }
      return { level, action, count: items.length, dimFailures, removedFrom: alsoRemoveFromDimensions.length - dimFailures.length };
    },
    onSuccess: ({ level, action, count, dimFailures, removedFrom }) => {
      toast.success(`${action === "add" ? "Added" : "Removed"} ${count} item${count === 1 ? "" : "s"} ${action === "add" ? "to" : "from"} ${level.kind === "base" ? "the base role" : `"${level.name}"`}${removedFrom ? ` and removed from ${removedFrom} dimension${removedFrom === 1 ? "" : "s"}` : ""}. Members get the change after Apply Changes / the next role propagation.`, { duration: 7000 });
      for (const f of dimFailures) toast.error(`Couldn't remove from dimension ${f}`, { duration: 8000 });
      setPending(null);
      invalidate();
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  function requestChange(level, action, items) {
    const review = reviewChange(comp, level, action, items);
    // Every change confirms — it alters who gets access — and the dialog
    // carries whatever the review found (often nothing).
    setPending({ level, action, items, review, removeFromDimensions: true });
  }

  const suggest = useMutation({
    mutationFn: () => suggestRoleComposition(roleId),
    onSuccess: (data) => setSuggestion({ data, skipped: new Set() }),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  if (isLoading) {
    return (
      <div className="px-4 py-10 flex flex-col items-center gap-3 text-center">
        <Spinner size={22} />
        <p className="text-sm text-gray-500">Measuring this role against everyone it covers…</p>
        <p className="text-xs text-gray-400 max-w-sm">This reads every identity once to find who matches the membership rule and what they hold, so a large tenant can take a little while.</p>
      </div>
    );
  }
  if (error) return <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />;
  if (!comp) return null;

  const T = comp.thresholdPercent;
  const busy = apply.isPending;
  const sourceTones = sourceTonesFor(comp);

  // A render function, NOT a component: defined in here it would be a new
  // component type on every render, remounting each list (and resetting its
  // expanded/"show all" state) whenever a dialog opened.
  const renderLevel = ({ key, level, data, membership, members, isBase }) => {
    const expanded = isBase || openDims.has(level.id);
    const aboveThreshold = data.excluded.filter((i) => i.percent >= T && !(i.inCommonAccess || []).length && !i.inBase).length;
    return (
    <div key={key} className={`border border-gray-200 rounded-2xl ${expanded ? "p-4" : "px-4 py-3"}`}>
      <div className="flex items-center gap-2 flex-wrap">
        {isBase ? (
          <>
            <Layers size={16} className="text-violet-600 flex-shrink-0" />
            <h3 className="text-sm font-semibold text-gray-900 min-w-0 truncate">{comp.role.name}</h3>
          </>
        ) : (
          <button
            type="button"
            onClick={() => toggleDim(level.id)}
            aria-expanded={expanded}
            title={expanded ? "Collapse this dimension" : "Expand this dimension"}
            className="flex items-center gap-2 min-w-0 text-left"
          >
            {expanded ? <ChevronDown size={15} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={15} className="text-gray-400 flex-shrink-0" />}
            <Boxes size={16} className="text-sky-600 flex-shrink-0" />
            <h3 className="text-sm font-semibold text-gray-900 min-w-0 truncate">{level.name}</h3>
          </button>
        )}
        <button
          type="button"
          onClick={() => setAddFor(level)}
          disabled={busy}
          title={`Add access items to ${isBase ? "the base role" : "this dimension"} — search for them`}
          aria-label={`Add access items to ${isBase ? comp.role.name : level.name}`}
          className="w-6 h-6 rounded-lg border border-emerald-200 text-emerald-700 hover:bg-emerald-50 flex items-center justify-center flex-shrink-0 disabled:opacity-40"
        >
          <Plus size={13} />
        </button>
        <button
          type="button"
          onClick={() => setMembersFor({ title: `Members of ${isBase ? comp.role.name : `"${level.name}"`}`, members })}
          className="ml-auto flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors flex-shrink-0"
          title="See who these members are"
        >
          <Users size={12} />
          {members.length} member{members.length === 1 ? "" : "s"}
        </button>
      </div>
      {!expanded && (
        <p className="text-xs text-gray-500 mt-1 pl-[1.4rem]">
          {data.included.length} included · {data.excluded.length} excluded
          {aboveThreshold > 0 && <span className="text-emerald-700 font-medium"> · {aboveThreshold} excluded at or above {T}%</span>}
        </p>
      )}
      {expanded && (
      <>
      <p className="text-xs text-gray-600 mt-2"><span className="font-medium text-gray-700">Membership rule:</span> {describeMembership(membership) || "None — no rule or identity list."}{!isBase && " (within the base role's members)"}</p>
      {members.length > 0 && members.length < 3 && (
        <p className="text-xs text-amber-700 mt-1 flex items-center gap-1"><AlertTriangle size={12} /> Only {members.length} member{members.length === 1 ? "" : "s"} — percentages here say very little.</p>
      )}
      <ItemList
        title="Included access items"
        help={`What ${isBase ? "the base role" : "this dimension"} grants today, with how many of its ${members.length} member${members.length === 1 ? "" : "s"} actually hold each. − removes one.`}
        items={data.included} side="included" threshold={T} busy={busy} sourceTones={sourceTones}
        onOpen={(it) => setItemFor({ item: withHolders(it), levelLabel: levelLabel(level), levelMembers: members })}
        onMove={(it) => requestChange(level, "remove", [it])}
      />
      <ItemList
        title="Excluded access items"
        help={`Held by these members but not granted ${isBase ? "by the base role" : "by this dimension"}. + adds one. Green bars are at or above the ${T}% commonality threshold.`}
        items={data.excluded} side="excluded" threshold={T} busy={busy} sourceTones={sourceTones}
        onOpen={(it) => setItemFor({ item: withHolders(it), levelLabel: levelLabel(level), levelMembers: members })}
        onMove={(it) => requestChange(level, "add", [it])}
      />
      </>
      )}
    </div>
    );
  };

  return (
    <div className="px-4 py-4 space-y-4">
      <div className="flex items-start gap-3 flex-wrap">
        <p className="text-xs text-gray-500 flex-1 min-w-[16rem]">
          This role measured against the {comp.members.length} {comp.members.length === 1 ? "person" : "people"} its membership rule covers right now.
          Commonality is the share of a level's members who hold an item; the tenant's threshold is <span className="font-medium text-gray-700">{T}%</span>.
          {comp.truncated ? " The identity scan hit its limit, so the population may be incomplete." : ""}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => suggest.mutate()}
            disabled={suggest.isPending || busy || comp.members.length === 0}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 transition-colors"
            title={`Propose what this role should grant, from the ${T}% commonality threshold, with an AI review`}
          >
            {suggest.isPending ? <Spinner size={13} className="text-white" /> : <Sparkles size={13} />}
            {suggest.isPending ? "Working it out…" : "Suggest changes with AI"}
          </button>
          <button type="button" onClick={() => refetch()} disabled={isFetching} title="Re-measure" className="w-8 h-8 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 flex items-center justify-center disabled:opacity-50">
            {isFetching ? <Spinner size={13} /> : <RefreshCw size={13} />}
          </button>
        </div>
      </div>

      {comp.commonAccessWarning && <p className="text-xs text-amber-700 border border-amber-200 bg-amber-50 rounded-xl px-3 py-2">{comp.commonAccessWarning}</p>}

      <div className="border border-gray-100 rounded-xl p-3">
        <p className="text-xs font-semibold text-gray-700 flex items-center gap-1.5"><ShieldCheck size={13} className="text-amber-600" /> Common Access roles in scope</p>
        {comp.commonAccessRoles.length === 0 ? (
          <p className="text-xs text-gray-500 mt-1">None — no Common Access role's membership covers this role's population.</p>
        ) : (
          <>
            <p className="text-xs text-gray-500 mt-1">Everyone in this role already gets these, so this role shouldn't repeat what they grant.</p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {comp.commonAccessRoles.map((c) => (
                <button key={c.id} type="button" onClick={() => navigate(`/roles/${c.id}`)} className="text-xs font-medium px-2.5 py-1 rounded-full border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 transition-colors" title="Open this role">
                  {c.name} <span className="font-normal text-amber-600">· {c.entitlementCount}</span>{c.enabled ? "" : " · disabled"}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {comp.members.length === 0 ? (
        <EmptyState icon={Users} title="No members" subtitle="Nobody matches this role's membership rule right now, so there is no population to measure commonality against." />
      ) : (
        <>
          {renderLevel({ key: "base", level: { kind: "base" }, data: comp.base, membership: comp.role.membership, members: comp.members, isBase: true })}
          {comp.dimensions.length > 0 && (
            <div className="flex items-center gap-3 pt-1">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Dimensions · {comp.dimensions.length}</p>
              <div className="ml-auto flex items-center gap-3 text-xs">
                <button
                  type="button"
                  onClick={() => setOpenDims(new Set(comp.dimensions.map((d) => d.id)))}
                  disabled={comp.dimensions.every((d) => openDims.has(d.id))}
                  className="text-blue-600 hover:underline disabled:text-gray-300 disabled:no-underline"
                >
                  Expand all
                </button>
                <button
                  type="button"
                  onClick={() => setOpenDims(new Set())}
                  disabled={!comp.dimensions.some((d) => openDims.has(d.id))}
                  className="text-blue-600 hover:underline disabled:text-gray-300 disabled:no-underline"
                >
                  Collapse all
                </button>
              </div>
            </div>
          )}
          {comp.dimensions.map((d) =>
            renderLevel({ key: d.id, level: { kind: "dimension", id: d.id, name: d.name }, data: d, membership: d.membership, members: membersOf(d.memberIdx), isBase: false })
          )}
        </>
      )}

      {membersFor && <MembersDialog title={membersFor.title} members={membersFor.members} navigate={navigate} onClose={() => setMembersFor(null)} />}
      {itemFor && <ItemHoldersDialog {...itemFor} navigate={navigate} onClose={() => setItemFor(null)} />}
      {addFor && (
        <AddItemsDialog
          levelLabel={levelLabel(addFor)} isBase={addFor.kind === "base"} comp={comp} level={addFor}
          onClose={() => setAddFor(null)}
          onConfirm={(items) => { const level = addFor; setAddFor(null); requestChange(level, "add", items); }}
        />
      )}

      {pending && (() => {
        const { level, action, items, review } = pending;
        const blockedIds = new Set(review.blocked.map((b) => b.item.id));
        const effective = items.filter((i) => !blockedIds.has(i.id));
        return (
          <Modal title={`${action === "add" ? "Add to" : "Remove from"} ${levelLabel(level)}?`} onClose={() => setPending(null)} busy={busy}>
            <ul className="text-sm text-gray-800 border border-gray-100 rounded-xl divide-y divide-gray-100 mb-3 max-h-40 overflow-y-auto">
              {items.map((i) => (
                <li key={i.id} className={`px-3 py-1.5 flex items-center gap-2 ${blockedIds.has(i.id) ? "text-gray-400 line-through" : ""}`}>
                  <span className="truncate flex-1">{i.name}</span>
                  <span className="text-xs text-gray-400 flex-shrink-0">{i.source?.name || ""}</span>
                </li>
              ))}
            </ul>
            {review.blocked.map((b, i) => <p key={`b${i}`} className="text-xs text-red-700 border border-red-100 bg-red-50 rounded-lg px-3 py-2 mb-2"><span className="font-medium">{b.item.name}:</span> {b.reason}</p>)}
            {review.warnings.map((w, i) => <p key={`w${i}`} className="text-xs text-amber-800 border border-amber-200 bg-amber-50 rounded-lg px-3 py-2 mb-2 flex gap-1.5"><AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />{w}</p>)}
            {review.dimensionOverlap.length > 0 && (
              <div className="border border-sky-200 bg-sky-50 rounded-lg px-3 py-2 mb-2">
                <p className="text-xs text-sky-900">
                  {review.dimensionOverlap.length === 1 ? "A dimension already grants" : "Some dimensions already grant"} what you're adding to the base role:
                </p>
                <ul className="text-xs text-sky-900 mt-1 list-disc pl-4">
                  {review.dimensionOverlap.map((o) => <li key={o.dimension.id}><span className="font-medium">{o.dimension.name}</span> — {o.items.map((x) => x.name).join(", ")}</li>)}
                </ul>
                <label className="flex items-start gap-2 mt-2 cursor-pointer">
                  <input type="checkbox" checked={pending.removeFromDimensions} onChange={() => setPending((p) => ({ ...p, removeFromDimensions: !p.removeFromDimensions }))} className="w-4 h-4 mt-0.5 rounded border-gray-300" />
                  <span className="text-xs text-sky-900">Remove {review.dimensionOverlap.length === 1 ? "it from that dimension" : "them from those dimensions"} too — once the base role grants it, the dimension doesn't need to.</span>
                </label>
              </div>
            )}
            {action === "remove" && <p className="text-xs text-gray-500 mb-2">Members keep what they already hold until the role is propagated; after that, anyone who only had this through the role loses it.</p>}
            <PrimaryButton
              onClick={() => apply.mutate({ level, action, items: effective, alsoRemoveFromDimensions: pending.removeFromDimensions ? review.dimensionOverlap : [] })}
              loading={busy}
              disabled={effective.length === 0}
              className={action === "remove" ? "!bg-red-600 hover:!bg-red-700" : ""}
            >
              {effective.length === 0 ? "Nothing to add" : `${action === "add" ? "Add" : "Remove"} ${effective.length} item${effective.length === 1 ? "" : "s"}`}
            </PrimaryButton>
            <OutlineButton onClick={() => setPending(null)} disabled={busy} className="mt-2">Cancel</OutlineButton>
          </Modal>
        );
      })()}

      {suggestion && <SuggestionDialog comp={comp} roleId={roleId} state={suggestion} setState={setSuggestion} onSaved={() => { setSuggestion(null); invalidate(); }} />}
    </div>
  );
}

// The AI suggestion: the computed proposal, the AI's read of it, the layout
// the role would end up with, and Save. Every change can be left out.
function SuggestionDialog({ comp, roleId, state, setState, onSaved }) {
  const { data, skipped } = state;
  const T = data.thresholdPercent;
  const cautionOf = useMemo(() => new Map((data.ai?.cautions || []).map((c) => [c.id, c.note])), [data]);
  const key = (levelId, action, id) => `${levelId}|${action}|${id}`;
  const toggle = (k) => setState((s) => { const next = new Set(s.skipped); if (next.has(k)) next.delete(k); else next.add(k); return { ...s, skipped: next }; });

  const levels = [
    { levelId: "base", title: `${comp.role.name} (base role)`, current: comp.base.included, ...data.proposal.base },
    ...data.proposal.dimensions.map((d) => ({ levelId: d.id, title: `Dimension "${d.name}"`, current: comp.dimensions.find((x) => x.id === d.id)?.included || [], add: d.add, remove: d.remove })),
  ];
  const kept = (lvl, action) => lvl[action].filter((c) => !skipped.has(key(lvl.levelId, action, c.id)));
  const total = levels.reduce((n, l) => n + kept(l, "add").length + kept(l, "remove").length, 0);

  const save = useMutation({
    mutationFn: async () => {
      const failures = [];
      let applied = 0;
      for (const lvl of levels) {
        const add = kept(lvl, "add"), remove = kept(lvl, "remove");
        if (!add.length && !remove.length) continue;
        const body = { ...(add.length ? { add: add.map((c) => ({ id: c.id, name: c.name })) } : {}), ...(remove.length ? { remove: remove.map((c) => c.id) } : {}) };
        try {
          if (lvl.levelId === "base") await updateRoleEntitlements(roleId, body); else await updateDimensionEntitlements(roleId, lvl.levelId, body);
          applied += add.length + remove.length;
        } catch (err) { failures.push(`${lvl.title}: ${err.response?.data?.error || err.message}`); }
      }
      return { applied, failures };
    },
    onSuccess: ({ applied, failures }) => {
      if (applied) toast.success(`Saved ${applied} change${applied === 1 ? "" : "s"} to the role. Members get them after Apply Changes / the next role propagation.`, { duration: 7000 });
      for (const f of failures) toast.error(f, { duration: 9000 });
      if (failures.length === 0) onSaved();
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const renderChange = (lvl, action, c) => {
    const k = key(lvl.levelId, action, c.id);
    const off = skipped.has(k);
    return (
      <label key={k} className={`flex items-start gap-2.5 px-3 py-2 cursor-pointer ${off ? "opacity-50" : ""}`}>
        <input type="checkbox" checked={!off} onChange={() => toggle(k)} disabled={save.isPending} className="w-4 h-4 mt-0.5 rounded border-gray-300 flex-shrink-0" />
        <span className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 ${action === "add" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-600"}`}>{action === "add" ? <Plus size={12} /> : <Minus size={12} />}</span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm text-gray-900">{c.name} <span className="text-xs text-gray-400">{c.source?.name || ""}</span></span>
          <span className="block text-xs text-gray-500">{c.reason}</span>
          {cautionOf.has(c.id) && <span className="block text-xs text-amber-800 mt-0.5"><AlertTriangle size={11} className="inline -mt-0.5 mr-1" />AI caution: {cautionOf.get(c.id)}</span>}
        </span>
      </label>
    );
  };

  return (
    <Modal title="Suggested changes" onClose={() => setState(null)} wide busy={save.isPending}>
      <p className="text-xs text-gray-500">
        Computed from the tenant's <span className="font-medium text-gray-700">{T}%</span> commonality threshold: an item belongs on a level when at least {T}% of that level's members hold it,
        at the highest level that justifies it, and never when an in-scope Common Access role already grants it. Untick anything you don't want. Nothing is saved until you press Save.
      </p>
      {data.ai?.summary && (
        <div className="border border-violet-200 bg-violet-50 rounded-xl px-3 py-2.5 mt-3">
          <p className="text-xs font-semibold text-violet-900 flex items-center gap-1.5"><Sparkles size={12} /> AI review</p>
          <p className="text-xs text-violet-900 mt-1 whitespace-pre-wrap">{data.ai.summary}</p>
        </div>
      )}
      {data.ai?.error && <p className="text-xs text-gray-500 border border-gray-200 rounded-lg px-3 py-2 mt-3">{data.ai.error}</p>}
      {data.smallPopulations?.length > 0 && (
        <p className="text-xs text-amber-800 border border-amber-200 bg-amber-50 rounded-lg px-3 py-2 mt-3">
          Very small populations — treat their percentages with care: {data.smallPopulations.map((p) => `${p.level} (${p.memberCount})`).join(", ")}.
        </p>
      )}
      {data.commonAccessWarning && <p className="text-xs text-amber-800 border border-amber-200 bg-amber-50 rounded-lg px-3 py-2 mt-3">{data.commonAccessWarning}</p>}

      {data.changeCount === 0 ? (
        <p className="text-sm text-gray-700 mt-4">No changes suggested — this role already matches what the {T}% threshold says it should grant, and repeats nothing from Common Access.</p>
      ) : (
        levels.filter((l) => l.add.length || l.remove.length).map((lvl) => {
          const removing = new Set(kept(lvl, "remove").map((c) => c.id));
          const after = [...lvl.current.filter((i) => !removing.has(i.id)).map((i) => i.name), ...kept(lvl, "add").map((c) => c.name)].sort((a, b) => a.localeCompare(b));
          return (
            <div key={lvl.levelId} className="mt-4">
              <p className="text-xs font-semibold text-gray-700">{lvl.title}</p>
              <div className="border border-gray-100 rounded-xl divide-y divide-gray-100 mt-1.5">
                {lvl.add.map((c) => renderChange(lvl, "add", c))}
                {lvl.remove.map((c) => renderChange(lvl, "remove", c))}
              </div>
              <p className="text-xs text-gray-500 mt-1.5">
                <span className="font-medium text-gray-700">New layout ({after.length} item{after.length === 1 ? "" : "s"}, was {lvl.current.length}):</span>{" "}
                {after.length ? after.join(", ") : "nothing — this level would grant no entitlements of its own."}
              </p>
            </div>
          );
        })
      )}

      {data.changeCount > 0 && (
        <PrimaryButton onClick={() => save.mutate()} loading={save.isPending} disabled={total === 0} className="mt-4">
          {total === 0 ? "Nothing selected" : `Save ${total} change${total === 1 ? "" : "s"}`}
        </PrimaryButton>
      )}
      <OutlineButton onClick={() => setState(null)} disabled={save.isPending} className="mt-2">{data.changeCount === 0 ? "Close" : "Cancel"}</OutlineButton>
    </Modal>
  );
}
