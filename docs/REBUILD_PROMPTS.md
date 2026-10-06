# Rebuilding Admin Studio: a prompt sequence

Derived from the app as it stands — 37 pages, 18 shared components, 139 server
routes, ~183 client API functions, ~34k lines. Each numbered item is a prompt
you could actually type; the order matters, because later ones depend on
decisions made earlier.

The prompts that carry the most weight are not the feature descriptions. They
are in **Phase 0**, where the ISC constraints get stated up front. Every one of
those was discovered by a failed live call, and a rebuild that does not know
them will produce code that looks correct and fails in ways whose error messages
point somewhere else entirely.

---

## Phase 0 — Constraints to state before any code

State these as facts in the first prompt. They are cheap to assert and expensive
to rediscover.

1. **"The ISC API base is `https://<tenant>.api.identitynow-demo.com` for demo
   tenants and `.identitynow.com` for production. Never derive one from a short
   tenant name alone — a demo tenant fails DNS resolution, and the error looks
   nothing like a configuration problem."**

2. **"The hosted login page is at the tenant host without `.api.` —
   `https://<tenant>.identitynow-demo.com/oauth/authorize`. It 302s to whatever
   login host that stack actually uses, so never hardcode `login.sailpoint.com`."**

3. **"ISC PATCH endpoints are JSON Patch (RFC 6902) and require
   `Content-Type: application/json-patch+json`. Plain `application/json` returns
   400 with a message that does not mention content type."**

4. **"Send `X-SailPoint-Experimental: true` on every request. SailPoint's v2025
   spec marks ~230 paths as preview endpoints requiring it; without it they
   return a bare 400. The header is inert on every other endpoint."**

5. **"`segments` is not a queryable filter on roles, entitlements or access
   profiles, and is absent from the search index. Anything 'by segment' must be
   filtered client-side after fetching, or derived."**

6. **"Search queries tokenise on hyphens. `attributes.location:BE-Brussels`
   silently returns zero rows. Match on raw attribute values instead."**

7. **"OAuth clients are tenant-scoped. A client registered in one tenant cannot
   authenticate against another, and a client secret is returned once at
   creation and never again — so 're-register' means delete and recreate."**

---

## Phase 1 — Scaffold and the proxy

8. "Create a monorepo: `server/` (Express, ESM) and `client/`
   (Create React App, Tailwind, React Router, TanStack Query, lucide-react
   icons, react-hot-toast). Root `package.json` runs both with one command.
   Note that the root package has no `start` script, so deploys run from
   `server/`."

9. "In `server/`, build a generic authenticated proxy to the ISC REST API:
   `/api/isc/*` forwards method, path, query and body upstream, injecting the
   bearer token and the headers from Phase 0. Add retry-with-backoff for 429 and
   5xx, and a helper that paginates a list endpoint to exhaustion."

10. "Add sign-in via ISC's authorization-code flow. The user logs in on
    SailPoint's own hosted page; this app never sees a password. Store the
    session server-side and hand the browser an opaque session token."

11. "Support multiple tenants: an encrypted registry keyed by tenant holding
    each tenant's OAuth client id and secret. AES-256-GCM, key from the
    environment and deliberately not beside the data. Include a setup route
    that creates the sign-in OAuth client in a tenant via the API and stores it."

---

## Phase 2 — Browse (read-only)

12. "Build a mobile-first shell: bottom nav, a `TopBar` with back navigation,
    and shared UI primitives — `ListRow`, `SectionLabel`, `InfoRow`,
    `SearchBar`, `FilterBar`, `EmptyState`, `SkeletonList`, `ErrorBox`,
    `Spinner`, `IconButton`, `ConfirmModal`, `PrimaryButton`."

13. "Add list screens for Roles, Access Profiles, Applications, Sources,
    Identities and Data Segments. Each has debounced search, filters, infinite
    or paged loading, and URL-synced state so a screen survives a refresh."

14. "Add detail screens for each object type. Role Detail is the core screen:
    entitlements, access profiles, membership criteria rendered as plain
    English, dimensions for dynamic roles, and members."

15. "Add Approvals, Requests and Tasks screens backed by ISC's access-request
    and task-status APIs."

---

