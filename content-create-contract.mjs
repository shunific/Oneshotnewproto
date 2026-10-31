export const contentCanonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
export const contentExact = (value, fields) => object(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const fail = () => { throw new Error('Review the complete original local content request.'); };
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const date = value => { if (value == null) return null; const result = new Date(value); if (!Number.isFinite(result.getTime())) fail(); return result.toISOString(); };
export function normalizeContentPayload(kind, input) {
  if (!object(input)) fail();
  const fields = kind === 'promo' ? ['code','description','discountPercent','isActive','isLimitedUses','maxUsage','startDate','expiresAt'] : kind === 'announcement' ? ['title','content','type','isActive','startDate','expiresAt'] : fail();
  if (Object.keys(input).some(key => !fields.includes(key) && !(kind === 'promo' && key === 'deleteWhenDepleted'))) fail();
  const payload = { ...Object.fromEntries(fields.filter(key => !['startDate','expiresAt'].includes(key)).map(key => [key, input[key]])), startDate: date(input.startDate), expiresAt: date(input.expiresAt) };
  if (typeof payload.isActive !== 'boolean' || (payload.startDate && payload.expiresAt && payload.startDate >= payload.expiresAt)) fail();
  if (kind === 'promo') {
    if (!text(payload.code,100) || !/^[A-Z0-9_-]+$/.test(payload.code.trim().toUpperCase()) || !text(payload.description,2000) || !Number.isInteger(payload.discountPercent) || payload.discountPercent < 1 || payload.discountPercent > 100 || typeof payload.isLimitedUses !== 'boolean' || !Number.isSafeInteger(payload.maxUsage) || payload.maxUsage < 1 || payload.maxUsage > 999999999) fail();
    payload.code = payload.code.trim().toUpperCase(); payload.description = payload.description.trim();
  } else {
    if (!text(payload.title,200) || !text(payload.content,10000) || !['info','warning','promo','event'].includes(payload.type)) fail();
    payload.title = payload.title.trim(); payload.content = payload.content.trim();
  }
  return payload;
}
export function validateContentCommand(kind, command) {
  if (!contentExact(command,['requestId','expectedActorId','payload']) || typeof command.requestId !== 'string' || !uuid.test(command.requestId) || !text(command.expectedActorId,120) || command.expectedActorId.trim() !== command.expectedActorId) fail();
  const normalized = normalizeContentPayload(kind,command.payload);
  if (contentCanonical(normalized) !== contentCanonical(command.payload)) fail();
  return JSON.parse(contentCanonical(command));
}
export const contentRecordId = (kind, requestId) => `${kind === 'promo' ? 'p' : 'a'}_${requestId}`;
export function validateCreatedContentRecord(kind, command, record) {
  const extra = kind === 'promo' ? ['usageCount'] : ['createdAt'];
  if (!contentExact(record,['id',...Object.keys(command.payload),...extra]) || record.id !== contentRecordId(kind,command.requestId)) fail();
  for (const field of Object.keys(command.payload)) if (contentCanonical(record[field]) !== contentCanonical(command.payload[field])) fail();
  if (kind === 'promo' ? record.usageCount !== 0 : !iso(record.createdAt)) fail();
  return JSON.parse(contentCanonical(record));
}
export function validateContentAck(kind,command,result) {
  if (!contentExact(result,['requestId','kind','actorId','recordType','record','replayed']) || result.requestId !== command.requestId || result.kind !== kind || result.actorId !== command.expectedActorId || result.recordType !== 'local-content-create' || typeof result.replayed !== 'boolean') fail();
  return validateCreatedContentRecord(kind,command,result.record);
}
export function isContentReconciliation(kind,command,status,result) {
  return status === 409 && contentExact(result,['error','code','requestId','kind','actorId','recordId','state']) && typeof result.error === 'string' && result.code === 'CONTENT_CREATE_RECONCILE' && result.requestId === command.requestId && result.kind === kind && result.actorId === command.expectedActorId && result.recordId === contentRecordId(kind,command.requestId) && ['changed','deleted'].includes(result.state);
}
