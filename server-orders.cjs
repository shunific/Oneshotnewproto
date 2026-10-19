const { assertTableNotHeld } = require('./server-reservation-moves.cjs');
const sqlite3 = require('sqlite3');
const { createHash } = require('node:crypto');
const { canonicalSession } = require('./server-checkout.cjs');
const { calculateSessionBill } = require('./session-billing.mjs');

const failure = (status, message) => Object.assign(new Error(message), { status });
const quantity = value => Number.isSafeInteger(value) && value > 0;
const cents = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
      !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) {
    throw failure(409, 'Invalid stored item price.');
  }
  return Math.round(value * 100);
};
const run = (db, sql, values = []) => new Promise((resolve, reject) => {
  db.run(sql, values, function (error) { error ? reject(error) : resolve(this); });
});
const get = (db, sql, values = []) => new Promise((resolve, reject) => {
  db.get(sql, values, (error, row) => error ? reject(error) : resolve(row));
});
const close = db => new Promise(resolve => db.close(resolve));

async function transaction(dbPath, tableId, operationKey, expectedSessionStartTime, requestPayload, operation) {
  const requestFingerprint = createHash('sha256').update(canonicalSession({ tableId, expectedSessionStartTime: new Date(expectedSessionStartTime).toISOString(), payload: requestPayload })).digest('hex');
  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE,
      error => error ? reject(error) : resolve(connection));
  });
  db.configure('busyTimeout', 5000);
  let begun = false;
  try {
    await run(db, 'BEGIN IMMEDIATE');
    begun = true;
    await assertTableNotHeld(db,tableId);
    const table = await get(db, 'SELECT id, status, isActive, sessionData FROM tables WHERE id = ?', [tableId]);
    if (!table) throw failure(404, 'Table was not found.');
    if (table.status !== 'occupied' || table.isActive !== 1) throw failure(409, 'Table has no active occupied session.');
    let session;
    try { session = JSON.parse(table.sessionData); } catch { throw failure(409, 'Table session is invalid.'); }
    if (!session || typeof session !== 'object' || Array.isArray(session) ||
        (session.orders !== undefined && !Array.isArray(session.orders))) throw failure(409, 'Table session is invalid.');
    const currentStart = typeof session.startTime === 'string' ? Date.parse(session.startTime) : NaN;
    if (!Number.isFinite(currentStart) || currentStart !== Date.parse(expectedSessionStartTime)) throw failure(409, 'Table session changed. Reopen the table before ordering.');
    const billingTime = Date.now();
    calculateSessionBill(session, billingTime, false);
    session.orders = session.orders || [];
    for (const order of session.orders) {
      if (!order || typeof order.id !== 'string' || !quantity(order.qty)) throw failure(409, 'Stored orders are invalid.');
      cents(order.price);
    }
    const operations = session.processedOrderOperations || [];
    if (!Array.isArray(operations) || operations.some(entry => !entry || typeof entry.key !== 'string' || !Array.isArray(entry.inventoryIds))) throw failure(409, 'Order operation history is invalid.');
    const replay = operations.find(entry => entry.key === operationKey);
    let inventory;
    if (replay) {
      if (typeof replay.requestFingerprint !== 'string') throw failure(409, 'Legacy order retry requires reconciliation of the saved order before continuing.');
      if (replay.requestFingerprint !== requestFingerprint) throw failure(409, 'Request ID was already used for different order details. Retry the original request.');
      inventory = [];
      for (const id of replay.inventoryIds) {
        const item = await get(db, 'SELECT * FROM inventory WHERE id = ?', [id]);
        if (!item) throw failure(409, 'Previously ordered inventory is unavailable.');
        inventory.push({ ...item, isActive: item.isActive === 1 });
      }
    } else {
      if (operations.length >= 500) throw failure(409, 'Session order operation limit reached.');
      inventory = await operation(db, session);
      session.processedOrderOperations = [...operations, { key: operationKey, requestFingerprint, inventoryIds: inventory.map(item => item.id) }];
    }
    calculateSessionBill(session, billingTime, false);
    await run(db, 'UPDATE tables SET sessionData = ? WHERE id = ?', [JSON.stringify(session), tableId]);
    await run(db, 'COMMIT');
    begun = false;
    return { id: tableId, session, inventory };
  } catch (error) {
    if (begun) await run(db, 'ROLLBACK').catch(() => {});
    throw error;
  } finally { await close(db); }
}

