# api-added-in-analysis-2

Tracks when each Camunda 8 REST API operation and property was first introduced, by parsing OpenAPI specs across versions 8.5–8.9.

First install deps:
```bash
npm install
```

## Flow 1: camunda-schema-bundler (recommended)

Fetches and bundles specs from GitHub via `camunda-schema-bundler`. No local repo needed.

```bash
npm run build:bundler   # → bundler-specs/ → output/bundler-version-map.json
```

Uses the `camunda-schema-bundler` npm package (installed via `npm install`).

## Flow 2: extract-specs

Sparse-clones each version's spec from GitHub, bundles with Redocly.

```bash
npm run all            # extract-specs.sh → specs/ → output/version-map.json
```

## Prerequisites

- Node.js 18+

## Output

Both flows produce identical output (185 operations, 2,262 properties, 2 deleted operations).

```json
{
  "operations": {
    "GET /topology": { "version": "8.5", "summary": "Get cluster topology." }
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

## Comparing Version Maps

Use `json-diff` to compare the two version map outputs:

```bash
# Full diff
npx json-diff output/version-map.json output/bundler-version-map.json

# Diff only operations
npx json-diff <(node -e "process.stdout.write(JSON.stringify(require('./output/version-map.json').operations))") \
              <(node -e "process.stdout.write(JSON.stringify(require('./output/bundler-version-map.json').operations))")

# Diff only properties
npx json-diff <(node -e "process.stdout.write(JSON.stringify(require('./output/version-map.json').properties))") \
              <(node -e "process.stdout.write(JSON.stringify(require('./output/bundler-version-map.json').properties))")
```
