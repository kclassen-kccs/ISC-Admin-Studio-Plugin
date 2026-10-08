# Admin Studio Plugin

Admin Studio as a **SailPoint Identity Security Cloud (ISC) UI plugin**: an
administration and role-engineering workbench that runs inside ISC itself. It
browses and edits identities, roles, access profiles, entitlements,
applications, sources, workflows, forms, transforms and metadata, and
provides role mining, role evaluation, Common Access and
Separation-of-Duties (SOD) exception handling.

The plugin is a static React bundle. ISC loads it into a sandboxed iframe,
and the App Shell signs the user in and issues a plugin-scoped access token.
There is no separate server and no separate sign-in.

```
ISC App Shell ──postMessage──▶ Admin Studio (React, sandboxed iframe)
      │ scoped token                      │
      └───────────────────────────────────┴──▶ ISC REST APIs (tenant API, as the signed-in user)
```

## How it works

- **Authentication.** `@sailpoint/ui-plugin-sdk` runs a handshake with the
  App Shell. `client/src/lib/pluginSdk.js` owns the single SDK instance and
  supplies the tenant API base URL and a fresh token. `client/src/hooks/useAuth.jsx`
  turns the handshake context into the app's `session`.
- **API calls.** A global axios request interceptor in
  `client/src/lib/sailpoint.js` sends any `/api/isc/<version>/<path>` request
  directly to the tenant API with the scoped bearer token. The token is
  limited to the `apiScopes` in `sp-ui-plugin.json` and never exceeds the
  signed-in user's own rights.
- **Former server logic** now runs in the browser. Route logic from the old
  Express server lives in `client/src/lib/ported/`, built on the shared
  helpers in `client/src/lib/isc.js` (retry, paging, search, error shaping).
- **Persistence.** `client/src/lib/store.js` is an IndexedDB record store
  (`get` / `all` / `put` / `delete`), namespaced by tenant. Data lives in the
  plugin iframe's own browser storage, so it is per browser and per user.
- **Routing.** `HashRouter`, with the current route mirrored into the ISC page
  URL through the SDK's `setRoute`.
- **Security boundary.** The iframe cannot read ISC's cookies or DOM, and its
  CSP allows no outside origins. Anything that needs a server (see below) is
  not possible inside the plugin.

## Status of the port

| Area | State |
|---|---|
| Identities, roles (incl. dimensions, members, entitlements, propagation), sources (schemas, accounts, aggregation, identity profiles, apps, datasets, resources), connector customizers, Common Access flags, SOD mitigations, role evaluation | Ported to the client |
| Remaining generic ISC pages (entitlements, access profiles, applications, workflows, forms, transforms, launchers, campaigns, etc.) | Work through `/api/isc` where they already did; routes with dedicated server logic still being ported |
| Role mining scans, skeleton scans, attribute sync, data segments, schema analysis, tenant settings, preferences, reports, backup and restore, parameters | Not yet ported. Calls return a "not yet available in the plugin" error (HTTP 501) |
| AI-generated descriptions and workflow AI | Removed. The plugin CSP allows no outside calls |
| LDAP lookups | Removed |
| Capacitor / iOS app | Removed |

`server/` still holds the old Express code as reference for the remaining
port and will be deleted when the port is finished.

## Prerequisites

- **Node.js 22** and npm. The client is Create React App
  (`react-scripts` 5), which is unreliable on very new Node majors.
