const CLOUD_UNAVAILABLE = 'Secure cloud synchronization has not been configured.';
function registerCloudRoutes(app) {
  // Real /api/sync-to-cloud is handled directly in server.cjs with full Supabase integration
}
module.exports = { registerCloudRoutes, CLOUD_UNAVAILABLE };
