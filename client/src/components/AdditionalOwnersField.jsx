import { PickerField } from "./PickerField";
import { Field } from "./ui";
import { listIdentities, listGovernanceGroups } from "../lib/sailpoint";

// Additional owners, as Role edit does it: several users OR one governance
// group — a radio choice, never mixed (the server routes enforce the same
// rule). Shared by the Role, Access Profile and Source edit dialogs.
//
// State lives in the parent as { mode: "users" | "group", users: [{id,name}],
// group: [{id,name}] } — build it with additionalOwnersState() and turn it
// back into ISC's shape with additionalOwnersValue().

export function additionalOwnersState(list) {
  const owners = list || [];
  const group = owners.find((o) => o.type === "GOVERNANCE_GROUP");
  return group
    ? { mode: "group", users: [], group: [{ id: group.id, name: group.name }] }
    : { mode: "users", users: owners.map((o) => ({ id: o.id, name: o.name })), group: [] };
}

export function additionalOwnersValue({ mode, users, group }) {
  return mode === "group"
    ? group.map((g) => ({ type: "GOVERNANCE_GROUP", id: g.id, name: g.name }))
    : users.map((u) => ({ type: "IDENTITY", id: u.id, name: u.name }));
}

export function additionalOwnersChanged(next, current) {
  const cur = current || [];
  return next.length !== cur.length || next.some((o, i) => o.id !== cur[i]?.id || o.type !== cur[i]?.type);
}

// Read-only display: "Jane Doe, John Roe" or "Group: Finance Approvers".
export function formatAdditionalOwners(list) {
  const owners = list || [];
  if (owners.length === 0) return undefined;
  return owners.map((o) => (o.type === "GOVERNANCE_GROUP" ? `Group: ${o.name}` : o.name)).join(", ");
}

const searchIdentities = async (q) => (await listIdentities({ limit: 15, query: q || undefined })).map((i) => ({ id: i.id, name: i.name }));
const searchGroups = async (q) => (await listGovernanceGroups({ limit: 15, query: q || undefined })).map((g) => ({ id: g.id, name: g.name }));

// groupOnly: the object can only take a governance group (a Source's
// management workgroup), so the Users choice is hidden.
export function AdditionalOwnersField({ label = "Additional owners", value, onChange, help, groupOnly = false }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <Field label={label}>
      {!groupOnly && <div className="flex gap-4 mb-2">
        <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
          <input type="radio" checked={value.mode === "users"} onChange={() => set({ mode: "users" })} className="accent-blue-600" />
          Users
        </label>
        <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
          <input type="radio" checked={value.mode === "group"} onChange={() => set({ mode: "group" })} className="accent-blue-600" />
          Governance group
        </label>
      </div>}
      {value.mode === "users" && !groupOnly ? (
        <PickerField label="" cacheKey="additional-owner-users" placeholder="Search users…" searchFn={searchIdentities} multi selected={value.users} onChange={(users) => set({ users })} />
      ) : (
        <PickerField label="" cacheKey="additional-owner-group" placeholder="Search governance groups…" searchFn={searchGroups} multi={false} selected={value.group} onChange={(group) => set({ group })} />
      )}
      {help && <p className="text-xs text-gray-400 -mt-2">{help}</p>}
    </Field>
  );
}
