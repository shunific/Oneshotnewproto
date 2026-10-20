import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { sendPasswordReset, assertBookingSnapshot } from './verifiedWrites.js';

function apiClient(status, response, inspect = () => {}) {
  return createClient('https://qa.example.test', 'qa-publishable-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (url, options) => {
        inspect(url, options);
        return new Response(JSON.stringify(response), {
          status, headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  });
}

test('password reset reports the actual rate-limit error', async () => {
  const client = apiClient(429, { code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' });
  await assert.rejects(sendPasswordReset(client, 'qa@example.test', 'https://qa.example.test/reset-password'), /email rate limit exceeded/);
});

test('accepted password reset reaches the requested redirect', async () => {
  const client = apiClient(200, {}, (url) => {
    assert.equal(new URL(url).searchParams.get('redirect_to'), 'https://qa.example.test/reset-password');
  });
  await sendPasswordReset(client, 'qa@example.test', 'https://qa.example.test/reset-password');
});

test('booking write rechecks current readiness and snapshot after an asynchronous upload', async () => {
  const snapshot = { ready: true, key: 'original-snapshot' };
  const expectedKey = snapshot.key;
  await Promise.resolve();
  snapshot.ready = false;
  assert.throws(() => assertBookingSnapshot(snapshot, expectedKey), /changed/);
  snapshot.ready = true;
  snapshot.key = 'changed-rate-or-availability';
  assert.throws(() => assertBookingSnapshot(snapshot, expectedKey), /changed/);
  assert.doesNotThrow(() => assertBookingSnapshot(snapshot, snapshot.key));
});
