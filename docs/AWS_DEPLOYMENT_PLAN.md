# AWS Deployment — As-Built Record & Original Plan

**Status: DEPLOYED (2026-08-17).** Production runs on AWS at
https://adminstudio.kccs.net; Vercel + Railway
(https://adminstudio.vercel.app) is the permanent test environment. The
original plan is preserved below as design rationale; this first section is
the operational record.

## As built

| Resource | Value |
|---|---|
| Domain / TLS | `adminstudio.kccs.net` → Elastic IP `54.225.209.85`; Let's Encrypt via certbot, auto-renewed by the `certbot-renew.timer` systemd timer (HTTP 301-redirects to HTTPS) |
| EC2 | `i-09e5f2edacdc0ce10`, t4g.small (Graviton/arm64), Amazon Linux 2023, us-east-1, default VPC |
| Security group | `admin-studio-prod` — 443/80 open, 22 restricted to the admin IP |
| IAM | Role/instance profile `admin-studio-ec2` — scoped to the one DynamoDB table, the one S3 bucket, and `ssm:GetParameter` on `/admin-studio/prod/*` |
| DynamoDB | `admin-studio-prod` (on-demand; `store` PK / `key` SK; TTL on `expiresAtEpoch`; PITR enabled) |
| S3 | `admin-studio-prod-016857744033` (versioned, all public access blocked) — OAuth registry object + report PDF blobs |
| Secrets | SSM SecureStrings: `/admin-studio/prod/{DATA_ENCRYPTION_KEY, LOCAL_ADMIN_USERNAME, LOCAL_ADMIN_PASSWORD, ANTHROPIC_API_KEY}` — rendered into `server/.env` at boot by `/opt/admin-studio/load-env.sh` (root-owned, mode 600; re-run + `pm2 restart` to pick up changes) |
| Processes | nginx serves `/opt/admin-studio/client-build` and same-origin-proxies `/api/*` → Express on :3001, run by pm2 (`admin-studio`, boot-persistent) |

**Deploy procedure** (from the repo root, SSH key `~/.ssh/admin-studio-aws.pem`):

```bash
# server
rsync -az -e "ssh -i ~/.ssh/admin-studio-aws.pem" \
  --exclude node_modules --exclude data --exclude "data.*" --exclude .env --exclude build \
  server/ ec2-user@54.225.209.85:/opt/admin-studio/server/
ssh -i ~/.ssh/admin-studio-aws.pem ec2-user@54.225.209.85 \
  'cd /opt/admin-studio/server && npm install --omit=dev && pm2 restart admin-studio'

# client (build locally with no REACT_APP_API_BASE — same-origin)
cd client && npx react-scripts build && cd ..
rsync -az --delete -e "ssh -i ~/.ssh/admin-studio-aws.pem" \
  client/build/ ec2-user@54.225.209.85:/opt/admin-studio/client-build/
```

**Deviations from the plan as written:**
- `express-async-errors` was added — async route failures were hanging
  requests instead of returning 500s.
- The instance role also needed `s3:ListBucket` (without it, S3 reads of a
  missing key surface as `AccessDenied` rather than `NoSuchKey`).
- AI description generation is provider-configurable (`claudeGenerateText`
  in `server/index.js`): production uses `ANTHROPIC_API_KEY` from SSM; an
  Amazon Bedrock path (Mantle client, IAM-role auth, `AI_PROVIDER=bedrock`)
  is implemented but off — the account's Bedrock model agreement was not
  accepted.
- Tenant OAuth registration moved behind the Local Admin sign-in as part of
  the pre-exposure hardening (with a per-account lockout on local-login),
  so Phase 7's "register via the UI" now happens from the Local Admin page.
- No data was migrated (per plan) — production started empty and tenants
  were re-registered fresh.

---

# Original plan (historical)

The remainder of this document is the plan as approved before execution,
kept for design rationale. The storage redesign, hardening, and phase
structure below were implemented as described except where noted above.

Before the deployment, the app ran split across two managed platforms: the
client (`client/`, a Create React App SPA) on Vercel, and the server
(`server/`, a stateful Express proxy) on Railway with a persistent volume
at `DATA_DIR`. That Vercel/Railway pair isn't going away — it becomes the
permanent **test** environment. AWS is built as a separate, permanent
**production** environment alongside it, not a replacement.

---

## 1. What makes this app's deployment non-trivial

- **The server is stateful today, but won't be on AWS.** There's no external
  database — role scans, saved PDF reports, tenant settings, and the
  encrypted OAuth client registry (`oauth-clients.json`) are flat JSON/SQLite
  files on disk at `DATA_DIR` (see [ARCHITECTURE.md](ARCHITECTURE.md)).
  Lifted straight to AWS as-is, that means whatever hosts the server needs a
  *persistent, non-ephemeral* volume — and the running process would also
  hold everything in memory, since that's how the current storage layer
  works. Section 2 below replaces this with S3/DynamoDB and **no in-memory
  cache** — every read and write goes through to managed storage, so the
  process itself holds no state at all. That's a deliberately larger
  refactor than the minimum needed to drop the volume, chosen so the server
  is genuinely interchangeable/restart-safe and horizontally-scale-ready,
  not just off local disk.
- **The redirect URI is load-bearing.** SailPoint's OAuth client only
  redirects to an exact match. The production domain is baked into three
  places at once — `server/scripts/register-oauth-client.js`,
  `server/index.js`'s `/api/auth/register-client` route, and
  `client/src/hooks/useAuth.jsx`'s `NATIVE_WEB_REDIRECT_URI` — and is also
  registered per-tenant as a live OAuth client in each SailPoint tenant.
  **Decide the final AWS domain before registering anything** — we just
  learned firsthand (retiring the app's previous Vercel domain) that
  changing it later means re-registering every tenant's OAuth client, which
  rotates its secret and requires a redeploy to pick up.
- **Two environments run permanently, not just during cutover.** Vercel +
  Railway stay as a **test** environment (its own new-ish domain,
  unrelated to AWS); AWS is a separate **production** environment on its own
  new DNS name — no domain is being moved or retired. That changes the
  redirect-URI story above from "swap the domain" to "register both,
  permanently": the redirect URI lists in the two server-side locations, and
  the per-tenant OAuth client registered in SailPoint, need entries for
  *both* domains at the same time, indefinitely. (`NATIVE_WEB_REDIRECT_URI`
  is different — it's a single value, not a list; see Phase 7.) The
  registration script already
  supports multiple valid redirect URIs on one client (it lists `localhost`,
  the web domain, and the native custom scheme together today) — extend
  that same list rather than registering a second, separate OAuth client.
  **Correction from an earlier draft of this plan:** the script's own
  docstring claims it "deletes-and-recreates any existing client with the
  same name," but the actual code doesn't do that — it finds the existing
  client and exits with an error (code 2), printing a `curl -X DELETE`
  command and telling you to run it first. There's no update-in-place path;
  adding a redirect URI to an existing client is a genuine two-step,
  manual-delete-then-recreate operation (see Phase 7), with a real gap in
  between where sign-in is down for *both* environments, since they'd share
  the one client. A second client under a different `SP_SIGNIN_CLIENT_NAME`
  avoids that gap entirely, at the cost of two clients to keep track of
  instead of one — worth weighing against the shared-client approach this
  plan otherwise recommends for simplicity.
- **Secrets need real handling.** `DATA_ENCRYPTION_KEY` (AES-256-GCM key for
  the OAuth client registry), `SP_OAUTH_CLIENTS`, and optionally
  `ANTHROPIC_API_KEY` currently live in a local `.env`. On AWS these belong
  in Secrets Manager or SSM Parameter Store, not a checked-in or hand-copied
  file.

---

## 2. Storage redesign: encrypted S3 + DynamoDB

Rather than lift-and-shift `DATA_DIR` onto an AWS volume, split storage by
how each piece is actually used — this removes the persistent-volume
requirement from *both* architecture options below.

| Data | Today | AWS target | Why |
|---|---|---|---|
| `oauth-clients.json` (encrypted OAuth client registry) | Local file, AES-256-GCM encrypted at the app layer | **One S3 object**, versioned | Tiny (~1KB), write-rare (only on tenant registration). Already encrypted before it touches storage — S3 is just relocating encrypted bytes. S3 versioning gives a free, automatic audit trail of every registration/rotation. |
| `role-reports/*.pdf`, `saved-reports/*.pdf` | Loose files in `DATA_DIR` subdirectories | **S3 objects** | Blob storage for blobs — no argument needed. Low mutation frequency (written once, read many times). Their metadata/index (`role-reports.json`, `saved-reports.json` — which report belongs to which PDF) is a record store like any other, see the row below. |
| All 14 record stores (`role-scans.json`, `role-eval-scans.json`, `attribute-sync-scans.json`, `segment-scans.json`, `segment-role-matches.json`, `skeleton-scans.json`, `schema-analysis.json`, `tenant-settings.json`, `flagged-common-access-roles.json`, `sod-mitigations.json`, `user-preferences.json`, `studio-preferences.json`, `role-reports.json`, `saved-reports.json`) | Flat JSON, whole file rewritten on every mutation | **DynamoDB**, one table, `store` + `key` as a composite primary key | Matches the shape the code already models internally (see below) — no relational schema needed, no instance to run, scales to zero cost when idle, and gives real partial-record writes instead of rewriting a multi-MB file per change. |

### Multi-instance readiness: session & login state also has to move

Dropping the in-memory *record-store* cache (above) is necessary for running
more than one server instance, but it isn't sufficient — `server/index.js`
holds three more pieces of state in plain module-level `Map`s that are just
as invisible to a second instance:

| In-memory `Map` (server/index.js) | Holds | Breaks how, with 2+ instances |
|---|---|---|
| `sessions` (line ~367) | `sessionId → { tenant, accessToken, refreshToken, expiresAt, identity }` — every signed-in user's live session | The authorize request and every later API call could land on different instances. Whichever one didn't create the session sees it as logged out — intermittent, load-balancer-routing-dependent 401s. |
| `pendingLogins` (line ~522) | `state → { tenant, redirectUri, createdAt }` — CSRF state for an in-flight OAuth login | If the authorize-url request and the SailPoint callback land on different instances, sign-in fails outright with a state mismatch. |
| `completedNativeLogins` (line ~533) | `state → { sessionId }` — native app's post-login hand-off, polled by the iOS app | Same failure mode as `pendingLogins`, specific to the native sign-in flow. |

All three are **correctness-critical**, not caches — there's no
"just refetch it" fallback like the record stores have. They need to move
into the same DynamoDB table as additional stores (`sessions`,
`pending-logins`, `completed-native-logins`), which conveniently also
replaces the manual `reapPendingLogins()` sweep: DynamoDB's native
per-item TTL attribute can expire `pendingLogins`/`completedNativeLogins`
entries automatically (matching the existing `LOGIN_STATE_TTL_MS`), and
expire `sessions` entries against their own `expiresAt`. One caveat:
DynamoDB TTL deletion is background/best-effort (typically prompt, but AWS
only guarantees within days), so any check that *matters* — "is this login
state still valid," "has this session expired" — must still compare
timestamps at read time, exactly as the code does today. TTL replaces only
the cleanup sweep, not the expiry check.

`sessions` specifically needs one more thing beyond the plumbing above:
it holds live SailPoint `accessToken`/`refreshToken` — genuinely sensitive,
equivalent to credentials. Today those never touch disk at all (pure
in-memory, gone the moment the process restarts); moving them into
DynamoDB means they persist somewhere network-reachable for the first
time. **Encrypt the session value itself before writing it** — the same
AES-256-GCM-via-`DATA_ENCRYPTION_KEY` pattern already used for
`oauth-clients.json` — as defense in depth on top of DynamoDB's own
default encryption-at-rest, not a substitute for it. `pendingLogins` and
`completedNativeLogins` don't need this: they carry only short-lived state
(a tenant name, a redirect URI, a session ID pointer), not tokens.

One more `Map`, `serviceTokens` (tenant → cached SailPoint API token,
line ~335), is lower priority — it already has a "recompute on cache miss"
fallback in `serviceToken()`, so a second instance just means an extra token
request rather than broken behavior. Worth moving for consistency and to
avoid a burst of redundant token requests right after scaling up, but it's
a performance nicety, not a blocker like the three above.

One more minor item, not a blocker: `express-rate-limit`'s default store is
also per-process, so each instance would enforce its own request quota
independently instead of one shared global limit. That's a soft
degradation (effective quota multiplies by instance count), not broken
behavior — worth a shared store (e.g. DynamoDB-backed) only if the exact
quota ever matters more precisely than it does for an internal admin tool.

**This isn't just an infra swap — it's a code change**, and should be its own
phase done (and tested locally) before any AWS infrastructure work:

- `server/storage/jsonRecordStore.js` and `server/storage/sqliteRecordStore.js`
  already establish a `{ data, save() }` interface — the codebase's own
  comments literally call these "Phase 1" (JSON) and "Phase 2" (SQLite) of a
  storage-interface migration, with `server/storage/index.js` (the
  backend-selector) as "Phase 3." This work is **Phase 4** of that same
  progression — a fourth backend, `s3RecordStore.js` (for the OAuth client
  registry — one object, `get`/`put`, trivially async since it's only
  touched from an already-async route handler) and `dynamoRecordStore.js`
  (for everything else), wired into `server/storage/index.js` alongside the
  existing two. (This "Phase N" numbering is the codebase's own internal
  label for the storage-interface migration's history — unrelated to this
  document's Phase 0–10 rollout steps below.)
- The current interface is **synchronous** — call sites throughout
  `server/index.js` do `store.data[id] = ...; store.save();` inline, and
  reads do `store.data[id]` / `Object.values(store.data)` directly against
  the in-memory object. None of that survives the move: **no in-memory
  cache** means every read becomes a `GetItem`/`Query` and every write
  becomes a `PutItem`/`DeleteItem`, each `await`-based. This touches every
  read *and* write call site across all 14 stores plus the OAuth registry —
  a materially bigger refactor than just making `save()` async, but it's
  what makes the server truly stateless rather than stateless-until-you-
  look-at-the-process's memory.
- The DynamoDB table's primary key (`store` partition key, `key` sort key)
  is what makes this practical without falling back to full-table scans:
  "all records for `role-scans`" is a `Query` on the `store` partition —
  the same access pattern `Object.values(store.data)` provides today, just
  over the network instead of in-process. A single record lookup is a plain
  `GetItem` on `(store, key)`.
- Combined with moving `sessions`/`pendingLogins`/`completedNativeLogins`
  (above) off in-process memory too, this removes what made the app
  single-instance by necessity — with no per-process state left to go stale
  or diverge, running more than one instance behind a load balancer becomes
  safe later without a further rewrite, even though Option A starts with
  just one.

---

## 3. Two architecture options

With storage handled by S3 + DynamoDB, neither option below needs a
persistent volume or filesystem for `DATA_DIR` — that changes Option B's
calculus significantly (no EFS, no NAT Gateway forced by it).

### Option A — EC2, no data volume needed ("lightweight", recommended to start)

One small EC2 instance runs everything: nginx serves the built client and
reverse-proxies `/api/*` to a local Express process (managed by `pm2`). The
instance itself is now disposable — no data volume to carry across
replacements, since all state lives in S3/DynamoDB. Starting with one
instance is a capacity choice, not an architectural constraint: because
nothing is cached or held in process memory (Section 2), a second instance
could be added behind a load balancer later — for redundancy or capacity —
without rewriting application logic, just infrastructure (an ALB, a target
group, taking the Elastic IP off the single-instance model).

```
Internet → Route 53 → EC2 (Elastic IP)
                        ├─ nginx :443 (TLS via certbot)
                        │    ├─ / → client/build (static)
                        │    └─ /api/* → 127.0.0.1:3001
                        └─ pm2 → node server/index.js
                             ├─ S3 → oauth-clients.json, report PDFs
                             └─ DynamoDB → role scans, settings, etc.
```

**Why this first:** it's the closest match to how the app already runs
(single Node process behind nginx), needs no Docker/ECS knowledge, and is
cheap. Downsides: no auto-scaling, manual OS patching, single point of
failure — all acceptable for what is currently a small internal admin tool.

Serving the client and API from the *same* origin (nginx path-based routing)
is deliberate: it means one domain, one OAuth redirect URI, and zero CORS
configuration — simpler than the current two-origin Vercel/Railway split.

### Option B — ECS Fargate + S3/CloudFront ("cloud-native")

```
Internet → Route 53 → CloudFront → S3 (client build)
                            │
                            └→ ALB (TLS) → ECS Fargate task (server)
                                              ├─ S3 → oauth-clients.json, report PDFs
                                              └─ DynamoDB → role scans, settings, etc.
```

- Client: private S3 bucket + CloudFront (Origin Access Control), built with
  `REACT_APP_API_BASE` pointing at the ALB/API domain.
- Server: Dockerized, one Fargate task (no autoscaling needed at this
  traffic level) behind an ALB with an ACM certificate. No EFS, no mounted
  filesystem at all — the task is fully stateless at the infra level.
- Secrets: AWS Secrets Manager, injected into the task definition as
  `secrets` (not plaintext environment variables).

**Why later, maybe:** managed, no OS patching, scales if this ever needs it
— and with EFS out of the picture, most of the previous cost/complexity gap
with Option A closes. Still meaningfully more moving parts (ALB, ECS task
definitions, CI/CD to build and push images) than a single EC2 box. Worth
revisiting if usage grows or the team wants everything in containers for
consistency with other services.

**Decided: Option A.** It gets production up on AWS with the least new
surface area to learn or misconfigure. Option B stays documented above in
case the scale/ops calculus changes later — it's a notably easier sell now
that storage doesn't force EFS/NAT into it — but everything from here on
(the step-by-step plan, cost estimate) is written for Option A.

---

## 4. Step-by-step plan (Option A)

### Phase 0 — Decide before touching AWS
- Final production domain: a **new** DNS name, registered for this purpose —
  `adminstudio.vercel.app` is untouched and keeps serving the test
  environment.
- AWS account, target region (e.g. `us-east-1`), and who has access.
- Single DynamoDB table (composite `store`/`key` keys, mirroring
  `sqliteRecordStore.js`'s `kv_store` shape) vs. one table per store — the
  single-table approach is recommended as the lower-effort, closer-to-current
  option.

### Phase 1 — Storage backend migration (code, no AWS infra yet beyond a dev bucket/table)
- Build `s3RecordStore.js` and `dynamoRecordStore.js` — **a new, fully async
  interface**, not the existing `{ data, save() }` shape. That shape assumes
  a synchronous in-memory object (`store.data[id]`,
  `Object.values(store.data)`), which no longer exists per the decision
  above. Replace it with something like `get(key)`, `getAll()`, `put(key,
  value)`, `delete(key)` — each `async`, each hitting DynamoDB/S3 directly,
  no cache in between.
- Convert every one of `server/index.js`'s call sites — reads and writes,
  across all 14 stores plus the OAuth registry — to the new async
  interface. This is the bulk of the work in this phase: more than making
  `save()` async, every direct `store.data` access throughout the file
  needs to become an `await`ed call.
- Migrate the three correctness-critical in-memory `Map`s (`sessions`,
  `pendingLogins`, `completedNativeLogins`) into the same DynamoDB table as
  additional stores, using DynamoDB's per-item TTL attribute for expiry
  instead of the current manual `reapPendingLogins()` sweep. Without this,
  the record-store migration alone still leaves a second instance broken —
  see the multi-instance readiness note in Section 2. **Encrypt `sessions`
  values with `DATA_ENCRYPTION_KEY` (AES-256-GCM) before writing** — same
  reasoning as `oauth-clients.json`, since a session carries live SailPoint
  access/refresh tokens. `pendingLogins`/`completedNativeLogins` don't need
  this. Move `serviceTokens`
  too while in there, for consistency (lower priority — it degrades
  gracefully today, it doesn't break).
- Add a `STORAGE_BACKEND=s3+dynamo` (or similar) option alongside the
  existing `json`/`sqlite` values in `server/storage/index.js`.
- Test locally against a real (dev-account) S3 bucket and DynamoDB table
  before this ever touches production AWS — this de-risks every later
  phase, since the storage layer is proven independent of everything else
  before infrastructure work even starts.

### Phase 2 — Networking
- Use the account's default VPC (no need for a custom one at this scale).
- Security group: inbound `443` and `80` (for ACME HTTP-01 challenge) from
  `0.0.0.0/0`; inbound `22` restricted to an admin IP/CIDR only.
- Allocate an Elastic IP and associate it with the instance so DNS survives
  reboots/replacements.

### Phase 3 — Compute
- Launch an EC2 instance — Amazon Linux 2023 or Ubuntu 22.04 LTS (both have
  official arm64 builds), **`t4g.small`** — Graviton/arm64, chosen over the
  x86 `t3.small` equivalent to keep cost down (Graviton runs ~20% cheaper
  for the same vCPU/RAM). No native-module compatibility concerns here:
  Node.js ships official arm64 binaries, and dropping `better-sqlite3` from
  the storage layer (Section 2) removes the one dependency in this app that
  used to need architecture-matched native builds.
- Install Node.js (pin an LTS — e.g. 20.x or 22.x — rather than tracking
  whatever's newest, for stability), `nginx`, `certbot`, `pm2`.
- No data volume to size or attach — the default root volume is fine, since
  `DATA_DIR` no longer holds anything (S3/DynamoDB hold it instead).
- Attach an IAM instance role granting exactly the S3 (bucket-scoped) and
  DynamoDB (table-scoped) permissions the server needs — no broader access.

### Phase 4 — App deploy mechanics
- Pull the repo (or ship a CI-built artifact) onto the instance.
- `npm run build` in `client/`. Leave `REACT_APP_API_BASE` unset if nginx
  same-origin-proxies `/api/*` (recommended, per the CORS/OAuth note above).
- nginx serves `client/build` as static files and reverse-proxies `/api/*`
  (and any other server-owned paths) to `127.0.0.1:3001`.
- Run the server with `pm2 start index.js --name admin-studio`, then
  `pm2 startup && pm2 save` so it survives instance reboots.

### Phase 5 — Secrets & config
- Generate a fresh `DATA_ENCRYPTION_KEY` for this environment
  (`openssl rand -hex 32`) — don't reuse another environment's key. (Still
  needed even with S3 storage — this key encrypts the OAuth client registry
  *before* it's written to that S3 object.)
- Store secrets in SSM Parameter Store as `SecureString`s under a scoped
  path, e.g. `/admin-studio/prod/DATA_ENCRYPTION_KEY`,
  `/admin-studio/prod/SP_OAUTH_CLIENTS`, `/admin-studio/prod/ANTHROPIC_API_KEY`.
  Grant the instance's IAM role `ssm:GetParameter` scoped to that path only.
- A small boot-time script populates `server/.env` from those parameters
  before `pm2`/`systemd` starts the app, so no plaintext secret is ever
  committed or hand-copied over SSH.
- Simpler (less secure) fallback for a single-admin internal tool: a
  root-owned `server/.env` with `600` permissions, maintained by hand — note
  the tradeoff explicitly if this path is chosen instead.

### Phase 6 — TLS & DNS
- Point the domain's record at the instance's Elastic IP (Route 53 or
  external DNS).
- `certbot --nginx` for a free Let's Encrypt certificate; certbot's default
  systemd timer handles renewal.

### Phase 7 — OAuth client re-registration (per tenant)
- **Add** the new AWS domain to the redirect URI lists in
  `register-oauth-client.js` and `server/index.js`'s
  `/api/auth/register-client` route — keep the existing
  `adminstudio.vercel.app` entries in place, since that environment keeps
  running as test.
- `NATIVE_WEB_REDIRECT_URI` (`client/src/hooks/useAuth.jsx`) is **not a
  list** — it's a single URL, and it must match the environment the native
  build targets: the iOS app's `REACT_APP_API_BASE` decides which server
  holds the in-flight login state, and the web callback page posts the OAuth
  code to *its own* origin's server, so the two must be the same
  environment or native sign-in breaks. Decide which environment the native
  app belongs to (production/AWS is the natural choice once it exists) and
  point both `REACT_APP_API_BASE` (in `client/package.json`'s
  `build:native` script and `client/.env.native`) and
  `NATIVE_WEB_REDIRECT_URI` at it together.
- Per tenant, this is a **manual delete-then-recreate**, not a one-command
  update (see the correction in Section 1 — the script errors out rather
  than replacing an existing client):
  1. Run `node scripts/register-oauth-client.js <tenant> <admin-id> <admin-secret>`.
     It will find the existing client and exit with an error printing a
     `curl -X DELETE .../beta/oauth-clients/<id>` command.
  2. Run that printed `curl` command (needs a fresh admin token — the
     script's own token isn't reusable after it exits) to actually delete
     the client.
  3. Re-run the registration script — this time it creates the client fresh,
     now with both domains in its redirect URI list, and prints a new
     secret.
  4. Sign-in is down for **both** environments between steps 2 and 3, since
     they share this one client — do this during a low-traffic window.
- The new secret from step 3 applies to both environments (it's the same
  client), so feed it into both Phase 5's AWS secret store *and*
  Vercel/Railway's existing `SP_OAUTH_CLIENTS` config — the test
  environment needs its secret updated too, or its sign-in breaks.
- If the client and API end up on different origins after all, update
  `ALLOWED_ORIGINS` (CORS) in `server/index.js` to include the new AWS
  domain — avoidable entirely with the same-origin nginx setup above.

### Phase 8 — Data
- **Not needed.** AWS production starts with empty S3/DynamoDB storage — no
  migration from Railway. Test and production are independent environments
  from day one, not a copy of one another.

### Phase 9 — Go live
- Validate sign-in end-to-end per tenant on the new AWS domain.
- No DNS-move or rollback plan required here — `adminstudio.vercel.app`
  isn't being touched, so there's nothing to revert if something's wrong on
  AWS beyond fixing it there. Test and production simply run side by side
  from here on.

### Phase 10 — Ongoing ops
- Log rotation / `pm2 logs` or forward to CloudWatch Logs via the CloudWatch
  agent.
- Enable DynamoDB point-in-time recovery (PITR) and S3 versioning + a
  lifecycle rule to expire old versions after a reasonable window — this
  replaces the EBS-snapshot backup story from the volume-based design, and
  arguably improves on it: PITR gives per-write recovery granularity instead
  of periodic whole-volume snapshots.
- OS and Node patch cadence for the EC2 instance itself.

---

## 5. Cost ballpark

**Option A** (EC2, no data volume, + S3 + DynamoDB): roughly **$14–18/month**
- `t4g.small` on-demand: ~$12–13/mo
- Root EBS volume (OS + app code only, ~8–10GB gp3): ~$0.80/mo
- Elastic IP: free while attached to a running instance
- Route 53 hosted zone: ~$0.50/mo + negligible query volume
- S3 (report PDFs + OAuth registry object): a few cents/mo at current sizes
- DynamoDB (on-demand pricing): with no in-memory cache, every read hits the
  table directly instead of a one-time bulk load at startup, so request
  volume scales with actual app usage rather than server restarts — still
  likely **within the AWS free tier** for a handful of internal admins,
  otherwise a few dollars/mo at most
- Data transfer: negligible at this traffic level

**Option B** (Fargate + ALB + CloudFront + S3 + DynamoDB): roughly
**$30–35/month** (or **$60–70/month** if a NAT Gateway is added — see below)
- Fargate (0.25 vCPU / 0.5GB, always-on): ~$9–10/mo
- ALB: ~$16–20/mo base + LCU usage
- S3 + CloudFront: a few dollars at this scale
- DynamoDB: same as above, likely within the free tier
- NAT Gateway: ~$32/mo + data — **no longer needed for storage access** now
  that EFS is out of the picture; only relevant if the Fargate task is
  placed in a private subnet for other reasons. Giving the task a public IP
  in a public subnet avoids this entirely and is a reasonable tradeoff for
  an internal tool with no inbound exposure beyond the ALB.

Removing EFS (and the NAT Gateway it used to require) is the single biggest
change to Option B's cost — it goes from roughly double Option A's cost to
being much closer to it.

---

## 6. Decided vs. still open

**Decided:**
- Architecture: **Option A** (EC2, no data volume).
- Instance type: **`t4g.small`** (Graviton/arm64), to keep cost down.
- Environments: Vercel/Railway stays permanently as **test**; AWS is a
  separate, permanent **production** environment on a **new DNS name** —
  nothing is being moved or retired.
- Data: **no migration** — AWS production starts empty.
- Storage: **no in-memory cache** — every read/write goes through
  DynamoDB/S3 directly. Required so a second instance can be added later
  purely as an infra change, with zero application-logic rewrite. This also
  means `sessions`, `pendingLogins`, and `completedNativeLogins` — not just
  the 14 JSON record stores — move off in-process memory (Section 2).

**Still open:**
- Target AWS region, and does an account/IAM setup already exist to build
  this in?
- Single DynamoDB table vs. one per store (Phase 0) — single-table is the
  default recommendation above.
- One shared OAuth client covering both environments vs. a separate client
  per environment via `SP_SIGNIN_CLIENT_NAME` (Section 1 correction / Phase
  7): shared is simpler to manage but its re-registration takes both
  environments' sign-in down together; separate clients avoid that outage
  and decouple the environments' secrets, at the cost of two registrations
  per tenant. Related: which environment the **native iOS app** pairs with
  (Phase 7) — it can only target one.
- Whether Phase 1's storage backend migration is worth doing as standalone
  work (testable locally, no AWS dependency beyond a dev bucket/table) ahead
  of committing to a full infra timeline.
