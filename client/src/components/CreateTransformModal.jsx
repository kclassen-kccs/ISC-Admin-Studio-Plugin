import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, ChevronLeft } from "lucide-react";
import toast from "react-hot-toast";
import { createTransform } from "../lib/sailpoint";
import { PrimaryButton, OutlineButton } from "./ui";
import { jsonParseError } from "./JsonEditor";
import { JsonEditTabs } from "./JsonTree";

// The documented operation catalog
// (developer.sailpoint.com/docs/extensibility/transforms/operations), each
// with a starter template mirroring that page's own JSON examples. Rule-
// based utility operations are listed as their own entries since their
// JSON shape differs from a plain type.
const TRANSFORM_TEMPLATES = [
  { label: "Account Attribute", template: { name: "My Account Attribute Transform", type: "accountAttribute", attributes: { sourceName: "Source Name", attributeName: "attribute_name" } } },
  { label: "Base64 Decode", template: { name: "My Base64 Decode Transform", type: "base64Decode", attributes: {} } },
  { label: "Base64 Encode", template: { name: "My Base64 Encode Transform", type: "base64Encode", attributes: {} } },
  { label: "Concatenation", template: { name: "My Concat Transform", type: "concat", attributes: { values: [{ type: "identityAttribute", attributes: { name: "firstname" } }, " ", { type: "identityAttribute", attributes: { name: "lastname" } }] } } },
  { label: "Conditional", template: { name: "My Conditional Transform", type: "conditional", attributes: { expression: "$compare eq true", compare: "true", positiveCondition: "yes", negativeCondition: "no" } } },
  { label: "Date Compare", template: { name: "My Date Compare Transform", type: "dateCompare", attributes: { firstDate: { type: "accountAttribute", attributes: { sourceName: "Source Name", attributeName: "termination_date" } }, secondDate: "now", operator: "GT", positiveCondition: "active", negativeCondition: "terminated" } } },
  { label: "Date Format", template: { name: "My Date Format Transform", type: "dateFormat", attributes: { inputFormat: "M/d/yyyy", outputFormat: "yyyy-MM-dd" } } },
  { label: "Date Math", template: { name: "My Date Math Transform", type: "dateMath", attributes: { expression: "now+1w", roundUp: false } } },
  { label: "Decompose Diacritical Marks", template: { name: "My Decompose Diacritical Marks Transform", type: "decomposeDiacriticalMarks", attributes: {} } },
  { label: "E.164 Phone", template: { name: "My E164 Phone Transform", type: "e164phone", attributes: { defaultRegion: "US" } } },
  { label: "First Valid", template: { name: "My First Valid Transform", type: "firstValid", attributes: { values: [{ type: "accountAttribute", attributes: { sourceName: "Source Name", attributeName: "email" } }, { type: "identityAttribute", attributes: { name: "email" } }, "default@example.com"], ignoreErrors: false } } },
  { label: "Identity Attribute", template: { name: "My Identity Attribute Transform", type: "identityAttribute", attributes: { name: "email" } } },
  { label: "Index Of", template: { name: "My Index Of Transform", type: "indexOf", attributes: { substring: "@" } } },
  { label: "ISO3166", template: { name: "My ISO3166 Transform", type: "iso3166", attributes: { format: "alpha2" } } },
  { label: "Last Index Of", template: { name: "My Last Index Of Transform", type: "lastIndexOf", attributes: { substring: "." } } },
  { label: "Left Pad", template: { name: "My Left Pad Transform", type: "leftPad", attributes: { length: "8", padding: "0" } } },
  { label: "Lookup", template: { name: "My Lookup Transform", type: "lookup", attributes: { table: { key1: "value1", key2: "value2", default: "defaultValue" } } } },
  { label: "Lower", template: { name: "My Lower Transform", type: "lower", attributes: {} } },
  { label: "Name Normalizer", template: { name: "My Name Normalizer Transform", type: "nameNormalizer", attributes: {} } },
  { label: "Reference", template: { name: "My Reference Transform", type: "reference", attributes: { id: "Existing Transform Name" } } },
  { label: "Replace", template: { name: "My Replace Transform", type: "replace", attributes: { regex: "[^a-zA-Z]", replacement: "" } } },
  { label: "Replace All", template: { name: "My Replace All Transform", type: "replaceAll", attributes: { table: { "-": " ", "\"": "'" } } } },
  { label: "RFC5646", template: { name: "My RFC5646 Transform", type: "rfc5646", attributes: {} } },
  { label: "Right Pad", template: { name: "My Right Pad Transform", type: "rightPad", attributes: { length: "8", padding: "0" } } },
  { label: "Split", template: { name: "My Split Transform", type: "split", attributes: { delimiter: ",", index: 0 } } },
  { label: "Static", template: { name: "My Static Transform", type: "static", attributes: { value: "Fixed value" } } },
  { label: "Substring", template: { name: "My Substring Transform", type: "substring", attributes: { begin: 0, end: 3 } } },
  { label: "Trim", template: { name: "My Trim Transform", type: "trim", attributes: {} } },
  { label: "Upper", template: { name: "My Upper Transform", type: "upper", attributes: {} } },
  { label: "UUID Generator", template: { name: "My UUID Transform", type: "uuid", attributes: {} } },
  { label: "Username Generator", template: { name: "My Username Generator Transform", type: "usernameGenerator", attributes: { sourceCheck: true, patterns: ["$fi.$ln${uniqueCounter}"], fi: { type: "identityAttribute", attributes: { name: "firstname" } }, ln: { type: "identityAttribute", attributes: { name: "lastname" } } } } },
  { label: "Get End of String (rule)", template: { name: "My Get End Of String Transform", type: "rule", attributes: { name: "Cloud Services Deployment Utility", operation: "getEndOfString", numChars: "4" } } },
  { label: "Generate Random String (rule)", template: { name: "My Generate Random String Transform", type: "rule", attributes: { name: "Cloud Services Deployment Utility", operation: "generateRandomString", includeNumbers: "true", includeSpecialChars: "true", length: "16" } } },
  { label: "Random Alphanumeric (rule)", template: { name: "My Random Alphanumeric Transform", type: "rule", attributes: { name: "Cloud Services Deployment Utility", operation: "randomAlphaNumeric", length: "32" } } },
  { label: "Random Numeric (rule)", template: { name: "My Random Numeric Transform", type: "rule", attributes: { name: "Cloud Services Deployment Utility", operation: "randomNumeric", length: "32" } } },
  { label: "Get Reference Identity Attribute (rule)", template: { name: "My Get Reference Identity Attribute Transform", type: "rule", attributes: { name: "Cloud Services Deployment Utility Rule", operation: "getReferenceIdentityAttribute", uid: "manager", attributeName: "email" } } },
];

