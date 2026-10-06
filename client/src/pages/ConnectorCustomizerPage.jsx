import { useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, Pencil, Link, Unlink, Trash2, CheckCircle2, XCircle, ShieldCheck } from "lucide-react";
import toast from "react-hot-toast";
import {
  getConnectorCustomizer, createConnectorCustomizer, updateConnectorCustomizer, deleteConnectorCustomizer,
  getConnectorCustomizerSource, saveConnectorCustomizerSource, deleteConnectorCustomizerSource,
  validateConnectorCustomizerScript, deployConnectorCustomizer,
  getSource, setSourceConnectorCustomizer,
} from "../lib/sailpoint";
import { TopBar } from "../components/TopBar";
import {
  InfoRow, SkeletonList, ErrorBox, IconButton, PrimaryButton, OutlineButton, Field, Input, ConfirmModal, Spinner,
} from "../components/ui";

// Which customizer a SaaS source runs: its connectorAttributes.connectorCustomizerId.
export function sourceCustomizerId(source) {
  return source?.connectorAttributes?.connectorCustomizerId || null;
}

const errText = (err) => err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message;

function ValidationResult({ result }) {
  if (!result) return null;
  if (result.state === "OK") {
    return (
      <p className="text-xs text-emerald-700 flex items-start gap-1.5 mt-2">
        <CheckCircle2 size={14} className="flex-shrink-0 mt-px" />
        <span>Validation passed{result.handlers?.length ? <> — handlers: <span className="font-mono">{result.handlers.join(", ")}</span></> : ""}</span>
      </p>
    );
  }
  const details = Array.isArray(result.details) ? result.details : [];
  return (
    <div className="mt-2 border border-red-200 bg-red-50 rounded-xl px-3 py-2.5 text-xs text-red-700">
      <p className="font-medium flex items-center gap-1.5"><XCircle size={14} /> Validation failed{details.length ? ` — ${details.length} issue${details.length === 1 ? "" : "s"}` : ""}</p>
      <ul className="mt-1 space-y-0.5">
        {details.map((d, i) => (
          <li key={i} className="font-mono break-words">{d.line ? `line ${d.line}: ` : ""}{d.message || "unspecified issue"}</li>
        ))}
      </ul>
    </div>
  );
}

