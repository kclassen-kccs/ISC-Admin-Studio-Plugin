import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { X, Search, UserPlus, Lock } from "lucide-react";
import toast from "react-hot-toast";
import {
  getLdapInfo, searchLdapUsers, getSourceAccountSchema, exportSourceAccounts, loadAccountsFile,
} from "../lib/sailpoint";
import { toCsv } from "../lib/csv";
import { Field, Input, PrimaryButton, OutlineButton, ErrorBox } from "./ui";
import { SailPointIcon } from "./SailPointIcon";

// Add people from the corporate directory to the ISC Admins source (a
// Delimited File source): search LDAP with the user's OWN directory
// credentials — as many searches as needed — tick people into a running
// list (each row reviewable/editable), then append them all to the source's
// accounts and re-upload the full file once (SailPoint deduplicates it) —
// the same export → edit → load-accounts path the Edit Accounts screen uses. The directory password
// stays in this dialog's state for the searches only; it's sent to the
// Admin Studio server per search and never stored.

// Directory attribute -> ISC Admins column, matching how the existing rows
// are filled in (id = name = the login, e.g. first.last).
function rowFromLdap(u) {
  return {
    id: u.sAMAccountName,
    name: u.sAMAccountName,
    givenName: u.givenName,
    familyName: u.sn,
    "e-mail": u.mail,
    location: u.l,
    phone: u.telephoneNumber,
  };
}

const ALWAYS_EXCLUDED_ATTRS = new Set(["idNowDescription"]);

