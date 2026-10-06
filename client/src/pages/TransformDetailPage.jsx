import { useMemo, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FunctionSquare, Info, Braces, Pencil, FlaskConical, Play } from "lucide-react";
import toast from "react-hot-toast";
import { getTransform, updateTransform, listTransforms, fetchAllPages } from "../lib/sailpoint";
import { collectTransformInputs, evaluateTransform } from "../lib/transformEval";
import { useUrlState } from "../hooks/useUrlState";
import { TopBar } from "../components/TopBar";
import {
  InfoRow, SkeletonList, ErrorBox, IconButton, PrimaryButton, OutlineButton, Field, Input,
} from "../components/ui";
import { JSON_EDITOR_STYLE, highlightJson, escapeHtml, jsonParseError } from "../components/JsonEditor";
import { JsonEditTabs } from "../components/JsonTree";

const SECTIONS = [
  { key: "details", label: "Details", Icon: Info },
  { key: "json", label: "JSON", Icon: Braces },
  { key: "test", label: "Test", Icon: FlaskConical },
];

// ISC's PUT /transforms/{id} takes { name, type, attributes } and treats
// name/type as immutable — id/internal are read-only and stripped.
const EDITABLE_TRANSFORM_FIELDS = ["name", "type", "attributes"];

// Same view/edit contract as the Workflow JSON tab — highlighted view,
// live-validated overlay editor, Save disabled while invalid.
function JsonPanel({ data, transformId }) {
  const queryClient = useQueryClient();
  const pretty = useMemo(() => JSON.stringify(data, null, 2), [data]);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(pretty);
  const parseError = editing ? jsonParseError(text) : null;

  const save = useMutation({
    mutationFn: () => {
      const parsed = JSON.parse(text);
      const body = {};
      for (const key of EDITABLE_TRANSFORM_FIELDS) {
        if (parsed[key] !== undefined) body[key] = parsed[key];
      }
      return updateTransform(transformId, body);
    },
    onSuccess: () => {
      toast.success("Transform saved");
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["transform", transformId] });
      queryClient.invalidateQueries({ queryKey: ["transforms"] });
    },
    onError: (err) => toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message),
  });

  return (
    <div className="px-4 py-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs text-gray-500">
          {editing
            ? "id/internal are ignored on save; ISC treats name and type as immutable."
            : "The transform's full definition as ISC returns it."}
        </p>
        {!editing ? (
          <IconButton icon={Pencil} title="Edit JSON" onClick={() => { setText(pretty); setEditing(true); }} />
        ) : null}
      </div>

      {!editing ? (
        <pre
          className="border border-gray-200 rounded-xl overflow-auto text-gray-800 bg-gray-50"
          style={JSON_EDITOR_STYLE}
          dangerouslySetInnerHTML={{ __html: highlightJson(escapeHtml(pretty)) }}
        />
      ) : (
        <>
          <JsonEditTabs text={text} onChange={setText} minHeight="240px" title={`${data?.name || transformId} — transform`} />
          <div className="flex gap-2 mt-3">
            <PrimaryButton onClick={() => save.mutate()} loading={save.isPending} disabled={!!parseError} className="!w-auto flex-1">
              Save
            </PrimaryButton>
            <OutlineButton onClick={() => setEditing(false)} disabled={save.isPending} className="!w-auto flex-1">
              Cancel
            </OutlineButton>
          </div>
        </>
      )}
    </div>
  );
}

// One-line explanations of what each operation type does, from SailPoint's
// own transform-operations catalog
// (developer.sailpoint.com/docs/extensibility/transforms/operations).
const TYPE_DESCRIPTIONS = {
  accountAttribute: "Looks up an account attribute for a particular source on an identity.",
  base64Decode: "Renders base64 data in its original format.",
  base64Encode: "Encodes data with a Base64-based text encoding scheme.",
  concat: "Joins two or more string values into a combined output.",
  conditional: "Outputs different values depending on simple conditional logic.",
  dateCompare: "Compares two dates and returns a value based on which is earlier or later.",
  dateFormat: "Converts datetime strings from one format to another.",
  dateMath: "Adds, subtracts, and rounds components of a timestamp's incoming value.",
  decomposeDiacriticalMarks: "Cleans or standardizes accented symbols used within language.",
  displayName: "Builds an identity's display name, preferring Preferred Name over Given Name.",
  e164phone: "Converts a phone number string into an E.164-compatible number.",
  firstValid: "Returns the first of its values that is not null or empty.",
  identityAttribute: "Gets a user's identity attribute value.",
  indexOf: "Gets the location of a specific substring within a value.",
  lastIndexOf: "Gets the last location of a specific substring within a value.",
  iso3166: "Converts a string into an ISO 3166 country code value.",
  leftPad: "Pads the left of the input string to a desired length.",
  rightPad: "Pads the right of the input string to a desired length.",
  lookup: "Looks up the input in a table and returns the matching value.",
  lower: "Converts an input string into all lowercase letters.",
  upper: "Converts an input string into all uppercase letters.",
  trim: "Trims whitespace from the beginning and end of the input.",
  nameNormalizer: "Cleans or standardizes the spelling of names coming from source systems.",
  reference: "Reuses a transform that has already been written.",
  replace: "Finds and replaces all instances of a single pattern.",
  replaceAll: "Finds and replaces all instances of every pattern in its table.",
  rfc5646: "Converts a language abbreviation into an RFC 5646 language tag.",
  split: "Splits the input on a delimiter and returns the Nth element.",
  static: "Returns a fixed value, optionally built from variables.",
  substring: "Gets an inner portion of the string passed into the transform.",
  usernameGenerator: "Derives a unique value for an account create profile attribute.",
  uuid: "Creates a universally unique ID (UUID).",
};

