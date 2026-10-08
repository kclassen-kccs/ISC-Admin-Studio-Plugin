#!/usr/bin/env bash
# Rebuilds dist/: the deployable plugin package plus its install script.
#
#   npm run dist            builds client/ first, then packages
#   npm run dist -- --no-build   packages whatever is in client/build
#
# Produces dist/admin-studio-plugin.zip, whose top folder admin-studio-plugin/
# holds sp-ui-plugin.json (the manifest), client/build/ (the built app),
# install.sh, install.ps1 and INSTALL.md, and dist/BUILD.txt saying what was
# packaged. dist/install.sh, dist/install.ps1 and dist/INSTALL.md are the
# maintained originals; the zip carries copies. Nothing here reads or writes credentials or API keys.
# Run it before every push that changes the plugin, so dist/ stays current.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" != "--no-build" ]]; then
  (cd client && CI=false npm run build)
fi
[[ -f client/build/index.html ]] || { echo "client/build is missing; run npm run build" >&2; exit 1; }

VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NAME="admin-studio-plugin"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/$NAME/client"
cp sp-ui-plugin.json "$STAGE/$NAME/"
cp -R client/build "$STAGE/$NAME/client/build"
cp dist/install.sh dist/install.ps1 dist/INSTALL.md "$STAGE/$NAME/"
chmod +x "$STAGE/$NAME/install.sh"
printf 'Admin Studio ISC UI plugin %s\nPackaged %s from commit %s (the commit before the one that carries this file)\nContents: sp-ui-plugin.json, client/build/, install.sh, install.ps1, INSTALL.md\nNo source, credentials or API keys are included.\n' \
  "$VERSION" "$DATE" "$COMMIT" > "$STAGE/$NAME/BUILD.txt"

rm -f dist/*.zip
(cd "$STAGE" && zip -qr -X "$ROOT/dist/$NAME.zip" "$NAME")
cp "$STAGE/$NAME/BUILD.txt" dist/BUILD.txt
echo "dist/$NAME.zip: version $VERSION, $(du -h "dist/$NAME.zip" | cut -f1)"
