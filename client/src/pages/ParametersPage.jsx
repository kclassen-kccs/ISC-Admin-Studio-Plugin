import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  KeyRound, ChevronRight, Plus, Printer, Trash2, Eye, EyeOff, X, Info, ListTree, Link2, Braces, Lock, Copy,
  Pencil, FlaskConical, CheckCircle2, XCircle, AlertTriangle,
} from "lucide-react";
import toast from "react-hot-toast";
import {
  listParameters, getParameter, deleteParameter, getParameterReferences, getParameterSpecifications,
  createParameter, updateParameter, testParameterOAuth, testParameterHttp, getIdentitiesByIds, listIdentities, getCredentials,
} from "../lib/sailpoint";
import { printParametersListPdf, printParametersDetailPdf } from "../lib/exportParametersPdf";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { usePagedList } from "../hooks/usePagedList";
import { useAuth } from "../hooks/useAuth";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import { PickerField } from "../components/PickerField";
import {
  SearchBar, FilterBar, SkeletonList, EmptyState, ErrorBox, IconButton, ConfirmModal, SelectionActionBar,
  Spinner, SectionLabel, Field, Input, Textarea, PrimaryButton, OutlineButton,
} from "../components/ui";
import { escapeHtml, highlightJson, JSON_EDITOR_STYLE } from "../components/JsonEditor";

// ─── Parameters (ISC Parameter Storage) ──────────────────────────────────────
// Typed, named configuration — credentials, connections, OAuth scopes —
// that workflows and other services reference. Every type's fields come
// from the tenant's specification document (GET /parameter-storage/
// specifications), so the create form follows ISC's own definitions rather
// than a hardcoded list. Private fields (passwords, client secrets, header
// values) are masked on entry and never displayed: ISC doesn't return them,
// and they're encrypted server-side before they're sent.

const MASK = "••••••••";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const fmtDate = (d) => (d ? new Date(d).toLocaleString() : "—");
const fmtValue = (v) => (Array.isArray(v) ? v.join(", ") : v == null || v === "" ? "—" : String(v));

// typeId -> { id, label, category, primaryField, fields, needsLicense, needsFeatureFlag, managedByConsumer }
function useParameterSpecs() {
  const q = useQuery({ queryKey: ["parameter-specs"], queryFn: getParameterSpecifications, staleTime: 10 * 60 * 1000 });
  const byType = useMemo(() => {
    const map = new Map();
    for (const cat of Array.isArray(q.data) ? q.data : []) {
      for (const p of cat.parameters || []) map.set(p.id, { ...p, category: cat.label, categoryId: cat.id });
    }
    return map;
  }, [q.data]);
  return { categories: Array.isArray(q.data) ? q.data : [], byType, isLoading: q.isLoading, error: q.error };
}

function useOwnerNames(ids) {
  const unique = [...new Set(ids.filter(Boolean))].sort();
  const q = useQuery({
    queryKey: ["parameter-owner-names", unique.join(",")],
    queryFn: async () => {
      const out = {};
      for (let i = 0; i < unique.length; i += 50) {
        for (const idn of (await getIdentitiesByIds(unique.slice(i, i + 50))) || []) out[idn.id] = idn.name;
      }
      return out;
    },
    enabled: unique.length > 0,
    staleTime: 5 * 60 * 1000,
  });
  return q.data || {};
}

// The parameter's fields in specification order, public values filled in,
// private ones flagged (their values are never available).
function describeFields(param, spec) {
  if (!spec) {
    return Object.entries(param.publicFields || {}).map(([name, value]) => ({ name, label: name, value, private: false }));
  }
  return (spec.fields || []).map((f) => ({
    name: f.name,
    label: f.label || f.name,
    value: f.private ? null : param.publicFields?.[f.name],
    private: !!f.private,
  }));
}

const typeLabel = (param, byType) => byType.get(param.type)?.label || (param.type ? `Type ${param.type}` : "—");

// ─── Create ──────────────────────────────────────────────────────────────────

