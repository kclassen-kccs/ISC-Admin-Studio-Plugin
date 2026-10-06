import { useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Code, Pencil, CheckCircle2, XCircle, ShieldCheck, Search, Maximize2, Minimize2, AlertTriangle, Info } from "lucide-react";
import toast from "react-hot-toast";
import {
  getConnectorRule, createConnectorRule, updateConnectorRule, validateConnectorRule, getSource,
} from "../lib/sailpoint";
import { TopBar } from "../components/TopBar";
import { useUrlState } from "../hooks/useUrlState";
import { JsonEditSurface, JsonFindReplaceBar, useJsonFind, highlightCode } from "../components/JsonEditor";
import { checkScriptStructure } from "../lib/scriptSyntax";
import { handleBracketKey, BEANSHELL_QUOTES } from "../lib/bracketPairs";
import { useCodeCompletion, CompletionList, buildCompletions } from "../components/CodeAutocomplete";
import {
  InfoRow, SkeletonList, ErrorBox, IconButton, PrimaryButton, OutlineButton, Field, Input, Textarea, Select, Spinner,
} from "../components/ui";

// Every connector rule type ISC accepts (ConnectorRuleCreateRequest.type).
export const CONNECTOR_RULE_TYPES = [
  "BuildMap", "ConnectorAfterCreate", "ConnectorAfterDelete", "ConnectorAfterModify", "ConnectorBeforeCreate",
  "ConnectorBeforeDelete", "ConnectorBeforeModify", "JDBCBuildMap", "JDBCOperationProvisioning", "JDBCProvision",
  "PeopleSoftHRMSBuildMap", "PeopleSoftHRMSOperationProvisioning", "PeopleSoftHRMSProvision", "RACFPermissionCustomization",
  "ResourceObjectCustomization", "SAPBuildMap", "SapHrManagerRule", "SapHrOperationProvisioning", "SapHrProvision",
  "SuccessFactorsOperationProvisioning", "WebServiceAfterOperationRule", "WebServiceBeforeOperationRule",
];

const STARTER_SCRIPT = `import sailpoint.object.*;

// Connector rule script (BeanShell). The variables available depend on the
// rule type — see the rule's signature for its inputs and output.

return null;
`;

function ValidationResult({ result }) {
  if (!result) return null;
  if (result.state === "OK") {
    return (
      <p className="text-xs text-emerald-700 flex items-center gap-1.5 mt-2"><CheckCircle2 size={14} /> Validation passed — the script is accepted by ISC.</p>
    );
  }
  const details = Array.isArray(result.details) ? result.details : [];
  return (
    <div className="mt-2 border border-red-200 bg-red-50 rounded-xl px-3 py-2.5 text-xs text-red-700">
      <p className="font-medium flex items-center gap-1.5"><XCircle size={14} /> Validation failed{details.length ? ` — ${details.length} issue${details.length === 1 ? "" : "s"}` : ""}</p>
      <ul className="mt-1 space-y-0.5">
        {details.map((d, i) => (
          <li key={i} className="font-mono break-words">line {d.line ?? "?"}, col {d.column ?? "?"}: {d.message || d.messsage || "unspecified issue"}</li>
        ))}
      </ul>
    </div>
  );
}

