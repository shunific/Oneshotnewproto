// Isolated verification only: real local PostgreSQL output, controlled Auth/RPC transport.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createCloudStaffService, PROJECT_URL } = require('../server-cloud-staff.cjs');
async function main() {
  const verified = spawnSync('python3', [path.join(__dirname, 'verify-staff-checkin-local.py')], { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(verified.status, 0, verified.stderr || verified.error?.message);
  const sqlProof = JSON.parse(verified.stdout);
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(sqlProof.sourceSha256, hash(path.join(__dirname, 'staff-checkin.draft.sql')));
  const command = sqlProof.successfulCommand, result = sqlProof.successfulResult;
  assert.ok(command && result && sqlProof.liveWrites === false);
  let calls = 0;
  const reply = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  const service = createCloudStaffService({
    enabled: true, key: 'sb_publishable_' + 'x'.repeat(30),
    isLocalSessionActive: async token => token === 'qa-contract-session',
    fetchImpl: async (url, init) => {
      assert.ok(url.startsWith(PROJECT_URL + '/'));
      if (url.includes('/auth/v1/token')) return reply({ access_token: 'FIXTURE_ACCESS', refresh_token: 'FIXTURE_REFRESH', expires_in: 3600 });
      if (url.endsWith('/oneshot_staff_identity')) return reply({ userId: result.claim.actorUserId, venueId: 'oneshot', role: result.claim.actorRole, email: 'staff@example.invalid' });
      if (url.endsWith('/oneshot_staff_claim_checkin')) {
        assert.deepEqual(JSON.parse(init.body), { payload: command }); calls++;
        return reply(result);
      }
      throw new Error('Unexpected controlled transport call');
    },
  });
  await service.connect('qa-contract-session', 'staff@example.invalid', 'existing-fixture-password');
  const adopted = await service.claimCheckin('qa-contract-session', command);
  assert.deepEqual(adopted, result); assert.equal(calls, 1);
  const proof = {
    PASS: true, sqlChecks: sqlProof.passed, sqlSourceSha256: sqlProof.sourceSha256,
    adapterSourceSha256: hash(path.join(__dirname, '../server-cloud-staff.cjs')),
    realPostgresClaimAcceptedByAdapter: true,
    grossCents: adopted.claim.grossTotalCents, discountCents: adopted.claim.discountCents,
    netCents: adopted.claim.netTotalCents, verifiedPaidCents: adopted.claim.verifiedPaidCents,
    state: adopted.claim.state, liveWrites: false,
    limits: ['Real local PostgreSQL with synthetic JWT/roles; controlled native Auth/RPC transport.', 'No hosted PostgREST, native SQLite admission, renderer, ACK/completion or customer-to-POS acceptance.'],
  };
  const target = path.resolve(__dirname, '../../staff-checkin-adapter-contract-20261019.json');
  fs.writeFileSync(target, JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
