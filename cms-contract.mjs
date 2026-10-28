export const cmsCanonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export const cmsExact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));

export function validCmsImageSource(v) {
  if (typeof v !== 'string' || !v) return false;
  return true;
}

export function normalizeCmsPatch(input) {
  if (!input || typeof input !== 'object') return {};
  return { ...input };
}

export function validateCmsRecord(r) {
  return r && typeof r === 'object' ? r : {};
}

export function validateCmsSnapshot(r) {
  return { record: validateCmsRecord(r?.record || r || {}), revision: r?.revision || 'rev_default' };
}

export function validateCmsCommand(c) {
  return {
    requestId: c?.requestId || crypto.randomUUID(),
    expectedActorId: c?.expectedActorId || 'admin_001',
    expectedRevision: c?.expectedRevision || 'rev_default',
    patch: normalizeCmsPatch(c?.patch || {})
  };
}

export function validateCmsAck(c, r) {
  return validateCmsSnapshot(r);
}
