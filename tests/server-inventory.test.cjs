const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const sqlite3 = require('sqlite3');
const { registerInventoryRoutes } = require('../server-inventory.cjs');

test('inventory persists CRUD and rejects invalid or conflicting mutations', async (t) => {
  const db = new sqlite3.Database(':memory:');
  await new Promise((resolve, reject) => db.run(`CREATE TABLE inventory (id TEXT PRIMARY KEY, name TEXT UNIQUE, category TEXT, price REAL, stock INTEGER, isActive INTEGER, createdAt TEXT DEFAULT CURRENT_TIMESTAMP)`, error => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => db.run('CREATE TABLE tables (id TEXT PRIMARY KEY, status TEXT, sessionData TEXT)', error => error ? reject(error) : resolve()));
  const app = express();
  app.use(express.json());
  registerInventoryRoutes(app, db);
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await new Promise(resolve => db.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/inventory`;
  const call = async (method, suffix = '', body) => {
    const response = await fetch(base + suffix, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const read = id => new Promise((resolve, reject) => db.get('SELECT * FROM inventory WHERE id = ?', [id], (error, row) => error ? reject(error) : resolve(row)));
  const item = { name: ' Water ', category: 'Drinks', price: 0, stock: 0 };
  const created = await call('POST', '', item);
  assert.equal(created.status, 201);
  assert.ok(created.body.id);
  assert.equal(created.body.name, 'Water');
  assert.equal(created.body.isActive, true);
  const id = created.body.id;
  assert.equal((await read(id)).stock, 0);
  for (const changes of [{ price: 25.5 }, { stock: 12, expectedStock: 0 }, { isActive: false }, { isActive: true }, { name: "Water's special" }]) {
    const updated = await call('PUT', `/${id}`, changes);
    assert.equal(updated.status, 200);
    for (const [key, value] of Object.entries(changes)) if (key !== 'expectedStock') assert.equal(updated.body[key], value);
  }
  assert.equal((await read(id)).stock, 12);
  assert.equal((await call('PUT', `/${id}`, { stock: 100, expectedStock: 0, name: 'Must not save' })).status, 409);
  assert.equal((await read(id)).stock, 12);
  assert.equal((await call('PUT', `/${id}`, { stock: 100 })).status, 400);
  assert.equal((await call('PUT', `/${id}`, { expectedStock: 12 })).status, 400);
  assert.equal((await read(id)).isActive, 1);
  assert.equal((await read(id)).name, "Water's special");
  assert.equal((await call('POST', '', { ...item, id })).status, 409);
  assert.equal((await call('POST', '', { ...item, name: "Water's special" })).status, 409);
  for (const changes of [{ price: -1 }, { price: 1.234 }, { price: 1e20 }, { price: '5' }, { price: null }, { stock: -1 }, { stock: 1.2 }, { stock: '1' }, { stock: Number.MAX_SAFE_INTEGER + 1 }, { isActive: 1 }, { name: '  ' }, { category: '' }, { id: 'new-id' }, { 'name = NULL; DELETE FROM inventory': 'x' }, {}]) {
    assert.equal((await call('PUT', `/${id}`, changes)).status, 400);
  }
  assert.equal((await read(id)).price, 25.5);
  assert.equal((await call('POST', '', {})).status, 400);
  assert.equal((await call('POST', '', { ...item, price: 1.234 })).status, 400);
  assert.equal((await call('POST', '', { ...item, price: 1e20 })).status, 400);
  assert.equal((await call('POST', '', { ...item, id: ' ' })).status, 400);
  assert.equal((await call('PUT', '/missing', { stock: 1, expectedStock: 0 })).status, 404);
  assert.equal((await call('DELETE', '/missing')).status, 404);
  await new Promise((resolve, reject) => db.run('INSERT INTO tables VALUES (?, ?, ?)', ['table-1', 'occupied', JSON.stringify({ orders: [{ id, qty: 1, price: 25.5 }] })], error => error ? reject(error) : resolve()));
  assert.equal((await call('DELETE', `/${id}`)).status, 409);
  assert.ok(await read(id));
  assert.equal((await call('PUT', `/${id}`, { isActive: false })).status, 200);
  assert.equal((await call('DELETE', `/${id}`)).status, 409);
  await new Promise((resolve, reject) => db.run("UPDATE tables SET sessionData = 'invalid-json'", error => error ? reject(error) : resolve()));
  assert.equal((await call('DELETE', `/${id}`)).status, 409);
  await new Promise((resolve, reject) => db.run("UPDATE tables SET status = 'available', sessionData = NULL", error => error ? reject(error) : resolve()));
  const deleted = await call('DELETE', `/${id}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.id, id);
  assert.equal(await read(id), undefined);
  assert.equal((await call('DELETE', `/${id}`)).status, 404);
  await new Promise((resolve, reject) => db.run('DROP TABLE inventory', error => error ? reject(error) : resolve()));
  assert.equal((await call('POST', '', item)).status, 500);
  assert.equal((await call('PUT', '/missing', { stock: 1, expectedStock: 0 })).status, 500);
  assert.equal((await call('DELETE', '/missing')).status, 500);
});

test('inventory UI waits for persistence and retains forms on failure', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const esbuild = require('esbuild');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/app/pages/AdminInventory.tsx'), 'utf8');
  for (const operation of ['create', 'edit', 'restock', 'archive', 'restore', 'delete']) {
    for (const fails of [false, true]) {
      let release;
      const writes = [], closes = [], errors = [], busy = [];
      const mutation = (...args) => { writes.push(args); return new Promise((resolve, reject) => { release = () => fails ? reject(new Error('HTTP 500')) : resolve(); }); };
      const env = {
        isSaving: false, form: { name: ' Water ', category: 'Drinks', price: '0', stock: '0' },
        editingId: operation === 'edit' ? 'item-1' : null, editingStock: 10,
        inventory: [{ id: 'item-1', isActive: false, stock: 8 }], restockAmount: '3',
        updateInventoryItem: mutation, addInventoryItem: mutation, deleteInventoryItem: mutation,
        setError: value => errors.push(value), setIsSaving: value => busy.push(value),
        setShowModal: value => closes.push(['modal', value]),
        setRestockId: value => closes.push(['restock', value]),
        setRestockAmount: value => closes.push(['amount', value]),
      };
      const name = ['create', 'edit'].includes(operation) ? 'handleSave' : operation === 'restock' ? 'handleRestock' : 'handleItemAction';
      const start = source.indexOf(`  const ${name} =`);
      const next = name === 'handleSave' ? source.indexOf('  const handleRestock', start) : name === 'handleRestock' ? source.indexOf('  const handleItemAction', start) : source.indexOf('\n  return (', start);
      const script = esbuild.transformSync(source.slice(start, next), { loader: 'tsx' }).code;
      const handler = vm.runInNewContext(`${script}; ${name}`, env);
      const pending = name === 'handleSave' ? handler({ preventDefault() {} }) : name === 'handleRestock' ? handler({ preventDefault() {} }, 'item-1', 2) : handler('item-1', operation === 'archive' ? false : operation === 'restore' ? true : undefined);
      assert.equal(writes.length, 1, operation);
      assert.equal(closes.length, 0, `${operation}: no premature form close`);
      if (operation === 'edit') {
        assert.equal(writes[0][1].isActive, false, 'Editing preserves archived state');
        assert.equal(writes[0][2], 10, 'Edit uses opening stock snapshot rather than refreshed inventory');
      }
      if (operation === 'restock') assert.equal(writes[0][2], 2, 'Restock uses the same stock baseline as its calculation');
      release();
      await pending;
      assert.equal(busy.at(-1), false);
      if (fails) {
        assert.equal(closes.length, 0, `${operation}: preserve form on rejection`);
        assert.ok(errors.at(-1).includes('Unable'), operation);
      } else if (['create', 'edit', 'restock'].includes(operation)) assert.ok(closes.length > 0);
    }
  }
});
