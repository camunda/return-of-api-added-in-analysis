# api-added-in-analysis-2

Tracks when each Camunda 8 REST API operation and property was first introduced, by parsing OpenAPI specs across versions 8.5–8.9.

Produces `output/version-map.json` (or `output/bundler-version-map.json`) — a map of every operation and request/response property to the version it first appeared.

## Usage

### Via camunda-schema-bundler (recommended)

Fetches and bundles specs directly from the Camunda GitHub repo — no local specs needed.

```bash
npm install
npm run build:bundler
```

### Via pre-extracted specs

Requires bundled YAML specs in `specs/{8.5,8.6,8.7,8.8,8.9}/bundled-api.yaml`.

```bash
npm install
npm run all          # extract-specs + build
```

## Prerequisites

- Node.js 18+
- [camunda-schema-bundler](../camunda-schema-bundler) built locally (for `build:bundler`)

## Output Format

`output/version-map.json` / `output/bundler-version-map.json`:

```json
{
  "operations": {
    "GET /topology": { "version": "8.5", "summary": "Get cluster topology." },
    "POST /jobs/activation": { "version": "8.6", "summary": "Activate jobs" }
  },
  "properties": {
    "POST /process-instances > request > variables": {
      "version": "8.6", "type": "object", "location": "request",
      "endpoint": "POST /process-instances", "property": "variables", "depth": 0
    }
  },
  "deletedOperations": {
    "POST /document/{documentId}/links": {
      "removedIn": "8.7", "summary": "Create document link (alpha)"
    }
  }
}
```

## How It Works

1. **build-bundler-version-map.mjs** — Uses `camunda-schema-bundler` to fetch + bundle each version's spec from GitHub, then extracts operations and properties.
2. **build-version-map.mjs** — Parses pre-extracted YAML specs from `specs/`, same analysis logic.

Both produce identical output (185 operations, 2,262 properties, 2 deleted operations).
