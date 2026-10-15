# Admin Studio — Product Description (Web App)

> **Archived.** Marketing copy for the earlier standalone web app at adminstudio.kccs.net (hosted sign-in, proxy server). The current product description is [../PRODUCT_DESCRIPTION.md](../PRODUCT_DESCRIPTION.md).

App Store–style marketing copy for the web application at
adminstudio.kccs.net. Companion to [APP_STORE_LISTING.md](APP_STORE_LISTING.md)
(the native iOS listing).

---

## Tagline

> **Admin Studio** — Role engineering for SailPoint Identity Security
> Cloud, without the busywork.

## Short blurb (~160 chars)

> Mine Dynamic Roles and dimensions from real access data, keep Attribute
> Sync healthy, and run your ISC tenant's daily admin work — all in one
> fast web app.

## Description

Admin Studio is the workbench for people who run SailPoint Identity
Security Cloud tenants. It takes the work that normally means hours of
spreadsheet archaeology and console tab-hopping — discovering birthright
dynamic roles, mapping segments, syncing attributes, onboarding flat-file
sources — and turns each one into a guided, reviewable flow that ends
with real objects created in ISC.

**Mine for ISC Dynamic Roles with criteria and Dimensions included.**
Scan for Roles reads every identity's attributes and entitlements,
buckets your population into peer groups, and proposes complete Dynamic
Role Models: the membership criteria that define who belongs, and the
entitlements the group genuinely holds in common at a threshold you
control. Review each proposal, tune it, and create it in ISC with one
click, with AI-drafted descriptions already in place.

**Mine for ISC Data Segments with membership, roles, and entitlements
mapped.** Admin Studio divides the organization into administrative
boundaries that match your Company structure and legal boundaries to
create each Data Segment's population. The mining process also does not
let Roles span across Data Segment boundaries. Identities, Roles and
Entitlements relevant to each Segment are included so it becomes a
functional model on day one.

**Create and maintain Attribute Sync.**
Scan every source's provisioning configuration, see where attribute sync
is missing or drifting, and deploy the recommended sync model — then
re-run the scan anytime to keep mappings honest as sources evolve.

**AI descriptions where empty text boxes used to be.**
Generate grounded, fact-based descriptions for Roles, Access Profiles,
Sources, and Applications in bulk — drafted from the object's real
entitlements, membership, and configuration, then reviewed and edited by
you before anything is saved.

**Own your disconnected sources.**
Update disconnected-source users directly in the app — add, edit, and
remove accounts on Delimited File sources without ever exporting a CSV.
Onboarding is just as fast: point the wizard at a CSV and Admin Studio
auto-creates the source, detects the schema from the file's own header
row, aggregates the accounts, and — if you want — auto-creates a matching
Identity Profile with AI-matched attribute mappings in the same pass.

**The admin tasks, one click away.**
User aggregations, entitlement aggregations, unoptimized aggregations for
the stubborn cases, account resets, entitlement resets, and full source
resets — each with a clear confirmation, right from the source's page.

**Evaluate, repair, report.**
Role Evaluation checks every role against who actually holds what today,
flags stale criteria, missing dimensions, and separation-of-duties
violations, and walks you through repair — with time-boxed SOD
mitigations, scheduled re-evaluations, and polished PDF reports you can
print, save, or email.

**Enterprise sign-in, zero stored passwords.**
Everyone signs in on SailPoint's own hosted login page — SSO and MFA work
exactly as configured, the app never sees a password, and each user's
reach mirrors their ISC permissions.

## Requirements

A SailPoint Identity Security Cloud tenant and a one-time OAuth client
registration by an administrator. Admin Studio is an independent product,
not affiliated with or endorsed by SailPoint Technologies.

## Feature checklist

- Dynamic Role mining: membership criteria + common entitlements,
  proposed and created in ISC, Batch management operations
- Dimension mining: membership, parent-role mapping, and incremental
  entitlements per dimension
- Data Segmentation mining: Members, Roles, and entitlements mapping,
  Auto Draft Management
- Attribute Sync: scan, recommend, deploy, and re-check sync models
- AI descriptions: Roles, Access Profiles, Sources, Applications — bulk
  generate, review, save
- Disconnected sources: in-app account add/edit/delete; CSV to
  auto-created Source + Identity Profile
- Source operations: user/entitlement/unoptimized aggregations; account,
  entitlement, and full source resets
- Role Evaluation: drift detection, SOD violations, guided repair,
  mitigations, scheduling, Backup & Restore
- Reports: PDF export, print, email, and saved report history
- Backup & restore: ISC Configurations and offline-source data, per-file
  or single ZIP