function registerOrderRoutes(app, dbPath) {
  const requestKey = (req, kind) => {
    if (typeof req.body?.expectedSessionStartTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(req.body.expectedSessionStartTime) || !Number.isFinite(Date.parse(req.body.expectedSessionStartTime))) throw failure(400, 'Expected session start time is required.');
    if (typeof req.body?.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(req.body.requestId)) throw failure(400, 'A unique request ID is required.');
    return `${kind}:${req.body.requestId}`;
  };
  const respond = operation => async (req, res) => {
    try { res.json(await operation(req)); }
    catch (error) {
      const status = error.status || 503;
      res.status(status).json({ error: error.status ? error.message : 'Order could not be saved. Please retry.' });
    }
  };
  app.post('/api/tables/:id/orders', respond(async req => {
    const key = requestKey(req, 'submit');
    const cart = req.body?.cart;
    if (!Array.isArray(cart) || cart.length === 0 || cart.length > 100) throw failure(400, 'Cart must contain between 1 and 100 items.');
    const quantities = new Map();
    for (const item of cart) {
      if (!item || typeof item.id !== 'string' || !item.id || !quantity(item.qty)) throw failure(400, 'Cart items require an ID and positive integer quantity.');
      const total = (quantities.get(item.id) || 0) + item.qty;
      if (!quantity(total)) throw failure(400, 'Cart quantity is too large.');
      quantities.set(item.id, total);
    }
    return transaction(dbPath, req.params.id, key, req.body.expectedSessionStartTime, { cart }, async (db, session) => {
      const updated = [];
      for (const [id, qty] of quantities) {
        const item = await get(db, 'SELECT * FROM inventory WHERE id = ?', [id]);
        if (!item) throw failure(404, 'Inventory item was not found.');
        if (item.isActive !== 1 || !Number.isSafeInteger(item.stock) || item.stock < qty) throw failure(409, 'Inventory item is inactive or has insufficient stock.');
        const priceCents = cents(item.price);
        if (!Number.isSafeInteger(priceCents * qty)) throw failure(400, 'Order amount is too large.');
        const existing = session.orders.find(order => order.id === id && cents(order.price) === priceCents);
        if (existing) {
          if (!quantity(existing.qty + qty) || !Number.isSafeInteger(priceCents * (existing.qty + qty))) throw failure(409, 'Order amount is too large.');
          existing.qty += qty;
        } else session.orders.push({ id, name: item.name, price: priceCents / 100, qty });
        await run(db, 'UPDATE inventory SET stock = stock - ? WHERE id = ?', [qty, id]);
        updated.push({ ...item, stock: item.stock - qty, isActive: true });
      }
      return updated;
    });
  }));
  app.post('/api/tables/:id/orders/:orderIndex/void', respond(async req => {
    const key = requestKey(req, 'void');
    if (!/^(0|[1-9]\d*)$/.test(req.params.orderIndex)) throw failure(400, 'Invalid order index.');
    const index = Number(req.params.orderIndex);
    const expected = req.body?.expectedOrder;
    if (!Number.isSafeInteger(index) || !expected || typeof expected.id !== 'string' || !quantity(expected.qty) ||
        typeof expected.price !== 'number' || !Number.isFinite(expected.price)) throw failure(400, 'Expected order details are required.');
    return transaction(dbPath, req.params.id, key, req.body.expectedSessionStartTime, { orderIndex: index, expectedOrder: expected }, async (db, session) => {
      const order = session.orders[index];
      if (!order || order.id !== expected.id || order.qty !== expected.qty || order.price !== expected.price) throw failure(409, 'Order changed. Refresh before voiding.');
      const item = await get(db, 'SELECT * FROM inventory WHERE id = ?', [order.id]);
      if (!item) throw failure(404, 'Inventory item was not found.');
      if (!Number.isSafeInteger(item.stock) || item.stock < 0 || !Number.isSafeInteger(item.stock + order.qty)) throw failure(409, 'Inventory stock is invalid.');
      await run(db, 'UPDATE inventory SET stock = stock + ? WHERE id = ?', [order.qty, order.id]);
      session.orders.splice(index, 1);
      return [{ ...item, stock: item.stock + order.qty, isActive: item.isActive === 1 }];
    });
  }));
}

module.exports = { registerOrderRoutes };
