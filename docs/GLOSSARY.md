# Glossary

Terms this plugin introduces on top of standard SailPoint ISC concepts. Each
entry cites where the definition comes from in code, and links to the ISC
product documentation for the underlying platform concept it builds on.

---

### Dimension

A **Dynamic role**'s base membership criteria describes a broad population
(e.g. everyone in a department) that shares a base set of entitlements. A
**dimension** is a narrower slice of that same population — everyone sharing
one additional identity-attribute value (e.g. `title = "Staff Accountant"`
within that department) — plus the entitlements *that* narrower group holds
in common, beyond the base role's entitlements.

> "A dimension's entitlements are those every member sharing that value
> holds, minus what the base role already grants."
> — `client/src/lib/ported/roleMiningShared.js` (`buildPeerGroups`)

Managed on the **Dimensions** tab of Role Detail; proposed automatically by
[Role Scan](#role-scan-aka-role-model-draft) and flagged as missing/stale by
[Role Evaluation](#role-evaluation).

Related ISC concept: [Managing Roles — Dynamic Roles](https://documentation.sailpoint.com/saas/help/access/roles.html)

---

### Common Access

An ISC role flagged as **birthright / universal access** — access nearly
everyone (or everyone in a broad segment) should have, generally granted
automatically rather than requested. This app tracks Common Access roles
from three merged sources:

1. Roles ISC itself has confirmed as Common Access (`GET /beta/common-access`)
2. Roles a user has manually flagged as Common Access in this app
3. Roles a Role Scan in this app created *as* Common Access

A Common Access role's entitlements only count as "birthright" for another
role if the Common Access role's own membership criteria is a **superset** of
the target role's — i.e., everyone eligible for the target role is also
eligible for the Common Access role (`criteriaLeavesSubsetOf`,
`client/src/lib/ported/roleCommonAccess.js`). This is why Role Evaluation and Role Scan both
show a **Common Access picker** before running: you choose which overlapping
Common Access roles should be excluded from "missing entitlement" suggestions
so birthright access isn't double-proposed.

Related ISC concept: [Managing Roles — Common Access](https://documentation.sailpoint.com/saas/help/access/roles.html) (requires AI-driven Identity Security licensing in ISC itself)

---

### Peer group

The unit Role Scan discovers before it becomes a role: a bucket of identities
sharing some combination of attributes *and* enough entitlements in common
to be worth turning into a role. Role Scan tries the broadest attribute
combination first, so people who vary only on some attributes end up as one
Dynamic role with [dimensions](#dimension), rather than being fragmented into
many narrow roles (`buildPeerGroups`, `client/src/lib/ported/roleMiningShared.js`).

---

### Role Scan (a.k.a. "Role Model Draft")

The peer-group discovery workflow (Role Mining → **Scan for Roles**): fetches
every identity's attributes and entitlements, buckets them into
[peer groups](#peer-group), computes each group's commonly-held entitlements
at a configurable threshold, and — if the
[Multi-Company/Division Boundary](#boundary-attributes--multi-companydivision-boundary)
is enabled — runs one independent scan pass per boundary-value combination.
A reviewer picks which discovered groups to turn into real roles (with an
AI-generated name/description review step).

---

### Skeleton role

A cheap variant of Role Scan (**Mining Config → Skeleton Scan**) that skips
entitlement fetching entirely — it buckets identities purely by
[Schema Analysis](#schema-analysis)'s top attribute(s) and creates roles and
dimensions with no entitlements. Always created **disabled**, since there's
nothing yet to safely grant.

---

### Schema Analysis

Looks at identity *attributes* (not entitlements) and scores which 1–2
attributes best divide the tenant into peer groups, using a normalized-entropy
× coverage score (`client/src/lib/ported/schemaAnalysis.js`). Replaces a hardcoded
department/location assumption — its output feeds the grouping attributes
used by [Role Scan](#role-scan-aka-role-model-draft) and [Skeleton Scan](#skeleton-role).

---

### Boundary attributes / Multi-Company/Division Boundary

A **Studio Settings → Schema Analysis** toggle. When enabled, Role Mining
produces a separate set of role drafts *per distinct combination* of up to
two chosen attribute values (e.g. one pass per Company, or per
Company + Division) instead of one tenant-wide pass
(`partitionProfilesByBoundary`, `client/src/lib/ported/roleMiningShared.js`). The same partitioning also drives
[Data Segments](#data-segments) generation.

---

### Data Segments

This app's **Build Segments** feature (Studio Settings → Schema Analysis;
browsed under Browse → Data Segments) creates one ISC
[Segment](https://documentation.sailpoint.com/saas/help/segmentation/index.html)
per distinct combination of [Boundary attribute](#boundary-attributes--multi-companydivision-boundary)
values found among active identities — the same partitioning Role Scan uses
for peer groups. Only shown in navigation when a tenant has both the
Boundary and its own "Create Data Segments" setting enabled.

Related ISC concept: [Managing Data Segments](https://documentation.sailpoint.com/saas/help/segmentation/manage_data_segments.html)

---

### Role Evaluation

Compares a role's currently-granted entitlements against what its **actual
current members** hold today — computed live (`evaluateRoleMembershipMembers`),
not from ISC's search index, since that can't be trusted for this comparison.
This is a **deterministic algorithm**
(`evaluateRoleAlgorithmic`, `client/src/lib/ported/roleEvaluation.js`), not an LLM call — an
earlier AI-based version of this specific feature was tried and removed.

For each role it flags:
- Stale entitlements (rarely held by current members)
- Commonly-held-but-missing entitlements
- Missing dimensions (an attribute value with enough shared entitlements that
  isn't yet a dimension) and stale dimensions
- [SOD](#sod-mitigation) policy violations, in both the base role and its
  dimensions, factoring in applicable [Common Access](#common-access)
  entitlements so birthright access isn't flagged as an anomaly

Related ISC concept: [Separation of Duties](https://documentation.sailpoint.com/saas/help/sod/index.html)

---

### SOD mitigation

A time-limited exception, kept in this browser's plugin storage (the
`sod-mitigations` record store), that
suppresses an active Separation-of-Duties violation from being reported until
it expires, **without removing** the conflicting entitlements. The
alternative in Role Evaluation's Repair flow is to actually remove the
conflicting entitlement ("Repair Role").

Related ISC concept: [Separation of Duties Overview](https://documentation.sailpoint.com/saas/help/sod/index.html)

---

### Role Propagation ("Apply in ISC")

SailPoint's own tenant-wide job that provisions or revokes access according
to role/dimension membership criteria. Editing a role or its dimensions in
this app takes effect in the role **definition** immediately, but members'
actual access only catches up once Role Propagation runs (Role Mining →
**Apply in ISC**).

Related ISC concept: [Propagating Role Changes](https://documentation.sailpoint.com/identityiq/help/roles_groups_and_populations/roles/propagating_role_changes.html)

---

### Role Statistics Refresh

A [Role Evaluation](#role-evaluation) pass across every role in the tenant,
started with **Run Now** (the plugin has no background scheduler, so the
old app's hourly/daily/weekly schedule is gone). Its most recent run feeds
the Home screen's pass / needs-update / SOD stat tiles.
