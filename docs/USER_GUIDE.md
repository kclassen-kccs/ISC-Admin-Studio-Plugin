# User Guide

A walkthrough of every screen of Admin Studio as it runs inside SailPoint
Identity Security Cloud (ISC), organized by the six sidebar tabs: **Home**,
**Browse**, **Tools**, **Mining**, **Backup & Restore**, **Studio
Settings**. Domain terms in **bold** are defined in [GLOSSARY.md](GLOSSARY.md);
the exhaustive per-screen inventory of actions and rules is
[FEATURE_LIST.md](FEATURE_LIST.md).

---

## Getting in

There is nothing to sign in to. An administrator installs the plugin on the
tenant (see [../dist/INSTALL.md](../dist/INSTALL.md)), and you open it at
`https://<tenant>.identitynow.com/ui/plugin/<instance id>` while signed in to
ISC. ISC opens Admin Studio in its own page and hands it a token for your
session, so everything you do here runs with your own ISC permissions and
nothing more. Who may open the plugin is decided by ISC, not by the plugin.

What the plugin stores (scan results, saved reports, settings, mitigations)
lives in your browser, per tenant. Another browser or another person starts
with an empty slate, and a scan only runs while its tab stays open.

---

## Home

The Admin Studio banner across the top shows the tenant name in the
tenant's own instance badge colour. Below it: "At a glance" tiles for
Identities, Sources, Roles and Common Access Roles (each opens the matching
list); "Active Role Statistics" (Roles OK / Roles Needing Updates, with SOD
flags, from the most recent [Role Statistics Refresh](GLOSSARY.md#role-statistics-refresh));
and "View my reports" when you have saved PDF reports. The avatar opens
Profile (your name, tenant, API and plugin versions). A tenant that has never
run Schema Analysis is sent there first.

---

## Browse

The general-purpose ISC browsing and management surface. Every list has
search, filters kept in the URL, a pager above and below the list, multi
select with a bulk action bar, and Print menus for PDF reports; every detail
screen has a "View in Identity Security Cloud" link and a JSON tab with an
editor (Tree or Text, with **Fix with AI** for JSON that doesn't parse).

- **Identities** — search and filter (identity profile, lifecycle state,
  any Schema Analysis attribute), detail with accounts, entitlements,
  access, activity (with AI explanations of failed events) and lifecycle
  state changes; bulk enable and disable.
- **Roles** — list and detail; see [Role Detail](#role-detail-the-core-screen).
- **Entitlements** — tenant-wide list; detail with Members, Roles and
  Access Profiles tabs; AI descriptions; metadata tagging.
- **Access Profiles** — full edit (name, description, owner, entitlements,
  approvals), enable/disable, AI descriptions, bulk operations.
- **Applications** — list and detail with access profiles and
  visibility/requestability toggles.
- **Sources** — detail with Entitlements, Accounts, Applications,
  Aggregation History, Provisioning Policies, Identity Profile, Activity,
  Logs, Connector Rules and Connector Customizers tabs; trigger account,
  entitlement and unoptimized aggregations; account, entitlement and full
  source resets; delete. **Add Disconnected Source** creates a Delimited
  File source from a CSV and can create a matching Identity Profile with
  AI-matched attribute mappings. **Edit Accounts** adds, edits and removes
  accounts on Delimited File sources.
- **Workflows** — list, detail with definition, executions and validation;
  JSON editing with a disable/save/re-enable flow; AI: draft a workflow from
  requirements through an outline, propose a modification, and draw the
  definition as a flowchart.
- **Forms**, **Launchers**, **Transforms** — list and detail with JSON
  editing (transforms can be evaluated against an identity).
- **Governance Groups** — create, edit, delete; members (bulk add and
  remove); a Usage tab showing everywhere the group is referenced.
- **Metadata** — Access Model Metadata attributes and their values, with
  the roles, access profiles and entitlements tagged by each value, and
  bulk tagging.
- **Data Segments** (only when the Multi-Company/Division Boundary and its
  "Create Data Segments" toggle are on) — this plugin's Data Segments:
  list, build, enable/disable, and a detail view that renders the
  segment's criteria in plain English with its roles and entitlements.
- **Segments** — ISC's access-request Segments: activate, deactivate,
  delete, and a detail with the matched identities, roles, access profiles
  and entitlements.
- **User Certifications** — the tenant's certification campaigns with
  their reports.
- **Parameter Storage** — ISC Parameter Storage: create, edit and delete
  parameters of every type the tenant offers; secrets are encrypted in the
  browser before they are sent and are never shown again.
- **Org Info** — the tenant's org configuration, read-only.

### Role Detail — the core screen

Tabs for Details, Membership Rules, Entitlements, Members, Access
Profiles, Dimensions (Dynamic roles) and more. Actions:

- Enable / disable / delete, requestable and visibility toggles,
  certification of the role's composition
- **Evaluate** (sparkles) — opens the Common Access picker (choose which
  overlapping [Common Access](GLOSSARY.md#common-access) roles to exclude
  from suggestions), then runs [Role Evaluation](GLOSSARY.md#role-evaluation)
  for this one role
- AI-generated description (edit and save); AI review of the role's
  composition
- Full edit: owner and additional owners, Standard vs. Dynamic type,
  flag as Common Access
- Add and remove entitlements and members; dimension CRUD with per
  dimension entitlements
- From an evaluation result: accept all, accept one dimension's proposal,
  create a missing dimension, remove a stale dimension, and either
  **Repair Role** (remove the conflicting entitlements) or **Mitigate**
  (apply a time-limited [SOD mitigation](GLOSSARY.md#sod-mitigation))

The Roles list has the same Eval action for whatever is filtered, plus
Print modes (simple list / brief / full detail), Email Report (one PDF per
owner with a pre-filled mail link; nothing is sent automatically) and
batch Rename.

---

## Tools

- **Event Log** — the tenant's audit events, newest first, with All /
  Failed / Retryable Failures views and a 24 hours / 7 days / 30 days
  window. A failed event's sheet offers **Suggest a fix with AI**: the
  likely cause and concrete correction steps from the event's own fields,
  saved per event in this browser.
- **Base64** and **URL Encode** — encode and decode entirely in the
  browser.

---

## Mining

The role-engineering workflows. Scan-detail screens show every proposed
item on the left and the selected item's full card on the right.

### Role Model Drafts

Start, list and cancel a peer-group discovery scan
([Role Scan](GLOSSARY.md#role-scan-aka-role-model-draft)). Each discovered
[peer group](GLOSSARY.md#peer-group) shows members, entitlements and
dimension previews. Create one role or all of them, with an AI
name/description review step first; print the draft as a PDF.

### Role Evaluation

Tenant-wide [Role Evaluation](GLOSSARY.md#role-evaluation) scans and the
Role Statistics Refresh (Run Now). Per-role result cards show stale and
missing entitlements, dimension gaps, missing or stale dimensions and SOD
violations with Mitigate or Repair Role actions; "Accept" applies one
role's suggestions, "Accept all" applies every result. Printable as a PDF
report.

### Skeleton Roles

The cheap variant: buckets identities purely by Schema Analysis's top
attributes, fetches no entitlements, and creates roles and dimensions
disabled ([Skeleton role](GLOSSARY.md#skeleton-role)).

### Attribute Sync

Scans every source's provisioning policy for identity-attribute-mapped
fields and proposes an Attribute Sync configuration per source (Already
Enabled / Recommended / Excluded, with reasons); deploy one source at a time
or all recommended changes at once. Printable.

### Mail Distribution Groups

Proposes mail distribution lists from the role model and generates the
PowerShell to create them in AD or Entra, since ISC's API can't create
those groups itself.

### User Certifications

Plans one certification campaign per combination of the attributes you
choose in Studio Settings → User Certifications, shows the users and
access items each campaign would cover, and creates the campaigns in ISC
staged, never activated from here.

### Segments

Proposes one ISC access-request Segment per Multi-Company/Division
Boundary value, with the roles, access profiles and entitlements its
members hold; create all or selected, optionally activating the new
Segments.

### Data Segments (conditional)

Only when the Boundary and "Create Data Segments" are on: proposes a
[Data Segment](GLOSSARY.md#data-segments) per boundary value combination
with matching roles and entitlements; create individually, all at once, or
merge into an existing segment; assign matching roles and entitlements to
existing segments. Printable.

---

## Backup & Restore

- **Backup Configuration** — exports the tenant's full SP-Config as a
  JSON download.
- **Restore Configuration** — loads a prior export, lets you pick objects
  from a browsable tree, and imports them (additive only; nothing created
  since the backup is removed).
- **Backup Offline Sources** — exports schema and accounts of Delimited
  File sources as CSV, one file per source or one ZIP.
- **Restore Offline Source** — re-uploads selected rows of a backup CSV
  and aggregates them into the chosen source.

---

## Studio Settings

- **Mining Config** — Role Scan scope, Dynamic-role and duplicate-role
  toggles, Role Naming (prefix/suffix/separator), the Skeleton Scan
  trigger.
- **Schema Analysis** — runs [Schema Analysis](GLOSSARY.md#schema-analysis),
  lets you reorder or override the top-attribute pick, and configures the
  [Multi-Company/Division Boundary](GLOSSARY.md#boundary-attributes--multi-companydivision-boundary)
  with its "Create Data Segments" toggle.
- **Evaluation Config** — role filtering for manual evaluations,
  "Consider Common Roles" and "Check for SOD Violations" toggles, result
  retention, the "Allow SOD Mitigations" gate and a Manage Mitigations
  screen.
- **User Certifications** — the attributes, scope, reviewer, deadline and
  filters the certification planner uses.
- **Preferences** — Tenant Conversion (convert a demo tenant to a new role
  model end to end), Appearance (System / Light / Dark), JSON Edit Mode
  (Text or Tree), **AI Route** (ISC workflow, the default, or Direct from
  this browser) and the **Anthropic API Key** field: *Save to ISC* writes
  the key, encrypted, into the tenant's "Admin Studio AI Key" parameter and
  creates the AI connection parameter and the "Admin Studio AI Query"
  workflow when the tenant lacks them. The plugin keeps no copy of the
  key; the field only shows that the tenant holds one, with Replace.

---

## What needs a server, and isn't here

The plugin can only call the tenant's own API. The LDAP tools (Add from
LDAP) and the connection tests on Parameter Storage need outbound calls ISC
doesn't allow a plugin to make, and say so on screen. The "Direct from this
browser" AI route is blocked for the same reason today; the ISC workflow
route is the one that works. Access Requests, Approvals and Tasks are not
in the plugin at all: ISC's own UI covers them.
