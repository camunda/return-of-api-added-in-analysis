#!/usr/bin/env bash
#
# Extract and bundle OpenAPI specs from the camunda/camunda repo for versions 8.5–8.9.
#
# If specs already exist in a sibling camunda-go-client/spec/ directory, symlinks
# them instead of re-extracting.
#
# Usage:
#   ./extract-specs.sh [<path-to-camunda-repo>]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GO_CLIENT_SPECS="/Users/amanyadav/camunda-go-client/spec"
CAMUNDA_REPO="${1:-/Users/amanyadav/camunda/camunda}"
SPEC_PATH="zeebe/gateway-protocol/src/main/proto/rest-api.yaml"
SPEC_V2_DIR="zeebe/gateway-protocol/src/main/proto/v2"

VERSIONS=(8.5 8.6 8.7 8.8 8.9)

echo "=== Extracting OpenAPI specs for versions: ${VERSIONS[*]} ==="
echo ""

for v in "${VERSIONS[@]}"; do
  dest="$SCRIPT_DIR/specs/$v"
  mkdir -p "$dest"

  # Prefer pre-extracted specs from camunda-go-client
  if [[ -f "$GO_CLIENT_SPECS/$v/bundled-api.yaml" ]]; then
    cp "$GO_CLIENT_SPECS/$v/bundled-api.yaml" "$dest/bundled-api.yaml"
    echo "  $v: copied from camunda-go-client ($(wc -l < "$dest/bundled-api.yaml" | tr -d ' ') lines)"
    continue
  fi

  # Fall back to extraction from git
  ref="origin/stable/$v"

  # Detect spec layout
  if git -C "$CAMUNDA_REPO" ls-tree --name-only "$ref" "${SPEC_V2_DIR}/" 2>/dev/null | grep -q .; then
    echo "  $v: Multi-file spec (v2/), extracting and bundling..."
    TMPDIR=$(mktemp -d)
    trap "rm -rf $TMPDIR" EXIT
    git -C "$CAMUNDA_REPO" ls-tree --name-only "$ref" "${SPEC_V2_DIR}/" | while read -r filepath; do
      filename=$(basename "$filepath")
      git -C "$CAMUNDA_REPO" show "${ref}:${filepath}" > "${TMPDIR}/${filename}"
    done
    npx --yes @redocly/cli@2.25.3 bundle "${TMPDIR}/rest-api.yaml" -o "$dest/bundled-api.yaml" 2>&1 | grep -v "EBADENGINE\|Warning:" || true
    echo "    $(wc -l < "$dest/bundled-api.yaml" | tr -d ' ') lines"
  else
    echo "  $v: Monolithic spec, extracting..."
    git -C "$CAMUNDA_REPO" show "${ref}:${SPEC_PATH}" > "$dest/bundled-api.yaml"
    echo "    $(wc -l < "$dest/bundled-api.yaml" | tr -d ' ') lines"
  fi
done

echo ""
echo "=== Done ==="
