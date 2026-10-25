const sqlite3 = require('sqlite3');
const { createHash, createHmac } = require('node:crypto');
const { canonicalSession } = require('./server-session-identity.cjs');
const { createNativeActorGuard } = require('./server-native-actor.cjs');
const { verifyReservationAdmission, verifyReservationCompletionReplay } = require('./server-reservation-completion.cjs');
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const run = (db, sql) => new Promise((resolve,reject)=>db.run(sql,e=>e?reject(e):resolve()));
const get = (db, sql, args = []) => new Promise((resolve,reject)=>db.get(sql,args,(e,row)=>e?reject(e):resolve(row)));
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const signingText = e => ['oneshot-native-event-v1',e.keyId,e.deviceId,e.actorId,e.eventType,e.eventId,e.claimId,hash(e.payload)].join('\n');

function validateCommand(input) {
  if (!input || Array.isArray(input) || Object.keys(input).length !== 2 || !Object.keys(input).every(k=>['eventType','eventId'].includes(k)) || !['admission','reservation-completion','reservation-move-prepare','reservation-move-commit','reservation-move-abort','reservation-move-cancel'].includes(input.eventType) || !uuid(input.eventId)) throw fail(400,'INVALID_DEVICE_EVENT','Choose an existing native event.');
}
async function readStoredNativeEvent(dbPath, command, { allowDelivered = false } = {}) {
  validateCommand(command);
  command = { eventType: command.eventType, eventId: command.eventId };
    let db, begun=false;
    try {
      db = await new Promise((resolve,reject)=>{const c=new sqlite3.Database(dbPath,sqlite3.OPEN_READONLY,e=>e?reject(e):resolve(c));});
      db.configure('busyTimeout',5000);await run(db,'BEGIN');begun=true;
      if (command.eventType.startsWith('reservation-move-')) {
        const event = await require('./server-reservation-moves.cjs').readStoredReservationMoveEvent(db,command,{allowDelivered});
        await run(db,'COMMIT');begun=false;
        return event;
      }
      const device = await get(db,'SELECT device_id FROM native_checkin_device WHERE singleton=1');
      let event, body;
      if (command.eventType === 'admission') {
        event = await get(db,'SELECT * FROM native_checkin_outbox WHERE event_id=?',[command.eventId]);
        if (!event) throw fail(404,'DEVICE_EVENT_NOT_FOUND','The original pending event was not found.');
        const operation = await get(db,'SELECT response_json FROM native_checkin_operations WHERE request_id=?',[event.request_id]);
        const saved = JSON.parse(operation?.response_json);
        await verifyReservationAdmission(db,saved.table.session);
        if (saved.outboxEventId !== event.event_id) throw Error('Mismatched admission event');
        body = JSON.parse(event.payload_json);
      } else {
        event = await get(db,'SELECT * FROM native_reservation_completion_outbox WHERE event_id=?',[command.eventId]);
        if (!event) throw fail(404,'DEVICE_EVENT_NOT_FOUND','The original pending event was not found.');
        const operation = await get(db,'SELECT * FROM checkout_operations WHERE request_id=?',[event.checkout_request_id]);
        const request = JSON.parse(operation?.request_fingerprint), saved = JSON.parse(operation?.response_json);
        if (canonicalSession(request) !== operation.request_fingerprint || request.tableId !== operation.table_id || request.requestId !== operation.request_id || saved.requestId !== operation.request_id || saved.id !== operation.table_id || Date.parse(request.expectedSessionStartTime) !== Date.parse(operation.session_start) || Date.parse(request.expectedSession?.startTime) !== Date.parse(operation.session_start)) throw Error('Mismatched checkout operation');
        await verifyReservationCompletionReplay(db,saved,request.expectedSession);
        if (saved.reservationCompletion.eventId !== event.event_id) throw Error('Mismatched completion event');
        body = JSON.parse(event.payload_json);
      }
      if (!allowDelivered && event.delivered_at !== null) throw fail(409,'DEVICE_EVENT_ALREADY_ACKNOWLEDGED','The original event is already acknowledged.');
      if (!uuid(device?.device_id) || body.deviceId !== device.device_id || body.eventId !== command.eventId || body.type !== command.eventType || !uuid(body.claimId)) throw Error('Mismatched device/event binding');
      const payload = canonicalSession(body);
      if (Buffer.byteLength(payload,'utf8') > 1048576) throw fail(409,'DEVICE_EVENT_TOO_LARGE','The original event exceeds the reviewed delivery limit. Keep it pending for reconciliation.');
      await run(db,'COMMIT');begun=false;
      return { deviceId:device.device_id,eventId:body.eventId,claimId:body.claimId,eventType:body.type,reservationId:body.reservationId,deliveredAt:event.delivered_at,payload };
    } catch (error) {
      if (begun) await run(db,'ROLLBACK').catch(()=>{});
      if (error.code?.startsWith('DEVICE_')) throw error;
      throw fail(409,'DEVICE_EVENT_RECONCILIATION_REQUIRED','The stored event could not be verified. Keep its original operation for reconciliation.');
    } finally { if (db) await new Promise(resolve=>db.close(resolve)); }
  }

// Internal backend only. The host supplies fresh identity and private key access;
// callers can choose a stored event ID, never a payload, device, actor or key.
function createNativeEventSigner(dbPath, { resolveActor, isActorCurrent, loadDeviceKey } = {}) {
  if (![resolveActor,isActorCurrent,loadDeviceKey].every(f=>typeof f==='function')) throw new TypeError('Trusted identity, generation and private device-key callbacks are required.');
  const { resolve: actor, assertCurrent: current } = createNativeActorGuard({ resolveActor, isActorCurrent }, () => fail(403,'DEVICE_PROOF_ACCOUNT_CHANGED','Staff session changed. The stored event remains pending.'));
  async function sign(token, input) {
    validateCommand(input);
    const command = { eventType:input.eventType,eventId:input.eventId };
    const expected = await actor(token), event = await readStoredNativeEvent(dbPath,command);
    let credential, key, result;
    try {
      try { credential = await loadDeviceKey(event.deviceId); }
      catch { throw fail(503,'DEVICE_KEY_UNAVAILABLE','The private device key is unavailable. The event remains pending.'); }
      if (credential?.deviceId !== event.deviceId || !uuid(credential?.keyId) || !Buffer.isBuffer(credential?.key) || credential.key.length !== 32) throw fail(503,'DEVICE_KEY_UNAVAILABLE','A private enrolled device key is required. The event remains pending.');
      key = Buffer.from(credential.key);const keyId = credential.keyId;
      const refreshed = await actor(token);
      if (refreshed.localStaffId !== expected.localStaffId || refreshed.cloudUserId !== expected.cloudUserId || refreshed.generation !== expected.generation) throw fail(403,'DEVICE_PROOF_ACCOUNT_CHANGED','Staff session changed while preparing device proof. The event remains pending.');
      const envelope = { version:1,keyId,deviceId:event.deviceId,actorId:expected.cloudUserId,eventType:event.eventType,eventId:event.eventId,claimId:event.claimId,payload:event.payload };
      const signature = createHmac('sha256',key).update(signingText(envelope),'utf8').digest('hex');
      current(token,expected);
      result = Object.freeze({ ...envelope,signature });
    } finally {
      if (key) key.fill(0);
      if (typeof credential?.dispose === 'function') {
        try { await credential.dispose(); }
        catch { /* Cleanup must not replace the result or expose provider diagnostics. */ }
      }
    }
    current(token,expected);
    return result;
  }
  return { sign };
}
module.exports = { readStoredNativeEvent, createNativeEventSigner, deviceEventSigningText: signingText };
