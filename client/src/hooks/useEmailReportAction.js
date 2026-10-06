import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { getCredentials, getIdentityEmail, createRoleReport, saveReport } from "../lib/sailpoint";

/**
 * Shared by every list's "Email Report" bulk action (Roles, Entitlements,
 * Access Profiles, Sources) — groups the selected items by owner, builds
 * one combined detail-report PDF per owner (via the caller's own
 * `buildDetailPdfBase64`, since only the caller knows how to enrich/render
 * its own object type), hosts it (createRoleReport — a generic,
 * resource-agnostic report host despite the name), and prepares a mailto:
 * link. Nothing is ever auto-sent — see EmailReportDialog, which is what
 * actually opens each mailto: link, one user click at a time.
 *
 * `objectLabel` is the singular display name ("Role", "Entitlement",
 * "Access Profile", "Source") — used for the subject line
 * ("{objectLabel} Report for {Owner}"), the filename, and the email body.
 * `itemLabel(item)` returns the display name for one item (roles/access
 * profiles/sources use `.name`; entitlements fall back to `.value` when
 * `.name` is a raw synced attribute). `onDone` (optional) runs once the
 * dialog/no-op outcome is settled — every caller uses it to clear its own
 * `selected` Set, which this hook has no access to itself.
 */
export function useEmailReportAction({ objectLabel, buildDetailPdfBase64, itemLabel, onDone }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dialog, setDialog] = useState(null);

  const mutation = useMutation({
    mutationFn: async (selectedItems) => {
      const byOwner = new Map(); // ownerId -> { owner, items: [] }
      const skippedNoOwner = [];
      for (const item of selectedItems) {
        if (!item.owner?.id) {
          skippedNoOwner.push({ id: item.id, name: itemLabel(item) });
          continue;
        }
        if (!byOwner.has(item.owner.id)) byOwner.set(item.owner.id, { owner: item.owner, items: [] });
        byOwner.get(item.owner.id).items.push(item);
      }

      const tenant = getCredentials()?.tenant;
      const prepared = [];
      const noEmailOwners = [];
      const otherErrors = [];
      for (const { owner, items } of byOwner.values()) {
        try {
          const [pdfBase64, { email }] = await Promise.all([
            buildDetailPdfBase64({ tenant, items }),
            getIdentityEmail(owner.id),
          ]);
          if (!email) {
            noEmailOwners.push({ ownerId: owner.id, ownerName: owner.name, count: items.length, items: items.map(itemLabel) });
            continue;
          }
          const filename = `${owner.name} ${objectLabel} Report.pdf`;
          const { url } = await createRoleReport({ filename, pdfBase64 });
          // A personal copy for the sender's own "My Reports" list — best
          // effort, since the email link below is the actual point of this
          // action and shouldn't fail over a save that's just a convenience.
          saveReport({ filename, title: `${objectLabel} Report for ${owner.name}`, pdfBase64 }).catch(() => {});
          const label = objectLabel.toLowerCase();
          const subject = `${objectLabel} Report for ${owner.name}`;
          const body =
            `Attached is a link to a ${objectLabel} report covering ${items.length} ${label}${items.length === 1 ? "" : "s"} you own:\n\n` +
            `${items.map((it) => `- ${itemLabel(it)}`).join("\n")}\n\n` +
            `View the full report: ${url}\n` +
            `(This link will be available for 2 weeks.)`;
          const mailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
          prepared.push({ ownerId: owner.id, ownerName: owner.name, count: items.length, reportUrl: url, mailto, sent: false, filename, pdfBase64 });
        } catch (err) {
          otherErrors.push({ ownerId: owner.id, ownerName: owner.name, error: err.response?.data?.error || err.message, count: items.length });
        }
      }

      return { prepared, noEmailOwners, otherErrors, skippedNoOwner };
    },
    onSuccess: ({ prepared, noEmailOwners, otherErrors, skippedNoOwner }) => {
      if (otherErrors.length) {
        toast.error(`${otherErrors.length} report${otherErrors.length === 1 ? "" : "s"} failed: ${otherErrors.map((f) => `${f.ownerName} (${f.error})`).join("; ")}`);
      }
      if (prepared.length === 0 && !otherErrors.length && !skippedNoOwner.length && !noEmailOwners.length) {
        toast.error(`None of the selected ${objectLabel.toLowerCase()}s have an owner — nothing to email.`);
      }
      if (prepared.length || skippedNoOwner.length || noEmailOwners.length) {
        setDialog({ prepared, skippedNoOwner, noEmailOwners });
      }
      setConfirmOpen(false);
      onDone?.();
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return { confirmOpen, setConfirmOpen, dialog, setDialog, mutation };
}
