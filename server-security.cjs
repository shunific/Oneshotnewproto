const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const HEADERS = ['content-type'];

function createAllowedOrigin({ port = 3001, development = false } = {}) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new TypeError('API port must be an integer between 1 and 65535');
  }
  const hosts = new Set(LOOPBACK_HOSTS.map(host => `${host}:${numericPort}`));
  const origins = new Set([...hosts].map(host => `http://${host}`));
  if (development) {
    LOOPBACK_HOSTS.forEach(host => origins.add(`http://${host}:5173`));
  }
  return { hosts, origins };
}

function createApiGuard(options = {}) {
  const { hosts, origins } = createAllowedOrigin(options);
  return function apiGuard(req, res, next) {
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (!hosts.has(host) || req.headers['sec-fetch-site'] === 'cross-site' ||
        (origin !== undefined && !origins.has(origin))) {
      return res.status(403).json({ error: 'Untrusted local API request' });
    }
    if (origin !== undefined) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.vary('Origin');
    }
    if (req.method === 'OPTIONS') {
      const method = req.headers['access-control-request-method'];
      const requestedHeaders = req.headers['access-control-request-headers'];
      const validHeaders = requestedHeaders === undefined ||
        (typeof requestedHeaders === 'string' && requestedHeaders.split(',')
          .every(header => HEADERS.includes(header.trim().toLowerCase())));
      if ((method !== undefined && !METHODS.includes(method)) || !validHeaders) {
        return res.status(403).json({ error: 'Unsupported local API preflight' });
      }
      res.setHeader('Access-Control-Allow-Methods', METHODS.join(', '));
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return res.status(204).end();
    }
    return next();
  };
}

module.exports = { createAllowedOrigin, createApiGuard };
