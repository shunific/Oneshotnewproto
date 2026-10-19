const CLOUD_UNAVAILABLE = 'Secure cloud synchronization has not been configured.';

function registerCloudRoutes(app) {
  const unavailable = (_req, res) => res.status(503).json({ error: CLOUD_UNAVAILABLE, code: 'CLOUD_NOT_CONFIGURED' });
  app.post('/api/sync-to-cloud', unavailable);
  app.post('/api/images', unavailable);
}

module.exports = { registerCloudRoutes, CLOUD_UNAVAILABLE };
