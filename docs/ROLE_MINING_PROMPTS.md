# Role Mining — Rebuild Prompts

A sequence of prompts for an AI coding assistant that recreate the logic
Admin Studio uses to mine Roles from a SailPoint Identity Security Cloud
(ISC) tenant. Each prompt is self-contained: it states the rules the
current implementation enforces, so the assistant can rebuild the feature in
any language or framework without reading this repository.

The prompts describe **what** the logic does and **why** each rule exists.
They do not prescribe file names or a UI. Where the current code is the
reference, the module is named in a *Reference* line so a reader can compare.

Terms in **bold** are defined in [GLOSSARY.md](GLOSSARY.md). The algorithm
summary lives in [ARCHITECTURE.md](ARCHITECTURE.md#the-role-mining-algorithm-role-scan);
the screens are in [USER_GUIDE.md](USER_GUIDE.md#mining).

---

## How to use these prompts

1. Give the assistant **Prompt 0** first and keep it in context for the rest.
2. Run Prompts 1 to 10 in order. Each builds on the previous one's output.
   Paste the assistant's result (or a summary of its public functions) into
   the next prompt where it says *"Use the … you built earlier"*.
3. Finish with **Prompt 11**, the worked example, and make every check pass
   before calling the port done.

Each prompt ends with a **Checks** list. Treat those as acceptance tests.

---

## Prompt 0 — Context and ground rules

```
You are building the role-mining engine of an administration tool for
SailPoint Identity Security Cloud (ISC). The engine discovers "peer groups"
of identities that share identity attributes, works out which entitlements
each group commonly holds, and can create a real ISC Role (optionally a
Dynamic role with Dimensions) from each group. It runs against the tenant's
own REST API with a bearer token; it never calls anything else.

ISC facts you must respect:

- Search API: POST /v2026/search with body { indices: ["identities"],
  query: { query: "<Lucene>" }, sort: ["id"], searchAfter?: [<lastId>] }
  and query parameter limit (max 250). Offset paging fails past 10,000
  records, so ALWAYS page with searchAfter on the id sort. A page shorter
  than the limit is the last page. Add
  queryResultFilter: { includes: ["id","name","displayName","email",
  "manager","attributes","access"] } when you need the identity's access.
  In a Search identity document, top-level `name` is the USERNAME and
  `displayName` is the human name. `attributes.cloudLifecycleState` and
  `attributes.identityState` carry lifecycle state. `access` is an array
  of { id, name, displayName, type, source } where type is one of
  ENTITLEMENT, ACCESS_PROFILE, ROLE.
- Roles API: GET /v2026/roles (limit 250, offset, sorters=name) to list;
  POST /v2026/roles to create; PATCH /v2026/roles/{id} with content type
  application/json-patch+json; GET /v2026/roles/{id}.
- Dimensions (Dynamic roles): POST /v2026/roles/{roleId}/dimensions,
  GET /v2026/roles/{roleId}/dimensions. Create dimensions SEQUENTIALLY:
  parallel creates against the same parent role return intermittent 500s.
- Entitlements: GET /v2026/entitlements?filters=id in ("a","b",...)&limit=N
  resolves up to 50 ids per call to their real name and source name.
- Common Access (IAI): POST /common-access/v1 with header
  X-SailPoint-Experimental: true flags a role as Common Access. It needs
  the OAuth scope iai:access-modeling:manage; a bare 401 means the scope
  or licence is missing, a 409 means the role is already flagged. GET of
  the list does not reliably include a role right after it is flagged, so
  keep your own record of roles you flagged and union it with the list;
  keep a record of roles the user explicitly unflagged and subtract it.
- Membership criteria shape (what ISC accepts on a role):
  { type: "STANDARD", criteria: { operation: "OR", key: null, values: null,
    stringValue: null, children: [ { operation: "AND", key: null,
    values: null, stringValue: null, children: [ <leaves> ] } ] } }
  where a leaf is { operation: "EQUALS", key: { type: "IDENTITY",
  property: "attribute.<key>", sourceId: null }, values: ["<value>"],
  stringValue: null, children: null }.
  A dimension's criteria is a single AND with one EQUALS leaf whose value
  is in stringValue (not values).

Resilience rules for every ISC call:
- Retry on no HTTP status, 429, or any 5xx, up to 3 attempts; wait
  Retry-After seconds when the header is present, otherwise
  attempt * 750 ms. Never retry a 4xx other than 429.
- Scans run in the foreground of whatever process started them and
  persist progress to a record so a UI can poll it. A record whose status
  is "running" but whose runner is gone (process or tab reloaded) must be
  marked "failed" the next time its store is read.

Write clear, testable code with pure functions for the algorithmic parts
(scoring, bucketing, commonality) and thin wrappers for the API calls.
```

---

## Prompt 1 — Identity loader and scope resolver

*Reference: `client/src/lib/ported/roleMiningShared.js` → `searchAllIdentities`, `fetchScopeIds`.*

```
Using the ISC facts above, build two functions.

1. searchAllIdentities({ query = "*", pageSize = 250, onPage, includeAccess })
   Pages through every identity matching the Lucene query with searchAfter.
   Normalize every Search document into exactly this shape:
     {
       id,
       name:          displayName || name,
       email:         email || null,
       status:        attributes.cloudLifecycleState || null,
       identityState: attributes.identityState || null,
       manager:       { id, name } or null,
       attributes:    [ { key, value } ] for EXACTLY these five keys, in
                      this order, with null when missing:
                      manager, jobTitle, department, country, location
     }
   When includeAccess is true, also request the `access` field (see
   queryResultFilter) and add
     access: [ { id, name } ]   restricted to items whose type is ENTITLEMENT.
   After each page call onPage(normalizedPage, totalSoFar) if provided;
   if it returns false, stop paging (this is how a scan is cancelled).
   Return the full array.

2. fetchScopeIds(indices, query)
   For a non-empty query, return a Set of every document id in the given
   indices (e.g. ["identities"]) that matches it, paged with searchAfter.
   For an empty or whitespace query return null, which callers treat as
   "no scope: do not filter" (NOT "matches nothing").

Also provide isActiveIdentity(idn): true when status === "active" or
identityState === "ACTIVE". Service and test accounts come back with
null in both fields.

Checks:
- A tenant with 12,000 identities is read in full (no 10,000 cap).
- With includeAccess, an identity holding 3 entitlements, 1 access
  profile and 2 roles yields access.length === 3.
- fetchScopeIds("identities", "") === null.
- onPage returning false stops after that page and returns what was read.
```

---

## Prompt 2 — Schema Analysis: pick the attributes to mine on

*Reference: `client/src/lib/ported/schemaAnalysis.js` → `scoreSchemaAttributes`, `runSchemaAnalysis`, `setSchemaTopAttributes`, `setSchemaRoleBoundary`.*

```
Use the identity loader you built earlier. Build "Schema Analysis", which
looks only at identity ATTRIBUTES (never entitlements) and picks the
attributes that best divide the tenant's people into peer groups.

Constants:
  PEER_GROUP_MIN_SIZE = 3
  STATUS_KEYS = { "status", "cloudStatus", "internalCloudStatus",
                  "identityState", "cloudLifecycleState", "lifecycleState" }

scoreSchemaAttributes(identities) -> candidates sorted best first
  For every attribute key across all identities, count how many identities
  hold each distinct non-empty value, skipping STATUS_KEYS (they describe
  state, not who someone is). Then for each key:
    - distinctValues = number of distinct values; skip the key if < 2.
    - coveredCount   = identities with any value for this key.
    - avgGroupSize   = coveredCount / distinctValues; skip the key if
                       avgGroupSize < PEER_GROUP_MIN_SIZE (this is what
                       removes near-unique fields like email or employee id).
    - entropy        = -Σ p·log2(p) over the value counts, p = count/coveredCount.
    - normalizedEntropy = entropy / log2(distinctValues)   (0..1)
    - coverage       = coveredCount / identities.length    (0..1)
    - score          = normalizedEntropy * coverage
  Return [{ key, distinctValues, coverage (3 dp), avgGroupSize (1 dp),
  score (3 dp) }] sorted by score descending.

runSchemaAnalysis(settings, previousAnalysis) -> record
  1. Resolve the Scan Scope: scopeIds = fetchScopeIds(["identities"],
     settings.nameScope). Load every identity and keep those that are
     active (isActiveIdentity) and, when scopeIds is not null, in scope.
  2. candidates = scoreSchemaAttributes(identities).
  3. suggestedTopAttributes = first 2 candidate keys.
     topAttributes = suggestedTopAttributes (a fresh run RESETS any manual
     priority order, because the valid candidate set may have changed).
  4. Multi-Company/Division Boundary carry-forward:
     previousBoundaryStillValid = previous exists AND previous.roleBoundaryEnabled
       AND previous.roleBoundaryAttributes is non-empty AND every one of
       them is still a candidate key.
     firstRunBoundaryOn = no previous record AND suggestedTopAttributes
       is non-empty (a tenant's very first analysis turns the boundary AND
       "create data segments" on, seeded with the suggested attributes).
     roleBoundaryEnabled    = previousBoundaryStillValid || firstRunBoundaryOn
     roleBoundaryAttributes = previous's when still valid, else the
                              suggested attributes on a first run, else [].
     createDataSegments     = firstRunBoundaryOn ||
                              (previousBoundaryStillValid && previous.createDataSegments)
  5. Persist one record per tenant:
     { tenant, computedAt, totalIdentities, scopeQuery (null when no scope),
       candidates, suggestedTopAttributes, topAttributes,
       roleBoundaryEnabled, roleBoundaryAttributes, createDataSegments }

setSchemaTopAttributes(topAttributes)
  Accept 1 or 2 UNIQUE keys that are all candidates of the stored analysis,
  in priority order (first = highest). Store them as topAttributes without
  re-running. Reject anything else with a clear message; reject with
  "Run schema analysis first." when there is no record.

setSchemaRoleBoundary({ enabled, attributes, createDataSegments })
  enabled must be boolean; attributes 0 to 2 unique candidate keys;
  createDataSegments optional boolean. Persist enabled and attributes;
  persist createDataSegments = enabled && !!createDataSegments so it can
  never be on while the boundary is off.

Checks:
- An attribute with one value for everyone is not a candidate.
- A field unique per person (avgGroupSize 1) is not a candidate.
- Two attributes with the same spread: the one more identities have a
  value for scores higher.
- Re-running after the user manually ordered [location, department]
  resets topAttributes to the suggested pair.
- setSchemaRoleBoundary({ enabled: false, attributes: [],
  createDataSegments: true }) persists createDataSegments === false.
```

---

## Prompt 3 — Mining configuration

*Reference: `client/src/lib/ported/roleShared.js` → `DEFAULT_TENANT_SETTINGS`; `client/src/lib/ported/settings.js` → `setTenantSettings`.*

```
Build a per-tenant settings record with these defaults. Every scan reads
it at start and LOCKS the values it uses onto the scan record, so a change
made while a scan runs never alters that scan's result.

  createDynamicRoles:              true
  allowDuplicateRoles:             true
  rolePrefix:                      "The "
  roleSuffix:                      " Role"
  attributeSeparator:              " - "
  nameScope:                       "attributes.cloudLifecycleState:active"
                                   (a raw ISC Search query; "" = no scope)
  entitlementCommonalityThreshold: 80      (percent, integer 1..100)
  considerCommonRoles:             true    (used by Role Evaluation)
  segmentMetadataAttribute:        "Segments"

Validation when saving: booleans must be booleans; prefix, suffix and
separator are stored EXACTLY as typed (the default separator depends on
its surrounding spaces; an explicit "" is honoured); nameScope, when
non-empty, must be a query ISC accepts and should warn when it matches 0
identities; the threshold must be a number from 1 to 100.

Also provide getRoleScanAttributeKeys():
  the stored Schema Analysis topAttributes with STATUS_KEYS removed; when
  that leaves nothing (no analysis yet) fall back to
  ["department", "location"].

Checks:
- Missing record returns every default.
- Saving { attributeSeparator: "" } then reading returns "".
- With no Schema Analysis, getRoleScanAttributeKeys() is
  ["department","location"]; with topAttributes ["jobTitle",
  "cloudLifecycleState"] it is ["jobTitle"].
```

---

## Prompt 4 — Mining profiles and boundary partitions

*Reference: `client/src/lib/ported/roleMiningShared.js` → `buildIdentityRoleProfileFromAccess`, `partitionProfilesByBoundary`, `parseSimpleScopeCriteria`.*

```
Build three pure helpers.

buildProfile(identity, attributeKeys) -> profile
  attrs = for each key in attributeKeys, the identity's attribute value or
  the literal string "Unknown" when absent. Return
    { id, name, email, managerName (manager.name or null), attrs,
      entitlements: identity.access || [], entitlementsFailed: false }.
  "Unknown" is a sentinel: a profile is never bucketed on an attribute it
  does not have a value for.

partitionProfilesByBoundary(profiles, boundaryKeys) -> [{ values, profiles }]
  Bucket profiles by the exact combination of EVERY boundary key's value
  (a boundary of [company, division] partitions by the pair). A profile
  missing any boundary value (null or "Unknown") belongs to NO partition.

parseSimpleScopeCriteria(scopeQuery) -> { attrKey, value } | null
  The Scan Scope is arbitrary Lucene, but a role's membership criteria can
  only express attribute EQUALS leaves. Translate ONLY the simple single
  equality, in any of these spellings, and return null for anything else:
    attributes.cloudLifecycleState:active
    cloudLifecycleState = active
    attributes.department:"Sales".
  Regex (case-insensitive):
    ^(?:attributes\.)?([\w.]+)\s*[:=]\s*"?([^".]+?)"?\.?$
  Normalise the key's casing only for keys you know ISC's criteria schema
  spells a particular way (at least cloudLifecycleState); leave others as
  typed.

Checks:
- parseSimpleScopeCriteria("attributes.cloudlifecyclestate:active")
  === { attrKey: "cloudLifecycleState", value: "active" }.
- parseSimpleScopeCriteria("department:Sales AND location:NYC") === null.
- A profile with company "Acme" and division "Unknown" is in no partition
  for boundary [company, division].
```

---

## Prompt 5 — Peer-group discovery (the core)

*Reference: `client/src/lib/ported/roleMiningShared.js` → `buildPeerGroups`; `client/src/lib/ported/roleShared.js` → `commonlyHeldEntitlementIds`.*

```
Build the peer-group algorithm as pure functions over the profiles from the
previous prompt.

commonlyHeldEntitlementIds(members, threshold) -> Set<entitlementId>
  Count how many members hold each entitlement id. An id is "commonly
  held" when count >= ceil(members.length * threshold). threshold is a
  fraction (0.8 for 80%). This is a threshold, NOT a strict intersection:
  an entitlement most but not all members hold still qualifies.

buildPeerGroups(profiles, attributeKeys, createDynamicRoles = true,
                commonRoleEntIds = new Set(), threshold = 0.8) -> groups[]

  1. Decide which attribute COMBINATIONS to try, in order.
     - createDynamicRoles ON: every non-empty subset of attributeKeys,
       sorted by size ascending (broadest first: one attribute, then
       pairs, then all). Within the same size, a combination equal to
       {department, location} comes before any other pair.
     - createDynamicRoles OFF: only one combination, all of attributeKeys
       together (one plain role per distinct value combination).
     Rationale: trying the broadest match first merges people who share
     one attribute but differ on the others into ONE group, which becomes
     a Dynamic role with a dimension per differing attribute, instead of
     fragmenting into many small roles.

  2. For each combination in order, bucket the profiles NOT YET ASSIGNED
     to a group by the exact values of that combination's keys. Skip a
     profile for this combination if any of those values is "Unknown".
     Every bucket becomes a group, whatever its size (a group of 1 is
     still a group) and whether or not its members share any access.
     Mark every member assigned so later, more specific combinations only
     see the leftovers.

  3. For each bucket compute its BASE access (commonSig):
     - exactly one member: that member's own entitlement ids (there are
       no peers to compute commonality from);
     - otherwise: commonlyHeldEntitlementIds over the members holding
       MORE THAN ONE entitlement, at `threshold`. Members with 0
       entitlements (not provisioned yet) and members with exactly 1 (a
       test or service account's single trivial entitlement would
       otherwise be proposed for the whole group) still COUNT AS MEMBERS
       but are left out of the commonality maths.
     Then remove every id in commonRoleEntIds: access a Common Access
     role already gives everyone is birthright, not what distinguishes
     this group.

  4. attributeCriteria = [{ key, value }] for the combination's keys, taken
     from the first member (all members share them by construction).

  5. Dimension preview. varyingKeys = attributeKeys not in the combination.
     For each varying key, the candidate values are every distinct
     non-"Unknown" value of that key among ALL profiles that match this
     group's attributeCriteria (the whole population, not only this
     bucket, so a value does not vanish just because its only holder was
     claimed by an earlier group). For each (key, value):
       subs   = this bucket's members with that value,
       shared = commonlyHeldEntitlementIds(subs with > 1 entitlement, threshold),
       entitlements = shared minus commonSig minus commonRoleEntIds,
       record { attribute: key, value, memberCount: subs.length,
                entitlements: [{ id, name }] }.
     Resolve names from whichever member actually holds each entitlement.

  6. Emit the group:
     { id: "group_<n>",
       name: "<values joined by space> Peer Group",
       attributeCriteria,
       members: [{ id, name, email, managerName, ...attrs, entitlementCount }],
       commonAccess: [{ id, name }],      // the base access
       dimensionPreview,
       roleCreated: null }

Checks (threshold 0.8, keys [department, location], dynamic ON):
- 10 people in Engineering across 3 locations: ONE group with
  attributeCriteria [department=Engineering] and up to 3 dimension
  previews, not 3 groups.
- A group of 5 where 4 hold entitlement X and 1 does not: X is in
  commonAccess (4 >= ceil(5*0.8)=4).
- A member with exactly one entitlement is counted in members and
  memberCount but does not influence commonAccess.
- A solo member's commonAccess equals their own entitlements.
- An entitlement in commonRoleEntIds never appears in commonAccess or in
  any dimension preview.
- Dynamic OFF with the same data yields one group per distinct
  (department, location) pair and no dimension previews.
```

---

## Prompt 6 — The Role Scan runner

*Reference: `client/src/lib/ported/roleScans.js` → `startRoleScan`, `runRoleScan`, `listRoleScans`, `cancelRoleScan`, `deleteRoleScan`; `client/src/lib/ported/roleCommonAccess.js` → `fetchCommonAccessRoleSummaries`; `client/src/lib/ported/scanJobs.js`.*

```
Use everything built so far. Build the scan that produces a "Role Model
Draft" record a reviewer can act on.

startRoleScan() -> { scanId }
  Create the record and lock the configuration onto it:
    { id, tenant, status: "running", startedAt, completedAt: null,
      scopeQuery: settings.nameScope || null, scanned: 0, totalIdentities: 0,
      groups: [], error: null,
      attributeKeys: getRoleScanAttributeKeys(),
      createDynamicRoles, allowDuplicateRoles,
      entitlementCommonalityThreshold,
      roleBoundaryEnabled: schemaAnalysis.roleBoundaryEnabled,
      roleBoundaryAttributes: schemaAnalysis.roleBoundaryAttributes || [],
      entitlementFetchFailures: 0 }
  Then run the scan asynchronously and return the id immediately.

runRoleScan(scanId)
  1. scopeIds = fetchScopeIds(["identities"], scan.scopeQuery). There is
     NO built-in active-only filter here: which identities qualify is
     entirely the Scan Scope's job.
  2. profileKeys = attributeKeys ∪ roleBoundaryAttributes (when the
     boundary is on). Load identities with includeAccess, page by page;
     after each page, keep those in scope, build profiles, and update the
     record's scanned / totalIdentities. Check for cancellation between
     pages; on cancel set status "cancelled" and stop.
  3. Common Access context: fetch every known Common Access role
     (confirmed list ∪ locally flagged, minus locally denied). For each,
     read the role and its dimensions, collect its entitlement ids
     (base + every dimension), its membership EQUALS leaves (INCLUDING
     lifecycle-state leaves) and enabled flag. IGNORE dimensional roles
     (a Dynamic role is never Common Access, even if ISC lists it). If
     this fetch fails after retries, continue the scan and set
     commonAccessExclusionFailed: true on the record.
  4. Build rolesByCriteriaKey: page through every existing role, extract
     its membership EQUALS leaves EXCLUDING lifecycle-state leaves, and
     key the first role found by the canonical sorted "key=value|…"
     string of those leaves. A failure here is non-fatal (the map stays
     empty and duplicate detection reports nothing this run).
  5. threshold = entitlementCommonalityThreshold / 100.
     scopeCriteria = parseSimpleScopeCriteria(scopeQuery).
  6. Partitions: when the boundary is on with attributes, partition the
     profiles by boundary; otherwise one partition { values: [],
     profiles } with no boundary leaves. Run steps 7 and 8 for EACH
     partition independently.
  7. Common Access proposal for the partition (exactly one per partition
     with at least one profile):
     - attributeCriteria = [scopeCriteria as {key,value} if parseable]
       + boundary leaves [{ key, value, isBoundary: true }]. If that is
       empty, use [{ key: "cloudLifecycleState", value: "active" }]
       (a role cannot be created with no criteria at all).
     - scopeCommonEntIds = commonlyHeldEntitlementIds(partition profiles
       with > 1 entitlement, threshold). May be empty; an empty Common
       Access role is still proposed.
     - allowDuplicateRoles OFF: look for existing Common Access roles
       whose criteria leaves are a SUBSET of this partition's scope leaves
       (every leaf the role imposes is also in the scope) and, when a
       boundary is on, that pin EVERY boundary attribute to exactly this
       partition's values. If any match: do not propose a new role; emit
       a group with existingRole = the first match, no members and no
       commonAccess; and exclude the UNION of ALL matching roles'
       entitlement ids from this partition's peer groups.
     - Otherwise (allowDuplicateRoles ON, or no match): emit a new group
       { id: "common_access_scope_<n>",
         name: applyRoleNaming(["<boundary values joined by space>",
                "Common Access"].filter(Boolean).join(" - "), prefix, suffix),
         attributeCriteria, members: all partition profiles,
         commonAccess: scopeCommonEntIds, dimensionPreview: [],
         roleCreated: null, existingRole: null, isCommonAccessScope: true }
       and exclude scopeCommonEntIds from this partition's peer groups.
     - Any error in this step is logged and the partition continues
       without a Common Access proposal.
  8. groups = buildPeerGroups(partition profiles, attributeKeys,
     createDynamicRoles, excludedIds, threshold). Renumber ids so they are
     unique across the whole scan. When boundary leaves exist, PREPEND
     them to every group's attributeCriteria and rebuild the group name
     from all criteria values. Put the Common Access group first.
  9. Duplicate detection: for every non-Common-Access group, look up the
     canonical key of its attributeCriteria in rolesByCriteriaKey and set
     existingRole = { id, name, enabled } or null. NEVER drop a matched
     group: with duplicates off, creation refuses it later, but the draft
     must still show it so "merge into existing role" is reachable.
  10. Relabel entitlements: resolve every entitlement id in commonAccess
     and dimension previews (50 per call) to its real name and source
     name, and attach { name, source }. Non-fatal on failure.
  11. Persist status "completed", completedAt, groups,
     commonAccessExclusionFailed. On any uncaught error persist status
     "failed" with a readable error.

Also provide: listRoleScans() (newest first, groups replaced by
groupCount), getRoleScan(id), cancelRoleScan(id) (only while running),
deleteRoleScan(id) (refuse while running). Reading the store first marks
any "running" record with no live runner as "failed".

Checks:
- Boundary [country] with identities in US and CA produces two Common
  Access proposals, named e.g. "The US - Common Access Role" and
  "The CA - Common Access Role", and every peer group's criteria begins
  with its country leaf.
- With no scope and no boundary, the Common Access proposal's criteria is
  exactly [cloudLifecycleState=active].
- An existing enabled role with criteria department=Sales AND
  cloudLifecycleState=active is reported as existingRole on the
  [department=Sales] group (lifecycle leaves are ignored for matching).
- Cancelling mid-scan leaves status "cancelled" and the pages read so far.
```

---

## Prompt 7 — Role naming

*Reference: `client/src/lib/roleNaming.js`.*

```
Build the naming helpers. Prefix and suffix are applied ONLY when a role is
actually created or proposed for creation, never in the scan's own display
or reports.

roleCriteriaText(group, separator = " - ")
  Common Access group: "Common Access", or "Common Access - <boundary
  values joined by separator>" when its criteria carries boundary leaves
  (so two partitions never propose the same name).
  Any other group: the criteria VALUES joined by separator, e.g.
  "Engineering - London".

applyRoleNaming(baseName, prefix, suffix)
  Add the prefix only if baseName does not already start with it, and the
  suffix only if it does not already end with it, so re-proposing a name
  never stacks a second copy.

proposedRoleName(group, prefix, suffix, separator)
  = applyRoleNaming(roleCriteriaText(group, separator), prefix, suffix)

displayRoleName(group, separator)
  = the created role's real name when roleCreated is set, otherwise
  roleCriteriaText (deliberately WITHOUT prefix/suffix).

Checks:
- applyRoleNaming("The Sales Role", "The ", " Role") === "The Sales Role".
- proposedRoleName for criteria [{department:"Engineering"},
  {location:"London"}] with defaults === "The Engineering - London Role".
```

---

## Prompt 8 — Create a Role from a peer group

*Reference: `client/src/lib/ported/roleScans.js` → `createRoleForPeerGroup`, `mergeRoleGroupIntoExisting`; `client/src/lib/ported/roleDimensions.js`; `client/src/lib/ported/metadataTagging.js` → `ensureRoleSegmentMetadata`.*

```
Use the scan record and naming helpers. Build

createRoleForPeerGroup(scanId, groupId, { name?, description?, ownerId,
                                           ownerName })

  Guards: ownerId is required. The group must exist on the scan. Read the
  CURRENT allowDuplicateRoles setting; when it is off and the group has
  existingRole, refuse with a message naming the existing role and
  pointing at "merge into the existing role". Do NOT refuse a group with
  empty commonAccess: a group whose members share nothing is still a real
  combination (its access may live in its dimensions, or the role is a
  membership-only placeholder).

  Membership criteria: the OR/AND/EQUALS shape from Prompt 0 with one
  EQUALS leaf per attributeCriteria entry, values: [value]. ALWAYS
  prepend an EQUALS leaf attribute.cloudLifecycleState = "active" unless
  the group's own criteria already contains a cloudLifecycleState leaf
  (case-insensitive key compare), so a generated role never matches a
  disabled identity.

  Dynamic or Standard:
    matchedKeys  = keys in the group's attributeCriteria
    varyingKeys  = [] for a Common Access group (always Standard);
                   otherwise, when the SCAN's locked createDynamicRoles is
                   on, scan.attributeKeys not in matchedKeys; else [].
    isDynamic    = varyingKeys.length > 0
    defaultName  = group.name with a trailing " Peer Group" replaced by
                   " Dynamic Peer Group" when isDynamic, else group.name
                   (the caller normally passes proposedRoleName instead).
    labelize(k)  = split camelCase with spaces and capitalise the first
                   letter ("jobTitle" -> "Job Title").

  Role payload (POST /v2026/roles):
    { name: name || defaultName,
      description: description || 'Auto-generated from peer group
        "<group.name>" — provisions the access common to its members.',
      owner: { type: "IDENTITY", id: ownerId, name: ownerName },
      entitlements: group.commonAccess as [{ id, type: "ENTITLEMENT", name }],
      enabled: false,            // a draft never grants access on creation
      requestable: Common Access ? false : !isDynamic,
      membership,
      ...(isDynamic ? { dimensional: true, accessRequestConfig: {
            dimensionSchema: { dimensionAttributes: varyingKeys.map(k =>
              ({ name: k, displayName: labelize(k), derived: true })) } } } : {}) }

  After creation, for a Common Access group only:
    a. Flag it via the Common Access API; record success or the error on
       the result (commonAccessFlagged, commonAccessError) but never fail
       the whole create because of it.
    b. Reconcile: run the deterministic Role Evaluation of the new role
       (its "commonly held but not granted" check) and add every
       entitlement it reports missing with a JSON Patch replace of
       /entitlements. Update group.commonAccess to the role's final
       entitlements. Then remove those added ids from the commonAccess
       and dimension previews of every sibling group in the SAME
       boundary partition that has not yet been turned into a role, so a
       later peer-group role does not carry birthright access twice.

  Dimensions (Dynamic roles only), created SEQUENTIALLY, one per entry of
  group.dimensionPreview (attribute, value, entitlements):
    POST /v2026/roles/{roleId}/dimensions
    { name: value, description: "<labelize(attribute)>: <value>",
      entitlements: [{ id, type: "ENTITLEMENT", name }], accessProfiles: [],
      membership: { type: "STANDARD", criteria: { operation: "AND",
        key: null, stringValue: "", children: [{ operation: "EQUALS",
        key: { type: "IDENTITY", property: "attribute.<attribute>",
        sourceId: null }, stringValue: value, children: null }] } } }
    Record { attribute, value, id, ok: true } or { ok: false, error } per
    dimension; one failure does not stop the others.
    (Fallback for a scan record without dimensionPreview: for each
    varying key and distinct non-"Unknown" value among the members, fetch
    each sub-member's entitlements, take the strict intersection, remove
    the base entitlements, and finally drop any entitlement that more
    than one dimension would grant since it distinguishes none of them.)

  Segment metadata (only when Schema Analysis has roleBoundaryEnabled AND
  createDataSegments): derive the role's segment value from its boundary
  criteria values joined by " - ", make sure the configured metadata
  attribute (default "Segments") and that value exist, and tag the role
  and every entitlement on it (dimensions included). Additive and
  best-effort; never fails the create.

  Finally set group.roleCreated = { id, name, createdAt, dimensional,
  dimensionAttributes: varyingKeys, dimensions } on the scan record and
  return { role, dimensions, commonAccessFlagged, commonAccessError,
  segmentMetadata }.

mergeRoleGroupIntoExisting(scanId, groupId)
  Requires group.existingRole and a non-empty group.commonAccess. Read the
  existing role, add only the entitlements it does not already have (one
  JSON Patch replace of /entitlements), record
  group.mergedIntoExisting = { roleId, roleName, mergedAt, addedCount } and
  return the count so "0 added" is reportable.

Bulk "Create All Roles": the eligible groups are those with no
roleCreated and (allowDuplicateRoles OR no existingRole), created one
after another, collecting per-group success or error.

Checks:
- A [department=Engineering] group from a [department, location] scan
  creates a dimensional role with dimensionAttributes [location] and one
  dimension per preview entry, each carrying only that preview's
  entitlements.
- A group matching both keys creates a Standard, requestable role.
- The Common Access proposal creates a Standard, non-requestable role,
  flags it, and reconciles missing entitlements.
- Every created role has enabled === false and an active-lifecycle leaf.
- With duplicates off, creating a group with existingRole is refused but
  mergeRoleGroupIntoExisting on it works.
```

---

## Prompt 9 — AI names and descriptions for the draft

*Reference: `client/src/lib/ported/aiDescriptions.js` → `generateDescriptionFromFacts`, `generateRoleScanDescriptions`; `client/src/pages/roleMining/ScanForRolesPage.jsx` → `buildGroupFacts`; `client/src/lib/roleScanCreate.js` → `summarizeGroup`.*

```
Add the optional AI review step that runs before "Create All Roles". The
model is only ever given FACTS derived from the scan; it never sees raw
identity data, and nothing is created until the reviewer confirms.

Names are NOT generated by AI. Each group's proposed name is
proposedRoleName(group, prefix, suffix, separator) from the current naming
settings.

Facts for a peer group (one line each):
  Role name: <name>
  Type: Dynamic (dimensional) | Standard         // Dynamic when any
                                                 // scan attribute is not
                                                 // in the group's criteria
  Membership: Automatically assigned to active identities where
    <key> = "<value>" and <key> = "<value>".     // or "no specific criteria"
  Base entitlements (<n>): <names joined by ", "> // or "none"
  and, for a Dynamic group:
  Dimensions (one per distinct value of <varying keys>, each adds
    entitlements on top of the base):
    - <attribute>=<value>: <names>                // or "no additional entitlements"

Facts for the Common Access group:
  Role name: <name>
  Type: Standard, flagged as ISC Common Access
  Membership: Automatically assigned to every identity in this scan's scope.
  Entitlements (<n>, held by every identity in scope): <names> // or "none"

The prompt sent to the model, verbatim (roleTypeReference is "This Dynamic
Role" or "This Static Role"; the optional length hint is appended when a
maximum length is requested):

  Write a concise (2-4 sentence) description for this SailPoint role,
  based only on the facts below — don't invent anything not stated.
  Explain what access it grants and, if there's a membership rule, who
  gets it automatically. Don't repeat the role's name in the description
  — refer to it as "<roleTypeReference>" instead. Plain prose, no
  markdown, no preamble like "Here's a description" — just the
  description text itself.[ Keep it under <N> characters in total — one
  or two sentences.]

  <facts, one per line>

Run the groups with limited concurrency; an empty response is an error.
Each group's result is { key: group.id, description } or { key, error }.
When a group's generation fails, or the reviewer skips AI entirely, fall
back to a deterministic summary:
  peer group:    "Auto-generated for identities that share the
                  <Attribute label> "<value>" and the <label> "<value>" …"
                  plus a sentence about the base entitlements and, for a
                  Dynamic group, its dimensions;
  Common Access: "Auto-generated for every identity in this scan's scope.
                  Grants <n> entitlement(s) held by all <m> identities in
                  scope — birthright access, not a peer-group role."

Show every proposal (name, description, error if any) in an editable
review list; "Create" then calls createRoleForPeerGroup for each row with
the reviewed name and description.

Checks:
- The model request contains no identity names, emails or ids.
- A Dynamic group's facts list every dimension preview entry.
- A failed generation still yields a usable fallback description and the
  row is marked with the error.
```

---

## Prompt 10 — Skeleton Roles (membership-only variant)

*Reference: `client/src/lib/ported/skeletonScans.js`.*

```
Build the lightweight variant that proposes roles from identity attributes
ALONE: no entitlement fetching, no commonality maths, no Common Access
exclusion. It is for tenants that want the role structure first and will
attach access later.

Inputs: the same settings and Schema Analysis; per-run overrides for
rolePrefix, roleSuffix, attributeSeparator and useBoundary that are never
persisted.

Plan (nothing is created in ISC during planning):
  attributeKeys = getRoleScanAttributeKeys()
  primaryKey    = attributeKeys[0]
  secondaryKey  = createDynamicRoles ? attributeKeys[1] : null
  Load identities (no access), apply the Scan Scope, build profiles with
  attributeKeys ∪ boundary attributes, partition by boundary when on.
  Per partition:
  - If the scope parses as a simple equality, plan ONE Common Access role:
    name applyRoleNaming([boundary values joined by separator, "Common
    Access"].filter(Boolean).join(" - "), prefix, suffix); membership =
    the scope leaf AND the boundary leaves (no wrapping OR when there are
    no boundary leaves: the scope leaf alone); no entitlements;
    description 'Skeleton Common Access role for scope <key> = "<value>"
    [and <boundary key> = "<value>", …] — membership only, no
    entitlements assigned yet.'
  - Bucket profiles by primaryKey value (skip missing/"Unknown"), sorted
    by value. For each value plan a role:
      name        = applyRoleNaming([...boundary values, value]
                      .join(separator), prefix, suffix)
      membership  = OR( AND( cloudLifecycleState=active,
                             <primaryKey>=<value>, …boundary leaves ) )
      dimensions  = when secondaryKey is set, every distinct
                    non-"Unknown" value of secondaryKey in the bucket,
                    sorted, with member counts; the role is Dynamic when
                    there is at least one.
      description = 'Skeleton role auto-generated for <primaryKey> =
                    "<value>"[ and …boundary] — membership and dimensions
                    only, no entitlements assigned yet.'
      entitlements = []
  Persist status "completed" with results[] (each with index, status
  "planned", roleId null) and counts planned / created / failed.

Create one planned row on demand: POST the role with enabled: false,
requestable: false, owner = the current user, entitlements [], the
planned membership, and the dimensional schema for secondaryKey when
Dynamic; flag Common Access rows; then create each dimension
sequentially with no entitlements. A failed row may be retried; an
already-created row is refused. Deleting a draft never deletes roles.

Checks:
- No entitlement or access call is made during planning.
- With keys [department, location] and Dynamic on, "Engineering" becomes
  one Dynamic role with a dimension per location present in the bucket.
- With Dynamic off, "Engineering" is a Standard role with no dimensions.
```

---

## Prompt 11 — Worked example and acceptance run

```
Create a fixture of 14 identities and run the whole pipeline against it
with mocked ISC calls. Settings: defaults, no boundary, Schema Analysis
suggesting [department, location].

  id  department   location  entitlements
  1   Engineering  London    E1 E2 E3 E5
  2   Engineering  London    E1 E2 E3
  3   Engineering  London    E1 E2 E3 E4
  4   Engineering  Berlin    E1 E2 E6
  5   Engineering  Berlin    E1 E2 E6 E7
  6   Engineering  (none)    E1 E2
  7   Sales        London    E1 E8 E9
  8   Sales        London    E1 E8 E9
  9   Sales        London    E1 E8
  10  Sales        Berlin    E1 E8 E9 E10
  11  Finance      Berlin    E1 E11
  12  Finance      Berlin    E1 E11 E12
  13  Finance      Berlin    E1 E11
  14  (none)       Berlin    E1 E13

Expected (every identity active, scope cloudLifecycleState=active):
- Common Access proposal with criteria [cloudLifecycleState=active] and
  commonAccess [E1] (every one of the 14 identities holds at least two
  entitlements, so all 14 feed the maths and E1 is held by 14/14).
- Three peer groups at the [department] level: Engineering (6 members),
  Sales (4), Finance (3). Identity 14 has "Unknown" department and no
  location to pair with it, so it falls through to the [location] level
  and becomes a Berlin group of 1 whose commonAccess is its own
  entitlements minus E1: [E13].
- Engineering base access: members with > 1 entitlement are all six;
  E2 is held by 6/6 → base [E2] (E1 removed as Common Access). E3 is
  held by 3/6 = 50% → not base. Dimension previews: London → [E3]
  (3/3), Berlin → [E6] (2/2); E5, E4, E7 are below 80% in their slices.
- Sales base access: E8 (4/4) → [E8]; E9 is 3/4 = 75% → not base.
  London dimension: E9 held by 2/3 = 67% → []. Berlin: [E9, E10]
  (solo slice, 1/1).
- Finance base: E11 (3/3) → [E11]; E12 1/3 → not base; Berlin dimension
  → [] (E12 1/3).
- Creating the Engineering group yields a Dynamic role named
  "Engineering Dynamic Peer Group" when no name is passed, or
  "The Engineering Role" via proposedRoleName, disabled, not requestable,
  with dimensions London [E3] and Berlin [E6].
- Creating the Common Access proposal yields "The Common Access Role",
  Standard, not requestable, flagged, with [E1].

Make the run reproducible as an automated test.
```

---

## Appendix A — Record shapes the UI depends on

Role scan record (store `role-scans`, one per scan):

```
{ id, tenant, status: running|completed|cancelled|failed, startedAt,
  completedAt, scopeQuery, scanned, totalIdentities, error,
  attributeKeys, createDynamicRoles, allowDuplicateRoles,
  entitlementCommonalityThreshold, roleBoundaryEnabled,
  roleBoundaryAttributes, entitlementFetchFailures,
  commonAccessExclusionFailed,
  groups: [{ id, name, attributeCriteria: [{ key, value, isBoundary? }],
             members: [{ id, name, email, managerName, <attr>…, entitlementCount }],
             commonAccess: [{ id, name, source }],
             dimensionPreview: [{ attribute, value, memberCount,
                                  entitlements: [{ id, name, source }] }],
             existingRole: { id, name, enabled } | null,
             isCommonAccessScope?: true,
             roleCreated: { id, name, createdAt, dimensional,
                            dimensionAttributes, dimensions } | null,
             mergedIntoExisting?: { roleId, roleName, mergedAt, addedCount } }] }
```

Schema analysis record (store `schema-analysis`, one per tenant): see
Prompt 2. Tenant settings (store `tenant-settings`): see Prompt 3.

## Appendix B — Design decisions worth keeping

- **Broadest combination first** is what turns "people who share a
  department but sit in different offices" into one Dynamic role with
  location dimensions instead of one role per office.
- **Threshold, not intersection** (default 80%) tolerates a few
  under-provisioned members; members with 0 or 1 entitlement are
  excluded from the maths so new hires and service accounts cannot drag
  a real entitlement below the line or push a trivial one above it.
- **Common Access first, then exclude it** keeps birthright access off
  every peer-group role. The proposal is reconciled with the deterministic
  Role Evaluation right after creation so both views agree.
- **Every group becomes a group**, including singletons and groups with no
  shared access, because the attribute combination is real even when the
  access is not yet provisioned.
- **Nothing is enabled on creation.** Every generated role is created
  disabled and must be reviewed and enabled in ISC.
- **Lifecycle leaves are excluded from duplicate matching** but always
  added to generated criteria, so an existing "Sales (active)" role
  matches a proposed "Sales" group.
- **Locked configuration per scan** makes a draft reproducible even when
  Mining Config or Schema Analysis changes while it runs.
