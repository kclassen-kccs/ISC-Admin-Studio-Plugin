# Admin Studio — Feature & Function List

A complete inventory of every screen and the actions it exposes, organized by
the app's navigation structure. Screen names in quotes match the title shown
in the app itself. This is a structured reference (a checklist/audit
document) — for a narrative walkthrough see [USER_GUIDE.md](USER_GUIDE.md);
for domain-term definitions see [GLOSSARY.md](GLOSSARY.md).

**Navigation shell:** six top-level tabs — **Home**, **Browse**, **Tools**,
**Mining** (Role Mining), **Backup & Restore**, **Studio Settings** — plus a
Profile screen (avatar icon on Home) and My Reports (Home's quick action).
Every tab but Home is a collapsible section header in the sidebar (clicking
expands it; it doesn't navigate; the section holding the current route opens
on its own). Browse and Mining sub-links are sorted A–Z by label. The sidebar
shows only the links and the app version; there is no tenant box, no sign-in
indicator and no log-out: ISC's App Shell signs the user in and the plugin
runs with that session. On every screen the TopBar title is itself a
dropdown menu for jumping between sibling screens of the same tab; on narrow
viewports a hamburger opens a nav drawer.

Browse and Mining each gain a conditional sub-link, shown only when a
tenant has the Multi-Company/Division Boundary enabled *and* its own
"Create Data Segments" toggle on (set in Studio Settings → Schema Analysis):
**Data Segments** under Browse and **Data Segments** under Mining. The two
**Segments** sub-links (ISC access-request Segments) are always shown.

---

## Home

### "Dashboard"
- **"Admin Studio" banner** across the top: shield icon, the words "Admin
  Studio" and, under them, the tenant's instance badge name (or site name,
  or tenant). Display only, not a link. Coloured with the tenant's instance
  badge colour from ISC's UI metadata when the badge is visible, with black
  or white text chosen by brightness; the default blue look otherwise (and
  when the metadata can't be read, e.g. by a non-ORG_ADMIN account).
- "At a glance" metric tiles: Identities ("Total in tenant", counted from
  the identities API), Sources ("Connected"), Roles ("Total in tenant"),
  Common Access Roles ("Flagged as ISC common access": ISC's confirmed
  common-access roles plus roles this plugin flagged or created as such,
  counting only enabled roles that grant at least one entitlement) — each
  clickable; Common Access Roles opens the latest Role Statistics Refresh
  scan, or the Role Evaluation list if there is none. A tile ISC answers
  403 for shows "—" with "No access for this account".
- "Active Role Statistics" section (shown once a Role Statistics Refresh
  has completed): "Roles OK" (green) / "Roles Needing Updates" (red when
  any SOD violation is counted, amber when updates are needed without SOD,
  green otherwise); "SOD Violation!" / "Mitigated SOD Present" labels; "As
  of" timestamp; both tiles open that scan's results. SOD counts follow the
  current "check SOD violations" setting.
- "Quick actions": "View my N reports" (only when the user has saved
  reports).
- Header: Refresh (re-runs the counts, role stats and reports, then
  "Dashboard refreshed"); avatar initial → Profile. There is no log-out.
- A tenant that has never run Schema Analysis is redirected to Studio
  Settings → Schema Analysis once per browser session per tenant.

---

## Browse

Sub-links (A–Z): Access Profiles, Applications, (conditionally Data
Segments), Entitlements, Forms, Governance Groups, Identities, Launchers,
Metadata, Org Info, Parameter Storage, Roles, Segments, Sources, Transforms,
User Certifications, Workflows.

Most detail screens share two things worth knowing once:

- **"View in Identity Security Cloud"** header action — deep link to the
  same object in ISC's own UI (Identity, Role, Access Profile,
  Application, Entitlement, Data Segment; Sources call it "Manage
  Accounts in Identity Security Cloud").
- **Pager** (EVERY list screen) — shown both ABOVE and BELOW the list it
  pages, so neither end of a page strands you: "Page 2 of 7 (656
  entitlements)" — the current page, how many pages, and the total in the
  whole result set (not just the page) — with **first / previous / next /
  last** controls, each disabled when it would do nothing and while a page
  is loading. Falls back to "Page 2" when no total is available, and the
  Last jump is then disabled rather than guessing where the end is (its
  tooltip says so). One shared component.
  - **Server-paged** (too big to hold in memory): Identities (50/page),
    Entitlements (100), and a source's own Accounts and Entitlements tabs
    (100). The total is ISC's own count for exactly the current search and
    filters. "Select all" on these covers the current page.
    - **ISC's 10,000-record paging ceiling.** ISC rejects any request whose
      `offset + limit` exceeds 10,000 ("count exceeded max limit of offset
      and limit"), whatever the real total is. So these pagers only offer
      the pages ISC will actually serve: page counts stop at the ceiling,
      Next stops there, and **Last jumps to the last reachable page, not
      the true end**. A deep offset from an old URL is clamped to it rather
      than sent through to a 400. When the result set is bigger than that,
      a **red warning sits on the pager line**, above and below the list,
      saying how many records are past the ceiling and that only narrowing
      the search or filters will reach them. On a tenant with ~147,800
      entitlements that means 100 pages of 100 are reachable and the other
      ~137,800 need a search. Does not apply to client-paged lists.
  - **Client-paged** — lists that fetch everything and filter locally
    (Roles, Access Profiles, Applications, Sources, Data Segments,
    Workflows, Forms, Launchers, Transforms, Metadata attributes, User
    Certifications), paged 50 at a time by the
    shared `usePagedList` hook. The counts above the list, "Select all",
    and every bulk/print action still cover the WHOLE filtered result, not
    just the visible page — unchanged from before paging. The pager is
    hidden when everything fits on one page.
  - The page is kept in the **URL**, so Back returns to the page you were
    on and a bookmarked page reopens on it; changing the search or any
    filter returns to page 1. A page past the end of a shortened list says
    so and offers "Back to first page" (client-paged lists snap to the last
    real page automatically).
  - Also used by the member pagers on the Role (members, and the compact
    per-dimension members), Access Profile, Entitlement and Data Segment
    detail screens, and by the Data Segment detail screen's Roles tab
    (client-paged from the one access fetch). That screen's Entitlements tab
    is rolled up by source instead — same behaviour as the Identity detail
    screen's Entitlements tab: groups collapsed by default, expand/collapse
    all, and a search that auto-expands matching groups. Paging there applies
    to the GROUPS, so the pager only appears on a segment spanning more
    sources than fit one page.
- **"JSON" tab** (shared Raw JSON panel) — "The object's full definition
  as ISC returns it." as a syntax-highlighted read-only view, with an
  "Edit JSON" pencil. Editing opens a Tree/Text editor over one shared
  buffer: Tree mode (expand/collapse, inline key rename, change type,
  per-type value editors, Add property/Add item, Paste JSON over this
  subtree, Duplicate item, Remove; Undo/Redo), Text mode (live-highlighted
  textarea with "Valid JSON" / "Invalid JSON: …" status — and, while it's
  invalid, **Fix with AI**: the plugin sends the text and the parser's
  message to the AI route (see Preferences), asking for a SYNTAX-only repair
  (no renamed keys, changed values or reformatting), and verifies the
  result parses (one retry if not; nothing is changed on failure; 60,000
  character limit). The editor then shows "What's wrong" — a plain-language
  explanation of each problem, where it is and why JSON disallows it —
  and the proposed change as removed / added lines, with Apply fix /
  Dismiss. Nothing is applied silently or saved; "Undo fix" is offered
  right after applying. The changed-lines view is the safeguard: the
  original can't be parsed, so nothing can prove values were left alone
  except reading what changed. The same control is on every editor built
  on this one — transforms (create and edit), workflow JSON and step
  JSON, metadata attributes, launchers (including a launcher's config
  box), source JSON), Find and replace
  (Match case, Regular expression, Replace / All), Print JSON. Read-only
  keys (id, created, modified, creator, modifiedBy, …) are dimmed and
  never sent. Save sends only the top-level fields you changed as
  JSON-Patch ("No changes to save" if nothing differs); Cancel discards.
  No confirmation on Remove or Save.

### "Identities"
- Search by name/email; total tenant count shown.
- Filters: All/Active/Inactive lifecycle-state pills, Identity Profile
  dropdown ("All Identity Profiles" default; sourced directly from the
  tenant's Identity Profiles, not derived by scanning identities),
  "Attribute…" pill (pick a key from Schema Analysis's candidate
  attributes in a dialog, enter a value — contains match, e.g. "Eng"
  matches "Engineer"/"Engineering") with a clear control on the pill;
  "Segment…" filter (conditional on Data Segments — lists the segment's
  own members, with the other filters applied to that page; chip with X
  to clear; URL-backed).
- Paged 50 per page (see **Pager** under Conventions). The total is ISC's
  count for exactly the current search + filters. With a Segment filter
  PLUS a profile / lifecycle / attribute filter no true total exists (those
  are applied to each page locally), so the pager shows the page number and
  offers Next while a page comes back full, with Last disabled. ISC Search
  stops paging at 10,000 — beyond that, use the search box.
- Per-row Active/Inactive pill toggles that identity's lifecycle state.
- Bulk select: Enable (N), Disable (N), with progress indicator.

### "Identity" (detail)
- Header: avatar, name, title/department, Active/Inactive toggle pill,
  a **Lifecycle: <state> · Change** pill, View in Identity Security Cloud.
- **Accounts tab** — the identity's accounts, by source (read from ISC's
  v2025 accounts API: on this tenant the v2026 one rejects its own
  documented filters and returns a different schema). Search (source,
  account name, native identity, display name); a checkbox per row and
  "Select all" (of what's listed — a selected row hidden by the search is
  never acted on); each row shows source, account name / native identity
  and an Active / Disabled / Locked pill, and opens the detail sheet. With
  a selection, an action bar offers:
  **Enable (n)** and **Disable (n)** — real provisioning: ISC sends the
  enable / disable to each source. n counts only accounts whose state
  would change and whose source supports it (the ENABLE feature); accounts
  on sources that don't are skipped and the bar says how many. Enable runs
  straight away; Disable confirms, listing the accounts.
  **Remove from ISC (n)** — deliberately NOT called deprovision: ISC has no
  API that deletes a single account on its source. This deletes the
  account from ISC's records only — nothing is sent to the source, the
  account there keeps working, and it returns at the next aggregation if
  it still exists; the confirm says exactly that, and what actually takes
  an account away (disable it, remove the access that grants it, or a
  lifecycle state that deletes accounts).
  Actions run one account at a time with a progress count; a failure
  doesn't stop the rest and a result dialog names each failure. Outcomes
  show up on the Activity tab.
- **Set lifecycle state** (the Change pill) — the Active/Inactive pill only
  flips between the profile's active and inactive states; this reaches every
  lifecycle state the identity's OWN identity profile defines (prehire,
  terminated, …; the profile is found through the identity's authoritative
  source). Each state is a card: name, "Current" badge, how many identities
  are in it, its description, and — the point of the dialog — what entering
  it DOES: "Enables / Disables / DELETES accounts on n sources (or all
  sources)", "Removes ALL of the identity's access", access profiles it
  grants, who it emails. Account deletion and remove-all-access are shown in
  red, and choosing such a state turns the confirm button red with a warning
  that moving the identity back doesn't restore them. The current state and
  states disabled on the profile can't be chosen. When the profile maps
  cloudLifecycleState through a transform, an amber note says so (which
  source attribute / transform): a manual change takes effect now but ISC
  recalculates it at the next identity refresh, so it only lasts if the
  source agrees — change it at the source for a lasting change. The plugin
  refuses a state id that isn't on the identity's own profile rather than
  passing it to ISC. Success refreshes the identity and its Activity tab.
- Tabs: **Details** (email, alias, manager, lifecycle state, last refresh,
  ID, extra attributes), **Roles** (view-only, click-through), **Access**
  (view-only access profiles, click-through), **Accounts** (linked accounts
  across sources — see below; detail sheet with all fields), **Entitlements** (search,
  grouped/collapsible by source with "Expand all sources" / "Collapse all
  sources", detail sheet per item), and conditionally **Segments** (data
  segments this identity matches — only when Create Data Segments is on),
  and **Activity**.
- **Activity** — what ISC recorded for, about and by the identity, newest
  first, in three views: *Provisioning activity* (ISC account activities
  matched by identity id — access requests, identity refreshes, lifecycle
  changes; each shows status, requester, sources and errors, and expands
  to every account operation with its attribute changes and result),
  *Events about this identity* (audit events naming it as target —
  sign-ins, provisioning results, certifications) and *Actions by this
  identity* (audit events it performed — requests, approvals, admin
  changes). Audit events carry only a name, so they're matched on every
  name the identity goes by (name, alias, uid, display name). Window (24
  hours … 90 days), a "didn't complete" / "failures only" checkbox,
  Refresh, "Load older" 100 at a time. Expanding anything that failed (an
  account activity that didn't complete or has errors; a FAILED / ERROR /
  INCOMPLETE event) offers **Explain and suggest a fix with AI** — see
  "AI explanations" under Tools > Operations — and **Retry** (below).
- **Retry** (identity and source Activity tabs, on anything that failed) —
  ISC has no call that re-runs a failed transaction, so a retry is a new,
  equivalent operation, always behind a confirm that says exactly what
  will run; where none exists the row says "Not retryable" and why.
  Failed account / entitlement aggregation → the same aggregation again;
  failed test connection → test again; failed account enable / disable →
  the same call again (account matched by source + native identity);
  failed attribute sync → attribute sync for that identity again; failed
  account create / modify, entitlement add / remove, and any account
  activity that didn't complete → reprocess the identity (ISC
  re-evaluates it and enforces provisioning it still owes — with a note
  that a removal from a one-off revoke or certification isn't re-issued
  that way, and that a non-transient cause will fail again). Not
  retryable: failed sign-ins, role propagation, activity still pending,
  anything else without an equivalent. Never done: re-submitting an access
  request in place of a failed entitlement change (a different operation
  — direct assignment, own approvals). A name on an event is only acted
  on when it matches exactly one identity / source / account.
