import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { UploadCloud, FileText, CheckCircle2, XCircle } from "lucide-react";
import toast from "react-hot-toast";
import {
  createDisconnectedSource, detectSourceSchema, setSourceSchemaUid, createIdentityProfileForSource,
  loadAccountsFile, getSourceAggregationHistory,
} from "../lib/sailpoint";
import { parseCsv, toCsv } from "../lib/csv";
import { Field, Input, Select, PrimaryButton, OutlineButton, Spinner } from "./ui";

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Couldn't read that file."));
    reader.readAsText(file);
  });
}

function toBase64(text) {
  return btoa(unescape(encodeURIComponent(text)));
}

// Prefers an obviously-named id column, else the first column whose sampled
// values are all present and unique — same idea as ISC's own schema
// detection default, done client-side since (see buildAugmentedCsv below)
// the UID/Account Name pick has to happen BEFORE anything is uploaded.
function guessUidColumn(headers, rows) {
  const lower = headers.map((h) => h.toLowerCase());
  for (const p of ["id", "uid", "employeeid", "emp_id", "employee_id"]) {
    const idx = lower.indexOf(p);
    if (idx !== -1) return headers[idx];
  }
  const sample = rows.slice(0, 200);
  for (const h of headers) {
    const values = sample.map((r) => r[h]);
    const nonEmpty = values.filter((v) => v !== "" && v != null);
    if (nonEmpty.length === values.length && nonEmpty.length > 0 && new Set(nonEmpty).size === nonEmpty.length) {
      return h;
    }
  }
  return headers[0] || "";
}

function guessNameColumn(headers, uidCol) {
  const lower = headers.map((h) => h.toLowerCase());
  for (const p of ["name", "fullname", "full_name", "displayname", "display_name"]) {
    const idx = lower.indexOf(p);
    if (idx !== -1 && headers[idx] !== uidCol) return headers[idx];
  }
  return headers.find((h) => h !== uidCol) || headers[0] || "";
}

// ISC's DelimitedFile connector hard-requires the account schema to keep
// "id"/"name" attributes — it refuses to save a schema that drops them
// ("Unable to delete attributes 'name, id' because it is referenced by
// ...the default identity profile mapping for this source type", verified
// live). Rather than fight that, this guarantees the uploaded file always
// has literal "id"/"name" columns carrying the user's chosen UID/Account
// Name values — renaming any pre-existing "id"/"name" columns that AREN'T
// the chosen ones first, so nothing is silently overwritten or lost.
function buildAugmentedCsv({ headers, rows }, uidCol, nameCol) {
  const renameMap = {};
  if (uidCol !== "id" && headers.includes("id")) renameMap.id = "id_original";
  if (nameCol !== "name" && headers.includes("name")) renameMap.name = "name_original";

  const finalHeaders = ["id", "name", ...headers.filter((h) => h !== "id" && h !== "name").map((h) => renameMap[h] || h)];
  const finalRows = rows.map((r) => {
    const renamed = {};
    headers.forEach((h) => { renamed[renameMap[h] || h] = r[h]; });
    return { ...renamed, id: r[uidCol], name: r[nameCol] };
  });
  return toCsv(finalHeaders, finalRows);
}

