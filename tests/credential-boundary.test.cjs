const test = require('node:test');
const assert = require('node:assert/strict');
const {hasPrivilegedJwt} = require('../scripts/credential-boundary.cjs');
const fs = require('node:fs');
const path = require('node:path');
const fake = claims => [Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify(claims)).toString('base64url'),'FAKE_TEST_SIGNATURE_NOT_A_REAL_CREDENTIAL'].join('.');
test('packaging guard detects a previously unknown privileged JWT in source or binary bytes without signature verification', () => {
  const key = fake({role:'service_role',ref:'qa-test-project'});
  assert.equal(hasPrivilegedJwt('const credential = "'+key+'";'),true);
  assert.equal(hasPrivilegedJwt(Buffer.concat([Buffer.from([0,255]),Buffer.from(key),Buffer.from([0,254])])),true);
  assert.equal(hasPrivilegedJwt(fake({role:'anon'})),false);
  assert.equal(hasPrivilegedJwt(fake({role:'authenticated'})),false);
  assert.equal(hasPrivilegedJwt('eyJabc.definitely_not_json.fake_signature'),false);
  assert.equal(hasPrivilegedJwt('No credentials'),false);
});
test('committed build workflows contain no readable privileged Supabase JWT', () => {
  const directory = path.join(__dirname,'../.github/workflows');
  for (const name of fs.readdirSync(directory).filter(name=>/\.ya?ml$/.test(name))) {
    assert.equal(hasPrivilegedJwt(fs.readFileSync(path.join(directory,name))),false,`Credential boundary failed for workflow ${name}`);
  }
});
