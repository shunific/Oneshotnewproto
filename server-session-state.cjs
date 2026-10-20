const sqlite3 = require('sqlite3');
const {assertVenueAvailability}=require('./server-venue-availability.cjs');
const {reviewedOpenLimit}=require('./server-table-start.cjs');
const { randomUUID } = require('node:crypto');
const { canonicalSession } = require('./server-checkout.cjs');
const { calculateSessionBill } = require('./session-billing.mjs');
const { assertTableNotHeld } = require('./server-reservation-moves.cjs');
const fail = (status, message) => Object.assign(new Error(message), { status });
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function(error) { error ? reject(error) : resolve(this); }));
const get = (db, sql, args = []) => new Promise((resolve, reject) => db.get(sql, args, (error, row) => error ? reject(error) : resolve(row)));
const close = db => new Promise(resolve => db.close(resolve));
const open = filename => new Promise((resolve, reject) => { const db = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE, error => error ? reject(error) : resolve(db)); });
function cents(value, status = 400) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) throw fail(status, 'Amounts must be nonnegative currency values.');
  return Math.round(value * 100);
}
async function initialize(db) {
  await run(db, 'CREATE TABLE IF NOT EXISTS session_state_operations (request_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, session_start TEXT NOT NULL, request_fingerprint TEXT NOT NULL, response_json TEXT NOT NULL)');
  await run(db, 'CREATE TABLE IF NOT EXISTS session_payments (id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, table_id TEXT NOT NULL, session_start TEXT NOT NULL, amount REAL NOT NULL, payment_method TEXT NOT NULL, payment_reference TEXT, created_at TEXT NOT NULL)');
}
function sessionOf(row) {
  let session;
  try { session = JSON.parse(row.sessionData); } catch { throw fail(409, 'Stored session is invalid.'); }
  if (!session || typeof session !== 'object' || Array.isArray(session) || !Number.isFinite(Date.parse(session.startTime))) throw fail(409, 'Stored session is invalid.');
  return session;
}
function registerSessionStateRoutes(app, dbPath, { reservationMoves, readyBefore = Promise.resolve(), now = Date.now, resolveActor, isActorCurrent } = {}) {
  const ready = (async () => { await readyBefore; const db = await open(dbPath); try { db.configure('busyTimeout', 5000); await initialize(db); } finally { await close(db); } })();
  const handler = kind => async (req, res) => {
    let db, begun = false;
    try {
      await ready;
      const fresh=async()=>{if(typeof resolveActor!=='function'||typeof isActorCurrent!=='function')throw fail(503,'Staff authorization is unavailable.');const actor=await resolveActor(req.authToken);if(!actor||actor.localStaffId!==req.staff?.id||!isActorCurrent(req.authToken,actor))throw fail(403,'Staff authorization changed. Sign in again before changing play.');};
      await fresh();
      const body = req.body || {};
      const allowed = new Set(kind === 'extend' ? ['requestId','expectedSession','minutes','tendered','paymentMethod','paymentReference','expectedLatestEndTime'] : ['requestId','expectedSession','targetId','expectedTargetStatus','expectedTargetSession']);
      if (Object.keys(body).some(key => !allowed.has(key)) || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(body.requestId) || !body.expectedSession || typeof body.expectedSession !== 'object' || Array.isArray(body.expectedSession) || !Number.isFinite(Date.parse(body.expectedSession.startTime))) throw fail(400, 'A unique request ID and complete expected session are required.');
      if (kind === 'extend') {
        if (body.minutes !== 'open' && (!Number.isSafeInteger(body.minutes) || body.minutes <= 0 || body.minutes > 1440 || body.minutes % 15 !== 0)) throw fail(400, 'Extend by 15-minute increments, up to 24 hours.');
        cents(body.tendered);
        if (!['cash','gcash'].includes(body.paymentMethod) || (body.paymentReference !== undefined && (typeof body.paymentReference !== 'string' || body.paymentReference.length > 128))) throw fail(400, 'Invalid payment details.');
        if (body.paymentMethod === 'gcash' && body.tendered > 0 && !body.paymentReference?.trim()) throw fail(400, 'GCash requires a payment reference.');
      } else if (typeof body.targetId !== 'string' || !body.targetId || body.targetId === req.params.id || body.expectedTargetStatus !== 'available' || body.expectedTargetSession !== null) throw fail(400, 'Choose a different available empty table.');
      if (kind === 'move' && body.expectedSession.pricingVersion === 2) {
        if (typeof reservationMoves?.move !== 'function') throw fail(409, 'Reservation moves require the trusted cloud permit coordinator.');
        return res.json(await reservationMoves.move(req.authToken, { ...body, sourceId: req.params.id }));
      }
      const start = new Date(body.expectedSession.startTime).toISOString();
      const fingerprint = canonicalSession({ kind, sourceId: req.params.id, ...body });
      db = await open(dbPath); db.configure('busyTimeout', 5000);
      await run(db, 'BEGIN IMMEDIATE'); begun = true;await fresh();
      const previous = await get(db, 'SELECT * FROM session_state_operations WHERE request_id = ?', [body.requestId]);
      if (previous) {
        if (previous.source_id !== req.params.id || previous.session_start !== start || previous.request_fingerprint !== fingerprint) throw fail(409, 'Request ID was already used for a different session action.');
        await fresh();await run(db, 'COMMIT'); begun = false;
        return res.json({ ...JSON.parse(previous.response_json), replayed: true });
      }
      if (kind === 'extend' && body.paymentMethod === 'gcash' && body.tendered > 0) {
        const reference = body.paymentReference.trim();
        if (reference.length > 120 || !/^[A-Za-z0-9 -]+$/.test(reference) || reference.replace(/[ -]/g, '').length < 3) {
          throw fail(400, 'GCash reference must contain at least three letters or digits and only letters, digits, spaces or hyphens (maximum 120 characters).');
        }
      }
      const source = await get(db, 'SELECT * FROM tables WHERE id = ?', [req.params.id]);
      if (!source) throw fail(404, 'Source table was not found.');
      if (source.status !== 'occupied' || source.isActive !== 1) throw fail(409, 'Source table has no active session.');
      const session = sessionOf(source);
      if (kind === 'move' && session.pricingVersion === 2) throw fail(409, 'Reservation moves require the trusted cloud permit coordinator.');
      await assertTableNotHeld(db, source.id);
      if (canonicalSession(session) !== canonicalSession(body.expectedSession)) throw fail(409, 'Session changed. Refresh before continuing.');
      const billingTime = now();
      calculateSessionBill(session, billingTime, false);
      let response;
      if (kind === 'extend') {
        if (session.pricingVersion === 2) throw fail(409, 'Reservation extension requires venue-rule review.');
        const rate = cents(session.hourlyRate, 409);
        const paid = cents(session.amountPaid, 409);
        if (!rate || session.isOpenTime || !Number.isSafeInteger(session.durationMinutes) || session.durationMinutes <= 0) throw fail(409, 'Only a valid fixed-duration session can be extended.');
        const addedCharge = body.minutes === 'open' ? 0 : Math.round(rate * body.minutes / 60);
        const applied = cents(body.tendered);
        if (!Number.isSafeInteger(addedCharge) || !Number.isSafeInteger(paid + applied) || applied > addedCharge) throw fail(400, 'Extension payment cannot exceed the extension charge.');
        const updated = { ...session, durationMinutes: body.minutes === 'open' ? null : session.durationMinutes + body.minutes, isOpenTime: body.minutes === 'open', amountPaid: (paid + applied) / 100 };
        if (updated.durationMinutes !== null && !Number.isSafeInteger(updated.durationMinutes)) throw fail(409, 'Session duration is too large.');
        updated.isPaid = !updated.isOpenTime && paid + applied >= Math.round(rate * updated.durationMinutes / 60);
        updated.paymentStatus = updated.isPaid ? 'paid' : 'payLater';
        const venue=await assertVenueAvailability(db,{tableId:source.id,session:updated,now:billingTime,operation:'extend'});
        if(updated.isOpenTime){reviewedOpenLimit({isOpenTime:true,latestEndTime:body.expectedLatestEndTime},venue);updated.latestEndTime=venue.latestEndTime;}
        let payment = null;
        if (applied > 0) {
          payment = { id: randomUUID(), operationId: body.requestId, tableId: source.id, sessionStartTime: start, amount: applied / 100, paymentMethod: body.paymentMethod, paymentReference: body.paymentMethod === 'gcash' ? body.paymentReference.trim() : null, createdAt: new Date().toISOString() };
          await run(db, 'INSERT INTO session_payments VALUES (?,?,?,?,?,?,?,?)', [payment.id,payment.operationId,payment.tableId,payment.sessionStartTime,payment.amount,payment.paymentMethod,payment.paymentReference,payment.createdAt]);
        }
        await run(db, 'UPDATE tables SET sessionData = ? WHERE id = ?', [JSON.stringify(updated), source.id]);
        response = { id: source.id, requestId: body.requestId, session: updated, table: { id: source.id, status: 'occupied', session: updated }, payment, extensionCharge: addedCharge / 100, replayed: false };
      } else {
        await assertTableNotHeld(db, body.targetId);
        const target = await get(db, 'SELECT * FROM tables WHERE id = ?', [body.targetId]);
        if (!target) throw fail(404, 'Target table was not found.');
        let targetSession; try { targetSession = target.sessionData === null ? null : JSON.parse(target.sessionData); } catch { throw fail(409, 'Target table session is invalid.'); }
        if (target.status !== 'available' || target.isActive !== 1 || targetSession !== null) throw fail(409, 'Target table is no longer available.');
        const venue=await assertVenueAvailability(db,{tableId:target.id,session,now:billingTime,operation:'move'});
        if(session.isOpenTime)session.latestEndTime=venue.latestEndTime;
        await run(db, "UPDATE tables SET status = 'occupied', sessionData = ? WHERE id = ?", [JSON.stringify(session), target.id]);
        await run(db, "UPDATE tables SET status = 'available', sessionData = NULL WHERE id = ?", [source.id]);
        response = { id: source.id, requestId: body.requestId, source: { id: source.id, status: 'available', session: null }, target: { id: target.id, status: 'occupied', session }, replayed: false };
      }
      calculateSessionBill(kind === 'extend' ? response.session : response.target.session, billingTime, false);
      await run(db, 'INSERT INTO session_state_operations VALUES (?,?,?,?,?)', [body.requestId,source.id,start,fingerprint,JSON.stringify(response)]);
      await fresh();await run(db, 'COMMIT'); begun = false;
      res.json(response);
    } catch (error) {
      if (begun) await run(db, 'ROLLBACK').catch(() => {});
      res.status(error.status || 503).json({ error: error.status ? error.message : 'Session change could not be confirmed. Retry the same request.', ...(error.code?.startsWith('VENUE_')?{code:error.code}:{}), ...(error.status===409&&error.code==='NATIVE_MOVE_NOT_STARTED'&&typeof error.requestId==='string'&&typeof error.sourceId==='string'?{code:error.code,requestId:error.requestId,sourceId:error.sourceId}:{}) });
    } finally { if (db) await close(db); }
  };
  app.post('/api/tables/:id/extend', handler('extend'));
  app.post('/api/tables/:id/move', handler('move'));
  return { ready };
}
module.exports = { registerSessionStateRoutes };