- **Bulk retry** (identity and source Activity tabs) — an "Only retryable
  failures" checkbox narrows the list to failures that have a retry (for
  events, applied by ISC's search on the retryable event types; for
  account activities, those that finished without completing), and turns
  on selection: a checkbox per row, "Select all" (of what's loaded), and
  a **Retry selected (n)** button. The confirm states how many distinct
  operations will run and which. The run goes OLDEST FAILURE FIRST, one
  operation at a time (so a disable that failed before an enable is
  re-sent before it), each distinct operation once — sixteen failed
  changes for one person are one "reprocess identity" — and a failure
  doesn't stop the rest. A result dialog reports how many started, how
  many selected failures were covered by an operation already run, and
  each one that couldn't be started with its reason.
- All sub-item detail sheets are read-only.

### "Sources"
- Search; then two single-pill (segmented) filters side by side on one
  line — each is one pill holding all its choices, the active one filled;
  they wrap to a second line only on a narrow screen: Health (All / Healthy
  / Unhealthy) and connector type (All / VA Based / SaaS Based). Both
  default to All, are kept in the URL, and combine. SaaS = the source's connector attributes carry idnProxyType
  "sp-connect" or an spConnectorSpecId; VA = on a managed cluster and not
  SaaS (a cluster alone isn't the tell — SaaS sources sit on
  sp_connect_proxy_cluster). Sources that are neither (Delimited File,
  Non-Employee — no cluster) appear only under All.
- Header: Add Disconnected Source (+ icon, wizard below), Print (current
  filtered list as PDF).
- Bulk select: Generate Descriptions (AI, review/edit/save sheet —
  generated source descriptions are always held to 255 characters, ISC's
  limit, and a longer edit is refused on save), Email Report (one PDF per
  owner, pre-filled mailto — nothing auto-sends), Print Detail for
  Selected.
- No enable/disable/delete at the list level.

### "Add Disconnected Source" (wizard, from Sources list)
- Step 1: Source Name, Accounts CSV, "Create an Identity Profile" checkbox
  (defaults on), Create.
- Step 2: detected columns from the file's own header row (parsed
  client-side, before anything is uploaded) — confirm/adjust UID Attribute
  and Account Name Attribute; both default to a best guess (a literal
  id/uid-style column name, else the first column with all-unique values).
  Confirm & Aggregate / Back.
- Creates a Delimited File source, saves its schema (the uploaded file
  always carries "id"/"name" columns under the hood, renamed from the
  chosen UID/Account Name attributes if needed — ISC's connector requires
  them), aggregates from the same file, and polls until done.
- If requested: AI-matches the remaining schema attributes to the Identity
  Schema and creates an Identity Profile named "{source name} Profile" as
  the source's Identity Profile, then runs Process Identities so the
  mapping actually applies.
- Result screen: success/failure per step, "Retry Identity Profile" for
  just that step if that one part failed, Done.

