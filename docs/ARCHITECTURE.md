# Architecture

Developer-facing reference for how the app is put together. For what each
screen does, see [USER_GUIDE.md](USER_GUIDE.md); for domain terminology, see
[GLOSSARY.md](GLOSSARY.md).

## Overview

```
Browser / iOS app (React, client/)
        │  every request, one axios client (lib/sailpoint.js)
        ▼
Express proxy (server/index.js, ~6,900 lines)
        │  generic pass-through            │  dedicated business-logic routes
        │  app.all("/api/isc/*")           │  role mining, evaluation, segments,
        │                                  │  schema analysis, settings, SOD
        ▼                                  ▼
https://{tenant}.api.identitynow-demo.com (SailPoint ISC v2026 API)
        + api.anthropic.com (role/access-profile description generation only)
```

The server is not a dumb CORS-dodging proxy — it's where most of the
domain-specific logic lives. Roughly 40% of `server/index.js` is role-mining
and role-evaluation algorithms with no ISC equivalent; the rest is auth and a
generic forward-anything-to-ISC route that most simple CRUD calls ride on.

## Auth

Sign-in is OAuth 2.0 **authorization code** flow against SailPoint's own
hosted login page — the app never sees a user's ISC password. Flow:

1. Client requests an authorize URL from the proxy (`/api/auth/*`) for a
   chosen tenant.
2. User authenticates on ISC's hosted page, gets redirected back to
   `<app-origin>/auth/callback` with a code.
3. The proxy exchanges the code for tokens and creates a **server-side
   session** (opaque session ID, tokens held in a server-side map — never
   sent to the browser).
4. Every subsequent client call passes the session ID; the proxy attaches
   the real bearer token when forwarding to ISC.

OAuth clients are **tenant-scoped in ISC**, so each tenant that supports
sign-in needs its own registered client
(`node scripts/register-oauth-client.js`), stored AES-256-GCM-encrypted in
`server/data/oauth-clients.json` under `DATA_ENCRYPTION_KEY`. A tenant
without strong auth (MFA) falls back to a stored service credential rather
than blocking sign-in; the client shows a strong-auth status indicator
(green/amber/red) per tenant (`Nav.jsx`).

Legacy PAT/client-credential env vars (`SP_DEFAULT_*`) are still read but are
**no longer used for sign-in** — they exist only for local scripts calling
the API without a user session. See `server/.env.example`.

## Persistence

Every store goes through one async record-store interface —
`get(key)` / `all()` / `put(key, value, {ttlEpochMs})` / `delete(key)` —
with the backend chosen by `STORAGE_BACKEND` (`server/storage/index.js`):

- **`json`** (default — local dev, Railway test env): flat JSON files under
  `DATA_DIR` (`server/data/`), cached in memory, whole file rewritten per
  change. On a container host, mount `DATA_DIR` to a persistent volume.
- **`sqlite`**: same shape over a single `app.sqlite` (WAL, per-key diffs).
- **`aws`** (production): **no cache of any kind** — every read/write is a
  live call. Records live in one DynamoDB table (`store` partition key,
  `key` sort key, per-item TTL); the OAuth client registry is a single
  app-layer-encrypted S3 object; report PDFs are S3 blobs. Because no
  state lives in the process or on disk, the server is stateless: it
  survives restarts with sessions intact and can scale to multiple
  instances without code changes.