function SecretInput({ value, onChange, placeholder }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
        style={{ paddingRight: "2.5rem" }}
      />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
        title={shown ? "Hide" : "Show"}
      >
        {shown ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

function FieldInput({ field, value, onChange }) {
  if (field.private) return <SecretInput value={value ?? ""} onChange={onChange} placeholder={field.newLabel || field.label} />;
  if (field.type === "enum") {
    return (
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-blue-400"
      >
        <option value="">Choose…</option>
        {(field.options || []).map((o) => <option key={o.value} value={o.value}>{o.label || o.value}</option>)}
      </select>
    );
  }
  if (field.type === "string[]") {
    return <Textarea rows={3} value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder="One per line" />;
  }
  if (field.type === "int") {
    return <Input type="number" value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={field.default != null ? String(field.default) : ""} />;
  }
  return <Input value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
}

// Form state (strings) -> { publicFields, privateFields } shaped by type.
function buildFieldPayload(spec, values) {
  const publicFields = {};
  const privateFields = {};
  for (const f of spec.fields || []) {
    const raw = values[f.name];
    if (f.private) {
      if (raw) privateFields[f.name] = raw;
      continue;
    }
    if (f.type === "string[]") {
      const list = String(raw || "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      if (list.length) publicFields[f.name] = list;
    } else if (f.type === "int") {
      const n = raw === "" || raw == null ? f.default : Number(raw);
      if (n != null && !Number.isNaN(n)) publicFields[f.name] = n;
    } else if (raw != null && raw !== "") {
      publicFields[f.name] = raw;
    }
  }
  return { publicFields, privateFields };
}

const searchIdentities = async (q) => (await listIdentities({ limit: 15, query: q || undefined })).map((i) => ({ id: i.id, name: i.name }));

// Which web test a parameter type supports, from its fields (so it follows
// the tenant's specification rather than hardcoded type ids). null = not
// testable over HTTP (Active Directory, Server, Kerberos, OAuth scopes) or
// consumer-managed (the provisioner's account passwords).
function testKind(spec) {
  if (!spec || spec.managedByConsumer) return null;
  const names = new Set((spec.fields || []).map((f) => f.name));
  if (names.has("clientId") && names.has("clientSecret")) return names.has("tokenURL") ? "oauth2" : "entra";
  if (names.has("username") && names.has("password")) return "basic";
  if (names.has("headerName") && names.has("headerValue")) return "header";
  if (names.has("tenantId") && names.size === 1) return "entra-tenant";
  if (names.has("url")) return "web";
  return null;
}

const TEST_INTRO = {
  oauth2: "Requests a token with the client-credentials grant using the values above. The token itself is discarded.",
  entra: "Requests a token from Microsoft Entra ID with the client-credentials grant. The token itself is discarded.",
  basic: "Requests a URL with these credentials as HTTP Basic authentication and reports whether they were accepted.",
  header: "Requests a URL with this header and reports whether it was accepted.",
  "entra-tenant": "Looks up the tenant's public OpenID configuration at Microsoft to confirm it exists.",
  web: "Requests the URL and reports whether it's reachable.",
};

function TestResult({ result, kind }) {
  if (!result) return null;
  if (result.ok) {
    const detail = [
      result.status && `${result.status}`,
      result.ms != null && `${result.ms} ms`,
      result.tokenType,
      result.expiresIn != null && `expires in ${result.expiresIn}s`,
      result.scope && `scope: ${result.scope}`,
      result.tenantGuid && `tenant ${result.tenantGuid}`,
      result.location && `redirects to ${result.location}`,
    ].filter(Boolean).join(" · ");
    const what = kind === "oauth2" || kind === "entra" ? "Token issued" : kind === "entra-tenant" ? "Tenant found" : kind === "web" ? "Reachable" : "Accepted";
    return (
      <p className="mt-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 flex items-start gap-1.5">
        <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" />
        <span>{what}{result.host ? ` by ${result.host}` : ""}{detail ? ` (${detail})` : ""}</span>
      </p>
    );
  }
  return (
    <p className="mt-2 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-start gap-1.5">
      <XCircle size={14} className="flex-shrink-0 mt-0.5" />
      <span>
        Failed{result.host ? ` at ${result.host}` : ""}{result.status ? ` (${result.status})` : ""}: {result.error}
        {result.errorDescription ? ` — ${result.errorDescription}` : ""}
        {result.wwwAuthenticate ? ` — server asks for: ${result.wwwAuthenticate}` : ""}
      </span>
    </p>
  );
}

function ParameterTestPanel({ kind, values, editing }) {
  const [scope, setScope] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [testUrl, setTestUrl] = useState("");
  const [result, setResult] = useState(null);
  const test = useMutation({
    mutationFn: () => {
      if (kind === "oauth2" || kind === "entra") {
        return testParameterOAuth({
          kind, tokenURL: values.tokenURL, tenantId, clientId: values.clientId, clientSecret: values.clientSecret,
          credentialLocation: values.credentialLocation || "HEADER", scope,
        });
      }
      return testParameterHttp({
        kind,
        url: kind === "web" ? values.url : testUrl,
        username: values.username, password: values.password,
        headerName: values.headerName, headerValue: values.headerValue,
        tenantId: values.tenantId,
      });
    },
    onSuccess: setResult,
    onError: (err) => setResult({ ok: false, error: err.response?.data?.error || err.message }),
  });

  const secretField = { oauth2: "clientSecret", entra: "clientSecret", basic: "password", header: "headerValue" }[kind];
  const missing = [
    kind === "oauth2" && !values.tokenURL && "token URL",
    kind === "entra" && !tenantId.trim() && "tenant ID",
    (kind === "oauth2" || kind === "entra") && !values.clientId && "client ID",
    kind === "basic" && !values.username && "username",
    kind === "header" && !values.headerName && "header name",
    (kind === "basic" || kind === "header") && !testUrl.trim() && "URL to test",
    kind === "entra-tenant" && !values.tenantId && "tenant ID",
    kind === "web" && !values.url && "URL",
    secretField && !values[secretField] && (kind === "basic" ? "password" : kind === "header" ? "header value" : "client secret"),
  ].filter(Boolean);

  return (
    <div className="border border-gray-200 rounded-xl p-3 mb-4 bg-gray-50">
      <p className="text-sm font-medium text-gray-900 mb-1 flex items-center gap-1.5"><FlaskConical size={14} /> Test</p>
      <p className="text-xs text-gray-500 mb-2">{TEST_INTRO[kind]} Runs from the Admin Studio server; nothing is saved.</p>
      {kind === "entra" && (
        <Field label="Entra tenant ID or domain"><Input value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="contoso.onmicrosoft.com" /></Field>
      )}
      {(kind === "oauth2" || kind === "entra") && (
        <Field label={`Scope (optional${kind === "entra" ? ", defaults to Microsoft Graph" : ""})`}>
          <Input value={scope} onChange={(e) => setScope(e.target.value)} placeholder={kind === "entra" ? "https://graph.microsoft.com/.default" : "e.g. read write"} />
        </Field>
      )}
      {(kind === "basic" || kind === "header") && (
        <Field label="URL to test against (https)">
          <Input value={testUrl} onChange={(e) => setTestUrl(e.target.value)} placeholder="https://api.example.com/whoami" />
        </Field>
      )}
      {editing && secretField && !values[secretField] && (
        <p className="text-xs text-amber-700 mb-2">Enter the {kind === "basic" ? "password" : kind === "header" ? "header value" : "client secret"} to test — the stored one can't be read back from ISC.</p>
      )}
      <OutlineButton onClick={() => test.mutate()} loading={test.isPending} disabled={missing.length > 0}>
        <FlaskConical size={16} />
        {missing.length ? `Test (needs ${missing.join(", ")})` : "Test"}
      </OutlineButton>
      <TestResult result={result} kind={kind} />
    </div>
  );
}

// Stored public values -> form strings (string[] one per line).
function valuesFromParameter(param, spec) {
  const out = {};
  for (const f of spec?.fields || []) {
    if (f.private) continue;
    const v = param.publicFields?.[f.name];
    if (v == null) continue;
    out[f.name] = Array.isArray(v) ? v.join("\n") : String(v);
  }
  return out;
}

// Shown after a save that went through WITHOUT its secret: ISC rejected the
// encrypted value in every format, so the server saved everything else.
function SecretNotSavedDialog({ name, info, spec, editing, onClose }) {
  const labels = (info.fields || []).map((f) => spec?.fields?.find((x) => x.name === f)?.label || f);
  return (
    <div className="fixed inset-0 bg-black/40 z-40 flex items-end md:items-center justify-center">
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={18} className="text-amber-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-900">{editing ? "Saved" : "Created"} without the {labels.join(" and ")}</h2>
        </div>
        <p className="text-sm text-gray-700 mb-2">
          "{name}" was {editing ? "updated" : "created"}, but the <strong>{labels.join(" and ")}</strong> {labels.length === 1 ? "was" : "were"} <strong>not saved</strong>.
        </p>
        <p className="text-sm text-gray-600 mb-2">
          ISC rejected the encrypted secret ({info.reason}). Everything else — name, description, owner and the other
          fields — was saved.
        </p>
        <p className="text-sm text-gray-600 mb-3">
          {editing
            ? "Any secret already stored on this parameter is unchanged."
            : "The parameter has no secret stored, so anything using it won't be able to authenticate until one is added."}
          {" "}Until SailPoint confirms the required format, set the secret in ISC directly.
        </p>
        {info.trackingId && <p className="text-xs text-gray-400 mb-4">ISC tracking ID: <span className="font-mono">{info.trackingId}</span></p>}
        <PrimaryButton onClick={onClose}>OK</PrimaryButton>
      </div>
    </div>
  );
}

/**
 * Create (no `parameter`) or edit (`parameter` given) — one form. Editing
 * keeps the type fixed (ISC won't change it), pre-fills the public fields,
 * and leaves secret fields blank: blank means "keep the stored value", since
 * ISC never returns it.
 */
function ParameterFormModal({ categories, byType, parameter, ownerName, onClose, onSaved }) {
  const { session } = useAuth();
  const editing = !!parameter;
  const [typeId, setTypeId] = useState(parameter?.type || "");
  const [name, setName] = useState(parameter?.name || "");
  const [description, setDescription] = useState(parameter?.description || "");
  const [owner, setOwner] = useState(() =>
    editing
      ? (parameter.ownerId ? [{ id: parameter.ownerId, name: ownerName || parameter.ownerId }] : [])
      : (session?.identity?.id ? [{ id: session.identity.id, name: session.identity.username }] : [])
  );
  const spec = typeId ? byType.get(typeId) : null;
  const [values, setValues] = useState(() => (editing ? valuesFromParameter(parameter, byType.get(parameter.type)) : {}));
  const kind = testKind(spec);
  const [secretNotice, setSecretNotice] = useState(null); // { saved, info } — shown before closing

  // Types a consumer manages itself (e.g. the provisioner's account
  // passwords) aren't created by hand.
  const creatable = categories
    .map((c) => ({ ...c, parameters: (c.parameters || []).filter((p) => !p.managedByConsumer) }))
    .filter((c) => c.parameters.length);

  const save = useMutation({
    mutationFn: () => {
      const { publicFields, privateFields } = buildFieldPayload(spec, values);
      return editing
        ? updateParameter(parameter.id, { name, description, ownerId: owner[0]?.id, publicFields, privateFields })
        : createParameter({ type: typeId, name, description, ownerId: owner[0]?.id, publicFields, privateFields });
    },
    onSuccess: (saved) => {
      if (saved?._secretNotSaved) {
        setSecretNotice({ saved, info: saved._secretNotSaved });
        return;
      }
      toast.success(`Parameter "${saved?.name || name}" ${editing ? "updated" : "created"}`);
      onSaved(saved);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 10000 }),
  });

  const missingPrimary = spec?.primaryField && !String(values[spec.primaryField] ?? "").trim();

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && !save.isPending && onClose()}>
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center flex-shrink-0">
              <KeyRound size={18} className="text-indigo-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">{editing ? "Edit Parameter" : "New Parameter"}</h2>
          </div>
          <button onClick={onClose} disabled={save.isPending} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        {editing ? (
          <Field label="Type">
            <p className="text-sm text-gray-900 py-2">{spec ? `${spec.category} · ${spec.label}` : parameter.type} <span className="text-xs text-gray-400">(can't be changed)</span></p>
          </Field>
        ) : (
          <Field label="Type">
            <select
              value={typeId}
              onChange={(e) => { setTypeId(e.target.value); setValues({}); }}
              className="w-full bg-white border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-blue-400"
            >
              <option value="">Choose a parameter type…</option>
              {creatable.map((c) => (
                <optgroup key={c.id} label={c.label}>
                  {c.parameters.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}{p.needsLicense ? " (licensed)" : ""}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
        )}

        {spec && (
          <>
            {!editing && (spec.needsLicense || spec.needsFeatureFlag) && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
                This type needs {[spec.needsLicense && `the ${spec.needsLicense} license`, spec.needsFeatureFlag && "a feature flag"].filter(Boolean).join(" and ")} on the tenant.
              </p>
            )}
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ServiceNow API credentials" /></Field>
            <Field label="Description"><Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            <PickerField label="Owner" placeholder="Search users…" searchFn={searchIdentities} selected={owner} onChange={setOwner} />

            <SectionLabel>{spec.label} fields</SectionLabel>
            {(spec.fields || []).map((f) => (
              <Field
                key={f.name}
                label={`${f.label || f.name}${f.name === spec.primaryField ? " *" : ""}${f.private ? (editing ? " (leave blank to keep the stored value)" : " (stored encrypted)") : ""}`}
              >
                <FieldInput field={f} value={values[f.name]} onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))} />
              </Field>
            ))}

            {kind && <ParameterTestPanel kind={kind} values={values} editing={editing} />}

            <p className="text-xs text-gray-500 mb-4 flex items-start gap-1.5">
              <Lock size={12} className="flex-shrink-0 mt-0.5" />
              Secret fields are encrypted on the Admin Studio server, end to end to SailPoint's Parameter Storage enclave, before they're sent. They can't be viewed afterwards.
            </p>
          </>
        )}

        <PrimaryButton onClick={() => save.mutate()} loading={save.isPending} disabled={!spec || !name.trim() || missingPrimary || owner.length === 0}>
          {editing ? "Save Changes" : "Create Parameter"}
        </PrimaryButton>
        <OutlineButton onClick={onClose} disabled={save.isPending} className="mt-2">Cancel</OutlineButton>
      </div>
      {secretNotice && (
        <SecretNotSavedDialog
          name={secretNotice.saved?.name || name}
          info={secretNotice.info}
          spec={spec}
          editing={editing}
          onClose={() => { const { saved } = secretNotice; setSecretNotice(null); onSaved(saved); }}
        />
      )}
    </div>
  );
}

