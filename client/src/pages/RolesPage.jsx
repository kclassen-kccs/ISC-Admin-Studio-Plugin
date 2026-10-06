import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronRight, Layers, Trash2, Power, PowerOff, Printer, Sparkles, RefreshCw, UploadCloud, Wand2, PencilLine, UserCog, BadgeCheck, Mail, X, Globe, CheckCircle2, XCircle, CircleSlash, Tags } from "lucide-react";
import toast from "react-hot-toast";
import {
  listRoles, deleteRole, setRoleEnabled, listRoleDimensions, listAllRoleMembers, listAllDimensionMembers, getCredentials,
  startRoleEvalScan, getRolePropagationRunning,
  generateAllRoleDescriptions, updateRole, getEntitlementsByIds, getCommonAccessRoleIds,
  fetchAllPages, certifyRoles, enableRoleCommonAccess, disableRoleCommonAccess,
} from "../lib/sailpoint";
import { printRolesListPdf, printRolesDetailPdf, printRolesBriefPdf, buildRolesDetailPdfBase64 } from "../lib/exportRolePdf";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { useUrlState } from "../hooks/useUrlState";
import { MetadataFilterControl, useMetadataFilter, useMetadataMatchIds, METADATA_NOT_SET } from "../components/MetadataFilter";
import { SegmentFilterControl, useSegmentFilter, useSegmentMatchIds } from "../components/SegmentFilter";
import { useEmailReportAction } from "../hooks/useEmailReportAction";
import { isBirthrightRole } from "../lib/roleMembership";
import { TopBar } from "../components/TopBar";
import { BrowseTitleMenu } from "../components/BrowseTitleMenu";
import { SearchBar, FilterBar, SkeletonList, EmptyState, ErrorBox, IconButton, ConfirmModal, Spinner, SelectionActionBar, Pager, OutlineButton } from "../components/ui";

import { useBulkTagMetadata } from "../components/BulkTagMetadata";
import { ApplyChangesModal } from "../components/ApplyChangesModal";
import { BulkDescriptionReviewSheet } from "../components/BulkDescriptionReviewSheet";
import { RoleRenameModal } from "../components/RoleRenameModal";
import { ChangeOwnerModal } from "../components/ChangeOwnerModal";
import { EmailReportDialog } from "../components/EmailReportDialog";

const ROLES_PAGE_SIZE = 50;

// Shared by the Detail Report print and Email Report actions — both need
// the same full-detail, entitlement-source-resolved role objects. `roles`
// (typically `list`, already loaded on this page) already carries every
// field a report uses except a dimensional role's own dimensions
// (verified live field-by-field against a single-role GET), so this only
// fetches dimensions (a few at a time) plus a bulk entitlement-source
// lookup for anything referenced by any role or dimension in the set.
async function enrichRolesForReport(roles) {
  const detailed = [];
  const batchSize = 5;
  for (let i = 0; i < roles.length; i += batchSize) {
    const batch = roles.slice(i, i + batchSize);
    const withDims = await Promise.all(
      batch.map(async (r) => ({
        ...r,
        dimensions: r.dimensional ? await listRoleDimensions(r.id) : [],
      }))
    );
    detailed.push(...withDims);
  }

  const allEntitlementIds = [
    ...new Set(
      detailed.flatMap((r) => [
        ...(r.entitlements || []).map((e) => e.id),
        ...(r.dimensions || []).flatMap((d) => (d.entitlements || []).map((e) => e.id)),
      ])
    ),
  ];
  const sourceById = {};
  const idBatchSize = 50;
  for (let i = 0; i < allEntitlementIds.length; i += idBatchSize) {
    const details = await getEntitlementsByIds(allEntitlementIds.slice(i, i + idBatchSize));
    for (const e of details) sourceById[e.id] = e.source?.name;
  }
  const withSource = (ents) => (ents || []).map((e) => ({ ...e, sourceName: sourceById[e.id] }));

  // Members for the identity list the detailed printout carries, so a
  // multi-role report matches what printing one role from its detail screen
  // produces. This is the expensive part of the enrichment — the server
  // re-evaluates each rule against every identity — so it runs in small
  // batches, and a role whose members can't be fetched has that section
  // marked unavailable in the printout rather than omitted, so a partial
  // report can't pass for a complete one.
  const withMembers = [];
  for (let i = 0; i < detailed.length; i += batchSize) {
    const batch = detailed.slice(i, i + batchSize);
    withMembers.push(...await Promise.all(batch.map(async (r) => {
      const [base, ...dims] = await Promise.all([
        listAllRoleMembers(r.id).catch(() => null),
        ...(r.dimensions || []).map((d) => listAllDimensionMembers(r.id, d.id).catch(() => null)),
      ]);
      return {
        ...r,
        ...(base ? { members: base.members, memberTotal: base.total } : { membersUnavailable: true }),
        dimensions: (r.dimensions || []).map((d, j) => ({
          ...d,
          ...(dims[j] ? { members: dims[j].members, memberTotal: dims[j].total } : { membersUnavailable: true }),
        })),
      };
    })));
  }

  return withMembers.map((r) => ({
    ...r,
    entitlements: withSource(r.entitlements),
    dimensions: (r.dimensions || []).map((d) => ({ ...d, entitlements: withSource(d.entitlements) })),
  }));
}

