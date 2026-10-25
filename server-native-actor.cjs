const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const localId = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && value === value.trim();
function createNativeActorGuard({ resolveActor, isActorCurrent }, changed) {
  if (typeof resolveActor !== 'function' || typeof isActorCurrent !== 'function' || typeof changed !== 'function') throw new TypeError('Trusted identity and generation callbacks are required.');
  function assertCurrent(token, expected) {
    if (isActorCurrent(token, expected) !== true) throw changed();
  }
  async function resolve(token, expectedCloudId) {
    const value = await resolveActor(token);
    if (!localId(value?.localStaffId) || !uuid(value?.cloudUserId) || !Number.isSafeInteger(value?.generation) || value.generation < 1 || (expectedCloudId && value.cloudUserId !== expectedCloudId)) throw changed();
    const snapshot = { localStaffId: value.localStaffId, cloudUserId: value.cloudUserId, generation: value.generation };
    assertCurrent(token,snapshot);return snapshot;
  }
  return { resolve, assertCurrent };
}
module.exports = { createNativeActorGuard };
