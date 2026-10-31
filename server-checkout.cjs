const { assertTableNotHeld } = require('./server-reservation-moves.cjs');
const sqlite3 = require('sqlite3');
const { randomUUID } = require('node:crypto');
const fail = (status, message) => Object.assign(new Error(message), { status });
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function(error) { error ? reject(error) : resolve(this); }));
const get = (db, sql, args = []) => new Promise((resolve, reject) => db.get(sql, args, (error, row) => error ? reject(error) : resolve(row)));
const all = (db, sql) => new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
const close = db => new Promise(resolve => db.close(resolve));
const { canonicalSession } = require('./server-session-identity.cjs');
const { recordReservationCompletion, verifyReservationCompletionReplay } = require('./server-reservation-completion.cjs');
function money(value, status = 409) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) throw fail(status, 'Amounts must be nonnegative currency values with at most two decimal places.');
  return Math.round(value * 100);
}
const { calculateSessionBill } = require('./session-billing.mjs');
const calculateCheckout = calculateSessionBill;
async function initializeCheckoutSchema(db) {
  await run(db, 'CREATE TABLE IF NOT EXISTS checkout_operations (request_id TEXT PRIMARY KEY, table_id TEXT NOT NULL, session_start TEXT NOT NULL, request_fingerprint TEXT NOT NULL, response_json TEXT NOT NULL)');
  const columns = new Set((await all(db, 'PRAGMA table_info(e_receipts)')).map(column => column.name));
  if (!columns.size) throw new Error('Receipt schema is unavailable.');
  for (const [name, definition] of [['booking_discount_amount', 'REAL'], ['reservation_claim_id', 'TEXT'], ['owner_user_id', 'TEXT'], ['customer_email', 'TEXT'], ['customer_phone', 'TEXT'], ['overtime_minutes', 'INTEGER'], ['overtime_rate', 'REAL'], ['pricing_version', 'INTEGER'], ['refund_due', 'REAL NOT NULL DEFAULT 0'], ['refund_status', "TEXT NOT NULL DEFAULT 'none'"], ['payment_reference', 'TEXT'], ['original_amount', 'REAL NOT NULL DEFAULT 0'], ['void_reason', 'TEXT'], ['void_actor_id', 'TEXT'], ['void_actor_name', 'TEXT']]) {
    if (!columns.has(name)) await run(db, `ALTER TABLE e_receipts ADD COLUMN ${name} ${definition}`);
  }
}
function registerCheckoutRoutes(app, dbPath) {
  app.post('/api/tables/:id/checkout', async (req, res) => {
    let db, begun = false;
    try {
      const body = req.body || {};
      if (Object.prototype.hasOwnProperty.call(body, 'tableId')) throw fail(400, 'The checkout table is selected by its route, not the payment form.');
      if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(body.requestId) || typeof body.expectedSessionStartTime !== 'string' || !Number.isFinite(Date.parse(body.expectedSessionStartTime)) || !body.expectedSession || typeof body.expectedSession !== 'object' || Array.isArray(body.expectedSession)) throw fail(400, 'A request ID and complete expected session are required.');
      if (!['paid','partial','unpaid'].includes(body.paymentStatus) || !['cash','gcash'].includes(body.paymentMethod) || typeof body.useProrated !== 'boolean') throw fail(400, 'Invalid checkout payment options.');
      if (body.closureKind !== undefined && !['checkout','walkout','void'].includes(body.closureKind)) throw fail(400, 'Invalid closure kind.');
      const isVoid = body.closureKind === 'void';
      if (isVoid && (!(req.staff?.isAdmin === true || req.staff?.isAdmin === 1) || typeof req.staff.id !== 'string' || !req.staff.id)) throw fail(403, 'Administrator sign-in is required to void a session.');
      if (isVoid && (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000)) throw fail(400, 'A reason of at most 1000 characters is required for session void.');
      if (isVoid && (body.paymentStatus !== 'unpaid' || body.tendered !== 0 || body.paymentMethod !== 'cash' || body.useProrated !== false)) throw fail(400, 'Session void cannot collect payment or change the billing mode.');
      if (body.closureKind === 'walkout' && (body.paymentStatus !== 'unpaid' || body.tendered !== 0)) throw fail(400, 'Walkout cannot record a new payment.');
      const tendered = money(body.tendered, 400);
      if (body.paymentMethod === 'gcash' && tendered > 0 && (typeof body.paymentReference !== 'string' || !body.paymentReference.trim() || body.paymentReference.length > 128)) throw fail(400, 'A payment reference is required for GCash.');
      const start = new Date(body.expectedSessionStartTime).toISOString();
      if (Date.parse(body.expectedSession.startTime) !== Date.parse(start)) throw fail(400, 'Expected session identity does not match.');
      const fingerprint = canonicalSession({ ...body, tableId: req.params.id });
      db = await new Promise((resolve, reject) => { const conn = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, error => error ? reject(error) : resolve(conn)); });
      db.configure('busyTimeout', 5000);
      await run(db, 'BEGIN IMMEDIATE'); begun = true;
      await initializeCheckoutSchema(db);
      const saved = await get(db, 'SELECT * FROM checkout_operations WHERE request_id = ?', [body.requestId]);
      if (saved) {
        if (saved.table_id !== req.params.id || saved.session_start !== start || saved.request_fingerprint !== fingerprint) throw fail(409, 'Request ID was already used for a different checkout.');
        const response = JSON.parse(saved.response_json);
        await verifyReservationCompletionReplay(db, response, body.expectedSession);
        await run(db, 'COMMIT'); begun = false;
        return res.json({ ...response, replayed: true });
      }
      if (body.paymentMethod === 'gcash' && tendered > 0) {
        const reference = body.paymentReference.trim();
        if (reference.length > 120 || !/^[A-Za-z0-9 -]+$/.test(reference) || reference.replace(/[ -]/g, '').length < 3) throw fail(400, 'GCash reference must contain at least three letters or digits and only letters, digits, spaces or hyphens (maximum 120 characters).');
      }
      await assertTableNotHeld(db,req.params.id);
      const table = await get(db, 'SELECT * FROM tables WHERE id = ?', [req.params.id]);
      if (!table) throw fail(404, 'Table was not found.');
      if (table.status !== 'occupied' || table.isActive !== 1) throw fail(409, 'Table has no active session.');
      let session; try { session = JSON.parse(table.sessionData); } catch { throw fail(409, 'Stored session is invalid.'); }
      if (!session || Date.parse(session.startTime) !== Date.parse(start) || canonicalSession(session) !== canonicalSession(body.expectedSession)) throw fail(409, 'Session changed. Refresh and review the current bill before checkout.');
      const now = Date.now(); const originalCharges = calculateCheckout(session, now, body.useProrated);
      const charges = isVoid ? { ...originalCharges, tableCents: 0, overtimeCents: 0, fnbCents: 0, totalCents: 0, balanceCents: 0, refundCents: originalCharges.alreadyPaid } : originalCharges;
      if (body.paymentStatus === 'paid' && tendered < charges.balanceCents) throw fail(400, 'Tendered amount does not settle the balance.');
      if (body.paymentStatus === 'partial' && (tendered <= 0 || tendered >= charges.balanceCents)) throw fail(400, 'Partial payment must be greater than zero and below the balance.');
      if (body.paymentStatus === 'unpaid' && tendered !== 0) throw fail(400, 'Unpaid checkout cannot record a payment.');
      if (body.paymentMethod === 'gcash' && tendered > charges.balanceCents) throw fail(400, 'GCash payment cannot exceed the balance.');
      const applied = Math.min(tendered, charges.balanceCents);
      const paid = Math.min(charges.totalCents, charges.alreadyPaid + applied);
      const balance = charges.balanceCents - applied;
      const settledAt = new Date(now).toISOString();
      const playEnd = session.pricingVersion === 1 && session.isOpenTime === true && Object.hasOwn(session, 'latestEndTime') ? Math.min(now, Date.parse(session.latestEndTime)) : now;
      const end = new Date(playEnd).toISOString(); const id = randomUUID();
      const status = isVoid ? 'voided' : body.closureKind === 'walkout' ? 'walkout' : charges.refundCents > 0 ? 'refund_pending' : !session.isOpenTime && charges.elapsedMins < session.durationMinutes ? 'ended_early' : charges.overtimeMins > 0 ? 'completed_overtime' : 'completed';
      const history = { id, customerName: session.customerName, tableId: table.id, tableName: table.name, startTime: start, endTime: end, durationMinutes: charges.elapsedMins, totalAmount: charges.totalCents / 100, amountPaid: paid / 100, orders: session.orders || [], status, closureReason: isVoid ? `Voided by ${req.staff.fullName || req.staff.username || req.staff.id} (${req.staff.id}). Reason: ${body.reason.trim()}. Original bill ₱${(originalCharges.totalCents / 100).toFixed(2)} waived; consumed inventory remains deducted.${charges.refundCents > 0 ? ` Prepaid refund ₱${(charges.refundCents / 100).toFixed(2)} pending return.` : ''}` : charges.refundCents > 0 ? 'Checkout committed; prepaid refund is due and has not been acknowledged as returned.' : 'Checkout committed with payment and receipt.', partySize: session.partySize || 2 };
      await run(db, 'INSERT INTO session_history (id,customerName,tableId,tableName,startTime,endTime,durationMinutes,totalAmount,amountPaid,orders,status,closureReason,partySize) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [id,history.customerName,table.id,table.name,start,end,history.durationMinutes,history.totalAmount,history.amountPaid,JSON.stringify(history.orders),status,history.closureReason,history.partySize]);
      const receipt = { id, receipt_no: `REC-${id}`, reservation_id: session.reservationId || null, customer_name: session.customerName, customer_email: session.pricingVersion === 2 ? session.customerEmail || null : null, customer_phone: session.pricingVersion === 2 ? session.customerPhone || null : null, booking_discount_amount: session.pricingVersion === 2 ? originalCharges.discountCents / 100 : null, reservation_claim_id: session.pricingVersion === 2 ? session.reservationPricing.claimId : null, owner_user_id: session.pricingVersion === 2 ? session.reservationPricing.ownerUserId : null, table_id: table.id, table_name: table.name, play_start_time: start, play_end_time: end, duration_minutes: charges.elapsedMins, table_rate: session.hourlyRate, overtime_minutes: originalCharges.overtimeMins, overtime_rate: originalCharges.overtimeRateCents / 100, pricing_version: originalCharges.pricingVersion, table_charge: originalCharges.tableCents / 100, overtime_charge: originalCharges.overtimeCents / 100, fnb_charge: originalCharges.fnbCents / 100, subtotal: (originalCharges.totalCents + originalCharges.discountCents) / 100, discount_amount: (originalCharges.discountCents + (isVoid ? originalCharges.totalCents : 0)) / 100, total_amount: charges.totalCents / 100, amount_paid: paid / 100, balance_due: balance / 100, payment_method: body.paymentMethod, payment_status: isVoid ? charges.refundCents > 0 ? 'voided_refund_pending' : 'voided' : charges.refundCents > 0 ? 'refund_pending' : balance === 0 ? 'paid' : applied + charges.alreadyPaid > 0 ? 'partial' : 'unpaid', refund_due: charges.refundCents / 100, refund_status: charges.refundCents > 0 ? 'pending' : 'none', payment_reference: body.paymentMethod === 'gcash' && tendered > 0 ? body.paymentReference.trim() : null, original_amount: originalCharges.totalCents / 100, void_reason: isVoid ? body.reason.trim() : null, void_actor_id: isVoid ? req.staff.id : null, void_actor_name: isVoid ? req.staff.fullName || req.staff.username || req.staff.id : null, created_at: settledAt };
      const columns = Object.keys(receipt);
      await run(db, `INSERT INTO e_receipts (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(receipt));
      if (balance > 0) {
        const debtName = typeof body.debtName === 'string' && body.debtName.trim() ? body.debtName.trim().slice(0,200) : session.customerName;
        const contact = typeof body.debtContact === 'string' ? body.debtContact.trim().slice(0,200) : '';
        await run(db, 'INSERT INTO watchlist (id,name,reason,description,status,dateAdded,isArchived) VALUES (?,?,?,?,?,?,0)', [randomUUID(),debtName,body.closureKind === 'walkout' ? 'theft' : 'debt',`Unpaid balance of ₱${(balance/100).toFixed(2)} at ${table.name}. ${contact ? `Contact: ${contact}. ` : ''}Receipt: ${receipt.receipt_no}`,'active',settledAt]);
      }
      await run(db, "UPDATE tables SET status = 'available',sessionData = NULL WHERE id = ?", [table.id]);
      const response = { id: table.id, requestId: body.requestId, receipt, history, table: {id: table.id,status:'available',session:null}, replayed:false, alreadyPaid: charges.alreadyPaid / 100, totalPaidNow: applied / 100, tendered: tendered / 100, paymentReference: body.paymentReference || null, change: Math.max(0,tendered-charges.balanceCents)/100, refundDue: charges.refundCents / 100 };
      if (session.pricingVersion === 2) response.reservationCompletion = await recordReservationCompletion(db, { session, response, staff: req.staff, closureKind: body.closureKind || 'checkout' });
      await run(db, 'INSERT INTO checkout_operations VALUES (?,?,?,?,?)', [body.requestId,table.id,start,fingerprint,JSON.stringify(response)]);
      await run(db, 'COMMIT'); begun = false;
      res.json(response);
    } catch (error) {
      if (begun) await run(db, 'ROLLBACK').catch(() => {});
      res.status(error.status || 503).json({error: error.status ? error.message : 'Checkout could not be confirmed. Retry the same request.'});
    } finally { if (db) await close(db); }
  });
}
module.exports = { registerCheckoutRoutes, initializeCheckoutSchema, canonicalSession, calculateCheckout };
