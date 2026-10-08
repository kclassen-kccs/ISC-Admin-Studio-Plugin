#!/usr/bin/env bash
# Installs or updates the Admin Studio plugin on one ISC tenant.
#
#   ./install.sh            update: upload the build, then push the manifest
#   ./install.sh --create   first install on a tenant: register, then the same
#
# Run it from the unzipped package folder (next to sp-ui-plugin.json). It
# needs the SailPoint CLI (sail) and the tenant's API client in the
# environment; it never stores them anywhere:
#   export SAIL_BASE_URL=https://<tenant>.api.identitynow.com
#   export SAIL_CLIENT_ID=<client id>
#   export SAIL_CLIENT_SECRET=<client secret>
# The Anthropic API key is not part of the install: an admin enters it on
# Studio Settings > Preferences inside the plugin ("Save to ISC").
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
[[ -f sp-ui-plugin.json && -f client/build/index.html ]] || { echo "Run this from the unzipped package folder (sp-ui-plugin.json and client/build must be here)." >&2; exit 1; }

if ! command -v sail >/dev/null 2>&1; then
  cat >&2 <<'MSG'
The SailPoint CLI (sail) is not on PATH. Install it with
  go install github.com/sailpoint-oss/sailpoint-cli@latest
and rename the binary to sail, or download a release from
https://github.com/sailpoint-oss/sailpoint-cli/releases
MSG
  exit 1
fi
for v in SAIL_BASE_URL SAIL_CLIENT_ID SAIL_CLIENT_SECRET; do
  if [[ -z "${!v:-}" ]]; then
    echo "$v is not set. Export the tenant's API client first (see the header of this script), or run 'sail set auth'." >&2
    exit 1
  fi
done
export SAIL_EXPERIMENTAL_UI_PLUGINS=1

if [[ "${1:-}" == "--create" ]]; then
  # No --private and no allowed-user list: ISC controls who may open the
  # plugin. A private registration locks it to the deploying API client and
  # every other user gets "Forbidden" at launch.
  echo "Registering the plugin on $SAIL_BASE_URL ..."
  sail ui-plugins create
fi

echo "Uploading the build ..."
sail ui-plugins upload
echo "Pushing the manifest ..."
sail ui-plugins push-manifest

cat <<'MSG'

Done. The plugin has no navigation entry yet; open it at
  https://<tenant>.identitynow.com/ui/plugin/<instance id>
('sail ui-plugins list' shows the instance id). Then, as an admin, open
Studio Settings > Preferences in the plugin and use "Save to ISC" to put the
Anthropic API key into the tenant's "Admin Studio AI Key" parameter; that
also creates the "Admin Studio AI Connection" parameter and the "Admin
Studio AI Query" workflow (which must stay disabled).
MSG
