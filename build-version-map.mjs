/**
 * build-version-map.mjs
 *
 * Parses OpenAPI specs for versions 8.5–8.9 and builds a unified version map
 * recording when each operation and property was first introduced.
 *
 * This works directly from the specs (no openapi-diff needed) by comparing the
 * set of operations and schema properties across consecutive versions.
 *
 * Output: output/version-map.json
 *
 * Structure:
 * {
 *   operations: {
 *     "GET /path": { version: "8.5", summary: "..." },
 *     ...
 *   },
 *   properties: {
 *     "POST /path > request > fieldName": { version: "8.7", location: "request" },
 *     "GET /path > response > fieldName": { version: "8.8", location: "response" },
 *     ...
 *   },
 *   deletedOperations: {
 *     "POST /old-path": { removedIn: "8.7", summary: "..." },
 *     ...
 *   }
 * }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import YAML, { parse } from 'yaml';

const yaml = { load: (source) => YAML.parse(source) };

const VERSIONS = ['8.5', '8.6', '8.7', '8.8', '8.9'];
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// ─── Helpers ───────────────────────────────────────────────────────────────────

function loadSpec(version) {
  const path = `specs/${version}/bundled-api.yaml`;
  if (!existsSync(path)) {
    console.error(`  WARN: spec not found: ${path}`);
    return null;
  }
  return parse(readFileSync(path, 'utf8'));
}

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
  // Unwrap single-element allOf
  if (schema.allOf && schema.allOf.length === 1) {
    return resolveSchema(spec, schema.allOf[0]);
  }
  return schema;
}

/**
 * Convert a $ref string like "#/components/schemas/Foo" to a path array.
 */
function refToPath(ref) {
  if (!ref || !ref.startsWith('#/')) return null;
  return ref.slice(2).split('/');
}

/**
 * Extract property names from a schema and record their nesting metadata.
 * Handles $ref, allOf (any length), and sibling properties correctly.
 *
 * Returns Map<qualifiedName, { name, depth, path }> where `qualifiedName`
 * reflects the access chain from the operation's root schema, e.g.
 *   "tenants[].name"   for a `name` field inside an array of objects
 *   "user.address.zip" for a `zip` field nested two objects deep
 * `name` is the leaf property name. The map key is the qualified name so
 * nested properties with colliding leaf names (e.g. multiple `name` fields)
 * are recorded independently rather than overwriting each other.
 */