- The **SailPoint CLI** (`sail`), authenticated to your tenant. See the
  [SailPoint CLI documentation](https://developer.sailpoint.com/docs/tools/cli).
  In CI, use `SAIL_BASE_URL`, `SAIL_CLIENT_ID` and `SAIL_CLIENT_SECRET`.
- A tenant with UI plugins enabled and the `idn:ui-plugins-author` license.
- Admin rights `idn:plugins-ui:*` (create, read, update, delete).
- Access to the public npm registry for `@sailpoint/ui-plugin-sdk`.
- During early access, enable the command group in each shell:

  ```bash
  export SAIL_EXPERIMENTAL_UI_PLUGINS=1
  ```

## Develop

```bash
npm run install:all                 # root and client dependencies
sail ui-plugins create --private    # register the plugin; visible only to you
sail ui-plugins link                # bind your dev server; prints the developer URL
npm start                           # HTTPS dev server on port 3000
```

Open the URL `link` prints (`…/ui/plugin/<plugin-id>?spPluginDev=admin-studio`).
ISC loads your local code in the real tenant with a **Local Dev** badge, a real
handshake and a real scoped token. Opening the bundle outside ISC cannot
complete the handshake and shows a connection error instead.

Your dev server must send the plugin-document CSP and Permissions-Policy
headers that `create` and `link` return. Follow the generated plugin guide to
copy them into `client/package.json` scripts or a dev-server proxy setup. Accept
the self-signed certificate on first load. Run `sail ui-plugins unlink` when
finished.

## Build and deploy

```bash
npm run build       # builds client/ to client/build with relative asset paths
npm run deploy      # build, then sail ui-plugins upload
sail ui-plugins push-manifest   # push sp-ui-plugin.json changes only
```

Bundles are served from a nested CDN path, so `client/package.json` sets
`"homepage": "."`. Do not change it to a root-absolute path.

The plugin is reachable at its own URL
(`https://<tenant>.identitynow.com/ui/plugin/<plugin-id>`) until navbar
customization is available in ISC.

### Distributable package

[`dist/`](dist/) holds the deployable plugin for tenants that don't build from
source: `admin-studio-plugin.zip` (manifest, built app, `install.sh`,
`install.ps1` for Windows, `INSTALL.md`, `BUILD.txt`), with the install
scripts and notes alongside.
`npm run dist` rebuilds it (`-- --no-build` to package the current
`client/build`); it is rebuilt with every plugin change, so `dist/` always
matches the source. See [`dist/INSTALL.md`](dist/INSTALL.md).

## Manifest

[`sp-ui-plugin.json`](sp-ui-plugin.json) is the contract with ISC. The
`manifest` section is sent to the tenant; `build` is local only.

- `alias` — `admin-studio`, the tenant-unique key the CLI resolves.
- `apiScopes` — currently `["sp:scopes:all"]`. Narrow this to the scopes the
  plugin actually needs before wider release. A call outside the declared
  scopes fails locally exactly as in production.
- `slots` — one `full-page` slot.
- `build.outDir` — `./client/build`, `build.port` — `3000`.

Validate it offline with `npm run validate`.

## npm scripts

| Script | What it does |
|---|---|
| `npm run install:all` | Installs root and client dependencies |
| `npm start` | HTTPS dev server for use with `sail ui-plugins link` |
| `npm run build` | Production build into `client/build` |
| `npm run deploy` | Build, then `sail ui-plugins upload` |
| `npm run dist` | Build, then package `dist/admin-studio-plugin.zip` with the install script |
| `npm run validate` | Offline manifest check |
| `npm run version:bump` | Bumps the version across package manifests |

## Project structure

```
sp-ui-plugin.json        Plugin manifest and local build settings
client/
  public/index.html      HTML shell
  src/
    App.jsx              Routes, providers, App Shell route reporting
    hooks/useAuth.jsx    Session built from the plugin handshake
    lib/
      pluginSdk.js       SDK singleton, API base URL and token
      sailpoint.js       All API functions and the axios interceptor
      isc.js             Shared helpers for ported server logic
      store.js           IndexedDB record store
      ported/            Route logic moved from the old Express server
    pages/ components/   Screens and UI primitives
server/                  Old Express server, kept only as port reference
docs/                    Earlier documentation for the standalone app
```

## Documentation

The files in [docs/](docs/) describe the earlier standalone web/iOS app
(Express proxy, OAuth sign-in, AWS deployment). They remain useful for what
each screen does ([USER_GUIDE.md](docs/USER_GUIDE.md),
[FEATURE_LIST.md](docs/FEATURE_LIST.md), [GLOSSARY.md](docs/GLOSSARY.md)), but
the architecture, auth and deployment sections no longer apply.

## License

See [LICENSE.txt](LICENSE.txt).
