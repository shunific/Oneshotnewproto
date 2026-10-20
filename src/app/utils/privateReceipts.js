export const RECEIPT_BUCKET = 'oneshot-receipts';
export const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ownerPattern = new RegExp(`^${uuid}$`);
const pathPattern = new RegExp(`^(${uuid})/${uuid}\\.(?:jpg|png)$`);

async function verifiedOwner(client) {
  const { data, error } = await client.auth.getUser();
  if (error) throw error;
  const user = data?.user;
  if (!user || !ownerPattern.test(user.id) || !user.email_confirmed_at || user.is_anonymous) {
    throw new Error('Sign in with a verified customer account to upload or view payment receipts.');
  }
  return user.id;
}

export function assertPrivateReceiptReference(reference, ownerId) {
  if (reference?.bucket !== RECEIPT_BUCKET || typeof reference.path !== 'string') {
    throw new Error('A private receipt object reference is required.');
  }
  const match = reference.path.match(pathPattern);
  if (!match || (ownerId !== undefined && match[1] !== ownerId)) {
    throw new Error('This receipt does not belong to the signed-in customer.');
  }
  return { bucket: RECEIPT_BUCKET, path: reference.path };
}

const PENDING_PREFIX = 'oneshot_pending_receipt_v1:';
const MAX_PENDING = 5;
const pruneGenerations = new WeakMap();
function isStorageObject(storage) { return storage !== null && (typeof storage === 'object' || typeof storage === 'function'); }
function pruneGeneration(storage) { return pruneGenerations.get(storage) || 0; }
function assertGeneration(storage, generation) {
  if (pruneGeneration(storage) !== generation) throw new Error('Receipt recovery request changed because the customer account changed. Review the current booking before retrying.');
}
function requireStorage(storage) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') throw new Error('Receipt recovery storage is unavailable. Enable session storage before uploading.');
  return storage;
}
function readAttempts(storage, ownerId) {
  requireStorage(storage);
  const raw = storage.getItem(PENDING_PREFIX + ownerId);
  if (raw === null) return [];
  if (typeof raw !== 'string' || raw.length > 4096) throw new Error('Receipt recovery data is invalid. Contact staff before uploading another receipt.');
  let records;
  try { records = JSON.parse(raw); } catch { throw new Error('Receipt recovery data is invalid. Contact staff before uploading another receipt.'); }
  if (!Array.isArray(records) || records.length > MAX_PENDING || records.some(record => !record || typeof record !== 'object' || Array.isArray(record) || typeof record.requestId !== 'string' || typeof record.sha256 !== 'string' || (record.path !== undefined && typeof record.path !== 'string') || Object.keys(record).some(key => !['requestId', 'sha256', 'contentType', 'byteSize', 'path'].includes(key)) || !ownerPattern.test(record.requestId) || !/^[0-9a-f]{64}$/.test(record.sha256) || !['image/png', 'image/jpeg'].includes(record.contentType) || !Number.isInteger(record.byteSize) || record.byteSize <= 0 || record.byteSize > MAX_RECEIPT_BYTES || (record.path !== undefined && (!pathPattern.test(record.path) || !record.path.startsWith(ownerId + '/') || !record.path.endsWith(record.contentType === 'image/png' ? '.png' : '.jpg')))) || new Set(records.map(contentKey)).size !== records.length || new Set(records.map(record => record.requestId)).size !== records.length) throw new Error('Receipt recovery data is invalid. Contact staff before uploading another receipt.');
  return records;
}
function contentKey(record) { return `${record.sha256}:${record.contentType}:${record.byteSize}`; }
function writeAttempts(storage, ownerId, records) {
  const key = PENDING_PREFIX + ownerId;
  if (records.length) storage.setItem(key, JSON.stringify(records)); else storage.removeItem(key);
}
function operationFor(storage, ownerId, content) {
  const records = readAttempts(storage, ownerId);
  let record = records.find(record => contentKey(record) === contentKey(content));
  if (!record) {
    if (records.length >= MAX_PENDING) throw new Error('Finish your pending booking or contact staff to review unused receipts before uploading more.');
    record = { ...content, requestId: crypto.randomUUID() }; records.push(record);
  }
  // Even an existing request must prove storage remains writable before dispatch.
  writeAttempts(storage, ownerId, records);
  return record;
}
function updateAttempt(storage, ownerId, requestId, update) {
  const records = readAttempts(storage, ownerId), index = records.findIndex(record => record.requestId === requestId);
  if (index < 0) throw new Error('Receipt recovery request changed. Review the current booking before retrying.');
  records[index] = update(records[index]); writeAttempts(storage, ownerId, records);
}
export function clearPendingReceiptUploads(storage, exceptOwnerId = null) {
  // Invalidate work before storage access: a failed prune must still stop old I/O.
  if (isStorageObject(storage)) pruneGenerations.set(storage, pruneGeneration(storage) + 1);
  requireStorage(storage);
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (key?.startsWith(PENDING_PREFIX) && key !== PENDING_PREFIX + exceptOwnerId) storage.removeItem(key);
  }
}
export function forgetBookedReceiptUpload(storage, reference) {
  // A confirmed booking remains confirmed even if browser cleanup is unavailable.
  try {
    const { path } = assertPrivateReceiptReference(reference);
    const ownerId = path.split('/')[0];
    const records = readAttempts(storage, ownerId);
    const remaining = records.filter(record => record.path !== path);
    if (remaining.length !== records.length) writeAttempts(storage, ownerId, remaining);
    return remaining.length !== records.length;
  } catch { return false; }
}

