const { createHash } = require('node:crypto');
const { canonicalSession } = require('./server-session-identity.cjs');
const PROJECT_URL = "https://olywhyaozjlkjrnsdydg.supabase.co";
const MAX_RECEIPT = 5 * 1024 * 1024;
const fail = (status, code, message) =>
  Object.assign(new Error(message), { status, code });
const validIdentity = (value) =>
  value &&
  /^[0-9a-f-]{36}$/.test(value.userId) &&
  value.venueId === "oneshot" &&
  ["cashier", "manager"].includes(value.role) &&
  typeof value.email === "string";
function publicKey(key) {
  if (typeof key !== "string") return false;
  if (/^sb_publishable_[A-Za-z0-9_-]{20,200}$/.test(key)) return true;
  try {
    return (
      JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString())
        .role === "anon"
    );
  } catch {
    return false;
  }
}
function validateCheckinClaimResult(result, payload) {
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  const identifier = value => typeof value === 'string' && value.length >= 1 && value.length <= 120 && value === value.trim();
  const claim = result?.claim;
  const cents = value => Number.isSafeInteger(value) && value >= 0 && value <= 240000000;
  const claimFields = ['claimId','requestId','reservationId','actorUserId','actorRole','deviceId','tableId','cloudTableId','ownerUserId','sourceRevision','claimRevision','state','customerName','contactNumber','email','partySize','durationMinutes','bookingDate','timeSlot','netTotalCents','grossTotalCents','discountCents','requiredDepositCents','verifiedPaidCents'];
  const date = typeof claim?.bookingDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(claim.bookingDate) ? Date.parse(claim.bookingDate + 'T00:00:00Z') : NaN;
  if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(k => !['claim','replayed','recordType','fundsTransferred'].includes(k)) ||
      result.recordType !== 'reservation-check-in-claim' || result.fundsTransferred !== false || typeof result.replayed !== 'boolean' ||
      !claim || Array.isArray(claim) || Object.keys(claim).length !== claimFields.length || Object.keys(claim).some(k => !claimFields.includes(k)) ||
      !uuid(claim.claimId) || claim.requestId !== payload.requestId || claim.reservationId !== payload.id || claim.actorUserId !== payload.expectedStaffId || !['cashier','manager'].includes(claim.actorRole) ||
      claim.deviceId !== payload.deviceId || claim.tableId !== payload.tableId || !identifier(claim.cloudTableId) || !uuid(claim.ownerUserId) ||
      claim.sourceRevision !== payload.expectedRevision || claim.claimRevision !== payload.expectedRevision + 1 || claim.state !== 'claim-pending' ||
      typeof claim.customerName !== 'string' || !claim.customerName.trim() || claim.customerName.length > 500 ||
      typeof claim.contactNumber !== 'string' || !claim.contactNumber.trim() || claim.contactNumber.length > 120 ||
      !(claim.email === null || (typeof claim.email === 'string' && claim.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claim.email))) ||
      !Number.isSafeInteger(claim.partySize) || claim.partySize < 1 || claim.partySize > 2147483647 ||
      !Number.isSafeInteger(claim.durationMinutes) || claim.durationMinutes < 60 || claim.durationMinutes > 1440 || claim.durationMinutes % 60 !== 0 ||
      !Number.isFinite(date) || new Date(date).toISOString().slice(0,10) !== claim.bookingDate || typeof claim.timeSlot !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(claim.timeSlot) ||
      ![claim.netTotalCents,claim.grossTotalCents,claim.discountCents,claim.requiredDepositCents,claim.verifiedPaidCents].every(cents) ||
      claim.grossTotalCents !== claim.netTotalCents + claim.discountCents || claim.requiredDepositCents > claim.verifiedPaidCents || claim.verifiedPaidCents > claim.netTotalCents) {
    throw fail(503, 'CLOUD_RESPONSE_INVALID', 'Check-in claim could not be verified. Keep the original request for recovery.');
  }
  return result;
}
const nativeUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const nativeExact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const nativeEventStates = Object.freeze({admission:'checked-in','reservation-completion':'completed','reservation-move-prepare':'move-prepared','reservation-move-commit':'moved','reservation-move-abort':'move-aborted','reservation-move-cancel':'move-cancelled'});
function validateNativeEventEnvelope(input) {
  // Version 1 remains readable for verified historical local delivery journals.
  const fields = input?.version === 2 ? ['version','deviceId','actorId','eventType','eventId','claimId','payload'] : ['version','keyId','deviceId','actorId','eventType','eventId','claimId','payload','signature'];
  const invalid = () => fail(400,'INVALID_NATIVE_EVENT','Choose an original native event.');
  if (!nativeExact(input,fields) || ![1,2].includes(input.version) || !Object.hasOwn(nativeEventStates,input.eventType) || !['deviceId','actorId','eventId','claimId'].every(key => nativeUuid(input[key])) || (input.version === 1 && !nativeUuid(input.keyId)) || typeof input.payload !== 'string' || !input.payload || Buffer.byteLength(input.payload,'utf8') > 1048576 || (input.version === 1 && (typeof input.signature !== 'string' || !/^[a-f0-9]{64}$/.test(input.signature)))) throw invalid();
  const envelope = Object.fromEntries(fields.map(key => [key,input[key]]));
  let body;
  try { body = JSON.parse(envelope.payload); } catch { throw invalid(); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || canonicalSession(body) !== envelope.payload || body.eventId !== envelope.eventId || body.type !== envelope.eventType || body.claimId !== envelope.claimId || body.deviceId !== envelope.deviceId || typeof body.reservationId !== 'string' || !body.reservationId || body.reservationId.length > 120 || body.reservationId !== body.reservationId.trim() || (envelope.eventType === 'reservation-completion' && !nativeUuid(body.receipt?.id))) throw invalid();
  return Object.freeze(envelope);
}
function validateNativeEventAckResult(result, input) {
  const envelope = validateNativeEventEnvelope(input);
  const body = JSON.parse(envelope.payload), ack = result?.ack;
  const fields = ['eventId','eventType','claimId','deviceId','reservationId','payloadSha256','state','revision','receiptId','receivedAt','acceptedBy'];
  const hash = createHash('sha256').update(envelope.payload,'utf8').digest('hex');
  const expectedRevision = envelope.eventType==='reservation-move-cancel' ? body.expectedRevision+2 : envelope.eventType.startsWith('reservation-move-') ? body.expectedRevision+1 : null;
  const received = typeof ack?.receivedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ack.receivedAt) ? Date.parse(ack.receivedAt) : NaN;
  if (!nativeExact(result,['ack','replayed','recordType','fundsTransferred']) || result.recordType !== 'reservation-lifecycle-ack' || result.fundsTransferred !== false || typeof result.replayed !== 'boolean' || !nativeExact(ack,fields) || ack.eventId !== envelope.eventId || ack.eventType !== envelope.eventType || ack.claimId !== envelope.claimId || ack.deviceId !== envelope.deviceId || ack.reservationId !== body.reservationId || ack.payloadSha256 !== hash || ack.state !== nativeEventStates[envelope.eventType] || !Number.isSafeInteger(ack.revision) || ack.revision < 1 || (expectedRevision!==null&&(!Number.isSafeInteger(expectedRevision)||ack.revision!==expectedRevision)) || ack.receiptId !== (envelope.eventType === 'reservation-completion' ? body.receipt.id : null) || !nativeUuid(ack.acceptedBy) || (!result.replayed && ack.acceptedBy !== envelope.actorId) || !Number.isFinite(received) || new Date(received).toISOString() !== ack.receivedAt) throw fail(503,'CLOUD_RESPONSE_INVALID','Native event acknowledgement could not be verified. Keep the original event pending.');
  return { ack:Object.fromEntries(fields.map(key => [key,ack[key]])),replayed:result.replayed,recordType:result.recordType,fundsTransferred:false };
}
function validateCheckinCancellationResult(result,payload){
  const fields=['requestId','reservationId','deviceId','tableId','cancelled','replayed','recordType','fundsTransferred'];
  if(!nativeExact(result,fields)||result.requestId!==payload.requestId||result.reservationId!==payload.id||result.deviceId!==payload.deviceId||result.tableId!==payload.tableId||result.cancelled!==true||typeof result.replayed!=='boolean'||result.recordType!=='reservation-check-in-cancellation'||result.fundsTransferred!==false)throw fail(503,'CLOUD_RESPONSE_INVALID','Original check-in cancellation could not be verified. Keep its pending request.');
  return Object.fromEntries(fields.map(key=>[key,result[key]]));
}
function createCloudStaffService({
  enabled = process.env.ONESHOT_CLOUD_STAFF_ENABLED === "1",
  key = process.env.ONESHOT_CLOUD_PUBLISHABLE_KEY,
  fetchImpl = fetch,
  now = Date.now,
  isLocalSessionActive = async () => false,
} = {}) {
  const configured = enabled && publicKey(key);
  let connectionGeneration = 0;
  const records = new Map();
  const connecting = new Set();
  const epochs = new Map();
  const attempts = new Map();
  const refreshes = new Map();
  async function readLimited(response, limit) {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
      await response.body?.cancel();
      throw fail(
        503,
        "CLOUD_RESPONSE_INVALID",
        "Cloud response exceeded the expected size.",
      );
    }
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) {
          await reader.cancel();
          throw fail(
            503,
            "CLOUD_RESPONSE_INVALID",
            "Cloud response exceeded the expected size.",
          );
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, length);
  }
  async function request(path, token, body) {
    let response;
    try {
      response = await fetchImpl(PROJECT_URL + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          apikey: key,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw fail(
        503,
        "CLOUD_UNAVAILABLE",
        "Cloud service is unavailable. No result was confirmed.",
      );
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw fail(
          403,
          "CLOUD_SIGN_IN_REQUIRED",
          "Cloud access was denied. Reconnect with an approved staff account.",
        );
      if (response.status === 404)
        throw fail(
          503,
          "CLOUD_SETUP_REQUIRED",
          "The secure cloud staff service has not been deployed.",
        );
      let code = "CLOUD_REQUEST_REJECTED";
      try {
        const value = JSON.parse(
          (await readLimited(response, 4096)).toString(),
        );
        if (/^[A-Z][A-Z_]{2,80}$/.test(value.message)) code = value.message;
      } catch {}
      throw fail(
        response.status >= 500 ? 503 : 409,
        code,
        "The cloud request was not confirmed. Refresh before retrying.",
      );
    }
    return response;
  }
  async function json(path, token, body) {
    const response = await request(path, token, body);
    const text = (await readLimited(response, 4 * 1024 * 1024)).toString();
    try {
      return JSON.parse(text);
    } catch {
      throw fail(
        503,
        "CLOUD_RESPONSE_INVALID",
        "Cloud response could not be verified.",
      );
    }
  }
  async function revoke(record) {
    if (record) {
      try {
        await request("/auth/v1/logout?scope=local", record.accessToken, {});
        return true;
      } catch {}
    }
    return false;
  }
  function disposeSession(localToken) {
    epochs.set(localToken, (epochs.get(localToken) || 0) + 1);
    attempts.delete(localToken);
    const old = records.get(localToken);
    records.delete(localToken);
    if (old) void revoke(old);
    if (!connecting.has(localToken)) epochs.delete(localToken);
  }
  async function local(localToken) {
    if (!configured)
      throw fail(
        503,
        "CLOUD_NOT_CONFIGURED",
        "Cloud staff access is not configured on this device.",
      );
    if (!localToken || !(await isLocalSessionActive(localToken))) {
      disposeSession(localToken);
      throw fail(
        401,
        "LOCAL_SESSION_ENDED",
        "Sign in to the POS before connecting cloud staff access.",
      );
    }
  }
  async function identityFor(accessToken) {
    const value = await json(
      "/rest/v1/rpc/oneshot_staff_identity",
      accessToken,
      {},
    );
    if (!validIdentity(value))
      throw fail(
        403,
        "CLOUD_STAFF_REQUIRED",
        "This cloud account is not an approved staff member.",
      );
    return {
      userId: value.userId,
      venueId: value.venueId,
      role: value.role,
      email: value.email,
    };
  }
  function session(data) {
    if (
      !data ||
      typeof data.access_token !== "string" ||
      typeof data.refresh_token !== "string" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      data.expires_in > 86400
    )
      throw fail(
        503,
        "CLOUD_RESPONSE_INVALID",
        "Cloud sign-in could not be verified.",
      );
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expires: now() + data.expires_in * 1000,
    };
  }
  async function connect(localToken, email, password) {
    await local(localToken);
    if (
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      typeof password !== "string" ||
      !password ||
      password.length > 256
    )
      throw fail(
        400,
        "INVALID_CLOUD_LOGIN",
        "Enter your existing cloud staff email and password.",
      );
    const previous = attempts.get(localToken);
    const bucket =
      previous && previous.until > now()
        ? previous
        : { count: 0, until: now() + 15 * 60 * 1000 };
    if (bucket.count >= 5)
      throw fail(
        429,
        "CLOUD_LOGIN_LIMIT",
        "Too many cloud sign-in attempts. Wait 15 minutes.",
      );
    bucket.count++;
    attempts.set(localToken, bucket);
    if (connecting.has(localToken))
      throw fail(
        409,
        "CLOUD_CONNECT_BUSY",
        "Cloud sign-in is already in progress.",
      );
    const epoch = (epochs.get(localToken) || 0) + 1;
    epochs.set(localToken, epoch);
    connecting.add(localToken);
    let record;
    try {
      const value = await json("/auth/v1/token?grant_type=password", null, {
        email: email.trim(),
        password,
      });
      record = session(value);
      try {
        record.identity = await identityFor(record.accessToken);
        await local(localToken);
        if (epochs.get(localToken) !== epoch)
          throw fail(
            403,
            "CLOUD_ACCOUNT_CHANGED",
            "Cloud connection was cancelled.",
          );
      } catch (error) {
        void revoke(record);
        throw error;
      }
      if (connectionGeneration >= Number.MAX_SAFE_INTEGER) { void revoke(record); throw fail(503,'CLOUD_SESSION_CAPACITY','Restart the device before connecting cloud staff access.'); }
      record.generation = ++connectionGeneration;
      const old = records.get(localToken);
      records.set(localToken, record);
      attempts.delete(localToken);
      if (old) void revoke(old);
      return { configured: true, connected: true, identity: record.identity };
    } finally {
      connecting.delete(localToken);
      if (!records.has(localToken)) epochs.delete(localToken);
    }
  }
  async function current(localToken) {
    await local(localToken);
    let record = records.get(localToken);
    if (!record)
      throw fail(
        403,
        "CLOUD_SIGN_IN_REQUIRED",
        "Connect an approved cloud staff account.",
      );
    if (record.expires <= now() + 30000) {
      if (!refreshes.has(localToken)) {
        const pending = (async () => {
          const updated = session(
            await json("/auth/v1/token?grant_type=refresh_token", null, {
              refresh_token: record.refreshToken,
            }),
          );
          try {
            updated.identity = await identityFor(updated.accessToken);
            await local(localToken);
            if (
              records.get(localToken) !== record ||
              updated.identity.userId !== record.identity.userId
            )
              throw fail(
                403,
                "CLOUD_ACCOUNT_CHANGED",
                "Cloud account changed. Reconnect before continuing.",
              );
            updated.generation = record.generation;
            records.set(localToken, updated);
            return updated;
          } catch (error) {
            void revoke(updated);
            throw error;
          }
        })();
        refreshes.set(localToken, pending);
      }
      try {
        record = await refreshes.get(localToken);
      } catch (error) {
        if (error.status === 403 && records.get(localToken) === record)
          disposeSession(localToken);
        throw error;
      } finally {
        refreshes.delete(localToken);
      }
    }
    try {
      const identity = await identityFor(record.accessToken);
      await local(localToken);
      if (
        records.get(localToken) !== record ||
        identity.userId !== record.identity.userId
      )
        throw fail(
          403,
          "CLOUD_ACCOUNT_CHANGED",
          "Cloud account changed. Reconnect before continuing.",
        );
      record.identity = identity;
      return record;
    } catch (error) {
      if (error.status === 403 && records.get(localToken) === record)
        disposeSession(localToken);
      throw error;
    }
  }
  function isNativeActorCurrent(token, expected) {
    const record = records.get(token);
    return Boolean(configured && record && !connecting.has(token) && record.expires > now() && record.identity.userId === expected?.cloudUserId && record.generation === expected?.generation);
  }
  async function resolveNativeActor(token) {
    const record = await current(token);
    const actor = { cloudUserId: record.identity.userId, generation: record.generation };
    if (!isNativeActorCurrent(token,actor)) throw fail(403,'CLOUD_ACCOUNT_CHANGED','Cloud account changed. Recover the original operation under an approved account.');
    return Object.freeze(actor);
  }
  async function status(token) {
    if (!configured) return { configured: false, connected: false };
    await local(token);
    if (!records.has(token)) return { configured: true, connected: false };
    const record = await current(token);
    return { configured: true, connected: true, identity: record.identity };
  }
  async function disconnect(token) {
    epochs.set(token, (epochs.get(token) || 0) + 1);
    const record = records.get(token);
    records.delete(token);
    return {
      connected: false,
      remoteRevocationConfirmed: await revoke(record),
    };
  }
  async function rpc(token, name, payload) {
    const record = await current(token);
    const value = await json(
      "/rest/v1/rpc/" + name,
      record.accessToken,
      payload,
    );
    await local(token);
    if (records.get(token) !== record)
      throw fail(
        403,
        "CLOUD_ACCOUNT_CHANGED",
        "Cloud account changed. Review the result under the original account.",
      );
    return value;
  }
  async function reservations(token, from, to) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(from || "") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to || "")
    )
      throw fail(400, "INVALID_DATE_RANGE", "Choose a valid date range.");
    const result = await rpc(token, "oneshot_staff_reservations", {
      p_from: from,
      p_to: to,
    });
    if (
      !Array.isArray(result?.reservations) ||
      result.reservations.length > 1000
    )
      throw fail(
        503,
        "CLOUD_RESPONSE_INVALID",
        "Cloud booking list could not be verified.",
      );
    return result;
  }
  async function claimCheckin(token, input) {
    const fields = ['requestId', 'id', 'expectedRevision', 'expectedStaffId', 'deviceId', 'tableId'];
    const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
    const identifier = value => typeof value === 'string' && value.length >= 1 && value.length <= 120 && value === value.trim();
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length !== fields.length || Object.keys(input).some(k => !fields.includes(k)) ||
        !uuid(input.requestId) || !uuid(input.expectedStaffId) || !uuid(input.deviceId) || !identifier(input.id) || !identifier(input.tableId) ||
        !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || input.expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw fail(400, 'INVALID_CHECKIN_CLAIM', 'Review the reservation, device, table and current booking revision.');
    }
    const payload = { ...input };
    const record = await current(token);
    if (payload.expectedStaffId !== record.identity.userId) throw fail(403, 'CLOUD_ACCOUNT_CHANGED', 'Cloud account changed. Review before checking in.');
    const result = await rpc(token, 'oneshot_staff_claim_checkin', { payload });
    return validateCheckinClaimResult(result, payload);
  }
  async function cancelCheckin(token,input){
    const fields=['requestId','id','expectedRevision','expectedStaffId','deviceId','tableId'];
    if(!nativeExact(input,fields)||!nativeUuid(input.requestId)||!nativeUuid(input.expectedStaffId)||!nativeUuid(input.deviceId)||!['id','tableId'].every(key=>typeof input[key]==='string'&&input[key]===input[key].trim()&&input[key].length>0&&input[key].length<=120)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||input.expectedRevision>=Number.MAX_SAFE_INTEGER)throw fail(400,'INVALID_CHECKIN_CANCELLATION','Choose the original check-in request.');
    const payload=Object.fromEntries(fields.map(key=>[key,input[key]]));
    const record=await current(token);if(record.identity.userId!==payload.expectedStaffId)throw fail(403,'CLOUD_ACCOUNT_CHANGED','Reconnect the original cloud staff account.');
    const result=await rpc(token,'oneshot_staff_cancel_checkin_request',{payload});
    return result?.recordType==='reservation-check-in-claim'?validateCheckinClaimResult(result,payload):validateCheckinCancellationResult(result,payload);
  }
  async function nativeTableMappings(token, deviceId) {
    if(!nativeUuid(deviceId))throw fail(400,'INVALID_NATIVE_DEVICE','Review the local installation identity.');
    const result=await rpc(token,'oneshot_staff_native_table_mappings',{p_device_id:deviceId});
    if(!nativeExact(result,['deviceId','mappings','recordType','fundsTransferred'])||result.deviceId!==deviceId||result.recordType!=='staff-native-table-mappings'||result.fundsTransferred!==false||!Array.isArray(result.mappings)||result.mappings.length>1000)throw fail(503,'CLOUD_RESPONSE_INVALID','Physical table mappings could not be verified.');
    const local=new Set(),cloud=new Set();
    const mappings=result.mappings.map(row=>{
      if(!nativeExact(row,['tableId','cloudTableId'])||!['tableId','cloudTableId'].every(key=>typeof row[key]==='string'&&row[key].trim()===row[key]&&row[key].length>0&&row[key].length<=120)||local.has(row.tableId)||cloud.has(row.cloudTableId))throw fail(503,'CLOUD_RESPONSE_INVALID','Physical table mappings could not be verified.');
      local.add(row.tableId);cloud.add(row.cloudTableId);return{tableId:row.tableId,cloudTableId:row.cloudTableId};
    });
    return{deviceId,mappings,recordType:result.recordType,fundsTransferred:false};
  }
  async function ackNativeEvent(token, input) {
    const envelope = validateNativeEventEnvelope(input);
    if (envelope.version !== 2) throw fail(400,'INVALID_NATIVE_EVENT','Publish an original staff-authorized native event.');
    const record = await current(token);
    if (record.identity.userId !== envelope.actorId) throw fail(403,'CLOUD_ACCOUNT_CHANGED','Cloud account changed. Keep the original event pending.');
    const result = await rpc(token,'oneshot_staff_ack_native_event',{ payload:envelope });
    return validateNativeEventAckResult(result,envelope);
  }
  async function confirm(token, input) {
    const fields = [
      "requestId",
      "id",
      "expectedRevision",
      "paymentKind",
      "method",
      "reference",
      "expectedAmountCents",
      "expectedStaffId",
    ];
    if (
      !input ||
      Object.keys(input).some((k) => !fields.includes(k)) ||
      typeof input.requestId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(input.requestId) ||
      typeof input.id !== "string" ||
      input.id.length > 100 ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      !["deposit", "balance"].includes(input.paymentKind) ||
      !["cash", "gcash"].includes(input.method) ||
      !Number.isSafeInteger(input.expectedAmountCents) ||
      input.expectedAmountCents < 1 ||
      (input.reference !== undefined &&
        (typeof input.reference !== "string" || input.reference.length > 120))
    )
      throw fail(
        400,
        "INVALID_PAYMENT_VERIFICATION",
        "Review the payment verification fields.",
      );
    const record = await current(token);
    if (input.expectedStaffId !== record.identity.userId)
      throw fail(
        403,
        "CLOUD_ACCOUNT_CHANGED",
        "Cloud account changed. Review before confirming.",
      );
    return rpc(token, "oneshot_staff_confirm_payment", { payload: input });
  }
  async function approve(token, input) {
    const fields = [
      "requestId",
      "id",
      "expectedRevision",
      "expectedStaffId",
      "expectedTotalCents",
      "expectedDownPaymentCents",
    ];
    if (
      !input ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !fields.includes(k)) ||
      typeof input.requestId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(input.requestId) ||
      typeof input.id !== "string" ||
      !input.id ||
      input.id.length > 100 ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      !Number.isSafeInteger(input.expectedTotalCents) ||
      input.expectedTotalCents < 0 ||
      input.expectedTotalCents > 240000000 ||
      input.expectedDownPaymentCents !== 0
    )
      throw fail(
        400,
        "INVALID_BOOKING_APPROVAL",
        "Review the booking and its zero deposit before approving.",
      );
    const record = await current(token);
    if (input.expectedStaffId !== record.identity.userId)
      throw fail(
        403,
        "CLOUD_ACCOUNT_CHANGED",
        "Cloud account changed. Review before approving.",
      );
    return rpc(token, "oneshot_staff_approve_booking", { payload: input });
  }
  async function receipt(token, id) {
    if (typeof id !== "string" || !id || id.length > 100)
      throw fail(400, "INVALID_BOOKING", "Choose a booking.");
    const record = await current(token);
    const ref = await rpc(token, "oneshot_staff_receipt", {
      p_reservation_id: id,
    });
    if (
      ref?.reservationId !== id ||
      typeof ref.path !== "string" ||
      !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png)$/.test(ref.path)
    )
      throw fail(
        409,
        "PRIVATE_RECEIPT_REQUIRED",
        "This booking has no verified private receipt. Legacy public receipts require migration.",
      );
    const response = await request(
      "/storage/v1/object/authenticated/oneshot-receipts/" +
        ref.path.split("/").map(encodeURIComponent).join("/"),
      record.accessToken,
    );
    const type = response.headers.get("content-type")?.split(";")[0];
    const data = await readLimited(response, MAX_RECEIPT);
    await local(token);
    if (
      records.get(token) !== record ||
      !["image/jpeg", "image/png"].includes(type) ||
      !data.length ||
      data.length > MAX_RECEIPT
    )
      throw fail(
        503,
        "CLOUD_RESPONSE_INVALID",
        "Private receipt could not be verified.",
      );
    return { data, type };
  }
  return {
    connect,
    status,
    disconnect,
    reservations,
    confirm,
    approve,
    claimCheckin,
    nativeTableMappings,
    cancelCheckin,
    ackNativeEvent,
    receipt,
    disposeSession,
    resolveNativeActor,
    isNativeActorCurrent,
  };
}
function registerCloudStaffRoutes(app, options) {
  const service = createCloudStaffService(options);
  const handle = (fn) => async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (!req.staff || !req.authToken)
        throw fail(401, "LOCAL_SESSION_ENDED", "Sign in to the POS.");
      await fn(req, res);
    } catch (error) {
      res.status(error.status || 503).json({
        error: error.message || "Cloud request unavailable.",
        code: error.code || "CLOUD_UNAVAILABLE",
      });
    }
  };
  app.get(
    "/api/cloud/staff/status",
    handle(async (req, res) => res.json(await service.status(req.authToken))),
  );
  app.post(
    "/api/cloud/staff/connect",
    handle(async (req, res) =>
      res.json(
        await service.connect(
          req.authToken,
          req.body?.email,
          req.body?.password,
        ),
      ),
    ),
  );
  app.post(
    "/api/cloud/staff/disconnect",
    handle(async (req, res) =>
      res.json(await service.disconnect(req.authToken)),
    ),
  );
  app.get(
    "/api/cloud/staff/reservations",
    handle(async (req, res) =>
      res.json(
        await service.reservations(req.authToken, req.query.from, req.query.to),
      ),
    ),
  );
  app.post(
    "/api/cloud/staff/payments",
    handle(async (req, res) =>
      res.json(await service.confirm(req.authToken, req.body)),
    ),
  );
  app.post(
    "/api/cloud/staff/approvals",
    handle(async (req, res) =>
      res.json(await service.approve(req.authToken, req.body)),
    ),
  );
  app.get(
    "/api/cloud/staff/receipt",
    handle(async (req, res) => {
      const result = await service.receipt(req.authToken, req.query.id);
      res.type(result.type).send(result.data);
    }),
  );
  return service;
}
module.exports = {
  createCloudStaffService,
  validateCheckinClaimResult,
  validateCheckinCancellationResult,
  validateNativeEventEnvelope,
  validateNativeEventAckResult,
  registerCloudStaffRoutes,
  publicKey,
  PROJECT_URL,
};
