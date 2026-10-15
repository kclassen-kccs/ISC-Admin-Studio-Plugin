# Admin Studio — Product Description

Product copy for Admin Studio as a SailPoint Identity Security Cloud (ISC)
UI plugin. The earlier web-app and App Store copy is in
[archive/](archive/README.md).

---

## Tagline

> **Admin Studio** — Role engineering and tenant administration, inside
> Identity Security Cloud.

## Short blurb (~160 chars)

> Mine Dynamic Roles and Data Segments from real access data, keep
> Attribute Sync healthy, and run your tenant's daily admin work, all
> inside ISC with your own sign-in.

## Description

Admin Studio is the workbench for people who run SailPoint Identity
Security Cloud tenants, installed into ISC as a UI plugin. It takes the work
that normally means hours of spreadsheet archaeology and console
tab-hopping, discovering birthright dynamic roles, mapping segments, syncing
attributes, onboarding flat-file sources, and turns each one into a guided,
reviewable flow that ends with real objects created in ISC.

**Runs inside ISC, as you.** There is nothing to sign in to and no server
in between: ISC opens Admin Studio in its own page, hands it a token scoped
to your session, and every call goes straight to your tenant's API with
your own permissions. What you can do in ISC is what you can do here,
nothing more.

**Mine for ISC Dynamic Roles with criteria and Dimensions included.**
Scan for Roles reads every identity's attributes and entitlements,
buckets your population into peer groups, and proposes complete Dynamic
Role Models: the membership criteria that define who belongs, and the
entitlements the group genuinely holds in common at a threshold you
control. Review each proposal, tune it, and create it in ISC with one
click, with AI-drafted descriptions already in place.

**Mine for ISC Data Segments with membership, roles, and entitlements
mapped.** Admin Studio divides the organization into administrative
boundaries that match your company structure to create each Data
Segment's population, keeps roles from spanning segment boundaries, and
maps the identities, roles and entitlements relevant to each segment so it
is a working model on day one.

**Create and maintain Attribute Sync.** Scan every source's provisioning
configuration, see where attribute sync is missing or drifting, deploy the
recommended sync model, and re-run the scan any time to keep mappings
honest as sources evolve.

**AI descriptions where empty text boxes used to be.** Generate grounded,
fact-based descriptions for roles, access profiles, sources and
applications in bulk, drafted from the object's real entitlements,
membership and configuration, then reviewed and edited by you before
anything is saved. The same assistant explains failed events and suggests
fixes, repairs broken JSON, drafts and modifies workflows, and reviews role
composition.

**AI that stays inside your tenant.** The plugin never calls a model
provider itself. It runs an ISC workflow on your tenant that holds the API
key in ISC Parameter Storage, encrypted, so the key is never in a browser,
a bundle or a file. One admin enters the key once, on the plugin's
Preferences screen.

**Own your disconnected sources.** Add, edit and remove accounts on
Delimited File sources without exporting a CSV. Onboarding is just as
fast: point the wizard at a CSV and Admin Studio creates the source,
detects the schema from the file's header row, aggregates the accounts
and, if you want, creates a matching Identity Profile with AI-matched
attribute mappings in the same pass.

**The admin tasks, one click away.** Account and entitlement aggregations,
unoptimized aggregations for the stubborn cases, account resets,
entitlement resets and full source resets, each with a clear confirmation,
right from the source's page. Workflows, forms, transforms, launchers,
governance groups, Access Model Metadata, Parameter Storage, user
certification campaigns and the tenant's event log are all a click away in
Browse and Tools.

**Evaluate, repair, report.** Role Evaluation checks every role against
who actually holds what today, flags stale criteria, missing dimensions and
separation-of-duties violations, and walks you through repair, with
time-boxed SOD mitigations and PDF reports you can print, save or send to
each role owner.

**Back up and restore.** Export the tenant's configuration and
offline-source data, restore selectively, and keep the backups wherever
you keep files.

## Requirements

A SailPoint Identity Security Cloud tenant with UI plugins enabled, an
administrator to install the plugin with the SailPoint CLI (see
[../dist/INSTALL.md](../dist/INSTALL.md)), and, for the AI features, an
Anthropic API key entered once on the plugin's Preferences screen. Admin
Studio is an independent product, not affiliated with or endorsed by
SailPoint Technologies.

## Feature checklist

- Dynamic Role mining: membership criteria plus common entitlements,
  proposed and created in ISC, with batch management operations
- Dimension mining: membership, parent-role mapping and incremental
  entitlements per dimension
- Data Segment mining: members, roles and entitlement mapping, with
  draft management
- Attribute Sync: scan, recommend, deploy and re-check sync models
- AI descriptions for roles, access profiles, sources and applications,
  AI fix suggestions for failed events, JSON repair, workflow drafting
- Disconnected sources: in-app account add, edit and delete; CSV to an
  auto-created source and Identity Profile
- Source operations: account, entitlement and unoptimized aggregations;
  account, entitlement and full source resets
- Role Evaluation: drift detection, SOD violations, guided repair and
  mitigations
- Browse and edit: identities, roles, entitlements, access profiles,
  applications, sources, workflows, forms, launchers, transforms,
  governance groups, metadata, segments, Parameter Storage,
  certification campaigns, org info
- Reports: PDF export and print, per-owner email reports, saved report
  history
- Backup and restore: ISC configuration and offline-source data
