import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { listWorkflowLibraryActions, listFormDefinitions } from "../lib/sailpoint";
import { Field, SkeletonList } from "./ui";

// ─── Structured (schema-driven) workflow step editing ───────────────────────
// Renders a step's attributes as typed fields using the action's own input
// schema from GET /workflow-library/actions — labels, help text, required
// flags, and field types verbatim from what SailPoint's builder uses. The
// draft step object is fully controlled by the parent (StepEditorSheet),
// which also owns the JSON tab and the save.

// ISC exposes a step's outputs under a camelCase reference: "HTTP Request"
// -> $.hTTPRequest (verified against a live definition — the first char is
// lowercased AFTER joining, so acronyms keep their tail).
export function camelStepRef(name) {
  const joined = String(name || "").split(/[^A-Za-z0-9]+/).filter(Boolean)
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("");
  return joined ? joined[0].toLowerCase() + joined.slice(1) : "";
}

export function expressionSuggestions(workflow) {
  const out = ["$.trigger.", "$.secrets.", "$.form.input."];
  for (const name of Object.keys(workflow.definition?.steps || {})) {
    out.push(`$.${camelStepRef(name)}.`);
  }
  return out;
}

const INPUT = "w-full border border-gray-200 rounded-xl bg-white px-3 py-2 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-blue-400";
const EXPR = "w-full border border-indigo-200 rounded-xl bg-indigo-50/40 px-3 py-2 text-xs text-indigo-900 font-mono outline-none focus:border-indigo-400";

function FxChip({ on, onClick }) {
  return (
    <button
      type="button"
      title={on ? "Switch to a plain value" : "Switch to an expression ($.stepName…, $.trigger…, $.secrets…)"}
      onClick={onClick}
      className={`ml-auto font-mono text-[10px] font-medium border rounded-md px-1.5 py-0.5 transition-colors ${
        on ? "border-indigo-300 bg-indigo-50 text-indigo-600" : "border-gray-200 text-gray-400 hover:text-gray-600"
      }`}
    >
      ƒx
    </button>
  );
}