The stores (record-store name = the json backend's filename):

| Store | Holds |
|---|---|
| `oauth-clients.json` | Encrypted per-tenant OAuth client registry (S3 object on aws) |
| `role-scans.json`, `skeleton-scans.json` | Role Scan / Skeleton Scan run history and results |
| `role-eval-scans.json` | Role Evaluation scan run history and per-role results |
| `attribute-sync-scans.json`, `segment-scans.json`, `segment-role-matches.json` | Attribute Sync / Data Segment scan history |
| `schema-analysis.json` | Last Schema Analysis run, chosen top attributes, Boundary config |
| `sod-mitigations.json` | Active/expired SOD mitigation exceptions |
| `tenant-settings.json` | Role Mining/Evaluation configuration (naming, thresholds, scope, toggles) |
| `studio-preferences.json` | Role Statistics Refresh schedule |
| `user-preferences.json` | Per-user preferences (dark mode) |
| `flagged-common-access-roles.json` | Roles this app has flagged as Common Access |
| `role-reports.json`, `saved-reports.json` | Report metadata (PDF blobs on disk locally, S3 on aws) |
| `sessions`, `pending-logins`, `completed-native-logins`, `service-tokens` | Auth state — in-memory on local backends, DynamoDB (TTL'd) on aws; session and service-token values are AES-256-GCM-encrypted with `DATA_ENCRYPTION_KEY` before writing |
| `local-login-attempts` | Local-admin failed-attempt lockout counters |

## Client structure

- **Routing**: `App.jsx` — see [USER_GUIDE.md](USER_GUIDE.md) for the full
  page-by-page map.
- **Server state**: `@tanstack/react-query` throughout — no Redux/Zustand.
  All API calls go through the single `lib/sailpoint.js` module (grouped by
  feature area: auth, identities, entitlements, sources, access
  requests/approvals/work items, roles CRUD, AI descriptions, Common Access,
  evaluation/SOD, dimensions, role propagation, access profiles, tenant/studio
  settings, schema analysis, segments, role scans, role eval scans).
- **UI primitives**: `components/ui.jsx` (buttons, fields, search/filter bar,
  skeleton loaders, empty/error states, confirm modal, status badges, metric
  cards). No charting library — "statistics" render as colored stat
  tiles/badges, not charts.
- **Reports**: `lib/exportRolePdf.js`, `exportRoleScanPdf.js`,
  `exportEntitlementPdf.js`, `pdfUtils.js` — jsPDF-based PDF generation for
  role lists/detail (simple / brief / full), scan reports, and segment lists.
- **Native**: Capacitor wraps the same React build for iOS
  (`client/ios/App`, `capacitor.config.ts`); `npm run build:native` points
  the build at the deployed proxy via `REACT_APP_API_BASE` and runs
  `cap sync ios`.

## Server routes

### Generic proxy

`app.all("/api/isc/*")` forwards arbitrary method/path/body/query to
`https://{tenant}.api.identitynow-demo.com{path}` with the session's bearer
token, relaying `content-type`, `x-total-count`, and `link` headers back.
Most simple list/CRUD calls in `lib/sailpoint.js` (identities, entitlements,
sources, access requests, roles list/get, access profiles, campaigns, SOD
violations) ride on this rather than having a dedicated server route.

One side effect lives here: a `DELETE /v2026/roles/:id` through this generic
path also calls `forgetFlaggedCommonAccessRole`, so a deleted Common Access
role drops out of this app's tracking.

### Dedicated business-logic routes

Grouped by feature (see `server/index.js` section headers for exact line
ranges):

- **Role editing** — field/enabled/entitlements/members PATCH, live
  membership-rule evaluation, dimension CRUD.
- **AI descriptions** — `POST /api/roles/:id/generate-description`,
  `/api/insights/role-descriptions/generate-all`,
  `/api/access-profiles/:id/generate-description`. Calls Claude Haiku 4.5
  via `api.anthropic.com/v1/messages`; requires `ANTHROPIC_API_KEY`. **This
  is the only AI usage in the app** — role evaluation was deliberately moved
  off AI to a deterministic algorithm.
- **Common Access** — flag/unflag, overlap lookups (single and bulk).
- **Role Scan / Skeleton Scan** — start/list/get/cancel/delete, per-group
  "create role", bulk description generation.
- **Schema Analysis** — run/get, set top attributes, set Boundary config.
- **Data Segments** — list/get/delete, set active, build-from-Boundary.
- **Role Evaluation** — the algorithmic core (`evaluateRoleAlgorithmic`, the
  single largest function in the file) plus the scan wrapper
  (start/list/get/cancel/delete, accept/accept-all/mark-handled) and SOD
  mitigation CRUD (per-role and tenant-wide).
- **Settings** — tenant settings (naming, thresholds, retention, boundary,
  SOD toggles, name scope), Studio preferences (Role Stats Refresh
  schedule), per-user preferences (dark mode).
- **Role Statistics Refresh** — `run-now` and summary endpoints;
  `checkRoleStatsRefreshSchedules` runs on a 60-second in-process
  `setInterval` tick (not a real cron) to detect due schedules.
- **Source aggregation** — trigger account/entitlement aggregation, read
  history.
- **Work items**, **health check**.

### Cross-cutting infra

- A global axios response interceptor retries any `429` up to 5 times,
  honoring `Retry-After` — covers every outbound call (ISC, Anthropic, OAuth
  token exchange).
- `withApiRetry` — additional retry wrapper for scan-loop transient
  failures.
- `mapWithConcurrency` — bounds concurrent per-identity/entitlement fetches
  used throughout scan and evaluation code (typically concurrency 8).
- `express-rate-limit` (120 req/min) and `helmet`.

## The role-mining algorithm (Role Scan)

`runRoleScan`:
1. `fetchIdentityRoleProfile` — pull every active identity's attributes and
   entitlements.
2. If the Multi-Company/Division Boundary is enabled,
   `partitionProfilesByBoundary` splits the identity set by boundary-attribute
   combination first, and everything below runs independently per partition
   (including its own Common Access proposal).
3. `buildPeerGroups` — bucket identities by attribute combination, broadest
   first, so identities differing only on some attributes collapse into one
   Dynamic role with dimensions rather than fragmenting; compute each
   group's commonly-held entitlements (`commonlyHeldEntitlementIds`) at a
   configurable commonality threshold.
4. Reviewer picks which discovered peer groups become real roles
   (`createRoleForPeerGroup`), optionally reviewing AI-generated
   names/descriptions first.

Skeleton Scan is the same pipeline with step 1 skipped entirely — buckets
purely by Schema Analysis's top attribute(s), no entitlement fetch, roles
always created disabled.

## The role-evaluation algorithm

`evaluateRoleAlgorithmic` (`server/index.js:5337`):
1. Live-evaluate the role's membership criteria against every active
   identity (`findRoleMembers`) — not from ISC's search index.
2. Fetch each matched member's entitlements.
3. Compute stale and commonly-held-but-missing entitlements, separately for
   the base role (percentage-based threshold) and each dimension
   (raw-occurrence-based threshold, since dimension populations are small).
4. Detect missing dimensions (an attribute value with enough shared
   entitlements that isn't yet a dimension) and stale dimensions.
5. `findSodViolations` — check conflicting-access SOD policies against both
   base and dimension entitlement sets.
6. `filterApplicableCommonAccessEntIds` — exclude entitlements covered by
   applicable Common Access roles so birthright access isn't double-flagged.

Exposed via `POST /api/roles/:id/evaluate` (single role) and the
`/api/insights/role-eval-scans` family (tenant-wide scans, with
accept/accept-all/mark-handled actions).

## Known loose end

The root `package.json` lists `@supabase/ssr` and `@supabase/supabase-js` as
dependencies, but nothing under `client/` or `server/` appears to import
them — likely vestigial from an earlier iteration. Worth confirming and
removing rather than treating as load-bearing.
