const storageKey = (tableId, startTime) => `oneshot_pending_order:${JSON.stringify([tableId, startTime])}`;

export function getPendingOrder(storage, tableId, startTime) {
  const raw = storage.getItem(storageKey(tableId, startTime));
  if (!raw) return null;
  const pending = JSON.parse(raw);
  if (!pending || typeof pending.requestId !== 'string' || typeof pending.operation !== 'string' || !pending.payload || pending.payload.expectedSessionStartTime !== startTime) {
    throw new Error('Pending order record could not be read. Reconcile this session before ordering.');
  }
  return pending;
}

export async function saveOrderOperation({ storage, request, tableId, operation, payload, newId = () => crypto.randomUUID() }) {
  const key = storageKey(tableId, payload.expectedSessionStartTime);
  let pending = getPendingOrder(storage, tableId, payload.expectedSessionStartTime);
  if (pending && (pending.operation !== operation || JSON.stringify(pending.payload) !== JSON.stringify(payload))) {
    throw new Error('Confirm the previous order operation before changing this cart.');
  }
  if (!pending) {
    pending = { requestId: newId(), operation, payload };
    storage.setItem(key, JSON.stringify(pending));
  }
  let saved;
  try {
    saved = await request(`/api/tables/${encodeURIComponent(tableId)}/${operation}`, { ...pending.payload, requestId: pending.requestId });
  } catch (error) {
    if (error.status >= 400 && error.status < 500) storage.removeItem(key);
    throw error;
  }
  const validMoney = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 100));
  const sameSession = Number.isFinite(Date.parse(saved?.session?.startTime)) && Date.parse(saved.session.startTime) === Date.parse(payload.expectedSessionStartTime);
  const validOrders = Array.isArray(saved?.session?.orders) && saved.session.orders.every(order => typeof order.id === 'string' && Number.isSafeInteger(order.qty) && order.qty > 0 && validMoney(order.price));
  const validInventory = Array.isArray(saved?.inventory) && saved.inventory.every(item => typeof item.id === 'string' && Number.isSafeInteger(item.stock) && item.stock >= 0 && validMoney(item.price) && typeof item.isActive === 'boolean');
  const operationKey = `${operation === 'orders' ? 'submit' : 'void'}:${pending.requestId}`;
  const acknowledged = saved?.session?.processedOrderOperations?.some(entry => entry.key === operationKey);
  const requiredIds = operation === 'orders' ? payload.cart.map(item => item.id) : [payload.expectedOrder.id];
  if (saved?.id !== tableId || !sameSession || !validOrders || !validInventory || !acknowledged || requiredIds.some(id => !saved.inventory.some(item => item.id === id))) throw new Error('Order save was not confirmed.');
  storage.removeItem(key);
  return saved;
}
