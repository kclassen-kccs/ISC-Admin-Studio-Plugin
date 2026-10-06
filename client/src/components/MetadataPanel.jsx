import { Tags, Plus, X } from "lucide-react";
import { EmptyState, IconButton } from "./ui";

// Access Model Metadata assigned to one access item (role / access
// profile / entitlement) — rendered from the record's own
// accessModelMetadata field, which every object GET carries inline
// ({ attributes: [] } when nothing is assigned; verified live).
//
// Editing is opt-in via props: `onAdd` renders a header Plus button
// (the owner screen supplies its own add dialog), and `onRemoveValue`
// puts an X on each value pill.
export function MetadataPanel({ metadata, onAdd, onRemoveValue, onRemoveAttribute, removePending }) {
  const attributes = metadata?.attributes || [];

  const addButton = onAdd ? (
    <div className="flex items-center justify-between px-4 pt-3">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Metadata</p>
      <IconButton icon={Plus} title="Add metadata" onClick={onAdd} />
    </div>
  ) : null;

  if (attributes.length === 0) {
    return (
      <div>
        {addButton}
        <EmptyState
          icon={Tags}
          title="No metadata"
          subtitle="No Access Model Metadata attributes are assigned to this item"
        />
      </div>
    );
  }

  return (
    <div>
      {addButton}
      <div className="px-4 py-4 space-y-3">
        {attributes.map((attr) => (
          <div key={attr.key} className="border border-gray-100 rounded-xl p-4">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <p className="text-sm font-semibold text-gray-900">{attr.name || attr.key}</p>
              {onRemoveAttribute && (
                <button
                  type="button"
                  title="Remove this attribute (all its assigned values) from this item"
                  disabled={removePending}
                  onClick={() => onRemoveAttribute(attr)}
                  className="ml-auto inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-red-50 text-red-600 border-red-200 hover:bg-red-100 disabled:opacity-40 flex-shrink-0"
                >
                  <X size={11} />
                  Remove
                </button>
              )}
              {attr.name && attr.key && attr.name !== attr.key && (
                <span className="text-xs text-gray-400 font-mono">{attr.key}</span>
              )}
              {attr.type && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-gray-50 text-gray-500 border-gray-200">
                  {attr.type}
                </span>
              )}
              {attr.multiselect && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200">
                  multi-value
                </span>
              )}
            </div>
            {attr.description && (
              <p className="text-xs text-gray-500 mb-2">{attr.description}</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {(attr.values || []).map((v) => (
                <span
                  key={v.value}
                  title={v.value !== v.name ? `Technical name: ${v.value}` : undefined}
                  className="inline-flex items-center gap-1 text-xs bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-100 px-2 py-1 rounded-full"
                >
                  {v.name || v.value}
                  {onRemoveValue && (
                    <button
                      type="button"
                      title="Remove this value"
                      disabled={removePending}
                      onClick={() => onRemoveValue(attr.key, v.value)}
                      className="text-fuchsia-400 hover:text-fuchsia-700 disabled:opacity-40"
                    >
                      <X size={11} />
                    </button>
                  )}
                </span>
              ))}
              {(attr.values || []).length === 0 && (
                <span className="text-xs text-gray-400 italic">No values assigned</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