// One schema field with the value/expression (.$-key) convention: an
// expression variant of attribute `name` is stored under `name.$`.
function SchemaField({ field, attrs, setAttrs, suggestions, datalistId, forms }) {
  const name = field.name;
  const exprKey = `${name}.$`;
  const isExpr = attrs[exprKey] !== undefined;
  const value = isExpr ? attrs[exprKey] : attrs[name];

  const toggleExpr = () => {
    const next = { ...attrs };
    if (isExpr) {
      delete next[exprKey];
      next[name] = "";
    } else {
      delete next[name];
      next[exprKey] = typeof value === "string" && value.startsWith("$") ? value : "$.";
    }
    setAttrs(next);
  };
  const setValue = (v) => setAttrs({ ...attrs, [isExpr ? exprKey : name]: v });

  const label = (
    <span className="flex items-center gap-1.5 w-full">
      {field.label || name}
      {field.required && <span className="text-red-600">*</span>}
      <FxChip on={isExpr} onClick={toggleExpr} />
    </span>
  );

  let control;
  if (isExpr) {
    control = (
      <input className={EXPR} list={datalistId} value={value ?? ""} onChange={(e) => setValue(e.target.value)} placeholder="$." spellCheck={false} />
    );
  } else {
    switch (field.type) {
      case "select":
      case "multiType":
        control = (
          <select className={INPUT} value={value ?? ""} onChange={(e) => setValue(e.target.value)}>
            <option value="">Choose…</option>
            {(field.options || []).map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        );
        break;
      case "formPicker":
        control = (
          <select className={INPUT} value={value ?? ""} onChange={(e) => setValue(e.target.value)}>
            <option value="">Choose a form…</option>
            {(forms || []).map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </select>
        );
        break;
      case "toggle":
      case "checkbox":
        control = (
          <button
            type="button"
            role="switch"
            aria-checked={value === true || value === "true"}
            onClick={() => setValue(!(value === true || value === "true"))}
            className={`relative w-10 h-6 rounded-full transition-colors ${value === true || value === "true" ? "bg-blue-600" : "bg-gray-300"}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${value === true || value === "true" ? "translate-x-4" : ""}`} />
          </button>
        );
        break;
      case "number":
        control = <input type="number" className={INPUT} value={value ?? ""} onChange={(e) => setValue(e.target.value === "" ? "" : Number(e.target.value))} />;
        break;
      case "textarea":
      case "htmlEditor":
      case "json":
        control = (
          <textarea
            className={INPUT} rows={3} spellCheck={false}
            value={typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : value ?? ""}
            onChange={(e) => setValue(e.target.value)}
          />
        );
        break;
      case "keyValuePairs": {
        const pairs = value && typeof value === "object" && !Array.isArray(value) ? value : {};
        const entries = Object.entries(pairs);
        control = (
          <div className="space-y-1.5">
            {entries.map(([k, v], i) => (
              <div key={i} className="flex gap-1.5 items-center">
                <input
                  className={`${INPUT} !w-2/5 font-mono !text-xs`} value={k} spellCheck={false}
                  onChange={(e) => {
                    const next = {};
                    entries.forEach(([ek, ev], j) => { next[j === i ? e.target.value : ek] = ev; });
                    setValue(next);
                  }}
                />
                <input
                  className={`${INPUT} flex-1 !text-xs`} value={typeof v === "string" ? v : JSON.stringify(v)}
                  onChange={(e) => setValue({ ...pairs, [k]: e.target.value })}
                />
                <button type="button" title="Remove pair" onClick={() => { const next = { ...pairs }; delete next[k]; setValue(next); }} className="text-gray-400 hover:text-red-600">
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setValue({ ...pairs, "": "" })}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
            >
              <Plus size={12} /> Add pair
            </button>
          </div>
        );
        break;
      }
      default:
        // text, url, email, date, duration, secret, pickers we don't have a
        // native control for — a plain text field still beats raw JSON.
        control = <input className={INPUT} value={typeof value === "object" && value !== null ? JSON.stringify(value) : value ?? ""} onChange={(e) => setValue(e.target.value)} spellCheck={false} />;
    }
  }

  // multiType: the chosen option carries its own subfields (e.g. HTTP
  // auth type -> the credentials fields for that auth flavor).
  const selectedOption = field.type === "multiType" && !isExpr
    ? (field.options || []).find((o) => o.value === value)
    : null;

  return (
    <div className="mt-3">
      <Field label={label}>
        {control}
        {field.helpText && <p className="text-[11px] text-gray-400 mt-1 leading-snug">{field.helpText}</p>}
      </Field>
      {selectedOption?.subfields?.length > 0 && (
        <div className="ml-3 pl-3 border-l-2 border-gray-100">
          {selectedOption.subfields.map((sf) => (
            <SchemaField key={sf.name} field={sf} attrs={attrs} setAttrs={setAttrs} suggestions={suggestions} datalistId={datalistId} forms={forms} />
          ))}
        </div>
      )}
    </div>
  );
}

// Every attribute key a schema (including nested option subfields) claims.
function claimedKeys(fields, out = new Set()) {
  for (const f of fields || []) {
    out.add(f.name);
    out.add(`${f.name}.$`);
    for (const o of f.options || []) claimedKeys(o.subfields, out);
  }
  return out;
}

const COMPARATORS = [
  "StringEquals", "StringNotEquals", "StringContains", "StringStartsWith", "StringEndsWith",
  "NumericEquals", "NumericNotEquals", "NumericGreaterThan", "NumericLessThan", "BooleanEquals",
];

function StepPicker({ label, value, onChange, stepNames, allowNone }) {
  return (
    <Field label={label}>
      <select className={INPUT} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        {allowNone && <option value="">— none —</option>}
        {stepNames.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </Field>
  );
}

export function StepFieldsEditor({ workflow, stepName, draft, onChange }) {
  const actionsQuery = useQuery({
    queryKey: ["workflow-library-actions"],
    queryFn: listWorkflowLibraryActions,
    staleTime: Infinity,
  });
  const needsForms = JSON.stringify(
    (actionsQuery.data || []).find((a) => a.id === draft?.actionId)?.formFields || []
  ).includes('"formPicker"');
  const formsQuery = useQuery({
    queryKey: ["form-definitions"],
    queryFn: listFormDefinitions,
    enabled: needsForms,
  });

  const stepNames = Object.keys(workflow.definition?.steps || {}).filter((n) => n !== stepName);
  const suggestions = expressionSuggestions(workflow);
  const datalistId = `expr-suggestions-${stepName.replace(/[^a-zA-Z0-9]/g, "")}`;

  if (actionsQuery.isLoading) return <SkeletonList rows={3} />;

  const schema = (actionsQuery.data || []).find((a) => a.id === draft.actionId);
  const attrs = draft.attributes || {};
  const setAttrs = (attributes) => onChange({ ...draft, attributes });

  const claimed = claimedKeys(schema?.formFields);
  const extraKeys = Object.keys(attrs).filter((k) => !claimed.has(k));

  return (
    <div>
      <datalist id={datalistId}>
        {suggestions.map((sg) => (
          <option key={sg} value={sg} />
        ))}
      </datalist>

      {draft.type === "choice" ? (
        <>
          {(draft.choiceList || []).map((c, i) => (
            <div key={i} className="border border-gray-100 rounded-xl p-3 mt-3">
              <Field label="Compare (expression)">
                <input
                  className={EXPR}
                  list={datalistId}
                  value={c.variableA ?? ""}
                  spellCheck={false}
                  onChange={(e) => {
                    const list = draft.choiceList.map((x, j) => (j === i ? { ...x, variableA: e.target.value } : x));
                    onChange({ ...draft, choiceList: list });
                  }}
                />
              </Field>
              <div className="flex gap-1.5 mt-2">
                <select
                  className={`${INPUT} !w-1/2 !text-xs`}
                  value={c.comparator || ""}
                  onChange={(e) => {
                    const list = draft.choiceList.map((x, j) => (j === i ? { ...x, comparator: e.target.value } : x));
                    onChange({ ...draft, choiceList: list });
                  }}
                >
                  {COMPARATORS.map((op) => (
                    <option key={op} value={op}>{op}</option>
                  ))}
                </select>
                <input
                  className={`${INPUT} flex-1 !text-xs`}
                  value={c.variableB ?? ""}
                  onChange={(e) => {
                    const list = draft.choiceList.map((x, j) => (j === i ? { ...x, variableB: e.target.value } : x));
                    onChange({ ...draft, choiceList: list });
                  }}
                />
              </div>
              <div className="mt-2">
                <StepPicker
                  label="Then go to"
                  value={c.nextStep}
                  onChange={(v) => {
                    const list = draft.choiceList.map((x, j) => (j === i ? { ...x, nextStep: v } : x));
                    onChange({ ...draft, choiceList: list });
                  }}
                  stepNames={stepNames}
                  allowNone
                />
              </div>
            </div>
          ))}
          <div className="mt-3">
            <StepPicker label="Otherwise" value={draft.defaultStep} onChange={(v) => onChange({ ...draft, defaultStep: v })} stepNames={stepNames} allowNone />
          </div>
        </>
      ) : schema ? (
        <>
          {formsQuery.isLoading && needsForms && <SkeletonList rows={1} />}
          {schema.formFields.map((f) => (
            <SchemaField key={f.name} field={f} attrs={attrs} setAttrs={setAttrs} suggestions={suggestions} datalistId={datalistId} forms={formsQuery.data} />
          ))}
        </>
      ) : (
        <p className="text-xs text-gray-400 mt-2">
          No input schema is published for this step type — use the Additional attributes below or the JSON tab.
        </p>
      )}

      {draft.type !== "choice" && extraKeys.length > 0 && (
        <>
          <p className="text-[10.5px] font-semibold uppercase tracking-wide text-gray-400 mt-5 mb-1">Additional attributes</p>
          {extraKeys.map((k) => {
            const v = attrs[k];
            const isObj = v !== null && typeof v === "object";
            return (
              <div key={k} className="flex gap-1.5 items-center mt-1.5">
                <span className="font-mono text-[11px] text-gray-500 w-2/5 truncate flex-shrink-0" title={k}>{k}</span>
                {isObj ? (
                  <span className="text-[11px] text-gray-400 italic truncate">object — edit in the JSON tab</span>
                ) : (
                  <input
                    className={k.endsWith(".$") || String(v).startsWith("$") ? EXPR : `${INPUT} !text-xs`}
                    list={datalistId}
                    value={v ?? ""}
                    spellCheck={false}
                    onChange={(e) => setAttrs({ ...attrs, [k]: e.target.value })}
                  />
                )}
              </div>
            );
          })}
        </>
      )}

      {draft.type !== "choice" && (
        <div className="mt-4">
          <StepPicker label="Next step" value={draft.nextStep} onChange={(v) => onChange({ ...draft, nextStep: v })} stepNames={stepNames} allowNone />
        </div>
      )}
    </div>
  );
}
