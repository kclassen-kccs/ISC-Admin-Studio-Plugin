import { useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Server, Key, ChevronRight, X, Info, Shield, ShieldCheck, Shapes, Link, Maximize2, Minimize2, Activity, Power, PowerOff, Trash2, Split, BadgeCheck, UsersRound, Mail } from "lucide-react";
import {
  getIdentity, getIdentityAccounts, getIdentityEntitlements, getIdentityAccess,
  getEntitlementsByIds, setIdentityLifecycleState, sortByName,
  getIdentitySegments, getIdentityIscSegments, getSchemaAnalysis, getCredentials, setAccountEnabled, removeAccountFromIsc, inviteIdentity,
} from "../lib/sailpoint";
import { TopBar } from "../components/TopBar";
import { SegmentsTabPanel } from "../components/SegmentsTabPanel";
import { IdentityActivityPanel } from "../components/IdentityActivityPanel";
import { UserLevelsPanel, GovernanceGroupsPanel } from "../components/IdentityAccessAdminPanels";
import { SetLifecycleStateModal } from "../components/SetLifecycleStateModal";
import { Avatar, InfoRow, SkeletonList, ErrorBox, Spinner, SearchBar, IconButton, SelectionActionBar, ConfirmModal } from "../components/ui";
import { ResultDialog } from "../components/ResultDialog";
import toast from "react-hot-toast";
import { tenantUiHost } from "../lib/tenantHost";

function fmtDate(d) {
  if (!d) return "";
  try { return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return ""; }
}

function labelizeKey(key) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

// Core fields rendered explicitly above; skip duplicating them from the
// freeform attributes map.
const CORE_ATTR_KEYS = new Set(["displayname", "email", "name", "uid", "id"]);

// ─── Account detail sheet ─────────────────────────────────────────────────────────

// Top-level account fields shown explicitly with friendly labels/formatting;
// everything else non-blank (plus the freeform attributes map) is listed below.
const ACCOUNT_FIELD_LABELS = {
  name: "Name",
  nativeIdentity: "Native identity",
  description: "Description",
  type: "Type",
  uuid: "UUID",
  origin: "Origin",
  manuallyCorrelated: "Manually correlated",
  hasEntitlements: "Has entitlements",
};
const ACCOUNT_SKIP_KEYS = new Set([
  "id", "name", "attributes", "source", "owner", "owners",
  "correlatedIdentity", "disabled", "locked", "recommendation",
  "classificationMethod", "correlatedEntities", "subType", "privilegeLevel",
]);

// Account field row for the account sheet: label column on the left, the
// value wrapping onto more lines (never truncated) on the right, with side
// padding so neither touches the box edge. Long unbroken values (DNs, ids,
// JSON) break anywhere rather than pushing into the label.
function AccountRow({ label, value }) {
  if (value == null || value === "") return null;
  return (
    <div className="flex items-start gap-4 px-3 py-2.5 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500 w-2/5 md:w-1/3 flex-shrink-0 break-words">{label}</span>
      <span className="text-sm text-gray-900 font-medium flex-1 min-w-0 text-right [overflow-wrap:anywhere] whitespace-pre-wrap">{value}</span>
    </div>
  );
}