const RULE_OPERATION_DESCRIPTIONS = {
  getEndOfString: "Gets the rightmost N characters of a string (Cloud Services Deployment Utility rule).",
  generateRandomString: "Generates a random string of any length, optionally with numbers and special characters.",
  randomAlphaNumeric: "Generates a random alphanumeric string of any length.",
  randomNumeric: "Generates a random number of any length.",
  getReferenceIdentityAttribute: "Gets another user's identity attribute (e.g. the manager's).",
};

function describeTransformType(transform) {
  if (transform.type === "rule") {
    const op = transform.attributes?.operation;
    return (
      RULE_OPERATION_DESCRIPTIONS[op] ||
      `Runs reusable rule logic${op ? ` ("${op}")` : ""} — custom rules execute server-side in ISC.`
    );
  }
  return TYPE_DESCRIPTIONS[transform.type] || "An operation type this app doesn't have a description for.";
}

// Local test harness: the definition is walked for what it reads (implicit
// input, account/identity attributes, referenced transforms), each becomes
// a prompt, and Run evaluates the transform in the browser — ISC has no
// public evaluate endpoint, so unsupported step types fail with a clear
// message instead of a wrong answer.
function TestPanel({ transform }) {
  const transformsQuery = useQuery({
    queryKey: ["transforms"],
    queryFn: () => fetchAllPages((page) => listTransforms(page)),
  });
  const transformsByName = useMemo(
    () => new Map((transformsQuery.data || []).map((t) => [t.name, t])),
    [transformsQuery.data]
  );
  const inputs = useMemo(
    () => collectTransformInputs(transform, transformsByName),
    [transform, transformsByName]
  );

  const [values, setValues] = useState({});
  const [outcome, setOutcome] = useState(null); // { result, notes } | { error }

  function run() {
    try {
      const map = new Map(Object.entries(values));
      const { result, notes } = evaluateTransform(transform, map, transformsByName);
      setOutcome({ result, notes });
    } catch (err) {
      setOutcome({ error: err.message });
    }
  }

  return (
    <div className="px-4 py-4">
      <div className="border border-fuchsia-100 bg-fuchsia-50 rounded-xl px-4 py-3 mb-4">
        <p className="text-xs font-semibold text-fuchsia-700 uppercase tracking-wide mb-0.5">
          {transform.type === "rule" && transform.attributes?.operation
            ? `rule · ${transform.attributes.operation}`
            : transform.type}
        </p>
        <p className="text-sm text-fuchsia-900">{describeTransformType(transform)}</p>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Inputs below were discovered from the transform's logic. Values are evaluated locally — nothing is
        written to ISC.
      </p>

      {inputs.map(({ key, label }) => (
        <Field key={key} label={label}>
          <Input
            value={values[key] ?? ""}
            onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
            placeholder="Value"
          />
        </Field>
      ))}

      <PrimaryButton onClick={run}>
        <Play size={16} />
        Run
      </PrimaryButton>

      {outcome && (
        <div className="mt-4">
          {outcome.error ? (
            <div className="border border-red-200 bg-red-50 rounded-xl px-4 py-3">
              <p className="text-xs font-semibold text-red-700 uppercase tracking-wide mb-1">Error</p>
              <p className="text-sm text-red-700">{outcome.error}</p>
            </div>
          ) : (
            <div className="border border-emerald-200 bg-emerald-50 rounded-xl px-4 py-3">
              <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-1">Result</p>
              <p className="text-sm text-emerald-900 font-mono break-all">
                {outcome.result === null || outcome.result === "" ? <span className="italic">(empty)</span> : String(outcome.result)}
              </p>
            </div>
          )}
          {outcome.notes?.length > 0 && (
            <div className="mt-2">
              {outcome.notes.map((n) => (
                <p key={n} className="text-xs text-amber-700">{n}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TransformDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [section, setSection] = useUrlState("tab", "details");

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["transform", id],
    queryFn: () => getTransform(id),
  });

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar title="Transform" onBack={() => navigate(-1)} />
      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading && <SkeletonList rows={6} />}
        {error && <ErrorBox message={error.message} onRetry={refetch} />}

        {data && (
          <>
            <div className="px-4 py-4 flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-fuchsia-50 flex items-center justify-center flex-shrink-0">
                <FunctionSquare size={20} className="text-fuchsia-700" />
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-base font-semibold text-gray-900 truncate">{data.name}</h2>
                <p className="text-xs text-gray-500 mt-0.5">{data.type}</p>
              </div>
            </div>

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
                {section === "details" && (
                  <div className="px-4 py-4">
                    <div className="border border-gray-100 rounded-xl overflow-hidden px-3">
                      <InfoRow label="Name" value={data.name} />
                      <InfoRow label="Type" value={data.type} />
                      <InfoRow label="Internal" value={data.internal != null ? String(data.internal) : undefined} />
                      <InfoRow label="Transform ID" value={data.id} />
                    </div>
                  </div>
                )}
                {section === "json" && <JsonPanel data={data} transformId={id} />}
                {section === "test" && <TestPanel transform={data} />}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
