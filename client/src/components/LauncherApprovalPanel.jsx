import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { getLauncherEntitlement } from "../lib/sailpoint";
import { ApprovalSettingsPanel } from "./ApprovalSettingsPanel";
import { SkeletonList, ErrorBox, EmptyState, OutlineButton } from "./ui";

// ─── Launcher → Approval ─────────────────────────────────────────────────────
// A launcher is granted through its entitlement (ISC creates one per
// launcher), so "who approves a launcher" is that entitlement's approval
// settings — the shared ApprovalSettingsPanel, pointed at it.
export function LauncherApprovalPanel({ launcherId }) {
  const entQ = useQuery({ queryKey: ["launcher-entitlement", launcherId], queryFn: () => getLauncherEntitlement(launcherId), staleTime: 60_000 });
  const entitlement = entQ.data?.entitlement || null;

  if (entQ.isLoading) return <div className="px-4 py-4"><SkeletonList rows={4} /></div>;
  if (entQ.error) return <div className="px-4 py-4"><ErrorBox message={entQ.error.response?.data?.error || entQ.error.message} onRetry={entQ.refetch} /></div>;
  if (!entitlement) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No entitlement yet"
        subtitle="Approvals are set on the launcher's entitlement, which ISC creates a few minutes after the launcher. Check back shortly."
        action={<div className="mt-3"><OutlineButton onClick={() => entQ.refetch()} className="!w-auto">Check again</OutlineButton></div>}
      />
    );
  }
  return (
    <ApprovalSettingsPanel
      kind="entitlement"
      object={entitlement}
      invalidateKeys={[["launcher-entitlement", launcherId]]}
      intro={`Approvals for "${entitlement.displayName || entitlement.name}" — the entitlement users request to get this launcher in their Launchpad.`}
    />
  );
}
