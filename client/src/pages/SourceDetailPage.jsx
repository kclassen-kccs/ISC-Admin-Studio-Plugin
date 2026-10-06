import { useEffect, useState, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Database, Key, Server, History, Users, Zap, Info, LayoutGrid, Plus, Trash2, Wand2,
  RotateCcw, UserX, KeyRound, ClipboardList, ChevronLeft, ChevronRight, Asterisk, Pencil, X,
  UserCog, Table2, RefreshCw, Link, Braces, Tags, Layers, ChevronDown, ListTree, ChevronsUpDown, ChevronsDownUp,
  Boxes, PlugZap, Code, Cloud, ScrollText, Activity, Play, Printer,
} from "lucide-react";
import { RawJsonPanel, buildPatchOps } from "../components/RawJsonPanel";
import { jsonParseError } from "../components/JsonEditor";
import { JsonEditTabs } from "../components/JsonTree";
import { JSON_EDITOR_STYLE, highlightJson, escapeHtml } from "../components/JsonEditor";
import toast from "react-hot-toast";
import {
  getSource, listEntitlementsBySource, listAccountsBySource, getSourceAggregationHistory,
  countEntitlementsBySource, listAllEntitlementsBySource, listAllAccountsBySource,
  aggregateSourceAccounts, aggregateSourceEntitlements,
  resetSource, resetSourceAccounts, resetSourceEntitlements,
  listSourceApps, createSourceApp, deleteSourceApp, updateSourceApp, generateAllSourceAppDescriptions,
  listSourceDatasets, aggregateSourceDataset, updateSourceDataset,
  listSourceSchemas, updateSourceSchema,
  listSourceResources, updateSourceResource,
  listSourceProvisioningPolicies, getSourceProvisioningPolicy, updateSourceProvisioningPolicy, isEditableAccountSourceType,
  generateSourceDescription, updateSourceDescription, updateSource, listIdentities, getSourceIdentityProfile, deleteSource, deleteIdentityProfile, processIdentityProfile,
  createIdentityProfileForSource, syncSourceIdentityProfile, getSourceAccountSchema,
  detectSourceSchema, setSourceSchemaUid, syncSourceProvisioningPolicies, getCredentials,
  updateEntitlement, generateAllEntitlementDescriptions, exportSourceAccounts, generateSourceData, loadAccountsFile,
  bulkTagEntitlementMetadata, testSourceConfiguration, getManagedCluster, listManagedClientsForCluster, listConnectorRules,
  listConnectorCustomizers, isSaasSource,
  setSourceDeleteThreshold,
} from "../lib/sailpoint";
import { toCsv } from "../lib/csv";
import { AddSailPointUserPill, isIscAdminsSource } from "../components/SailPointIcon";
import { AddFromLdapModal } from "../components/AddFromLdapModal";
import { useAuth } from "../hooks/useAuth";
import { useUrlState } from "../hooks/useUrlState";
import { useUrlSearch } from "../hooks/useUrlSearch";
import { TopBar } from "../components/TopBar";
import {
  InfoRow, SkeletonList, ErrorBox, EmptyState, Spinner, SearchBar, IconButton, OutlineButton,
  ConfirmModal, PrimaryButton, Field, Textarea, Input, SelectionActionBar, Pager, iscMaxOffset,
} from "../components/ui";
import { printSourceAccountsPdf, printSourceEntitlementsPdf } from "../lib/exportSourceListsPdf";
import { ChangeOwnerModal } from "../components/ChangeOwnerModal";
import { PickerField } from "../components/PickerField";
import { AdditionalOwnersField } from "../components/AdditionalOwnersField";
import { TagMetadataModal } from "../components/TagMetadataModal";
import { ResultDialog } from "../components/ResultDialog";
import { BulkDescriptionReviewSheet } from "../components/BulkDescriptionReviewSheet";
import { ApplicationFormModal } from "../components/ApplicationFormModal";
import { SaasConnectorLogsPanel } from "../components/SaasConnectorLogsPanel";
import { SourceActivityPanel } from "../components/SourceActivityPanel";
import { tenantUiHost, isDemoDomainTenant } from "../lib/tenantHost";

const ENTITLEMENTS_PAGE_SIZE = 100;
const ACCOUNTS_PAGE_SIZE = 100;

// ─── Entitlements panel ────────────────────────────────────────────────────────

