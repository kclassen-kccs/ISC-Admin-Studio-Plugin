import { useState } from "react";
import { listIdentities, listSources } from "../lib/sailpoint";
import { Field, Input, Textarea, Select, PrimaryButton, OutlineButton } from "./ui";
import { PickerField } from "./PickerField";

// Create-only dialog for a new Application — prompts for Source (unless
// sourceId is fixed, i.e. opened from a source's own Applications tab),
// Name, Description, Owner, and Specific/All Users. Owner defaults to the
// signed-in user. Editing an existing Application happens on its own detail
// page (ApplicationDetailPage), not in a dialog.
export function ApplicationFormModal({ sourceId, sourceName, currentUser, onSave, onClose, pending }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState(currentUser ? [currentUser] : []);
  const [matchAllAccounts, setMatchAllAccounts] = useState(true);
  const [source, setSource] = useState([]);

  const fixedSourceId = sourceId;
  const effectiveSourceId = fixedSourceId || source[0]?.id;

  const searchIdentities = async (q) => (await listIdentities({ limit: 15, query: q || undefined })).map((i) => ({ id: i.id, name: i.name }));
  const searchSources = async (q) => (await listSources({ limit: 15, query: q || undefined })).map((s) => ({ id: s.id, name: s.name }));

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-3">New Application</h2>

        {fixedSourceId ? (
          <Field label="Source">
            <Input value={sourceName || ""} disabled />
          </Field>
        ) : (
          <PickerField
            label="Source"
            placeholder="Search sources…"
            searchFn={searchSources}
            multi={false}
            selected={source}
            onChange={setSource}
          />
        )}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Application name" autoFocus />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this application for?" />
        </Field>
        <PickerField
          label="Owner"
          placeholder="Search users…"
          searchFn={searchIdentities}
          multi={false}
          selected={owner}
          onChange={setOwner}
        />
        <Field label="Accounts">
          <Select value={matchAllAccounts ? "all" : "specific"} onChange={(e) => setMatchAllAccounts(e.target.value === "all")}>
            <option value="all">All Users</option>
            <option value="specific">Specific Users</option>
          </Select>
        </Field>

        <PrimaryButton
          onClick={() => onSave({ name: name.trim(), description, owner: owner[0], matchAllAccounts, sourceId: effectiveSourceId })}
          loading={pending}
          disabled={!name.trim() || !owner[0] || !effectiveSourceId}
        >
          Create
        </PrimaryButton>
        <OutlineButton onClick={onClose} disabled={pending} className="mt-2">Cancel</OutlineButton>
      </div>
    </div>
  );
}
