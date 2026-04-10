/**
 * build-bundler-version-map.mjs
 *
 * Uses camunda-schema-bundler to fetch and bundle OpenAPI specs for versions
 * 8.5–8.9 directly from the Camunda GitHub repo, then builds a unified
 * version map recording when each operation and property was first introduced.
 *
 * This is the bundler-based equivalent of build-version-map.mjs, which reads
 * pre-extracted YAML specs from disk. Here the bundler handles fetching,
 * bundling, and normalization automatically.
 *
 * Output: output/bundler-version-map.json
 */
import { writeFileSync, mkdirSync } from 'fs';
import { fetchAndBundle } from 'camunda-schema-bundler';

const VERSIONS = ['8.5', '8.6', '8.7', '8.8', '8.9'];
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a $ref pointer like "#/components/schemas/Foo" within the spec.
 */
function resolveRef(spec, ref) {
  if (!ref || !ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let current = spec;
  for (const p of parts) {
    if (!current || typeof current !== 'object') return null;
    current = current[p];
  }
  return current || null;
}

/**
 * Resolve a schema, following $ref and unwrapping single-element allOf.
 */
function resolveSchema(spec, schema) {
  if (!schema) return null;
  if (schema.$ref) {
    return resolveSchema(spec, resolveRef(spec, schema.$ref));
  }
  if (schema.allOf && schema.allOf.length === 1) {
    return resolveSchema(spec, schema.allOf[0]);
  }
  return schema;
}

/**
 * Extract top-level property names and their types from a schema.
 * Handles $ref, allOf (any length), and sibling properties correctly.
 * Returns Map<propertyName, { type, depth }>.
 */
function extractProperties(spec, schema, depth = 0, maxDepth = 3) {
  const props = new Map();
  if (!schema) return props;

  if (schema.$ref) {
    const refTarget = resolveRef(spec, schema.$ref);
    const refProps = extractProperties(spec, refTarget, depth, maxDepth);
    for (const [name, info] of refProps) {
      if (!props.has(name)) props.set(name, info);
    }
  }

  if (schema.properties) {
    for (const [name, propSchema] of Object.entries(schema.properties)) {
      const resolvedProp = resolveSchema(spec, propSchema);
      const type = resolvedProp?.type || (resolvedProp?.enum ? 'enum' : 'object');
      if (!props.has(name)) {
        props.set(name, { depth });
      }

      // Recurse into nested objects (but not too deep)
      if (depth < maxDepth && (type === 'object' || type === 'array')) {
        // Use the original propSchema (not resolvedProp) so extractProperties
        // can walk $ref, allOf, and sibling properties correctly.
        let innerSchema = propSchema.$ref ? resolveRef(spec, propSchema.$ref) : resolvedProp;
        if (type === 'array') {
          // For arrays, we need to get to the items schema
          const arraySchema = propSchema.$ref ? resolveRef(spec, propSchema.$ref) : resolvedProp;
          innerSchema = arraySchema?.items || resolvedProp?.items;
        }
        if (!innerSchema) continue;
        const nested = extractProperties(spec, innerSchema, depth + 1, maxDepth);
        for (const [nestedName, nestedInfo] of nested) {
          if (!props.has(nestedName)) {
            props.set(nestedName, nestedInfo);
          }
        }
      }
    }
  }

  // allOf composition — handle any length (including 1 with sibling properties)
  if (schema.allOf) {
    for (const sub of schema.allOf) {
      const subProps = extractProperties(spec, sub, depth, maxDepth);
      for (const [name, info] of subProps) {
        if (!props.has(name)) {
          props.set(name, info);
        }
      }
    }
  }

  // oneOf / anyOf — merge properties from all branches
  for (const keyword of ['oneOf', 'anyOf']) {
    if (schema[keyword]) {
      for (const sub of schema[keyword]) {
        const subProps = extractProperties(spec, sub, depth, maxDepth);
        for (const [name, info] of subProps) {
          if (!props.has(name)) {
            props.set(name, info);
          }
        }
      }
    }
  }

  return props;
}

/**
 * Extract request body properties for an operation.
 */
function getRequestProperties(spec, operation) {
  const body = operation.requestBody;
  if (!body) return new Map();
  const content = body.content?.['application/json'] || body.content?.['multipart/form-data'];
  if (!content?.schema) return new Map();
  return extractProperties(spec, content.schema);
}

/**
 * Extract response properties for an operation (from the success response).
 */
function getResponseProperties(spec, operation) {
  const responses = operation.responses;
  if (!responses) return new Map();

  const successCode = Object.keys(responses).find(
    (code) => code === '200' || code === '201' || code === '204'
  ) || Object.keys(responses).find((code) => code.startsWith('2'));

  if (!successCode) return new Map();
  const response = responses[successCode];
  const content = response?.content?.['application/json'];
  if (!content?.schema) return new Map();
  return extractProperties(spec, content.schema);
}

/**
 * Extract all operations and their properties from a spec object.
 */
function extractSpecData(spec) {
  const operations = new Map();
  const properties = new Map();

  if (!spec?.paths) return { operations, properties };

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const opKey = `${method.toUpperCase()} ${path}`;
      operations.set(opKey, {
        summary: operation.summary || '',
        operationId: operation.operationId || '',
      });

      const reqProps = getRequestProperties(spec, operation);
      for (const [propName, propInfo] of reqProps) {
        const propKey = `${opKey} > request > ${propName}`;
        properties.set(propKey, {
          location: 'request',
          endpoint: opKey,
          property: propName,
          depth: propInfo.depth,
        });
      }

      const resProps = getResponseProperties(spec, operation);
      for (const [propName, propInfo] of resProps) {
        const propKey = `${opKey} > response > ${propName}`;
        properties.set(propKey, {
          location: 'response',
          endpoint: opKey,
          property: propName,
          depth: propInfo.depth,
        });
      }
    }
  }

  return { operations, properties };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Building version map from camunda-schema-bundler output...\n');

  const versionMap = {
    operations: {},
    properties: {},
    deletedOperations: {},
  };

  let previousOps = null;

  for (const version of VERSIONS) {
    const ref = `stable/${version}`;
    const outputDir = `bundler-specs/${version}/upstream`;
    const outputSpec = `bundler-specs/${version}/rest-api.bundle.json`;

    console.log(`  Fetching and bundling ${ref}...`);

    let result;
    try {
      result = await fetchAndBundle({
        ref,
        outputDir,
        outputSpec,
        allowPathLocalLikeRefs: true,
      });
    } catch (err) {
      console.error(`  ERROR bundling ${version}: ${err.message}`);
      continue;
    }

    const spec = result.spec;
    console.log(`    Bundled: ${result.stats.pathCount} paths, ${result.stats.schemaCount} schemas`);

    const { operations, properties } = extractSpecData(spec);

    // Record operations first seen in this version
    let newOps = 0;
    for (const [opKey, opData] of operations) {
      if (!versionMap.operations[opKey]) {
        versionMap.operations[opKey] = {
          version,
          summary: opData.summary,
        };
        newOps++;
      }
    }

    // Record properties first seen in this version
    let newProps = 0;
    for (const [propKey, propData] of properties) {
      if (!versionMap.properties[propKey]) {
        versionMap.properties[propKey] = {
          version,
          ...propData,
        };
        newProps++;
      }
    }

    // Detect deleted operations
    let deletedOps = 0;
    if (previousOps) {
      for (const [opKey, opData] of previousOps) {
        if (!operations.has(opKey) && !versionMap.deletedOperations[opKey]) {
          versionMap.deletedOperations[opKey] = {
            removedIn: version,
            summary: opData.summary,
          };
          deletedOps++;
        }
      }
    }

    console.log(
      `    ${version}: ${operations.size} ops (${newOps} new), ` +
      `${properties.size} props (${newProps} new)` +
      (deletedOps > 0 ? `, ${deletedOps} deleted ops` : '')
    );

    previousOps = operations;
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  console.log('');

  const opsByVersion = {};
  for (const val of Object.values(versionMap.operations)) {
    opsByVersion[val.version] = (opsByVersion[val.version] || 0) + 1;
  }
  console.log('Operations by version:');
  for (const [v, count] of Object.entries(opsByVersion).sort()) {
    console.log(`  ${v}: ${count} operations`);
  }

  const propsByVersion = {};
  for (const val of Object.values(versionMap.properties)) {
    propsByVersion[val.version] = (propsByVersion[val.version] || 0) + 1;
  }
  console.log('\nProperties by version:');
  for (const [v, count] of Object.entries(propsByVersion).sort()) {
    console.log(`  ${v}: ${count} properties`);
  }

  // Write output
  mkdirSync('output', { recursive: true });
  writeFileSync('output/bundler-version-map.json', JSON.stringify(versionMap, null, 2));
  console.log(`\nVersion map written to output/bundler-version-map.json`);
  console.log(`  ${Object.keys(versionMap.operations).length} operations`);
  console.log(`  ${Object.keys(versionMap.properties).length} properties`);
  console.log(`  ${Object.keys(versionMap.deletedOperations).length} deleted operations`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