export function AddFromLdapModal({ sourceId, sourceName, onClose }) {
  const info = useQuery({ queryKey: ["ldap-info"], queryFn: getLdapInfo, staleTime: 10 * 60 * 1000, retry: false });
  const schema = useQuery({ queryKey: ["source-account-schema", sourceId], queryFn: () => getSourceAccountSchema(sourceId) });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [query, setQuery] = useState("");
  // Everyone picked so far, across any number of searches, in pick order:
  // dn -> { user, row }. Each row is editable before adding.
  const [selected, setSelected] = useState(() => new Map());
  const [editingDn, setEditingDn] = useState(null);

  const columns = (schema.data?.attributes || []).filter((a) => !ALWAYS_EXCLUDED_ATTRS.has(a.name));
  const idColumn = schema.data?.identityAttribute || "id";

  const search = useMutation({ mutationFn: () => searchLdapUsers({ username, password, query }) });

  const toggle = (u) => setSelected((prev) => {
    const next = new Map(prev);
    if (next.has(u.dn)) {
      next.delete(u.dn);
      if (editingDn === u.dn) setEditingDn(null);
    } else {
      const mapped = rowFromLdap(u);
      next.set(u.dn, { user: u, row: Object.fromEntries(columns.map((c) => [c.name, mapped[c.name] ?? ""])) });
    }
    return next;
  });
  const setField = (dn, name, value) => setSelected((prev) => {
    const next = new Map(prev);
    const entry = next.get(dn);
    if (entry) next.set(dn, { ...entry, row: { ...entry.row, [name]: value } });
    return next;
  });

  const picks = [...selected.values()];
  const idOf = (row) => String(row[idColumn] || "").trim().toLowerCase();
  const missingId = picks.filter((p) => !idOf(p.row));

  // One export, every selected row appended, one upload — the full list is
  // always aggregated; SailPoint deduplicates the file on its side (rows
  // sharing an id with an existing account or each other are left to it).
  const add = useMutation({
    mutationFn: async () => {
      const existing = await exportSourceAccounts(sourceId);
      const rows = picks.map((p) => p.row);
      const headers = columns.map((c) => c.name);
      const csv = toCsv(headers, [...(existing || []).map((a) => a.attributes || {}), ...rows]);
      await loadAccountsFile(sourceId, { filename: `${sourceName || "accounts"}-sailpoint-add.csv`, csvBase64: btoa(unescape(encodeURIComponent(csv))) });
      return rows.map((r) => r.name || r[idColumn]);
    },
    onSuccess: (added) => {
      toast.success(`Added ${added.length} user${added.length === 1 ? "" : "s"} to ${sourceName}: ${added.join(", ")}. ISC is aggregating the updated file — the accounts appear after a short delay.`, { duration: 9000 });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });

  const users = search.data?.users || [];
  const busy = search.isPending || add.isPending;
  const runSearch = () => username && password && query.trim().length >= 2 && search.mutate();

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
              <SailPointIcon size={20} />
            </div>
            <div>
              <h2 className="text-base font-semibold text-gray-900">Add from SailPoint</h2>
              <p className="text-xs text-gray-500">to {sourceName}</p>
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        {info.data?.error && <ErrorBox message={`Can't reach ${info.data.host}: ${info.data.error}`} />}

        <p className="text-xs text-gray-500 mb-3 flex items-start gap-1.5">
          <Lock size={12} className="flex-shrink-0 mt-0.5" />
          Search uses the SailPoint Active Directory with your own SailPoint account. Your password is used for the search only and isn't saved.
        </p>
        <Field label="Your SailPoint Username">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={info.data?.domain ? `first.last (or first.last@${info.data.domain})` : "first.last"} autoComplete="username" />
        </Field>
        <Field label="Your SailPoint Password">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>

        {/* The running selection — survives new searches. */}
        {picks.length > 0 && (
          <div className="mb-4">
            <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Selected ({picks.length})</p>
            <div className="border border-blue-100 bg-blue-50/40 rounded-xl overflow-hidden divide-y divide-blue-100">
              {picks.map(({ user: u, row }) => (
                <div key={u.dn}>
                  <div className="flex items-center gap-2 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{u.displayName || u.sAMAccountName}</p>
                      <p className="text-xs text-gray-500 truncate">
                        {idColumn}: {row[idColumn] || <span className="text-red-600">missing</span>}{row["e-mail"] ? ` · ${row["e-mail"]}` : ""}
                      </p>
                    </div>
                    <button type="button" onClick={() => setEditingDn(editingDn === u.dn ? null : u.dn)} className="text-xs font-medium text-blue-600 hover:text-blue-700 flex-shrink-0" disabled={busy}>
                      {editingDn === u.dn ? "Done" : "Edit"}
                    </button>
                    <button type="button" onClick={() => toggle(u)} title="Remove from the list" className="text-gray-400 hover:text-red-600 flex-shrink-0" disabled={busy}>
                      <X size={16} />
                    </button>
                  </div>
                  {editingDn === u.dn && (
                    <div className="px-3 pb-2 bg-white">
                      {columns.map((c) => (
                        <Field key={c.name} label={`${c.name}${c.name === idColumn ? " (account ID)" : ""}`}>
                          <Input value={row[c.name] ?? ""} onChange={(e) => setField(u.dn, c.name, e.target.value)} />
                        </Field>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {/* Add sits right under the list it acts on. */}
            <p className="text-xs text-gray-500 mt-2 mb-2">
              Adds {picks.length === 1 ? "this user" : `these ${picks.length} users`} to {sourceName}'s accounts file in one upload and aggregates the full list — SailPoint deduplicates the file.
            </p>
            <PrimaryButton onClick={() => add.mutate()} loading={add.isPending} disabled={missingId.length > 0 || columns.length === 0}>
              <UserPlus size={16} />
              {`Add ${picks.length} user${picks.length === 1 ? "" : "s"} to ${sourceName}`}
            </PrimaryButton>
            {missingId.length > 0 && <p className="text-xs text-red-600 mt-1">Every selected user needs an {idColumn} — edit the ones marked missing.</p>}
          </div>
        )}

        <Field label={picks.length ? "Find more users" : "Find users"}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runSearch()} placeholder="Name, login or e-mail" />
        </Field>
        <OutlineButton onClick={runSearch} loading={search.isPending} disabled={!username || !password || query.trim().length < 2}>
          <Search size={16} />
          Search
        </OutlineButton>

        {search.error && <div className="mt-3"><ErrorBox message={search.error.response?.data?.error || search.error.message} /></div>}
        {search.isSuccess && (
          <div className="mt-3">
            <p className="text-xs text-gray-400 mb-1.5">
              {users.length} match{users.length === 1 ? "" : "es"}{search.data.truncated ? " (first 25 — refine the search to narrow it)" : ""} — tick to add to the list
            </p>
            <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
              {users.map((u) => (
                <label key={u.dn} className="w-full px-3 py-2.5 hover:bg-gray-50 flex items-center gap-3 cursor-pointer">
                  <input type="checkbox" checked={selected.has(u.dn)} onChange={() => toggle(u)} disabled={busy || schema.isLoading} className="w-4 h-4 rounded border-gray-300 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {u.displayName || `${u.givenName} ${u.sn}`.trim() || u.sAMAccountName}
                      {u.disabled && <span className="ml-2 text-[10px] font-semibold text-red-600 uppercase">disabled</span>}
                    </p>
                    <p className="text-xs text-gray-500 truncate">{[u.sAMAccountName, u.mail, u.title, u.l].filter(Boolean).join(" · ")}</p>
                  </div>
                </label>
              ))}
              {users.length === 0 && <p className="px-3 py-3 text-sm text-gray-400">No one matches "{query}".</p>}
            </div>
          </div>
        )}

        <div className="mt-4">
          <OutlineButton onClick={onClose} disabled={busy}>Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}
