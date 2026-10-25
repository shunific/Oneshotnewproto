const fail = (status, message) => Object.assign(new Error(message), { status });
const run = (db, sql, values) => new Promise((resolve, reject) => db.run(sql, values, function(error) { error ? reject(error) : resolve(this.changes); }));
const get = (db, sql, values) => new Promise((resolve, reject) => db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));

function registerFeedbackResolutionRoutes(app, db, { requireAdmin } = {}) {
  const middleware = Array.isArray(requireAdmin) ? requireAdmin : [requireAdmin];
  if (!middleware.length || middleware.some(fn => typeof fn !== 'function')) throw new TypeError('Administrator authorization is required for feedback resolution.');
  app.put('/api/feedback/:id', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, middleware, async (req, res) => {
    try {
      if (!(req.staff?.isAdmin === true || req.staff?.isAdmin === 1) || typeof req.staff.id !== 'string' || !req.staff.id) throw fail(403, 'Administrator access required.');
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 3 || Object.keys(body).some(key => !['status','notes','expectedActorId'].includes(key)) || body.status !== 'resolved' || typeof body.notes !== 'string' || !body.notes.trim() || body.notes.length > 2000 || typeof body.expectedActorId !== 'string' || !body.expectedActorId) throw fail(400, 'Enter a resolution summary of 1–2000 characters.');
      if (body.expectedActorId !== req.staff.id) throw fail(409, 'Account changed. Review the feedback under the current administrator account.');
      if (typeof req.params.id !== 'string' || !req.params.id || req.params.id.length > 200) throw fail(400, 'Choose an existing feedback message.');
      const notes = body.notes.trim();
      // A completed resolution is immutable here. Exact retries are harmless;
      // a stale second administrator cannot overwrite the first saved summary.
      await run(db, "UPDATE feedback SET status='resolved',notes=? WHERE id=? AND (status='pending' OR status IS NULL)", [notes,req.params.id]);
      const saved = await get(db, 'SELECT id,status,notes FROM feedback WHERE id=?', [req.params.id]);
      if (!saved) throw fail(404, 'Feedback message was not found. Refresh the list.');
      if (saved.status !== 'resolved' || saved.notes !== notes) throw fail(409, 'Feedback changed or was already resolved. Refresh before continuing.');
      res.json(saved);
    } catch (error) {
      res.status(error.status || 503).json({ error: error.status ? error.message : 'Resolution could not be confirmed. Your notes have been kept; retry or refresh to review the saved status.' });
    }
  });
}
module.exports = { registerFeedbackResolutionRoutes };
