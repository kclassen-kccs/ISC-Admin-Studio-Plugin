# Admin Studio – ISC UI plugin: install

The package (`admin-studio-plugin.zip`) holds the plugin manifest
(`sp-ui-plugin.json`), the built app (`client/build/`), this file and
`install.sh`. It contains no source, credentials or API keys. `BUILD.txt`
says which version and commit it was packaged from.

## Prerequisites

- A SailPoint Identity Security Cloud tenant with UI plugins enabled, and an
  API client (client ID and secret) with admin rights on it.
- The SailPoint CLI (`sail`): `go install github.com/sailpoint-oss/sailpoint-cli@latest`
  and rename the binary to `sail`, or a release binary from
  https://github.com/sailpoint-oss/sailpoint-cli/releases.

## Install or update

1. Unzip the package and `cd admin-studio-plugin`.
2. Point the CLI at the tenant (never put these values in the package):
   ```
   export SAIL_BASE_URL=https://<tenant>.api.identitynow.com
   export SAIL_CLIENT_ID=<client id>
   export SAIL_CLIENT_SECRET=<client secret>
   ```
3. First install on a tenant: `./install.sh --create`
   Update of an installed plugin: `./install.sh`

   The script registers the plugin only with `--create`, then uploads the
   build and pushes the manifest. Without the script, the same is
   `sail ui-plugins create` (first time only), `sail ui-plugins upload`,
   `sail ui-plugins push-manifest`, with `SAIL_EXPERIMENTAL_UI_PLUGINS=1`.
4. Open `https://<tenant>.identitynow.com/ui/plugin/<instance id>`
   (`sail ui-plugins list` shows the id). There is no navigation entry yet,
   so bookmark the URL. Reload the page after an update.

Do not register the plugin as private or with an allowed-user list: ISC
decides who may open it, and a private registration gives every user but the
deploying API client "Forbidden" at launch.

## AI setup (once per tenant, inside the plugin)

As an admin, open Studio Settings → Preferences and use **Save to ISC** under
Anthropic API Key. The plugin stores the key only in the tenant's
"Admin Studio AI Key" parameter (encrypted on the way) and creates the
"Admin Studio AI Connection" parameter and the "Admin Studio AI Query"
workflow when they are missing. The workflow must stay disabled: the plugin
runs it as a test execution with the signed-in user's session. Replacing the
key later updates the parameter and checks the rest is still in place. The
plugin keeps no copy of the key.

## Not included

- Requests, Approvals and Tasks are not part of this plugin.
- The LDAP tools and parameter connection tests need calls the plugin
  cannot make and say so on screen.
- The "Direct from this browser" AI route is blocked by ISC's plugin policy
  today; the ISC workflow route above is the one that works.