function EntitlementsPanel({ sourceId, sourceName, onNavigateEntitlement }) {
  const queryClient = useQueryClient();
  // URL-backed — clicking an entitlement navigates away (onNavigateEntitlement),
  // and clicking Back unmounts this panel, which would reset a plain useState.
  const { search, debouncedSearch, handleSearch } = useUrlSearch("eq");
  // Page offset lives in the URL too, so Back returns to the same page. A
  // new search starts from the first page.
  const [offsetStr, setOffsetStr] = useUrlState("eo", "0");
  // ISC stops paging at 10,000 (offset + limit); clamp rather than 400.
  const offset = Math.min(Math.max(Number(offsetStr) || 0, 0), iscMaxOffset(ENTITLEMENTS_PAGE_SIZE));
  const setOffset = (n) => setOffsetStr(String(n));
  const handleSearchAndReset = (v) => { handleSearch(v); if (offset) setOffset(0); };

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ["source-entitlements", sourceId, debouncedSearch, offset],
    queryFn: () => listEntitlementsBySource(sourceId, { limit: ENTITLEMENTS_PAGE_SIZE, offset, query: debouncedSearch || undefined }),
    keepPreviousData: true,
  });
  const list = Array.isArray(data) ? data : [];
  // The real total, from ISC's count header — one cheap call per search.
  const { data: total } = useQuery({
    queryKey: ["source-entitlements-count", sourceId, debouncedSearch],
    queryFn: () => countEntitlementsBySource(sourceId, { query: debouncedSearch || undefined }),
    staleTime: 60_000,
  });
  const tenant = getCredentials()?.tenant;

  // Print fetches EVERY page (the list is paged; the printout isn't), so on
  // a big source this takes a few seconds — the button shows it.
  const print = useMutation({
    mutationFn: async () => {
      const all = await listAllEntitlementsBySource(sourceId, { query: debouncedSearch || undefined });
      if (!printSourceEntitlementsPdf({ tenant, sourceName, entitlements: all, query: debouncedSearch || "" })) toast("Pop-up blocked — downloaded the PDF instead");
      return all.length;
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Select one/all + bulk Change Owner — same interaction as the Browse
  // Entitlements page (ISC's API has no entitlement delete, single or bulk
  // — every root 405/410s, verified live — so owner change is the bulk
  // action offered here).
  const [selected, setSelected] = useState(new Set());
  const [changeOwnerOpen, setChangeOwnerOpen] = useState(false);
  const [tagMetadataOpen, setTagMetadataOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [descriptionResults, setDescriptionResults] = useState(null);
  const allSelected = list.length > 0 && list.every((e) => selected.has(e.id));
  const entitlementById = new Map(list.map((e) => [e.id, e]));

  // Same AI generate-then-review flow as the Browse Entitlements page:
  // drafts come back for review in BulkDescriptionReviewSheet and nothing
  // is saved until individual rows are accepted there.
  const generateDescriptions = useMutation({
    mutationFn: () => generateAllEntitlementDescriptions([...selected]),
    onSuccess: (result) => {
      setDescriptionResults(result.results);
      setSelected(new Set());
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const saveDescriptions = useMutation({
    mutationFn: (items) => Promise.all(items.map(({ roleId, description }) => updateEntitlement(roleId, { description }))),
    onSuccess: (_result, items) => {
      toast.success(`${items.length} description${items.length === 1 ? "" : "s"} saved`);
      queryClient.invalidateQueries({ queryKey: ["source-entitlements", sourceId] });
      queryClient.invalidateQueries({ queryKey: ["entitlements"] });
      setDescriptionResults(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const tagMetadata = useMutation({
    mutationFn: (sel) => bulkTagEntitlementMetadata({ ...sel, entitlementIds: [...selected] }),
    onSuccess: (result) => {
      toast.success(`Tagged ${result.tagged} entitlement${result.tagged === 1 ? "" : "s"}`);
      setSelected(new Set());
      setTagMetadataOpen(false);
      queryClient.invalidateQueries({ queryKey: ["source-entitlements", sourceId] });
      queryClient.invalidateQueries({ queryKey: ["entitlements"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const bulkChangeOwner = useMutation({
    mutationFn: async (owner) => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await updateEntitlement(id, { owner: { id: owner.id, name: owner.name } });
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
        toast.error(`Changed owner for ${results.length - failed.length} of ${results.length} entitlements — ${failed.length} failed`);
      } else {
        toast.success(`Changed owner for ${results.length} entitlement${results.length === 1 ? "" : "s"}`);
      }
      setSelected(new Set());
      setChangeOwnerOpen(false);
      setProgress(0);
      queryClient.invalidateQueries({ queryKey: ["source-entitlements", sourceId] });
      queryClient.invalidateQueries({ queryKey: ["entitlements"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const pager = (
    <Pager offset={offset} pageSize={ENTITLEMENTS_PAGE_SIZE} total={typeof total === "number" ? total : undefined} noun="entitlement" onOffsetChange={setOffset} hasNext={typeof total === "number" ? undefined : list.length === ENTITLEMENTS_PAGE_SIZE} busy={isFetching} maxOffset={iscMaxOffset(ENTITLEMENTS_PAGE_SIZE)} />
  );

  return (
    <div>
      <SearchBar value={search} onChange={handleSearchAndReset} placeholder="Search entitlements…" />
      {isLoading && <SkeletonList rows={4} />}
      {error && <ErrorBox message={error.message} />}
      {!isLoading && !error && list.length === 0 && (
        <EmptyState
          icon={Key}
          title={debouncedSearch ? "No results" : offset > 0 ? "No more entitlements" : "No entitlements"}
          subtitle={debouncedSearch ? `No entitlements match "${debouncedSearch}"` : offset > 0 ? "This page is past the end of the list." : "This source has no entitlements"}
          action={offset > 0 ? <OutlineButton onClick={() => setOffset(0)} className="!w-auto mt-3">Back to first page</OutlineButton> : undefined}
        />
      )}
      {!isLoading && list.length > 0 && (
        <>
          <div className="flex items-center justify-between px-4 pt-2 gap-3">
            <label className="flex items-center gap-2 text-xs text-gray-500">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => setSelected(allSelected ? new Set() : new Set(list.map((e) => e.id)))}
                className="w-4 h-4 rounded border-gray-300"
              />
              Select all on this page
            </label>
            <IconButton
              icon={Printer}
              title={`Print entitlement list${typeof total === "number" ? ` (${total.toLocaleString()} entitlements)` : ""}${debouncedSearch ? ` matching "${debouncedSearch}"` : ""}`}
              onClick={() => print.mutate()}
              loading={print.isPending}
            />
          </div>
          {pager}

          {selected.size > 0 && (
            <SelectionActionBar
              count={selected.size}
              progressText={bulkChangeOwner.isPending ? `Changing owner for ${progress} of ${selected.size}…` : null}
              actions={[
                {
                  icon: Wand2,
                  title: `Generate Descriptions (${selected.size})`,
                  onClick: () => generateDescriptions.mutate(),
                  loading: generateDescriptions.isPending,
                },
                {
                  icon: UserCog,
                  title: `Change Owner (${selected.size})`,
                  onClick: () => setChangeOwnerOpen(true),
                  disabled: bulkChangeOwner.isPending,
                },
                {
                  icon: Tags,
                  title: `Tag Metadata (${selected.size})`,
                  onClick: () => setTagMetadataOpen(true),
                  disabled: tagMetadata.isPending,
                },
              ]}
            />
          )}

          {list.map((e) => (
            <div
              key={e.id}
              className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 transition-colors"
            >
              <input
                type="checkbox"
                checked={selected.has(e.id)}
                onChange={() => toggleOne(e.id)}
                className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
              />
              <button
                onClick={() => onNavigateEntitlement(e.id)}
                className="flex-1 min-w-0 flex items-center gap-3 text-left active:bg-gray-100"
              >
                <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                  <Key size={14} className="text-gray-500" />
                </div>
                <p className="text-sm font-medium text-gray-900 truncate flex-1">{e.name}</p>
              </button>
            </div>
          ))}
          {pager}
        </>
      )}

      {descriptionResults && (
        <BulkDescriptionReviewSheet
          items={descriptionResults}
          roleById={entitlementById}
          onClose={() => setDescriptionResults(null)}
          onSaveSelected={(items) => saveDescriptions.mutate(items)}
          pending={saveDescriptions.isPending}
        />
      )}

      {changeOwnerOpen && (
        <ChangeOwnerModal
          count={selected.size}
          pending={bulkChangeOwner.isPending}
          progressText={`Changing owner for ${progress} of ${selected.size}…`}
          onConfirm={(owner) => bulkChangeOwner.mutate(owner)}
          onClose={() => setChangeOwnerOpen(false)}
        />
      )}

      {tagMetadataOpen && (
        <TagMetadataModal
          count={selected.size}
          pending={tagMetadata.isPending}
          onConfirm={(sel) => tagMetadata.mutate(sel)}
          onClose={() => setTagMetadataOpen(false)}
        />
      )}
    </div>
  );
}

// ─── Accounts panel ─────────────────────────────────────────────────────────────

// The identity an account is linked to. /v2026/accounts returns it as
// correlatedIdentity with a `correlated` flag; older (v3-shaped) responses
// use identity / uncorrelated — both are read so either works.
function linkedIdentity(acct) {
  const ident = acct?.correlatedIdentity || acct?.identity || null;
  if (!ident?.id) return null;
  if (acct.correlated === false || acct.uncorrelated === true) return null;
  return ident;
}

function AccountDetailModal({ account, onClose }) {
  const navigate = useNavigate();
  const attributes = account.attributes || {};
  const entitlementAttributes = account.entitlementAttributes || {};

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-base font-semibold text-gray-900 truncate">{account.name || account.nativeIdentity}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0 ml-3">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 pt-3 pb-5">
          <div className="border border-gray-100 rounded-xl overflow-hidden px-3">
            <InfoRow label="Native Identity" value={account.nativeIdentity} />
            {/* Correlated identity links through to its Identity detail
                page — hand-rolled instead of InfoRow so the value can be a
                button (InfoRow stringifies its value for the hover title). */}
            {linkedIdentity(account) ? (
              <div className="flex justify-between items-center py-3 border-b border-gray-100 last:border-0 gap-4">
                <span className="text-sm text-gray-500 flex-shrink-0">Correlated Identity</span>
                <button
                  onClick={() => navigate(`/identities/${linkedIdentity(account).id}`)}
                  className="text-sm text-blue-600 hover:underline font-medium text-right truncate flex-1 min-w-0"
                  title={linkedIdentity(account).name}
                >
                  {linkedIdentity(account).name}
                </button>
              </div>
            ) : (
              <InfoRow label="Correlated Identity" value={linkedIdentity(account)?.name || "Uncorrelated"} />
            )}
            <InfoRow label="Source" value={account.sourceName} />
            <InfoRow label="Status" value={account.disabled ? "Disabled" : "Active"} />
            <InfoRow label="Locked" value={account.locked ? "Yes" : undefined} />
            <InfoRow label="Privileged" value={account.privileged ? "Yes" : undefined} />
            <InfoRow label="Authoritative" value={account.authoritative != null ? String(account.authoritative) : undefined} />
            <InfoRow label="Manually Correlated" value={account.manuallyCorrelated != null ? String(account.manuallyCorrelated) : undefined} />
            <InfoRow label="Created" value={account.created ? new Date(account.created).toLocaleString() : undefined} />
            <InfoRow label="Modified" value={account.modified ? new Date(account.modified).toLocaleString() : undefined} />
            <InfoRow label="Account ID" value={account.id} />
          </div>

          {Object.keys(attributes).length > 0 && (
            <>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-5 mb-2">Attributes</p>
              <div className="border border-gray-100 rounded-xl overflow-hidden px-3">
                {Object.entries(attributes).map(([k, v]) => (
                  <InfoRow key={k} label={k} value={Array.isArray(v) ? v.join(", ") : v} />
                ))}
              </div>
            </>
          )}

          {Object.keys(entitlementAttributes).length > 0 && (
            <>
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mt-5 mb-2">Entitlements</p>
              <div className="border border-gray-100 rounded-xl overflow-hidden px-3">
                {Object.entries(entitlementAttributes).map(([k, v]) => (
                  <InfoRow key={k} label={k} value={Array.isArray(v) ? v.join(", ") : v} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Generate Data (AI) ────────────────────────────────────────────────────
// Exports the source's current account CSV, pre-writes an editable prompt
// describing it, sends prompt+CSV to the AI, and shows the returned CSV for
// review. Saving uploads the FIRST LINE as the schema (detect-schema, same
// header-only mechanism as the Schema tab) and then runs a full,
// unoptimized account load of the whole file.
function GenerateDataModal({ sourceId, sourceName, onClose }) {
  const queryClient = useQueryClient();
  const schemaQuery = useQuery({
    queryKey: ["source-account-schema", sourceId],
    queryFn: () => getSourceAccountSchema(sourceId),
  });
  const exportQuery = useQuery({
    queryKey: ["source-accounts-export", sourceId],
    queryFn: () => exportSourceAccounts(sourceId),
  });

  const [prompt, setPrompt] = useState(null); // seeded once below
  const [generated, setGenerated] = useState(null); // { csv, rows }

  const headers = (schemaQuery.data?.attributes || []).filter((a) => a.name !== "idNowDescription").map((a) => a.name);
  const currentRows = exportQuery.data ? exportQuery.data.length : null;
  const currentCsv = schemaQuery.data && exportQuery.data
    ? toCsv(headers, exportQuery.data.map((acct) => ({ ...(acct.attributes || {}) })))
    : null;

  useEffect(() => {
    if (prompt === null && schemaQuery.data && exportQuery.data) {
      setPrompt(
        `You are updating the account data for the source "${sourceName}".\n` +
        `The CSV columns are: ${headers.join(", ")}.\n` +
        `It currently has ${exportQuery.data.length} account row${exportQuery.data.length === 1 ? "" : "s"}.\n\n` +
        `Make these changes to the data:\n` +
        `- add 10 realistic new accounts that follow the existing patterns\n\n` +
        `Keep the header row unchanged, keep existing rows unless the instructions above say otherwise, and output valid CSV.`
      );
    }
  }, [prompt, schemaQuery.data, exportQuery.data]);

  const generate = useMutation({
    mutationFn: () => {
      const csvBase64 = btoa(unescape(encodeURIComponent(currentCsv)));
      return generateSourceData(sourceId, { prompt, csvBase64 });
    },
    onSuccess: (result) => setGenerated(result),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const save = useMutation({
    mutationFn: async () => {
      const lines = generated.csv.split("\n");
      const headerCsv = lines[0] + "\n";
      // 1) schema from the file's first line — header-only upload, same as
      //    the Schema tab's editor
      await detectSourceSchema(sourceId, {
        filename: `${sourceName || "accounts"}-schema.csv`,
        csvBase64: btoa(unescape(encodeURIComponent(headerCsv))),
      });
      // 2) full aggregation of the whole generated file (unoptimized)
      return loadAccountsFile(sourceId, {
        filename: `${sourceName || "accounts"}-generated.csv`,
        csvBase64: btoa(unescape(encodeURIComponent(generated.csv + "\n"))),
        disableOptimization: true,
      });
    },
    onSuccess: () => {
      toast.success(
        "Schema uploaded and full aggregation started from the generated file. ISC processes it asynchronously — expect a short delay before the new data shows up.",
        { duration: 8000 }
      );
      queryClient.invalidateQueries({ queryKey: ["source-accounts", sourceId] });
      queryClient.invalidateQueries({ queryKey: ["source-account-schema", sourceId] });
      queryClient.invalidateQueries({ queryKey: ["source-entitlements", sourceId] });
      onClose();
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const loading = schemaQuery.isLoading || exportQuery.isLoading || prompt === null;
  const pending = generate.isPending || save.isPending;
  const previewLines = generated ? generated.csv.split("\n").slice(0, 15) : [];

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-base font-semibold text-gray-900">Generate Data</h2>
          <button onClick={onClose} disabled={pending} className="text-gray-400 hover:text-gray-600 disabled:opacity-50">
            <X size={18} />
          </button>
        </div>
        <p className="text-xs text-gray-500 px-5 pt-2 leading-relaxed">
          AI modifies this source's account CSV per your instructions. Review the result, then Save — the file's
          first line is uploaded as the schema, followed by a full aggregation of the data.
        </p>

        <div className="px-5 pt-3 pb-5">
          {loading && <SkeletonList rows={4} />}
          {(schemaQuery.error || exportQuery.error) && (
            <ErrorBox message={(schemaQuery.error || exportQuery.error).message} />
          )}

          {!loading && !schemaQuery.error && !exportQuery.error && !generated && (
            <>
              <Field label={`Prompt (current data: ${currentRows} row${currentRows === 1 ? "" : "s"})`}>
                <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={10} />
              </Field>
              <PrimaryButton onClick={() => generate.mutate()} loading={generate.isPending} disabled={!prompt?.trim() || pending}>
                <Wand2 size={16} />
                {generate.isPending ? "Generating…" : "Generate"}
              </PrimaryButton>
              <OutlineButton onClick={onClose} disabled={pending} className="mt-2">
                Cancel
              </OutlineButton>
            </>
          )}

          {generated && (
            <>
              <p className="text-xs text-gray-500 mb-2">
                Generated file: {generated.rows} data row{generated.rows === 1 ? "" : "s"} (was {currentRows}). Preview:
              </p>
              <pre className="border border-gray-200 rounded-xl bg-gray-50 text-xs text-gray-800 px-3 py-2 overflow-x-auto max-h-56 overflow-y-auto mb-3">
                {previewLines.join("\n")}
                {generated.csv.split("\n").length > 15 ? "\n…" : ""}
              </pre>
              <PrimaryButton onClick={() => save.mutate()} loading={save.isPending} disabled={pending}>
                Save — Upload Schema &amp; Run Full Aggregation
              </PrimaryButton>
              <OutlineButton onClick={() => setGenerated(null)} disabled={pending} className="mt-2">
                Back to Prompt
              </OutlineButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AccountsPanel({ sourceId, sourceType, sourceName }) {
  const navigate = useNavigate();
  const { search, debouncedSearch, handleSearch } = useUrlSearch("aq");
  const [viewingAccount, setViewingAccount] = useState(null);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [ldapOpen, setLdapOpen] = useState(false);
  const queryClient = useQueryClient();
  // Page offset in the URL, so Back returns to the same page; a new search
  // starts from the first page.
  const [offsetStr, setOffsetStr] = useUrlState("ao", "0");
  // ISC stops paging at 10,000 (offset + limit); clamp rather than 400.
  const offset = Math.min(Math.max(Number(offsetStr) || 0, 0), iscMaxOffset(ACCOUNTS_PAGE_SIZE));
  const setOffset = (n) => setOffsetStr(String(n));
  const handleSearchAndReset = (v) => { handleSearch(v); if (offset) setOffset(0); };

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ["source-accounts", sourceId, debouncedSearch, offset],
    queryFn: () => listAccountsBySource(sourceId, { limit: ACCOUNTS_PAGE_SIZE, offset, query: debouncedSearch || undefined }),
    keepPreviousData: true,
  });
  const list = Array.isArray(data?.accounts) ? data.accounts : [];
  // ISC's own count when it gave one; otherwise the pager just offers Next
  // while a page comes back full.
  const total = data?.totalIsExact && typeof data.total === "number" ? data.total : undefined;
  const tenant = getCredentials()?.tenant;

  const print = useMutation({
    mutationFn: async () => {
      const all = await listAllAccountsBySource(sourceId, { query: debouncedSearch || undefined });
      if (!printSourceAccountsPdf({ tenant, sourceName, accounts: all, query: debouncedSearch || "" })) toast("Pop-up blocked — downloaded the PDF instead");
      return all.length;
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const pager = (
    <Pager offset={offset} pageSize={ACCOUNTS_PAGE_SIZE} total={total} noun="account" onOffsetChange={setOffset} hasNext={total === undefined ? list.length === ACCOUNTS_PAGE_SIZE : undefined} busy={isFetching} maxOffset={iscMaxOffset(ACCOUNTS_PAGE_SIZE)} />
  );

  return (
    <div>
      {/* Delimited File / Generic only. Always shown — not just when the list
          below has rows — so an empty source, or a search with no matches,
          still has a way in (Edit Accounts is also where the first record
          gets added). */}
      {isEditableAccountSourceType(sourceType) && (
        <div className="flex items-center gap-2 flex-wrap px-4 pt-3">
          <button
            type="button"
            onClick={() => navigate(`/sources/${sourceId}/edit-accounts`)}
            title="Export this source's account file, edit records one at a time or in a batch, then re-aggregate"
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800 transition-colors"
          >
            <Pencil size={13} />
            Edit Accounts
          </button>
          <button
            type="button"
            onClick={() => setGenerateOpen(true)}
            title="Generate Data — AI-modify this source's account CSV, then re-upload schema and aggregate"
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 active:bg-gray-100 transition-colors"
          >
            <Wand2 size={13} />
            Generate Data
          </button>
          {/* Only for the ISC Admins source on an identitynow-demo.com tenant. */}
          {isIscAdminsSource({ name: sourceName }) && isDemoDomainTenant(tenant) && <AddSailPointUserPill onOpen={() => setLdapOpen(true)} />}
        </div>
      )}
      {ldapOpen && (
        <AddFromLdapModal
          sourceId={sourceId}
          sourceName={sourceName}
          onClose={() => {
            setLdapOpen(false);
            queryClient.invalidateQueries({ queryKey: ["source-accounts", sourceId] });
          }}
        />
      )}
      <SearchBar value={search} onChange={handleSearchAndReset} placeholder="Search accounts…" />
      {isLoading && <SkeletonList rows={4} />}
      {error && <ErrorBox message={error.message} />}
      {!isLoading && !error && list.length === 0 && (
        <EmptyState
          icon={Server}
          title={debouncedSearch ? "No results" : offset > 0 ? "No more accounts" : "No accounts"}
          subtitle={debouncedSearch ? `No accounts match "${debouncedSearch}"` : offset > 0 ? "This page is past the end of the list." : "This source has no accounts"}
          action={offset > 0 ? <OutlineButton onClick={() => setOffset(0)} className="!w-auto mt-3">Back to first page</OutlineButton> : undefined}
        />
      )}
      {!isLoading && list.length > 0 && (
        <>
          <div className="flex items-center justify-end px-4 pt-2 gap-3">
            <IconButton
              icon={Printer}
              title={`Print account list${total !== undefined ? ` (${total.toLocaleString()} accounts)` : ""}${debouncedSearch ? ` matching "${debouncedSearch}"` : ""}`}
              onClick={() => print.mutate()}
              loading={print.isPending}
            />
          </div>
          {pager}
          {list.map((acct) => (
            <button
              key={acct.id}
              onClick={() => setViewingAccount(acct)}
              className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
            >
              <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                <Server size={14} className="text-gray-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{acct.name || acct.nativeIdentity}</p>
                {/* Second line: the linked identity — a link straight to its
                    Identity detail page (a span, not a nested button — the
                    row is already one — with stopPropagation so the row's
                    own account modal doesn't also open) — or "Uncorrelated"
                    when ISC hasn't linked the account to anyone. */}
                {linkedIdentity(acct) ? (
                  <p className="text-xs mt-0.5 truncate">
                    <span
                      role="link"
                      tabIndex={0}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/identities/${linkedIdentity(acct).id}`);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.stopPropagation();
                          navigate(`/identities/${linkedIdentity(acct).id}`);
                        }
                      }}
                      className="text-blue-600 hover:underline"
                    >
                      {linkedIdentity(acct).name}
                    </span>
                  </p>
                ) : (
                  <p className="text-xs mt-0.5 truncate">
                    <span className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-px font-medium">Uncorrelated</span>
                  </p>
                )}
              </div>
              <span
                className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 ${
                  acct.disabled
                    ? "bg-gray-100 text-gray-500 border-gray-200"
                    : "bg-green-50 text-green-700 border-green-200"
                }`}
              >
                {acct.disabled ? "Disabled" : "Active"}
              </span>
            </button>
          ))}
          {pager}
        </>
      )}
      {viewingAccount && (
        <AccountDetailModal account={viewingAccount} onClose={() => setViewingAccount(null)} />
      )}
      {generateOpen && (
        <GenerateDataModal sourceId={sourceId} sourceName={sourceName} onClose={() => setGenerateOpen(false)} />
      )}
    </div>
  );
}

// ─── Aggregation history panel ───────────────────────────────────────────────────

const TASK_STATUS_STYLES = {
  SUCCESS: "bg-green-50 text-green-700 border-green-200",
  ERROR: "bg-red-50 text-red-700 border-red-200",
  WARNING: "bg-amber-50 text-amber-800 border-amber-200",
  TERMINATED: "bg-gray-100 text-gray-500 border-gray-200",
};

// A task's messages come straight through from ISC's task-status object
// (the history route filters but doesn't reshape). Each message's text
// lives under localizedText.message in the documented model; older or
// differently-shaped entries are read leniently rather than dropped.
function taskMessageText(m) {
  if (typeof m === "string") return m;
  return m?.localizedText?.message || m?.text || m?.message || m?.key || JSON.stringify(m);
}
const TASK_MESSAGE_STYLES = {
  ERROR: "bg-red-50 text-red-700 border-red-200",
  WARN: "bg-amber-50 text-amber-800 border-amber-200",
  WARNING: "bg-amber-50 text-amber-800 border-amber-200",
};

function AggregationHistoryPanel({ sourceId }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["source-aggregation-history", sourceId],
    queryFn: () => getSourceAggregationHistory(sourceId),
    refetchInterval: (query) => (query.state.data?.some((t) => !t.completed) ? 4000 : false),
  });
  const list = Array.isArray(data) ? data : [];
  // Which tasks have their message panel open, and which of those are also
  // showing the raw task object — the fallback for a failure whose reason
  // ISC put somewhere other than `messages`.
  const [openIds, setOpenIds] = useState(() => new Set());
  const [rawIds, setRawIds] = useState(() => new Set());
  const toggleIn = (setter) => (id) =>
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleOpen = toggleIn(setOpenIds);
  const toggleRaw = toggleIn(setRawIds);

  if (isLoading) return <SkeletonList rows={4} />;
  if (error) return <ErrorBox message={error.message} />;
  if (list.length === 0) {
    return <EmptyState icon={History} title="No aggregation history" subtitle="No aggregation tasks have run for this source yet" />;
  }

  return (
    <div>
      {list.map((t) => {
        const running = !t.completed;
        const style = running ? "bg-blue-50 text-blue-700 border-blue-200" : (TASK_STATUS_STYLES[t.completionStatus] || "bg-gray-100 text-gray-500 border-gray-200");
        const messages = Array.isArray(t.messages) ? t.messages : [];
        const isOpen = openIds.has(t.id);
        return (
          <div key={t.id} className="border-b border-gray-100">
            <div className="px-4 py-3.5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-sm font-medium text-gray-900 truncate">
                  {t.taskDefinitionSummary?.uniqueName || t.uniqueName}
                </p>
                {/* The status badge is the click target for a finished task's
                    detail — an ERROR badge is exactly where you'd look for
                    the reason, and it keeps the row free of a second control. */}
                {running ? (
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 ${style}`}>Running</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleOpen(t.id)}
                    title={isOpen ? "Hide task details" : "Show task messages"}
                    className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 flex items-center gap-1 hover:opacity-80 transition-opacity ${style}`}
                  >
                    {t.completionStatus || "Unknown"}
                    <ChevronDown size={11} className={`transition-transform ${isOpen ? "" : "-rotate-90"}`} />
                  </button>
                )}
              </div>
              <p className="text-xs text-gray-500">
                Launched {t.launched ? new Date(t.launched).toLocaleString() : "—"}
                {t.completed && ` · Completed ${new Date(t.completed).toLocaleString()}`}
              </p>
            </div>

            {isOpen && (
              <div className="px-4 pb-3.5">
                {messages.length > 0 ? (
                  <div className="space-y-1.5">
                    {messages.map((m, i) => {
                      const type = String(m?.type || "").toUpperCase();
                      const mstyle = TASK_MESSAGE_STYLES[type] || "bg-gray-50 text-gray-700 border-gray-200";
                      return (
                        <div key={i} className={`border rounded-lg px-3 py-2 ${mstyle}`}>
                          {type && <p className="text-[10px] font-semibold uppercase tracking-wide opacity-70 mb-0.5">{type}</p>}
                          <p className="text-xs whitespace-pre-wrap break-words">{taskMessageText(m)}</p>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">
                    ISC recorded no messages for this task
                    {t.completionStatus === "ERROR" ? " — the failure reason may be in the raw task object below." : "."}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => toggleRaw(t.id)}
                  className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 mt-2"
                >
                  <ChevronDown size={12} className={`transition-transform ${rawIds.has(t.id) ? "" : "-rotate-90"}`} />
                  {rawIds.has(t.id) ? "Hide raw task JSON" : "Show raw task JSON"}
                </button>
                {rawIds.has(t.id) && (
                  <pre
                    className="mt-2 border border-gray-200 rounded-xl overflow-auto text-gray-800 bg-gray-50"
                    style={JSON_EDITOR_STYLE}
                    dangerouslySetInnerHTML={{ __html: highlightJson(escapeHtml(JSON.stringify(t, null, 2))) }}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Entitlement Schema panel ─────────────────────────────────────────────────

// Server-owned fields on a schema — held read-only in the editor. The
// whole object is PUT back regardless (that's the proven write for schemas
// on this tenant), and the proxy forces `id` from the path.
const SCHEMA_READ_ONLY = ["id", "created", "modified"];

// One non-account schema. Collapsed by default; the header is the click
// target that expands it to its JSON. Open/closed lives in the panel (so
// expand/collapse-all can drive every card), but edit state stays here —
// collapsing a card mid-edit hides the editor without discarding it, and
// the header says so.
function SchemaJsonCard({ sourceId, schema, open, onToggle }) {
  const queryClient = useQueryClient();
  const pretty = useMemo(() => JSON.stringify(schema, null, 2), [schema]);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(pretty);
  const parseError = editing ? jsonParseError(text) : null;
  const attrCount = Array.isArray(schema.attributes) ? schema.attributes.length : 0;

  const save = useMutation({
    mutationFn: () => updateSourceSchema(sourceId, schema.id, JSON.parse(text)),
    onSuccess: () => {
      toast.success(`Schema "${schema.name}" saved`);
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["source-schemas", sourceId] });
      // The Schema tab and anything keyed on the account schema read the
      // same underlying objects.
      queryClient.invalidateQueries({ queryKey: ["source-account-schema", sourceId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });

  return (
    <div className="border-b border-gray-100">
      <div className="flex items-start gap-3 px-4 py-3.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex-1 min-w-0 flex items-start gap-2 text-left"
        >
          <ChevronDown size={14} className={`text-gray-400 flex-shrink-0 mt-0.5 transition-transform ${open ? "" : "-rotate-90"}`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-medium text-gray-900 truncate">{schema.name || schema.id}</p>
              {editing && !open && (
                <span className="text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded-full">
                  unsaved edit
                </span>
              )}
            </div>
            <p className="text-xs text-gray-500">
              {attrCount} attribute{attrCount === 1 ? "" : "s"}
              {schema.nativeObjectType && ` · native type ${schema.nativeObjectType}`}
              {schema.identityAttribute && ` · ID ${schema.identityAttribute}`}
              {schema.displayAttribute && ` · display ${schema.displayAttribute}`}
            </p>
            {schema.id && <p className="text-[11px] text-gray-400 font-mono truncate mt-0.5">{schema.id}</p>}
          </div>
        </button>
        {open && !editing && (
          <IconButton icon={Pencil} title={`Edit "${schema.name}" schema JSON`} onClick={() => { setText(pretty); setEditing(true); }} />
        )}
      </div>

      {open && (
        <div className="px-4 pb-4">
          {!editing ? (
            <pre
              className="border border-gray-200 rounded-xl overflow-auto text-gray-800 bg-gray-50"
              style={JSON_EDITOR_STYLE}
              dangerouslySetInnerHTML={{ __html: highlightJson(escapeHtml(pretty)) }}
            />
          ) : (
            <>
              <p className="text-xs text-gray-500 mb-2">
                The whole schema is saved as edited (full replace). <span className="font-mono">id</span>,{" "}
                <span className="font-mono">created</span> and <span className="font-mono">modified</span> are server-owned.
              </p>
              <JsonEditTabs
                text={text}
                onChange={setText}
                readOnlyKeys={SCHEMA_READ_ONLY}
                minHeight="260px"
                title={`${schema.name} — schema`}
              />
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
      )}
    </div>
  );
}

function EntitlementSchemasPanel({ sourceId }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["source-schemas", sourceId],
    queryFn: () => listSourceSchemas(sourceId),
  });
  // The account schema has its own tab; everything else on the source
  // (group, role, whatever the connector defines) is an entitlement schema.
  const schemas = (Array.isArray(data) ? data : []).filter((sc) => sc.name !== "account");
  const keyOf = (sc) => sc.id || sc.name;
  // Starts empty = everything collapsed; the header icon flips all at once.
  const [openIds, setOpenIds] = useState(() => new Set());
  const allOpen = schemas.length > 0 && schemas.every((sc) => openIds.has(keyOf(sc)));
  const toggleOne = (key) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleAll = () => setOpenIds(allOpen ? new Set() : new Set(schemas.map(keyOf)));

  if (isLoading) return <SkeletonList rows={4} />;
  if (error) return <ErrorBox message={error.message} />;
  if (schemas.length === 0) {
    return <EmptyState icon={ListTree} title="No entitlement schemas" subtitle="This source only has an account schema — see the Schema tab" />;
  }

  return (
    <div>
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <p className="text-xs text-gray-400">
          {schemas.length} entitlement schema{schemas.length === 1 ? "" : "s"}
        </p>
        <IconButton
          icon={allOpen ? ChevronsDownUp : ChevronsUpDown}
          title={allOpen ? "Collapse all" : "Expand all"}
          onClick={toggleAll}
        />
      </div>
      {schemas.map((sc) => (
        // Keyed on id so a card's edit state survives list refetches.
        <SchemaJsonCard
          key={keyOf(sc)}
          sourceId={sourceId}
          schema={sc}
          open={openIds.has(keyOf(sc))}
          onToggle={() => toggleOne(keyOf(sc))}
        />
      ))}
    </div>
  );
}

// ─── Datasets panel ───────────────────────────────────────────────────────────

// Shape per the SailPoint Go SDK's SourceDataset model (the endpoint lives
// on the un-versioned /sources/v1 surface and isn't in the public API docs):
// { id, name, description, aggregationEnabled, resources: [{id, name, type}] }.

// PATCH .../datasets/{id} is whitelisted, not open (per the SDK's
// UpdateSourceDatasetV1 description): aggregationEnabled may always change;
// name, description and resources only when the source's connector carries
// the supportDatasetCreation label; id is immutable. Any other key in the
// GET representation is rejected outright as 400.1 "semantically invalid" —
// verified live, that's what a plain top-level diff produced. So only these
// four are ever diffed, and everything else is held read-only in the editor.
const DATASET_PATCHABLE = new Set(["name", "description", "aggregationEnabled", "resources"]);
const DATASET_CONNECTOR_GATED = new Set(["name", "description", "resources"]);
const patchKey = (op) => op.path.slice(1).split("/")[0];

// One row owns its own JSON view/edit state so editing one dataset doesn't
// disturb another's expanded view. Same view → pencil → validated editor →
// Save-sends-only-the-diff contract as RawJsonPanel.
function DatasetRow({ sourceId, d, index, aggregate }) {
  const queryClient = useQueryClient();
  const pretty = useMemo(() => JSON.stringify(d, null, 2), [d]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(pretty);
  const parseError = editing ? jsonParseError(text) : null;
  // Every key the tenant returned that isn't patchable — greyed out in Tree
  // mode and excluded from the diff, whatever it's called.
  const readOnlyKeys = useMemo(() => Object.keys(d).filter((k) => !DATASET_PATCHABLE.has(k)), [d]);

  // The ops travel as the mutation variable (not computed inside mutationFn)
  // so onError can see which fields were in the rejected patch.
  const save = useMutation({
    mutationFn: (ops) => updateSourceDataset(sourceId, d.id, ops),
    onSuccess: () => {
      toast.success("Dataset saved");
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["source-datasets", sourceId] });
    },
    onError: (err, ops) => {
      // ISC's own reason comes first (the proxy passes through its
      // messages + causes). A 400 on a connector-gated field is *usually*
      // the capability limit, but not provably so from here — a value
      // validation failure returns the same status — so that's added as a
      // hint after ISC's text, not asserted in place of it.
      const reason = err.response?.data?.error || err.message;
      const gated = [...new Set(ops.map(patchKey).filter((k) => DATASET_CONNECTOR_GATED.has(k)))];
      if (err.response?.status === 400 && gated.length > 0) {
        toast.error(
          `${reason}\n\nNote: ${gated.join(", ")} can only be edited when this source's connector supports ` +
          `dataset creation (the supportDatasetCreation label); aggregationEnabled can always be changed.`,
          { duration: 10000 }
        );
        return;
      }
      toast.error(reason);
    },
  });

  function onSave() {
    const edited = JSON.parse(text);
    const all = buildPatchOps(d, edited, new Set(readOnlyKeys));
    // A key typed fresh into the editor isn't in readOnlyKeys (that's derived
    // from what the tenant returned) but isn't patchable either — drop it
    // and say so rather than let the whole save fail on it.
    const ops = all.filter((op) => DATASET_PATCHABLE.has(patchKey(op)));
    const dropped = [...new Set(all.filter((op) => !DATASET_PATCHABLE.has(patchKey(op))).map(patchKey))];
    if (dropped.length) toast(`Ignored ${dropped.join(", ")} — not a patchable dataset field.`);
    if (ops.length === 0) {
      toast.success("No changes to save");
      setEditing(false);
      return;
    }
    save.mutate(ops);
  }

  const resources = Array.isArray(d.resources) ? d.resources : [];
  // Shown as a flag, not used to disable the button: the model only says
  // whether aggregation is enabled on the source's schedule, and an
  // on-demand run may still be allowed — let the API be the judge and
  // surface its answer as the toast rather than pre-empting it.
  const enabled = d.aggregationEnabled !== false;
  const name = d.name || d.id || "Untitled dataset";

  return (
    <div className="border-b border-gray-100">
      <div className="flex items-start gap-3 px-4 py-3.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <p className="text-sm font-medium text-gray-900 truncate">{name}</p>
            <span
              className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 ${
                enabled ? "bg-emerald-50 text-emerald-700 border-emerald-100" : "bg-gray-100 text-gray-500 border-gray-200"
              }`}
            >
              Aggregation {enabled ? "On" : "Off"}
            </span>
          </div>
          {d.description && <p className="text-xs text-gray-600 mb-1.5">{d.description}</p>}
          {resources.length > 0 ? (
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {resources.map((r, ri) => (
                <span
                  key={r.id || ri}
                  className="text-xs bg-violet-50 text-violet-700 border border-violet-100 px-2 py-0.5 rounded-full"
                  title={r.id}
                >
                  {r.name || r.id}
                  {r.type && <span className="text-violet-400"> · {r.type}</span>}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400 mb-1.5">No resources</p>
          )}
          {d.id && <p className="text-[11px] text-gray-400 font-mono truncate">{d.id}</p>}
          {/* Always dismissible — this used to be disabled mid-edit, which
              left the panel stuck open after a failed save with no visible
              reason (browsers don't show a title on a disabled button).
              Hiding only collapses the panel: an in-progress edit is kept,
              flagged on the button, and restored on reopen. */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 mt-2"
          >
            <ChevronDown size={12} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
            {open ? "Hide JSON" : editing ? "Show JSON (unsaved edit)" : "Show JSON"}
          </button>
        </div>
        <IconButton
          icon={RefreshCw}
          title={`Aggregate "${name}"`}
          onClick={() => d.id && aggregate.mutate(d.id)}
          loading={aggregate.isPending && aggregate.variables === d.id}
          disabled={!d.id || aggregate.isPending}
        />
      </div>

      {open && (
        <div className="px-4 pb-3.5">
          {!editing ? (
            <>
              <div className="flex items-center justify-between mb-2 gap-3">
                <p className="text-xs text-gray-500">The dataset as ISC returns it.</p>
                <IconButton
                  icon={Pencil}
                  title="Edit dataset JSON"
                  onClick={() => { setText(pretty); setEditing(true); }}
                  disabled={!d.id}
                />
              </div>
              <pre
                className="border border-gray-200 rounded-xl overflow-auto text-gray-800 bg-gray-50"
                style={JSON_EDITOR_STYLE}
                dangerouslySetInnerHTML={{ __html: highlightJson(escapeHtml(pretty)) }}
              />
            </>
          ) : (
            <>
              <p className="text-xs text-gray-500 mb-2">
                Only fields you change are sent (as JSON-Patch). <span className="font-mono">aggregationEnabled</span> can
                always be changed; <span className="font-mono">name</span>, <span className="font-mono">description</span> and{" "}
                <span className="font-mono">resources</span> only if this source's connector supports dataset creation.
                Everything else is read-only.
              </p>
              <JsonEditTabs
                text={text}
                onChange={setText}
                readOnlyKeys={readOnlyKeys}
                minHeight="200px"
                title={`${name} — dataset`}
              />
              <div className="flex gap-2 mt-3">
                <PrimaryButton onClick={onSave} loading={save.isPending} disabled={!!parseError} className="!w-auto flex-1">
                  Save
                </PrimaryButton>
                <OutlineButton onClick={() => setEditing(false)} disabled={save.isPending} className="!w-auto flex-1">
                  Cancel
                </OutlineButton>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DatasetsPanel({ sourceId }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["source-datasets", sourceId],
    queryFn: () => listSourceDatasets(sourceId),
  });
  const list = Array.isArray(data) ? data : [];

  // One mutation for the whole list, keyed on the dataset id it was called
  // with, so only the clicked row's icon spins (same pattern as the Role
  // Evaluation report's per-row Accept).
  const aggregate = useMutation({
    mutationFn: (datasetId) => aggregateSourceDataset(sourceId, datasetId),
    onSuccess: (_result, datasetId) => {
      const name = list.find((d) => d.id === datasetId)?.name || "dataset";
      toast.success(`Aggregation started for "${name}"`);
      // It lands in the source's task history like any other aggregation.
      queryClient.invalidateQueries({ queryKey: ["source-aggregation-history", sourceId] });
      queryClient.invalidateQueries({ queryKey: ["source-datasets", sourceId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  if (isLoading) return <SkeletonList rows={4} />;
  if (error) return <ErrorBox message={error.message} />;
  if (list.length === 0) {
    return <EmptyState icon={Layers} title="No datasets" subtitle="This source has no datasets defined" />;
  }

  return (
    <div>
      {list.map((d, i) => (
        // Keyed on id so a row's edit state survives list refetches; the
        // index fallback only matters for a dataset with no id at all.
        <DatasetRow key={d.id || `dataset-${i}`} sourceId={sourceId} d={d} index={i} aggregate={aggregate} />
      ))}
    </div>
  );
}

// ─── Resources panel ──────────────────────────────────────────────────────────

// Shape per the SDK's SourceDatasetResource model:
// { id, name, type, datasetId, features: [], schema }.
//
// The PATCH endpoint's rules are looser on paper than the dataset one's —
// "connectors with the supportDatasetCreation label can update additional
// resource fields", with nothing promised as always-writable — and schema
// edits are explicitly directed to the schema APIs (the Entitlement Schema
// tab here). So only these four are ever diffed; id and schema are held
// read-only, and a 400 shows ISC's own reason with the label rule as a note.
const RESOURCE_PATCHABLE = new Set(["name", "type", "datasetId", "features"]);
const resourcePatchKey = (op) => op.path.slice(1).split("/")[0];

// One row owns its JSON view/edit state — same contract as DatasetRow.
// datasetName is resolved by the panel from the (already cached) datasets
// list, so the row can show which dataset it belongs to by name.
function ResourceRow({ sourceId, r, datasetName }) {
  const queryClient = useQueryClient();
  const pretty = useMemo(() => JSON.stringify(r, null, 2), [r]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(pretty);
  const parseError = editing ? jsonParseError(text) : null;
  const readOnlyKeys = useMemo(() => Object.keys(r).filter((k) => !RESOURCE_PATCHABLE.has(k)), [r]);

  const save = useMutation({
    mutationFn: (ops) => updateSourceResource(sourceId, r.id, ops),
    onSuccess: () => {
      toast.success("Resource saved");
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["source-resources", sourceId] });
    },
    onError: (err, ops) => {
      const reason = err.response?.data?.error || err.message;
      const fields = [...new Set(ops.map(resourcePatchKey))];
      if (err.response?.status === 400 && fields.length > 0) {
        toast.error(
          `${reason}\n\nNote: resource fields can only be edited when this source's connector supports ` +
          `dataset creation (the supportDatasetCreation label). Schema changes go through the Entitlement Schema tab.`,
          { duration: 10000 }
        );
        return;
      }
      toast.error(reason);
    },
  });

  function onSave() {
    const edited = JSON.parse(text);
    const all = buildPatchOps(r, edited, new Set(readOnlyKeys));
    const ops = all.filter((op) => RESOURCE_PATCHABLE.has(resourcePatchKey(op)));
    const dropped = [...new Set(all.filter((op) => !RESOURCE_PATCHABLE.has(resourcePatchKey(op))).map(resourcePatchKey))];
    if (dropped.length) toast(`Ignored ${dropped.join(", ")} — not a patchable resource field.`);
    if (ops.length === 0) {
      toast.success("No changes to save");
      setEditing(false);
      return;
    }
    save.mutate(ops);
  }

  const features = Array.isArray(r.features) ? r.features : [];
  const attrCount = Array.isArray(r.schema?.attributes) ? r.schema.attributes.length : null;
  const name = r.name || r.id || "Untitled resource";

  return (
    <div className="border-b border-gray-100">
      <div className="px-4 py-3.5">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <p className="text-sm font-medium text-gray-900 truncate">{name}</p>
          {r.type && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-violet-50 text-violet-700 border-violet-100 flex-shrink-0">
              {r.type}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-500">
          {r.datasetId ? `Dataset: ${datasetName || r.datasetId}` : "No dataset"}
          {attrCount !== null && ` · ${attrCount} schema attribute${attrCount === 1 ? "" : "s"}`}
          {r.schema?.identityAttribute && ` · ID ${r.schema.identityAttribute}`}
          {r.schema?.displayAttribute && ` · display ${r.schema.displayAttribute}`}
        </p>
        {features.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {features.map((f) => (
              <span key={f} className="text-[11px] bg-gray-100 text-gray-600 border border-gray-200 px-2 py-0.5 rounded-full">{f}</span>
            ))}
          </div>
        )}
        {r.id && <p className="text-[11px] text-gray-400 font-mono truncate mt-1">{r.id}</p>}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 mt-2"
        >
          <ChevronDown size={12} className={`transition-transform ${open ? "" : "-rotate-90"}`} />
          {open ? "Hide JSON" : editing ? "Show JSON (unsaved edit)" : "Show JSON"}
        </button>
      </div>

      {open && (
        <div className="px-4 pb-3.5">
          {!editing ? (
            <>
              <div className="flex items-center justify-between mb-2 gap-3">
                <p className="text-xs text-gray-500">The resource as ISC returns it.</p>
                <IconButton icon={Pencil} title="Edit resource JSON" onClick={() => { setText(pretty); setEditing(true); }} disabled={!r.id} />
              </div>
              <pre
                className="border border-gray-200 rounded-xl overflow-auto text-gray-800 bg-gray-50"
                style={JSON_EDITOR_STYLE}
                dangerouslySetInnerHTML={{ __html: highlightJson(escapeHtml(pretty)) }}
              />
            </>
          ) : (
            <>
              <p className="text-xs text-gray-500 mb-2">
                Only fields you change are sent (as JSON-Patch). <span className="font-mono">name</span>,{" "}
                <span className="font-mono">type</span>, <span className="font-mono">datasetId</span> and{" "}
                <span className="font-mono">features</span> can be edited if this source's connector supports dataset
                creation. <span className="font-mono">schema</span> is edited on the Entitlement Schema tab; everything
                else is read-only.
              </p>
              <JsonEditTabs text={text} onChange={setText} readOnlyKeys={readOnlyKeys} minHeight="200px" title={`${name} — resource`} />
              <div className="flex gap-2 mt-3">
                <PrimaryButton onClick={onSave} loading={save.isPending} disabled={!!parseError} className="!w-auto flex-1">
                  Save
                </PrimaryButton>
                <OutlineButton onClick={() => setEditing(false)} disabled={save.isPending} className="!w-auto flex-1">
                  Cancel
                </OutlineButton>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ResourcesPanel({ sourceId }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["source-resources", sourceId],
    queryFn: () => listSourceResources(sourceId),
  });
  // Same query key the Datasets tab uses, so this is usually a cache hit —
  // and it's only here to turn each resource's datasetId into a name.
  const datasetsQuery = useQuery({
    queryKey: ["source-datasets", sourceId],
    queryFn: () => listSourceDatasets(sourceId),
  });
  const datasetNames = useMemo(() => {
    const m = new Map();
    for (const d of Array.isArray(datasetsQuery.data) ? datasetsQuery.data : []) if (d?.id) m.set(d.id, d.name);
    return m;
  }, [datasetsQuery.data]);
  const list = Array.isArray(data) ? data : [];

  if (isLoading) return <SkeletonList rows={4} />;
  if (error) return <ErrorBox message={error.message} />;
  if (list.length === 0) {
    return <EmptyState icon={Boxes} title="No resources" subtitle="This source has no resources defined" />;
  }

  return (
    <div>
      <div className="px-4 py-3 border-b border-gray-100">
        <p className="text-xs text-gray-400">{list.length} resource{list.length === 1 ? "" : "s"}</p>
      </div>
      {list.map((r, i) => (
        <ResourceRow key={r.id || `resource-${i}`} sourceId={sourceId} r={r} datasetName={datasetNames.get(r.datasetId)} />
      ))}
    </div>
  );
}

// ─── Applications panel ─────────────────────────────────────────────────────────

function ApplicationsPanel({ sourceId, sourceName }) {
  const { session } = useAuth();
  const currentUser = session?.identity
    ? { id: session.identity.id, name: session.identity.displayName || session.identity.username }
    : null;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { search, debouncedSearch, handleSearch } = useUrlSearch("appq");
  const [selected, setSelected] = useState(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [creating, setCreating] = useState(false);
  const [descriptionResults, setDescriptionResults] = useState(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["source-apps", sourceId],
    queryFn: () => listSourceApps(sourceId),
  });

  const list = (Array.isArray(data) ? data : [])
    .filter((a) => !debouncedSearch || a.name?.toLowerCase().includes(debouncedSearch.toLowerCase()))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const appById = new Map(list.map((a) => [a.id, a]));
  const allSelected = list.length > 0 && list.every((a) => selected.has(a.id));

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => (allSelected ? new Set() : new Set(list.map((a) => a.id))));
  }

  const createApp = useMutation({
    mutationFn: ({ name, owner, matchAllAccounts }) => createSourceApp(sourceId, { name, owner, matchAllAccounts }),
    onSuccess: () => {
      toast.success("Application created");
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ["source-apps", sourceId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const togglePillField = useMutation({
    mutationFn: ({ id, field, value }) => updateSourceApp(id, { [field]: value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["source-apps", sourceId] }),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const bulkDelete = useMutation({
    mutationFn: async () => {
      const ids = [...selected];
      const results = [];
      for (const id of ids) {
        try {
          await deleteSourceApp(id);
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
        toast.error(`Deleted ${results.length - failed.length} of ${results.length} applications — ${failed.length} failed`);
      } else {
        toast.success(`Deleted ${results.length} application${results.length === 1 ? "" : "s"}`);
      }
      setSelected(new Set());
      setConfirmOpen(false);
      setProgress(0);
      queryClient.invalidateQueries({ queryKey: ["source-apps", sourceId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const generateDescriptions = useMutation({
    mutationFn: () => generateAllSourceAppDescriptions(list.map((a) => a.id)),
    onSuccess: (result) => setDescriptionResults(result.results),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const saveDescriptions = useMutation({
    mutationFn: (items) => Promise.all(items.map(({ roleId, description }) => updateSourceApp(roleId, { description }))),
    onSuccess: (_result, items) => {
      toast.success(`${items.length} description${items.length === 1 ? "" : "s"} saved`);
      queryClient.invalidateQueries({ queryKey: ["source-apps", sourceId] });
      setDescriptionResults(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Bulk versions of the per-row Enable/Disable and Requestable/No Requests
  // pills, applied to every selected application.
  function makeBulkToggle({ label, verb, field, value }) {
    return useMutation({
      mutationFn: async () => {
        const ids = [...selected];
        const results = [];
        for (const id of ids) {
          try {
            await updateSourceApp(id, { [field]: value });
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
          toast.error(`${verb} ${results.length - failed.length} of ${results.length} ${label} — ${failed.length} failed`);
        } else {
          toast.success(`${verb} ${results.length} application${results.length === 1 ? "" : "s"}`);
        }
        setSelected(new Set());
        setProgress(0);
        queryClient.invalidateQueries({ queryKey: ["source-apps", sourceId] });
      },
      onError: (err) => toast.error(err.response?.data?.error || err.message),
    });
  }

  const bulkEnable = makeBulkToggle({ label: "enabled", verb: "Enabled", field: "enabled", value: true });
  const bulkDisable = makeBulkToggle({ label: "disabled", verb: "Disabled", field: "enabled", value: false });
  const bulkMakeRequestable = makeBulkToggle({ label: "requestable", verb: "Made requestable", field: "provisionRequestEnabled", value: true });
  const bulkNoRequests = makeBulkToggle({ label: "no-requests", verb: "Set to no requests", field: "provisionRequestEnabled", value: false });

  const bulkActionPending =
    bulkEnable.isPending || bulkDisable.isPending || bulkMakeRequestable.isPending || bulkNoRequests.isPending;

  return (
    <div>
      <SearchBar value={search} onChange={handleSearch} placeholder="Search applications…" />

      <div className="flex items-center justify-between px-4 pb-2 gap-3">
        <label className="flex items-center gap-2 text-xs text-gray-500">
          {list.length > 0 && (
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              className="w-4 h-4 rounded border-gray-300"
            />
          )}
          {list.length} application{list.length !== 1 && "s"}{debouncedSearch && " matching"}
        </label>
        <div className="flex items-center gap-1 flex-shrink-0">
          <IconButton icon={Plus} title="Create Application" onClick={() => setCreating(true)} />
          <IconButton
            icon={Wand2}
            title="Generate descriptions for the applications currently shown"
            onClick={() => generateDescriptions.mutate()}
            loading={generateDescriptions.isPending}
            disabled={list.length === 0}
          />
        </div>
      </div>

      {selected.size > 0 && (
        <div className="px-4 pb-2 flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <OutlineButton onClick={() => bulkEnable.mutate()} loading={bulkEnable.isPending} disabled={bulkActionPending}>
              Enable ({selected.size})
            </OutlineButton>
            <OutlineButton onClick={() => bulkDisable.mutate()} loading={bulkDisable.isPending} disabled={bulkActionPending}>
              Disable ({selected.size})
            </OutlineButton>
            <OutlineButton onClick={() => bulkMakeRequestable.mutate()} loading={bulkMakeRequestable.isPending} disabled={bulkActionPending}>
              Make Requestable ({selected.size})
            </OutlineButton>
            <OutlineButton onClick={() => bulkNoRequests.mutate()} loading={bulkNoRequests.isPending} disabled={bulkActionPending}>
              No Requests ({selected.size})
            </OutlineButton>
          </div>
          <OutlineButton
            onClick={() => setConfirmOpen(true)}
            className="!border-red-200 !text-red-600 hover:!bg-red-50"
          >
            <Trash2 size={16} />
            Delete Selected Applications ({selected.size})
          </OutlineButton>
        </div>
      )}

      {isLoading && <SkeletonList rows={4} />}
      {error && <ErrorBox message={error.message} />}
      {!isLoading && !error && list.length === 0 && (
        <EmptyState
          icon={LayoutGrid}
          title={debouncedSearch ? "No results" : "No applications"}
          subtitle={debouncedSearch ? `No applications match "${debouncedSearch}"` : "Use the + icon above to create one"}
        />
      )}

      {!isLoading &&
        list.map((a) => (
          <div key={a.id} className="flex items-center gap-3 px-4 py-3.5 border-b border-gray-100">
            <input
              type="checkbox"
              checked={selected.has(a.id)}
              onChange={() => toggleOne(a.id)}
              className="w-4 h-4 rounded border-gray-300 flex-shrink-0"
            />
            <div
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/applications/${a.id}`)}
              onKeyDown={(e) => e.key === "Enter" && navigate(`/applications/${a.id}`)}
              className="flex-1 min-w-0 flex items-center gap-3 cursor-pointer"
            >
              <div className="w-8 h-8 rounded-full bg-violet-50 flex items-center justify-center flex-shrink-0">
                <LayoutGrid size={14} className="text-violet-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{a.name}</p>
                <p className={`text-xs mt-0.5 truncate ${a.description ? "text-gray-500" : "text-gray-300 italic"}`}>
                  {a.description || "No description yet"}
                </p>
              </div>
            </div>
            <button
              type="button"
              title={a.enabled ? "Disable" : "Enable"}
              onClick={(e) => {
                e.stopPropagation();
                togglePillField.mutate({ id: a.id, field: "enabled", value: !a.enabled });
              }}
              disabled={togglePillField.isPending && togglePillField.variables?.id === a.id && togglePillField.variables?.field === "enabled"}
              className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 transition-colors disabled:opacity-50 ${
                a.enabled
                  ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-gray-50 hover:text-gray-500 hover:border-gray-200"
                  : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200"
              }`}
            >
              {a.enabled ? "Enabled" : "Disabled"}
            </button>
            <button
              type="button"
              title={a.appCenterEnabled ? "Hide from request center" : "Show in request center"}
              onClick={(e) => {
                e.stopPropagation();
                togglePillField.mutate({ id: a.id, field: "appCenterEnabled", value: !a.appCenterEnabled });
              }}
              disabled={togglePillField.isPending && togglePillField.variables?.id === a.id && togglePillField.variables?.field === "appCenterEnabled"}
              className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 transition-colors disabled:opacity-50 ${
                a.appCenterEnabled
                  ? "bg-blue-50 text-blue-700 border-blue-200 hover:bg-gray-50 hover:text-gray-500 hover:border-gray-200"
                  : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200"
              }`}
            >
              {a.appCenterEnabled ? "Visible" : "Hidden"}
            </button>
            <button
              type="button"
              title={a.provisionRequestEnabled ? "Disallow access requests" : "Allow access requests"}
              onClick={(e) => {
                e.stopPropagation();
                togglePillField.mutate({ id: a.id, field: "provisionRequestEnabled", value: !a.provisionRequestEnabled });
              }}
              disabled={togglePillField.isPending && togglePillField.variables?.id === a.id && togglePillField.variables?.field === "provisionRequestEnabled"}
              className={`text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0 transition-colors disabled:opacity-50 ${
                a.provisionRequestEnabled
                  ? "bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-gray-50 hover:text-gray-500 hover:border-gray-200"
                  : "bg-gray-50 text-gray-500 border-gray-200 hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200"
              }`}
            >
              {a.provisionRequestEnabled ? "Requestable" : "Not Requestable"}
            </button>
          </div>
        ))}

      {creating && (
        <ApplicationFormModal
          sourceId={sourceId}
          sourceName={sourceName}
          currentUser={currentUser}
          onSave={(fields) => createApp.mutate(fields)}
          onClose={() => setCreating(false)}
          pending={createApp.isPending}
        />
      )}

      {confirmOpen && (
        <ConfirmModal
          title={`Delete ${selected.size} application${selected.size === 1 ? "" : "s"}?`}
          message={`This permanently deletes the selected application${selected.size === 1 ? "" : "s"} from this tenant. This cannot be undone.`}
          confirmLabel="Delete"
          danger
          pending={bulkDelete.isPending}
          progressText={`Deleting ${progress} of ${selected.size}…`}
          onConfirm={() => bulkDelete.mutate()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}

      {descriptionResults && (
        <BulkDescriptionReviewSheet
          items={descriptionResults}
          roleById={appById}
          onClose={() => setDescriptionResults(null)}
          onSaveSelected={(items) => saveDescriptions.mutate(items)}
          pending={saveDescriptions.isPending}
        />
      )}

      {generateDescriptions.isPending && (
        <div className="fixed inset-0 bg-black/20 z-20 flex items-center justify-center pointer-events-none">
          <div className="bg-white rounded-2xl shadow-xl px-5 py-4 flex items-center gap-3">
            <Spinner size={18} />
            <p className="text-sm text-gray-600">Generating descriptions for {list.length} application{list.length === 1 ? "" : "s"}…</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Provisioning policies panel ─────────────────────────────────────────────────
// List Provisioning Policies for the list (keyed by usageType, not a
// generated id — CREATE, UPDATE, ENABLE, DISABLE, CREATE_GROUP, ...),
// Get Provisioning Policy by usageType for the detail view when one's
// selected. No sub-route of its own — selection just swaps this panel's
// own view, same as how Applications' create form takes over in place.

function describeTransform(transform) {
  if (!transform) return null;
  const attrs = transform.attributes || {};
  const detail = attrs.value ?? attrs.name ?? Object.entries(attrs).map(([k, v]) => `${k}: ${v}`).join(", ");
  return `${transform.type}${detail ? `: ${detail}` : ""}`;
}

function ProvisioningPolicyDetail({ sourceId, usageType, onBack }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["source-provisioning-policy", sourceId, usageType],
    queryFn: () => getSourceProvisioningPolicy(sourceId, usageType),
  });

  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const parseError = editing ? jsonParseError(text) : null;

  // Policies don't take JSON-Patch — the whole edited document is PUT back
  // (see updateSourceProvisioningPolicy). usageType is the identifier and
  // stays the one being edited regardless of what the body says.
  const save = useMutation({
    mutationFn: () => updateSourceProvisioningPolicy(sourceId, usageType, JSON.parse(text)),
    onSuccess: () => {
      toast.success("Provisioning policy saved");
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["source-provisioning-policy", sourceId, usageType] });
      queryClient.invalidateQueries({ queryKey: ["source-provisioning-policies", sourceId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  if (editing && data) {
    return (
      <div>
        <button
          onClick={onBack}
          className="flex items-center gap-1 px-4 py-3 text-xs font-medium text-gray-500 hover:text-gray-700"
        >
          <ChevronLeft size={14} />
          Back to Provisioning Policies
        </button>
        <div className="px-4 pb-4">
          <p className="text-sm font-medium text-gray-900 mb-3">{data.name} — JSON</p>
          <JsonEditTabs text={text} onChange={setText} minHeight="240px" />
          <div className="flex gap-2 mt-3">
            <PrimaryButton onClick={() => save.mutate()} loading={save.isPending} disabled={!!parseError} className="!w-auto flex-1">
              Save
            </PrimaryButton>
            <OutlineButton onClick={() => setEditing(false)} disabled={save.isPending} className="!w-auto flex-1">
              Cancel
            </OutlineButton>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-1 px-4 py-3 text-xs font-medium text-gray-500 hover:text-gray-700"
      >
        <ChevronLeft size={14} />
        Back to Provisioning Policies
      </button>
      {isLoading && <SkeletonList rows={4} />}
      {error && <ErrorBox message={error.message} />}
      {data && (
        <div className="px-4 pb-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-gray-900">{data.name}</p>
            <IconButton
              icon={Pencil}
              title="Edit policy JSON"
              onClick={() => { setText(JSON.stringify(data, null, 2)); setEditing(true); }}
            />
          </div>
          {data.description && <p className="text-xs text-gray-500 mt-1">{data.description}</p>}
          <p className="text-xs text-gray-400 mt-2 mb-3">
            {(data.fields || []).length} field{(data.fields || []).length === 1 ? "" : "s"}
          </p>
          <div className="space-y-2">
            {(data.fields || []).map((f, i) => (
              <div key={`${f.name}-${i}`} className="border border-gray-100 rounded-lg px-3 py-2.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <p className="text-sm font-medium text-gray-900">{f.name}</p>
                  <span className="text-xs text-gray-400">{f.type}{f.isMultiValued ? "[]" : ""}</span>
                  {f.isRequired && (
                    <span title="Required" className="text-red-500">
                      <Asterisk size={11} />
                    </span>
                  )}
                </div>
                {describeTransform(f.transform) && (
                  <p className="text-xs text-gray-500 mt-1 truncate">{describeTransform(f.transform)}</p>
                )}
              </div>
            ))}
            {(data.fields || []).length === 0 && (
              <p className="text-xs text-gray-400">No fields defined on this policy.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ProvisioningPoliciesPanel({ sourceId }) {
  const [selectedUsageType, setSelectedUsageType] = useState(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["source-provisioning-policies", sourceId],
    queryFn: () => listSourceProvisioningPolicies(sourceId),
  });
  const list = Array.isArray(data) ? data : [];

  if (selectedUsageType) {
    return (
      <ProvisioningPolicyDetail
        sourceId={sourceId}
        usageType={selectedUsageType}
        onBack={() => setSelectedUsageType(null)}
      />
    );
  }

  return (
    <div>
      {isLoading && <SkeletonList rows={4} />}
      {error && <ErrorBox message={error.message} />}
      {!isLoading && !error && list.length === 0 && (
        <EmptyState
          icon={ClipboardList}
          title="No provisioning policies"
          subtitle="This source has no provisioning policies configured"
        />
      )}
      {!isLoading && list.length > 0 && (
        <>
          <p className="text-xs text-gray-400 px-4 py-2">
            {list.length} polic{list.length === 1 ? "y" : "ies"}
          </p>
          {list.map((p) => (
            <button
              key={p.usageType}
              onClick={() => setSelectedUsageType(p.usageType)}
              className="w-full flex items-center gap-3 px-4 py-3.5 border-b border-gray-100 hover:bg-gray-50 active:bg-gray-100 text-left transition-colors"
            >
              <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                <ClipboardList size={14} className="text-gray-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{p.name}</p>
                <p className="text-xs text-gray-500 mt-0.5 truncate">
                  {p.usageType}{p.description ? ` — ${p.description}` : ""}
                </p>
              </div>
              <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
            </button>
          ))}
        </>
      )}
    </div>
  );
}

// ─── Identity Profile panel ─────────────────────────────────────────────────

function IdentityProfilePanel({ sourceId }) {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["source-identity-profile", sourceId],
    queryFn: () => getSourceIdentityProfile(sourceId),
  });

  // Same create-identity-profile logic the Add Disconnected Source wizard
  // uses at the end of its own flow (AI-matches this source's schema
  // attributes to the Identity Schema, creates "<source name> Profile",
  // then runs Process Identities) — just that one step, not the
  // source-creation/schema-detection/aggregation steps that precede it
  // there, since this source already exists and is already aggregated.
  const createProfile = useMutation({
    mutationFn: () => createIdentityProfileForSource(sourceId),
    onSuccess: (result) => {
      if (result.applied === false) {
        toast(`Identity Profile "${result.profile?.name}" created, but applying the mapping to identities failed — re-run Process Identities from ISC.`);
      } else {
        toast.success(`Identity Profile "${result.profile?.name}" created`);
      }
      queryClient.invalidateQueries({ queryKey: ["source-identity-profile", sourceId] });
      queryClient.invalidateQueries({ queryKey: ["identity-profiles"] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Reconciles the profile's mappings against the source's CURRENT account
  // schema rather than requiring a full recreate — adds a mapping for any
  // new schema attribute, drops any mapping whose account attribute no
  // longer exists, and leaves every other mapping exactly as it was.
  const syncProfile = useMutation({
    mutationFn: () => syncSourceIdentityProfile(sourceId),
    onSuccess: (result) => {
      const unmatched = result.unmatchedNames || [];
      if (!result.changed) {
        toast(
          unmatched.length > 0
            ? `No mappings changed — couldn't confidently auto-map: ${unmatched.join(", ")}. Map ${unmatched.length === 1 ? "it" : "them"} manually in ISC, or check that AI matching is configured.`
            : "Already up to date — no schema changes to reconcile",
          unmatched.length > 0 ? { duration: 8000 } : undefined
        );
      } else {
        const parts = [];
        if (result.added > 0) parts.push(`added ${result.added}`);
        if (result.removed > 0) parts.push(`removed ${result.removed}`);
        toast.success(
          `Mappings updated (${parts.join(", ")})` +
            (unmatched.length > 0 ? ` — couldn't auto-map: ${unmatched.join(", ")}` : "") +
            (result.applied === false ? " — re-run Process Identities from ISC to apply" : ""),
          { duration: unmatched.length > 0 ? 8000 : undefined }
        );
      }
      queryClient.invalidateQueries({ queryKey: ["source-identity-profile", sourceId] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // ISC's own "Apply Changes": re-evaluates every identity under this
  // profile against its current mappings and lifecycle states. ISC accepts
  // the job and runs it in the background, so success here means "started".
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const applyChanges = useMutation({
    mutationFn: () => processIdentityProfile(data.profile.id),
    onSuccess: () => {
      setApplyConfirmOpen(false);
      toast.success(
        `Apply Changes started for "${data.profile.name}". ISC processes identities in the background, so updated attributes can take a few minutes to appear.`,
        { duration: 8000 }
      );
    },
    onError: (err) => {
      setApplyConfirmOpen(false);
      toast.error(err.response?.data?.error || err.message);
    },
  });

  const tenant = getCredentials()?.tenant;

  if (isLoading) return <SkeletonList rows={4} />;
  if (error) return <ErrorBox message={error.message} />;
  if (!data?.hasProfile) {
    return (
      <EmptyState
        icon={UserCog}
        title="No Identity Profile"
        subtitle="No Identity Profile uses this source as its authoritative source"
        action={
          <button
            onClick={() => createProfile.mutate()}
            disabled={createProfile.isPending}
            className="mt-4 flex items-center gap-2 bg-blue-600 text-white text-sm font-medium px-4 py-2 rounded-xl disabled:opacity-50"
          >
            {createProfile.isPending ? <Spinner size={16} /> : <Plus size={16} />}
            Create Identity Profile
          </button>
        }
      />
    );
  }

  const mappings = data.mappings || [];
  const iscUrl = tenant
    ? `https://${tenantUiHost(tenant)}/ui/ip/admin/identity-profiles/${data.profile.id}/settings`
    : null;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 px-4 py-4 border-b border-gray-100">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">{data.profile.name}</p>
          {data.profile.description && (
            <p className="text-xs text-gray-500 mt-0.5 truncate">{data.profile.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => setApplyConfirmOpen(true)}
            disabled={applyChanges.isPending}
            title="Apply Changes — re-evaluate every identity under this profile against its current mappings"
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 transition-colors"
          >
            {applyChanges.isPending ? <Spinner size={13} className="text-white" /> : <Play size={13} />}
            Apply Changes
          </button>
          <IconButton
            icon={RefreshCw}
            title="Update mappings — add new schema attributes, remove ones that no longer exist"
            onClick={() => syncProfile.mutate()}
            loading={syncProfile.isPending}
          />
          <IconButton
            icon={Pencil}
            title="Manage in Identity Security Cloud"
            onClick={() => iscUrl && window.open(iscUrl, "_blank", "noopener,noreferrer")}
            disabled={!iscUrl}
          />
        </div>
      </div>
      {mappings.length === 0 ? (
        <EmptyState
          icon={UserCog}
          title="No attribute mappings"
          subtitle="This profile has no identity attribute mappings configured"
        />
      ) : (
        <>
          <p className="text-xs text-gray-400 px-4 py-2">
            {mappings.length} mapped attribute{mappings.length === 1 ? "" : "s"}
          </p>
          <div className="border border-gray-100 rounded-xl overflow-hidden mx-4 mb-4">
            {mappings.map((m) => (
              <InfoRow key={m.name} label={m.displayName} value={m.mapping} />
            ))}
          </div>
        </>
      )}

      {applyConfirmOpen && (
        <ConfirmModal
          title={`Apply changes to "${data.profile.name}"?`}
          message="This re-evaluates every identity under this Identity Profile against its current attribute mappings and lifecycle states, and can trigger provisioning that depends on those attributes (role membership, attribute sync, lifecycle state changes). ISC runs it in the background — on a large profile it can take a while, and updates appear gradually."
          confirmLabel="Apply Changes"
          pending={applyChanges.isPending}
          onConfirm={() => applyChanges.mutate()}
          onCancel={() => setApplyConfirmOpen(false)}
        />
      )}
    </div>
  );
}

// Reviews Claude's suggested description before applying it — same shape as
// AccessProfileDetailPage's/ApplicationDetailPage's GeneratedDescriptionModal.
function GeneratedDescriptionModal({ currentDescription, suggestion, onClose, onSave, pending }) {
  const [description, setDescription] = useState(suggestion);

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-1 flex items-center gap-2">
          <Wand2 size={16} className="text-violet-600" />
          AI-generated description
        </h2>
        <p className="text-xs text-gray-400 mb-4">Review and edit before saving — nothing is applied until you confirm.</p>

        <Field label="Current description">
          <p className="text-sm text-gray-500 bg-gray-50 border border-gray-100 rounded-xl px-3 py-2.5">
            {currentDescription || "(none)"}
          </p>
        </Field>
        <Field label="Suggested description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        <div className="flex gap-2 mt-2">
          <PrimaryButton onClick={() => onSave(description)} loading={pending} disabled={!description.trim()} className="!w-auto flex-1">
            Save
          </PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

// ─── Account schema editor ──────────────────────────────────────────────────────
// Delimited File / Generic sources only (same isEditableAccountSourceType gate as
// the Edit Accounts icon) — add/remove columns on the account schema. Saving
// uploads a HEADER-ONLY csv (no data rows) to ISC's own schema-detection
// endpoint, the same one the disconnected-source wizard uses — only the column
// list matters for a schema change, so there's no need to re-export and
// re-upload every account's actual data just to add or drop a column.
// Detection re-derives its own best-guess UID/Account Name from the file, which
// for an already-established source is very likely wrong (it can't know which
// existing column was already playing that role), so the source's current ones
// are immediately restored via the same UID-confirm step the wizard uses.
// Renaming isn't offered — SailPoint treats a rename as add-one/drop-one
// anyway, so it wouldn't preserve data any better than Add + Delete would.
function SchemaEditorModal({ sourceId, sourceName, onClose }) {
  const queryClient = useQueryClient();
  const schemaQuery = useQuery({
    queryKey: ["source-account-schema", sourceId],
    queryFn: () => getSourceAccountSchema(sourceId),
  });
  const [attrs, setAttrs] = useState(null); // null until seeded from the schema
  const [newName, setNewName] = useState("");
  // Set only after a successful save, when this source has an Identity
  // Profile — swaps the modal over to a confirm prompt rather than closing
  // outright, since reconciling its mappings is a separate, optional step.
  const [profilePrompt, setProfilePrompt] = useState(null);

  // Which attribute holds each special role. Single values by construction,
  // so exclusivity is automatic: choosing Unique ID or Account Name on one
  // row silently demotes whichever row held it before back to String.
  const [uidAttr, setUidAttr] = useState(null);
  const [nameAttr, setNameAttr] = useState(null);
  // Entitlement is the one multi-row role — a Map of attribute name to its
  // isMulti flag (Entitlement - Single Value vs Entitlement - Multi-value).
  const [entAttrs, setEntAttrs] = useState(new Map());

  useEffect(() => {
    if (attrs === null && schemaQuery.data) {
      setAttrs(schemaQuery.data.attributes.map((a) => ({ ...a })));
      setUidAttr(schemaQuery.data.identityAttribute || null);
      setNameAttr(schemaQuery.data.displayAttribute || null);
      setEntAttrs(new Map(schemaQuery.data.attributes.filter((a) => a.isEntitlement).map((a) => [a.name, !!a.isMulti])));
    }
  }, [attrs, schemaQuery.data]);

  const originalNames = new Set((schemaQuery.data?.attributes || []).map((a) => a.name));

  function addAttribute() {
    const name = newName.trim();
    if (!name) return;
    if (attrs.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      toast.error(`"${name}" already exists on this schema`);
      return;
    }
    setAttrs((prev) => [...prev, { name, type: "STRING", isMulti: false, description: "" }]);
    setNewName("");
  }

  function removeAttribute(name) {
    setAttrs((prev) => prev.filter((a) => a.name !== name));
    setEntAttrs((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Map(prev);
      next.delete(name);
      return next;
    });
  }

  const finishUp = () => {
    queryClient.invalidateQueries({ queryKey: ["source-account-schema", sourceId] });
    queryClient.invalidateQueries({ queryKey: ["source-provisioning-policies", sourceId] });
    queryClient.invalidateQueries({ queryKey: ["source-identity-profile", sourceId] });
    onClose();
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const removedNames = [...originalNames].filter((n) => !attrs.some((a) => a.name === n));
      const added = attrs.filter((a) => !originalNames.has(a.name)).map((a) => ({ name: a.name, isMulti: !!a.isMulti }));

      const csv = toCsv(attrs.map((a) => a.name), []);
      const csvBase64 = btoa(unescape(encodeURIComponent(csv)));
      const detected = await detectSourceSchema(sourceId, { filename: `${sourceName || "accounts"}-schema.csv`, csvBase64 });
      await setSourceSchemaUid(sourceId, detected.schemaId, {
        identityAttribute: uidAttr,
        displayAttribute: nameAttr,
        entitlementAttributes: attrs.filter((a) => entAttrs.has(a.name)).map((a) => ({ name: a.name, isMulti: entAttrs.get(a.name) })),
      });

      const policyResult = await syncSourceProvisioningPolicies(sourceId, { removedNames, added });

      let hasProfile = false;
      try {
        hasProfile = !!(await getSourceIdentityProfile(sourceId))?.hasProfile;
      } catch {
        // Not fatal — the schema/policy update already succeeded regardless.
      }

      return { policyResult, hasProfile, removedNames, added };
    },
    onSuccess: (result) => {
      const policyNote = result.policyResult?.policiesUpdated?.length
        ? ` Provisioning ${result.policyResult.policiesUpdated.length === 1 ? "policy" : "policies"} (${result.policyResult.policiesUpdated.join(", ")}) updated to match.`
        : "";
      toast.success(`Schema updated.${policyNote}`, { duration: 6000 });
      if (result.hasProfile && (result.removedNames.length > 0 || result.added.length > 0)) {
        setProfilePrompt({ removedNames: result.removedNames, added: result.added });
      } else {
        finishUp();
      }
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const syncProfileMutation = useMutation({
    mutationFn: () => syncSourceIdentityProfile(sourceId),
    onSuccess: (result) => {
      if (result.changed) {
        const parts = [];
        if (result.added > 0) parts.push(`added ${result.added}`);
        if (result.removed > 0) parts.push(`removed ${result.removed}`);
        toast.success(`Identity Profile mappings updated (${parts.join(", ")})`);
      } else {
        toast("Identity Profile mappings already up to date");
      }
      finishUp();
    },
    onError: (err) => {
      toast.error(err.response?.data?.error || err.message);
      finishUp(); // the schema/policy changes already succeeded — don't strand the modal open over this
    },
  });

  if (profilePrompt) {
    return (
      <ConfirmModal
        title="Update Identity Profile mappings too?"
        message="An Identity Profile uses this source as its authoritative source. Reconcile its attribute mappings with the schema change — add mappings for new attributes, remove mappings for ones that no longer exist?"
        confirmLabel="Update Mappings"
        pending={syncProfileMutation.isPending}
        onConfirm={() => syncProfileMutation.mutate()}
        onCancel={finishUp}
      />
    );
  }

  const loading = schemaQuery.isLoading || attrs === null;
  const pending = saveMutation.isPending || syncProfileMutation.isPending;

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 pt-5">
          <h2 className="text-base font-semibold text-gray-900">Account Schema</h2>
          <button onClick={onClose} disabled={pending} className="text-gray-400 hover:text-gray-600 disabled:opacity-50">
            <X size={18} />
          </button>
        </div>
        <p className="text-xs text-gray-500 px-5 pt-2 leading-relaxed">
          Add or remove account attributes. Saving updates the schema in ISC (from just the column list, not the
          account data) and keeps this source's provisioning policies in step with the change.
        </p>

        <div className="px-5 pt-3 pb-5">
          {loading && <SkeletonList rows={4} />}
          {schemaQuery.error && <ErrorBox message={schemaQuery.error.message} />}

          {!loading && !schemaQuery.error && (
            <>
              <div className="border border-gray-100 rounded-xl overflow-hidden divide-y divide-gray-100 mb-4">
                {attrs.map((a) => {
                  const role =
                    a.name === uidAttr ? "uid"
                    : a.name === nameAttr ? "name"
                    : entAttrs.has(a.name) ? (entAttrs.get(a.name) ? "ent-multi" : "ent-single")
                    : "string";
                  const holdsRole = role === "uid" || role === "name";
                  return (
                    <div key={a.name} className="flex items-center gap-2 px-3 py-2.5">
                      <span className="text-sm text-gray-900 flex-1 truncate">{a.name}</span>
                      <select
                        value={role}
                        onChange={(e) => {
                          const next = e.target.value;
                          // Leaving a role clears it; taking a role moves it
                          // here (the previous holder derives back to String).
                          if (a.name === uidAttr && next !== "uid") setUidAttr(null);
                          if (a.name === nameAttr && next !== "name") setNameAttr(null);
                          if (next === "uid") setUidAttr(a.name);
                          if (next === "name") setNameAttr(a.name);
                          // Entitlement is multi-select: toggle membership
                          // (and the row's single/multi flavor) without
                          // touching any other row's choice.
                          setEntAttrs((prev) => {
                            const isEnt = next === "ent-single" || next === "ent-multi";
                            const wantMulti = next === "ent-multi";
                            if (!isEnt && !prev.has(a.name)) return prev;
                            if (isEnt && prev.has(a.name) && prev.get(a.name) === wantMulti) return prev;
                            const changed = new Map(prev);
                            if (isEnt) changed.set(a.name, wantMulti); else changed.delete(a.name);
                            return changed;
                          });
                        }}
                        className="text-xs text-gray-700 border border-gray-200 rounded-lg px-2 py-1 bg-white outline-none focus:border-blue-400 flex-shrink-0"
                      >
                        <option value="string">String</option>
                        <option value="uid">Unique ID</option>
                        <option value="name">Account Name</option>
                        <option value="ent-single">Entitlement - Single Value</option>
                        <option value="ent-multi">Entitlement - Multi-value</option>
                      </select>
                      <button
                        type="button"
                        title={holdsRole ? "Can't remove — set this attribute to String first" : "Remove attribute"}
                        onClick={() => removeAttribute(a.name)}
                        disabled={holdsRole}
                        className="text-gray-400 hover:text-red-600 disabled:opacity-30 disabled:hover:text-gray-400 flex-shrink-0"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>

              <Field label="Add attribute">
                <div className="flex gap-2">
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); addAttribute(); }
                    }}
                    placeholder="Attribute name"
                  />
                  <OutlineButton onClick={addAttribute} className="!w-auto px-4 flex-shrink-0">
                    Add
                  </OutlineButton>
                </div>
              </Field>

              {(!uidAttr || !nameAttr) && (
                <p className="text-xs text-amber-600 mb-2">
                  Pick one attribute as Unique ID and one as Account Name before saving.
                </p>
              )}
              <PrimaryButton onClick={() => saveMutation.mutate()} loading={saveMutation.isPending} disabled={attrs.length === 0 || !uidAttr || !nameAttr || pending}>
                Save Schema
              </PrimaryButton>
              <OutlineButton onClick={onClose} disabled={pending} className="mt-2">
                Cancel
              </OutlineButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Read-only schema view for every source type (an account schema exists
// regardless of connector) — the Pencil icon that opens SchemaEditorModal
// only shows for Delimited File / Generic sources, the only ones whose
// schema this app can actually change.
function SchemaPanel({ sourceId, sourceType, sourceName }) {
  const schemaQuery = useQuery({
    queryKey: ["source-account-schema", sourceId],
    queryFn: () => getSourceAccountSchema(sourceId),
  });
  const [editorOpen, setEditorOpen] = useState(false);

  if (schemaQuery.isLoading) return <SkeletonList rows={4} />;
  if (schemaQuery.error) return <ErrorBox message={schemaQuery.error.message} />;

  const attrs = schemaQuery.data?.attributes || [];
  const { identityAttribute, displayAttribute } = schemaQuery.data || {};

  return (
    <div>
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <p className="text-xs text-gray-400">
          {attrs.length} account attribute{attrs.length === 1 ? "" : "s"}
        </p>
        {isEditableAccountSourceType(sourceType) && (
          <IconButton icon={Pencil} title="Edit schema — add or remove account attributes" onClick={() => setEditorOpen(true)} />
        )}
      </div>

      {attrs.length === 0 ? (
        <EmptyState icon={Table2} title="No schema" subtitle="This source has no account schema yet" />
      ) : (
        <div className="border border-gray-100 rounded-xl overflow-hidden mx-4 mb-4 mt-3">
          {attrs.map((a) => (
            <InfoRow
              key={a.name}
              label={a.name}
              value={
                a.name === identityAttribute ? "Unique ID"
                : a.name === displayAttribute ? "Account Name"
                : a.isEntitlement ? (a.isMulti ? "Entitlement - Multi-value" : "Entitlement - Single Value")
                : a.type || "STRING"
              }
            />
          ))}
        </div>
      )}

      {editorOpen && <SchemaEditorModal sourceId={sourceId} sourceName={sourceName} onClose={() => setEditorOpen(false)} />}
    </div>
  );
}

// ─── Connector Rules panel ────────────────────────────────────────────────────
// Connector rules are tenant-wide in ISC (there's no per-source list), so
// this shows every rule, floating the ones this source references — its
// beforeProvisioningRule, or any connector attribute whose value names a
// rule — to the top with a "Used by this source" tag.

function ruleIsUsedBySource(rule, source) {
  if (!rule || !source) return false;
  if (source.beforeProvisioningRule?.id === rule.id || source.beforeProvisioningRule?.name === rule.name) return true;
  const values = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === "string") values.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(source.connectorAttributes);
  return values.some((v) => v === rule.id || v === rule.name);
}

function ConnectorRulesPanel({ sourceId, source }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["connector-rules"], queryFn: listConnectorRules });
  const rules = useMemo(() => {
    const all = Array.isArray(data) ? data : [];
    const q = search.trim().toLowerCase();
    return all
      .map((r) => ({ ...r, _used: ruleIsUsedBySource(r, source) }))
      .filter((r) => !q || [r.name, r.type, r.description].some((v) => v && String(v).toLowerCase().includes(q)))
      .sort((a, b) => (a._used === b._used ? 0 : a._used ? -1 : 1));
  }, [data, search, source]);
  const usedCount = rules.filter((r) => r._used).length;

  return (
    <div>
      <div className="px-4 pt-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-900">Connector Rules</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Rules that run in the Virtual Appliance as connector extensions. {usedCount ? `${usedCount} referenced by this source; ` : ""}rules are tenant-wide.
          </p>
        </div>
        <IconButton icon={Plus} title="Create a connector rule" onClick={() => navigate(`/sources/${sourceId}/rules/new`)} />
      </div>
      <SearchBar value={search} onChange={setSearch} placeholder="Search rules by name, type…" />
      {error && <div className="px-4"><ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} /></div>}
      {isLoading && <div className="px-4"><SkeletonList rows={5} /></div>}
      {!isLoading && !error && rules.length === 0 && (
        <EmptyState icon={Code} title={search ? "No results" : "No connector rules"} subtitle={search ? `No rules match "${search}"` : "This tenant has no connector rules yet — create one with the + above"} />
      )}
      {rules.map((r) => (
        <button
          key={r.id}
          onClick={() => navigate(`/sources/${sourceId}/rules/${r.id}`)}
          className="w-full text-left flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors"
        >
          <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center flex-shrink-0">
            <Code size={14} className="text-slate-700" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">{r.name}</p>
            <p className="text-xs text-gray-500 truncate mt-0.5">{r.type}{r.description ? ` · ${r.description}` : ""}</p>
          </div>
          {r._used && <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 flex-shrink-0">Used by this source</span>}
          <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
        </button>
      ))}
    </div>
  );
}

// ─── Connector Customizers panel (SaaS / cloud-hosted sources) ───────────────
// SaaS connectivity customizers are the cloud counterpart of VA connector
// rules: tenant-wide, assigned to a source through its connectorAttributes.
// connectorCustomizerId. The one this source uses floats to the top.

function ConnectorCustomizersPanel({ sourceId, source }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ["connector-customizers"], queryFn: listConnectorCustomizers });
  const assignedId = source?.connectorAttributes?.connectorCustomizerId || null;
  const customizers = useMemo(() => {
    const all = Array.isArray(data) ? data : [];
    const q = search.trim().toLowerCase();
    return all
      .filter((c) => !q || String(c.name || "").toLowerCase().includes(q))
      .sort((a, b) => ((a.id === assignedId) === (b.id === assignedId) ? 0 : a.id === assignedId ? -1 : 1));
  }, [data, search, assignedId]);

  return (
    <div>
      <div className="px-4 pt-4 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-900">Connector Customizers</p>
          <p className="text-xs text-gray-500 mt-0.5">
            SaaS connectivity customizers — the cloud equivalent of connector rules. {assignedId ? "One is assigned to this source." : "None is assigned to this source yet."}
          </p>
        </div>
        <IconButton icon={Plus} title="Create a connector customizer" onClick={() => navigate(`/sources/${sourceId}/customizers/new`)} />
      </div>
      <SearchBar value={search} onChange={setSearch} placeholder="Search customizers…" />
      {error && <div className="px-4"><ErrorBox message={error.response?.data?.error || error.message} onRetry={refetch} /></div>}
      {isLoading && <div className="px-4"><SkeletonList rows={4} /></div>}
      {!isLoading && !error && customizers.length === 0 && (
        <EmptyState icon={Cloud} title={search ? "No results" : "No connector customizers"} subtitle={search ? `No customizers match "${search}"` : "This tenant has no SaaS connectivity customizers yet — create one with the + above"} />
      )}
      {customizers.map((c) => (
        <button
          key={c.id}
          onClick={() => navigate(`/sources/${sourceId}/customizers/${c.id}`)}
          className="w-full text-left flex items-center gap-3 px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors"
        >
          <div className="w-8 h-8 rounded-full bg-sky-50 flex items-center justify-center flex-shrink-0">
            <Cloud size={14} className="text-sky-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">{c.name}</p>
            <p className="text-xs text-gray-500 truncate mt-0.5">
              Version {c.imageVersion ?? "—"}{c.created ? ` · created ${new Date(c.created).toLocaleDateString()}` : ""}
            </p>
          </div>
          {c.id === assignedId && <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 flex-shrink-0">Assigned to this source</span>}
          <ChevronRight size={16} className="text-gray-300 flex-shrink-0" />
        </button>
      ))}

    </div>
  );
}

// ─── Details panel ──────────────────────────────────────────────────────────────

// ISC's cluster/VA status codes, in the words its own admin UI uses.
const VA_STATUS_LABELS = {
  NORMAL: "Normal",
  WARNING: "Warning",
  FAILED: "Failed",
  CONFIGURING: "Configuring",
  NOT_CONFIGURED: "Not configured",
  UNKNOWN: "Unknown",
};
function vaStatusLabel(status) {
  if (!status) return undefined;
  const key = String(status).toUpperCase();
  return VA_STATUS_LABELS[key] || status;
}
function sinceLastSeen(client) {
  if (client?.sinceLastSeen) return client.sinceLastSeen;
  if (!client?.lastSeen) return null;
  const d = new Date(client.lastSeen);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
}

// Rows for the source's Virtual Appliance cluster — rendered inside the
// same bordered list as the source's own attributes, right after Cluster.
// Nothing at all renders for a source with no cluster (Delimited File,
// disconnected sources), and a fetch failure (e.g. a token without the
// authority to read managed clusters) collapses to a single explanatory
// row rather than hiding the section silently.
function VirtualApplianceRows({ clusterId }) {
  const cluster = useQuery({
    queryKey: ["managed-cluster", clusterId],
    queryFn: () => getManagedCluster(clusterId),
    enabled: !!clusterId,
    staleTime: 60_000,
  });
  const clients = useQuery({
    queryKey: ["managed-clients", clusterId],
    queryFn: () => listManagedClientsForCluster(clusterId),
    enabled: !!clusterId,
    staleTime: 60_000,
  });
  if (!clusterId) return null;
  // A heavier rule than the hairline between ordinary rows, so the VA block
  // reads as its own section of the list rather than more source fields.
  const divider = <div className="border-t-2 border-gray-200 my-1" aria-hidden="true" />;
  if (cluster.isLoading && clients.isLoading) return <>{divider}<InfoRow label="VA status" value="Loading…" /></>;
  if (cluster.isError && clients.isError) {
    return <>{divider}<InfoRow label="VA status" value={cluster.error?.response?.data?.error || cluster.error?.message || "Unavailable"} /></>;
  }
  const c = cluster.data || {};
  const vas = Array.isArray(clients.data) ? clients.data : [];
  return (
    <>
      {divider}
      <InfoRow label="VA status" value={vaStatusLabel(c.status)} />
      <InfoRow label="VA type" value={c.clientType} />
      <InfoRow label="CCG version" value={c.ccgVersion} />
      <InfoRow label="Cluster alert" value={c.alertKey} />
      <InfoRow label="Virtual appliances" value={vas.length ? String(vas.length) : undefined} />
      {vas.map((va, i) => {
        const name = va.name || va.ipAddress || va.id || `VA ${i + 1}`;
        const parts = [
          vaStatusLabel(va.status),
          va.ipAddress && va.ipAddress !== name ? va.ipAddress : null,
          va.vaVersion ? `v${va.vaVersion}` : null,
          sinceLastSeen(va) ? `seen ${sinceLastSeen(va)}` : null,
          va.alertKey || null,
        ].filter(Boolean);
        return <InfoRow key={va.id || i} label={name} value={parts.join(" · ") || undefined} />;
      })}
    </>
  );
}

// Delete threshold — editable inline. ISC skips an aggregation's deletion
// phase entirely when it would remove more than this share of the source's
// accounts, without failing the aggregation, so on a small source a low
// threshold silently blocks deletes (e.g. 10% of 7 accounts: removing even
// one is 14%).
function DeleteThresholdRow({ source }) {
  const queryClient = useQueryClient();
  const current = source.deleteThreshold ?? source.connectorAttributes?.deleteThresholdPercentage;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const parsed = Number(value);
  const valid = value !== "" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;
  const save = useMutation({
    mutationFn: () => setSourceDeleteThreshold(source, parsed),
    onSuccess: () => {
      toast.success(`Delete threshold set to ${Math.round(parsed)}%`);
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["source", source.id] });
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  return (
    <div className="flex justify-between items-start gap-4 py-3 px-4 border-b border-gray-100 last:border-0">
      <div className="min-w-0">
        <span className="text-sm text-gray-500">Delete threshold</span>
        <p className="text-[11px] text-gray-400 mt-0.5 leading-snug">
          An aggregation that would delete more than this percentage of accounts skips all deletions.
        </p>
      </div>
      {editing ? (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <input
            type="number"
            min={0}
            max={100}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && valid) save.mutate(); if (e.key === "Escape") setEditing(false); }}
            autoFocus
            className="w-20 bg-white text-gray-900 placeholder-gray-400 border border-gray-200 rounded-lg px-2 py-1 text-sm text-right outline-none focus:border-blue-400"
          />
          <span className="text-sm text-gray-500">%</span>
          <button type="button" onClick={() => save.mutate()} disabled={!valid || save.isPending} className="text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg px-2.5 py-1.5 disabled:opacity-50">
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={() => setEditing(false)} disabled={save.isPending} className="text-xs font-medium text-gray-500 hover:text-gray-700 px-1">Cancel</button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => { setValue(current != null ? String(current) : ""); setEditing(true); }}
          className="flex items-center gap-1.5 text-sm text-gray-900 font-medium hover:text-blue-600 flex-shrink-0"
          title="Edit delete threshold"
        >
          {current != null ? `${current}%` : "Not set"}
          <Pencil size={13} className="text-gray-400" />
        </button>
      )}
    </div>
  );
}

// Source edit dialog — Name, Description, Owner and Additional owners, only
// changed fields sent, like the Role and Access Profile dialogs. A Source's
// only additional-owner slot is its management workgroup (one governance
// group), so the Users choice isn't offered here.
function EditSourceModal({ source, onClose, onSave, pending }) {
  const [name, setName] = useState(source.name || "");
  const [description, setDescription] = useState(source.description || "");
  const [owner, setOwner] = useState(source.owner ? [{ id: source.owner.id, name: source.owner.name }] : []);
  const [additional, setAdditional] = useState(() => ({
    mode: "group",
    users: [],
    group: source.managementWorkgroup ? [{ id: source.managementWorkgroup.id, name: source.managementWorkgroup.name }] : [],
  }));
  const searchOwners = async (q) => (await listIdentities({ limit: 15, query: q || undefined })).map((i) => ({ id: i.id, name: i.name }));
  const tooLong = description.length > 255;
  const canSave = name.trim() && owner[0]?.id && !tooLong;

  function handleSave() {
    const fields = {};
    if (name.trim() !== source.name) fields.name = name.trim();
    if (description !== (source.description || "")) fields.description = description;
    if (owner[0]?.id !== source.owner?.id) fields.owner = owner[0];
    const nextGroup = additional.group[0] || null;
    if ((nextGroup?.id || null) !== (source.managementWorkgroup?.id || null)) fields.managementWorkgroup = nextGroup;
    if (Object.keys(fields).length === 0) return onClose();
    onSave(fields);
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 z-30 flex items-end md:items-center justify-center"
      onClick={(e) => e.target === e.currentTarget && !pending && onClose()}
    >
      <div className="bg-white w-full max-w-lg md:mx-4 rounded-t-2xl md:rounded-2xl shadow-xl p-5 max-h-[85vh] overflow-y-auto">
        <h2 className="text-base font-semibold text-gray-900 mb-4">Edit source</h2>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {name.trim() !== source.name && (
          <p className="text-xs text-amber-600 -mt-2 mb-3">Rules, transforms and workflows that refer to this source by name won't follow the rename.</p>
        )}
        <Field label={`Description (${description.length}/255)`}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {tooLong && <p className="text-xs text-red-600 -mt-2 mb-3">Source descriptions are limited to 255 characters.</p>}
        <PickerField label="Owner" cacheKey="source-owner" placeholder="Search users…" searchFn={searchOwners} multi={false} selected={owner} onChange={setOwner} />
        <AdditionalOwnersField
          groupOnly
          value={additional}
          onChange={setAdditional}
          help="A source's additional owners are one governance group — its management workgroup, whose members can administer the source. ISC doesn't support individual additional owners on sources."
        />
        <div className="flex gap-2 mt-2">
          <PrimaryButton onClick={handleSave} loading={pending} disabled={!canSave} className="!w-auto flex-1">Save</PrimaryButton>
          <OutlineButton onClick={onClose} disabled={pending} className="!w-auto flex-1">Cancel</OutlineButton>
        </div>
      </div>
    </div>
  );
}

function DetailsPanel({ data }) {
  return (
    <div className="px-4 py-4">
      {data.description && (
        <p className="text-sm text-gray-600 leading-relaxed mb-4">{data.description}</p>
      )}
      <div className="border border-gray-100 rounded-xl overflow-hidden">
        <InfoRow label="Type" value={data.type} />
        <InfoRow label="Connector" value={data.connectorName} />
        <InfoRow label="Status" value={data.healthy ? "Healthy" : "Unhealthy"} />
        <InfoRow label="Authoritative" value={data.authoritative != null ? String(data.authoritative) : undefined} />
        <DeleteThresholdRow source={data} />
        <InfoRow label="Owner" value={data.owner?.name} />
        <InfoRow label="Cluster" value={data.cluster?.name} />
        <VirtualApplianceRows clusterId={data.cluster?.id} />
        <InfoRow label="Additional owners" value={data.managementWorkgroup?.name ? `Group: ${data.managementWorkgroup.name}` : undefined} />
        <InfoRow label="Created" value={data.created ? new Date(data.created).toLocaleString() : undefined} />
        <InfoRow label="Modified" value={data.modified ? new Date(data.modified).toLocaleString() : undefined} />
        <InfoRow label="Source ID" value={data.id} />
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

// Customizers and the connector log stream only exist for SaaS connectors —
// a VA connector's log (ccg.log) stays on the appliance, out of the API's
// reach — and connector rules only for VA-based ones. Activity (ISC's audit
// events for the source) is on every source: for a VA source it stands in
// for the log; for a SaaS one it holds what Logs doesn't, the provisioning
// outcomes per identity.
const SAAS_ONLY_SECTIONS = ["customizers", "logs"];
const NON_SAAS_ONLY_SECTIONS = ["rules"];

const SECTIONS = [
  { key: "details", label: "Details", Icon: Info },
  { key: "schema", label: "Schema", Icon: Table2 },
  { key: "entitlementSchema", label: "Entitlement Schema", Icon: ListTree },
  { key: "entitlements", label: "Entitlements", Icon: Key },
  { key: "accounts", label: "Accounts", Icon: Server },
  { key: "datasets", label: "Datasets", Icon: Layers },
  { key: "resources", label: "Resources", Icon: Boxes },
  { key: "applications", label: "Applications", Icon: LayoutGrid },
  { key: "history", label: "Aggregation History", Icon: History },
  { key: "provisioning", label: "Provisioning Policies", Icon: ClipboardList },
  { key: "identityProfile", label: "Identity Profile", Icon: UserCog },
  { key: "rules", label: "Connector Rules", Icon: Code },
  { key: "customizers", label: "Connector Customizers", Icon: Cloud },
  { key: "logs", label: "Logs", Icon: ScrollText },
  { key: "activity", label: "Activity", Icon: Activity },
  { key: "json", label: "JSON", Icon: Braces },
];

export default function SourceDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [section, setSection] = useUrlState("tab", "details");
  const [suggestedDescription, setSuggestedDescription] = useState(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["source", id],
    queryFn: () => getSource(id),
  });

  const generateDescription = useMutation({
    mutationFn: () => generateSourceDescription(id),
    onSuccess: (result) => setSuggestedDescription(result.description),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const [editOpen, setEditOpen] = useState(false);
  const editSource = useMutation({
    mutationFn: (fields) => updateSource(id, fields),
    onSuccess: (updated) => {
      toast.success("Source updated");
      if (updated?.id) queryClient.setQueryData(["source", id], updated);
      queryClient.invalidateQueries({ queryKey: ["source", id] });
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      setEditOpen(false);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message, { duration: 8000 }),
  });

  const saveGeneratedDescription = useMutation({
    mutationFn: (desc) => updateSourceDescription(id, desc),
    onSuccess: () => {
      toast.success("Description updated");
      queryClient.invalidateQueries({ queryKey: ["source", id] });
      setSuggestedDescription(null);
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const aggregateEntitlements = useMutation({
    mutationFn: () => aggregateSourceEntitlements(id),
    onSuccess: () => toast.success("Entitlement aggregation started"),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const aggregateAccounts = useMutation({
    mutationFn: (disableOptimization) => aggregateSourceAccounts(id, disableOptimization),
    onSuccess: (_data, disableOptimization) =>
      toast.success(disableOptimization ? "Unoptimized aggregation started" : "User aggregation started"),
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  // Connector "test configuration" check. ISC answers 200 for both outcomes
  // (status SUCCESS or FAILURE with the connector's own details), so the
  // dialog is driven off the response body, not the HTTP status — only a
  // transport/auth failure lands in onError.
  const [testResult, setTestResult] = useState(null); // { success, message } | null
  const testConfiguration = useMutation({
    mutationFn: () => testSourceConfiguration(id),
    onSuccess: (result) => {
      const success = String(result?.status || "").toUpperCase() === "SUCCESS";
      const details = result?.details;
      const detailText =
        details == null || details === "" ? "" :
        typeof details === "string" ? details :
        JSON.stringify(details, null, 2);
      const elapsed = Number.isFinite(result?.elapsedMillis) ? ` in ${result.elapsedMillis} ms` : "";
      const headline = success
        ? `Connector configuration test passed${elapsed}.`
        : `Connector configuration test failed${elapsed}.`;
      setTestResult({ success, message: detailText ? `${headline}\n\n${detailText}` : headline });
    },
    onError: (err) => setTestResult({ success: false, message: err.response?.data?.error || err.message }),
  });

  // Each reset permanently deletes aggregated data on the source, so every
  // one is gated behind resetConfirm (which of the three, or null) rather
  // than firing straight from the icon click — same pattern as the
  // Applications panel's bulk-delete ConfirmModal below.
  const [resetConfirm, setResetConfirm] = useState(null); // "source" | "accounts" | "entitlements" | null
  const resetSourceMutation = useMutation({
    mutationFn: () => resetSource(id),
    onSuccess: () => { toast.success("Source reset started"); setResetConfirm(null); },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const resetAccountsMutation = useMutation({
    mutationFn: () => resetSourceAccounts(id),
    onSuccess: () => { toast.success("Account reset started"); setResetConfirm(null); },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const resetEntitlementsMutation = useMutation({
    mutationFn: () => resetSourceEntitlements(id),
    onSuccess: () => { toast.success("Entitlement reset started"); setResetConfirm(null); },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });
  const resetPending = resetSourceMutation.isPending || resetAccountsMutation.isPending || resetEntitlementsMutation.isPending;

  // Clicking Delete first checks for an associated Identity Profile (ISC
  // won't delete a Source at all while one still names it as
  // authoritativeSource — verified live) so the confirm dialog can offer to
  // delete that too, rather than the user hitting a cryptic "in use" error.
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [associatedProfile, setAssociatedProfile] = useState(null);
  const [deleteProfileToo, setDeleteProfileToo] = useState(true);

  const checkProfileMutation = useMutation({
    mutationFn: () => getSourceIdentityProfile(id),
    onSuccess: (result) => {
      setAssociatedProfile(result?.hasProfile ? result.profile : null);
      setDeleteProfileToo(true);
      setDeleteConfirmOpen(true);
    },
    onError: () => {
      // Fail open — still let the delete attempt happen even if the check
      // itself couldn't be made; ISC's own error will explain if something
      // still references this source.
      setAssociatedProfile(null);
      setDeleteConfirmOpen(true);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      if (associatedProfile && deleteProfileToo) {
        await deleteIdentityProfile(associatedProfile.id);
      }
      await deleteSource(id);
    },
    onSuccess: () => {
      toast.success(associatedProfile && deleteProfileToo ? "Source and Identity Profile deleted" : "Source deleted");
      queryClient.invalidateQueries({ queryKey: ["sources"] });
      queryClient.invalidateQueries({ queryKey: ["identity-profiles"] });
      navigate("/sources");
    },
    onError: (err) => toast.error(err.response?.data?.error || err.message),
  });

  const sourceIscTenant = getCredentials()?.tenant;
  const sourceIscUrl =
    sourceIscTenant && data ? `https://${tenantUiHost(sourceIscTenant)}/ui/a/admin/connections/sources/${data.id}/view/accounts` : null;

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <TopBar
        title="Source"
        onBack={() => navigate(-1)}
        action={
          data && (
            <div className="flex items-center gap-2">
              <IconButton icon={Pencil} title="Edit" onClick={() => setEditOpen(true)} />
              <IconButton
                icon={Link}
                title="Manage Accounts in Identity Security Cloud"
                onClick={() => sourceIscUrl && window.open(sourceIscUrl, "_blank", "noopener,noreferrer")}
                disabled={!sourceIscUrl}
              />
              <IconButton
                icon={PlugZap}
                title="Test Configuration"
                onClick={() => testConfiguration.mutate()}
                loading={testConfiguration.isPending}
                disabled={testConfiguration.isPending}
              />
              <IconButton
                icon={Users}
                title="User Aggregation"
                onClick={() => aggregateAccounts.mutate(false)}
                loading={aggregateAccounts.isPending && aggregateAccounts.variables === false}
                disabled={aggregateAccounts.isPending || aggregateEntitlements.isPending}
              />
              <IconButton
                icon={Key}
                title="Entitlement Aggregation"
                onClick={() => aggregateEntitlements.mutate()}
                loading={aggregateEntitlements.isPending}
                disabled={aggregateAccounts.isPending || aggregateEntitlements.isPending}
              />
              <IconButton
                icon={Zap}
                title="Unoptimized Aggregation"
                onClick={() => aggregateAccounts.mutate(true)}
                loading={aggregateAccounts.isPending && aggregateAccounts.variables === true}
                disabled={aggregateAccounts.isPending || aggregateEntitlements.isPending}
              />
              <IconButton
                icon={UserX}
                title="Reset Accounts"
                onClick={() => setResetConfirm("accounts")}
                disabled={resetPending}
              />
              <IconButton
                icon={KeyRound}
                title="Reset Entitlements"
                onClick={() => setResetConfirm("entitlements")}
                disabled={resetPending}
              />
              <IconButton
                icon={RotateCcw}
                title="Source Reset"
                onClick={() => setResetConfirm("source")}
                disabled={resetPending}
              />
              <IconButton
                icon={Wand2}
                title="Generate a new description with AI"
                onClick={() => generateDescription.mutate()}
                loading={generateDescription.isPending}
                disabled={resetPending || generateDescription.isPending}
              />
              <IconButton
                icon={Trash2}
                title="Delete Source"
                onClick={() => checkProfileMutation.mutate()}
                loading={checkProfileMutation.isPending}
                disabled={resetPending || generateDescription.isPending || deleteMutation.isPending}
                className="!border-red-200 !text-red-600 hover:!bg-red-50"
              />
            </div>
          )
        }
      />

      {editOpen && data && (
        <EditSourceModal source={data} pending={editSource.isPending} onClose={() => setEditOpen(false)} onSave={(fields) => editSource.mutate(fields)} />
      )}
      {testResult && (
        <ResultDialog
          title={testResult.success ? "Configuration Test Passed" : "Configuration Test Failed"}
          success={testResult.success}
          message={testResult.message}
          onClose={() => setTestResult(null)}
        />
      )}

      {resetConfirm && (
        <ConfirmModal
          title={
            resetConfirm === "source" ? "Reset this source?" :
            resetConfirm === "accounts" ? "Reset accounts?" :
            "Reset entitlements?"
          }
          message={
            resetConfirm === "source"
              ? "This permanently deletes every aggregated account and entitlement for this source. This cannot be undone."
              : resetConfirm === "accounts"
              ? "This permanently deletes every aggregated account for this source. This cannot be undone."
              : "This permanently deletes every aggregated entitlement for this source. This cannot be undone."
          }
          confirmLabel="Reset"
          danger
          pending={resetPending}
          onConfirm={() => {
            if (resetConfirm === "source") resetSourceMutation.mutate();
            else if (resetConfirm === "accounts") resetAccountsMutation.mutate();
            else resetEntitlementsMutation.mutate();
          }}
          onCancel={() => setResetConfirm(null)}
        />
      )}

      {deleteConfirmOpen && (
        <ConfirmModal
          title={`Delete "${data?.name}"?`}
          message={
            associatedProfile
              ? `This permanently deletes the source itself, not just its aggregated data. "${associatedProfile.name}" uses this source as its authoritative source — ISC won't let the source be deleted while that's still the case. This cannot be undone.`
              : "This permanently deletes the source itself, not just its aggregated data. This cannot be undone."
          }
          confirmLabel="Delete"
          danger
          pending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate()}
          onCancel={() => setDeleteConfirmOpen(false)}
        >
          {associatedProfile && (
            <label className="flex items-start gap-2 mb-4 text-sm text-gray-700 cursor-pointer">
              <input
                type="checkbox"
                checked={deleteProfileToo}
                onChange={(e) => setDeleteProfileToo(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 mt-0.5"
              />
              <span>Also delete Identity Profile "{associatedProfile.name}"</span>
            </label>
          )}
        </ConfirmModal>
      )}
      <div className="flex-1 overflow-y-auto pb-24">
        <div className="px-4 py-4">
          {isLoading && <SkeletonList rows={6} />}
          {error && <ErrorBox message={error.message} />}
          {data && (
            <>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center flex-shrink-0">
                  <Database size={18} className="text-blue-600" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-gray-900 truncate">{data.name}</h2>
                  {data.connectorName && <p className="text-xs text-gray-500">{data.connectorName}</p>}
                </div>
              </div>
            </>
          )}
        </div>

        {data && (
          <div className="flex border-t border-gray-100">
            <div className="w-28 flex-shrink-0 border-r border-gray-100 py-2">
              {SECTIONS.filter(({ key }) => !(isSaasSource(data) ? NON_SAAS_ONLY_SECTIONS : SAAS_ONLY_SECTIONS).includes(key)).map(({ key, label, Icon }) => (
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
              {section === "details" && <DetailsPanel data={data} />}
              {section === "schema" && <SchemaPanel sourceId={id} sourceType={data.type} sourceName={data.name} />}
              {section === "entitlementSchema" && <EntitlementSchemasPanel sourceId={id} />}
              {section === "entitlements" && (
                <EntitlementsPanel sourceId={id} sourceName={data.name} onNavigateEntitlement={(entId) => navigate(`/entitlements/${entId}`)} />
              )}
              {section === "accounts" && <AccountsPanel sourceId={id} sourceType={data.type} sourceName={data.name} />}
              {section === "datasets" && <DatasetsPanel sourceId={id} />}
              {section === "resources" && <ResourcesPanel sourceId={id} />}
              {section === "rules" && !isSaasSource(data) && <ConnectorRulesPanel sourceId={id} source={data} />}
              {section === "customizers" && isSaasSource(data) && <ConnectorCustomizersPanel sourceId={id} source={data} />}
              {section === "logs" && isSaasSource(data) && <SaasConnectorLogsPanel sourceId={id} source={data} />}
              {section === "activity" && <SourceActivityPanel sourceId={id} source={data} saas={isSaasSource(data)} />}
              {section === "applications" && <ApplicationsPanel sourceId={id} sourceName={data.name} />}
              {section === "history" && <AggregationHistoryPanel sourceId={id} />}
              {section === "provisioning" && <ProvisioningPoliciesPanel sourceId={id} />}
              {section === "identityProfile" && <IdentityProfilePanel sourceId={id} />}
              {section === "json" && (
                <RawJsonPanel data={data} resource="sources" objectId={id} invalidateKeys={[["source", id], ["sources"]]} />
              )}
            </div>
          </div>
        )}
      </div>

      {suggestedDescription != null && data && (
        <GeneratedDescriptionModal
          currentDescription={data.description}
          suggestion={suggestedDescription}
          onClose={() => setSuggestedDescription(null)}
          onSave={(desc) => saveGeneratedDescription.mutate(desc)}
          pending={saveGeneratedDescription.isPending}
        />
      )}
    </div>
  );
}
