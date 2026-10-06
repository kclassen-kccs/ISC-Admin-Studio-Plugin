import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { addObjectMetadata, removeObjectMetadata } from "../lib/sailpoint";
import { MetadataPanel } from "./MetadataPanel";
import { TagMetadataModal } from "./TagMetadataModal";

// The Metadata tab of a role, access profile or entitlement, editable: the
// shared MetadataPanel with its Plus button wired to the shared
// TagMetadataModal (attribute + value picker, ad-hoc value creation), an X on
// each assigned value, and a Remove on each attribute line.
// kind: "roles" | "access-profiles" | "entitlements". invalidateKeys: the
// query keys that hold this object (its detail record and its list).
export function EditableMetadataPanel({ kind, objectId, metadata, invalidateKeys = [] }) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);

  const refresh = () => invalidateKeys.forEach((queryKey) => queryClient.invalidateQueries({ queryKey }));
  const onError = (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 });

  const add = useMutation({
    mutationFn: (sel) => addObjectMetadata(kind, objectId, sel),
    onSuccess: (r) => {
      if (r?.already) toast("It already has that value — nothing changed");
      else toast.success("Metadata added");
      setAddOpen(false);
      refresh();
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: ({ key, value }) => removeObjectMetadata(kind, objectId, key, value),
    onSuccess: () => {
      toast.success("Metadata value removed");
      refresh();
    },
    onError,
  });

  // The per-line Remove: clears the whole attribute from this object by
  // removing each of its assigned values (there's no remove-the-attribute
  // API — assignment exists only as values).
  const removeAttribute = useMutation({
    mutationFn: async (attr) => {
      for (const v of attr.values || []) await removeObjectMetadata(kind, objectId, attr.key, v.value);
      return (attr.values || []).length;
    },
    onSuccess: (n, attr) => {
      toast.success(`Removed "${attr.name || attr.key}" (${n} value${n === 1 ? "" : "s"})`);
      refresh();
    },
    onError: (err) => {
      onError(err);
      refresh(); // partial removals may have landed — show the real state
    },
  });

  return (
    <>
      <MetadataPanel
        metadata={metadata}
        onAdd={() => setAddOpen(true)}
        onRemoveValue={(key, value) => remove.mutate({ key, value })}
        onRemoveAttribute={(attr) => removeAttribute.mutate(attr)}
        removePending={remove.isPending || removeAttribute.isPending}
      />
      {addOpen && (
        <TagMetadataModal count={1} pending={add.isPending} onConfirm={(sel) => add.mutate(sel)} onClose={() => setAddOpen(false)} />
      )}
    </>
  );
}