// Steps: form (name/file/checkbox) → schema (confirm UID + Account Name,
// detected client-side from the file's own header row) → aggregating (poll
// until the real ISC job finishes) → done. The actual source creation,
// schema save, and aggregation all happen together once the UID/Account
// Name choice is confirmed — see buildAugmentedCsv for why that ordering
// matters.
export function AddDisconnectedSourceModal({ onClose, onDone }) {
  const [step, setStep] = useState("form");
  const [name, setName] = useState("");
  const [file, setFile] = useState(null);
  const [createProfile, setCreateProfile] = useState(true);
  const [parsing, setParsing] = useState(false);

  const [parsedCsv, setParsedCsv] = useState(null); // { headers, rows }
  const [uidAttr, setUidAttr] = useState("");
  const [nameAttr, setNameAttr] = useState("");

  const [sourceId, setSourceId] = useState(null);
  const [sourceName, setSourceName] = useState("");
  const [result, setResult] = useState(null);

  async function handleFile(f) {
    setFile(f);
    if (!f) { setParsedCsv(null); return; }
    setParsing(true);
    try {
      const text = await readFileAsText(f);
      const parsed = parseCsv(text);
      if (parsed.headers.length === 0) {
        toast.error("That file doesn't look like a CSV — no header row found.");
        setParsedCsv(null);
        return;
      }
      setParsedCsv(parsed);
      const uid = guessUidColumn(parsed.headers, parsed.rows);
      setUidAttr(uid);
      setNameAttr(guessNameColumn(parsed.headers, uid));
    } catch (err) {
      toast.error(err.message);
      setParsedCsv(null);
    } finally {
      setParsing(false);
    }
  }

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const src = await createDisconnectedSource({ name: name.trim() });
      const csv = buildAugmentedCsv(parsedCsv, uidAttr, nameAttr);
      const csvBase64 = toBase64(csv);
      const filename = file.name;
      const detected = await detectSourceSchema(src.id, { filename, csvBase64 });
      await setSourceSchemaUid(src.id, detected.schemaId, { identityAttribute: "id", displayAttribute: "name" });
      await loadAccountsFile(src.id, { filename, csvBase64 });
      return src;
    },
    onSuccess: (src) => {
      setSourceId(src.id);
      setSourceName(src.name);
      setStep("aggregating");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const profileMutation = useMutation({
    mutationFn: () => createIdentityProfileForSource(sourceId),
    onSuccess: (data) => {
      setResult({
        profileCreated: true,
        profileName: data.profile?.name,
        mappingCount: (data.mapping || []).length,
        applied: data.applied !== false,
      });
      setStep("done");
    },
    onError: (err) => {
      setResult({ profileCreated: false, profileError: err.response?.data?.error || err.message });
      setStep("done");
    },
  });

  const aggQuery = useQuery({
    queryKey: ["wizard-aggregation-history", sourceId],
    queryFn: () => getSourceAggregationHistory(sourceId),
    enabled: step === "aggregating" && !!sourceId,
    refetchInterval: (query) => {
      const latest = query.state.data?.[0];
      return latest && !latest.completed ? 3000 : false;
    },
  });

  useEffect(() => {
    if (step !== "aggregating") return;
    const latest = aggQuery.data?.[0];
    if (!latest?.completed) return;
    if (createProfile) {
      profileMutation.mutate();
    } else {
      setResult({ profileCreated: false });
      setStep("done");
    }
  }, [step, aggQuery.data]);

  const canReview = name.trim().length > 0 && !!parsedCsv && !parsing;

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && step !== "aggregating" && !profileMutation.isPending && onClose()}
    >
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
            <UploadCloud size={18} className="text-blue-600" />
          </div>
          <h2 className="text-base font-semibold text-gray-900">Add Disconnected Source</h2>
        </div>

        {step === "form" && (
          <>
            <Field label="Source Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Contractor Roster" />
            </Field>
            <Field label="Accounts CSV">
              <label className="flex items-center gap-2 border border-dashed border-gray-300 rounded-xl px-3 py-3 text-sm text-gray-500 cursor-pointer hover:border-blue-400">
                <FileText size={16} className="flex-shrink-0" />
                <span className="truncate">{file ? file.name : "Choose a CSV file…"}</span>
                <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => handleFile(e.target.files?.[0] || null)} />
              </label>
            </Field>
            <label className="flex items-center gap-2 mb-4 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={createProfile}
                onChange={(e) => setCreateProfile(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300"
              />
              Create an Identity Profile
            </label>
            <div className="flex gap-2">
              <PrimaryButton onClick={() => setStep("schema")} loading={parsing} disabled={!canReview}>
                Create
              </PrimaryButton>
              <OutlineButton onClick={onClose}>Cancel</OutlineButton>
            </div>
          </>
        )}

        {step === "schema" && parsedCsv && (
          <>
            <p className="text-xs text-gray-500 mb-3">
              Detected {parsedCsv.headers.length} column{parsedCsv.headers.length === 1 ? "" : "s"} from the file — confirm which one uniquely identifies each account (UID) and which one is the display name.
            </p>
            <Field label="UID Attribute">
              <Select value={uidAttr} onChange={(e) => setUidAttr(e.target.value)}>
                {parsedCsv.headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </Select>
            </Field>
            <Field label="Account Name Attribute">
              <Select value={nameAttr} onChange={(e) => setNameAttr(e.target.value)}>
                {parsedCsv.headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </Select>
            </Field>
            <div className="flex gap-2">
              <PrimaryButton onClick={() => confirmMutation.mutate()} loading={confirmMutation.isPending} disabled={!uidAttr || !nameAttr}>
                Confirm &amp; Aggregate
              </PrimaryButton>
              <OutlineButton onClick={() => setStep("form")} disabled={confirmMutation.isPending}>Back</OutlineButton>
            </div>
          </>
        )}

        {step === "aggregating" && (
          <div className="flex flex-col items-center py-6 text-center">
            <Spinner size={24} />
            <p className="text-sm text-gray-700 mt-3">Aggregating accounts from the file…</p>
            <p className="text-xs text-gray-400 mt-1">
              {profileMutation.isPending ? "Aggregation complete — creating the Identity Profile…" : "This can take a minute."}
            </p>
          </div>
        )}

        {step === "done" && (
          <>
            <div className="flex items-center gap-2 mb-3 text-emerald-700">
              <CheckCircle2 size={18} className="flex-shrink-0" />
              <p className="text-sm font-medium">"{sourceName}" was created and aggregated.</p>
            </div>
            {createProfile && result?.profileCreated && (
              <div className="flex items-center gap-2 mb-3 text-emerald-700">
                <CheckCircle2 size={18} className="flex-shrink-0" />
                <p className="text-sm">
                  Identity Profile "{result.profileName}" created
                  {result.mappingCount > 0 ? ` with ${result.mappingCount} AI-matched attribute${result.mappingCount === 1 ? "" : "s"}` : ""}
                  {result.applied
                    ? " and applied to identities."
                    : " — created, but applying the mapping to identities failed; you can re-run Process Identities from the Identity Profile in ISC."}
                </p>
              </div>
            )}
            {createProfile && result && !result.profileCreated && (
              <>
                <div className="flex items-start gap-2 mb-3 text-red-600">
                  <XCircle size={18} className="flex-shrink-0 mt-0.5" />
                  <p className="text-sm">
                    The source was created and aggregated, but the Identity Profile failed: {result.profileError}
                  </p>
                </div>
                <PrimaryButton onClick={() => profileMutation.mutate()} loading={profileMutation.isPending} className="mb-2">
                  Retry Identity Profile
                </PrimaryButton>
              </>
            )}
            <PrimaryButton onClick={() => onDone?.(sourceId)} disabled={profileMutation.isPending}>Done</PrimaryButton>
          </>
        )}
      </div>
    </div>
  );
}