function AccountDetailSheet({ account, onClose }) {
  const extraFields = Object.entries(account)
    .filter(([key, value]) => value != null && value !== "" && !ACCOUNT_SKIP_KEYS.has(key))
    .sort(([a], [b]) => (ACCOUNT_FIELD_LABELS[a] || labelizeKey(a)).localeCompare(ACCOUNT_FIELD_LABELS[b] || labelizeKey(b)));
  const attrEntries = Object.entries(account.attributes || {})
    .filter(([, value]) => value != null && value !== "")
    .sort(([a], [b]) => labelizeKey(a).localeCompare(labelizeKey(b)));

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-white w-full max-w-3xl md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[90vh] flex flex-col">
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 bg-gray-200 rounded-full" />
        </div>
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
            <Server size={18} className="text-gray-500" />
            Account
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <h3 className="text-base font-semibold text-gray-900 mb-3">{account.name}</h3>

          <div className="border border-gray-100 rounded-xl overflow-hidden mb-4">
            <AccountRow label="Source" value={account.source?.name || account.sourceName} />
            <AccountRow label="Status" value={account.disabled ? "Disabled" : account.locked ? "Locked" : "Active"} />
            <AccountRow label="Correlated identity" value={account.correlatedIdentity?.name} />
            <AccountRow label="Owner" value={account.owner?.name} />
            {extraFields.map(([key, value]) => (
              <AccountRow
                key={key}
                label={ACCOUNT_FIELD_LABELS[key] || labelizeKey(key)}
                value={typeof value === "object" ? JSON.stringify(value) : String(value)}
              />
            ))}
          </div>

          {attrEntries.length > 0 && (
            <>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-1">Attributes</p>
              <div className="border border-gray-100 rounded-xl overflow-hidden">
                {attrEntries.map(([key, value]) => (
                  <AccountRow
                    key={key}
                    label={labelizeKey(key)}
                    value={typeof value === "object" ? JSON.stringify(value) : String(value)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Accounts panel ──────────────────────────────────────────────────────────────

// An account's source supports a feature ("ENABLE", …) — `features` is a
// comma-separated string on v2025 accounts, an array on the newer shape.
const accountSupports = (acct, feature) =>
  (Array.isArray(acct.features) ? acct.features : String(acct.features || "").split(",")).map((f) => String(f).trim()).includes(feature);

const accountSourceName = (acct) => acct.source?.name || acct.sourceName || "";

function AccountsPanel({ identityId, identityName, onSelect }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["identity-accounts", identityId],
    queryFn: () => getIdentityAccounts(identityId),
  });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [confirm, setConfirm] = useState(null); // "disable" | "remove"
  const [progress, setProgress] = useState(null);
  const [bulkResult, setBulkResult] = useState(null);

  const all = Array.isArray(data) ? data : [];
  const q = search.trim().toLowerCase();
  const list = all.filter(
    (a) => !q || [accountSourceName(a), a.name, a.nativeIdentity, a.attributes?.displayName].some((v) => String(v || "").toLowerCase().includes(q))
  );
  // Selection is over what's listed — a search can hide a selected row, and
  // an action must never reach an account the user can't see.
  const chosen = list.filter((a) => selected.has(a.id));
  const allSelected = list.length > 0 && list.every((a) => selected.has(a.id));
  const toggleOne = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(list.map((a) => a.id)));

  // What each action applies to. Enable / disable only make sense where the
  // state would change AND the source's connector supports it (ISC refuses
  // otherwise); those are skipped up front and counted, not failed.
  const targets = {
    enable: chosen.filter((a) => a.disabled && accountSupports(a, "ENABLE")),
    disable: chosen.filter((a) => !a.disabled && accountSupports(a, "ENABLE")),
    remove: chosen,
  };
  const unsupported = chosen.filter((a) => !accountSupports(a, "ENABLE")).length;

  const bulk = useMutation({
    mutationFn: async (action) => {
      const items = targets[action];
      const failed = [];
      let done = 0;
      // One at a time: each is a provisioning request, and ISC rate-limits bursts.
      for (const a of items) {
        try {
          if (action === "remove") await removeAccountFromIsc(a.id);
          else await setAccountEnabled(a.id, action === "enable");
        } catch (err) {
          failed.push(`${accountSourceName(a) || a.name}: ${err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message}`);
        }
        setProgress(`${++done} of ${items.length}…`);
      }
      return { action, total: items.length, failed };
    },
    onSettled: () => {
      setProgress(null);
      setConfirm(null);
      queryClient.invalidateQueries({ queryKey: ["identity-accounts", identityId] });
      queryClient.invalidateQueries({ queryKey: ["identity-activity", identityId] });
    },
    onSuccess: (r) => {
      const ok = r.total - r.failed.length;
      const what = { enable: "Enable", disable: "Disable", remove: "Removal" }[r.action];
      if (r.failed.length === 0) {
        toast.success(
          r.action === "remove"
            ? `${ok} account${ok === 1 ? "" : "s"} being removed from ISC`
            : `${what} requested for ${ok} account${ok === 1 ? "" : "s"} — ISC provisions it to the source; it can take a few minutes to show here.`,
          { duration: 8000 }
        );
      } else {
        setBulkResult({ title: `${what}: ${ok} of ${r.total} submitted`, message: `These could not be submitted:\n${r.failed.map((f) => `• ${f}`).join("\n")}` });
      }
      setSelected(new Set());
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) return <SkeletonList rows={3} />;
  if (error) return <ErrorBox message={error.response?.data?.messages?.[0]?.text || error.response?.data?.error || error.message} />;
  if (all.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-6">No accounts linked</p>;
  }

  return (
    <div>
      <SearchBar value={search} onChange={setSearch} placeholder="Search accounts by source, name or ID…" />
      <div className="flex items-center justify-between px-4 py-2 gap-3">
        <label className="flex items-center gap-2 text-xs text-gray-500">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={list.length === 0} className="w-4 h-4 rounded border-gray-300" />
          Select all
        </label>
        <p className="text-xs text-gray-400">{list.length} account{list.length !== 1 && "s"}{q && " matching"}</p>
      </div>
      {chosen.length > 0 && (
        <SelectionActionBar
          count={chosen.length}
          progressText={progress || (unsupported ? `${unsupported} selected account${unsupported === 1 ? " is" : "s are"} on a source that doesn't support enable / disable.` : undefined)}
          actions={[
            // Enabling restores access, so it runs straight away; the other two confirm.
            { icon: Power, title: `Enable (${targets.enable.length})`, onClick: () => bulk.mutate("enable"), loading: bulk.isPending && bulk.variables === "enable", disabled: bulk.isPending || targets.enable.length === 0 },
            { icon: PowerOff, title: `Disable (${targets.disable.length})`, onClick: () => setConfirm("disable"), loading: bulk.isPending && bulk.variables === "disable", disabled: bulk.isPending || targets.disable.length === 0 },
            { icon: Trash2, title: `Remove from ISC (${targets.remove.length})`, onClick: () => setConfirm("remove"), loading: bulk.isPending && bulk.variables === "remove", disabled: bulk.isPending, danger: true },
          ]}
        />
      )}
      {list.length === 0 && <p className="text-sm text-gray-400 text-center py-6">No accounts match "{search}"</p>}

      {list.map((acct) => (
        <div key={acct.id} className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors">
          <input type="checkbox" checked={selected.has(acct.id)} onChange={() => toggleOne(acct.id)} aria-label={`Select the ${accountSourceName(acct)} account`} className="w-4 h-4 rounded border-gray-300 flex-shrink-0" />
          <button onClick={() => onSelect(acct)} className="flex-1 min-w-0 flex items-center gap-3 text-left">
            <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
              <Server size={16} className="text-gray-500" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">
                {accountSourceName(acct) || acct.name || "Account"}
              </p>
              <p className="text-xs text-gray-500 mt-0.5 truncate">
                {[acct.name, acct.nativeIdentity || acct.accountId].filter((v, i, arr) => v && arr.indexOf(v) === i).join(" · ")}
              </p>
            </div>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 ${acct.disabled ? "bg-gray-100 text-gray-500 border-gray-200" : acct.locked ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-green-50 text-green-700 border-green-200"}`}>
              {acct.disabled ? "Disabled" : acct.locked ? "Locked" : "Active"}
            </span>
            <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
          </button>
        </div>
      ))}

      {confirm === "disable" && (
        <ConfirmModal
          title={`Disable ${targets.disable.length} account${targets.disable.length === 1 ? "" : "s"}?`}
          confirmLabel="Disable"
          pending={bulk.isPending}
          progressText={progress}
          onConfirm={() => bulk.mutate("disable")}
          onCancel={() => !bulk.isPending && setConfirm(null)}
        >
          <p className="text-sm text-gray-600 mb-2">ISC sends a disable to each source — {identityName || "this identity"} loses the use of {targets.disable.length === 1 ? "this account" : "these accounts"} until {targets.disable.length === 1 ? "it's" : "they're"} enabled again. The account and its access stay in place.</p>
          <ul className="text-xs text-gray-600 mb-4 max-h-32 overflow-y-auto list-disc pl-4 space-y-0.5">{targets.disable.map((a) => <li key={a.id}>{accountSourceName(a)} — {a.name}</li>)}</ul>
        </ConfirmModal>
      )}
      {confirm === "remove" && (
        <ConfirmModal
          title={`Remove ${targets.remove.length} account${targets.remove.length === 1 ? "" : "s"} from ISC?`}
          confirmLabel="Remove from ISC"
          danger
          pending={bulk.isPending}
          progressText={progress}
          onConfirm={() => bulk.mutate("remove")}
          onCancel={() => !bulk.isPending && setConfirm(null)}
        >
          <p className="text-sm text-gray-600 mb-2">
            <span className="font-medium text-gray-900">This does not deprovision anything.</span> The account is deleted from ISC's records only — nothing is sent to the source, the account there keeps working, and it returns here at the next aggregation if it still exists.
          </p>
          <p className="text-sm text-gray-600 mb-2">Use it for accounts that are already gone from the source, or to make ISC rebuild one. To actually take an account away, disable it, remove the access that grants it, or move the identity to a lifecycle state that deletes accounts.</p>
          <ul className="text-xs text-gray-600 mb-4 max-h-32 overflow-y-auto list-disc pl-4 space-y-0.5">{targets.remove.map((a) => <li key={a.id}>{accountSourceName(a)} — {a.name}</li>)}</ul>
        </ConfirmModal>
      )}
      {bulkResult && <ResultDialog title={bulkResult.title} success={false} message={bulkResult.message} onClose={() => setBulkResult(null)} />}
    </div>
  );
}

// ─── Roles / Access Profiles panel (rows open the detail page) ────────────────────────────────────

function AccessItemsPanel({ identityId, type, onSelect }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["identity-access", identityId, type],
    queryFn: () => getIdentityAccess(identityId, type),
  });
  const list = Array.isArray(data) ? data : [];
  const Icon = type === "ROLE" ? Shield : ShieldCheck;
  const label = type === "ROLE" ? "roles" : "access profiles";

  if (isLoading) return <SkeletonList rows={3} />;
  if (error) return <ErrorBox message={error.message} />;
  if (list.length === 0) {
    return <p className="text-sm text-gray-400 text-center py-6">No {label} assigned</p>;
  }

  return (
    <div>
      {list.map((item) => (
        <button
          key={item.id}
          onClick={() => onSelect(item)}
          className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 text-left hover:bg-gray-50 transition-colors"
        >
          <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
            <Icon size={16} className="text-gray-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">{item.name}</p>
            {type === "ACCESS_PROFILE" && item.source?.name && (
              <p className="text-xs text-gray-500 mt-0.5 truncate">{item.source.name}</p>
            )}
          </div>
          <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
        </button>
      ))}
    </div>
  );
}

// ─── Details panel ───────────────────────────────────────────────────────────────

function DetailsPanel({ identity, extraAttrs }) {
  const p = identity;
  return (
    <div className="px-4 py-2">
      <InfoRow label="Email" value={p.emailAddress} />
      <InfoRow label="Alias" value={p.alias} />
      <InfoRow label="Manager" value={p.managerRef?.name} />
      <InfoRow label="Lifecycle state" value={p.lifecycleState?.name || p.lifecycleState?.stateName} />
      <InfoRow label="Last refresh" value={fmtDate(p.lastRefresh)} />
      <InfoRow label="Identity ID" value={p.id} />
      {extraAttrs.map(([key, value]) => (
        <InfoRow
          key={key}
          label={labelizeKey(key)}
          value={typeof value === "object" ? JSON.stringify(value) : String(value)}
        />
      ))}
    </div>
  );
}

// ─── Entitlements panel ──────────────────────────────────────────────────────────

function EntitlementsPanel({ identityId, onSelect }) {
  const [search, setSearch] = useState("");

  const { data: basicList, isLoading: basicLoading, error: basicError } = useQuery({
    queryKey: ["identity-entitlements", identityId],
    queryFn: () => getIdentityEntitlements(identityId),
  });
  const ids = useMemo(
    () => (Array.isArray(basicList) ? basicList.map((e) => e.id) : []),
    [basicList]
  );

  const { data: fullList, isLoading: fullLoading, error: fullError } = useQuery({
    queryKey: ["entitlements-detail", ids],
    queryFn: () => getEntitlementsByIds(ids),
    enabled: ids.length > 0,
  });

  const isLoading = basicLoading || (ids.length > 0 && fullLoading);
  const error = basicError || fullError;
  // Fall back to the bare id/name list if the bulk detail fetch fails (e.g.
  // permissions) so the user still sees something rather than nothing.
  const entList = Array.isArray(fullList) ? fullList : (Array.isArray(basicList) ? basicList : []);

  const [expanded, setExpanded] = useState(new Set());

  const filtered = search
    ? entList.filter((e) => (e.name || "").toLowerCase().includes(search.toLowerCase()))
    : entList;

  const groups = useMemo(() => {
    const map = new Map();
    filtered.forEach((ent) => {
      const sourceName = ent.source?.name || "Other";
      if (!map.has(sourceName)) map.set(sourceName, []);
      map.get(sourceName).push(ent);
    });
    return Array.from(map.entries())
      .map(([sourceName, items]) => [sourceName, sortByName(items)])
      .sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  if (isLoading) return <SkeletonList rows={3} />;
  if (error) return <ErrorBox message={error.message} />;

  function toggleSource(sourceName) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sourceName)) next.delete(sourceName);
      else next.add(sourceName);
      return next;
    });
  }

  const allExpanded = groups.length > 0 && groups.every(([sourceName]) => expanded.has(sourceName));
  function toggleAllExpanded() {
    setExpanded(allExpanded ? new Set() : new Set(groups.map(([sourceName]) => sourceName)));
  }

  return (
    <div>
      {entList.length > 0 && (
        <SearchBar value={search} onChange={setSearch} placeholder="Search entitlements…" />
      )}
      {groups.length > 0 && (
        <div className="flex items-center justify-between gap-3 px-4">
          <p className="text-xs text-gray-400">
            {search && filtered.length !== entList.length ? `${filtered.length} of ${entList.length}` : filtered.length}
            {" "}entitlement{entList.length === 1 ? "" : "s"} across {groups.length} source{groups.length === 1 ? "" : "s"}
          </p>
          <IconButton
            icon={allExpanded ? Minimize2 : Maximize2}
            title={allExpanded ? "Collapse all sources" : "Expand all sources"}
            onClick={toggleAllExpanded}
            disabled={!!search}
          />
        </div>
      )}
      {filtered.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-6">
          {entList.length === 0 ? "No entitlements assigned" : "No entitlements match your search"}
        </p>
      )}
      {groups.map(([sourceName, items]) => {
        // While searching, any source with a match auto-expands; otherwise
        // only sources the user has clicked open are expanded.
        const isOpen = search ? true : expanded.has(sourceName);
        return (
          <div key={sourceName}>
            <button
              onClick={() => toggleSource(sourceName)}
              className="w-full flex items-center justify-between px-4 pt-3 pb-1 text-left"
            >
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                {sourceName} ({items.length})
              </span>
              <ChevronRight size={14} className={`text-gray-300 transition-transform ${isOpen ? "rotate-90" : ""}`} />
            </button>
            {isOpen && items.map((ent) => (
              <button
                key={ent.id}
                onClick={() => onSelect(ent.id)}
                className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 text-left hover:bg-gray-50 transition-colors"
              >
                <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                  <Key size={16} className="text-gray-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{ent.name || "Unnamed entitlement"}</p>
                </div>
                <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export default function IdentityDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [section, setSection] = useState("details");

  const { data: identity, isLoading: idLoading, error: idError } = useQuery({
    queryKey: ["identity", id],
    queryFn: () => getIdentity(id),
  });

  // Same gate Nav.jsx uses for the Data Segments feature itself — no point
  // showing a Segments tab (or spending the fetchAllDataSegments call
  // behind it) on a tenant that doesn't use segments at all.
  const { data: schemaAnalysis } = useQuery({
    queryKey: ["schema-analysis"],
    queryFn: getSchemaAnalysis,
    staleTime: 5 * 60 * 1000,
  });

  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const lifecycleMutation = useMutation({
    mutationFn: (state) => setIdentityLifecycleState(id, state),
    onSuccess: (_data, state) => {
      toast.success(
        state === "enable"
          ? "Enable request submitted — this can take a few minutes to reflect."
          : "Disable request submitted — this can take a few minutes to reflect."
      );
      queryClient.invalidateQueries({ queryKey: ["identity", id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const inviteMutation = useMutation({
    mutationFn: () => inviteIdentity(id),
    onSuccess: () => {
      toast.success("Invitation sent — ISC e-mails the identity a link to register.");
      queryClient.invalidateQueries({ queryKey: ["identity", id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });

  if (idLoading) {
    return (
      <div className="flex flex-col min-h-screen bg-white">
        <TopBar title="Identity" onBack={() => navigate(-1)} />
        <SkeletonList rows={6} />
      </div>
    );
  }

  if (idError) {
    return (
      <div className="flex flex-col min-h-screen bg-white">
        <TopBar title="Identity" onBack={() => navigate(-1)} />
        <ErrorBox message={idError.message} />
      </div>
    );
  }

  const p = identity || {};
  const attrs = p.attributes || {};
  const name = p.name || attrs.displayName || "Unknown";
  // identityStatus is rarely populated on this tenant; the real signal for
  // whether the identity is active is its cloud lifecycle state attribute.
  const active = attrs.cloudLifecycleState
    ? attrs.cloudLifecycleState.toLowerCase() === "active"
    : !["DISABLED", "DEACTIVATED", "TERMINATED"].includes(p.identityStatus);

  const extraAttrs = Object.entries(attrs).filter(
    ([key, value]) => value != null && value !== "" && !CORE_ATTR_KEYS.has(key.toLowerCase())
  );

  const SECTIONS = [
    { key: "details", label: "Details", Icon: Info },
    { key: "roles", label: "Roles", Icon: Shield },
    { key: "access-profiles", label: "Access Profiles", Icon: ShieldCheck },
    { key: "user-levels", label: "User Levels", Icon: BadgeCheck },
    { key: "governance-groups", label: "Governance Groups", Icon: UsersRound },
    { key: "accounts", label: "Accounts", Icon: Server },
    { key: "entitlements", label: "Entitlements", Icon: Key },
    ...(schemaAnalysis?.createDataSegments ? [{ key: "segments", label: "Data Segments", Icon: Shapes }] : []),
    { key: "isc-segments", label: "Segments", Icon: Split },
    { key: "activity", label: "Activity", Icon: Activity },
  ];

  const identityIscTenant = getCredentials()?.tenant;
  const identityIscUrl =
    identityIscTenant && p.id ? `https://${tenantUiHost(identityIscTenant)}/ui/a/admin/identities/${p.id}/details/attributes` : null;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Identity"
        onBack={() => navigate(-1)}
        action={
          <IconButton
            icon={Link}
            title="View in Identity Security Cloud"
            onClick={() => identityIscUrl && window.open(identityIscUrl, "_blank", "noopener,noreferrer")}
            disabled={!identityIscUrl}
          />
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        {/* Header */}
        <div className="px-4 py-5 border-b border-gray-100">
          <div className="flex items-start gap-4">
            <Avatar name={name} size="lg" />
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-semibold text-gray-900">{name}</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                {attrs.title || attrs.jobTitle || attrs.department || ""}
              </p>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <button
                  type="button"
                  title={active ? "Disable" : "Enable"}
                  onClick={() => lifecycleMutation.mutate(active ? "disable" : "enable")}
                  disabled={lifecycleMutation.isPending}
                  className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full border transition-colors disabled:opacity-50 ${
                    active
                      ? "bg-green-50 text-green-700 border-green-200 hover:bg-red-50 hover:text-red-700 hover:border-red-200"
                      : "bg-red-50 text-red-700 border-red-200 hover:bg-green-50 hover:text-green-700 hover:border-green-200"
                  }`}
                >
                  {p.identityStatus || (active ? "Active" : "Inactive")}
                </button>
                {/* The pill flips Active ⇄ Inactive; this reaches every state the
                    identity's profile defines (prehire, terminated, …). */}
                <button
                  type="button"
                  onClick={() => setLifecycleOpen(true)}
                  className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  {attrs.cloudLifecycleState ? `Lifecycle: ${attrs.cloudLifecycleState}` : "Lifecycle state"} · Change
                </button>
                {/* Unregistered (never invited) or pending (invited, not yet
                    registered) identities can be sent ISC's invitation. */}
                {["UNREGISTERED", "PENDING"].includes(p.identityStatus || attrs.cloudStatus) && (
                  <button
                    type="button"
                    onClick={() => inviteMutation.mutate()}
                    disabled={inviteMutation.isPending}
                    title={`Send ISC's registration invitation to ${attrs.email || p.emailAddress || name}`}
                    className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors disabled:opacity-50"
                  >
                    {inviteMutation.isPending ? <Spinner size={12} /> : <Mail size={12} />}
                    {(p.identityStatus || attrs.cloudStatus) === "PENDING" ? "Resend invite" : "Invite"}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Side menu + panel */}
        <div className="flex border-t border-gray-100">
          <div className="w-28 flex-shrink-0 border-r border-gray-100 py-2">
            {SECTIONS.map(({ key, label, Icon }) => (
              <button
                key={key}
                onClick={() => setSection(key)}
                className={`w-full flex flex-col items-center gap-1 px-2 py-3 text-xs font-medium transition-colors ${
                  section === key ? "text-blue-600 bg-blue-50" : "text-gray-400 hover:text-gray-600"
                }`}
              >
                <Icon size={18} />
                {label}
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-0">
            {section === "details" && <DetailsPanel identity={p} extraAttrs={extraAttrs} />}
            {section === "roles" && (
              <AccessItemsPanel identityId={id} type="ROLE" onSelect={(item) => navigate(`/roles/${item.id}`)} />
            )}
            {section === "access-profiles" && (
              <AccessItemsPanel identityId={id} type="ACCESS_PROFILE" onSelect={(item) => navigate(`/access-profiles/${item.id}`)} />
            )}
            {section === "accounts" && (
              <AccountsPanel identityId={id} identityName={name} onSelect={setSelectedAccount} />
            )}
            {section === "entitlements" && (
              <EntitlementsPanel identityId={id} onSelect={(entId) => navigate(`/entitlements/${entId}`)} />
            )}
            {section === "activity" && <IdentityActivityPanel identityId={id} identity={p} />}
            {section === "user-levels" && <UserLevelsPanel identityId={id} />}
            {section === "governance-groups" && <GovernanceGroupsPanel identityId={id} identityName={name} />}
            {section === "isc-segments" && (
              <SegmentsTabPanel
                queryKey={["identity-isc-segments", id]}
                queryFn={() => getIdentityIscSegments(id)}
                navigate={navigate}
                basePath="/access-segments"
                noun="segment"
                Icon={Split}
                emptySubtitle="This identity doesn't match any segment's member definition"
              />
            )}
            {section === "segments" && (
              <SegmentsTabPanel
                queryKey={["identity-segments", id]}
                queryFn={() => getIdentitySegments(id)}
                navigate={navigate}
                emptySubtitle="This identity's attributes don't match any data segment's membership criteria"
              />
            )}
          </div>
        </div>
      </div>

      {lifecycleOpen && <SetLifecycleStateModal identityId={id} identityName={name} onClose={() => setLifecycleOpen(false)} />}
      {selectedAccount && (
        <AccountDetailSheet account={selectedAccount} onClose={() => setSelectedAccount(null)} />
      )}
    </div>
  );
}
