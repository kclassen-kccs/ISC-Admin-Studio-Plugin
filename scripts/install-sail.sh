#!/usr/bin/env bash
# Installs the SailPoint CLI (`sail`) from source via the Go module proxy, for
# environments where GitHub release downloads are blocked.
set -euo pipefail
go install github.com/sailpoint-oss/sailpoint-cli@latest
BIN="$(go env GOPATH)/bin"
ln -sf "$BIN/sailpoint-cli" "$BIN/sail"
echo "Installed: $BIN/sail ($("$BIN/sail" --version))"
echo "Add to PATH:  export PATH=$BIN:\$PATH"