// Structural problems found in the browser as you type — see
// checkScriptStructure for why this is not a JavaScript parser.
function StructureIssues({ issues }) {
  if (!issues.length) return null;
  return (
    <div className="mt-2 border border-amber-200 bg-amber-50 rounded-xl px-3 py-2.5 text-xs text-amber-800">
      <p className="font-medium flex items-center gap-1.5">
        <AlertTriangle size={14} /> {issues.length} syntax {issues.length === 1 ? "issue" : "issues"} — ISC will reject this
      </p>
      <ul className="mt-1 space-y-0.5">
        {issues.map((d, i) => (
          <li key={i} className="font-mono break-words">line {d.line}, col {d.column}: {d.message}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The BeanShell editing surface: highlighting, find & replace, autocomplete
 * off the rule's own signature, live structural checks and the expand
 * toggle. Shared by the create/edit dialog and the rule's BeanShell tab so
 * the two can't drift apart.
 *
 * `expanded` is lifted to the caller — in the dialog it also resizes the
 * dialog itself, which only the caller can do.
 */
export function ScriptEditor({ script, onChange, signatureInputs, expanded, onToggleExpand, minHeight }) {
  const scriptRef = useRef(null);
  const [findOpen, setFindOpen] = useState(false);

  // Auto-closing brackets and quotes. Runs BEFORE the completion list's key
  // handling: the keys don't overlap (this claims brackets, quotes and
  // Backspace; the list claims arrows/Tab/Enter/Escape), and whichever
  // handles the event first must be the one that owns that key.
  const onBracketKey = (e) =>
    handleBracketKey(e, { textarea: scriptRef.current, onChange, quotes: BEANSHELL_QUOTES });

  const find = useJsonFind({ text: script, onChange, textareaRef: scriptRef, enabled: findOpen });
  const structureIssues = useMemo(() => checkScriptStructure(script), [script]);
  const completions = useMemo(() => buildCompletions(signatureInputs, script), [signatureInputs, script]);
  const completion = useCodeCompletion({
    text: script,
    onChange,
    textareaRef: scriptRef,
    completions,
    // Find/replace owns the keyboard while it's open.
    enabled: !findOpen,
  });

  return (
    <>
      <div className="flex items-center justify-end gap-2 mb-1.5">
        <IconButton
          icon={Search}
          title={findOpen ? "Hide find & replace" : "Find & replace"}
          onClick={() => setFindOpen((v) => !v)}
          className="!w-7 !h-7"
        />
        {onToggleExpand && (
          <IconButton
            icon={expanded ? Minimize2 : Maximize2}
            title={expanded ? "Shrink the editor" : "Expand to 90% of the window"}
            onClick={onToggleExpand}
            className="!w-7 !h-7"
          />
        )}
      </div>
      {findOpen && <JsonFindReplaceBar find={find} onClose={() => setFindOpen(false)} />}
      <JsonEditSurface
        text={script}
        onChange={onChange}
        textareaRef={scriptRef}
        matches={findOpen ? find.matches : undefined}
        activeIndex={findOpen ? find.index : -1}
        highlight={highlightCode}
        minHeight={minHeight || (expanded ? "calc(90vh - 320px)" : "320px")}
        textareaProps={{
          ...completion.textareaProps,
          onKeyDown: (e) => {
            if (onBracketKey(e)) return;
            completion.textareaProps.onKeyDown(e);
          },
        }}
      >
        <CompletionList completion={completion} />
      </JsonEditSurface>
      {signatureInputs.length > 0 && (
        <p className="text-xs text-gray-400 mt-1">
          Autocomplete: this rule's {signatureInputs.length} signature argument
          {signatureInputs.length === 1 ? "" : "s"} plus BeanShell keywords — ↑↓ to choose, Tab or Enter to insert.
        </p>
      )}
      <StructureIssues issues={structureIssues} />
    </>
  );
}

// Create / edit dialog. Save always validates the script with ISC first and
// refuses to write an invalid rule; Validate checks without saving.
export function ConnectorRuleEditor({ rule, onClose, onSaved }) {
  const isNew = !rule?.id;
  const [name, setName] = useState(rule?.name || "");
  const [type, setType] = useState(rule?.type || "BuildMap");
  const [description, setDescription] = useState(rule?.description || "");
  const [script, setScript] = useState(rule?.sourceCode?.script || STARTER_SCRIPT);
  const [validation, setValidation] = useState(null);
  const [validatedScript, setValidatedScript] = useState(null);
  const [expanded, setExpanded] = useState(false);

  // The rule's own signature arguments lead the completion list — they differ
  // per rule type and are the names an author can't guess.
  const signatureInputs = useMemo(
    () => (Array.isArray(rule?.signature?.input) ? rule.signature.input : []),
    [rule]
  );

  const validate = useMutation({
    mutationFn: () => validateConnectorRule({ version: rule?.sourceCode?.version || "1.0", script }),
    onSuccess: (result) => { setValidation(result); setValidatedScript(script); },
    onError: (err) => toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message),
  });

  const save = useMutation({
    mutationFn: async () => {
      // Always validate the exact script being saved.
      const result = validatedScript === script && validation ? validation : await validateConnectorRule({ version: rule?.sourceCode?.version || "1.0", script });
      setValidation(result);
      setValidatedScript(script);
      if (result?.state !== "OK") throw Object.assign(new Error("The script did not pass ISC validation — fix the issues listed and try again."), { validation: result });
      const body = {
        name: name.trim(),
        type,
        description: description.trim() || null,
        signature: rule?.signature || undefined,
        attributes: rule?.attributes || undefined,
        sourceCode: { version: rule?.sourceCode?.version || "1.0", script },
      };
      return isNew ? createConnectorRule(body) : updateConnectorRule(rule.id, { ...body, id: rule.id });
    },
    onSuccess: (saved) => { toast.success(isNew ? "Connector rule created" : "Connector rule saved"); onSaved(saved); },
    onError: (err) => { if (!err.validation) toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message); },
  });

  const canSave = name.trim() && type && script.trim();
  const dirtyValidation = validatedScript != null && validatedScript !== script;

  return (
    <div className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center" onClick={(e) => e.target === e.currentTarget && !save.isPending && onClose()}>
      <div
        className={`bg-white rounded-t-2xl md:rounded-2xl shadow-xl p-5 overflow-y-auto transition-[max-width] ${
          expanded ? "w-[90vw] max-w-none h-[90vh] max-h-[90vh]" : "w-full max-w-3xl md:mx-4 max-h-[92vh]"
        }`}
      >
        <h2 className="text-base font-semibold text-gray-900 mb-4">{isNew ? "Create connector rule" : "Edit connector rule"}</h2>
        <div className="grid md:grid-cols-2 md:gap-x-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={128} placeholder="e.g. AD Build Map" />
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)} disabled={!isNew}>
              {CONNECTOR_RULE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
            {!isNew && <p className="text-xs text-gray-400 mt-1">Type can't change after creation.</p>}
          </Field>
        </div>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>
        <Field label="Script (BeanShell)">
          <ScriptEditor
            script={script}
            onChange={setScript}
            signatureInputs={signatureInputs}
            expanded={expanded}
            onToggleExpand={() => setExpanded((v) => !v)}
          />
          {dirtyValidation && <p className="text-xs text-amber-700 mt-1">The script changed since it was last validated — it will be validated again on Save.</p>}
          <ValidationResult result={validation} />
        </Field>
        <div className="flex flex-col md:flex-row gap-2 mt-2">
          <OutlineButton onClick={() => validate.mutate()} loading={validate.isPending} disabled={!script.trim() || save.isPending} className="!w-auto md:flex-1">
            <ShieldCheck size={16} />
            Validate
          </OutlineButton>
          <PrimaryButton onClick={() => save.mutate()} loading={save.isPending} disabled={!canSave || validate.isPending} className="!w-auto md:flex-1">
            {isNew ? "Validate & Create" : "Validate & Save"}
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={save.isPending} className="!w-auto md:flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

/**
 * The rule's BeanShell tab — the script itself, editable in place.
 *
 * Saving here writes ONLY the script: name, type and description stay as
 * they are and are edited from Details, so the two tabs can't overwrite each
 * other's fields. As in the dialog, ISC validates before the write and an
 * invalid script is never saved.
 */
function BeanShellTab({ rule, onSaved }) {
  const [script, setScript] = useState(rule.sourceCode?.script || "");
  const [validation, setValidation] = useState(null);
  const [validatedScript, setValidatedScript] = useState(null);

  const signatureInputs = useMemo(
    () => (Array.isArray(rule?.signature?.input) ? rule.signature.input : []),
    [rule]
  );
  const version = rule.sourceCode?.version || "1.0";
  const dirty = script !== (rule.sourceCode?.script || "");
  const dirtyValidation = validatedScript != null && validatedScript !== script;

  const validate = useMutation({
    mutationFn: () => validateConnectorRule({ version, script }),
    onSuccess: (result) => { setValidation(result); setValidatedScript(script); },
    onError: (err) => toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message),
  });

  const save = useMutation({
    mutationFn: async () => {
      const result = validatedScript === script && validation ? validation : await validateConnectorRule({ version, script });
      setValidation(result);
      setValidatedScript(script);
      if (result?.state !== "OK") throw Object.assign(new Error("The script did not pass ISC validation — fix the issues listed and try again."), { validation: result });
      return updateConnectorRule(rule.id, {
        id: rule.id,
        name: rule.name,
        type: rule.type,
        description: rule.description ?? null,
        signature: rule.signature || undefined,
        attributes: rule.attributes || undefined,
        sourceCode: { version, script },
      });
    },
    onSuccess: (saved) => { toast.success("Script saved"); onSaved(saved); },
    onError: (err) => { if (!err.validation) toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message); },
  });

  return (
    <div className="px-4 py-4">
      {/* The tab has a whole screen to itself, so the editor is full height
          from the start and there's nothing to expand — no toggle here. */}
      <ScriptEditor
        script={script}
        onChange={setScript}
        signatureInputs={signatureInputs}
        minHeight="calc(100vh - 260px)"
      />
      {dirtyValidation && <p className="text-xs text-amber-700 mt-1">The script changed since it was last validated — it will be validated again on Save.</p>}
      <ValidationResult result={validation} />
      <div className="flex flex-col md:flex-row gap-2 mt-3">
        <OutlineButton onClick={() => validate.mutate()} loading={validate.isPending} disabled={!script.trim() || save.isPending} className="!w-auto md:flex-1">
          <ShieldCheck size={16} />
          Validate
        </OutlineButton>
        <PrimaryButton onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || !script.trim() || validate.isPending} className="!w-auto md:flex-1">
          Validate &amp; Save script
        </PrimaryButton>
        {dirty && (
          <OutlineButton onClick={() => { setScript(rule.sourceCode?.script || ""); setValidation(null); setValidatedScript(null); }} disabled={save.isPending} className="!w-auto md:flex-1">
            Discard changes
          </OutlineButton>
        )}
      </div>
    </div>
  );
}

export default function ConnectorRulePage() {
  const { id: sourceId, ruleId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const isNew = ruleId === "new";
  const [editOpen, setEditOpen] = useState(isNew);
  const [section, setSection] = useUrlState("tab", "details");

  const { data: rule, isLoading, error, refetch } = useQuery({
    queryKey: ["connector-rule", ruleId],
    queryFn: () => getConnectorRule(ruleId),
    enabled: !isNew,
  });
  const { data: source } = useQuery({ queryKey: ["source", sourceId], queryFn: () => getSource(sourceId), enabled: !!sourceId, staleTime: 60_000 });
  const backTo = `/sources/${sourceId}?tab=rules`;
  // Pop back to the source screen rather than pushing a second copy of it —
  // a pushed copy leaves this page underneath, so the source screen's own
  // Back (navigate(-1)) would land right back here. Only a direct load
  // (no in-app history) falls back to the explicit URL.
  const goBack = () => (location.key === "default" ? navigate(backTo, { replace: true }) : navigate(-1));

  const inputs = useMemo(() => (Array.isArray(rule?.signature?.input) ? rule.signature.input : []), [rule]);
  const output = rule?.signature?.output || null;

  function onSaved(saved) {
    queryClient.invalidateQueries({ queryKey: ["connector-rules"] });
    if (saved?.id) {
      queryClient.setQueryData(["connector-rule", saved.id], saved);
      queryClient.invalidateQueries({ queryKey: ["connector-rule", saved.id] });
    }
    setEditOpen(false);
    if (isNew && saved?.id) navigate(`/sources/${sourceId}/rules/${saved.id}`, { replace: true });
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Connector Rule"
        onBack={() => goBack()}
        action={rule && <IconButton icon={Pencil} title="Edit this rule" onClick={() => setEditOpen(true)} />}
      />
      <div className="flex-1 overflow-y-auto pb-24">
        {!isNew && isLoading && <div className="px-4 py-4"><SkeletonList rows={6} /></div>}
        {error && <div className="px-4 py-4"><ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} /></div>}
        {isNew && !editOpen && (
          <div className="px-4 py-8 text-center text-sm text-gray-500">
            <p>No rule created.</p>
            <OutlineButton onClick={() => goBack()} className="!w-auto mt-3">Back to Connector Rules</OutlineButton>
          </div>
        )}
        {rule && (
          <>
            <div className="px-4 py-4 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
                  <Code size={18} className="text-slate-700" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-semibold text-gray-900 truncate">{rule.name}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">{rule.type}{source?.name ? ` · viewed from ${source.name}` : ""}</p>
                </div>
              </div>
              {rule.description && <p className="text-sm text-gray-600 leading-relaxed mt-3">{rule.description}</p>}
            </div>

            <div className="flex">
              <div className="w-24 flex-shrink-0 border-r border-gray-100 py-2">
                {[
                  { key: "details", label: "Details", Icon: Info },
                  { key: "beanshell", label: "BeanShell", Icon: Code },
                ].map(({ key, label, Icon }) => (
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
                {section === "beanshell" && <BeanShellTab key={rule.modified || rule.id} rule={rule} onSaved={onSaved} />}
                {section === "details" && (
                <div className="px-4 py-4">
                  <div className="border border-gray-100 rounded-xl overflow-hidden px-4">
                    <InfoRow label="Name" value={rule.name} />
                    <InfoRow label="Type" value={rule.type} />
                    <InfoRow label="Version" value={rule.sourceCode?.version} />
                    <InfoRow label="Created" value={rule.created ? new Date(rule.created).toLocaleString() : undefined} />
                    <InfoRow label="Modified" value={rule.modified ? new Date(rule.modified).toLocaleString() : undefined} />
                    <InfoRow label="Rule ID" value={rule.id} />
                  </div>

                  {(inputs.length > 0 || output) && (
                    <>
                      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mt-4 mb-1">Signature</p>
                      <div className="border border-gray-100 rounded-xl overflow-hidden px-4">
                        {inputs.map((i) => (
                          <InfoRow key={i.name} label={`Input · ${i.name}`} value={[i.type, i.description].filter(Boolean).join(" — ") || "—"} />
                        ))}
                        {output && <InfoRow label={`Output · ${output.name || ""}`} value={[output.type, output.description].filter(Boolean).join(" — ") || "—"} />}
                      </div>
                    </>
              )}

              {rule.attributes && Object.keys(rule.attributes).length > 0 && (
                <>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mt-4 mb-1">Attributes</p>
                  <div className="border border-gray-100 rounded-xl overflow-hidden px-4">
                    {Object.entries(rule.attributes).map(([k, v]) => <InfoRow key={k} label={k} value={typeof v === "string" ? v : JSON.stringify(v)} />)}
                  </div>
                </>
              )}

              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mt-4 mb-1">Description</p>
              <div className="border border-gray-100 rounded-xl px-4 py-3">
                <p className="text-sm text-gray-600 leading-relaxed">{rule.description || "—"}</p>
              </div>
            </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {editOpen && (
        <ConnectorRuleEditor
          rule={isNew ? null : rule}
          onClose={() => { setEditOpen(false); if (isNew) goBack(); }}
          onSaved={onSaved}
        />
      )}
      {!isNew && editOpen && !rule && <div className="fixed inset-0 flex items-center justify-center"><Spinner size={20} /></div>}
    </div>
  );
}
