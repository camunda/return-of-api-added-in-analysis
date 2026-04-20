#!/usr/bin/env bash
#
# Extract and bundle OpenAPI specs from the camunda/camunda GitHub repo for versions 8.5–8.9.
# Uses sparse git clone to fetch only the spec directory for each version.
#
# Usage:
#   ./extract-specs.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_URL="https://github.com/camunda/camunda.git"
SPEC_PATH="zeebe/gateway-protocol/src/main/proto/rest-api.yaml"
SPEC_V2_DIR="zeebe/gateway-protocol/src/main/proto/v2"

VERSIONS=(8.5 8.6 8.7 8.8 8.9)

echo "=== Extracting OpenAPI specs for versions: ${VERSIONS[*]} ==="
echo ""

for v in "${VERSIONS[@]}"; do
  dest="$SCRIPT_DIR/specs/$v"
  mkdir -p "$dest"

  if [[ -f "$dest/bundled-api.yaml" ]]; then
    # Re-extract upstream files if missing (needed for source-file provenance)
    if [[ ! -d "$dest/upstream" ]]; then
      echo "  $v: bundle exists but upstream/ missing, re-extracting upstream files..."
    else
      echo "  $v: already exists ($(wc -l < "$dest/bundled-api.yaml" | tr -d ' ') lines), skipping"
      continue
    fi
  fi

  ref="stable/$v"
  clone_dir=$(mktemp -d)
  trap "rm -rf $clone_dir" EXIT

  echo "  $v: cloning $ref (sparse)..."
  git clone --depth 1 --branch "$ref" --filter=blob:none --sparse "$REPO_URL" "$clone_dir" 2>/dev/null

  # Try multi-file v2 layout first, fall back to monolithic
  if git -C "$clone_dir" sparse-checkout set "$SPEC_V2_DIR" 2>/dev/null && [[ -f "$clone_dir/$SPEC_V2_DIR/rest-api.yaml" ]]; then
    echo "    Multi-file spec (v2/), bundling..."
    npx --yes @redocly/cli@2.25.3 bundle "$clone_dir/$SPEC_V2_DIR/rest-api.yaml" -o "$dest/bundled-api.yaml" 2>&1 | grep -v "EBADENGINE\|Warning:" || true
    # Copy upstream YAML files for source-file provenance
    mkdir -p "$dest/upstream"
    cp "$clone_dir/$SPEC_V2_DIR/"*.yaml "$dest/upstream/" 2>/dev/null || true
  else
    git -C "$clone_dir" sparse-checkout set "$(dirname "$SPEC_PATH")" 2>/dev/null
    git -C "$clone_dir" checkout 2>/dev/null
    echo "    Monolithic spec, copying..."
    cp "$clone_dir/$SPEC_PATH" "$dest/bundled-api.yaml"
    # Create empty upstream/ marker so re-runs skip this version
    mkdir -p "$dest/upstream"
  fi

  rm -rf "$clone_dir"
  trap - EXIT
  echo "    $(wc -l < "$dest/bundled-api.yaml" | tr -d ' ') lines"
done

echo ""
echo "=== Done ==="
