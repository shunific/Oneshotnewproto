const sqlite3 = require('sqlite3');
const { randomUUID } = require('node:crypto');
const failure = (status, message) => Object.assign(new Error(message), { status });
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function(error) { error ? reject(error) : resolve(this); }));
const get = (db, sql, args = []) => new Promise((resolve, reject) => db.get(sql, args, (error, row) => error ? reject(error) : resolve(row)));
const close = db => new Promise(resolve => db.close(resolve));
const normalizeReference = value => value.trim().toUpperCase().replace(/[\s-]/g, '');
const strictCents = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) throw failure(409, 'Stored refund liability is invalid. Reconcile the receipt before recording a return.');
  return Math.round(value * 100);
};
const auditFromRow = row => row ? ({ id: row.id, receiptId: row.receipt_id, requestId: row.request_id, amountCents: row.amount_cents, method: row.method, reference: row.reference, reason: row.reason, actorId: row.actor_id, actorName: row.actor_name, createdAt: row.created_at }) : null;
async function connect(dbPath, readonly = false) {
  const db = await new Promise((resolve, reject) => { const connection = new sqlite3.Database(dbPath, readonly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE, error => error ? reject(error) : resolve(connection)); });
  db.configure('busyTimeout', 5000);
  try { await run(db, 'PRAGMA foreign_keys = ON'); }
  catch (error) { await close(db); throw error; }
  return db;
}
async function initializeRefundSchema(db) {
  await run(db, `CREATE TABLE IF NOT EXISTS receipt_refund_returns (
    id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL UNIQUE REFERENCES e_receipts(id) ON DELETE RESTRICT, request_id TEXT NOT NULL UNIQUE,
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0), method TEXT NOT NULL CHECK(method IN ('cash','gcash')),
    reference TEXT, reference_normalized TEXT, reason TEXT NOT NULL,
    actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, created_at TEXT NOT NULL, request_fingerprint TEXT NOT NULL
  )`);
  await run(db, "CREATE UNIQUE INDEX IF NOT EXISTS receipt_refund_returns_gcash_reference ON receipt_refund_returns(reference_normalized) WHERE method='gcash'");
}
function administrator(req) {
  if (!(req.staff?.isAdmin === true || req.staff?.isAdmin === 1) || typeof req.staff.id !== 'string' || !req.staff.id.trim()) throw failure(403, 'Administrator sign-in is required to record a refund return.');
}
function payloadOf(body) {
  const allowed = new Set(['requestId','expectedActorId','expectedRefundDueCents','method','reference','reason','acknowledgedReturned']);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.has(key))) throw failure(400, 'Unsupported refund return fields.');
  if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(body.requestId)) throw failure(400, 'A unique refund return request ID is required.');
  if (typeof body.expectedActorId !== 'string' || !body.expectedActorId.trim() || body.expectedActorId.length > 128) throw failure(400, 'The administrator account expected by this review is required.');
  if (!Number.isSafeInteger(body.expectedRefundDueCents) || body.expectedRefundDueCents <= 0) throw failure(400, 'The exact positive refund amount in cents is required.');
  if (!['cash','gcash'].includes(body.method) || body.acknowledgedReturned !== true || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000) throw failure(400, 'Confirm the full return and provide its method and reason.');
  if (body.reference !== undefined && (typeof body.reference !== 'string' || body.reference.length > 128)) throw failure(400, 'Payment reference must contain at most 128 characters.');
  if (body.method === 'gcash' && (typeof body.reference !== 'string' || !/^[A-Za-z0-9 -]+$/.test(body.reference) || normalizeReference(body.reference).length < 3)) throw failure(400, 'GCash reference must use letters, numbers, spaces or hyphens and contain at least 3 letters or digits.');
  return body;
}
function registerRefundRoutes(app, dbPath, options = {}) {
  const { requireAdmin } = options;
  if (typeof requireAdmin !== 'function' && (!Array.isArray(requireAdmin) || !requireAdmin.length || requireAdmin.some(handler => typeof handler !== 'function'))) throw new Error('Refund routes require administrator authentication middleware.');
  const privateResponse = (req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); next(); };
  const respond = operation => async (req, res) => {
    try { administrator(req); res.json(await operation(req)); }
    catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'Refund return could not be confirmed. Retry the same request.', fundsTransferred: false, ...(error.code === 'ACCOUNT_CHANGED' ? { code: 'ACCOUNT_CHANGED' } : {}), ...(error.nonCommitting === true ? { committed: false } : {}) }); }
  };
  app.get('/api/e-receipts/:id/refund-return', privateResponse, requireAdmin, respond(async req => {
    const db = await connect(dbPath, true);
    let begun = false;
    try {
      await run(db, 'BEGIN'); begun = true;
      const receipt = await get(db, 'SELECT * FROM e_receipts WHERE id = ?', [req.params.id]);
      if (!receipt) throw failure(404, 'Receipt was not found.');
      const exists = await get(db, "SELECT name FROM sqlite_master WHERE type='table' AND name='receipt_refund_returns'");
      const audit = exists ? await get(db, 'SELECT * FROM receipt_refund_returns WHERE receipt_id = ?', [receipt.id]) : null;
      await run(db, 'COMMIT'); begun = false;
      return { receipt, refundReturn: auditFromRow(audit), fundsTransferred: false };
    } catch (error) {
      if (begun) await run(db, 'ROLLBACK').catch(() => {});
      throw error;
    } finally { await close(db); }
  }));
  app.post('/api/e-receipts/:id/refund-return', privateResponse, requireAdmin, respond(async req => {
    let body;
    try {
      body = payloadOf(req.body);
      if (body.expectedActorId !== req.staff.id) throw Object.assign(failure(409, 'Administrator account changed. Review this refund under the current account before submitting.'), { code: 'ACCOUNT_CHANGED' });
    } catch (error) { if ([400,409].includes(error.status)) error.nonCommitting = true; throw error; }
    const fingerprint = JSON.stringify({ receiptId: req.params.id, actorId: req.staff.id, body: Object.fromEntries(Object.keys(body).sort().map(key => [key, body[key]])) });
    const db = await connect(dbPath); let begun = false;
    try {
      await run(db, 'BEGIN IMMEDIATE'); begun = true;
      const receipt = await get(db, 'SELECT * FROM e_receipts WHERE id = ?', [req.params.id]);
      if (!receipt) throw failure(404, 'Receipt was not found.');
      const amountCents = strictCents(receipt.refund_due);
      if (amountCents !== body.expectedRefundDueCents) throw failure(409, 'Refund amount changed. Review the current receipt before recording a return.');
      await initializeRefundSchema(db);
      const previousRequest = await get(db, 'SELECT * FROM receipt_refund_returns WHERE request_id = ?', [body.requestId]);
      if (previousRequest) {
        if (previousRequest.receipt_id !== receipt.id || previousRequest.actor_id !== req.staff.id || previousRequest.request_fingerprint !== fingerprint) throw failure(409, 'Request ID was already used for a different refund return.');
        if (receipt.refund_status !== 'returned') throw failure(409, 'Refund return audit and receipt disagree. Reconcile this receipt.');
        await run(db, 'COMMIT'); begun = false;
        return { receipt, refundReturn: auditFromRow(previousRequest), fundsTransferred: false, replayed: true };
      }
      if (receipt.refund_status !== 'pending') throw failure(409, 'This receipt has no pending refund return.');
      if (await get(db, 'SELECT id FROM receipt_refund_returns WHERE receipt_id = ?', [receipt.id])) throw failure(409, 'A full refund return was already recorded for this receipt.');
      const reference = body.reference === undefined ? null : body.reference.trim();
      const normalized = body.method === 'gcash' ? normalizeReference(body.reference) : null;
      if (normalized && await get(db, "SELECT id FROM receipt_refund_returns WHERE method='gcash' AND reference_normalized = ?", [normalized])) throw failure(409, 'This GCash reference was already used for a refund return.');
      const audit = { id: randomUUID(), receipt_id: receipt.id, request_id: body.requestId, amount_cents: amountCents, method: body.method, reference, reference_normalized: normalized, reason: body.reason.trim(), actor_id: req.staff.id, actor_name: req.staff.fullName || req.staff.username || req.staff.id, created_at: new Date().toISOString(), request_fingerprint: fingerprint };
      const columns = Object.keys(audit);
      await run(db, `INSERT INTO receipt_refund_returns (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(audit));
      const changed = await run(db, "UPDATE e_receipts SET refund_status='returned' WHERE id = ? AND refund_status='pending' AND refund_due = ?", [receipt.id,receipt.refund_due]);
      if (changed.changes !== 1) throw failure(409, 'Refund changed before confirmation. Review the current receipt.');
      await run(db, 'COMMIT'); begun = false;
      return { receipt: { ...receipt, refund_status: 'returned' }, refundReturn: auditFromRow(audit), fundsTransferred: false, replayed: false };
    } catch (error) {
      if (begun) {
        try { await run(db, 'ROLLBACK'); }
        catch { throw failure(503, 'Refund return outcome could not be confirmed. Retry the same saved request before making changes.'); }
        if ([400,404,409].includes(error.status)) error.nonCommitting = true;
      }
      throw error;
    } finally { await close(db); }
  }));
}
module.exports = { registerRefundRoutes };
