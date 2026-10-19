const test = require('node:test');
const assert = require('node:assert/strict');
const { createCloudStaffService } = require('../server-cloud-staff.cjs');

const staffId = '11111111-1111-4111-8111-111111111111';
const command = {
  requestId: '44444444-4444-4444-8444-444444444444',
  id: 'QA-BOUNDARY-CLAIM', expectedRevision: 3, expectedStaffId: staffId,
  deviceId: '33333333-3333-4333-8333-333333333333', tableId: 'local-table',
};
function authoritativeReply() {
  return {
    claim: {
      claimId: '55555555-5555-4555-8555-555555555555',
      requestId: command.requestId, reservationId: command.id,
      actorUserId: staffId, actorRole: 'cashier',
      deviceId: command.deviceId, tableId: command.tableId, cloudTableId: 'cloud-table',
      ownerUserId: '22222222-2222-4222-8222-222222222222',
      sourceRevision: 3, claimRevision: 4, state: 'claim-pending',
      customerName: 'QA Boundary TEST ONLY', contactNumber: '09123456789',
      email: 'qa@example.invalid', partySize: 2, durationMinutes: 120,
      bookingDate: '2026-10-19', timeSlot: '14:00',
      netTotalCents: 27000, grossTotalCents: 30000, discountCents: 3000,
      requiredDepositCents: 5400, verifiedPaidCents: 5400,
    },
    replayed: false, recordType: 'reservation-check-in-claim', fundsTransferred: false,
  };
}
async function connectedService(reply) {
  const json = body => new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
  const service = createCloudStaffService({
    enabled: true, key: 'sb_publishable_' + 'x'.repeat(30),
    isLocalSessionActive: async () => true,
    fetchImpl: async url => {
      if (url.includes('/auth/v1/token')) return json({
        access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600,
      });
      if (url.endsWith('/oneshot_staff_identity')) return json({
        userId: staffId, venueId: 'oneshot', role: 'cashier', email: 'staff@example.invalid',
      });
      if (url.endsWith('/oneshot_staff_claim_checkin')) return json(reply);
      throw new Error('Unexpected transport endpoint');
    },
  });
  await service.connect('qa-local', 'staff@example.invalid', 'existing-test-password');
  return service;
}

test('claim boundary rejects nested JSON and primitive type substitutions for every authoritative field', async () => {
  const baseline = authoritativeReply();
  const valid = await connectedService(baseline);
  assert.deepEqual(await valid.claimCheckin('qa-local', command), baseline);
  let rejected = 0;
  for (const [field, original] of Object.entries(baseline.claim)) {
    for (const hostile of [null, [], {}, true, false, 0, ['14:00'], { value: '14:00' }]) {
      if ((typeof hostile === typeof original && !Array.isArray(hostile)) ||
          (field === 'email' && hostile === null)) continue;
      const reply = authoritativeReply();
      reply.claim[field] = hostile;
      const service = await connectedService(reply);
      await assert.rejects(service.claimCheckin('qa-local', command),
        { code: 'CLOUD_RESPONSE_INVALID', status: 503 },
        `${field}: ${JSON.stringify(hostile)}`);
      rejected++;
    }
  }
  assert.equal(rejected, 182);
});