## Phase 3 — Selection and mutations

16. "Add multi-select to every list screen, with a `SelectionActionBar` that
    appears once something is selected. **Every action in that bar must operate
    only on the selection** — never on the loaded list."

17. "Add bulk actions per screen: enable/disable, change owner, make
    requestable, delete. Show per-item progress, and report partial failure
    honestly rather than a blanket success toast."

18. "Add role editing: rename, edit description, add and remove entitlements,
    manage dimensions of a dynamic role, and edit membership criteria."

19. "Add certification: create one ROLE_COMPOSITION campaign per role owner
    across the selected roles. ISC takes a single reviewer per campaign, so
    roles sharing an owner bundle into one campaign — say so in the UI, because
    five selected roles producing two campaigns otherwise looks like a bug."

20. "Add common-access flagging via `POST /common-access/v1` with
    `{access: {id, type: 'ROLE'}}`. It only succeeds when no record exists —
    409 otherwise, and there is no API to update an existing one. Flagging also
    triggers a tenant-wide analysis job, so the side effect is wider than the
    selection."

---

## Phase 4 — Role mining and evaluation

21. "Add Scan for Roles: partition identities by a chosen attribute boundary,
    find entitlements commonly held within each partition, and propose roles.
    Exclude entitlements already granted by a confirmed common-access role whose
    own membership is a superset of the proposed role's."

22. "Add Role Evaluation: for a role, flag entitlements redundant with a
    common-access role, entitlements held by only a fraction of members, and
    other roles whose membership criteria overlap."

23. "Add Skeleton Roles: generate empty roles from an attribute boundary with a
    configurable name pattern, for filling in later."

24. "Add Segment mining: propose data segments from attribute clusters, and a
    Segment-to-Role match screen that assigns matching roles and entitlements."

25. "Add AI-generated role descriptions with a bulk review sheet — proposals are
    shown beside the current description and never written without confirmation."

---

## Phase 5 — Reports

26. "Add PDF export built from generated HTML opened in a print window, with a
    download fallback when pop-ups are blocked. Cover list and detail variants
    for roles, access profiles, applications, sources and segments."

27. "Add two print entry points per list screen: a header menu that prints the
    whole filtered list, and a selection-bar action that prints only what is
    selected. Detail reports need their rows enriched first — share that
    enrichment between the two so they cannot drift."

28. "Add emailed reports: group selected roles by owner, generate a PDF per
    owner, and send each owner a link that expires."

---

## Phase 6 — Backup and restore

29. "Add backup: export tenant configuration via ISC's sp-config export, poll
    until complete, and store the artifact."

30. "Add restore, including an offline-source path that reconstructs a source
    and its accounts from a backup when the original is gone."

---

## Phase 7 — Settings and polish

31. "Add Studio Settings: mining configuration, evaluation configuration,
    schema analysis of identity attributes, and user preferences."

32. "Add an error boundary, a profile screen showing the signed-in ISC identity,
    and a home screen with tenant-level metrics."

33. "Add a native iOS build via Capacitor, with a custom URL scheme
    (`com.example.app://auth/callback`) registered as an additional redirect URI
    on the ISC OAuth client."

---

## Phase 8 — Deployment

34. "Deploy the server to Railway from the `server/` directory, with a mounted
    volume for the credential registry — the container filesystem is otherwise
    ephemeral and every stored tenant is lost on redeploy."

35. "Deploy the client to Vercel. Every hostname it is served on must be
    registered as a redirect URI on the ISC OAuth client, or sign-in fails there
    with a redirect_uri mismatch."

---

## What this list cannot capture

The prompts above describe *what* to build. Roughly a third of the real effort
went into things no prompt would have anticipated:

- ISC returning 400 where the cause was a missing header, a wrong content type,
  or a scope the token silently lacked.
- Endpoints existing at one API version and not another — entitlements only
  under `beta`, role dimensions only under `v2025`.
- `strong_auth: false` on browser-login tokens, which refuses endpoints an
  org admin plainly has rights to.
- Campaign, segment and common-access APIs that are create-only, with no update
  path and no way to read back what you wrote.

Budget for discovery against a live tenant. The prompts get you the shape; the
tenant tells you what is actually true.