export default function RolesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  // This page is mounted at two routes — Browse's /roles and Role Mining's
  // /role-mining/roles — so a role's detail page has to be reached under
  // whichever one got us here, or the sidebar would flip to Browse's group
  // regardless of which section the user actually came from.
  const detailBasePath = location.pathname.startsWith("/role-mining") ? "/role-mining/roles" : "/roles";
  const { search, debouncedSearch, handleSearch } = useUrlSearch();
  const [selected, setSelected] = useState(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [changeOwnerOpen, setChangeOwnerOpen] = useState(false);
  const [changeOwnerProgress, setChangeOwnerProgress] = useState(0);
  const [certifyConfirmOpen, setCertifyConfirmOpen] = useState(false);
  const emailReport = useEmailReportAction({
    objectLabel: "Role",
    buildDetailPdfBase64: async ({ tenant, items }) => {
      const enriched = await enrichRolesForReport(items);
      return buildRolesDetailPdfBase64({ tenant, roles: enriched });
    },
    itemLabel: (r) => r.name,
    onDone: () => setSelected(new Set()),
  });
  const [progress, setProgress] = useState(0);
  const [enableProgress, setEnableProgress] = useState(0);
  const [flagProgress, setFlagProgress] = useState(0);
  const [requestableProgress, setRequestableProgress] = useState(0);
  const [requestableWarningOpen, setRequestableWarningOpen] = useState(false);
  const [printMenuOpen, setPrintMenuOpen] = useState(false);
  // URL-backed (not useState) so the Active/Disabled, Standard/Dynamic, and
  // Common Access filters survive navigating into a role's detail
  // page and clicking Back — same reasoning as the search box (useUrlSearch
  // above) and every other URL-backed filter/tab in this app.
  const [enabledFilter, setEnabledFilter] = useUrlState("status", "ALL");
  const [typeFilter, setTypeFilter] = useUrlState("type", "BOTH");
  // ALL (All Role Types) | COMMON (Common Access Roles) | INDIVIDUAL
  // (Individual Roles) | BIRTHRIGHT (roles with a membership rule) — was a
  // "Common Access Only" toggle pill, replaced with a dropdown per explicit
  // request so a Common-Access-excluding view is reachable too. Birthright
  // isn't the opposite of either: a Common Access role usually IS birthright
  // (it has a rule), so it shows under both.
  const [commonAccessFilter, setCommonAccessFilter] = useUrlState("commonAccess", "ALL");
  // Access Model Metadata attribute + value — narrows to the ids ISC Search
  // reports as tagged with it (see components/MetadataFilter).
  const metadataFilter = useMetadataFilter();
  const metadataMatch = useMetadataMatchIds("roles", metadataFilter.filter);
  // Data Segment — narrows to the roles on the segment's Access Model.
  const segmentFilter = useSegmentFilter();
  const segmentMatch = useSegmentMatchIds("roles", segmentFilter.filter);
  const [applyModalOpen, setApplyModalOpen] = useState(false);
  // [{roleId, description}|{roleId,error}] | null — the bulk description
  // review sheet, generated for whatever's currently shown (search +
  // Active/Disabled + Standard/Dynamic filters all applied).
  const [descriptionResults, setDescriptionResults] = useState(null);
  const [renameModalOpen, setRenameModalOpen] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["roles", debouncedSearch],
    queryFn: () => fetchAllPages((page) => listRoles({ ...page, query: debouncedSearch || undefined })),
    keepPreviousData: true,
  });

  // Role edits (membership criteria, enablement) aren't reflected in who
  // actually holds a role until a tenant-wide Role Propagation run
  // completes — this can be started from here or ISC's own UI, so it's
  // polled rather than tied to this app's own apply-changes action.
  const { data: propagation } = useQuery({
    queryKey: ["role-propagation-running"],
    queryFn: getRolePropagationRunning,
    refetchInterval: 30_000,
  });

  // Which role ids this app considers Common Access — fetched once and
  // cross-referenced client-side, same as Active/Disabled/Standard/Dynamic
  // below, since "is this a Common Access role" isn't a field on the role
  // object itself (see getCommonAccessRoleIds server-side). Always fetched
  // (not just when the toggle is on) — the Evaluate flow below needs it too,
  // to check whether the currently-filtered list contains a Common Access
  // role regardless of whether the toggle itself is active.
  const { data: commonAccessIds } = useQuery({
    queryKey: ["common-access-role-ids"],
    queryFn: getCommonAccessRoleIds,
  });
  const commonAccessIdSet = new Set(commonAccessIds || []);

  // Same fallback RoleDetailPage's flag icon uses when the tenant's own
  // Common Access confirmation can't be reached (this call hits the same
  // /common-access/v1 endpoint that's been 401ing all session, so
  // commonAccessIdSet is frequently incomplete): a role whose name contains
  // "Common Access" is treated as one even if it isn't in the confirmed/
  // locally-tracked set, rather than only ever classifying what ISC (or
  // this app's own bookkeeping) happens to already know about.
  const isCommonAccessRole = (r) =>
    commonAccessIds !== undefined ? commonAccessIdSet.has(r.id) : /common access/i.test(r.name || "");

  // "enabled" isn't a queryable filter on ISC's own /v2026/roles (confirmed
  // live: 400 "not queryable"), so Active/Disabled and Standard/Dynamic are
  // both applied client-side against the fetched page.
  // Every role is fetched (ISC can't filter /roles on enabled, dimensional
  // or Common Access — those are applied here), then the FILTERED result is
  // paged client-side. `filtered` is everything that matches; `list` is the
  // page on screen. Evaluate and the counts use `filtered`; selection and
  // rows use `list`.
  const [offsetStr, setOffsetStr] = useUrlState("offset", "0");
  const offset = Math.max(Number(offsetStr) || 0, 0);
  const setOffset = (n) => setOffsetStr(String(n));
  const resetPage = () => { if (offset) setOffset(0); };
  const filtered = (Array.isArray(data) ? data : [])
    .filter((r) => (enabledFilter === "ACTIVE" ? r.enabled : enabledFilter === "DISABLED" ? !r.enabled : true))
    .filter((r) => (typeFilter === "STANDARD" ? !r.dimensional : typeFilter === "DYNAMIC" ? r.dimensional : true))
    .filter((r) =>
      commonAccessFilter === "COMMON"
        ? isCommonAccessRole(r)
        : commonAccessFilter === "INDIVIDUAL"
        ? !isCommonAccessRole(r)
        : commonAccessFilter === "BIRTHRIGHT"
        ? isBirthrightRole(r)
        : true
    )
    .filter((r) => !metadataFilter.filter || (metadataMatch.ids ? metadataMatch.ids.has(r.id) : false))
    .filter((r) => !segmentFilter.filter || (segmentMatch.ids ? segmentMatch.ids.has(r.id) : false));
  const list = filtered.slice(offset, offset + ROLES_PAGE_SIZE);
  const allSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const pager = <Pager offset={offset} pageSize={ROLES_PAGE_SIZE} total={filtered.length} noun="role" onOffsetChange={setOffset} />;
  // Tag Metadata: add a metadata value to — or remove it from — the selection.
  const tagMetadata = useBulkTagMetadata({
    kind: "roles",
    noun: "roles",
    ids: [...selected],
    names: new Map(list.map((x) => [x.id, x.displayName || x.name])),
    invalidateKeys: [["roles"], ["role"]],
    onDone: () => setSelected(new Set()),
  });
  const roleById = new Map(list.map((r) => [r.id, r]));

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      if (allSelected) return new Set();
      return new Set(filtered.map((r) => r.id));
    });
  }

  // Scoped to the current selection, unlike the header's print menu which
  // deliberately covers the whole filtered list. Both exist because "print
  // what I picked" and "print what I'm looking at" are different intents.
  const printSelectedDetail = useMutation({
    mutationFn: async () => {
      const tenant = getCredentials()?.tenant;
      // Same enrichment the header's Detail Report does — without it the
      // report is missing dimensions and entitlement sources.
      const chosen = await enrichRolesForReport(list.filter((r) => selected.has(r.id)));
      return printRolesDetailPdf({ tenant, roles: chosen });
    },
    onSuccess: (opened) => {
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const generateDescriptions = useMutation({
    mutationFn: () => generateAllRoleDescriptions([...selected]),
    onSuccess: (result) => {
      setDescriptionResults(result.results);
      setSelected(new Set());
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const saveDescriptions = useMutation({
    mutationFn: (items) => Promise.all(items.map(({ roleId, description }) => updateRole(roleId, { description }))),
    onSuccess: (_result, items) => {
      toast.success(`${items.length} description${items.length === 1 ? "" : "s"} saved`);
      queryClient.invalidateQueries({ queryKey: ["roles"] });
      setDescriptionResults(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const bulkDelete = useMutation({
    mutationFn: async () => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await deleteRole(id);
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err.response?.data?.error || err.message });
        }
        setProgress(results.length);
      }
      return results;
    },
    onSuccess: (results) => {
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        toast.error(`Deleted ${results.length - failed.length} of ${results.length} roles — ${failed.length} failed`);
      } else {
        toast.success(`Deleted ${results.length} role${results.length === 1 ? "" : "s"}`);
      }
      setSelected(new Set());
      setConfirmOpen(false);
      setProgress(0);
      queryClient.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const bulkSetEnabled = useMutation({
    mutationFn: async (enabled) => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await setRoleEnabled(id, enabled);
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err.response?.data?.error || err.message });
        }
        setEnableProgress(results.length);
      }
      return { results, enabled };
    },
    onSuccess: ({ results, enabled }) => {
      const failed = results.filter((r) => !r.ok);
      const verb = enabled ? "Enabled" : "Disabled";
      if (failed.length) {
        toast.error(`${verb} ${results.length - failed.length} of ${results.length} roles — ${failed.length} failed`);
      } else {
        toast.success(`${verb} ${results.length} role${results.length === 1 ? "" : "s"}`);
      }
      setSelected(new Set());
      setEnableProgress(0);
      queryClient.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Same shape as bulkSetEnabled. Server-side, requestable can only be
  // changed on a standard role with no membership rule (a dimensional role
  // or one with a rule is assigned automatically, not requested) — a role
  // that doesn't qualify just reports as a per-role failure here rather
  // than blocking the rest of the selection.
  const bulkSetRequestable = useMutation({
    mutationFn: async (requestable) => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await updateRole(id, { requestable });
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err.response?.data?.error || err.message });
        }
        setRequestableProgress(results.length);
      }
      return { results, requestable };
    },
    onSuccess: ({ results, requestable }) => {
      const failed = results.filter((r) => !r.ok);
      const verb = requestable ? "Made requestable" : "Set to no requests";
      if (failed.length) {
        toast.error(`${verb} ${results.length - failed.length} of ${results.length} roles — ${failed.length} failed`);
      } else {
        toast.success(`${verb} ${results.length} role${results.length === 1 ? "" : "s"}`);
      }
      setSelected(new Set());
      setRequestableProgress(0);
      queryClient.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const bulkChangeOwner = useMutation({
    mutationFn: async (owner) => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await updateRole(id, { owner: { id: owner.id, name: owner.name } });
          results.push({ id, ok: true });
        } catch (err) {
          results.push({ id, ok: false, error: err.response?.data?.error || err.message });
        }
        setChangeOwnerProgress(results.length);
      }
      return results;
    },
    onSuccess: (results) => {
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        toast.error(`Changed owner for ${results.length - failed.length} of ${results.length} roles — ${failed.length} failed`);
      } else {
        toast.success(`Changed owner for ${results.length} role${results.length === 1 ? "" : "s"}`);
      }
      setSelected(new Set());
      setChangeOwnerOpen(false);
      setChangeOwnerProgress(0);
      queryClient.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Creates and activates one ROLE_COMPOSITION certification campaign per
  // distinct role owner among the selected roles (see server's
  // POST /api/roles/certify) — the server does its own fresh per-role
  // owner lookup and the actual grouping/campaign creation; this just
  // fires the request and reports what came back.
  const certifyRolesMutation = useMutation({
    mutationFn: () => certifyRoles([...selected]),
    onSuccess: ({ results, skippedNoOwner, skippedDimensional }) => {
      const succeeded = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      if (failed.length) {
        toast.error(
          `Created ${succeeded.length} of ${results.length} campaign${results.length === 1 ? "" : "s"} — ${failed.length} failed: ${failed.map((f) => f.error).join("; ")}`
        );
      } else if (results.length === 0 && !skippedDimensional?.length && !skippedNoOwner?.length) {
        toast.error("None of the selected roles have an owner — nothing to certify.");
      } else if (results.length > 0) {
        toast.success(`Created ${succeeded.length} Role Composition campaign${succeeded.length === 1 ? "" : "s"}`);
      }
      if (skippedDimensional?.length) {
        toast.error(
          `${skippedDimensional.length} dimensional (dynamic) role${skippedDimensional.length === 1 ? "" : "s"} skipped — ` +
          `Role Composition certification isn't supported for dynamic roles: ${skippedDimensional.map((r) => r.name).join(", ")}`
        );
      }
      if (skippedNoOwner?.length) {
        toast.error(`${skippedNoOwner.length} role${skippedNoOwner.length === 1 ? "" : "s"} skipped — no owner set: ${skippedNoOwner.map((r) => r.name).join(", ")}`);
      }
      setSelected(new Set());
      setCertifyConfirmOpen(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Same POST /api/roles/:id/common-access Role Detail's own toolbar icon
  // uses, applied to every selected role. A 409 means the role already has
  // a common-access record — not a real failure, just nothing to do — so
  // it's reported separately from a genuine error rather than lumped in
  // with "failed".
  const bulkFlagCommonAccess = useMutation({
    mutationFn: async () => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await enableRoleCommonAccess(id);
          results.push({ id, ok: true, alreadyFlagged: false });
        } catch (err) {
          const alreadyFlagged = err.response?.status === 409;
          results.push({ id, ok: alreadyFlagged, alreadyFlagged, error: alreadyFlagged ? null : (err.response?.data?.error || err.message) });
        }
        setFlagProgress(results.length);
      }
      return results;
    },
    onSuccess: (results) => {
      const flagged = results.filter((r) => r.ok && !r.alreadyFlagged);
      const alreadyFlagged = results.filter((r) => r.alreadyFlagged);
      const failed = results.filter((r) => !r.ok);
      if (flagged.length) {
        toast.success(`Flagged ${flagged.length} role${flagged.length === 1 ? "" : "s"} as Common Access`);
      }
      if (alreadyFlagged.length) {
        toast(`${alreadyFlagged.length} role${alreadyFlagged.length === 1 ? "" : "s"} already had a Common Access record`);
      }
      if (failed.length) {
        toast.error(`${failed.length} role${failed.length === 1 ? "" : "s"} failed: ${failed.map((f) => f.error).join("; ")}`);
      }
      setSelected(new Set());
      setFlagProgress(0);
      queryClient.invalidateQueries({ queryKey: ["common-access-role-ids"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const bulkUnflagCommonAccess = useMutation({
    mutationFn: async () => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          const r = await disableRoleCommonAccess(id);
          results.push({ id, ok: true, iscUpdated: !!r.iscUpdated });
        } catch (err) {
          results.push({ id, ok: false, error: err.response?.data?.error || err.message });
        }
        setFlagProgress(results.length);
      }
      return results;
    },
    onSuccess: (results) => {
      const ok = results.filter((r) => r.ok);
      const failed = results.filter((r) => !r.ok);
      if (ok.length) toast.success(`Unflagged ${ok.length} role${ok.length === 1 ? "" : "s"} — no longer Common Access`);
      if (failed.length) toast.error(`${failed.length} failed: ${failed.map((f) => f.error).join("; ")}`);
      setSelected(new Set());
      setFlagProgress(0);
      queryClient.invalidateQueries({ queryKey: ["common-access-role-ids"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });


  const toggleOneEnabled = useMutation({
    mutationFn: ({ id, enabled }) => setRoleEnabled(id, enabled),
    onSuccess: (_data, { enabled }) => {
      toast.success(enabled ? "Enabled" : "Disabled");
      queryClient.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const printList = useMutation({
    mutationFn: async () => {
      const tenant = getCredentials()?.tenant;
      return printRolesListPdf({ tenant, roles: list, searchQuery: debouncedSearch || undefined });
    },
    onSuccess: (opened) => {
      setPrintMenuOpen(false);
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const printDetail = useMutation({
    mutationFn: async () => {
      const enrichedRoles = await enrichRolesForReport(list);
      const tenant = getCredentials()?.tenant;
      return printRolesDetailPdf({ tenant, roles: enrichedRoles, searchQuery: debouncedSearch || undefined });
    },
    onSuccess: (opened) => {
      setPrintMenuOpen(false);
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const printBrief = useMutation({
    mutationFn: async () => {
      // Only dimension names are needed here, not the full role/dimension
      // detail printDetail fetches — cheaper per-role, so only dimensional
      // roles need a request at all.
      const roles = [];
      const batchSize = 5;
      for (let i = 0; i < list.length; i += batchSize) {
        const batch = list.slice(i, i + batchSize);
        const withDimensions = await Promise.all(
          batch.map(async (r) => ({
            ...r,
            dimensions: r.dimensional ? await listRoleDimensions(r.id) : [],
          }))
        );
        roles.push(...withDimensions);
      }
      const tenant = getCredentials()?.tenant;
      return printRolesBriefPdf({ tenant, roles, searchQuery: debouncedSearch || undefined });
    },
    onSuccess: (opened) => {
      setPrintMenuOpen(false);
      if (!opened) toast("Pop-up blocked — downloaded the PDF instead");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const printPending = printList.isPending || printDetail.isPending || printBrief.isPending;

  // Evaluates EXACTLY the roles currently shown in `list` — an explicit id
  // list, not a re-derived search — so every client-side filter (Active/
  // Disabled, Standard/Dynamic, Common Access Only, search) is reflected
  // exactly, not just the search text. Reported live: selecting down to a
  // single Common Access role via Active + Common Access Only still had
  // the scan evaluate every role in the tenant, because the scan used to
  // scope itself by search text alone. Role Evaluation's own Start button
  // still scopes by search text (see startRoleEvalScan) since it has no
  // such extra filters to reproduce.
  //
  // No Common Access prompt. With no list sent, the scan matches each role
  // against every Common Access role in the tenant by membership rule — a
  // Common Access role applies when its criteria are a subset of the role's,
  // respecting the boundary attributes. That's per role, so each one gets
  // the Common Access roles that genuinely overlap it, where a hand-picked
  // list was applied uniformly to every role in the scan.
  const runEval = useMutation({
    mutationFn: () => startRoleEvalScan(debouncedSearch || "", undefined, filtered.map((r) => r.id)),
    onSuccess: ({ scanId }) => {
      toast.success("Role evaluation started — check back on the scan for results.");
      queryClient.invalidateQueries({ queryKey: ["roleEvalScans"] });
      navigate(`/role-mining/role-eval-scans/${scanId}`);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  function startEval() {
    runEval.mutate();
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title={<BrowseTitleMenu active="Roles" />}
        loading={isLoading}
        action={
          list.length > 0 && (
            <div className="relative flex items-center gap-2">
              <IconButton
                icon={UploadCloud}
                title="Apply Changes in ISC — start a tenant-wide Role Propagation run"
                onClick={() => setApplyModalOpen(true)}
              />
              <IconButton
                icon={Sparkles}
                title={debouncedSearch ? `Evaluate roles matching "${debouncedSearch}"` : "Evaluate all roles"}
                onClick={startEval}
                loading={runEval.isPending}
              />
              <IconButton
                icon={Printer}
                title="Print roles"
                onClick={() => setPrintMenuOpen((v) => !v)}
                disabled={printPending}
              />
              {printMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setPrintMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-1 w-56 bg-white border border-gray-200 rounded-xl shadow-lg z-20 overflow-hidden">
                    <button
                      onClick={() => printList.mutate()}
                      disabled={printPending}
                      className="w-full text-left px-4 py-3 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-50"
                    >
                      <p className="font-medium">Simple list</p>
                      <p className="text-xs text-gray-500 mt-0.5">Name and owner only</p>
                    </button>
                    <button
                      onClick={() => printBrief.mutate()}
                      disabled={printPending}
                      className="w-full text-left px-4 py-3 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-50 border-t border-gray-100"
                    >
                      <p className="font-medium">Brief report</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Each role with its dimension names indented below it{printBrief.isPending ? " — generating…" : ""}
                      </p>
                    </button>
                    <button
                      onClick={() => printDetail.mutate()}
                      disabled={printPending}
                      className="w-full text-left px-4 py-3 text-sm text-gray-900 hover:bg-gray-50 disabled:opacity-50 border-t border-gray-100"
                    >
                      <p className="font-medium">Full detail</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        All fields per role{printDetail.isPending ? " — generating…" : ", one page break between roles"}
                      </p>
                    </button>
                  </div>
                </>
              )}
            </div>
          )
        }
      />
      <div className="flex-1 overflow-y-auto pb-24">
        {propagation?.isRunning && (
          <div className="mx-4 mt-3 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2.5 text-sm text-amber-800">
            <RefreshCw size={15} className="flex-shrink-0 mt-0.5 animate-spin" />
            <span>
              Role changes are still propagating tenant-wide — recent edits may not yet be reflected in who holds a role.
            </span>
          </div>
        )}
        <SearchBar value={search} onChange={(v) => { handleSearch(v); resetPage(); }} placeholder="Search roles…" />
        <FilterBar
          options={[
            { value: "ALL", label: "All" },
            { value: "ACTIVE", label: "Enabled" },
            { value: "DISABLED", label: "Disabled" },
          ]}
          active={enabledFilter}
          onChange={(v) => { setEnabledFilter(v); resetPage(); }}
          right={
            // Capped and truncated — two selects side by side in the same
            // row as the All/Enabled/Disabled pills routinely overflowed the
            // app's narrow (max-w-md) mobile column even with these
            // hardcoded option labels, same overflow class fixed on
            // EntitlementsPage's Source/Owner filters.
            <div className="flex items-center gap-2">
              <select
                value={commonAccessFilter}
                onChange={(e) => { setCommonAccessFilter(e.target.value); resetPage(); }}
                className="max-w-[8rem] truncate text-xs font-medium px-2.5 py-1.5 rounded-full border border-gray-200 bg-white text-gray-600 outline-none focus:border-blue-400"
              >
                <option value="ALL">All Role Types</option>
                <option value="COMMON">Common Access Roles</option>
                <option value="INDIVIDUAL">Individual Roles</option>
                <option value="BIRTHRIGHT">Birthright Roles</option>
              </select>
              <select
                value={typeFilter}
                onChange={(e) => { setTypeFilter(e.target.value); resetPage(); }}
                className="max-w-[7rem] truncate text-xs font-medium px-2.5 py-1.5 rounded-full border border-gray-200 bg-white text-gray-600 outline-none focus:border-blue-400"
              >
                <option value="BOTH">Standard &amp; Dynamic</option>
                <option value="STANDARD">Standard</option>
                <option value="DYNAMIC">Dynamic</option>
              </select>
              <MetadataFilterControl filter={metadataFilter.filter} onApply={(f) => { metadataFilter.set(f); resetPage(); }} onClear={() => { metadataFilter.clear(); resetPage(); }} />
              <SegmentFilterControl filter={segmentFilter.filter} onApply={(f) => { segmentFilter.set(f); resetPage(); }} onClear={() => { segmentFilter.clear(); resetPage(); }} />
            </div>
          }
        />
        {metadataMatch.error && <ErrorBox message={`Metadata filter failed: ${metadataMatch.error.response?.data?.error || metadataMatch.error.message}`} />}
        {segmentMatch.error && <ErrorBox message={`Segment filter failed: ${segmentMatch.error.response?.data?.error || segmentMatch.error.message}`} />}

        {error && <ErrorBox message={error.message} onRetry={refetch} />}
        {(isLoading || metadataMatch.isLoading || segmentMatch.isLoading) && <SkeletonList rows={8} />}
        {!isLoading && !metadataMatch.isLoading && !segmentMatch.isLoading && !error && list.length === 0 && (
          <EmptyState
            icon={Layers}
            title={offset > 0 && filtered.length > 0 ? "No more roles" : debouncedSearch || metadataFilter.filter || segmentFilter.filter ? "No results" : "No roles found"}
            subtitle={offset > 0 && filtered.length > 0 ? "This page is past the end of the list." : segmentFilter.filter ? `No roles are on the Access Model of segment ${segmentFilter.filter.name}` : metadataFilter.filter ? (metadataFilter.filter.value === METADATA_NOT_SET ? `Every role has a value for ${metadataFilter.filter.attributeName}` : `No roles are tagged ${metadataFilter.filter.attributeName}: ${metadataFilter.filter.valueName}`) : debouncedSearch ? `No roles match "${debouncedSearch}"` : "Your tenant has no roles yet"}
            action={offset > 0 && filtered.length > 0 ? <OutlineButton onClick={() => setOffset(0)} className="!w-auto mt-3">Back to first page</OutlineButton> : undefined}
          />
        )}

        {!isLoading && list.length > 0 && (
          <div>
            <div className="flex items-center justify-between px-4 py-2 gap-3">
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  className="w-4 h-4 rounded border-gray-300"
                />
                Select all
              </label>
              <p className="text-xs text-gray-400">
                {filtered.length} role{filtered.length !== 1 && "s"}{(debouncedSearch || enabledFilter !== "ALL" || typeFilter !== "BOTH" || commonAccessFilter !== "ALL" || metadataFilter.filter || segmentFilter.filter) && " matching"}
              </p>
            </div>
            {pager}

            {selected.size > 0 && (
              <SelectionActionBar
                count={selected.size}
                progressText={
                  bulkSetEnabled.isPending
                    ? `Updating ${enableProgress} of ${selected.size}…`
                    : bulkChangeOwner.isPending
                    ? `Changing owner for ${changeOwnerProgress} of ${selected.size}…`
                    : bulkFlagCommonAccess.isPending
                    ? `Flagging ${flagProgress} of ${selected.size}…`
                    : bulkSetRequestable.isPending
                    ? `Updating ${requestableProgress} of ${selected.size}…`
                    : null
                }
                actions={[
                  { icon: Tags, title: `Tag Metadata (${selected.size})`, onClick: tagMetadata.open, loading: tagMetadata.pending },
                  {
                    icon: Power,
                    title: `Enable (${selected.size})`,
                    onClick: () => bulkSetEnabled.mutate(true),
                    loading: bulkSetEnabled.isPending && bulkSetEnabled.variables === true,
                    disabled: bulkSetEnabled.isPending || bulkDelete.isPending,
                  },
                  {
                    icon: PowerOff,
                    title: `Disable (${selected.size})`,
                    onClick: () => bulkSetEnabled.mutate(false),
                    loading: bulkSetEnabled.isPending && bulkSetEnabled.variables === false,
                    disabled: bulkSetEnabled.isPending || bulkDelete.isPending,
                  },
                  {
                    icon: UserCog,
                    title: `Change Owner (${selected.size})`,
                    onClick: () => setChangeOwnerOpen(true),
                    disabled: bulkSetEnabled.isPending || bulkDelete.isPending || bulkChangeOwner.isPending,
                  },
                  {
                    icon: CheckCircle2,
                    title: `Make Requestable (${selected.size})`,
                    onClick: () => {
                      // Same eligibility rule the server enforces (see PATCH
                      // /api/roles/:id) — checked here too so the selection
                      // gets one clear warning up front instead of a wall of
                      // per-role failure toasts after the fact.
                      const ineligible = list.some((r) => selected.has(r.id) && (r.dimensional || r.membership?.criteria));
                      if (ineligible) setRequestableWarningOpen(true);
                      else bulkSetRequestable.mutate(true);
                    },
                    loading: bulkSetRequestable.isPending && bulkSetRequestable.variables === true,
                    disabled: bulkSetEnabled.isPending || bulkDelete.isPending || bulkSetRequestable.isPending,
                  },
                  {
                    icon: XCircle,
                    title: `No Requests (${selected.size})`,
                    onClick: () => bulkSetRequestable.mutate(false),
                    loading: bulkSetRequestable.isPending && bulkSetRequestable.variables === false,
                    disabled: bulkSetEnabled.isPending || bulkDelete.isPending || bulkSetRequestable.isPending,
                  },
                  {
                    icon: Wand2,
                    title: `Generate Descriptions (${selected.size})`,
                    onClick: () => generateDescriptions.mutate(),
                    loading: generateDescriptions.isPending,
                    disabled: bulkSetEnabled.isPending || bulkDelete.isPending || generateDescriptions.isPending,
                  },
                  {
                    icon: PencilLine,
                    title: `Rename Selected Roles (${selected.size})`,
                    onClick: () => setRenameModalOpen(true),
                    disabled: bulkSetEnabled.isPending || bulkDelete.isPending,
                  },
                  {
                    icon: BadgeCheck,
                    title: `Certify Role Composition (${selected.size})`,
                    onClick: () => setCertifyConfirmOpen(true),
                    loading: certifyRolesMutation.isPending,
                    disabled: bulkSetEnabled.isPending || bulkDelete.isPending || certifyRolesMutation.isPending,
                  },
                  {
                    icon: Globe,
                    title: `Flag as Common Access (${selected.size})`,
                    onClick: () => bulkFlagCommonAccess.mutate(),
                    loading: bulkFlagCommonAccess.isPending,
                    disabled: bulkSetEnabled.isPending || bulkDelete.isPending || bulkFlagCommonAccess.isPending || bulkUnflagCommonAccess.isPending,
                  },
                  {
                    icon: CircleSlash,
                    title: `Unflag Common Access (${selected.size})`,
                    onClick: () => bulkUnflagCommonAccess.mutate(),
                    loading: bulkUnflagCommonAccess.isPending,
                    disabled: bulkSetEnabled.isPending || bulkDelete.isPending || bulkFlagCommonAccess.isPending || bulkUnflagCommonAccess.isPending,
                  },
                  {
                    icon: Mail,
                    title: `Email Report (${selected.size})`,
                    onClick: () => emailReport.setConfirmOpen(true),
                    loading: emailReport.mutation.isPending,
                    disabled: bulkSetEnabled.isPending || bulkDelete.isPending || emailReport.mutation.isPending,
                  },
                  {
                    icon: Printer,
                    title: `Print Detail for Selected (${selected.size})`,
                    onClick: () => printSelectedDetail.mutate(),
                    loading: printSelectedDetail.isPending,
                  },
                  {
                    icon: Trash2,
                    title: `Delete Selected Roles (${selected.size})`,
                    onClick: () => setConfirmOpen(true),
                    disabled: bulkSetEnabled.isPending,
                    danger: true,
                  },
                ]}
              />
            )}

            {list.map((r) => (
              <div
                key={r.id}
                className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selected.has(r.id)}
                  onChange={() => toggleOne(r.id)}
                  className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
                />
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`${detailBasePath}/${r.id}`)}
                  onKeyDown={(e) => e.key === "Enter" && navigate(`${detailBasePath}/${r.id}`)}
                  className="flex-1 min-w-0 flex items-center gap-3 text-left cursor-pointer active:bg-gray-100"
                >
                  <div className="w-10 h-10 rounded-full bg-amber-50 flex items-center justify-center flex-shrink-0">
                    <Layers size={16} className="text-amber-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{r.name}</p>
                    {r.description && (
                      <p className="text-xs text-gray-500 mt-0.5 truncate">{r.description}</p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                        r.dimensional
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                          : "bg-blue-50 text-blue-700 border-blue-200"
                      }`}
                    >
                      {r.dimensional ? "Dynamic" : "Standard"}
                    </span>
                    <button
                      type="button"
                      title={r.enabled ? "Disable" : "Enable"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleOneEnabled.mutate({ id: r.id, enabled: !r.enabled });
                      }}
                      disabled={toggleOneEnabled.isPending && toggleOneEnabled.variables?.id === r.id}
                      className={`text-xs font-medium px-2 py-0.5 rounded-full border transition-colors disabled:opacity-50 ${
                        r.enabled
                          ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-red-50 hover:text-red-700 hover:border-red-200"
                          : "bg-red-50 text-red-700 border-red-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200"
                      }`}
                    >
                      {r.enabled ? "Enabled" : "Disabled"}
                    </button>
                  </div>
                  <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
                </div>
              </div>
            ))}
            {pager}
          </div>
        )}
      </div>

      {confirmOpen && (
        <ConfirmModal
          title={`Delete ${selected.size} role${selected.size === 1 ? "" : "s"}?`}
          message={`This permanently deletes the selected role${selected.size === 1 ? "" : "s"} from this tenant. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          pending={bulkDelete.isPending}
          progressText={`Deleting ${progress} of ${selected.size}…`}
          onConfirm={() => bulkDelete.mutate()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      {changeOwnerOpen && (
        <ChangeOwnerModal
          count={selected.size}
          pending={bulkChangeOwner.isPending}
          progressText={`Changing owner for ${changeOwnerProgress} of ${selected.size}…`}
          onConfirm={(owner) => bulkChangeOwner.mutate(owner)}
          onClose={() => setChangeOwnerOpen(false)}
        />
      )}

      {requestableWarningOpen && (
        <ConfirmModal
          title="Some selected roles can't be made requestable"
          message="Only a Standard role with no membership rule can be made requestable. Roles with membership rules will fail to update safely."
          confirmLabel="Continue Anyway"
          pending={bulkSetRequestable.isPending}
          onConfirm={() => {
            setRequestableWarningOpen(false);
            bulkSetRequestable.mutate(true);
          }}
          onCancel={() => setRequestableWarningOpen(false)}
        />
      )}

      {certifyConfirmOpen && (
        <ConfirmModal
          title={`Certify ${selected.size} role${selected.size === 1 ? "" : "s"}?`}
          message={
            `Creates and activates one Role Composition certification campaign per role owner, ` +
            `named "[owner] Role Composition Review", assigned to that owner, with a deadline 2 weeks from today ` +
            `and email notifications enabled. Roles sharing an owner are combined into that owner's one campaign. ` +
            `A role with no owner set is skipped. Dimensional (dynamic) roles are also skipped — ISC's Role ` +
            `Composition certification doesn't generate anything to review for them.`
          }
          confirmLabel="Certify"
          pending={certifyRolesMutation.isPending}
          onConfirm={() => certifyRolesMutation.mutate()}
          onCancel={() => setCertifyConfirmOpen(false)}
        />
      )}

      {emailReport.confirmOpen && (
        <ConfirmModal
          title={`Email report for ${selected.size} role${selected.size === 1 ? "" : "s"}?`}
          message={
            `Builds one Role Report PDF per role owner (roles sharing an owner are combined into ` +
            `one report) and publishes each to a link — the link is used instead of an attachment since email links ` +
            `can't carry files. Nothing is sent automatically: you'll get a list to review, and each email only ` +
            `opens your mail app when you click its own send icon, one at a time. A role with no owner, or an ` +
            `owner with no email address on file, is skipped.`
          }
          confirmLabel="Build Reports"
          pending={emailReport.mutation.isPending}
          onConfirm={() => emailReport.mutation.mutate(list.filter((r) => selected.has(r.id)))}
          onCancel={() => emailReport.setConfirmOpen(false)}
        />
      )}

      {emailReport.dialog && (
        <EmailReportDialog
          objectLabel="Role"
          dialog={emailReport.dialog}
          onClose={() => emailReport.setDialog(null)}
          onMarkSent={(ownerId) =>
            emailReport.setDialog((prev) => ({
              ...prev,
              prepared: prev.prepared.map((r) => (r.ownerId === ownerId ? { ...r, sent: true } : r)),
            }))
          }
        />
      )}

      {applyModalOpen && <ApplyChangesModal onClose={() => setApplyModalOpen(false)} />}

      {renameModalOpen && (
        <RoleRenameModal
          roles={list.filter((r) => selected.has(r.id))}
          onClose={() => setRenameModalOpen(false)}
        />
      )}

      {descriptionResults && (
        <BulkDescriptionReviewSheet
          items={descriptionResults}
          roleById={roleById}
          onClose={() => setDescriptionResults(null)}
          onSaveSelected={(items) => saveDescriptions.mutate(items)}
          pending={saveDescriptions.isPending}
        />
      )}

      {generateDescriptions.isPending && (
        <div className="fixed inset-0 bg-black/20 z-20 flex items-center justify-center pointer-events-none">
          <div className="bg-white rounded-2xl shadow-xl px-5 py-4 flex items-center gap-3">
            <Spinner size={18} />
            <p className="text-sm text-gray-600">Generating descriptions for {selected.size} role{selected.size === 1 ? "" : "s"}…</p>
          </div>
        </div>
      )}
      {tagMetadata.element}
    </div>
  );
}
