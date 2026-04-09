import { readFileSync } from 'fs';

const a = JSON.parse(readFileSync('output/version-map.json', 'utf8'));
const b = JSON.parse(readFileSync('output/bundler-version-map.json', 'utf8'));

// Operations
const aOps = Object.keys(a.operations).sort();
const bOps = Object.keys(b.operations).sort();
const onlyInA_ops = aOps.filter(k => !(k in b.operations));
const onlyInB_ops = bOps.filter(k => !(k in a.operations));
const commonOps = aOps.filter(k => k in b.operations);
const versionMismatchOps = commonOps.filter(k => a.operations[k].version !== b.operations[k].version);

console.log('=== OPERATIONS ===');
console.log('version-map.json:', aOps.length);
console.log('bundler-version-map.json:', bOps.length);
console.log('Only in version-map:', onlyInA_ops.length, onlyInA_ops.slice(0, 5));
console.log('Only in bundler:', onlyInB_ops.length, onlyInB_ops.slice(0, 5));
console.log('Version mismatches:', versionMismatchOps.length);
for (const k of versionMismatchOps) {
  console.log('  ', k, a.operations[k].version, '->', b.operations[k].version);
}

// Properties
const aProps = Object.keys(a.properties).sort();
const bProps = Object.keys(b.properties).sort();
const onlyInA_props = aProps.filter(k => !(k in b.properties));
const onlyInB_props = bProps.filter(k => !(k in a.properties));
const commonProps = aProps.filter(k => k in b.properties);
const versionMismatchProps = commonProps.filter(k => a.properties[k].version !== b.properties[k].version);

console.log('\n=== PROPERTIES ===');
console.log('version-map.json:', aProps.length);
console.log('bundler-version-map.json:', bProps.length);
console.log('Only in version-map:', onlyInA_props.length);
if (onlyInA_props.length > 0) {
  console.log('  Examples:', onlyInA_props.slice(0, 5));
}
console.log('Only in bundler:', onlyInB_props.length);
if (onlyInB_props.length > 0) {
  console.log('  Examples:', onlyInB_props.slice(0, 5));
}
console.log('Common:', commonProps.length);
console.log('Version mismatches in common:', versionMismatchProps.length);
for (const k of versionMismatchProps.slice(0, 10)) {
  console.log('  ', k, a.properties[k].version, '->', b.properties[k].version);
}
if (versionMismatchProps.length > 10) {
  console.log('  ...and', versionMismatchProps.length - 10, 'more');
}

// Deleted operations
const aDelOps = Object.keys(a.deletedOperations).sort();
const bDelOps = Object.keys(b.deletedOperations).sort();
console.log('\n=== DELETED OPERATIONS ===');
console.log('version-map.json:', aDelOps.length, aDelOps);
console.log('bundler-version-map.json:', bDelOps.length, bDelOps);

console.log('\n=== IDENTICAL?', JSON.stringify(a) === JSON.stringify(b), '===');
