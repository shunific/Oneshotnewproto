const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { registerCloudRoutes, CLOUD_UNAVAILABLE } = require('../server-cloud.cjs');

test('desktop cloud routes fail closed without accepting uploads or claiming backup success', () => {
  const routes = new Map();
  registerCloudRoutes({ post: (path, handler) => routes.set(path, handler) });
  for (const path of ['/api/sync-to-cloud', '/api/images']) {
    let status, body;
    routes.get(path)({}, { status(value) { status = value; return this; }, json(value) { body = value; } });
    assert.equal(status, 503);
    assert.deepEqual(body, { error: CLOUD_UNAVAILABLE, code: 'CLOUD_NOT_CONFIGURED' });
  }
});

test('desktop cloud adapter never makes a network request or invents persisted data/URLs', async () => {
  const source = readFileSync(resolve(__dirname, '../src/app/utils/cloudDisabled.js'), 'utf8');
  const { createDisabledCloudClient } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const client = createDisabledCloudClient();
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = () => { requests++; throw new Error('Network forbidden'); };
  try {
    const operations = [
      client.from('reservations').select('*').eq('id', 'QA').single(),
      client.from('tables').update({ status: 'available' }).eq('id', 'QA').select(),
      client.from('reservations').insert([{ id: 'QA' }]).then(value => value),
      client.from('reservations').delete().eq('id', 'QA'),
      client.rpc('secure_booking', {}),
      client.storage.from('oneshot-assets').upload('QA.png', Buffer.from('QA')),
      client.storage.from('oneshot-assets').getPublicUrl('QA.png'),
    ];
    for (const operation of operations) {
      const result = await operation;
      assert.equal(result.status, 503);
      assert.equal(result.data, null);
      assert.equal(result.error.code, 'CLOUD_NOT_CONFIGURED');
      assert.equal(result.error.message, CLOUD_UNAVAILABLE);
    }
    assert.equal(requests, 0);
  } finally { global.fetch = originalFetch; }
});