// ─── List ────────────────────────────────────────────────────────────────────

export default function ParametersPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { search, debouncedSearch, handleSearch } = useUrlSearch();
  const [categoryFilter, setCategoryFilter] = useUrlState("category", "ALL");
  const [selected, setSelected] = useState(() => new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [printMenuOpen, setPrintMenuOpen] = useState(false);

  const { categories, byType } = useParameterSpecs();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["parameters"], queryFn: listParameters });
  const all = Array.isArray(data) ? data : [];
  const ownerNames = useOwnerNames(all.map((p) => p.ownerId));

  const term = debouncedSearch.trim().toLowerCase();
  const list = all
    .filter((p) => categoryFilter === "ALL" || byType.get(p.type)?.categoryId === categoryFilter)
    .filter((p) => !term || [p.name, p.description, typeLabel(p, byType), fmtValue(p.publicFields?.[p.primaryField])]
      .some((v) => String(v || "").toLowerCase().includes(term)))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const allSelected = list.length > 0 && list.every((p) => selected.has(p.id));
  const { page, pager } = usePagedList(list, { noun: "parameter", resetKey: `${debouncedSearch}|${categoryFilter}` });

  const toggleOne = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const printTargets = selected.size > 0 ? list.filter((p) => selected.has(p.id)) : list;
  const printSearchQuery = selected.size > 0 ? undefined : debouncedSearch || undefined;
  const toRow = (p) => {
    const spec = byType.get(p.type);
    return {
      name: p.name,
      typeLabel: typeLabel(p, byType),
      category: spec?.category,
      description: p.description,
      ownerName: ownerNames[p.ownerId] || p.ownerId,
      primaryValue: p.publicFields?.[p.primaryField],
      lastModifiedAt: p.lastModifiedAt,
      privateFieldsLastModifiedAt: p.privateFieldsLastModifiedAt,
      fields: describeFields(p, spec),
    };
  };
  const afterPrint = (opened) => {
    setPrintMenuOpen(false);
    if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
  };
  const printList = () => afterPrint(printParametersListPdf({ tenant: getCredentials()?.tenant, rows: printTargets.map(toRow), searchQuery: printSearchQuery }));
  const printDetail = () => afterPrint(printParametersDetailPdf({ tenant: getCredentials()?.tenant, rows: printTargets.map(toRow), searchQuery: printSearchQuery }));

  const bulkDelete = useMutation({
    mutationFn: async () => {
      const results = [];
      for (const id of [...selected]) {
        try { await deleteParameter(id); results.push({ id, ok: true }); }
        catch (err) { results.push({ id, ok: false, error: err.response?.data?.error || err.message }); }
        setProgress(results.length);
      }
      return results;
    },
    onSuccess: (results) => {
      const failed = results.filter((r) => !r.ok);
      if (failed.length) toast.error(`Deleted ${results.length - failed.length} of ${results.length} — ${failed.length} failed (a parameter still referenced can't be deleted): ${failed[0].error}`, { duration: 10000 });
      else toast.success(`Deleted ${plural(results.length, "parameter")}`);
      setSelected(new Set());
      setConfirmOpen(false);
      setProgress(0);
      queryClient.invalidateQueries({ queryKey: ["parameters"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<BrowseTitleMenu active="Parameter Storage" />}
        loading={isLoading}
        action={
          <div className="flex items-center gap-2">
            <IconButton icon={Plus} title="New Parameter" onClick={() => setCreateOpen(true)} disabled={categories.length === 0} />
            {list.length > 0 && (
              <div className="relative">
                <IconButton icon={Printer} title={selected.size > 0 ? `Print ${selected.size} selected` : "Print parameters"} onClick={() => setPrintMenuOpen((v) => !v)} />
                {printMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setPrintMenuOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 w-56 bg-white border border-gray-200 rounded-xl shadow-lg z-20 overflow-hidden">
                      <p className="px-4 pt-3 pb-1 text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
                        {selected.size > 0 ? `${selected.size} selected` : `${list.length} shown`}
                      </p>
                      <button onClick={printList} className="w-full text-left px-4 py-3 text-sm text-gray-900 hover:bg-gray-50">
                        <p className="font-medium">Basic list</p>
                        <p className="text-xs text-gray-500 mt-0.5">Name, type, primary value and owner</p>
                      </button>
                      <button onClick={printDetail} className="w-full text-left px-4 py-3 text-sm text-gray-900 hover:bg-gray-50 border-t border-gray-100">
                        <p className="font-medium">Detailed list</p>
                        <p className="text-xs text-gray-500 mt-0.5">Every field per parameter, secrets masked</p>
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        <SearchBar value={search} onChange={handleSearch} placeholder="Search parameters…" />
        <FilterBar
          options={[{ value: "ALL", label: "All" }, ...categories.map((c) => ({ value: c.id, label: c.label }))]}
          active={categoryFilter}
          onChange={setCategoryFilter}
        />

        {error && <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />}
        {isLoading && <SkeletonList rows={8} />}
        {!isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={KeyRound}
            title={term || categoryFilter !== "ALL" ? "No results" : "No parameters yet"}
            subtitle={term ? `No parameters match "${debouncedSearch}"` : "Use the + icon above to create one"}
          />
        )}

        {!isLoading && list.length > 0 && (
          <>
            <div className="flex items-center justify-between px-4 py-2 gap-3">
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(list.map((p) => p.id)))} className="w-4 h-4 rounded border-gray-300" />
                Select all
              </label>
              <p className="text-xs text-gray-400">{plural(list.length, "parameter")}{term && " matching"}</p>
            </div>

            {selected.size > 0 && (
              <SelectionActionBar
                count={selected.size}
                actions={[
                  { icon: Printer, title: `Print Detail for Selected (${selected.size})`, onClick: printDetail },
                  { icon: Trash2, title: `Delete Selected Parameters (${selected.size})`, onClick: () => setConfirmOpen(true), danger: true },
                ]}
              />
            )}

            {pager}
            {page.map((p) => (
              <div key={p.id} className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors">
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} className="w-4 h-4 rounded border-gray-300 flex-shrink-0" />
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/parameters/${p.id}`)}
                  onKeyDown={(e) => e.key === "Enter" && navigate(`/parameters/${p.id}`)}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left cursor-pointer active:bg-gray-100"
                >
                  <div className="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center flex-shrink-0">
                    <KeyRound size={16} className="text-indigo-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{p.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">
                      {typeLabel(p, byType)}
                      {p.publicFields?.[p.primaryField] != null && ` · ${fmtValue(p.publicFields[p.primaryField])}`}
                    </p>
                  </div>
                  <span className="text-xs text-gray-400 flex-shrink-0 hidden sm:block truncate max-w-[10rem]">{ownerNames[p.ownerId] || ""}</span>
                  <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
                </div>
              </div>
            ))}
            {pager}
          </>
        )}
      </div>

      {createOpen && (
        <ParameterFormModal
          categories={categories}
          byType={byType}
          onClose={() => setCreateOpen(false)}
          onSaved={(created) => {
            setCreateOpen(false);
            queryClient.invalidateQueries({ queryKey: ["parameters"] });
            if (created?.id) navigate(`/parameters/${created.id}`);
          }}
        />
      )}

      {confirmOpen && (
        <ConfirmModal
          title={`Delete ${plural(selected.size, "parameter")}?`}
          message="This permanently deletes the selected parameters from this tenant. ISC refuses to delete a parameter that's still referenced (e.g. by a workflow). This cannot be undone."
          confirmLabel="Delete"
          danger
          pending={bulkDelete.isPending}
          progressText={`Deleting ${progress} of ${selected.size}…`}
          onConfirm={() => bulkDelete.mutate()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Detail ──────────────────────────────────────────────────────────────────

const SECTIONS = [
  { key: "details", label: "Details", Icon: Info },
  { key: "fields", label: "Fields", Icon: ListTree },
  { key: "references", label: "References", Icon: Link2 },
  { key: "json", label: "JSON", Icon: Braces },
];

function Row({ label, children }) {
  return (
    <div className="flex justify-between items-start gap-4 py-3 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500 min-w-0">{label}</span>
      <span className="text-sm text-gray-900 font-medium text-right max-w-[65%] break-words">{children}</span>
    </div>
  );
}

function ReferencesPanel({ id }) {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["parameter-references", id], queryFn: () => getParameterReferences(id) });
  if (isLoading) return <div className="px-4 py-4"><SkeletonList rows={3} /></div>;
  if (error) return <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />;
  const refs = Array.isArray(data) ? data : [];
  if (refs.length === 0) return <EmptyState icon={Link2} title="Not referenced" subtitle="Nothing uses this parameter yet, so it can be deleted." />;
  return (
    <div className="px-4 py-2">
      <p className="text-xs text-gray-400 py-2">{plural(refs.length, "reference")}</p>
      <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100">
        {refs.map((r) => (
          <div key={r.id} className="px-3 py-2.5">
            <p className="text-sm font-medium text-gray-900">{r.name}</p>
            <p className="text-xs text-gray-500 mt-0.5">{r.consumerId}{r.usageHint ? ` · ${r.usageHint}` : ""}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ParameterDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [section, setSection] = useUrlState("tab", "details");
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const { categories, byType } = useParameterSpecs();
  const { data: p, isLoading, error, refetch } = useQuery({ queryKey: ["parameter", id], queryFn: () => getParameter(id) });
  const ownerNames = useOwnerNames(p ? [p.ownerId, p.lastModifiedBy, p.privateFieldsLastModifiedBy] : []);
  const spec = p ? byType.get(p.type) : null;
  const fields = p ? describeFields(p, spec) : [];
  const pretty = useMemo(() => (p ? JSON.stringify(p, null, 2) : ""), [p]);

  const remove = useMutation({
    mutationFn: () => deleteParameter(id),
    onSuccess: () => {
      toast.success("Parameter deleted");
      queryClient.invalidateQueries({ queryKey: ["parameters"] });
      navigate("/parameters");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 10000 }),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Parameter"
        onBack={() => navigate(-1)}
        action={p && (
          <div className="flex items-center gap-2">
            <IconButton icon={Pencil} title="Edit" onClick={() => setEditOpen(true)} disabled={remove.isPending || !spec} />
            <IconButton icon={Trash2} title="Delete" onClick={() => setConfirmDeleteOpen(true)} disabled={remove.isPending} className="!border-red-200 !text-red-600 hover:!bg-red-50" />
          </div>
        )}
      />
      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && <div className="flex items-center justify-center py-16"><Spinner size={24} /></div>}
        {error && <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />}
        {p && (
          <>
            <div className="px-4 py-4 flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-indigo-50 flex items-center justify-center flex-shrink-0">
                <KeyRound size={20} className="text-indigo-600" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-gray-900 truncate">{p.name}</h2>
                <p className="text-xs text-gray-500 truncate">{spec ? `${spec.category} · ${spec.label}` : typeLabel(p, byType)}</p>
              </div>
            </div>

            <div className="flex border-t border-gray-100">
              <div className="w-28 flex-shrink-0 border-r border-gray-100 py-2">
                {SECTIONS.map(({ key, label, Icon }) => (
                  <button
                    key={key}
                    onClick={() => setSection(key)}
                    className={`w-full flex flex-col items-center gap-1 px-2 py-3 text-xs font-medium transition-colors ${section === key ? "text-blue-600 bg-blue-50" : "text-gray-400 hover:text-gray-600"}`}
                  >
                    <Icon size={18} />
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex-1 min-w-0">
                {section === "details" && (
                  <div className="px-4 pb-4">
                    <SectionLabel>Details</SectionLabel>
                    <Row label="Name">{p.name}</Row>
                    <Row label="Description">{p.description || "—"}</Row>
                    <Row label="Category">{spec?.category || "—"}</Row>
                    <Row label="Type">{spec ? `${spec.label} (${p.type})` : p.type || "—"}</Row>
                    <Row label="Owner">{ownerNames[p.ownerId] || p.ownerId || "—"}</Row>
                    <Row label="Last modified">{fmtDate(p.lastModifiedAt)}{p.lastModifiedBy ? ` by ${ownerNames[p.lastModifiedBy] || p.lastModifiedBy}` : ""}</Row>
                    {p.privateFieldsLastModifiedAt && (
                      <Row label="Secret last changed">{fmtDate(p.privateFieldsLastModifiedAt)}{p.privateFieldsLastModifiedBy ? ` by ${ownerNames[p.privateFieldsLastModifiedBy] || p.privateFieldsLastModifiedBy}` : ""}</Row>
                    )}
                    <Row label="ID"><span className="font-mono text-xs">{p.id}</span></Row>
                  </div>
                )}

                {section === "fields" && (
                  <div className="px-4 pb-4">
                    <SectionLabel>{spec?.label || "Fields"}</SectionLabel>
                    {fields.length === 0 && <p className="text-sm text-gray-400 py-3">No fields.</p>}
                    {fields.map((f) => (
                      <Row key={f.name} label={<>{f.label}{f.name === p.primaryField && <span className="ml-1 text-[10px] text-indigo-600 font-semibold uppercase">primary</span>}</>}>
                        {f.private ? (
                          <span className="inline-flex items-center gap-1 text-gray-500" title="Stored encrypted — ISC never returns this value">
                            <Lock size={12} /> {MASK}
                          </span>
                        ) : (
                          fmtValue(f.value)
                        )}
                      </Row>
                    ))}
                  </div>
                )}

                {section === "references" && <ReferencesPanel id={id} />}

                {section === "json" && (
                  <div className="px-4 py-4">
                    <div className="flex items-center justify-between mb-3 gap-3">
                      <p className="text-xs text-gray-500">The parameter as ISC returns it — public fields only; secrets are never returned.</p>
                      <IconButton icon={Copy} title="Copy JSON" onClick={() => navigator.clipboard.writeText(pretty).then(() => toast.success("JSON copied"), () => toast.error("Couldn't copy"))} />
                    </div>
                    <pre className="border border-gray-200 rounded-xl overflow-auto text-gray-800 bg-gray-50" style={JSON_EDITOR_STYLE} dangerouslySetInnerHTML={{ __html: highlightJson(escapeHtml(pretty)) }} />
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {editOpen && p && (
        <ParameterFormModal
          categories={categories}
          byType={byType}
          parameter={p}
          ownerName={ownerNames[p.ownerId]}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            queryClient.invalidateQueries({ queryKey: ["parameter", id] });
            queryClient.invalidateQueries({ queryKey: ["parameters"] });
          }}
        />
      )}

      {confirmDeleteOpen && (
        <ConfirmModal
          title="Delete this parameter?"
          message="This permanently deletes the parameter. ISC refuses if it's still referenced (see the References tab). This cannot be undone."
          confirmLabel="Delete"
          danger
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => setConfirmDeleteOpen(false)}
        />
      )}
    </div>
  );
}