// Two-step create: pick the operation type, then edit its starter JSON
// (same validated editor as everywhere else) and create.
export function CreateTransformModal({ onClose, onCreated }) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState(null); // entry from TRANSFORM_TEMPLATES
  const [text, setText] = useState("");
  const parseError = picked ? jsonParseError(text) : null;

  const create = useMutation({
    mutationFn: () => createTransform(JSON.parse(text)),
    onSuccess: (created) => {
      toast.success(`Transform "${created?.name || "created"}" created`);
      queryClient.invalidateQueries({ queryKey: ["transforms"] });
      onCreated?.(created);
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.messages?.[0]?.text || err.response?.data?.error || err.message),
  });

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !create.isPending && onClose()}
    >
      <div className="bg-white w-full max-w-2xl md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[85vh] overflow-y-auto p-5">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2 min-w-0">
            {picked && (
              <button
                onClick={() => setPicked(null)}
                disabled={create.isPending}
                className="text-gray-400 hover:text-gray-600 flex-shrink-0"
                title="Back to type list"
              >
                <ChevronLeft size={18} />
              </button>
            )}
            <h2 className="text-base font-semibold text-gray-900 truncate">
              {picked ? `New ${picked.label} transform` : "New Transform"}
            </h2>
          </div>
          <button onClick={onClose} disabled={create.isPending} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
            <X size={18} />
          </button>
        </div>

        {!picked ? (
          <>
            <p className="text-xs text-gray-400 mb-3">
              Pick the operation type — the editor opens with that type's starter template.
            </p>
            <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100 max-h-[55vh] overflow-y-auto">
              {TRANSFORM_TEMPLATES.map((entry) => (
                <button
                  key={entry.label}
                  onClick={() => {
                    setPicked(entry);
                    setText(JSON.stringify(entry.template, null, 2));
                  }}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-gray-50 active:bg-gray-100"
                >
                  <span className="text-sm text-gray-900">{entry.label}</span>
                  <span className="text-xs text-gray-400 font-mono">
                    {entry.template.type === "rule" ? `rule · ${entry.template.attributes.operation}` : entry.template.type}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-gray-400 mb-3">
              Edit the template — set a unique name and fill in the attributes, then Create.
            </p>
            <JsonEditTabs text={text} onChange={setText} minHeight="240px" />
            {parseError ? (
              <p className="text-xs text-red-600 mt-2">Invalid JSON: {parseError}</p>
            ) : (
              <p className="text-xs text-emerald-600 mt-2">Valid JSON</p>
            )}
            <div className="flex gap-2 mt-3">
              <PrimaryButton onClick={() => create.mutate()} loading={create.isPending} disabled={!!parseError} className="!w-auto flex-1">
                Create
              </PrimaryButton>
              <OutlineButton onClick={onClose} disabled={create.isPending} className="!w-auto flex-1">
                Cancel
              </OutlineButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
