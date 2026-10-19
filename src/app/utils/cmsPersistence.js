import { cmsCanonical as canonical, cmsExact, normalizeCmsPatch, validateCmsCommand, validateCmsSnapshot, validateCmsAck } from '../../../cms-contract.mjs';

const keyFor = ownerId => `oneshot_pending_cms_save_v1:${encodeURIComponent(ownerId)}`;
const unconfirmed = () => new Error('CMS save is unconfirmed. Retry the saved original before saving different images.');
export function pendingCmsSave(storage, ownerId) {
  if (!ownerId) return null;
  if (!storage || typeof storage.getItem !== 'function') throw unconfirmed();
  const raw = storage.getItem(keyFor(ownerId));
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.length > 32768) throw unconfirmed();
  try {
    const record = JSON.parse(raw);
    if (!cmsExact(record, ['ownerId', 'command']) || record.ownerId !== ownerId || record.command?.expectedActorId !== ownerId) throw unconfirmed();
    validateCmsCommand(record.command);
    return record;
  } catch { throw unconfirmed(); }
}

export async function saveCmsConfig({storage, ownerId, revision, patch, request, read, isCurrent = () => true, retry = false, newId = () => crypto.randomUUID()}) {
  const current = () => { if (!ownerId || isCurrent() !== true) throw new Error('Administrator account changed. Sign in as the original administrator to recover this save.'); };
  current();
  let record = pendingCmsSave(storage, ownerId);
  if (retry && !record) throw new Error('No original CMS save is pending. Reload the saved images.');
  if (!record) record = {ownerId, command: validateCmsCommand({requestId: newId(), expectedActorId: ownerId, expectedRevision: revision, patch: normalizeCmsPatch(patch)})};
  else if (!retry && canonical(record.command.patch) !== canonical(normalizeCmsPatch(patch))) throw unconfirmed();
  const key = keyFor(ownerId), raw = canonical(record);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw unconfirmed();
  current();
  const removeMatching = () => {
    current(); const saved = storage.getItem(key);
    if (saved === null) return;
    if (saved !== raw) throw unconfirmed();
    storage.removeItem(key);
    if (storage.getItem(key) !== null) throw unconfirmed();
  };
  let result;
  try { result = await request(JSON.parse(canonical(record.command))); }
  catch (error) {
    current();
    // These rejections occur only after the server rules out an existing commit.
    if (error?.status === 409 && ['CMS_REVISION_CHANGED', 'CMS_IMAGE_UNAVAILABLE'].includes(error?.response?.code)) {
      const snapshot = validateCmsSnapshot(await read()); current();
      removeMatching();
      throw Object.assign(new Error('This CMS change was not saved. Reload the saved section, review your draft and try again.'), {code: 'CMS_REVIEW_REQUIRED', snapshot});
    }
    throw error;
  }
  current();
  let saved;
  try { saved = validateCmsAck(record.command, result); } catch { throw unconfirmed(); }
  // An exact replay may describe an older save. Always obtain current images.
  const snapshot = validateCmsSnapshot(await read()); current();
  let recoveryPending = false;
  try { removeMatching(); } catch { current(); recoveryPending = true; }
  return {...snapshot, replayed: result.replayed, superseded: saved.revision !== snapshot.revision, recoveryPending};
}
