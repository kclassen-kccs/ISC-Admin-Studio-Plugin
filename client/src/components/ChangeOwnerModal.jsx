import { useState } from "react";
import { X, UserCog } from "lucide-react";
import { listIdentities } from "../lib/sailpoint";
import { PickerField } from "./PickerField";
import { PrimaryButton, OutlineButton } from "./ui";

const searchIdentities = async (q) =>
  (await listIdentities({ limit: 15, query: q || undefined })).map((i) => ({ id: i.id, name: i.name }));

// Shared by RolesPage and AccessProfilesPage's "Change Owner" bulk action —
// a single-pick identity search (same PickerField CreateAccessProfileModal's
// own Owner field already uses) plus a confirm button, with an optional
// bulk-progress line while the caller's mutation is running.
export function ChangeOwnerModal({ count, onConfirm, onClose, pending, progressText }) {
  const [owner, setOwner] = useState([]);

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-md md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
              <UserCog size={18} className="text-blue-600" />
            </div>
            <h2 className="text-base font-semibold text-gray-900">
              Change Owner{count ? ` (${count})` : ""}
            </h2>
          </div>
          <button onClick={onClose} disabled={pending} className="text-gray-400 hover:text-gray-600 disabled:opacity-50">
            <X size={18} />
          </button>
        </div>

        <PickerField
          label="New Owner"
          placeholder="Search users…"
          searchFn={searchIdentities}
          multi={false}
          selected={owner}
          onChange={setOwner}
        />

        {pending && progressText && (
          <p className="text-xs text-gray-500 mb-3">{progressText}</p>
        )}

        <div className="flex gap-2">
          <PrimaryButton onClick={() => onConfirm(owner[0])} loading={pending} disabled={!owner[0]}>
            Change Owner
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending}>
            Cancel
          </OutlineButton>
        </div>
      </div>
    </div>
  );
}