async function validateImage(file) {
  if (!(file instanceof Blob) || !['image/jpeg', 'image/png'].includes(file.type) || !Number.isInteger(file.size) || file.size <= 0 || file.size > MAX_RECEIPT_BYTES) {
    throw new Error('Choose a PNG or JPEG receipt up to 5 MB.');
  }
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte);
  const jpeg = header[0] === 255 && header[1] === 216 && header[2] === 255;
  if ((file.type === 'image/png' && !png) || (file.type === 'image/jpeg' && !jpeg)) {
    throw new Error('The receipt contents do not match its PNG or JPEG file type.');
  }
}
async function digest(file) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}
async function sameOwner(client, ownerId) {
  if (await verifiedOwner(client) !== ownerId) throw new Error('The customer account changed. Review the receipt under its original account.');
}
export async function uploadPrivateBookingReceipt(client, file, { storage: recoveryStorage = globalThis.sessionStorage } = {}) {
  requireStorage(recoveryStorage);
  const generation = pruneGeneration(recoveryStorage);
  const checkGeneration = () => assertGeneration(recoveryStorage, generation);
  await validateImage(file);
  checkGeneration();
  const ownerId = await verifiedOwner(client);
  checkGeneration();
  const sha256 = await digest(file);
  checkGeneration();
  await sameOwner(client, ownerId);
  checkGeneration();
  const operation = operationFor(recoveryStorage, ownerId, { sha256, contentType: file.type, byteSize: file.size });
  const requestId = operation.requestId;
  const { data: intent, error: intentError } = await client.rpc('oneshot_receipt_upload_intent', {
    payload: { requestId, expectedCustomerId: ownerId, contentType: file.type, byteSize: file.size, sha256 },
  });
  checkGeneration();
  if (intentError?.message === 'RECEIPT_UPLOAD_LIMIT') throw new Error('Receipt upload allowance reached. Wait 15 minutes and retry with the same selected file.');
  if (intentError?.message === 'RECEIPT_UNLINKED_LIMIT') throw new Error('Finish your pending booking or contact staff to review unused receipts before uploading more.');
  if (intentError) throw intentError;
  const { path } = assertPrivateReceiptReference(intent, ownerId);
  if (!path.endsWith(file.type === 'image/png' ? '.png' : '.jpg') || intent.declaredSize !== file.size || intent.declaredMime !== file.type || intent.sha256 !== sha256 || typeof intent.uploadAllowed !== 'boolean' || typeof intent.replayed !== 'boolean' || !Number.isFinite(Date.parse(intent.expiresAt))) {
    throw new Error('The private receipt upload permission could not be verified.');
  }
  await sameOwner(client, ownerId);
  checkGeneration();
  updateAttempt(recoveryStorage, ownerId, requestId, record => {
    if (record.path && record.path !== path) throw new Error('The private receipt upload path changed. Contact staff before retrying.');
    return { ...record, path };
  });
  const storage = client.storage.from(RECEIPT_BUCKET);
  let result;
  if (intent.uploadAllowed) {
    try {
      result = await storage.upload(path, file, { upsert: false, contentType: file.type, cacheControl: '0' });
    } catch {
      result = null;
    }
  }
  checkGeneration();
  await sameOwner(client, ownerId);
  checkGeneration();
  if (result?.error || result?.data?.path !== path) {
    // A lost response or immutable-path conflict may follow a committed upload.
    // Recover only by reading the exact owned object and comparing all its bytes.
    const { data: saved, error } = await storage.download(path);
    checkGeneration();
    await sameOwner(client, ownerId);
    checkGeneration();
    if (!intent.uploadAllowed && Number(error?.statusCode ?? error?.status) === 404) {
      updateAttempt(recoveryStorage, ownerId, requestId, record => ({ sha256: record.sha256, contentType: record.contentType, byteSize: record.byteSize, requestId: crypto.randomUUID() }));
      throw new Error('Receipt upload permission expired without a saved receipt. Retry with the same file to request a new permission.');
    }
    const savedHash = !error && saved instanceof Blob && saved.size === file.size && saved.type === file.type ? await digest(saved) : null;
    checkGeneration();
    if (savedHash !== sha256) {
      throw new Error('Receipt upload is unconfirmed. Retry with the same selected file before choosing another receipt.');
    }
  }
  await sameOwner(client, ownerId);
  checkGeneration();
  const current = readAttempts(recoveryStorage, ownerId).find(record => record.requestId === requestId);
  if (!current || current.path !== path) throw new Error('Receipt recovery request changed. Review the current booking before retrying.');
  checkGeneration();
  return Object.freeze({ bucket: RECEIPT_BUCKET, path });
}

export async function downloadPrivateBookingReceipt(client, reference) {
  const ownerId = await verifiedOwner(client);
  const { path } = assertPrivateReceiptReference(reference, ownerId);
  const { data, error } = await client.storage.from(RECEIPT_BUCKET).download(path);
  if (error) throw error;
  await validateImage(data);
  await sameOwner(client, ownerId);
  if (!path.endsWith(data.type === 'image/png' ? '.png' : '.jpg')) throw new Error('The private receipt download could not be verified.');
  return data;
}