// Create / edit dialog. ISC holds a customizer as a built image, not a
// script — Deploy validates the script, has the server build it into a
// customizer ZIP and uploads that as the next version. Save Draft keeps the
// script with the app without touching ISC.
function ConnectorCustomizerEditor({ customizer, initialScript, onClose, onDone }) {
  const isNew = !customizer?.id;
  const [name, setName] = useState(customizer?.name || "");
  const [script, setScript] = useState(initialScript || "");
  const [validation, setValidation] = useState(null);
  const [validatedScript, setValidatedScript] = useState(null);

  const validate = useMutation({
    mutationFn: () => validateConnectorCustomizerScript(script),
    onSuccess: (result) => { setValidation(result); setValidatedScript(script); },
    onError: (err) => toast.error(errText(err)),
  });

  // Renames first when the name changed — ISC's PUT only carries the name.
  const renameIfChanged = async () => {
    if (!isNew && name.trim() !== customizer.name) await updateConnectorCustomizer(customizer.id, { name: name.trim() });
  };

  const saveDraft = useMutation({
    mutationFn: async () => {
      await renameIfChanged();
      return saveConnectorCustomizerSource(customizer.id, script);
    },
    onSuccess: () => { toast.success("Draft saved — not deployed to ISC yet"); onDone({ id: customizer.id }); },
    onError: (err) => toast.error(errText(err)),
  });

  const deploy = useMutation({
    mutationFn: async () => {
      // Always validate the exact script being deployed, before anything is created.
      const result = validatedScript === script && validation ? validation : await validateConnectorCustomizerScript(script);
      setValidation(result);
      setValidatedScript(script);
      if (result?.state !== "OK") throw Object.assign(new Error("The script did not pass validation — fix the issues listed and try again."), { validation: result });
      let id = customizer?.id;
      if (isNew) id = (await createConnectorCustomizer({ name: name.trim() })).id;
      else await renameIfChanged();
      try {
        const deployed = await deployConnectorCustomizer(id, script);
        return { id, version: deployed?.version };
      } catch (err) {
        // The customizer exists by now — keep the script with it so nothing
        // typed is lost, and land on its page where Deploy can be retried.
        if (isNew) {
          await saveConnectorCustomizerSource(id, script).catch(() => {});
          throw Object.assign(err, { createdId: id });
        }
        throw err;
      }
    },
    onSuccess: ({ id, version }) => {
      toast.success(`${isNew ? "Customizer created and deployed" : "Deployed"} as version ${version?.version ?? "?"}`, { duration: 6000 });
      onDone({ id });
    },
    onError: (err) => {
      if (err.validation) return;
      if (err.response?.data?.validation) { setValidation(err.response.data.validation); setValidatedScript(script); return; }
      if (err.createdId) {
        toast.error(`The customizer was created, but building its first version failed: ${errText(err)}`, { duration: 8000 });
        onDone({ id: err.createdId });
        return;
      }
      toast.error(errText(err));
    },
  });

  const busy = deploy.isPending || saveDraft.isPending;
  const canSave = name.trim() && script.trim();
  const dirtyValidation = validatedScript != null && validatedScript !== script;

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="bg-white w-full max-w-3xl md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[92vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-4">{isNew ? "Create connector customizer" : "Edit connector customizer"}</h2>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Workday customizer" />
        </Field>
        <Field label="Script (JavaScript)">
          <textarea
            value={script}
            onChange={(e) => setScript(e.target.value)}
            spellCheck={false}
            rows={18}
            className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-3 font-mono text-xs text-gray-900 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition leading-relaxed"
          />
          <p className="text-xs text-gray-400 mt-1">
            CommonJS. <span className="font-mono">require("@sailpoint/connector-sdk")</span> and Node built-in modules are available; other npm packages are not.
          </p>
          {dirtyValidation && <p className="text-xs text-amber-700 mt-1">The script changed since it was last validated — it will be validated again on Deploy.</p>}
          <ValidationResult result={validation} />
        </Field>
        <div className="flex flex-col md:flex-row gap-2 mt-2">
          <OutlineButton onClick={() => validate.mutate()} loading={validate.isPending} disabled={!script.trim() || busy} className="!w-auto md:flex-1">
            <ShieldCheck size={16} />
            Validate
          </OutlineButton>
          {!isNew && (
            <OutlineButton onClick={() => saveDraft.mutate()} loading={saveDraft.isPending} disabled={!canSave || deploy.isPending || validate.isPending} className="!w-auto md:flex-1">Save Draft</OutlineButton>
          )}
          <PrimaryButton onClick={() => deploy.mutate()} loading={deploy.isPending} disabled={!canSave || saveDraft.isPending || validate.isPending} className="!w-auto md:flex-1">
            {isNew ? "Validate & Create" : "Validate & Deploy"}
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={busy} className="!w-auto md:flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

export default function ConnectorCustomizerPage() {
  const { id: sourceId, customizerId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const isNew = customizerId === "new";
  const [editOpen, setEditOpen] = useState(isNew);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const backTo = `/sources/${sourceId}?tab=customizers`;
  // Pop back to the source screen rather than pushing a second copy of it —
  // a pushed copy leaves this page underneath, so the source screen's own
  // Back (navigate(-1)) would land right back here. Only a direct load
  // (no in-app history) falls back to the explicit URL.
  const goBack = () => (location.key === "default" ? navigate(backTo, { replace: true }) : navigate(-1));

  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["connector-customizer", customizerId], queryFn: () => getConnectorCustomizer(customizerId), enabled: !isNew });
  // For "new" this is the starter template.
  const { data: stored, isLoading: storedLoading, error: storedError, refetch: refetchStored } = useQuery({ queryKey: ["connector-customizer-source", customizerId], queryFn: () => getConnectorCustomizerSource(customizerId), retry: 1 });
  const { data: source } = useQuery({ queryKey: ["source", sourceId], queryFn: () => getSource(sourceId), enabled: !!sourceId });
  const assigned = !isNew && sourceCustomizerId(source) === customizerId;

  function onEditorDone({ id }) {
    queryClient.invalidateQueries({ queryKey: ["connector-customizers"] });
    queryClient.invalidateQueries({ queryKey: ["connector-customizer", id] });
    queryClient.invalidateQueries({ queryKey: ["connector-customizer-source", id] });
    setEditOpen(false);
    if (isNew) navigate(`/sources/${sourceId}/customizers/${id}`, { replace: true });
  }

  const assign = useMutation({
    mutationFn: (on) => setSourceConnectorCustomizer(sourceId, on ? customizerId : null),
    onSuccess: (_d, on) => {
      toast.success(on ? `Assigned to ${source?.name || "this source"}` : `Removed from ${source?.name || "this source"}`);
      queryClient.invalidateQueries({ queryKey: ["source", sourceId] });
    },
    onError: (err) => toast.error(errText(err)),
  });
  const remove = useMutation({
    mutationFn: async () => {
      await deleteConnectorCustomizer(customizerId);
      await deleteConnectorCustomizerSource(customizerId).catch(() => {});
    },
    onSuccess: () => {
      toast.success(`Deleted "${data?.name}"`);
      queryClient.invalidateQueries({ queryKey: ["connector-customizers"] });
      goBack();
    },
    onError: (err) => toast.error(errText(err)),
  });

  const deployed = stored?.deployed;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Connector Customizer"
        onBack={() => goBack()}
        action={
          data && (
            <div className="flex items-center gap-2">
              <IconButton icon={Pencil} title="Edit name and script" onClick={() => setEditOpen(true)} disabled={storedLoading} />
              <IconButton
                icon={assigned ? Unlink : Link}
                title={assigned ? `Remove from ${source?.name || "this source"}` : `Assign to ${source?.name || "this source"}`}
                onClick={() => assign.mutate(!assigned)}
                loading={assign.isPending}
                disabled={!source}
              />
              <IconButton icon={Trash2} title="Delete customizer" onClick={() => setDeleteConfirm(true)} loading={remove.isPending} className="!border-red-200 !text-red-600 hover:!bg-red-50" />
            </div>
          )
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && <div className="px-4 py-4"><SkeletonList rows={5} /></div>}
        {error && (
          <div className="px-4 py-4">
            <ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} />
            <OutlineButton onClick={() => goBack()} className="!w-auto mt-3">Back to Connector Customizers</OutlineButton>
          </div>
        )}
        {data && (
          <>
            <div className="px-4 py-4 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-sky-50 flex items-center justify-center flex-shrink-0">
                  <Cloud size={18} className="text-sky-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-semibold text-gray-900 truncate">{data.name}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    SaaS connectivity customizer · version {data.imageVersion ?? "—"}{source?.name ? ` · viewed from ${source.name}` : ""}
                  </p>
                </div>
                {assigned && <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 flex-shrink-0">Assigned to this source</span>}
              </div>
            </div>
            <div className="px-4 py-4">
              <div className="border border-gray-100 rounded-xl overflow-hidden px-4">
                <InfoRow label="Name" value={data.name} />
                <InfoRow label="Image version" value={data.imageVersion != null ? String(data.imageVersion) : undefined} />
                <InfoRow label="Image ID" value={data.imageID} />
                <InfoRow label="Created" value={data.created ? new Date(data.created).toLocaleString() : undefined} />
                <InfoRow label="Customizer ID" value={data.id} />
                <InfoRow label="Assigned to this source" value={source ? (assigned ? "Yes" : "No") : undefined} />
              </div>
              <div className="mt-3 flex flex-col md:flex-row gap-2">
                <OutlineButton onClick={() => setEditOpen(true)} disabled={storedLoading} className="!w-auto md:flex-1">
                  <Pencil size={16} />
                  Edit Script
                </OutlineButton>
                <OutlineButton onClick={() => assign.mutate(!assigned)} loading={assign.isPending} disabled={!source} className="!w-auto md:flex-1">
                  {assigned ? <Unlink size={16} /> : <Link size={16} />}
                  {assigned ? "Remove from This Source" : "Assign to This Source"}
                </OutlineButton>
              </div>

              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mt-4 mb-1">Script</p>
              {storedLoading && <SkeletonList rows={3} />}
              {storedError && <ErrorBox message={`Couldn't load the stored script: ${errText(storedError)}`} onRetry={refetchStored} />}
              {stored && !stored.stored && (
                <p className="text-xs text-gray-500 border border-gray-200 rounded-xl bg-gray-50 px-3 py-2.5">
                  No script is stored for this customizer. ISC keeps only a customizer's built image, never its source{data.imageVersion ? " — this one's current version was built outside the app, so its code can't be shown" : ""}. Use Edit Script to write one; deploying it becomes the next version{data.imageVersion ? " and replaces what runs now" : ""}.
                </p>
              )}
              {stored?.stored && (
                <>
                  <p className={`text-xs mb-1.5 ${stored.dirty ? "text-amber-700" : "text-gray-500"}`}>
                    {!deployed && "Draft — not deployed to ISC yet."}
                    {deployed && !stored.dirty && `Deployed as version ${deployed.version ?? "?"} on ${new Date(deployed.at).toLocaleString()}${deployed.by ? ` by ${deployed.by}` : ""}.`}
                    {deployed && stored.dirty && `Draft has changes that are not deployed — ISC is running version ${deployed.version ?? "?"}.`}
                    {deployed && data.imageVersion != null && deployed.version != null && data.imageVersion > deployed.version && ` ISC is now on version ${data.imageVersion}, uploaded outside the app — this script may not be what is running.`}
                  </p>
                  <pre className="border border-gray-200 rounded-xl overflow-auto bg-gray-50 text-gray-800 font-mono text-xs p-3 leading-relaxed whitespace-pre-wrap break-words">{stored.script}</pre>
                </>
              )}
              <p className="text-xs text-gray-500 mt-3">
                Deploying builds the script into a customizer image and uploads it as the next version; sources assigned to this customizer pick it up on their next run. Assigning sets the source's connectorCustomizerId attribute.
              </p>
            </div>
          </>
        )}
      </div>

      {editOpen && (isNew || data) && stored && (
        <ConnectorCustomizerEditor
          customizer={isNew ? null : data}
          initialScript={stored.script}
          onClose={() => { setEditOpen(false); if (isNew) goBack(); }}
          onDone={onEditorDone}
        />
      )}
      {editOpen && !((isNew || data) && stored) && !error && !storedError && <div className="fixed inset-0 flex items-center justify-center"><Spinner size={20} /></div>}
      {/* The editor can't open without the script (or, for a new one, the starter) — say so rather than spin. */}
      {editOpen && storedError && (
        <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center">
          <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5">
            <ErrorBox message={`Couldn't load the customizer script: ${errText(storedError)}`} onRetry={refetchStored} />
            <OutlineButton onClick={() => { setEditOpen(false); if (isNew) goBack(); }} className="mt-3">Close</OutlineButton>
          </div>
        </div>
      )}
      {deleteConfirm && data && (
        <ConfirmModal
          title={`Delete "${data.name}"?`}
          message="This permanently deletes the connector customizer from ISC, along with the script stored for it here. Sources that reference it will stop running it. This cannot be undone."
          confirmLabel="Delete"
          danger
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
          onCancel={() => !remove.isPending && setDeleteConfirm(false)}
        />
      )}
    </div>
  );
}