### "Source" (detail)
- Header actions: Manage Accounts in Identity Security Cloud, Test
  Configuration (runs ISC's connector test-configuration check — read-only;
  "Configuration Test Passed" / "Configuration Test Failed" result dialog
  with elapsed time and the connector's own details), User Aggregation,
  Entitlement Aggregation, Unoptimized Aggregation, Reset Accounts
  (confirm, destructive), Reset Entitlements (confirm, destructive), Source
  Reset (confirm, destructive — clears both), Generate description with AI,
  Delete Source (confirm, destructive — see below).
- Delete Source first checks for an associated Identity Profile (one whose
  authoritative source is this one); if found, the confirm dialog offers a
  checked-by-default "Also delete Identity Profile ..." option, since ISC
  refuses to delete a source at all while a profile still references it.
  Deletes the profile first, then the source (with a short automatic retry
  if ISC hasn't finished propagating the profile removal yet).
- Tabs:
  - **Details** — type, connector, health, authoritative flag, owner,
    cluster, and for sources that run on a Virtual Appliance cluster the
    VA status (cluster status, VA type, CCG version, any cluster alert,
    and one row per appliance with its status, IP, version and last-seen
    time), management workgroup, created/modified, ID.
  - **Schema** — the account schema; "Edit schema — add or remove account
    attributes", and an "Edit … schema JSON" pencil (validated JSON editor,
    Save/Cancel).
  - **Entitlement Schema** — the source's entitlement schemas (empty state
    points back to the Schema tab when there's only an account schema).
  - **Entitlements** — search, 100 per page with a pager at the top and
    bottom of the list ("Page 2 of 7 (612 entitlements)", from ISC's own
    count; the page is kept in the URL so Back returns to it, and a new
    search starts from page 1); "Select all on this page"; click-through to
    Entitlement Detail; bulk Generate Descriptions (review sheet), Change
    Owner, Tag Metadata (pick an Access Model Metadata attribute + value —
    or create a new ad-hoc value — and apply to every selected
    entitlement). **Print** (printer icon) — a landscape PDF of EVERY
    entitlement on the source (all pages fetched first; the current search
    applies and is stated in the header): name, attribute, value, owner,
    Privileged/Requestable flags, description, with counts in the header
    and a footer on every page.
  - **Accounts** — search, 100 per page with the same top-and-bottom pager
    and URL-kept page (ISC's count when the search is server-side; when a
    name search had to be filtered locally the pager just offers Next while
    a page comes back full); full detail modal per account; correlated
    accounts link through to Identity Detail; editable-account sources
    (Delimited File/Generic) get an Edit Accounts entry point and "Generate
    Data — AI-modify this source's account CSV, then re-upload schema and
    aggregate". **Print** (printer icon) — a landscape PDF of every account
    on the source: account name, correlated identity (or "Uncorrelated"),
    native identity, Active/Disabled/Locked, with correlated and disabled
    counts in the header.
  - **Datasets** — per-dataset "Edit dataset JSON" and "Aggregate …".
  - **Resources** — per-resource "Edit resource JSON".
  - **Applications** — full CRUD scoped to this source: search, create
    (name/owner/match-all-accounts), select-all, per-row Enable/Disable,
    Visible/Hidden, Requestable/Not-Requestable, Generate Descriptions (AI,
    bulk or all), bulk Enable/Disable/Make-Requestable/No-Requests, bulk
    Delete (confirm).
  - **Aggregation History** — task list with status, auto-refresh while
    running.
  - **Provisioning Policies** — list by usage type, click into a policy for
    its fields (type, required, transform); per-policy "Edit policy JSON".
  - **Identity Profile** — the Identity Profile whose authoritative source
    is this one (if any), with a concise list of only its
    actually-configured attribute mappings (source attribute → identity
    attribute) — an identity attribute with no mapping simply doesn't
    appear. Actions: **Apply Changes** (labelled blue button — ISC's own
    Apply Changes / Process Identities: re-evaluates every identity under
    the profile against its current mappings and lifecycle states; confirm
    first, warning it can trigger dependent provisioning and runs in the
    background; success toast says it has *started* and that updates take
    a few minutes to appear), "Update mappings — add new schema attributes,
    remove ones that no longer exist" (confirm), Manage in Identity Security
    Cloud.
  - **Connector Rules** (VA-based sources only — anything that isn't a
    SaaS connector) — every connector rule in the tenant (they're tenant-wide in
    ISC), alphabetical, with the ones this source references
    (its beforeProvisioningRule or any connector attribute naming a rule)
    tagged "Used by this source" and floated to the top; search; a + icon
    creates a rule. Click a rule to view it.
  - **Connector Customizers** (SaaS / cloud-hosted sources only — those
    whose connector attributes carry idnProxyType "sp-connect" or an
    spConnectorSpecId, NOT "no cluster": SaaS sources sit on the
    sp_connect_proxy_cluster; shown in place of Connector Rules) — every SaaS
    connectivity customizer in the tenant, with the one this source runs
    (its connectorCustomizerId attribute) tagged "Assigned to this source"
    and floated to the top; search; a + icon opens the create dialog (name
    + script). Click a customizer to view it.
  - **Logs** (SaaS sources only) — the SaaS connector runtime's log lines
    for this source (ISC's platform-logs query, what `sail conn logs`
    reads; matched by source name), newest first. Window (last hour … 30
    days), level filter (all / debug / info / warn / errors and up),
    Refresh. Tap a line to expand it: logger, request id ("show only this
    request" filters to that one command), the full structured record, and
    — on WARN / ERROR lines — **Explain and suggest a fix with AI**, which
    sends that line plus up to 60 lines around it from the same connector
    command (request id), with passwords, tokens, keys, auth headers and
    JWTs redacted in the browser first. ISC
    pages the stream oldest-first — the first 8 pages load on their own,
    then "Load newer lines". A play/pause icon runs a live tail (like
    `sail conn logs tail`): every 5s it fetches lines newer than the newest
    on screen (reaching 30s back and de-duplicating, since ISC ingests
    lines slightly out of order), marks them with a green edge, and pauses
    while the browser tab is hidden. A bug icon turns the connector's DEBUG logging
    on (confirm — verbose, may include request/response data) or off by
    setting the source's spConnDebugLoggingEnabled attribute; it applies
    from the connector's next command. VA-based sources have no Logs tab:
    their connector log (ccg.log) stays on the appliance and ISC has no API
    that returns it.
  - **Activity** (every source — for a VA-based one it stands in for the
    connector log; a SaaS source has it alongside Logs, for the per-identity
    provisioning outcomes the log doesn't show) — ISC's audit events for this source (events search index,
    matched by source name), newest first: aggregations started / passed /
    failed and who ran them, provisioning results (account create / modify,
    entitlement add / remove) with the identity, account, entitlement and
    the connector's error text, and configuration changes (schema,
    provisioning policies, correlation config, sub-types). Window (24 hours
    … 90 days), filter (all / aggregations / provisioning / configuration
    changes), an "Only unsuccessful activity" checkbox (failed, errored or
    incomplete — combines with the filter, e.g. only failed provisioning),
    Refresh, "Load older events" 100 at a time. Tap
    an event for every error, its technical name, tracking number and raw
    attributes; a failed event also offers **Explain and suggest a fix with
    AI** and **Retry** (see Retry under "Identity" detail). A VA's ccg.log stays on the appliance and ISC has no API
    that returns it, so for VA sources this is the closest thing to a log.
  - **JSON** — shared Raw JSON panel.

### "Connector Customizer" (from a SaaS source's Connector Customizers tab)
- Header: Edit name and script (pencil), Assign to / Remove from this
  source (sets or clears the source's connectorCustomizerId), Delete
  customizer (confirm, destructive — also drops the stored script).
- Name, image version, image ID, created, ID, whether it's assigned to
  this source; full-width Edit Script and Assign / Remove buttons.
- **Script** — ISC stores only a customizer's built image and never
  returns its source, so the script is kept by the plugin in this browser's
  storage (per tenant + customizer; another browser can't show it). Shown read-only with its status: draft / deployed
  as version N (when, by whom) / draft has undeployed changes / ISC has
  moved to a newer version uploaded outside the app. A customizer built
  outside the app (CLI) has no stored script — its code can't be shown,
  and deploying one from here replaces it.
- **Create / edit dialog** — name + JavaScript (CommonJS) script, seeded
  with a starter template. Validate (syntax + static checks in the browser:
  exports connectorCustomizer, known before…/after… handler names, at
  least one handler, only @sailpoint/connector-sdk and Node built-ins
  required — the script is parsed, never executed), Save Draft (no ISC
  call), Validate & Deploy / Validate & Create. Deploy has the plugin
  build index.js (the script + a stand-in for the slice of
  @sailpoint/connector-sdk a customizer uses) into a ZIP and upload it as
  the customizer's next version — no npm or bundler, so other npm packages
  aren't available. Create makes the customizer and deploys its first
  version in one step; if that deploy fails the customizer is kept with
  the script saved as a draft.

### "Connector Rule" (from a source's Connector Rules tab)
- Header: Edit this rule (pencil).
- Name, type, description; Details (name, type, version, created /
  modified, ID), Signature (each input's name, type and description, and
  the output), Attributes, and the BeanShell script in full.
- Editor (create or edit): Name, Type (fixed after creation), Description,
  Script. "Validate" runs ISC's connector-rule validation and lists every
  issue with line, column and message; "Validate & Save" / "Validate &
  Create" always validates the exact script first and refuses to write a
  rule ISC rejects. A script edited after validation is flagged and
  re-validated on save. Creating lands on the new rule's page.

### "Edit Accounts" (Delimited File/Generic sources only)
- In-memory editable record list exported from current accounts.
- Search, select-one/all, Add record (blank form from source schema), edit
  one record in a modal by clicking its row (every schema field, prefilled),
  Delete selected (local until saved).
- **Edit selected (N)** — batch edit form: the same schema-driven fields as
  the single-record form, but all starting empty. Any value typed is set on
  every selected record; a field left blank is not changed on any of them.
  Each field has a **Remove** checkbox that instead clears that field on
  every selected record (its input disables and reads "Will be cleared"; an
  empty cell in the rebuilt CSV). Multi-valued fields are typed
  comma-separated. The schema's identity attribute is locked ("Identity
  column — edit one record at a time") since one shared or blank value would
  break ISC's row-to-account correlation. A summary line lists what will be
  Set and Cleared; Apply is disabled until something is. Applies to this
  edit session only, with a toast saying so.
- "Save & Run Aggregation" — rebuilds a CSV from edits and re-uploads,
  starting account aggregation.

### "Roles"
- Search; Active/Disabled filter; "Standard & Dynamic" / Standard /
  Dynamic filter; Role Types filter — "All Role Types" / "Common Access
  Roles" / "Individual Roles" / **"Birthright Roles"** (only roles with a
  membership rule: ISC membership decided by criteria, not an explicit
  identity list — the same definition User Certifications' Exclude
  Birthright Roles uses, from one shared helper; a Common Access role
  usually has a rule too, so it appears under both); "Metadata…" filter (Access Model Metadata attribute +
  value, matched via ISC Search; chip with X to clear; URL-backed);
  "Segment…" filter (conditional on Data Segments — the roles on the
  segment's Access Model).
- Header: Apply Changes in ISC (tenant-wide Role Propagation run, modal),
  Evaluate (Role Evaluation scoped to current search/filters), Print menu
  (Simple list / Brief report with dimensions / Full detail).
- Propagation-in-progress banner when a run is active.
- Per-row: Enabled/Disabled pill (toggle).
- Bulk select: Enable, Disable, Make Requestable (warns that dimensional/
  rule-based roles can't be made requestable), No Requests, Change Owner,
  Generate Descriptions (AI), Rename Selected Roles (bulk modal), Certify
  Role Composition (one ROLE_COMPOSITION campaign per distinct owner,
  2-week deadline, skips dimensional/no-owner roles), Flag as Common
  Access, Unflag Common Access, Email Report (one PDF per owner-group,
  pre-filled mailto per owner — nothing auto-sends), Print Detail for
  Selected, Delete Selected Roles (confirm).

### "Role" (detail)
- Header: View in Identity Security Cloud, Enable/Disable, Evaluate this
  role (runs straight away — see Common Access below), Generate description with AI, Edit
  role (name/description/owner/additional owners/type/requestable/flag
  Common Access), Common Access flag icon (when eligible), Delete
  (confirm), Print (single-role PDF — details, then the membership rule
  with **the identities it matches immediately below it, as a wrapped,
  comma-separated list**, then access profiles and entitlements; repeated
  per dimension, each dimension's identities sitting under its own rule and
  ahead of its entitlements. The membership is fetched for the printout, so
  it doesn't depend on having opened the Members tab, and a role bigger
  than the fetch limit says how many were omitted rather than printing a
  partial roster silently). The same identity lists appear in the Roles
  list's Detailed print, so one role and many print alike.
- Common Access / Not Common Access badge.
- Tabs:
  - **Details** — role type, requestable, enabled, common access, owner,
    additional owners, privilege level, access request approvals,
    reauthorization required, requires end date, max access duration,
    revocation approvals, one row per assigned Access Model Metadata
    attribute, created/modified, role ID.
  - **Membership Rules** — plain-English rendering.
  - **Entitlements** — access profiles (view-only, click-through) + direct
    entitlements: search, select-all/one, bulk Delete, Add entitlements.
  - **Members** — rule-based role: read-only paginated/search list.
    Manually-assigned role: editable — Add members, Remove selected
    (confirm).
  - **Dimensions** (Dynamic roles only) — Expand/Collapse all, Add
    dimension (name/attribute/value/entitlements), per-dimension expand
    (membership rule, members, entitlements with add/bulk-delete), Edit
    dimension, Delete dimension (confirm).
  - **Composition** (second tab, directly below Details) — the role measured
    against the people its membership rule covers right now. One scan of the identities index finds that
    population and what each person holds, so the base role and every
    dimension are cut from the same snapshot. Header: how many people, the
    tenant's Entitlement Commonality threshold, Refresh, and **Suggest
    changes with AI**. Roles here are built from entitlements, so "access
    items" are entitlements.
    - **Common Access roles in scope** — every Common Access role whose
      membership covers this role's population (same subset + boundary rule
      the role scan uses), as pills linking to that role, with how many
      entitlements each grants. If they can't be read, a warning says so
      and nothing is flagged.
    - **Default view:** the base role's card is open; **dimensions are
      rolled up** to one line each — name, members pill, and "N included ·
      M excluded", with "· K excluded at or above <threshold>%" in green
      when the dimension has candidates worth a look (not counting items
      Common Access or the base role already grants). Click a dimension's
      name to expand or collapse it; **Expand all / Collapse all** beside
      the "Dimensions · N" heading act on all of them (each greys out when
      it would do nothing). On every level, **Included** and **Excluded
      access items start contracted**, their headings showing the counts.
      The + (add by search) and the members pill work on a rolled-up
      dimension too.
    - **Role (base)** and each **Dimension** get the same card:
      - name with a **+** (add access items by search — see below) and a
        **members pill** ("25 members") that opens a dialog of those people
        — name, job title, department, email, manager, entitlement count,
        lifecycle state; filterable; each name opens the identity. A
        dimension's members are the base role's members who also match the
        dimension's rule.
      - the **membership rule** in plain English; an amber note when a level
        has fewer than 3 members (percentages mean little).
      - **Included access items** — what the level grants, grouped by
        source, each with holders, commonality % and a bar (green at or
        above the threshold, amber above half of it); an item granted but
        held by nobody shows 0%. A red **−** removes it.
      - **Excluded access items** — held by the level's members but not
        granted there, grouped by source, most common first; items under 10%
        are folded behind "Show N more". A green **+** adds it.
      - Each **source's band is shaded** so the source stands out in the
        list: a source gets one tint (blue, violet, cyan or emerald) and
        keeps it everywhere on the screen — base role, every dimension,
        included and excluded — so the colour identifies the source rather
        than just alternating. Assigned alphabetically across every source
        the role touches, so it's the same on every visit; "Unknown source"
        is neutral grey. Amber and red are left out because this screen
        already uses them for Common Access and for removal. Works in dark
        mode.
      - Badges on an item: "Common Access: <role>", "In base role" (on a
        dimension), "On dimensions: …" (on the base).
    - **Click any item** → who has it: "22 of 25 people have this, for 88%
      commonality", with Have it / Don't have it lists; names open the
      identity.
    - **Every add or remove confirms first**, showing what the review found:
      an item an in-scope Common Access role already grants is **blocked**
      from the base role (the plugin never lets a role repeat Common Access,
      so it's shown as "won't be added" rather than silently dropped) and
      **warned** about on a dimension; adding to a dimension something the
      base role already grants is warned; adding to the base role something
      one or more dimensions grant lists those dimensions and offers
      (selected by default) to **remove it from them** in the same action.
      These checks cover items added by search too, including ones nobody in
      the role holds.
    - **Suggest changes with AI** — the changes themselves are arithmetic
      against the threshold, so they're reproducible and every id is real:
      an item belongs on a level when at least threshold% of that level's
      members hold it, at the highest level that justifies it (base before
      dimension, never both), and never when Common Access already grants
      it. AI then reviews that proposal as an access reviewer would — a
      plain-English summary plus per-change cautions (it can't add or remove
      items; ids it mentions that aren't in the proposal are discarded). The
      dialog lists each change with its reason and any AI caution, each with
      a checkbox to leave it out, shows the **new layout** per level (item
      count before/after and the resulting list), flags levels with very few
      members, and **Save** applies what's selected, level by level, with
      per-level failures reported. Without AI configured the computed
      proposal is still shown, and says so. Nothing is saved until Save.
    - Changes reach members after Apply Changes / the next role propagation;
      every success message says so.
  - **Metadata** — the role's Access Model Metadata (attribute, type,
    assigned values), editable exactly like an entitlement's: a + icon
    ("Add metadata") opens the Add Metadata dialog (Attribute, Value, or
    "Or create a new value" for ad-hoc attributes — the value is registered
    on the attribute first); an X on each assigned value removes it; a
    Remove pill on an attribute line removes all of its values from the
    role. No confirms. One shared panel serves roles, access profiles and
    entitlements.
  - **Tag Metadata (bulk, from the list)** — on the Roles, Access Profiles
    and Entitlements lists, selecting rows adds a tag icon, **Tag Metadata
    (n)**, first on the selection bar. Its dialog has an **Add a value /
    Remove a value** switch, then Attribute and Value ("Or create a new
    value" for ad-hoc attributes — Add only; there's nothing to untag a
    brand-new value from). Both operations first ask ISC Search
    which of the selected objects already carry the value and only act on
    the ones that need it; the rest are skipped, never failed (a mixed
    selection is the normal case, and ISC rejects both adding a value an
    object has and removing one it doesn't). Add registers the value on the
    attribute first and skips objects that already have it ("already had
    it"); Remove only untags the ones that carry it ("didn't have it") — and
    since Search's index runs minutes behind a tagging, Search is only
    believed when it says an object HAS the value: every selected object it
    doesn't vouch for is read directly before being skipped, so removing a
    tag straight after adding it works. If
    everything is skipped it says "Nothing to do". Search lags a recent
    change by minutes, so an add that ISC still rejects is checked against
    the object itself rather than by the wording of ISC's error (which
    differs per object type): same value already there → skipped; a
    single-valued attribute (e.g. Environment) already holding a different
    value → a failure that says so — "Environment holds one value and this
    role already has "Development". Remove that value first…" — it is
    never silently replaced. Every failure's reason is in the result sheet.
    The single-object + button does the same and says "It already has that
    value — nothing changed". The plugin works a few at a time, probes
    the API root once per run, and one failure doesn't stop the rest; up to
    2,000 objects per run. Success is a toast ("Added "SG" to 40 roles · 3
    didn't have it"); failures open a dialog naming each object and why.
    The selection clears and the list refreshes afterwards. If the tenant
    doesn't serve the per-item metadata route for that object type (see
    Access Profiles), it stops after the first object and says so.
  - **Segments** (conditional) — data segments whose Access Model selects
    this role.
  - **JSON** — shared Raw JSON panel.
- **Evaluation Sheet** (via Evaluate): "Possibly missing entitlements",
  "Possibly stale entitlements", per-dimension "Possibly missing" and
  "Redundant with base role" sections, missing/stale dimensions, SOD
  violations; Accept all, per-item accept, Repair Role (remove conflicting
  entitlements, re-evaluate), Mitigate (time-limited SOD exception if
  allowed; "Mitigated Violation Present" links to Manage Mitigations),
  Remove this dimension.

### "Entitlements" (tenant-wide, across all sources)
- Search by name; All / Requestable / Not Requestable pills; "All Sources"
  dropdown; Privilege dropdown (All / None / Low / Medium / High — matched
  against each entitlement's effective privilege level, an unset level
  counting as None; like No Owner it fetches every page matching the
  other filters and filters locally, since ISC can only filter the direct
  level server-side); "Metadata…" filter (pick an Access Model Metadata
  attribute and value — matched through ISC Search's metadata query and
  applied on the same fetch-every-page path; shown as a chip with an X
  to clear); "Segment…" filter (conditional on Data Segments — the
  entitlements on the segment's Access Model, directly selected or
  reachable through its roles; same client-side path); "Owner…" filter
  (search-and-pick a user, or "No Owner" for entitlements with nothing
  set). Search and filters live in the URL so they survive a trip into a
  detail page.
- Paginated 100 per page (Previous/Next, "start–end of total"); "Select
  all shown" scoped to the current page.
- Per-row: name, source · owner, Requestable / No Requests pill;
  click-through to Entitlement Detail.
- Bulk select: Generate Descriptions (AI, review sheet), Change Owner,
  Make Requestable, No Requests, Email Report (one PDF per owner, with a
  pre-filled mailto and a link that opens only in this browser's My Reports
  — nothing auto-sends; entitlements with no owner or
  an owner without an email are skipped and listed; "Download All as
  ZIP"), Print Selected.

### "Entitlement" (detail)
- Header: View in Identity Security Cloud, Generate a new description with
  AI, Edit name, description, owner, requestable & privilege level (the
  privilege picker — High / Medium / Low / None — writes ISC's
  privilegeOverride so the effective level follows it; "Keep …" leaves it
  unchanged), Print.
- Tabs: **Details** (source, attribute, value, effective privilege level
  with how it was set — override / criteria and by whom — plus direct and
  inherited levels when present, owner, requestable, ID), **Members** (paginated/searchable, click through to Identity
  Detail), **Roles** (every role that includes this entitlement,
  click-through), **Access Profiles** (every access profile that includes
  this entitlement, click-through), **Applications**, **Metadata**
  (editable: "Add metadata" → Add Metadata dialog with Attribute, Value, or
  "Or create a new value" for ad-hoc attributes; per-value X to remove;
  per-attribute Remove pill — no confirms), then conditionally
  **Approvals** (when requestable), **Parents** / **Children** (when the
  entitlement has them), **Segments** (when Create Data Segments is on),
  and **JSON**.

### "Access Profiles"
- Search; Active/Disabled filter; "Metadata…" filter (Access Model
  Metadata attribute + value, matched via ISC Search; chip with X to
  clear; URL-backed); "Segment…" filter (conditional on Data Segments —
  the access profiles referenced by the roles on the segment's Access
  Model).
- Header: Create Access Profile (name/owner/source/entitlement picker),
  Generate Descriptions (AI, all shown), Print menu (Simple list / Detail
  report).
- Per-row: Enabled/Disabled and Requestable/No Requests pills (toggle).
- Bulk select: Enable, Disable, Make Requestable, No Requests, Change Owner
  (search-and-pick), Email Report, Delete Selected Access Profiles
  (confirm), Print Detail for Selected.

### "Access Profile" (detail)
- Header: View in Identity Security Cloud, Enable/Disable, Generate
  description with AI, Edit (name/description/owner), Delete (confirm).
- Tabs:
  - **Details** — source, requestable, enabled, owner, created/modified, ID.
  - **Entitlements** — select-all/one, bulk Delete, Add entitlements
    (search-and-pick, scoped to the profile's own source), click-through.
  - **Members** — paginated/search; Add members submits a real GRANT_ACCESS
    request per identity (not instant); Request removal submits revoke
    requests (confirm, explains approval may be required).
  - **Metadata** — editable, same panel as roles and entitlements (+ to add
    a value, X to remove one, Remove to clear an attribute). Access
    profiles only gained ISC's per-item metadata route in v2026 and have no
    /beta equivalent; on a tenant whose /v2026 doesn't serve it yet the
    add / remove fails with a message saying exactly that, not a bare 404.
  - **JSON** — shared Raw JSON panel.

### "Applications" (tenant-wide, across all sources)
- Search; All/Enabled/Disabled filter.
- Header: Create Application (source picker included), Generate
  Descriptions (AI, all shown), Print menu (Simple list / Detail report).
- Per-row: Enabled/Disabled, Visible/Hidden, Requestable/Not-Requestable
  pills (toggle).
- Bulk select: Generate Descriptions, Enable, Disable, Make Requestable, No
  Requests, Make Visible, Make Invisible, Delete Selected (confirm), Print
  Detail for Selected.

### "Application" (detail)
- Header: View in Identity Security Cloud, Enable/Disable, Show in / Hide
  from request center, Allow / Disallow access requests, Generate
  description with AI, Edit (name/description/owner/accounts-scope/enabled/
  visible/requestable — one modal), Delete (confirm).
- Tabs: **Details** (owner, source, accounts scope, flags, created/
  modified, ID), **Access** (assigned access profiles, Add Access Profiles
  search-and-pick, per-row remove), **JSON** (shared Raw JSON panel).

### "Workflows"
- Search (name + description); Status filter (All/Enabled/Disabled); on
  the same line, a single-pill **Sort**: A–Z (default, case-insensitive)
  or Last updated (most recently modified first — created date when never
  edited, name as the tie-break, undated items last). The same control and
  the same shared sort helper are used on Forms and Launchers. Kept in the URL. While sorted by Last updated, each row
  also shows its "updated" date.
- Rows: name, one-line trigger summary (Scheduled with cron + timezone,
  External HTTP, Event, or "No trigger"), Enabled/Disabled pill;
  click-through.
- **Select one or all** — a checkbox per row and "Select all" (of what's
  listed; a selected row hidden by a filter is never acted on). With a
  selection, an action bar offers **Enable (n)**, **Disable (n)** and
  **Delete (n)** icons — the counts are how many the action applies to
  (already-enabled ones are skipped by Enable, and so on). Enable runs
  straight away (ISC validates it and refuses an incomplete workflow);
  Disable and Delete confirm first — Delete lists the workflows by name,
  says it removes run history and can't be undone, and that enabled ones
  are disabled first (ISC won't delete a running workflow; if the delete
  then fails, the workflow is re-enabled). Runs one workflow at a time
  with a progress count; a failure doesn't stop the rest, and a result
  dialog names each one that failed and why.
- **Create with AI** (sparkle icon, top bar) — a three-move dialog:
  1. *Describe it* — free text (tap-to-use examples offered): what starts
     the workflow, what it does, what it decides.
  2. *Review the outline* — the AI proposes a name and description and
     the workflow itself, drawn as a **flowchart** in the same style as a
     saved workflow's Workflow tab (layered top-down, the same colour per
     kind of step, arrows with branch labels): a trigger box ("Starts
     when", why it fits, a plain-language "Only when" filter), then a box
     per step carrying the step's name, the **description of what it will
     do**, its library id and — on a decision — each branch ("If … → step",
     "Otherwise → step") spelled out in full. Boxes grow to fit their
     text; the arrows are drawn from the boxes' measured positions and
     follow resizes. Below it: the assumptions the AI made and its
     questions for the requester.
     **Reordering** — ordinary steps have ▲ / ▼ buttons that move them one
     place earlier / later IN THE FLOW (…→ P → A → N… becomes
     …→ A → P → N…; whatever led to P now leads to A, and moving a step
     above the first makes it the new start). A move is offered only where
     it's well-defined — both steps are ordinary ones and the upper is the
     lower's sole way in; decisions, end steps, and steps directly after a
     decision or at a merge point have the button disabled with the reason
     as its tooltip (that kind of change is a redesign — use "Want
     changes?"). After a hand reorder a note explains that a step can only
     use data from steps before it: on Create the AI follows the new order
     exactly and leaves a REPLACE_WITH_… placeholder where something is no
     longer available at that point (verified: moving "Email Manager"
     above the manager lookup produced REPLACE_WITH_MANAGER_EMAIL_ADDRESS).
     The outline's links are data (next / branches / otherwise), validated
     like the built workflow: real targets, no dead ends, every decision
     has an "otherwise", nothing unreachable, every path ends. Every trigger / step id is a real id from THIS
     tenant's workflow library (triggers, actions, operators — current
     versions only); an outline naming anything else is rejected and
     retried once. "Revise Outline" takes free-text changes (or answers to
     its questions) and returns a new outline, as many times as needed;
     "Start Over" goes back to the description.
  3. *Approve & Create Workflow* — only now is the real workflow built:
     the AI gets the approved outline, the FULL library detail (input
     fields, allowed comparator values, example payloads) of just the
     trigger and actions the outline chose, how this tenant's existing
     workflows actually fill in those actions (the library's field lists
     have gaps — e.g. a Wait's duration), and up to two valid existing
     workflows as format references. The result is structurally validated
     before anything is saved — real trigger and action ids, a start
     step that exists, no dangling nextStep / branch / catch, every choice
     has a choiceList and default, no unreachable steps, every path ends
     in success or failure, loop bodies checked the same way — with one
     retry that feeds the problems back; if it still fails nothing is
     saved and the problems are shown. Values only the admin can supply
     (an address, an id, a URL) come back as REPLACE_WITH_… placeholders,
     listed in the success message. The workflow is saved **disabled**,
     owned by the signed-in user, and opens on its Workflow (flowchart)
     tab for review; it is never enabled automatically. Each call can take
     up to a minute or two. Uses the strong model (Claude Opus) rather than
     the small model the other AI features use. The
     description and the tenant's library names are sent to the AI
     provider.

### "Workflow" (detail)
- Header: name, Enabled/Disabled pill. Top bar: **Modify with AI**
  (sparkle), **Enable** (play), **Disable** (pause) and **Delete** (trash —
  confirms; removes the workflow and its run history, disabling it first if
  it's enabled; returns to the list). Enable / Disable icons are both always shown with the one that doesn't
  apply greyed out. Enable is immediate — ISC validates it and refuses an
  incomplete workflow (no trigger, an unfinished step) with its own
  message; Disable confirms first (the trigger stops starting it, events
  that occur meanwhile aren't replayed, runs in progress aren't
  cancelled). The pill and the Workflows list update on success.
- Tabs:
  - **Details** — description, Name, Status, Trigger, Trigger filter,
    Created, Last modified, Owner, Executions, Failures, Workflow ID.
  - **JSON** — read-only definition; Edit JSON → Tree/Text editor; Save
    PUTs only name/description/owner/definition/enabled/trigger.
  - **Saving an enabled workflow** (JSON tab and step editor alike) — ISC
    rejects any update to an enabled workflow ("failed to update workflow
    because it is enabled: not allowed"). Save therefore asks first —
    "Disable, Save & Re-enable" — and the plugin does it as one operation:
    disable, PUT, re-enable, restoring the enabled state even when the PUT
    is rejected so a bad edit never leaves a live workflow off. An edit
    that itself sets enabled: false leaves it disabled. The confirm is
    there because a trigger firing in those few seconds is missed. If
    re-enabling fails, the message says so and that the workflow is
    currently DISABLED. Errors show ISC's own message AND its detail lines
    (ISC answers a rejected workflow save / enable with a headline plus
    details: { "Error 1": … } — the reasons are in the details); a
    multi-line error is a card that keeps its lines and stays until
    dismissed, not a toast.
  - **Validate / Validate & Save** (JSON tab editor, step editor, and both
    AI dialogs) — ISC has no validate call: a save accepts almost
    anything and the real validation only runs when the workflow is
    ENABLED. Validate runs the app's own structural check against this
    tenant's workflow library, instantly and without touching ISC: real
    trigger and action ids; a start step that exists; no nextStep / branch
    / catch pointing nowhere; every choice has a choiceList and a default;
    no unreachable steps; every path ends in success or failure; every
    ".$" key holds a single JSONPath starting with "$" (text with values
    belongs under the plain key with {{$.path}} templates — the mistake
    that saves fine and then fails to enable with "unable parse path …,
    must start with $"); loop bodies checked the same way. The step editor
    validates the WHOLE workflow with the edit spliced in. A pass says
    plainly that ISC's own fuller validation still runs on enable. On a
    failure the problems are listed, with "Save anyway" (ISC accepts an
    unfinished workflow as a disabled draft) and **Propose a fix with AI**.
    Editing after validating marks the result stale; Validate & Save
    always re-validates what is about to be written. In AI create it
    checks the outline (e.g. after a hand reorder) before spending a
    minute building it; in AI modify it re-checks the proposal.
  - **Propose a fix with AI** — for validation problems: the AI gets the
    workflow as it is in the editor (saved or not), the problems verbatim,
    and an instruction to fix exactly those and change nothing else; the
    result must pass validation. Shown inline: what would change (computed
    locally from the two definitions), the AI's explanation, notes and placeholders, with
    Apply / Dismiss — nothing changes until applied, and nothing is saved
    until Validate & Save. In the JSON editor Apply replaces the JSON; in
    the step editor it applies that step's part and says which other steps
    the full fix also touches. When **ISC refuses an Enable**, its
    validation errors open a dialog (rather than a toast) offering
    "Propose a Fix with AI", which opens the Modify with AI review already
    working on a fix for exactly ISC's errors.
  - **Workflow** — an SVG flowchart of the definition, drawn by the AI
    route and sanitized before display (trigger node, one
    node per step, labelled choice branches, "otherwise" default edges);
    unavailable when no AI provider is configured. Click any node to open
    the step editor; Interactive Form steps with a literal form ID also get
    an "Open form preview" badge.
  - **Executions** — every run of the workflow ISC still holds (runs are
    kept 90 days), newest first, 50 at a time ("Load older runs"): status,
    start time, duration, execution id. A single-pill status filter (All /
    Failed / Completed / Running / Canceled — applied by ISC), Refresh, and
    a failed count. Opening a run loads its event history: any failure
    events first, in red, with their full attributes; then the whole run
    oldest-first as a timeline (time, event, step) where each event
    expands to its attributes; and the request id to quote to SailPoint
    support. A failed run offers **Explain and suggest a fix with AI** —
    the AI gets the run, the workflow's trigger and step list and the
    event history (failures in full, the rest one line each), with
    passwords, tokens, keys, auth headers and JWTs redacted in the browser
    first, and is asked to name the step and what to change in it. Saved
    per execution, like the other AI explanations (see Tools >
    Operations).
- **Modify with AI** — describe a change in plain language; the AI returns
  a PROPOSAL, and nothing touches ISC until it's approved. The review
  shows, in order: *What would change* — computed locally from the
  two definitions (steps added / removed / changed, trigger, first step,
  name, description), so it doesn't rest on the model's own account; *The
  AI's explanation* — one sentence per change; *Check before you rely on
  it* — its notes (assumptions, edge cases such as "fails if the identity
  has no manager") and any REPLACE_WITH_… placeholders; and *The workflow
  as proposed*, drawn with the same flowchart as the Workflow tab.
  "Revise Proposal" takes free-text feedback, as often as needed; "Start
  Over" returns to the description. The AI sees the whole workflow library
  in full detail (so it can add actions the workflow doesn't use yet) plus
  how this tenant's workflows fill those actions in, and is told to change
  only what was asked and keep existing step names. The result passes the
  same structural validation as AI-created workflows (one retry with the
  problems fed back; if it still fails there's nothing to review and the
  problems are shown). "Approve & Save" uses the normal save path — an
  enabled workflow is disabled, saved and re-enabled after a confirm —
  except that a proposal containing placeholders is saved DISABLED, so a
  live workflow never comes back on half-configured. Approve is disabled
  when the proposal changes nothing.
- Step editor dialog: title is the step key (or "Trigger"); Expand/Shrink
  dialog. Action and choice steps get **Fields** / **JSON** tabs (other
  steps are JSON-only). Fields renders the action's own input schema from
  ISC's workflow library — required markers, selects, form picker, toggle,
  number, textarea/JSON, key/value pair rows — with a "ƒx" chip per field to
  switch between a literal value and a `$.…` expression (suggestions for
  trigger, secrets, form input, and every step's output); unclaimed
  attributes under "Additional attributes". Choice steps edit each branch's
  compare expression / comparator / value / "Then go to" plus an
  "Otherwise" target; other steps end with a "Next step" picker. Save /
  Cancel.

### "Forms"
- Search by name (client-side); a single-pill **Sort**: A–Z (default) or
  Last updated — see Workflows; one shared helper sorts all three lists.
- Rows: name, owner · description (plus "updated <date>" while sorted by
  Last updated), "Used by N" / "Unused" pill; click opens
  the preview modal (no detail route).
- Bulk select: Delete (N) (confirm, destructive — warns that a workflow
  referencing a deleted form will fail at that step).
- Form preview modal, tabs: **Details** (name, description, owner, used by,
  element/input/condition counts, created/modified), **Preview** (renders
  the form's elements as live controls the way ISC's runtime would —
  sections, text/textarea/phone/date/select/toggle/checkbox, required
  markers, `{{…}}` interpolation chips; show/hide conditions evaluate live
  as you fill it in; Submit is permanently disabled — forms are submitted
  by their workflow), **Inputs** (one card per declared input), **JSON**
  (shared Raw JSON panel).

### "Governance Groups"
- Every ISC governance group (the API's workgroups), all pages fetched,
  sorted A–Z. Search (name, description, owner name — URL-backed); paged.
- Header: Create Governance Group (+) — "Create governance group" dialog:
  Name, Description, Owner (single identity search); Name and Owner
  required; opens the new group when created.
- Row: name, description · "Owner: <name>", "N members" / "N connections".
  Click opens the group. No bulk select.

### "Governance Group" (detail)
- Header: **Edit** (same dialog; only changed fields are sent as a JSON
  Patch), **Delete** (confirm, destructive; when ISC reports connections the
  confirmation says "ISC reports N connection(s) to it — check the Usage
  tab first"; returns to the list).
- Summary: name, "N members · Owner: <name>".
- Vertical tab rail (?tab=, URL-backed):
  - **Details** — description, Owner, Owner e-mail, Members, Connections,
    Created, Modified, Group ID.
  - **Members** — filter (name/email), "Select all shown" and per-row
    checkboxes ("X of N members"); rows (avatar, name, email) open the
    identity. Add members (person-plus) searches identities (25 per
    search, existing members hidden), picks collect as removable chips,
    "Add N members". Bulk Remove (N) (confirm, destructive). Adds and
    removes go through ISC's bulk add / bulk delete in chunks of 100, with
    per-chunk failures reported.
  - **Usage** — where the group is used: ISC's own connections list
    (Access request reviewer, Owner, Management workgroup) merged with a
    full scan of roles, access profiles, sources, SOD policies and
    workflows for the group's id. Each row: type · how it's used
    ("Additional owner", "Access request approver", "Revoke request
    approver", "Violation owner", "Referenced in workflow steps"); rows
    open the object (SOD policies aren't links). Entitlements appear only
    when ISC reports them as connections (they aren't scanned). Objects
    that couldn't be checked are listed in amber; Rescan.

### "Launchers"
- Every ISC Launcher (a named start button for a workflow run as an
  interactive process); search (name, description, type — URL-backed); a
  single-pill **Sort**: A–Z (default) or Last updated, same as Workflows
  and Forms (kept in the URL; rows show "updated <date>" while sorted by
  it).
- "Select all shown"; per-row checkbox; row shows description and an
  Enabled / Disabled pill; click-through.
- Bulk select: Delete Selected Launchers (confirm, destructive — one ISC
  delete per launcher, outcomes reported; referenced workflows untouched).

### "Launcher" (detail)
- Header: Launch in Identity Security Cloud (confirm; starts the launcher
  via ISC's launch API and reports the interactive process id; disabled
  launchers can't be launched), Edit launcher (name, description,
  workflow picker from the tenant's workflows, Enabled toggle, config
  as validated JSON — saved with ISC's full-object PUT), Delete launcher
  (confirm, destructive — returns to the list).
- Name, type, referenced workflow, Enabled / Disabled pill, description.
- Vertical tab rail: **Details** (name, type, status, referenced
  workflow by name — resolved directly when it isn't in the loaded list —
  plus its ID, with an "Open the referenced workflow" link, owner,
  created / modified, ID,
  and the config pretty-printed), **JSON** (read-only definition; Edit
  JSON opens the Tree/Text editor; Save PUTs only name, description,
  type, disabled, reference and config).

### "Transforms"
- Search (name + type).
- **Sort by** A–Z (default) / Last updated — the same single-pill control as
  Workflows, Forms and Launchers, kept in the URL. ISC's transform records
  carry no dates at all (no created/modified; `sorters=-modified` is
  ignored), so Last updated is built from ISC's audit events
  (TRANSFORM_CREATE_PASSED / TRANSFORM_UPDATE_PASSED — every change, whether
  made here, in the ISC UI, or by the system), fetched only when that sort
  is chosen. Rows then show "· updated <date> by <actor>"; a line beside
  the control says how many transforms changed within ISC's audit history.
  A transform untouched for longer than ISC retains audit events has no
  date and sorts after the dated ones, A–Z. If the history can't be read,
  an inline message says so and the list stays A–Z.
- Header: Create Transform (+ icon) — "New Transform" dialog: pick an
  operation type from the documented catalog (36 entries, including the
  rule-based ones labelled "(rule)"), then edit that type's starter
  template in a Tree/Text JSON editor and Create.
- Rows: name + type, "Internal" pill; click-through. No delete anywhere.

### "Transform" (detail)
- Header: name + type.
- Tabs:
  - **Details** — Name, Type, Internal, Transform ID.
  - **JSON** — read-only definition; Edit JSON → Tree/Text editor; Save
    PUTs name/type/attributes (ISC treats name and type as immutable).
  - **Test** — a one-line description of what this operation type does,
    one input field per input discovered from the transform's logic, Run;
    Result (or Error) plus any evaluator notes. Evaluation is entirely
    client-side — nothing is written to ISC.

### "Metadata" (Access Model Metadata attributes)
- Search (name + key); "N attribute(s)" count.
- Rows: name with type badge, "multi-value" badge, non-active status badge;
  description or key beneath; click-through. No create/delete.

### Metadata attribute (detail)
- Tabs: **Details** (Key, Type, Multi-value, Allow ad-hoc values, Status,
  Object types), **Values** (name, technical name, status / type; click a
  value to open its own screen), **JSON** (shared Raw JSON panel).
  - **Values — select and batch delete (custom attributes only):** a checkbox
    per value plus **Select all**; selecting any shows "N selected" and a
    red trash icon. Delete asks for confirmation, listing the values and
    warning that roles / access profiles / entitlements tagged with them
    lose the tag and data segment filters referencing them stop matching.
    ISC rejects a save that shortens the values list (400.1 "semantically
    invalid"), so the plugin deletes value by value through ISC's per-value
    delete (falling back to a JSON-Patch remove of the value's index if the
    tenant doesn't serve that route) and reports each outcome: a success
    toast with the count deleted, and an error toast naming what wasn't
    deleted and ISC's reason. A batch can partly succeed; whatever failed
    stays selected. Only an attribute whose type is exactly "custom" gets the
    selection controls; any other attribute (including one with no type)
    is treated as built-in and shows "This is a built-in attribute, so its
    values can't be deleted." The plugin enforces the same rule on every
    metadata write (Values tab, value JSON editor, attribute Raw JSON tab):
    an edit that would drop a built-in attribute's value — removing it, or
    changing its technical name — is refused with a 403, while in-place
    edits and added values are still allowed. No add of values here.

### Metadata value (detail — from an attribute's Values tab)
- Header: the value's name, its attribute and technical name, non-active
  status badge. Tabs (kept in the URL):
  - **Roles**, **Access Profiles**, **Entitlements** — everything of that
    type tagged with this value, found with ISC Search's
    @accessModelMetadata(key AND value) query, sorted by name, 100 at a
    time ("Load more"), with the total tagged. Rows show name, source /
    description (or owner), Disabled and Privileged badges, and click
    through to the role / access profile / entitlement. A search box
    filters what's loaded, and says so while there is more to load.
  - **JSON** — the value's entry in its attribute's values list, read-only
    with an Edit pencil → the Tree/Text editor (with Fix with AI for
    invalid JSON). Save splices the entry back into the attribute's values
    (ISC has no per-value write). Changing `value` (the technical name)
    shows a warning first — tags on roles / access profiles / entitlements
    and data segment filters reference that name, so they'd stop matching;
    change `name` to rename what people see — and the screen follows the
    new name after saving.
  - There is no Identities tab: identities are never tagged with metadata,
    they only hold things that are.

### "Data Segments" (conditional)
- Search; filter (All/Active/Inactive/Drafts).
- Header: Print menu (Basic list / Detailed list; prints the selection when
  rows are selected).
- Per-row: Active/Inactive pill (toggle); Published/Draft pill (Publish, or
  Disable since ISC has no unpublish).
- Bulk select: Publish (drafts) or Create Draft (reverts published segments
  to draft — swaps automatically based on selection), Assign Matching Roles
  & Entitlements (kicks off a match scan), Enable, Disable, Print Detail for
  Selected, Delete Selected Data Segments (confirm).

### "Data Segment" (detail, conditional)
- Header: View in Identity Security Cloud, Create Draft (if published),
  Assign Matching Roles & Entitlements, Enable/Disable, Publish/Disable,
  Delete (confirm).
- Tabs: **Details** (description, created/modified, visibility criteria in
  plain English, list of other drafts if any, Publish/Disable control),
  **Members** (paginated identities matching the segment criteria),
  **Roles** (view-only, click-through), **Entitlements** (view-only, shows
  direct vs. via-role/access-profile), **JSON** (shared Raw JSON panel).
- No owner field — ISC's Data Segment object has none.

### "Assign Matching Roles & Entitlements" (match scan results, conditional)
- Results grouped by segment: criteria pills, already-assigned items
  marked, unassigned roles/entitlements (grouped by source) checkable.
- Per-segment Select all; header Assign All Matches (N, confirm); footer
  Assign Selected (N) once anything is checked.

### "User Certifications" (campaigns)
- Every certification campaign in the tenant (any type, however created),
  grouped by ISC status in lifecycle order: Staged — ready to start,
  Pending — generating certifications, Activating, Active, Completing,
  Completed, Canceling, Error, Archived. In-flight statuses auto-refresh.
- Search (name, description, type, status — URL-backed); status pills All
  / Staged / Active (includes activating and completing) / Completed /
  Error, each with its count, URL-backed; header User Certification
  Settings (→ Studio Settings → User Certifications), Refresh and Print
  campaign list (one table per status group, of the campaigns shown).
- "Select all shown"; per-row checkbox; row shows type, deadline,
  certifications done / total, and a status pill; a per-row Start icon on
  staged campaigns.
- Bulk select: Start (N staged) (confirm — activates only the staged
  campaigns in the selection, one at a time, and reports skips and
  failures), Print Detail for Selected (one page per campaign with its
  certifications), Delete Selected Campaigns (confirm, destructive —
  ISC's bulk delete, removes the campaigns with their certifications and
  decisions; ISC may refuse an active one).
- Bulk select, Completed campaigns only (anything else in the selection is
  skipped; both icons are disabled, with a title saying why, when no
  selected campaign is completed):
  - **Run campaign remediation scan (N completed)** — confirm (says it
    re-checks every revoked item against its source, changes no access
    itself, runs in the background, and how many selected campaigns will be
    skipped), with a checkbox **"Automatically regenerate the campaign
    reports when the scan finishes"**, selected by default. One ISC call per
    campaign, each with its own failure toast.
    - Selected: each campaign becomes a background job that requests its
      scan, waits for it to finish, then regenerates all four reports. ISC
      never announces that a scan has finished (no task, no audit event), so
      the job uses the two indirect signals ISC does give: it waits for the
      campaign's `modified` time to move (up to 5 minutes, then carries on
      regardless), then requests each report and retries while ISC answers
      400 "A conflicting operation is already in progress" — ISC runs one
      operation per campaign at a time, so an accepted report means the scan
      is over. A blue **Remediation scans** banner above the list shows each
      campaign's current step (scan running / ISC still busy, waiting to
      regenerate the <report> / N of 4 reports regenerating), with failures
      in red and "Clear finished". Each job ends with a toast: success, or a
      plain statement that the scan's completion couldn't be confirmed and
      the reports were regenerated anyway. Jobs keep running if you navigate
      elsewhere in the app; a full page reload stops them.
    - Deselected: the scans are just requested, and a **"Regenerate the
      campaign reports"** dialog explains the reports ISC holds predate the
      scan and are stale (the Campaign Remediation Status Report
      especially); its "Generate Reports…" button opens the reports dialog
      for exactly the scanned campaigns with an amber stale-reports banner.
  - **Get Campaign Reports** — a two-step dialog. Nothing is saved to disk
    until the user picks what to download.
    - **Step 1, options:** Format PDF / CSV; checkboxes for ISC's four
      reports (Campaign Status, Campaign Composition, Campaign Remediation
      Status, Certification Signoff — all on by default); CSV only,
      **Consolidate all campaigns into one CSV per report** (every
      campaign's rows in one file per report type, with a leading Campaign
      column; header is the union of the campaigns' columns so none is
      dropped; pick one report to get a single file). A line states how many
      files will be fetched. **Get Reports** fetches them — the plugin
      first runs any report never run or whose file has expired, so it can
      take up to a minute per such report, and if ISC answers "conflicting
      operation in progress" (a scan or another report still running on that
      campaign) it retries for about a minute and a half before giving up
      with a plain "try again in a few minutes". **Generate Reports (N)**
      asks ISC to build fresh copies of the chosen reports without fetching
      anything (one request per campaign × report, each with its own
      outcome) and says to wait a minute. Up to 25 campaigns per request.
    - **Step 2, "Reports ready":** every fetched file listed with its name,
      campaign, report, size, row count when consolidated, and "freshly run"
      when the plugin had to run it. Each row has its own **Download**
      button (turns into a green "Saved" once used); with more than one
      file, a **Download all N as a ZIP** button at the top builds the ZIP
      in the browser from the same bytes (total size shown). Reports that
      couldn't be fetched are listed in red by campaign and report with
      ISC's reason — a failure never sinks the others. "Back to options"
      returns to step 1; "Done" closes.

### Campaign (detail)
- Header: Start this campaign (staged only, confirm; also a full-width
  "Start This Campaign" button), Refresh, Print this campaign, Delete
  this campaign (confirm, destructive — returns to the list).
- Name, type, deadline, status pill, description, ISC alerts.
- Vertical tab rail (as on Role detail): **Details** (type, status, scope
  — the search query / reviewer / access constraints for a Search
  campaign, roles and reviewer for Role Composition, sources for Source
  Owner — deadline, certifications completed / total, email
  notifications, auto-revoke undecided, recommendations, comments
  required, correlated status, created / modified, ID), **Users** (every
  identity in the campaign's review items — search, Expand/Collapse all;
  per user the reviewer, item count and decided count, expanding to each
  access item with its type, source and decision), **Access Items** (every
  access item under review — search; per item the type, source and user
  count, expanding to the users holding it with their reviewer and
  decision), **JSON** (shared Raw JSON panel). Users and Access Items are
  empty until ISC has generated the campaign's review items (i.e. once it
  leaves Pending). The detail printout prints the same users and access
  items tables.

---

### "Parameter Storage"
- Every ISC Parameter Storage parameter, sorted A–Z. Search (name,
  description, type label, primary value — URL-backed); category filter
  pills ("All" plus each category from the tenant's specifications,
  URL-backed); "N parameters"; paged.
- Row: checkbox, name, "<type label> · <primary field value>", owner name
  (wider screens). Click opens the parameter.
- Header: **New Parameter** (+; disabled until the specifications load);
  **Print** (when the list isn't empty) — "Basic list" (name, type, primary
  value, owner) or "Detailed list" (every field per parameter, secrets
  masked) as a PDF, covering the selection if anything is selected,
  otherwise everything shown.
- "Select all" covers the whole filtered list. Bulk: Print Detail for
  Selected; Delete Selected Parameters (confirm, destructive, one at a
  time with progress; the confirmation warns that ISC refuses to delete a
  parameter that is still referenced, e.g. by a workflow).
- **"New Parameter" dialog** — type picker grouped by category, built from
  the tenant's specification document (`/parameter-storage/specifications`,
  requested in English); consumer-managed types left out, licensed types
  marked "(licensed)" with a note when a type needs a license or feature
  flag. Then Name, Description, Owner (defaults to the signed-in user) and
  the type's fields with the primary field marked *; enum → select,
  string[] → one per line, int → number.
- **Secrets.** Private fields (passwords, client secrets, header values)
  are typed into masked inputs with a show/hide eye, labelled "(stored
  encrypted)", and encrypted in the browser before sending with the same
  scheme as ISC's own UI: a P-384 key exchange with SailPoint's Parameter
  Storage enclave over a verified AWS Nitro attestation, sent as a compact
  JWE. ISC never returns a secret and the plugin never shows one again. If
  ISC rejects the encrypted secret (400), everything else is still saved
  and a "Created/Saved without the <field>" dialog shows ISC's reason and
  tracking ID.
- **Test panel** (for types whose fields allow it: OAuth2 client
  credentials, Entra ID, Basic, Header, Entra tenant lookup, URL
  reachability) — not available in the plugin: those tests need outbound
  calls the plugin's content security policy forbids, so the panel
  reports that instead of a result.

### "Parameter" (detail)
- Header: **Edit** (same form; the type is fixed and public fields are
  pre-filled; secret fields start blank meaning "leave blank to keep the
  stored value" and are sent in their own PATCH after the other fields),
  **Delete** (confirm, destructive; ISC refuses while the parameter is
  still referenced; returns to the list).
- Summary: name, "<category> · <type>".
- Vertical tab rail (?tab=): **Details** (Name, Description, Category,
  Type label + id, Owner, Last modified by, "Secret last changed" by when
  set, ID); **Fields** (every field in specification order, primary
  tagged; private fields show a lock and "••••••••"); **References** (what
  uses the parameter: name, consumer id, usage hint; "Not referenced… so it
  can be deleted" when none); **JSON** (read-only, Copy JSON, public fields
  only).

### "Org Info"
- The tenant's org config (`GET /v2026/org-config`), read-only. Header:
  org name and time zone ("No time zone set" when empty).
- Vertical tab rail (?tab=):
  - **Details** in sections: General (Org name, Time zone); Features
    (Segmentation, Machine account discovery, SAF activated, Lifecycle
    state change honors source enable/disable, Entitlement stickiness
    disabled, Non-org-admins can manage ISC entitlements); AI &
    Recommendations (Certification recommendations, Access request
    recommendations, Harbor Pilot, Natural language search, AI agent
    delete requests); Access Risk Management (every arm* field, or "Not
    configured on this tenant."); Other settings (any field not named
    above, so new ISC fields still show). Booleans as On/Off pills; empty
    values "Not set".
  - **SOD** — "SoD Report Columns (X of N included)": Order, Column,
    Included, Required; a message when the config has none.
  - **JSON** — the org config as ISC returns it, with Copy JSON.

### "Segments" (ISC access-request Segments)
These are ISC's Segments, a different object from the plugin's Data
Segments: no draft/publish lifecycle, a Segment is simply Active or
Inactive.
- Every ISC Segment (`/v2026/segments`), sorted A–Z. Name search and
  All / Active / Inactive pills (URL-backed); "N segments"; paged. Empty
  state points to Mining → Segments.
- Row: checkbox, name, then the description or a readable member rule
  (`department = "Sales" AND …`), and an **Active / Inactive pill that is
  itself a toggle** (a JSON Patch of /active). Click opens the segment.
- Header **Print**: "Basic list" (name, description, status) or "Detailed
  list" (member rule plus roles, access profiles and entitlements per
  segment) as a PDF, covering the selection, otherwise everything shown.
- "Select all" covers the whole filtered list. Bulk (one at a time with
  progress, failures reported): Activate, Deactivate, Print Detail for
  Selected, Delete Selected Segments (confirm, destructive).

### "Segment" (detail)
- Header: Activate or Deactivate (whichever applies), Delete (confirm,
  destructive; returns to the list). The summary's Active/Inactive pill is
  clickable too.
- Vertical tab rail (?tab=): **Details** (Description, Owner, Created,
  Modified; Members section with the member rule; Access section with
  Roles, Access Profiles and Entitlements counts); **Identities** (the
  identities the member rule currently matches, from identity search,
  server-paged 50 per page with ISC's total, name search URL-backed; rows
  show job title · department and open the identity); **Roles** and
  **Access Profiles** (items assigned to this segment, paged; roles show
  their entitlement count, access profiles their source, disabled items
  marked); **Entitlements** (grouped by source with the same collapsible
  roll-up as Data Segments, search, expand/collapse all); **JSON** (full
  definition; Edit JSON sends only the changed fields as a JSON Patch).

---

## Tools

Sub-links: Event Log, Base64, URL Encode. Base64 and URL Encode run
entirely in the browser — nothing is sent anywhere; Event Log reads the
tenant's audit events.

### "Base64"
- One input textarea; "Base64 Encode" / "Base64 Decode" (disabled while
  empty). UTF-8 safe.
- Result panel ("Encoded"/"Decoded") with Copy; "Error" panel on invalid
  Base64 input.

### "URL Encode"
- One input textarea; "Encode non-special characters" checkbox (percent-
  encode every character, not just the special ones — affects Encode
  only); "Encode" / "Decode" (disabled while empty).
- Result panel with Copy; "Error" panel on invalid percent-encoding.

### "Event Log"
- The tenant's audit events from ISC's events search index, newest first,
  up to 250, auto-refreshed every minute; header Refresh.
- "Show" pills (URL-backed): **All** / **Failed** (status Failed, Error or
  Incomplete) / **Retryable Failures** (failures whose recorded error looks
  transient: timeout, connection reset or refused, network unreachable,
  429 / rate limited, 502/503/504, temporarily unavailable, lock
  contention — never one whose error points to a real fix: access denied,
  401/403, invalid credentials, not found / 404, validation or schema
  errors). Failed and Retryable use their own query, so the 250 cap applies
  to failures only; a footer note says when the cap is hit.
- Window pills 24 hours / 7 days / 30 days (URL-backed, default 7 days)
  with an "X of N" count. Search (name, technical name, type, action,
  actor, target, objects, status, stack — URL-backed).
- Row: event name, time, type, actor → target, status pill, a blue
  retry-reason pill ("timeout", "rate limited", …) on retryable failures,
  and a sparkle when a fix has been suggested; click opens the event sheet.
- Event sheet, for failed events: "Suggested fix" panel with "Suggest a fix
  with AI" — the plugin asks the AI route (the tenant's "Admin Studio AI
  Query" workflow by default) for the likely cause and concrete correction
  steps based only on the event's own fields, secrets redacted first. The
  suggestion is saved per event in this browser's plugin storage, per
  tenant, shown again whenever the event is reopened ("AI-generated from
  this event's own fields on <date> — saved for this event; verify before
  acting"), and marked with the sparkle on the row; Regenerate replaces
  it; a clear message when the tenant has no AI workflow set up. **AI
  explanations** elsewhere use the same route and the same saved-suggestion
  store: failed events on a source's or identity's Activity tab (same
  entry as here, so an event explained in one place shows as explained in
  the other), account activities that didn't complete (identity Activity —
  the AI also gets each account operation, its attribute changes and
  result), and WARN / ERROR lines on a SaaS source's Logs tab (the line
  plus its surrounding lines from the same connector command, secrets
  redacted first). Then Details (any error / warning / message text
  highlighted, plus status, type, action, operation, technical name,
  actor, target, objects, stack, tracking number, IP, created, ID, and
  every attribute — every value shown in full and word-wrapped, attribute
  objects pretty-printed) and a read-only JSON tab.

---

## Mining (Role Mining)

Sub-links (A–Z): Attribute Sync, (conditionally Data Segments), Mail
Distribution Groups, Role Evaluation, Role Model Drafts, Segments, Skeleton
Roles, User Certifications. (The "Segments by Metadata" screens below are
what the conditional Data Segments link opens.)

Scan-detail screens (Role Model Draft, Role Evaluation, Segments Draft)
use a two-pane layout on medium-and-wider viewports: a left rail listing
every proposed item with its status tags, and the selected item's full
card on the right.

### "Role Mining" (launcher)
- Header: Mining Config (→ Studio Settings → Mining Config).
- Current settings summary (boundary, scope, attributes, dynamic-roles/
  duplicate-roles flags).
- "Create a Role Model Draft" — starts a peer-group discovery scan.
- Past drafts list: status, cancel (running) or remove.

### "Role Model Draft" (scan detail)
- Header: Mining Config (→ Studio Settings → Mining Config), Create All Roles (bulk-create eligible groups — disabled with a
  tooltip when every group already has a role or matches an existing one),
  Print (PDF).
- Create All Roles sheet: prefix/suffix override, "Roles to be created
  (N)" preview of the resulting names, then AI Generate Descriptions or
  Skip & Review. The "Review & Create" step shows editable per-role
  descriptions (with an inline warning where AI generation failed and the
  auto-generated summary was used instead), "Create N Role(s)", Back,
  Cancel, and "Creating X of N…" progress. A toast afterwards names any
  Common Access roles that were created but couldn't be flagged in ISC.
- Scan summary: status, boundary, scope, combinations scanned, peer-group
  count, attribute priority, Create-Dynamic-Roles/Allow-Duplicate-Roles
  flags, commonality threshold, entitlement-fetch-failure warnings.
- Per peer-group card: member/shared-entitlement counts, criteria pills,
  member/entitlement pills (detail sheets), dimension-breakdown preview,
  existing-role-match warning, "Create This Role" (inline name/description
  edit, confirm) or "Merge into Existing Role" (when duplicates disallowed),
  or an "already created" summary.

### "Role Evaluation" (launcher)
- Header: Evaluation Config (→ Studio Settings → Evaluation Config).
- "Search (optional) — limits this scan to roles whose name matches";
  "Evaluate All Roles" / "Evaluate Matching Roles" — start immediately.
- **Common Access is never prompted for.** Every evaluation entry point —
  a role's own Evaluate, the Roles list's Evaluate, and this screen —
  works out the Common Access roles that apply to each role from the
  membership rules: a Common Access role applies when its criteria are a
  subset of the role's (so tenant-wide and same-location Common Access
  apply, a different location's doesn't), and with the Multi-Company /
  Division Boundary on, a Common Access role must pin the same boundary
  value to count. This is per role, where the old picker applied one
  hand-picked list uniformly to every role in a scan. A scan still detects
  which of its own roles ARE Common Access (the tenant's flagged set), so
  report ordering and the Accept cascade — additions accepted onto a
  Common Access role come off the roles it covers — keep working.
- Current Consider-Common-Roles / Check-SOD-Violations settings shown.
- Past evaluations list: status, cancel/remove.

### "Role Evaluation" (scan detail)
- Header: Evaluation Config (→ Studio Settings → Evaluation Config), Print (PDF — summary table of every role with findings, then a
  page per role with its SOD violations, add/remove candidates, per-
  dimension gaps/redundancies, missing/stale dimensions, and a final
  Suggested New Roles section), Terminate this evaluation (if running).
- Summary: status, scope ("N explicitly selected role(s)" or the search
  query), Common Access roles in scope, roles evaluated, suggestion/SOD-
  violation counts; amber warning if Common Access exclusion failed.
- "Accept All (N)".
- Rail tags per role: Applied / Common Access / Dynamic. Clean roles are
  omitted from the report; Common Access roles float to the top. Empty
  states "No roles found" / "No changes needed".
- Per-role cards: status icon, Dynamic badge, inline Accept (replaced by
  "Applied" once accepted), summary, badges (Membership Rule Evaluated /
  Not Evaluated, SOD count, mitigated-violation present, N to remove/add, N
  dimension gaps, N new dimensions needed) — opens the same Evaluation
  Sheet as Role Detail.
- "Suggested New Roles" — informational role-gap proposals (nothing
  auto-created); "N member(s) — low confidence" badge when the sample is
  small.
- "Common Access Not Confirmed in ISC" — per-row "Flag Now" retry.

### "Skeleton Roles" (launcher)
- Header: Mining Config (→ Studio Settings → Mining Config).
- "Use Multi-Company/Division Boundary" one-off checkbox override.
- Local Role Naming fields (separator/prefix/suffix) with live preview,
  used only for this draft.
- "Create a Skeleton Role Model Draft" — plans (in this app, nothing sent
  to ISC) one disabled, access-less role per primary-attribute value (per
  Boundary partition when on), plus a Common Access role per partition
  when the Scan Scope is a simple attribute = value query. Dynamic Roles
  adds a dimension per secondary-attribute value. Skeleton roles never
  carry entitlements.
- Past drafts list: status, "N roles proposed · C created in ISC · F
  failed · attributes", Cancel (while planning) or Remove (this app's
  record only; roles already created stay in ISC).

### "Skeleton Role Model Draft" (draft detail)
- Header: Mining Config, Cancel (while planning), Create All Roles (N)
  (confirm; creates every proposed role not yet created, one at a time
  with "Creating X of N…" progress), Print (PDF — same shape as the Role
  Model Draft report: a summary table of every proposed role with type,
  members, dimension count and role created, then a page per role with
  its membership rule, members table (name, email, manager) and a
  dimensions table with each dimension's membership rule, member count and
  created / failed status).
- Summary (two columns on md+): status, started, identities scanned,
  roles proposed / created / failed; attribute priority, Boundary, Create
  Dynamic Roles, naming used, scope.
- Two-pane layout as on Role Model Draft: a "Proposed Roles (N)" picker
  rail (icon by status, role name, members · dimensions · boundary
  values, Common Access / Dynamic tag) and the selected role's card;
  cards stack in one column below md.
- Role card: name with Common Access / Dynamic badges, counts, membership
  criteria pills (boundary values in amber), member pills (click-through
  to Identity detail; the Common Access role summarises its scope-wide
  membership instead), dimension pills with member counts (green / red
  once created or failed in ISC), description, then either "Create This Role" / "Create
  Common Access Role" / "Retry Creating This Role" or the green
  created block linking to the role in Roles, with any Common Access
  flag or dimension failures.

### "Attribute Sync" (launcher)
- Header: Mining Config (→ Studio Settings → Mining Config).
- "Scan Sources for Attribute Sync" — scans every source's provisioning
  policy for identity-attribute-mapped fields, proposes a mapping model;
  running scans show "N of M sources scanned".
- Past scans list: status, summary (source/change counts), Remove.

### "Attribute Sync Scan" (detail)
- Header: Mining Config, Print (PDF — summary table of every source scanned, then a page
  per source with at least one proposed mapping, listing each field's
  target identity attribute, status, and reason).
- "Deploy this Attribute Sync Model (N change(s) across M source(s))"
  (confirm) — writes recommended mappings to every deployable source at
  once; reads "No recommended changes to deploy" when there's nothing.
- Expand/Collapse All.
- Per-source cards: change count, per-source Deploy icon, expandable
  proposed-mapping list (Already Enabled / Recommended / Excluded, with
  reasons; deployed rows append "· Deployed" or "· Deploy failed: …");
  skipped sources shown with reason.

### "Mail Distribution Groups"
- Header: Mining Config (→ Studio Settings → Mining Config).
- Mines peer groups with the role-mining logic and turns each into a mail
  distribution list. ISC's API can't create AD/Entra groups, so Create
  downloads an Exchange PowerShell script that creates them *empty*; after
  running it and aggregating, Add to Roles attaches each group to its
  matching mined role.
- Form (cascading): "Create in" (Active Directory / Entra), "Source"
  (filtered to AD or Entra connectors), and for AD only "Create groups in
  OU" (read from the source's aggregated data; warns to aggregate first if
  none found).
- "Scan for Distribution Groups" (shows "Scanning… (N identities)" while
  running).
- Results: "Select all (N groups)"; header "Create (N)" (downloads
  `distribution-groups-<ad|entra>.ps1`) and "Add to Roles (N)".
- Per-row: group name, criteria, member count, role-name pill once added
  to a role, check icon once the script has been generated.
- No confirms; no past-scans list — results live only while you stay on
  the page.

### "User Certifications" (Mining launcher)
- Header: User Certification Settings (→ Studio Settings → User
  Certifications).
- Current settings summary: Attributes (the Certification Attributes
  chosen in User Certifications; with none chosen it reads "—" and says a
  single campaign will cover everyone in scope), Scan Scope, Notifications,
  Undecided Access, Comments, Duration.
- "Create Certification Campaign Drafts" — plans (in this app, nothing
  sent to ISC yet) one certification campaign per distinct combination of
  the certification attributes' values among
  active in-scope identities (one per department; with department and
  location chosen, one per department × location — users missing a value
  fall into a "(no location)" bucket rather than being dropped), named
  prefix + "{value}" + suffix (values joined with " - "; the tenant's
  Campaign Prefix / Suffix, the suffix defaulting to " user access review "),
  covering all
  access held by every user matching and reviewed by each user's own
  manager (a SEARCH campaign on `attributes.{key}:"{value}"` clauses
  AND-ed together and with the Scan Scope when one is set, with no
  explicit reviewer so ISC assigns managers). Each planned campaign is
  created in ISC only on demand from the drafts screen. A campaign whose
  total access items exceed the Size Limit is flagged "Too large" and
  can't be created; the flag names the count, the limit, and the unused
  Schema Analysis attribute(s) to add to sub-divide it. With Campaign
  Filters active, each user's access is trimmed to the items that pass,
  counts show "N excluded by filters", and a campaign left with nothing
  is tagged "Nothing to certify" and can't be created. The description
  spells out the scope, what managers review, what happens to undecided
  access and whether comments are required. Campaign attributes come from
  the User Certifications settings; campaigns are created as drafts in ISC
  and never activated from here.
- Past runs list: status, "N campaigns planned · C created in ISC · T too
  large · F failed · attributes",
  Cancel (running — stops before the next campaign) or Remove (this app's
  record only; campaigns stay in ISC).

### "User Certification Campaign Drafts" (run detail)
- Header: User Certification Settings (→ Studio Settings → User
  Certifications), Cancel (while planning), Create All Campaigns in ISC (N)
  (confirm; creates every planned campaign that isn't too large or already
  created, one at a time with "Creating X of N…" progress — each as a
  STAGED draft with the deadline set Duration from now; nothing is
  activated — also offered as a full-width "Create All Campaigns in ISC
  (N)" button under the run summary), Print menu (Summary — run settings plus
  one table of every campaign; Detailed — the summary plus a section per
  campaign with its users and every access item).
- Summary: status, started time, attributes (Certification Attributes, or
  "all users in scope" for a run planned with none set), scope,
  identities scanned, drafts created / failed, reviewer, deadline, the
  settings the run used, the active filters with how many held access
  items pass them, and any filter warnings (e.g. an index that couldn't
  be searched).
- Results grouped "By {attribute}": per campaign the name, user count,
  access-item count with a roles / access profiles / entitlements
  breakdown (each user's effective access as ISC's search index reports
  it), the criteria, a status tag — "Not created" (planned), "Created in
  ISC", "Failed" (with ISC's error; retryable) or amber "Too large" (with
  the sub-divide suggestion) — and, for a planned or failed campaign, a
  per-row "Create in ISC" (or "Retry in ISC") button; click through to the
  campaign. Once created, the tag follows ISC's own status — "Generating in
  ISC" (PENDING; polled every few seconds and via a header Refresh ISC
  status icon), "Staged in ISC" (a real draft, visible in ISC's Campaigns
  list), "Active", "Completed" (with a note when zero certifications were
  generated), "Error in ISC" (with ISC's alerts) or "Deleted in ISC". Empty state when no active identity has a value
  for the attributes.

### Certification campaign (detail)
- Header: Create this campaign in ISC (planned/failed only), Print this
  campaign (settings header, users table, and every access item). A
  full-width "Create This Campaign in ISC" button also sits under the
  description for a planned or failed campaign.
- Settings header: attribute = value, user and access-item counts, Type
  (Search campaign on identities), Reviewer (each user's manager),
  Deadline (set once created), Notifications, Undecided Access, Require
  Comments, Size Limit, ISC status ("Not created yet", the ISC status once
  created, or "Not created — too large"), campaign ID and creation time,
  the search query, the generated description, an amber too-large banner
  with the sub-divide suggestion, or the failure message if ISC rejected
  it.
- Users list: search (name, email, manager, or access-item name),
  Expand all / Collapse all; per user a row with email, manager, and
  role / access-profile / entitlement counts, expanding to the access
  items grouped by type with their granting source.

### "Segments by Metadata" (launcher, conditional)
- Amber note (no link) if the boundary isn't set up yet; otherwise a
  read-only "Boundary: attr + attr" box.
- Header: Mining Config (Multi-Company/Division Boundary) (→ Studio
  Settings → Mining Config).
- "Include Roles" / "Include Entitlements" checkboxes.
- "Scan for Data Segments".
- "Segments by Metadata Drafts" list: status, "N combinations · M proposed
  data segments", cancel/remove.
- Created segments tag their suggested roles/entitlements with the
  multi-valued Boundary metadata attribute (name set in Mining Config) and
  use a filter on it as their Access Model, so membership follows the tag
  with no per-item selection limit.
- **Metadata value GUIDs** — a segment's ROLE filter only resolves in ISC
  when it names the metadata value by ISC's internal GUID (the ENTITLEMENT
  filter works with the technical name). No API returns that GUID — checked
  live: the values list, single-value GET, the attribute GET with embedded
  values, a tagged role's own metadata, search documents, and the
  value-create response all omit it. The only place it can be read is a
  segment whose role filter was picked by hand in ISC's segment editor:
  ISC writes the GUID there, beside the ENTITLEMENT filter's technical
  name for the same value. Every time Data Segments are listed the plugin
  harvests those pairs and remembers them per tenant in this browser, so a value needs to
  be picked in ISC only once — after that, every create / conversion using
  that value gets a resolved ROLE filter automatically. Until a value's
  GUID is known its ROLE filter falls back to the technical name and the
  result says the role filter needs re-picking in ISC.
- Every created segment (both variants) also gets an **IDENTITY** scope on
  its Access Model: a FILTER whose expression is the segment's own build
  criteria — the same expression that defines its membership, from one
  builder, so the two can't drift apart. Members of the "Germany" segment
  then see Germany's identities rather than everyone. If ISC refuses the
  identity scope (data segmentation is still experimental), the segment is
  still created with its entitlement / role scopes, and a message names how
  many were created without it, ISC's reason, and that members will see
  all identities until it's added in ISC's segment editor. Existing
  segments are not changed.
- The older explicit-selection variant ("Data Segment Mining" at
  `/role-mining/segments`, which puts each role/entitlement directly on the
  segment's Access Model and is subject to ISC's 50-item cap) still routes
  but no longer has a nav entry; its drafts stay listed under that route.

### "Segments by Metadata Draft" (scan detail, conditional)
- Header: Mining Config, Create All Data Segments (N) (confirm explains the tagging and
  metadata-filter Access Model), Merge All — Create N New, Update M
  Existing (confirm; create new + update existing matches in one pass),
  Print (PDF — summary table showing each segment's membership rule, e.g.
  `department = "Engineering" AND location = "Austin"`, plus a page per
  segment with matching roles/entitlements; the membership rule is built
  from the scan's own boundary attributes/values, since a proposed segment
  has no real membership-rule object yet).
- Summary: "Boundary: …" / "No Boundary set", "N combinations found";
  empty state "No new data segments proposed".
- Rail "Proposed Data Segments (N)" with per-row checkbox and Created/
  Exists tags.
- Per-suggestion card: name, member count, matching-role/entitlement
  counts, boundary-attribute pills, suggested-role pills (click-through),
  suggested-entitlement pills grouped by source; existing-match warning
  with "Add suggested roles & entitlements to this existing data segment"
  (or "Added" confirmation); newly-created confirmation.
- Select-one/all across creatable + mergeable suggestions; selection bar
  offers Create Selected (N) and/or Merge Selected (N) depending on what's
  checked.
- After creation a toast reports how many entitlements and roles were
  tagged (explicit-selection drafts instead warn about segments that hit
  the 50-item Access Model limit).

---

### "Segments" (Mining launcher)
- Proposes one ISC access-request Segment per Multi-Company/Division
  Boundary value combination: members are the boundary filter; access is
  every role, access profile and entitlement those members hold, found with
  identity search. Separate from Data Segments; nothing is created until
  the draft is reviewed. Header gear → Mining Config.
- **Scan for Segments** — disabled until the Boundary is enabled with at
  least one attribute (an amber note points to Schema Analysis); otherwise
  shows "Boundary: <attr> + <attr>".
- "Segments Drafts" list: status (Running / Completed / Failed /
  Cancelled), start time, "N boundary values · N proposed segments";
  Running drafts can be Cancelled, finished ones Removed (no confirmation).
  Drafts live in this browser's plugin storage per tenant; the list
  refreshes every 4 s while one runs, otherwise every 15 s.

### "Segments Draft" (scan detail)
- Status, start time, live progress ("Scanned N objects…", then "Searching
  members' access… N done"), any error, "Boundary: …", "N boundary values
  found". Two-pane layout from medium viewports up.
- Proposed segments: one per boundary value combination, named "<values>
  Segment", with "N members · N roles · N access profiles · N
  entitlements"; members as boundary pills ("<attr> = <value>"); roles as
  pills, access profiles and entitlements as pills grouped by source (every
  pill opens the object); a failed access search shown per segment.
- Status tags: **Created** / **Added** (green, link to the ISC Segment,
  date, "Assigned x/y roles · … — N failed"); **Exists** (amber: a Segment
  of that name already exists, so creating adds this access to it).
- Header **Create All Segments (N)**, or "Select all" plus bulk **Create
  Selected (N)** (only segments not yet created or added are selectable).
  The confirmation says how many new Segments will be created and how many
  existing ones receive access, with an "Activate new Segments" checkbox
  (on by default); progress "Creating segments… (x of y done)". Create
  makes the Segment (owner = you, member rule = boundary filter) or reuses
  the existing one of that name, then assigns each item by adding the
  segment id to the item's own `segments` list (keeping its other
  segments); results and assignment failures are reported.
- Header Print prints the draft as a PDF.

---

## Backup & Restore

Sub-links: Backup Configuration, Restore Configuration, Backup Offline
Sources, Restore Offline Source.

### "Backup"
- "Backup Now" — exports the tenant's full SP-Config, downloads as JSON;
  "Backup Complete" / "Backup Failed" result dialog.

### "Restore"
- "Choose Backup File" (becomes "Choose a Different File", plus a Clear
  link, once loaded) — loads and validates a prior SP-Config JSON export
  (confirms it's a real export and matches the signed-in tenant).
- Header metadata (version/timestamp/tenant/description).
- Search-to-filter, Select All, Expand All/Collapse All.
- Browsable object tree by type (up to 3 levels deep — group, item, and the
  item's own fields), but only the first two levels are selectable;
  checking an item always carries all of its fields along.
- "Restore Selected (N)" (confirm, destructive-warning; reads "Select
  objects to restore" while nothing is checked) — imports via SP-Config;
  result dialog. Additive-only — never removes objects created since the
  backup (on-screen amber banner says so).

### "Backup Offline Sources"
- Search, select-one/all across Delimited File/Generic sources — every
  eligible source is selected by default the first time the list loads.
- "Backup Selected (N)" — exports schema + accounts as CSV per source, with
  progress; "N Backups Ready" result dialog with per-file Download and
  "Download All as ZIP" (when more than one).

### "Restore Offline Source"
- "Choose Backup CSV" / "Choose a Different File" — parses CSV,
  auto-matches filename to a known source (or manual Target Source pick).
- Parsed-row table with per-row checkboxes, Select All.
- "Aggregate Selected (N)" — re-uploads selected rows as CSV, starts
  account aggregation on the chosen source.

---

## Studio Settings

Sub-links: Mining Config, Schema Analysis, Evaluation Config, User
Certifications, Preferences.

### "Role Mining Configuration" (Mining Config)
- **Role Mining** — "Enable Multi-Company or Division Boundary" (replaced
  by a tappable "Run Schema Analysis first" card until an analysis
  exists), Create Data Segments (dependent on boundary; when on, exposes a
  nested "Global Metadata Attribute Name" field — default "Segments", own
  Save — naming the Access Model Metadata attribute that Segments by
  Metadata tags and filters on), Create Dynamic Roles, Allow Duplicate
  Roles — toggles save immediately.
- **Role Naming** — Attribute Separator, Prefix, Suffix with live preview,
  explicit Save.
- **Entitlement Commonality** — 1–100% threshold (used at role-creation
  time and by Role Evaluation), explicit Save with validation.
- **Scan Scope** — "Scope (ISC Search query)" free text, Check button
  validates against the real Search API and shows "N user(s) match"
  ("0 users match — can't be saved" blocks Save), explicit Save.

### "Schema Analysis"
- "Run analysis"/"Re-run analysis" — scores every identity attribute by how
  well it divides the tenant into peer groups.
- "Multi-Company or Division Boundary attributes used for Data Segments and
  Roles" list (up to 2, reorder/remove), "Save Role Boundary"; shows
  "Disabled — enable in Mining Config" until the boundary toggle is on.
- "Role Creation Priority order" list (up to 2, reorder/remove, "Reset to
  suggested"), "Save priority order".
- Analysis metadata (identity count, timestamp, scope).
- Available attributes list (top 10): score, distinct values, avg group
  size, coverage %, "Add to Priority List" / "Add to Boundary List" per
  attribute (mutually exclusive — an attribute in one list isn't offered
  for the other).

### "Role Evaluation Configuration" (Evaluation Config)
- **Behavior** — Role Filtering dropdown ("Enabled & Disabled Roles" /
  "Enabled Roles Only" / "Disabled Roles Only"; default Enabled Only),
  Consider Common Roles toggle, Check for SOD Violations toggle, Allow SOD
  Mitigations toggle (hidden entirely while SOD checking is off) with
  "Manage Mitigations" modal — list, "Mitigation" detail (Role, SOD
  Policy, "Mitigated until" date, Expired marker), delete (no confirm).
  The modal also opens automatically when arriving from a role's
  "Mitigated Violation Present" link.
- **Role Evaluation Retention** — scans to retain (1–20), explicit Save.
- **Role Statistics Refresh** — Enable toggle, Frequency (Hourly/Daily/
  Weekly), "Time of day" (becomes "Minute of the hour" for Hourly), Start
  date (required to enable), Save (appears when dirty), "Run Now"
  (immediate background refresh — feeds Home's pass/needs-update tiles).

### "User Certifications"
- **Campaign Prefix and Suffix** (first setting) — two text fields. Campaign
  Prefix has no default (empty). Campaign Suffix defaults to
  **" user access review "** — spaces included — the phrase that used to be
  fixed inside every campaign name and is now the tenant's to reword. Max 50
  characters each, no line breaks. Saved per tenant with the rest of these
  settings, on a Save button (they're typed); a tenant's saved value always
  wins over the default, including a saved empty suffix. Every campaign this
  app drafts is named prefix + root name + suffix, where the **root name is
  just the certification attribute value(s)** ("Engineering", or
  "Engineering - Austin"), joined **exactly as typed — leading and trailing
  spaces are kept** and nothing is inserted, so the separator is the user's
  to type ("Q3 - " with its trailing space; " (SOX)" with its leading
  space). A live "Example name" preview shows the result with its spaces
  preserved; "Reset suffix to default" puts the default back in the field
  (Save to keep it). Mining → Certifications' settings summary shows the
  resulting name pattern too.
- **Certification Attributes** — an ordered "Sequence"
  list of the chosen attributes (numbered, Move up / Move down / Remove)
  and an "Available attributes" list of Schema Analysis's remaining
  candidates (key, distinct-value count, coverage) with Add; every change
  saves immediately. One campaign is created per distinct combination of
  the chosen attributes' values, and the values appear in the campaign
  name in this sequence ("Engineering - Austin user access review").
  **Nothing chosen → one single campaign covering every user the rest of
  the criteria select** (scope, identity filters and item filters still
  apply), named "All users" before the prefix/suffix. Choosing attributes
  is what sub-divides that into several campaigns — which is also the
  remedy offered when one exceeds the Size Limit. "Open Schema Analysis"
  shown until an analysis exists.
- **Campaign Defaults** for every draft Mining → Certifications creates —
  each dropdown saves immediately: Enable Notifications (Yes / No; default
  Yes), Undecided Access (Maintain / Revoke; default Maintain — Revoke
  turns on ISC's auto-revoke at the deadline), Require Comments (None /
  All Decisions / For Revoke; default None), Duration (1 week / 2 weeks /
  30 days; default 30 days — sets the campaign deadline from creation
  time), Size Limit (whole number 1–1,000,000, default 10,000; explicit
  Save — the most access items one campaign may contain before it is
  flagged as too large instead of created).
- **Campaign Filters** — Access Item Types, Access Privilege and Metadata
  narrow which access items each campaign certifies; the Search Filter
  narrows which identities it covers. Include filters combine, an exclude
  filter removes its matches; item filters are resolved when a run is
  planned and sent as the campaign's access constraints on create.
  **Access Item Types** (first filter) — checkboxes for Roles, Access
  Profiles and Entitlements, all selected by default (= no type filter); each change saves immediately; the last selected box can't be cleared (a campaign
  has to certify something). Beneath them, **Role options**, enabled only
  while Roles is selected (their saved values are kept while it isn't):
  **Exclude Birthright Roles** — a birthright role is any role with a
  membership rule (ISC membership type STANDARD with criteria); roles with
  an explicit identity list or no membership are not birthright and stay
  in; the help text warns that if every role has a rule this removes all
  roles. **Include Common Access Roles** — enabled only while Exclude
  Birthright Roles is on: keeps Common Access roles (ISC's confirmed list
  plus the ones this app flagged or created, minus denied) even though they
  have membership rules, while other rule-based roles stay excluded. The
  run's filter summary reports how many roles were excluded and how many
  Common Access roles were kept; if the tenant's roles can't be read, the
  birthright exclusion is skipped for that run and a warning says so rather
  than silently dropping or keeping roles.
  Access Privilege (add one filter per level — High / Medium / Low / "No
  Value Set for Privilege (null)", the last matching items with no privilege level at all — each
  with its own Include / Exclude; Include levels are OR-ed, Exclude
  levels are OR-ed and win where both apply; none = privilege ignored,
  the default; matches ISC's privilege level on entitlements, roles and
  access profiles; per-row mode change and Remove); Metadata Filter (add any number of Access Model
  Metadata attribute + value pairs from the tenant's registry, each with
  its own Include / Exclude choice — Include pairs are OR-ed, Exclude
  pairs are OR-ed and win where both apply; per-pair mode change and
  Remove); Search Filter
  (identities) — an ISC Search query over identities that every campaign
  is limited to, default `attributes.cloudLifecycleState:active` with
  Include, explicit Save, "Include only" / "Exclude" matching identities;
  applied to the identity scan and AND-ed into each campaign's search
  query. All User Certifications settings are tenant-level and shared by
  every user of the tenant. Tenant-wide, shared by every user of the tenant; changes affect
  campaigns created from then on only.
  **Included Sources** (last setting on the screen) — every source in the
  tenant, listed by name with its connector, **all selected by default**;
  campaigns only certify access profiles and entitlements that come from a
  selected source. Roles aren't tied to a source, so this never removes a
  role. Each change saves immediately; "N of M sources included" count;
  Select all / Clear all (acting on the shown rows when the name filter is
  in use); a name filter appears past 8 sources. What is saved per tenant
  is the list of DESELECTED sources, so the default really is "all", and a
  source added to the tenant later is included automatically. With every
  source deselected, an amber note says campaigns will hold no access
  profiles or entitlements. An deselected source that no longer exists is
  listed with a "Forget it" link rather than lingering silently. ISC
  sources have no active/inactive switch, so the list is every source that
  exists. The run's filter summary names the deselected sources and how many
  items that removed; an item whose source isn't known is kept.
### "Preferences"
- **Tenant Conversion** — "Auto Convert a Tenant": converts a DemoHub
  tenant to a new Role Model end to end — configuration backup to this
  computer, rename existing roles, mine and create new roles, optionally
  build Data Segments (Country as the boundary), deploy Attribute Sync,
  apply AI descriptions, remove the old roles. Modal: destructive warning,
  "Dynamic Roles" and "Data Segments" checkboxes (both on by default),
  "Start Conversion" / Cancel; live timestamped log ("Keep this window
  open — the conversion runs from this browser tab"); per-step "Step
  failed" overlay with Retry / Continue / Cancel; on finish "Change Log
  PDF" and Close.
- **Appearance** — System (default, follows the OS), Light, or Dark.
  Per-user, kept in this browser.
- **AI Route** — ISC workflow (default) or Direct from this browser. The
  workflow route runs the tenant's "Admin Studio AI Query" workflow, which
  takes its URL from the "Admin Studio AI Connection" parameter and its
  key from the "Admin Studio AI Key" parameter in ISC Parameter Storage, so
  no key is in the browser (see isc/README.md). Per-user.
- **Anthropic API Key** — entered masked (eye toggle to reveal while
  typing) and never persisted by the plugin: "Save to ISC" writes it,
  encrypted end to end, into the tenant's "Admin Studio AI Key" parameter
  and creates the "Admin Studio AI Connection" parameter and the "Admin
  Studio AI Query" workflow if the tenant lacks them (the workflow is left
  disabled, as the route needs). The field then shows that the tenant
  holds the key (never a value) with Replace, and flags anything missing.
  Replacing the key updates the parameter and checks the other two are
  still in place; a line under the field says what was created or
  updated. The Direct route, which calls api.anthropic.com from the
  browser once ISC's plugin content security policy allows it, can use a
  key typed here only until the tab is closed or reloaded.
- **JSON Edit Mode** — Text (default) or Tree: the view every JSON editor
  opens in (workflows, transforms, forms, launchers, metadata, source JSON,
  raw JSON panels). Per-user, kept in this browser like Appearance.
  JSON that doesn't parse always opens in Text regardless, since Tree
  can't show it, and each editor's own Tree | Text tabs still switch views
  for that one edit.

---

## Outside the tab bar

### "Profile"
- Avatar initial, display name (falls back to "Admin") and the tenant UI
  host. Read-only; the plugin has no sign-out, since ISC's App Shell owns
  the session.
- "Session" card: Tenant (UI host), Signed in as (username), SailPoint ISC
  API version (v2026), Application version.

### "My Reports"
- List of generated/saved PDF reports (e.g. Role Composition Email
  Reports). Click to open/download (falls back to download if pop-up
  blocked).
