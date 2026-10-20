const {initializeCheckinCancellationSchema,assertCheckinRequestNotCancelled}=require('./server-checkin-cancellation.cjs');
const { assertTableNotHeld } = require('./server-reservation-moves.cjs');
const sqlite3 = require('sqlite3');
const { randomUUID, createHash } = require('node:crypto');
const { canonicalSession } = require('./server-session-identity.cjs');
const { checkinDefinitions, normalizeSql } = require('./server-checkin-schema.cjs');
const { createNativeActorGuard } = require('./server-native-actor.cjs');
const { calculateSessionBill } = require('./session-billing.mjs');
const { validateCheckinClaimResult } = require('./server-cloud-staff.cjs');
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && value === value.trim();
const fingerprint = value => createHash('sha256').update(canonicalSession(value)).digest('hex');
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function(error) { error ? reject(error) : resolve(this); }));
const get = (db, sql, args = []) => new Promise((resolve, reject) => db.get(sql, args, (error, row) => error ? reject(error) : resolve(row)));
const open = filename => new Promise((resolve, reject) => { const db = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE, error => error ? reject(error) : resolve(db)); });
const close = db => new Promise(resolve => db.close(resolve));

// Internal only. The host must supply fresh identity resolution and a synchronous
// session-generation guard; no renderer can provide these authority callbacks.
function createCheckinCoordinator(dbPath, { claimCheckin, resolveActor, isActorCurrent, now = Date.now } = {}) {
  if (typeof claimCheckin !== 'function' || typeof resolveActor !== 'function' || typeof isActorCurrent !== 'function') throw new TypeError('Trusted claim, identity and generation callbacks are required.');
  async function transaction(fn) {
    let db, begun = false;
    try {
      db = await open(dbPath); db.configure('busyTimeout', 5000);
      await run(db, 'BEGIN IMMEDIATE'); begun = true;
      const result = await fn(db);
      await run(db, 'COMMIT'); begun = false;
      return result;
    } catch (error) {
      if (begun) await run(db, 'ROLLBACK').catch(() => {});
      if (error.status) throw error;
      throw fail(503, 'CHECKIN_STORAGE_UNAVAILABLE', 'Check-in could not be confirmed. Keep the original request for recovery.');
    } finally { if (db) await close(db); }
  }
  const ready = transaction(async db => {
    await initializeCheckinCancellationSchema(db);
    for (const [name, definition] of checkinDefinitions) {
      await run(db, definition);
      const actual = await get(db, 'SELECT sql FROM sqlite_master WHERE type=? AND name=?', ['table',name]);
      if (!actual || normalizeSql(actual.sql) !== normalizeSql(definition)) throw fail(409, 'CHECKIN_SCHEMA_RECONCILIATION_REQUIRED', 'Unsupported check-in journal schema requires owner reconciliation.');
    }
    await run(db, 'INSERT OR IGNORE INTO native_checkin_device(singleton,device_id) VALUES(1,?)', [randomUUID()]);
    const device = await get(db, 'SELECT device_id FROM native_checkin_device WHERE singleton=1');
    if (!uuid(device?.device_id)) throw fail(409, 'CHECKIN_DEVICE_RECONCILIATION_REQUIRED', 'The saved device identity needs owner reconciliation.');
  });
  const { resolve: actor, assertCurrent } = createNativeActorGuard({ resolveActor, isActorCurrent }, () => fail(403, 'CHECKIN_ACCOUNT_CHANGED', 'Reconnect the original approved staff accounts before retrying.'));
  function owned(row, expected) {
    validateStored(row);
    if (row.local_staff_id !== expected.localStaffId || row.cloud_user_id !== expected.cloudUserId) throw fail(403, 'CHECKIN_ACCOUNT_CHANGED', 'This check-in belongs to a different staff account.');
  }
  function exactRequest(input) {
    const fields = ['requestId','id','expectedRevision','expectedStaffId','tableId'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== fields.length || Object.keys(input).some(k => !fields.includes(k)) || !uuid(input.requestId) || !id(input.id) || !id(input.tableId) || !uuid(input.expectedStaffId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || input.expectedRevision >= Number.MAX_SAFE_INTEGER) throw fail(400, 'INVALID_CHECKIN_REQUEST', 'Review the booking, table, revision and original request ID.');
    return { ...input };
  }
  function parse(value) {
    try { return JSON.parse(value); } catch { throw fail(409, 'CHECKIN_RECONCILIATION_REQUIRED', 'Stored check-in data is invalid. Reconcile the original operation.'); }
  }
  function validateStored(row) {
    try {
      if (!row || !id(row.local_staff_id)) throw Error('Invalid owner');
      const payload = parse(row.request_json), { deviceId, ...command } = payload;
      exactRequest(command);
      if (!uuid(deviceId) || row.request_fingerprint !== fingerprint(payload) || row.request_id !== payload.requestId || row.cloud_user_id !== payload.expectedStaffId || row.device_id !== deviceId || row.reservation_id !== payload.id || row.table_id !== payload.tableId) throw Error('Mismatched journal binding');
      if (row.phase !== 'prepared' && (!uuid(row.claim_id) || parse(row.claim_json).claimId !== row.claim_id)) throw Error('Mismatched claim record');
    } catch { throw fail(409, 'CHECKIN_RECONCILIATION_REQUIRED', 'Stored check-in bindings require reconciliation before recovery.'); }
  }
  function claimSession(claim, overtimeRate, startTime) {
    return { customerName: claim.customerName, customerEmail: claim.email, customerPhone: claim.contactNumber,
      reservationId: claim.reservationId, partySize: claim.partySize, startTime,
      durationMinutes: claim.durationMinutes, isOpenTime: false, hourlyRate: null, overtimeRate, pricingVersion: 2,
      amountPaid: claim.verifiedPaidCents / 100, isPaid: claim.verifiedPaidCents === claim.netTotalCents,
      paymentStatus: claim.verifiedPaidCents === claim.netTotalCents ? 'paid' : 'payLater', orders: [],
      reservationPricing: { claimId: claim.claimId, reservationId: claim.reservationId, ownerUserId: claim.ownerUserId,
        sourceRevision: claim.sourceRevision, claimRevision: claim.claimRevision, durationMinutes: claim.durationMinutes,
        grossCents: claim.grossTotalCents, discountCents: claim.discountCents, netCents: claim.netTotalCents, verifiedPaidCents: claim.verifiedPaidCents } };
  }
  function verifyClaim(claim, payload) {
    validateCheckinClaimResult({ claim, replayed: true, recordType: 'reservation-check-in-claim', fundsTransferred: false }, payload);
    if (!claim || claim.state !== 'claim-pending' || !uuid(claim.claimId) || claim.requestId !== payload.requestId || claim.actorUserId !== payload.expectedStaffId || claim.deviceId !== payload.deviceId || claim.tableId !== payload.tableId || claim.reservationId !== payload.id || claim.sourceRevision !== payload.expectedRevision || typeof claim.customerName !== 'string' || typeof claim.contactNumber !== 'string' || !Number.isSafeInteger(claim.partySize) || claim.partySize < 1) throw fail(409, 'CHECKIN_CLAIM_MISMATCH', 'The saved claim does not match the original check-in.');
    calculateSessionBill(claimSession(claim, 1, new Date(now()).toISOString()), now(), false);
  }
  async function claim(token, input) {
    const command = exactRequest(input);
    await ready;
    const expected = await actor(token, command.expectedStaffId);
    const prepared = await transaction(async db => {
      const device = await get(db, 'SELECT device_id FROM native_checkin_device WHERE singleton=1');
      const payload = { ...command, deviceId: device.device_id }, hash = fingerprint(payload);
      await assertCheckinRequestNotCancelled(db,payload,expected);
      const prior = await get(db, 'SELECT * FROM native_checkin_operations WHERE request_id=?', [command.requestId]);
      if (prior) {
        owned(prior, expected);
        if (prior.request_fingerprint !== hash) throw fail(409, 'CHECKIN_REQUEST_CONFLICT', 'Request ID belongs to a different check-in. Retry the original command.');
        assertCurrent(token, expected); return prior;
      }
      if (await get(db, 'SELECT request_id FROM native_checkin_operations WHERE reservation_id=?', [command.id])) throw fail(409, 'CHECKIN_ALREADY_PENDING', 'Recover the existing operation for this reservation.');
      await assertTableNotHeld(db,command.tableId);
      const table = await get(db, 'SELECT * FROM tables WHERE id=?', [command.tableId]);
      if (!table || table.status !== 'available' || table.isActive !== 1 || table.sessionData !== null) throw fail(409, 'CHECKIN_TABLE_UNAVAILABLE', 'Choose an active available empty table before requesting a claim.');
      if (await get(db, "SELECT request_id FROM native_checkin_operations WHERE table_id=? AND phase IN ('prepared','claimed')", [command.tableId])) throw fail(409, 'CHECKIN_TABLE_PENDING', 'Recover the existing check-in for this table first.');
      assertCurrent(token, expected);
      await run(db, "INSERT INTO native_checkin_operations(request_id,local_staff_id,cloud_user_id,device_id,reservation_id,table_id,request_fingerprint,request_json,phase,created_at) VALUES(?,?,?,?,?,?,?,?,'prepared',?)", [command.requestId,expected.localStaffId,expected.cloudUserId,device.device_id,command.id,command.tableId,hash,JSON.stringify(payload),new Date(now()).toISOString()]);
      assertCurrent(token, expected);
      return get(db, 'SELECT * FROM native_checkin_operations WHERE request_id=?', [command.requestId]);
    });
    if (prepared.phase !== 'prepared') {
      const saved = parse(prepared.claim_json); verifyClaim(saved, parse(prepared.request_json));
      return { requestId: command.requestId, phase: prepared.phase, claim: saved, replayed: true };
    }
    // The exact intent is committed before any cloud call. A lost response keeps it.
    const result = validateCheckinClaimResult(await claimCheckin(token, parse(prepared.request_json)), parse(prepared.request_json));
    const expectedAfter = await actor(token, expected.cloudUserId);
    if (expectedAfter.localStaffId !== expected.localStaffId || expectedAfter.generation !== expected.generation) throw fail(403, 'CHECKIN_ACCOUNT_CHANGED', 'Recover this claim under the original local account.');
    verifyClaim(result?.claim, parse(prepared.request_json));
    return transaction(async db => {
      const prior = await get(db, 'SELECT * FROM native_checkin_operations WHERE request_id=?', [command.requestId]);
      owned(prior, expected); assertCurrent(token, expected);
      if (prior.phase !== 'prepared') {
        if (canonicalSession(parse(prior.claim_json)) !== canonicalSession(result.claim)) throw fail(409, 'CHECKIN_CLAIM_MISMATCH', 'Conflicting claim responses require reconciliation.');
        return { requestId: command.requestId, phase: prior.phase, claim: parse(prior.claim_json), replayed: true };
      }
      await run(db, "UPDATE native_checkin_operations SET phase='claimed',claim_id=?,claim_json=? WHERE request_id=?", [result.claim.claimId,JSON.stringify(result.claim),command.requestId]);
      assertCurrent(token, expected);
      return { requestId: command.requestId, phase: 'claimed', claim: result.claim, replayed: result.replayed === true };
    });
  }
  async function admit(token, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2 || !uuid(input.requestId) || typeof input.expectedOvertimeRate !== 'number' || !Number.isFinite(input.expectedOvertimeRate) || input.expectedOvertimeRate <= 0 || input.expectedOvertimeRate > 5000 || Number(input.expectedOvertimeRate.toFixed(2)) !== input.expectedOvertimeRate) throw fail(400, 'INVALID_CHECKIN_ADMISSION', 'Review the original check-in ID and current overtime rate.');
    const command = { requestId: input.requestId, expectedOvertimeRate: input.expectedOvertimeRate }, hash = fingerprint(command);
    await ready;
    const expected = await actor(token);
    return transaction(async db => {
      const row = await get(db, 'SELECT * FROM native_checkin_operations WHERE request_id=?', [command.requestId]);
      if (!row) throw fail(404, 'CHECKIN_NOT_FOUND', 'Recover the original check-in before admission.');
      owned(row, expected); assertCurrent(token, expected);
      if (row.phase === 'admitted') {
        if (row.admission_fingerprint !== hash) throw fail(409, 'CHECKIN_REQUEST_CONFLICT', 'Admission already committed with different details. Retry its original rate.');
        const saved = parse(row.response_json), storedClaim = parse(row.claim_json);
        verifyClaim(storedClaim, parse(row.request_json));
        const event = await get(db, 'SELECT * FROM native_checkin_outbox WHERE request_id=?', [row.request_id]);
        if (saved.requestId !== row.request_id || saved.claimId !== row.claim_id || saved.phase !== 'admitted' || saved.table?.id !== row.table_id || !event || event.event_id !== saved.outboxEventId || event.claim_id !== row.claim_id || !Number.isFinite(Date.parse(saved.table?.session?.startTime)) || canonicalSession(saved.table.session) !== canonicalSession(claimSession(storedClaim,command.expectedOvertimeRate,saved.table.session.startTime))) throw fail(409, 'CHECKIN_RECONCILIATION_REQUIRED', 'Stored admission response or outbox requires reconciliation.');
        const eventPayload = { eventId: event.event_id, type: 'admission', requestId: row.request_id, claimId: row.claim_id, reservationId: row.reservation_id, deviceId: row.device_id, tableId: row.table_id, localStaffId: row.local_staff_id, cloudUserId: row.cloud_user_id, sessionStartTime: saved.table.session.startTime, overtimeRateCents: Math.round(saved.table.session.overtimeRate * 100) };
        if (event.event_type !== 'admission' || canonicalSession(parse(event.payload_json)) !== canonicalSession(eventPayload)) throw fail(409, 'CHECKIN_RECONCILIATION_REQUIRED', 'Stored admission outbox bindings require reconciliation.');
        assertCurrent(token, expected);
        return { ...saved, replayed: true };
      }
      if (row.phase !== 'claimed') throw fail(409, 'CHECKIN_CLAIM_UNCONFIRMED', 'Recover the cloud claim before starting play.');
      const payload = parse(row.request_json), savedClaim = parse(row.claim_json);
      verifyClaim(savedClaim, payload);
      const table = await get(db, 'SELECT * FROM tables WHERE id=?', [row.table_id]);
      if (!table || table.status !== 'available' || table.isActive !== 1 || table.sessionData !== null) throw fail(409, 'CHECKIN_TABLE_UNAVAILABLE', 'The claim is retained. Review the current table before admitting.');
      const setting = await get(db, 'SELECT settingValue FROM systemSettings WHERE keyName=?', ['overtimeRate']);
      if (!setting || Number(setting.settingValue) !== command.expectedOvertimeRate) throw fail(409, 'CHECKIN_RATE_CHANGED', 'Review the current overtime rate; the existing cloud claim is retained.');
      const started = new Date(now()).toISOString(), session = claimSession(savedClaim, command.expectedOvertimeRate, started);
      calculateSessionBill(session, now(), false);
      await assertTableNotHeld(db,row.table_id);
      const updated = await run(db, "UPDATE tables SET status='occupied',sessionData=? WHERE id=? AND status='available' AND isActive=1 AND sessionData IS NULL", [JSON.stringify(session),row.table_id]);
      if (updated.changes !== 1) throw fail(409, 'CHECKIN_TABLE_UNAVAILABLE', 'The table changed before admission.');
      const event = { eventId: randomUUID(), type: 'admission', requestId: row.request_id, claimId: savedClaim.claimId, reservationId: row.reservation_id, deviceId: row.device_id, tableId: row.table_id, localStaffId: expected.localStaffId, cloudUserId: expected.cloudUserId, sessionStartTime: started, overtimeRateCents: Math.round(session.overtimeRate * 100) };
      await run(db, "INSERT INTO native_checkin_outbox(event_id,request_id,claim_id,event_type,payload_json,created_at) VALUES(?,?,?,'admission',?,?)", [event.eventId,row.request_id,savedClaim.claimId,JSON.stringify(event),started]);
      const response = { requestId: row.request_id, claimId: savedClaim.claimId, phase: 'admitted', cloudAcknowledged: false, table: { id: row.table_id, status: 'occupied', session }, outboxEventId: event.eventId, replayed: false };
      await run(db, "UPDATE native_checkin_operations SET phase='admitted',admission_fingerprint=?,response_json=? WHERE request_id=?", [hash,JSON.stringify(response),row.request_id]);
      assertCurrent(token, expected);
      return response;
    });
  }
  return { ready, claim, admit };
}
module.exports = { createCheckinCoordinator };
