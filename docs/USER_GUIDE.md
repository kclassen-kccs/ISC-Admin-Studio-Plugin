# User Guide

Walkthrough of every screen, organized by the four navigation tabs (**Home**,
**Browse**, **Role Mining**, **Studio Settings**). Domain terms in **bold**
are defined in [GLOSSARY.md](GLOSSARY.md).

---

## Home

Dashboard: identity/source/role counts, a pending-approvals alert, "Common
roles" summary, and Role Statistics tiles (OK / Needs Updates / SOD, sourced
from the most recent [Role Statistics Refresh](GLOSSARY.md#role-statistics-refresh))
in a pass/fail traffic-light style. Quick actions for a new access request
and jumping into recent pending approvals.

---

## Sign-in

`LoginPage` / `AuthCallbackPage` — pick or self-register a tenant, then sign
in through ISC's own hosted login page (authorization-code OAuth; see
[ARCHITECTURE.md](ARCHITECTURE.md#auth)). On native iOS, the callback hands
off through a custom URL scheme.

---

## Browse

The general-purpose ISC browsing/management surface.

- **Identities** — search/list (filterable by Identity Profile, Active/
  Inactive lifecycle state, and any Schema Analysis attribute/value),
  detail view (accounts, entitlements), enable/disable lifecycle state.
- **Sources** — list/detail with Entitlements, Accounts, Applications,
  Aggregation History, Provisioning Policies, and Identity Profile tabs;
  trigger account/entitlement aggregation, view aggregation history, and
  delete a source (offering to delete its associated Identity Profile
  first, since ISC requires that). An **Add Disconnected Source** wizard on
  the list creates a Delimited File source from an uploaded CSV, aggregates
  it, and can AI-create a matching Identity Profile.
- **Access Profiles** — list with bulk delete; detail view supports full
  edit (name, description, owner, entitlements), enable/disable, AI-generated
  description, and member request/revoke.
- **Roles** — list and detail; see [Role Detail](#role-detail--the-core-screen)
  below — this is also where Role Evaluation is launched from outside the
  Role Mining tab.
- **Data Segments** — only shown when a tenant has both the
  [Multi-Company/Division Boundary](GLOSSARY.md#boundary-attributes--multi-companydivision-boundary)
  and its "Create Data Segments" setting enabled. List (search, print, bulk
  enable/disable, build) and a read-only detail view rendering the segment's
  visibility criteria in plain English.
- **Entitlements** — detail view, tabbed: Details, Members (paginated/
  searchable), Roles, and Access Profiles that include this entitlement;
  print.
- **My Requests** — submit and track access requests.
- **Approvals** — pending/approved/rejected access-request approvals, with
  approve/reject and SOD-violation detail on the approval itself.
- **Tasks** — ISC work items: list, detail, complete.
- **Profile** — session info, decoded OAuth token claims, sign out.

### Role Detail — the core screen

Five tabs: **Details**, **Membership Rules**, **Entitlements**, **Members**,
and **Dimensions** (Dynamic roles only). Actions available:

- Enable / disable / delete
- **Evaluate** (sparkles icon) — opens the Common Access picker (choose which
  overlapping [Common Access](GLOSSARY.md#common-access) roles to exclude
  from suggestions), then runs [Role Evaluation](GLOSSARY.md#role-evaluation)
  for this one role
- AI-generated description (edit and save)
- Full edit: owner / additional owners (users or a governance group),
  Standard vs. Dynamic type, requestable flag, flag-as-Common-Access
- Manual add/remove of entitlements and members
- Manual dimension CRUD: add/edit/delete a dimension, add/remove its
  entitlements
- From an open evaluation result: accept all, accept a single dimension's
  proposal, create a missing dimension, remove a stale dimension, and either
  **Repair Role** (remove the flagged conflicting entitlements and
  re-evaluate) or **Mitigate** (apply a time-limited
  [SOD mitigation](GLOSSARY.md#sod-mitigation) exception instead)

The **Roles list** itself also has a list-level Eval (sparkles) icon that
evaluates whatever's currently filtered/searched with the same Common Access
picker flow, plus three PDF print modes (simple list / brief with dimension
names / full detail).

---

## Role Mining

The role-engineering workflows.

### Scan for Roles ("Role Model Draft")

Kicks off, lists, and can cancel a peer-group discovery scan
([Role Scan](GLOSSARY.md#role-scan-aka-role-model-draft)). Shows each
discovered [peer group](GLOSSARY.md#peer-group) with a member/entitlement
preview and dimension preview. A reviewer creates one role, or all of them,
with an AI name/description review step first. Scan reports can be exported
and printed.

### Role Evaluation

Ad-hoc or persisted tenant-wide [Role Evaluation](GLOSSARY.md#role-evaluation)
scans. Per-role result cards show stale/missing entitlements, dimension
gaps, missing/stale dimensions, and SOD violations (with Mitigate or Repair
Role actions). "Accept" applies one role's suggestions; "Accept all" applies
every result in the scan. Prompts for the Common Access picker before
running, same as the single-role Evaluate action on Role Detail. Printable
as a PDF report — a summary table of every role with findings, then a page
per role with the full detail.

### Attribute Sync

Scans every source's provisioning policy for identity-attribute-mapped
fields and proposes an optimal Attribute Sync configuration for each one.
Per-source cards show the proposed field mappings (Already Enabled /
Recommended / Excluded, with reasons); deploy one source at a time or all
recommended changes at once. Printable as a PDF report.

### Data Segment Mining

Only shown when the Multi-Company/Division Boundary is configured. Scans
for combinations of boundary attributes with real members and proposes a
[Data Segment](GLOSSARY.md#boundary-attributes--multi-companydivision-boundary)
for each, with matching roles/entitlements. Create individually, all at
once, or merge into an existing segment. Printable as a PDF report — each
segment's membership rule (e.g. `department = "Engineering" AND location =
"Austin"`) is shown in the summary table and on its own page.

### Role Descriptions

Bulk AI-generated description review/apply across a searched set of roles.

### Rename

Batch prefix/suffix rename preview-and-apply across roles matching a search
string.

### Apply in ISC

Triggers and polls SailPoint's real
[Role Propagation](GLOSSARY.md#role-propagation-apply-in-isc) job, which is
what actually provisions/revokes member access to match role/dimension
definitions edited in this app.

---

## Studio Settings

Configuration for the Role Mining and Role Evaluation workflows.

### Mining Config

Role Scan scope, the entry point to [Schema Analysis](#schema-analysis),
Dynamic-role/duplicate-role toggles, Role Naming (prefix/suffix/separator),
and the [Skeleton Scan](GLOSSARY.md#skeleton-role) trigger.

### Evaluation Config

Role Filtering (which roles a manual evaluation considers), "Consider
Common Roles" and "Check for SOD Violations" toggles, Role Evaluation
retention, the "Allow SOD Mitigations" gate, and a
**Manage Mitigations** screen listing every persisted
[SOD mitigation](GLOSSARY.md#sod-mitigation) with a detail dialog.

### Schema Analysis

Runs [Schema Analysis](GLOSSARY.md#schema-analysis); lets a reviewer
reorder/override the top-attribute pick and configure the
[Multi-Company/Division Boundary](GLOSSARY.md#boundary-attributes--multi-companydivision-boundary)
plus the "Create Data Segments" toggle.

### Preferences

Dark mode (persisted server-side per user), the
[Role Statistics Refresh](GLOSSARY.md#role-statistics-refresh) schedule
(frequency, start date/time), sign out.

