// Inspect claims only; never include a matched credential in diagnostics.
function hasPrivilegedJwt(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  const tokens = text.matchAll(/eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g);
  for (const token of tokens) {
    try {
      const claims = JSON.parse(Buffer.from(token[1], 'base64url').toString('utf8'));
      if (claims.role === 'service_role') return true;
    } catch { /* Non-JWT byte sequences do not contain readable role claims. */ }
  }
  return false;
}
module.exports = {hasPrivilegedJwt};
