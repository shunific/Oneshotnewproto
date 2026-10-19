const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const {hasPrivilegedJwt} = require('./credential-boundary.cjs');
const root = path.resolve(__dirname, '..');
const bundle = path.resolve(process.argv[2] || path.join(root, 'release/mac-arm64/One Shot Management System.app'));
const resources = path.join(bundle, 'Contents/Resources');
const archive = path.join(resources, 'app.asar');
const list = asar.listPackage(archive);
assert(!list.some(name => /(^|\/)\.env(?:\.|$)/.test(name)), 'An environment file was packaged.');
assert(!fs.readdirSync(resources).some(name => /^\.env(?:\.|$)/.test(name)), 'An extra environment resource was packaged.');
for (const name of ['server.cjs','server-security.cjs','server-inventory.cjs','server-orders.cjs','server-queue.cjs','server-images.cjs','server-auth.cjs','server-checkout.cjs','server-checkin.cjs','server-session-identity.cjs','server-checkin-schema.cjs','server-reservation-completion.cjs','server-reservation-moves.cjs','server-device-proof.cjs','server-native-actor.cjs','server-native-delivery.cjs','server-native-runtime.cjs','server-native-move-routes.cjs','server-native-reservation-routes.cjs','server-checkin-cancellation.cjs','server-feedback.cjs','content-create-contract.mjs','server-content-create.cjs','server-venue-availability.cjs','server-table-start.cjs','venue-content-contract.mjs','server-venue-content.cjs','server-device-key-channel.cjs','electron/host-device-key-channel.cjs','electron/native-device-id.cjs','electron/device-key-store.cjs','server-refunds.cjs','server-policy.cjs','session-billing.mjs','server-session-state.cjs','server-cloud.cjs','server-cloud-staff.cjs','server-backup.cjs','electron/main.cjs']) {
  assert.deepEqual(asar.extractFile(archive, name), fs.readFileSync(path.join(root, name)), `Packaged ${name} differs from tested source.`);
}
const verifyDist = (directory, relative = 'dist') => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) verifyDist(file, name);
    else assert.deepEqual(asar.extractFile(archive, name), fs.readFileSync(file), 'Packaged renderer differs from the checked build.');
  }
};
verifyDist(path.join(root, 'dist'));
const privateValues = [];
for (const name of fs.readdirSync(root).filter(n => n.startsWith('.env'))) {
  for (const line of fs.readFileSync(path.join(root, name),'utf8').split('\n')) {
    const match = line.match(/^([^#=]+)\s*=\s*["']?(.+?)["']?$/);
    if (match && /SERVICE|SECRET/i.test(match[1]) && match[2].length > 20) privateValues.push(Buffer.from(match[2]));
  }
}
let files = 0;
const scan = target => {
  for (const entry of fs.readdirSync(target,{withFileTypes:true})) {
    const file=path.join(target,entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) scan(file);
    else { const data=fs.readFileSync(file); assert(!hasPrivilegedJwt(data), 'A privileged service-role JWT was found in the artifact.'); for (const value of privateValues) assert(!data.includes(value), 'An existing privileged environment credential leaked into the artifact.'); files++; }
  }
};
scan(resources);
assert(list.some(name => name.startsWith('/dist/assets/')), 'Compiled renderer is missing.');
console.log(`PASS: no environment files, privileged service-role JWTs or known privileged environment values across ${files} resource files; packaged backend helpers match tested source; compiled renderer present.`);
console.log('LIMIT: checks readable JWT role claims and known local secret values, not a universal secret detector or signing verification.');
