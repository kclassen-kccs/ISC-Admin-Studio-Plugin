# Architecture

Developer-facing reference for how the plugin is put together. For what each
screen does, see [USER_GUIDE.md](USER_GUIDE.md) and
[FEATURE_LIST.md](FEATURE_LIST.md); for domain terminology, see
[GLOSSARY.md](GLOSSARY.md). The earlier standalone app (Express proxy, OAuth
sign-in, AWS deployment, iOS build) is described only in
[archive/](archive/README.md).

## Overview

Admin Studio is a static React bundle that SailPoint Identity Security Cloud
(ISC) loads into a sandboxed iframe as a **UI plugin**. There is no server of
its own: every call goes from the browser to the tenant's own REST API with a
token the ISC App Shell issues for the signed-in user.

```
ISC App Shell ──postMessage handshake──▶ Admin Studio (React, sandboxed iframe)
      │ tenant API URL + scoped token              │  axios, one interceptor (lib/sailpoint.js)
      └───────────────────────────────────────────┴──▶ https://<tenant>.api.identitynow.com  (v3 / beta / v2025 / v2026)
                                                       │
                     "Admin Studio AI Query" workflow ◀─┘ test execution, user's session
                              │ HTTP Request step, key from Parameter Storage
                              ▼
                       api.anthropic.com (Claude Messages API)
```

Three consequences shape everything below:

- **The user's rights are the ceiling.** The token is scoped by
  `apiScopes` in `sp-ui-plugin.json` and never exceeds what the signed-in
  user may do in ISC. There is no service credential and no "elevated" mode.
- **No outbound calls.** The plugin content security policy allows the
  tenant API only, so the browser cannot reach a model provider, an LDAP
  server or an arbitrary HTTP endpoint. AI goes through an ISC workflow
  (below); LDAP tools and parameter connection tests say on screen that they
  need a server the plugin doesn't have.
- **Storage is the browser's.** Everything the old server kept (scan results,
  settings, reports, mitigations) is in the plugin iframe's own IndexedDB,
  per tenant and per browser.

## Handshake and authentication

`@sailpoint/ui-plugin-sdk` performs the handshake with the App Shell.
`client/src/lib/pluginSdk.js` owns the single SDK instance:

- `whenPluginReady()` resolves once the handshake completed.
- `getApiConfig()` returns `{ baseUrl, token }`: the tenant API base URL from
  `context.tenant.apiUrl.idn` and a fresh token from `sdk.api.getToken()`.
- `reportRoute(subPath)` mirrors the app's hash route into the ISC page URL.

`client/src/hooks/useAuth.jsx` turns the handshake context into the app's
`session` (tenant, user, token claims). Opening the bundle outside ISC cannot
complete the handshake and shows a connection error. There is no sign-in
screen, no sign-out and no token renewal in the plugin; the App Shell owns
the session.

## API calls

A global axios request interceptor in `client/src/lib/sailpoint.js` rewrites
any `/api/isc/<version>/<path>` request to the tenant API and attaches the
bearer token. `sailpoint.js` is still the one module every page calls (about
180 exported functions grouped by feature area); it either calls ISC directly
through that interceptor or delegates to a ported module.

`client/src/lib/isc.js` holds the shared helpers the ported modules use:
`iscGet` / `iscPost` / `iscPut` / `iscPatch` / `iscDelete` / `iscRaw`,
`withApiRetry` (transient failures in scan loops), `fetchAllPaged` (paginate a
list endpoint to exhaustion), `iscSearchPage` (one page of the search index),
and error shaping: `routeError` and `badRequest` produce errors shaped like the
old server's `{ error }` responses, so pages still read
`err.response.data.error`.

Headers and conventions the tenant API needs (JSON-Patch content type for
PATCH, `X-SailPoint-Experimental: true` for preview endpoints, hyphen-aware
search queries, the 10,000-record paging ceiling) are handled in the helpers
and documented where they bite in [FEATURE_LIST.md](FEATURE_LIST.md).

## Ported server logic (`client/src/lib/ported/`)

The old Express server's dedicated routes were ported one handler at a time
into browser modules with the same record shapes, validation and error
messages. The ones worth knowing by name:

| Module | Holds |
|---|---|
| `roleMiningShared.js`, `roleScans.js`, `skeletonScans.js` | Role Scan / Skeleton Scan: identity profiles, `partitionProfilesByBoundary`, `buildPeerGroups`, role creation from a peer group |
| `roleEvaluation.js`, `roleEvalScans.js` | `evaluateRoleAlgorithmic`, `findSodViolations`, SOD mitigations, tenant-wide evaluation scans, role composition review |
| `roleCommonAccess.js`, `roleStats.js`, `roleDimensions.js`, `roleMembers.js`, `roles.js` | Common Access tracking (`criteriaLeavesSubsetOf`), Role Statistics Refresh, dimension and membership editing |
| `schemaAnalysis.js`, `segments.js`, `segmentScans.js`, `segmentRoleMatches.js`, `accessSegmentScans.js`, `dlScans.js`, `attributeSyncScans.js`, `certificationRuns.js`, `campaignReports.js` | The other Insights scans and their results |
| `settings.js` | Tenant settings, Studio preferences, per-user preferences |
| `parameters.js`, `parameterCrypto.js` | Parameter Storage, with private fields encrypted in the browser to SailPoint's enclave (attestation document verified, then a JWE the enclave alone can open) |
| `aiDescriptions.js`, `opsSuggestions.js`, `jsonRepair.js`, `workflowAi.js`, `sourceIdentityProfile.js` | Every AI feature (see below) |
| `reports.js` | Saved and emailed PDF reports |
| `scanJobs.js` | Shared scan plumbing: `startJob`, `patchRecord`, `requestCancel`, `failInterrupted` |

### Scans run in the page

On the server each scan was a record in a store plus an async runner that
kept patching the record until it finished. In the plugin the runner is the
same code, running in the page: a scan keeps going while the tab is open and
is lost on a full reload, so a "running" record with no live runner is marked
failed the next time its store is read (`scanJobs.failInterrupted`). Cancel
sets a flag the runner polls. Long scans therefore want a tab that stays
open; there is no background scheduler, which is also why the scheduled Role
Statistics Refresh of the old app is now "Run Now" only.

## Persistence

`client/src/lib/store.js` is one async record-store interface,
`get(key)` / `all()` / `put(key, value, {ttlEpochMs})` / `delete(key)`, the
same shape the server's JSON, SQLite and DynamoDB backends shared. It is
backed by IndexedDB in the plugin iframe's own origin (database
`admin-studio`), with every record namespaced by tenant so one browser used
against several tenants never mixes data, and an in-memory fallback when
IndexedDB is blocked (the app runs, nothing persists).

| Store | Holds |
|---|---|
| `role-scans`, `skeleton-scans`, `role-eval-scans` | Scan run history and results |
| `schema-analysis` | Last Schema Analysis run, chosen top attributes, Boundary configuration |
| `sod-mitigations` | Active and expired SOD mitigation exceptions |
| `tenant-settings`, `studio-preferences`, `user-preferences` | Mining / evaluation configuration, Studio preferences, per-user preferences (appearance, JSON edit mode, AI route) |
| `flagged-common-access-roles`, `denied-common-access-roles` | Roles this plugin flagged, or refused to flag, as Common Access |
| `role-reports`, `saved-reports` | PDF reports (the PDF itself is stored, 2-week retention for emailed role reports) |
| `ops-suggestions` | Saved AI fix suggestions for Event Log, Activity and connector-log entries |
| `metadata-value-ids` | Access Model Metadata value GUIDs harvested from Data Segments |
| `connector-customizer-sources` | Connector customizer scripts, which ISC never returns |

Because the data is per browser: a scan started on one machine is not
visible on another, a role-report "link" only opens in the browser that
created it (it points at the plugin's own My Reports page), and clearing site
data for the plugin origin clears everything above.

## AI

Every AI feature builds its prompt in the browser from ISC data fetched with
the user's own token and calls one function, `generateText` in
`client/src/lib/aiProxy.js`, which picks the route from the user's **AI Route**
preference:

- **ISC workflow** (default; `client/src/lib/aiWorkflow.js`). The tenant's
  "Admin Studio AI Query" workflow has one HTTP Request step that POSTs the
  Claude Messages API request to the URL in the "Admin Studio AI Connection"
  parameter, authenticated with the "Admin Studio AI Key" parameter
  (`x-api-key`). The plugin starts it through the workflow **test** endpoint
  with the user's session (the External Trigger's execute endpoint only
  accepts its own OAuth client), polls the execution, and reads the step's
  `statusCode` and `body` from the execution history. ISC refuses test
  executions of an enabled workflow, so the workflow must stay disabled.
- **Direct from this browser.** A call to `api.anthropic.com` with a key the
  user typed in this tab, held in memory only until the tab closes. ISC's
  plugin policy blocks that call today; the route is kept for when it is
  allowed, with the `ai-proxy/` service as its fallback.