function extractProperties(
  spec,
  schema,
  depth = 0,
  maxDepth = 3,
  basePath = [],
  parentChain = '',
  visitedRefs = new Set(),
) {
  const props = new Map();
  if (!schema) return props;

  // Follow $ref — but merge with any sibling properties too. Guard against
  // recursive schemas (e.g. tree-shaped types) by tracking visited refs.
  if (schema.$ref) {
    if (visitedRefs.has(schema.$ref)) return props;
    const nextVisited = new Set(visitedRefs);
    nextVisited.add(schema.$ref);
    const refTarget = resolveRef(spec, schema.$ref);
    const refPath = refToPath(schema.$ref);
    const refProps = extractProperties(
      spec, refTarget, depth, maxDepth, refPath || basePath, parentChain, nextVisited,
    );
    for (const [qname, info] of refProps) {
      if (!props.has(qname)) props.set(qname, info);
    }
  }

  // Direct properties on this schema
  if (schema.properties) {
    for (const [name, propSchema] of Object.entries(schema.properties)) {
      const resolvedProp = resolveSchema(spec, propSchema);
      const type = resolvedProp?.type || (resolvedProp?.enum ? 'enum' : 'object');
      const qname = parentChain ? `${parentChain}.${name}` : name;
      if (!props.has(qname)) {
        // Property is explicitly named here — always use the inline path
        props.set(qname, { name, depth, path: [...basePath, 'properties', name] });
      }

      // Recurse into nested objects (but not too deep)
      if (depth < maxDepth && (type === 'object' || type === 'array')) {
        let innerSchema = propSchema.$ref ? resolveRef(spec, propSchema.$ref) : resolvedProp;
        let innerBasePath = propSchema.$ref
          ? (refToPath(propSchema.$ref) || [...basePath, 'properties', name])
          : [...basePath, 'properties', name];
        let childChain = qname;
        let childVisited = visitedRefs;
        if (propSchema.$ref) {
          if (visitedRefs.has(propSchema.$ref)) continue;
          childVisited = new Set(visitedRefs);
          childVisited.add(propSchema.$ref);
        }
        if (type === 'array') {
          const arraySchema = propSchema.$ref ? resolveRef(spec, propSchema.$ref) : resolvedProp;
          innerSchema = arraySchema?.items || resolvedProp?.items;
          if (innerSchema?.$ref) {
            if (childVisited.has(innerSchema.$ref)) continue;
            childVisited = new Set(childVisited);
            childVisited.add(innerSchema.$ref);
            innerBasePath = refToPath(innerSchema.$ref) || innerBasePath;
            innerSchema = resolveRef(spec, innerSchema.$ref) || innerSchema;
          } else {
            innerBasePath = [...innerBasePath, 'items'];
          }
          childChain = `${qname}[]`;
        }
        if (!innerSchema) continue;
        const nested = extractProperties(
          spec, innerSchema, depth + 1, maxDepth, innerBasePath, childChain, childVisited,
        );
        for (const [nestedQname, nestedInfo] of nested) {
          if (!props.has(nestedQname)) {
            props.set(nestedQname, nestedInfo);
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
      const subProps = extractProperties(
        spec, sub, depth, maxDepth, subBasePath, parentChain, visitedRefs,
      );
      for (const [qname, info] of subProps) {
        if (!props.has(qname)) {
          props.set(qname, info);
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
        const subProps = extractProperties(
          spec, sub, depth, maxDepth, subBasePath, parentChain, visitedRefs,
        );
        for (const [qname, info] of subProps) {
          if (!props.has(qname)) {
            props.set(qname, info);
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
function getRequestProperties(spec, operation, operationBasePath, upstreamRequestRef) {
  const body = operation.requestBody;
  if (!body) return new Map();
  const contentType = body.content?.['application/json'] ? 'application/json' : 'multipart/form-data';
  const content = body.content?.[contentType];
  if (!content?.schema) return new Map();
  const ref = content.schema.$ref || upstreamRequestRef;
  const schemaBasePath = ref
    ? (refToPath(ref) || [...operationBasePath, 'requestBody', 'content', contentType, 'schema'])
    : [...operationBasePath, 'requestBody', 'content', contentType, 'schema'];
  return extractProperties(spec, content.schema, 0, 3, schemaBasePath);
}

/**
 * Extract response properties for an operation (from the success response).
 */
function getResponseProperties(spec, operation, operationBasePath, upstreamResponseRef) {
  const responses = operation.responses;
  if (!responses) return new Map();

  const successCode = Object.keys(responses).find(
    (code) => code === '200' || code === '201' || code === '204'
  ) || Object.keys(responses).find((code) => code.startsWith('2'));

  if (!successCode) return new Map();
  const response = responses[successCode];
  const content = response?.content?.['application/json'];
  if (!content?.schema) return new Map();
  const ref = content.schema.$ref || upstreamResponseRef;
  const schemaBasePath = ref
    ? (refToPath(ref) || [...operationBasePath, 'responses', successCode, 'content', 'application/json', 'schema'])
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
 * Extract all operations and their properties from a spec.
 * When schemaFileMap and operationFileMap are provided, cross-file property
 * paths are prefixed with the source filename.
 * Returns { operations: Map, properties: Map }
 */
function extractSpecData(spec, operationFileMap, schemaFileMap, operationSchemaRefMap) {
  const operations = new Map();
  const properties = new Map();

  if (!spec?.paths) return { operations, properties };

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const opKey = `${method.toUpperCase()} ${path}`;
      const opSourceFile = operationFileMap?.get(opKey) || null;
      const operationBasePath = opSourceFile
        ? [opSourceFile, 'paths', path, method]
        : ['paths', path, method];
      operations.set(opKey, {
        summary: operation.summary || operation.description || '',
        operationId: operation.operationId || '',
        path: operationBasePath,
      });

      const upstreamRefs = operationSchemaRefMap?.get(opKey);

      // Request properties
      const reqProps = getRequestProperties(spec, operation, operationBasePath, upstreamRefs?.requestRef);
      for (const [qualifiedName, propInfo] of reqProps) {
        const propKey = `${opKey} > request > ${qualifiedName}`;
        const schemaFile = getSchemaFileForPath(propInfo.path, schemaFileMap);
        const finalPath = (schemaFile && schemaFile !== opSourceFile)
          ? [schemaFile, ...propInfo.path]
          : propInfo.path;
        properties.set(propKey, {
          location: 'request',
          endpoint: opKey,
          property: propInfo.name,
          qualifiedName,
          depth: propInfo.depth,
          path: finalPath,
        });
      }

      // Response properties
      const resProps = getResponseProperties(spec, operation, operationBasePath, upstreamRefs?.responseRef);
      for (const [qualifiedName, propInfo] of resProps) {
        const propKey = `${opKey} > response > ${qualifiedName}`;
        const schemaFile = getSchemaFileForPath(propInfo.path, schemaFileMap);
        const finalPath = (schemaFile && schemaFile !== opSourceFile)
          ? [schemaFile, ...propInfo.path]
          : propInfo.path;
        properties.set(propKey, {
          location: 'response',
          endpoint: opKey,
          property: propInfo.name,
          qualifiedName,
          depth: propInfo.depth,
          path: finalPath,
        });
      }
    }
  }

  return { operations, properties };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

console.log('Building Go API version map from OpenAPI specs...\n');

const versionMap = {
  metadata: {
    multiFileVersions: [],
  },
  operations: {},
  properties: {},
  deletedOperations: {},
};

// Track what was seen in each version for deletion detection
let previousOps = null;

for (const version of VERSIONS) {
  const spec = loadSpec(version);
  if (!spec) {
    console.log(`  SKIP: ${version} (no spec)`);
    continue;
  }

  // Build operation → source file map, schema → source file map,
  // and operation → original schema $ref map by scanning upstream YAML files
  const upstreamDir = `specs/${version}/upstream`;
  const operationFileMap = new Map();
  const schemaFileMap = new Map();
  const operationSchemaRefMap = new Map();
  if (existsSync(upstreamDir)) {
    try {
      const files = readdirSync(upstreamDir).filter(f => f.endsWith('.yaml')).sort();
      for (const file of files) {
        try {
          const content = readFileSync(`${upstreamDir}/${file}`, 'utf8');
        const parsed = yaml.load(content);
        if (parsed?.paths) {
          for (const [path, pathItem] of Object.entries(parsed.paths)) {
            for (const method of HTTP_METHODS) {
              if (pathItem[method]) {
                const opKey = `${method.toUpperCase()} ${path}`;
                if (!operationFileMap.has(opKey)) {
                  operationFileMap.set(opKey, file);
                }
                // Record original $ref for request/response schemas.
                // These may be lost when Redocly bundles the spec.
                // Normalize cross-file refs like "file.yaml#/..." to "#/..."
                // since the bundled spec uses local refs.
                if (!operationSchemaRefMap.has(opKey)) {
                  const op = pathItem[method];
                  const normalizeRef = (r) => r ? '#' + r.split('#').pop() : null;
                  const reqRef = normalizeRef(
                    op.requestBody?.content?.['application/json']?.schema?.$ref
                    || op.requestBody?.content?.['multipart/form-data']?.schema?.$ref
                  );
                  const responses = op.responses || {};
                  const successCode = Object.keys(responses).find(
                    (c) => c === '200' || c === '201' || c === '204'
                  ) || Object.keys(responses).find((c) => c.startsWith('2'));
                  const resRef = successCode
                    ? normalizeRef(responses[successCode]?.content?.['application/json']?.schema?.$ref)
                    : null;
                  if (reqRef || resRef) {
                    operationSchemaRefMap.set(opKey, { requestRef: reqRef, responseRef: resRef });
                  }
                }
              }
            }
          }
        }
        const schemas = parsed?.components?.schemas;
        if (schemas) {
          for (const name of Object.keys(schemas)) {
            if (!schemaFileMap.has(name)) {
              schemaFileMap.set(name, file);
            }
          }
        }
        } catch (error) {
          console.warn(`  WARN: failed to parse upstream YAML ${version}/${file}: ${error?.message || error}`);
        }
      }
    } catch (error) {
      console.warn(`  WARN: failed to read upstream dir for ${version}: ${error?.message || error}`);
    }
  }

  const uniqueSchemaFiles = new Set(schemaFileMap.values());
  const isMultiFile = uniqueSchemaFiles.size > 2;
  if (isMultiFile) {
    versionMap.metadata.multiFileVersions.push(version);
  }

  // Always pass the upstream-file maps so paths are prefixed with their
  // source filename whenever attribution is available. When a property was
  // first seen in an earlier (single-file) version, its path is upgraded
  // here using the latest version's split-file attribution while preserving
  // the original `version` field.
  const { operations, properties } = extractSpecData(
    spec,
    operationFileMap,
    schemaFileMap,
    operationSchemaRefMap
  );

  // Record operations first seen in this version (and refresh path attribution)
  let newOps = 0;
  for (const [opKey, opData] of operations) {
    if (!versionMap.operations[opKey]) {
      versionMap.operations[opKey] = {
        version,
        summary: opData.summary,
        path: opData.path,
      };
      newOps++;
    } else {
      // Keep the original first-seen version, but refresh the path to the
      // most recent attribution (later versions split into per-resource files).
      versionMap.operations[opKey].path = opData.path;
      // Backfill summary if it was missing in the version where it was first seen.
      if (!versionMap.operations[opKey].summary && opData.summary) {
        versionMap.operations[opKey].summary = opData.summary;
      }
    }
  }

  // Record properties first seen in this version (and refresh path attribution)
  let newProps = 0;
  for (const [propKey, propData] of properties) {
    if (!versionMap.properties[propKey]) {
      versionMap.properties[propKey] = {
        version,
        ...propData,
      };
      newProps++;
    } else {
      // Preserve the first-seen version; update path/depth to current version's.
      const existing = versionMap.properties[propKey];
      versionMap.properties[propKey] = {
        ...existing,
        location: propData.location,
        endpoint: propData.endpoint,
        property: propData.property,
        qualifiedName: propData.qualifiedName,
        depth: propData.depth,
        path: propData.path,
      };
    }
  }

  // Detect deleted operations (present in previous version but absent in this one)
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
    `  ${version}: ${operations.size} ops (${newOps} new), ` +
    `${properties.size} props (${newProps} new)` +
    (deletedOps > 0 ? `, ${deletedOps} deleted ops` : '')
  );

  previousOps = operations;
}

// ─── Summary ───────────────────────────────────────────────────────────────────

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
writeFileSync('output/version-map.json', JSON.stringify(versionMap, null, 2));
console.log(`\nVersion map written to output/version-map.json`);
console.log(`  ${Object.keys(versionMap.operations).length} operations`);
console.log(`  ${Object.keys(versionMap.properties).length} properties`);
console.log(`  ${Object.keys(versionMap.deletedOperations).length} deleted operations`);
