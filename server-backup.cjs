const { mkdtemp, chmod, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

function registerBackupRoutes(app, db, options = {}) {
  const middleware = Array.isArray(options.requireAdmin) ? options.requireAdmin : [options.requireAdmin];
  if (!middleware.length || middleware.some(handler => typeof handler !== 'function')) throw new TypeError('Backup downloads require administrator authorization middleware.');
  app.get('/api/backup', ...middleware, async (_req, res) => {
    let directory;
    try {
      directory = await mkdtemp(path.join(options.tempRoot || tmpdir(), 'oneshot-backup-'));
      await chmod(directory, 0o700);
      const filename = path.join(directory, 'backup.sqlite');
      // SQLite supplies a consistent snapshot including account secrets and all durable operation ledgers.
      await new Promise((resolve, reject) => db.run('VACUUM INTO ?', [filename], error => error ? reject(error) : resolve()));
      await chmod(filename, 0o600);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.type('application/vnd.sqlite3');
      await new Promise((resolve, reject) => res.download(filename, `OneShot-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`, error => error ? reject(error) : resolve()));
    } catch (_error) {
      if (!res.headersSent && !res.destroyed) res.status(503).json({ error: 'A complete backup could not be created. Retry shortly.' });
    } finally {
      // Only this request's freshly created private temporary directory is removed.
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  });
}
module.exports = { registerBackupRoutes };