The Anthropic API key is persisted nowhere in the plugin. Saving it on
Studio Settings → Preferences ("Save to ISC", `client/src/lib/aiSetup.js`)
writes it, encrypted in the browser, into the "Admin Studio AI Key"
parameter and creates the connection parameter and the workflow (from
`client/src/lib/aiWorkflow.template.json`, bound to the key parameter,
disabled) when the tenant lacks them. Replacing the key updates the parameter
and checks the other two are still there. `scripts/setup-ai-workflow.mjs` does
the same from a terminal with an API client, leaving a placeholder key.
[isc/README.md](../isc/README.md) describes the tenant objects.

Models: a fast model for the many short prompts (descriptions, fix
suggestions, JSON repair) and a strong one where a call asks for it (workflow
drafting and modification, role composition review); both named in
`aiProxy.js`.

## Client structure

- **Routing**: `HashRouter` in `App.jsx`; see [USER_GUIDE.md](USER_GUIDE.md)
  for the page map. The current route is reported to the App Shell so the ISC
  page URL follows it.
- **Server state**: `@tanstack/react-query` throughout, no Redux or Zustand.
- **Navigation**: `components/Nav.jsx` (sidebar with collapsible sections,
  drawer on narrow viewports), `components/TopBar.jsx` and the `*TitleMenu`
  components (the screen title is a dropdown for sibling screens).
- **UI primitives**: `components/ui.jsx` (buttons, fields, search and filter
  bars, skeleton loaders, empty and error states, confirm modal, status
  badges, metric cards). No charting library.
- **JSON editing**: `components/JsonEditor.jsx` and `JsonTree.jsx` (Tree and
  Text modes over one buffer), `JsonAiFix.jsx` (AI syntax repair review).
- **Reports**: `lib/export*Pdf.js` and `lib/pdfUtils.js`, jsPDF-based PDF
  generation for lists, details and scan reports; `components/EmailReportDialog.jsx`
  builds one PDF per owner with a `mailto:` link (nothing auto-sends).
- **Tests**: Jest through craco (`CI=true npx craco test --watchAll=false`),
  with unit tests beside the modules they cover (`*.test.js`).

## The role-mining algorithm (Role Scan)

`roleScans.js`:

1. Pull every active identity's attributes and entitlements through the
   search index (`searchAllIdentities`, 250 per page).
2. If the Multi-Company/Division Boundary is enabled,
   `partitionProfilesByBoundary` splits the identity set by boundary-attribute
   combination first, and everything below runs independently per partition
   (including its own Common Access proposal).
3. `buildPeerGroups` buckets identities by attribute combination, broadest
   first, so identities differing only on some attributes collapse into one
   Dynamic role with dimensions rather than fragmenting; each group's
   commonly held entitlements are computed at a configurable commonality
   threshold, excluding what an in-scope Common Access role already grants.
4. The reviewer picks which discovered peer groups become real roles
   (`createRoleForPeerGroup`), optionally reviewing AI-generated names and
   descriptions first.

Skeleton Scan (`skeletonScans.js`) is the same pipeline with step 1 skipped:
it buckets purely by Schema Analysis's top attributes, fetches no
entitlements, and always creates roles disabled.

## The role-evaluation algorithm

`evaluateRoleAlgorithmic` in `roleEvaluation.js`, deterministic (an earlier
AI-based version was tried and removed):

1. Live-evaluate the role's membership criteria against every active identity,
   not from ISC's search index.
2. Fetch each matched member's entitlements.
3. Compute stale and commonly-held-but-missing entitlements, separately for the
   base role (percentage threshold) and each dimension (raw-occurrence
   threshold, since dimension populations are small).
4. Detect missing dimensions (an attribute value with enough shared
   entitlements that isn't yet a dimension) and stale dimensions.
5. `findSodViolations` checks conflicting-access SOD policies against both
   base and dimension entitlement sets, then active mitigations are split out.
6. `filterApplicableCommonAccessEntIds` excludes entitlements covered by
   applicable Common Access roles so birthright access isn't double-flagged.

Exposed as a single-role evaluation (`evaluateRole`) and as tenant-wide scans
(`roleEvalScans.js`, with accept, accept-all and mark-handled actions).

## What the plugin cannot do

- **Outbound calls**: LDAP lookups (the "Add from LDAP" tools), parameter
  connection tests (test-http / test-oauth) and any direct model call. The
  functions raise "not yet available in the Identity Security Cloud plugin"
  and the screens say so.
- **Background work**: nothing runs when no tab is open (no scheduled
  evaluations, no server-side report hosting).
- **Cross-device state**: preferences and results do not sync between
  browsers.

`server/` still holds the old Express code as a reference for the port and is
not built, deployed or packaged. `ai-proxy/` is the optional fallback for the
direct AI route.
