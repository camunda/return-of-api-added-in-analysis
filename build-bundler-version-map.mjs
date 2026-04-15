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
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { fetchAndBundle } from 'camunda-schema-bundler';
import yaml from 'js-yaml';

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
 * Convert a $ref string like "#/components/schemas/Foo" to a path array
 * like ["components", "schemas", "Foo"].
 */
function refToPath(ref) {
  if (!ref || !ref.startsWith('#/')) return null;
  return ref.slice(2).split('/');
}

/**
 * Extract top-level property names and their types from a schema.
 * Handles $ref, allOf (any length), and sibling properties correctly.
 * Returns Map<propertyName, { depth, path }>.
 */
function extractProperties(spec, schema, depth = 0, maxDepth = 3, basePath = []) {
  const props = new Map();
  if (!schema) return props;

  if (schema.$ref) {
    const refTarget = resolveRef(spec, schema.$ref);
    const refPath = refToPath(schema.$ref);
    const refProps = extractProperties(spec, refTarget, depth, maxDepth, refPath || basePath);
    for (const [name, info] of refProps) {
      if (!props.has(name)) props.set(name, info);
    }
  }

  if (schema.properties) {
    for (const [name, propSchema] of Object.entries(schema.properties)) {
      const resolvedProp = resolveSchema(spec, propSchema);
      const type = resolvedProp?.type || (resolvedProp?.enum ? 'enum' : 'object');
      if (!props.has(name)) {
        // Property is explicitly named here — always use the inline path
        props.set(name, { depth, path: [...basePath, 'properties', name] });
      }

      // Recurse into nested objects (but not too deep)
      if (depth < maxDepth && (type === 'object' || type === 'array')) {
        let innerSchema = propSchema.$ref ? resolveRef(spec, propSchema.$ref) : resolvedProp;
        let innerBasePath = propSchema.$ref
          ? (refToPath(propSchema.$ref) || [...basePath, 'properties', name])
          : [...basePath, 'properties', name];
        if (type === 'array') {
          const arraySchema = propSchema.$ref ? resolveRef(spec, propSchema.$ref) : resolvedProp;
          innerSchema = arraySchema?.items || resolvedProp?.items;
          if (innerSchema?.$ref) {
            innerBasePath = refToPath(innerSchema.$ref) || innerBasePath;
            innerSchema = resolveRef(spec, innerSchema.$ref) || innerSchema;
          } else {
            innerBasePath = [...innerBasePath, 'items'];
          }
        }
        if (!innerSchema) continue;
        const nested = extractProperties(spec, innerSchema, depth + 1, maxDepth, innerBasePath);
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
    for (let i = 0; i < schema.allOf.length; i++) {
      const sub = schema.allOf[i];
      const subBasePath = sub.$ref ? (refToPath(sub.$ref) || basePath) : [...basePath, 'allOf', String(i)];
      const subProps = extractProperties(spec, sub, depth, maxDepth, subBasePath);
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
      for (let i = 0; i < schema[keyword].length; i++) {
        const sub = schema[keyword][i];
        const subBasePath = sub.$ref ? (refToPath(sub.$ref) || basePath) : [...basePath, keyword, String(i)];
        const subProps = extractProperties(spec, sub, depth, maxDepth, subBasePath);
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
function getRequestProperties(spec, operation, operationBasePath) {
  const body = operation.requestBody;
  if (!body) return new Map();
  const contentType = body.content?.['application/json'] ? 'application/json' : 'multipart/form-data';
  const content = body.content?.[contentType];
  if (!content?.schema) return new Map();
  const schemaBasePath = content.schema.$ref
    ? (refToPath(content.schema.$ref) || [...operationBasePath, 'requestBody', 'content', contentType, 'schema'])
    : [...operationBasePath, 'requestBody', 'content', contentType, 'schema'];
  return extractProperties(spec, content.schema, 0, 3, schemaBasePath);
}

/**
 * Extract response properties for an operation (from the success response).
 */
function getResponseProperties(spec, operation, operationBasePath) {
  const responses = operation.responses;
  if (!responses) return new Map();

  const successCode = Object.keys(responses).find(
    (code) => code === '200' || code === '201' || code === '204'
  ) || Object.keys(responses).find((code) => code.startsWith('2'));

  if (!successCode) return new Map();
  const response = responses[successCode];
  const content = response?.content?.['application/json'];
  if (!content?.schema) return new Map();
  const schemaBasePath = content.schema.$ref
    ? (refToPath(content.schema.$ref) || [...operationBasePath, 'responses', successCode, 'content', 'application/json', 'schema'])
    : [...operationBasePath, 'responses', successCode, 'content', 'application/json', 'schema'];
  return extractProperties(spec, content.schema, 0, 3, schemaBasePath);
}

/**
 * Given a path like ["components", "schemas", "Foo", ...], look up Foo's
 * source file in schemaFileMap. Returns the filename or null.
 */
function getSchemaFileForPath(pathArr, schemaFileMap) {
  if (!schemaFileMap || !pathArr) return null;
  if (pathArr[0] === 'components' && pathArr[1] === 'schemas' && pathArr[2]) {
    return schemaFileMap.get(pathArr[2]) || null;
  }
  return null;
}

/**
 * Extract all operations and their properties from a spec object.
 * When schemaFileMap and operationFileMap are provided, cross-file property
 * paths are prefixed with the source filename.
 */
function extractSpecData(spec, operationFileMap, schemaFileMap) {
  const operations = new Map();
  const properties = new Map();

  if (!spec?.paths) return { operations, properties };

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const opKey = `${method.toUpperCase()} ${path}`;
      const opSourceFile = operationFileMap?.get(opKey) || null;
      const operationBasePath = ['paths', path, method];
      operations.set(opKey, {
        summary: operation.summary || '',
        operationId: operation.operationId || '',
      });

      const reqProps = getRequestProperties(spec, operation, operationBasePath);
      for (const [propName, propInfo] of reqProps) {
        const propKey = `${opKey} > request > ${propName}`;
        const schemaFile = getSchemaFileForPath(propInfo.path, schemaFileMap);
        const finalPath = (schemaFile && schemaFile !== opSourceFile)
          ? [schemaFile, ...propInfo.path]
          : propInfo.path;
        properties.set(propKey, {
          location: 'request',
          endpoint: opKey,
          property: propName,
          depth: propInfo.depth,
          path: finalPath,
        });
      }

      const resProps = getResponseProperties(spec, operation, operationBasePath);
      for (const [propName, propInfo] of resProps) {
        const propKey = `${opKey} > response > ${propName}`;
        const schemaFile = getSchemaFileForPath(propInfo.path, schemaFileMap);
        const finalPath = (schemaFile && schemaFile !== opSourceFile)
          ? [schemaFile, ...propInfo.path]
          : propInfo.path;
        properties.set(propKey, {
          location: 'response',
          endpoint: opKey,
          property: propName,
          depth: propInfo.depth,
          path: finalPath,
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

    // Build operation → source file map and schema → source file map
    // by scanning upstream YAML files
    const operationFileMap = new Map();
    const schemaFileMap = new Map();
    try {
      const files = readdirSync(outputDir).filter(f => f.endsWith('.yaml'));
      for (const file of files) {
        try {
          const content = readFileSync(`${outputDir}/${file}`, 'utf8');
          const parsed = yaml.load(content);
          // Map operations (paths) to source files
          if (parsed?.paths) {
            for (const [path, pathItem] of Object.entries(parsed.paths)) {
              for (const method of HTTP_METHODS) {
                if (pathItem[method]) {
                  const opKey = `${method.toUpperCase()} ${path}`;
                  if (!operationFileMap.has(opKey)) {
                    operationFileMap.set(opKey, file);
                  }
                }
              }
            }
          }
          // Map schemas to source files
          const schemas = parsed?.components?.schemas;
          if (schemas) {
            for (const name of Object.keys(schemas)) {
              if (!schemaFileMap.has(name)) {
                schemaFileMap.set(name, file);
              }
            }
          }
        } catch (_) {}
      }
    } catch (_) {}

    // Only use file maps for multi-file specs (many upstream YAML files).
    // Monolithic specs (8.5–8.8) have just rest-api.yaml + rest-api-v1.yaml,
    // while multi-file specs (8.9+) have many domain-specific YAML files.
    const uniqueSchemaFiles = new Set(schemaFileMap.values());
    const isMultiFile = uniqueSchemaFiles.size > 2;
    const { operations, properties } = extractSpecData(
      spec,
      isMultiFile ? operationFileMap : null,
      isMultiFile ? schemaFileMap : null
    );

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
