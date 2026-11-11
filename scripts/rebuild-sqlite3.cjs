#!/usr/bin/env node
'use strict';

// sqlite3 6.x ships an N-API (node-addon-api) binary, which is ABI-stable across
// Node and Electron. Recompiling it with node-gyp is unnecessary, and on Windows
// it fails with EPERM when the existing binary is locked by a running process.
// Verify the installed binary is N-API and only fetch a prebuilt one when it is
// missing or was built against a non-N-API runtime.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const moduleDir = path.join(root, 'node_modules', 'sqlite3');
const binaryPath = path.join(moduleDir, 'build', 'Release', 'node_sqlite3.node');
const NAPI_SYMBOL = 'napi_register_module_v1';

function readBinaryState(file) {
  try {
    return fs.readFileSync(file).includes(NAPI_SYMBOL) ? 'napi' : 'not-napi';
  } catch {
    // The file exists but cannot be read, which on Windows means a running
    // process holds it open. Replacing it would fail with EPERM, so leave it be.
    return fs.existsSync(file) ? 'locked' : 'missing';
  }
}

function supportedNapiVersions() {
  try {
    const declared = require(path.join(moduleDir, 'package.json')).binary?.napi_versions;
    if (Array.isArray(declared) && declared.length) return [...declared].sort((a, b) => b - a);
  } catch { /* fall through to defaults */ }
  return [6, 3];
}

if (!fs.existsSync(moduleDir)) {
  console.error('sqlite3 is not installed. Run `npm install` first.');
  process.exit(1);
}

const state = readBinaryState(binaryPath);
if (state === 'napi') {
  console.log('sqlite3 native binary is already N-API (ABI-stable). Skipping rebuild.');
  process.exit(0);
}
if (state === 'locked') {
  console.log('sqlite3 native binary is in use by another process (locked). Leaving it as-is.');
  process.exit(0);
}

console.log('sqlite3 native binary is missing or not N-API. Fetching a prebuilt binary...');
const prebuildInstall = require.resolve('prebuild-install/bin.js', { paths: [root, moduleDir] });

for (const napiVersion of supportedNapiVersions()) {
  console.log(`Attempting sqlite3 N-API v${napiVersion} prebuild...`);
  const result = spawnSync(
    process.execPath,
    [prebuildInstall, '--runtime=napi', `--target=${napiVersion}`, '--verbose'],
    { cwd: moduleDir, stdio: 'inherit', env: process.env }
  );
  if (result.status === 0 && readBinaryState(binaryPath) === 'napi') {
    console.log(`sqlite3 N-API v${napiVersion} prebuilt binary installed.`);
    process.exit(0);
  }
}

console.error('\nsqlite3 could not be prepared automatically.');
console.error('Make sure no One Shot instance is running (it locks the native module),');
console.error('then delete node_modules/sqlite3/build and run `npm run rebuild` again.');
process.exit(1);
