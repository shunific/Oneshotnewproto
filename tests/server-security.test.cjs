const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiGuard, createAllowedOrigin } = require('../server-security.cjs');

function request(headers = {}, options = {}, method = 'GET') {
  const result = { status: 200, headers: {}, next: false };
  const res = {
    status(value) { result.status = value; return this; },
    json(value) { result.body = value; return this; },
    setHeader(key, value) { result.headers[key] = value; },
    vary(value) { result.headers.Vary = value; },
    end() { result.ended = true; return this; },
  };
  createApiGuard(options)({ headers: { host: 'localhost:3001', ...headers }, method }, res,
    () => { result.next = true; });
  return result;
}

test('accepts exact loopback hosts and same-server origins', () => {
  for (const host of ['localhost:3001', '127.0.0.1:3001', '[::1]:3001']) {
    const result = request({ host, origin: `http://${host}` });
    assert.equal(result.next, true);
    assert.equal(result.headers['Access-Control-Allow-Origin'], `http://${host}`);
    assert.equal(result.headers.Vary, 'Origin');
  }
});

test('allows local nonbrowser clients without adding wildcard CORS', () => {
  const result = request();
  assert.equal(result.next, true);
  assert.equal(result.headers['Access-Control-Allow-Origin'], undefined);
});

test('rejects malicious, ambiguous, missing and wrong-port Host values', () => {
  for (const host of [undefined, 'attacker.test:3001', 'localhost.attacker.test:3001',
    'localhost:5173', 'localhost', '127.1:3001', '2130706433:3001',
    'localhost:3001@attacker.test', 'localhost:3001,attacker.test', ['localhost:3001']]) {
    assert.equal(request({ host }).status, 403, String(host));
  }
});

test('rejects untrusted origins even for simple GET and POST requests', () => {
  for (const origin of ['https://attacker.test', 'null', 'http://localhost:5173',
    'http://localhost:3001.attacker.test', 'http://localhost:3001/',
    'https://localhost:3001', ['http://localhost:3001']]) {
    for (const method of ['GET', 'POST']) {
      const result = request({ origin }, {}, method);
      assert.equal(result.status, 403, String(origin));
      assert.equal(result.next, false);
    }
  }
});

test('cross-site fetch metadata is rejected with and without Origin', () => {
  assert.equal(request({ 'sec-fetch-site': 'cross-site' }).status, 403);
  assert.equal(request({ origin: 'http://localhost:3001', 'sec-fetch-site': 'cross-site' }).status, 403);
});

test('development frontend is allowed only by explicit configuration', () => {
  assert.equal(request({ origin: 'http://localhost:5173' }, { development: true }).next, true);
  assert.equal(request({ origin: 'http://localhost:5173' }).status, 403);
});

test('custom server ports replace the default host and origin', () => {
  assert.equal(request({ host: '127.0.0.1:4100', origin: 'http://127.0.0.1:4100' }, { port: 4100 }).next, true);
  assert.equal(request({}, { port: 4100 }).status, 403);
  for (const port of [0, 65536, 'invalid', 1.5]) {
    assert.throws(() => createAllowedOrigin({ port }), TypeError);
  }
});

test('handles trusted preflight without reaching route handlers', () => {
  const result = request({ origin: 'http://localhost:3001',
    'access-control-request-method': 'PUT', 'access-control-request-headers': 'Content-Type' }, {}, 'OPTIONS');
  assert.equal(result.status, 204);
  assert.equal(result.next, false);
  assert.equal(result.ended, true);
  assert.equal(result.headers['Access-Control-Allow-Headers'], 'Content-Type');
  assert.equal(request({ origin: 'https://attacker.test' }, {}, 'OPTIONS').status, 403);
  assert.equal(request({ 'access-control-request-method': 'TRACE' }, {}, 'OPTIONS').status, 403);
  assert.equal(request({ 'access-control-request-headers': 'X-Untrusted' }, {}, 'OPTIONS').status, 403);
});
