# api-added-in-analysis-2

Tracks when each Camunda 8 REST API operation and property was first introduced (and when it was removed), by parsing OpenAPI specs across versions 8.5–8.10. Nested object and array properties are extracted recursively, so the output captures the full request/response schema surface — not just top-level fields.

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

Both flows produce equivalent output (192 operations, 5,695 properties, 2 deleted operations, 111 deleted properties).

Each property carries:
- `qualifiedName` — dot-notation access path from the operation's root schema, with `[]` marking arrays of objects (e.g. `filter.processInstanceKey.$eq`, `brokers[].partitions[].role`). Used to disambiguate same-named fields at different nesting levels.
- `property` — bare leaf name (preserved for backward compatibility).
- `children` — list of property keys one level deeper in the `qualifiedName` tree, scoped to the same operation/location. Lets consumers walk the schema without re-parsing.
- `path` — JSON-Pointer-style location inside the OpenAPI document (for spec navigation).

Removed operations and properties are tracked under `deletedOperations` / `deletedProperties` with the version in which they disappeared.

```json
{
  "metadata": {
    "multiFileVersions": ["8.9", "8.10"]
  },
  "operations": {
    "GET /topology": {
      "version": "8.5",
      "summary": "Get cluster topology.",
      "path": ["paths", "/topology", "get"]
    }
  },
  "properties": {
    "POST /user-tasks/search > request > filter": {
      "version": "8.6",
      "location": "request",
      "endpoint": "POST /user-tasks/search",
      "property": "filter",
      "qualifiedName": "filter",
      "depth": 0,
      "path": ["components", "schemas", "UserTaskSearchQuery", "properties", "filter"],
      "children": [
        "POST /user-tasks/search > request > filter.state",
        "POST /user-tasks/search > request > filter.assignee"
      ]
    },
    "POST /user-tasks/search > request > filter.state": {
      "version": "8.6",
      "location": "request",
      "endpoint": "POST /user-tasks/search",
      "property": "state",
      "qualifiedName": "filter.state",
      "depth": 1,
      "path": ["components", "schemas", "UserTaskSearchQuery", "properties", "filter", "properties", "state"],
      "children": []
    }
  },
  "deletedOperations": {
    "POST /document/{documentId}/links": {
      "removedIn": "8.7",
      "summary": "Create document link (alpha)"
    }
  },
  "deletedProperties": {
    "POST /some-endpoint > request > legacyField": {
      "removedIn": "8.8",
      "endpoint": "POST /some-endpoint"
    }
  }
}
```

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
If running in a ci script:
```bash
npm ci --omit=dev
```