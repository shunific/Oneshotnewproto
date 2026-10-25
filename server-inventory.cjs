const { randomUUID } = require('node:crypto');

const columns = ['name', 'category', 'price', 'stock', 'isActive'];
function validate(body, creating) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Inventory data is required.';
  const allowed = creating ? ['id', ...columns] : [...columns, 'expectedStock'];
  if (Object.keys(body).some(key => !allowed.includes(key))) return 'Unknown inventory field.';
  if (creating && body.id !== undefined && (typeof body.id !== 'string' || !body.id.trim())) return 'Invalid item ID.';
  for (const key of ['name', 'category']) {
    if ((creating || key in body) && (typeof body[key] !== 'string' || !body[key].trim())) return `${key} is required.`;
  }
  if (creating || 'price' in body) {
    const price = body.price;
    const cents = Math.round(price * 100);
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || !Number.isSafeInteger(cents) || Math.abs(price * 100 - cents) > 0.000001) return 'Price must be nonnegative, have at most two decimal places, and fit within the supported amount.';
  }
  if ((creating || 'stock' in body) && (!Number.isSafeInteger(body.stock) || body.stock < 0)) return 'Stock must be a nonnegative integer.';
  if (!creating && 'stock' in body && (!Number.isSafeInteger(body.expectedStock) || body.expectedStock < 0)) return 'Expected stock must be a nonnegative integer.';
  if (!creating && 'expectedStock' in body && !('stock' in body)) return 'Expected stock requires a stock update.';
  if ('isActive' in body && typeof body.isActive !== 'boolean') return 'isActive must be a boolean.';
  if (!creating && !Object.keys(body).length) return 'At least one inventory field is required.';
}
function failure(res, error) {
  if (error.code?.startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'Inventory conflicts with an existing record or constraint.' });
  return res.status(500).json({ error: 'Unable to persist inventory changes.' });
}
function sendSaved(db, id, res, status) {
  db.get('SELECT id, name, category, price, stock, isActive, createdAt FROM inventory WHERE id = ?', [id], (error, row) => {
    if (error) return failure(res, error);
    if (!row) return res.status(404).json({ error: 'Inventory item was not found.' });
    res.status(status).json({ ...row, isActive: row.isActive === 1 });
  });
}
function registerInventoryRoutes(app, db) {
  app.post('/api/inventory', (req, res) => {
    const invalid = validate(req.body, true);
    if (invalid) return res.status(400).json({ error: invalid });
    const { name, category, price, stock, isActive = true } = req.body;
    const id = req.body.id || randomUUID();
    db.run('INSERT INTO inventory (id, name, category, price, stock, isActive) VALUES (?, ?, ?, ?, ?, ?)',
      [id, name.trim(), category.trim(), price, stock, isActive ? 1 : 0], function (error) {
        if (error) return failure(res, error);
        sendSaved(db, id, res, 201);
      });
  });
  app.put('/api/inventory/:id', (req, res) => {
    const invalid = validate(req.body, false);
    if (invalid) return res.status(400).json({ error: invalid });
    const changed = columns.filter(key => key in req.body);
    const values = changed.map(key => key === 'isActive' ? (req.body[key] ? 1 : 0) : typeof req.body[key] === 'string' ? req.body[key].trim() : req.body[key]);
    // Column names come exclusively from the fixed allowlist above.
    const stockUpdate = 'stock' in req.body;
    const condition = stockUpdate ? ' AND stock = ?' : '';
    const parameters = [...values, req.params.id, ...(stockUpdate ? [req.body.expectedStock] : [])];
    db.run(`UPDATE inventory SET ${changed.map(key => `${key} = ?`).join(', ')} WHERE id = ?${condition}`, parameters, function (error) {
      if (error) return failure(res, error);
      if (!this.changes) {
        return db.get('SELECT id FROM inventory WHERE id = ?', [req.params.id], (readError, row) => {
          if (readError) return failure(res, readError);
          res.status(row ? 409 : 404).json({ error: row ? 'Stock changed. Refresh before updating inventory.' : 'Inventory item was not found.' });
        });
      }
      sendSaved(db, req.params.id, res, 200);
    });
  });
  app.delete('/api/inventory/:id', (req, res) => {
    const sql = `DELETE FROM inventory WHERE id = ? AND NOT EXISTS (
      SELECT 1 FROM tables AS venue_table
      WHERE venue_table.status = 'occupied' AND venue_table.sessionData IS NOT NULL
      AND (
        NOT json_valid(venue_table.sessionData)
        OR EXISTS (
          SELECT 1 FROM json_each(CASE WHEN json_valid(venue_table.sessionData) THEN venue_table.sessionData ELSE '{}' END, '$.orders') AS session_order
          WHERE json_extract(CASE WHEN session_order.type = 'object' THEN session_order.value ELSE '{}' END, '$.id') = inventory.id
        )
      )
    )`;
    // The reference check and deletion share one write statement, serialized with order transactions.
    db.run(sql, [req.params.id], function (error) {
      if (error) return failure(res, error);
      if (!this.changes) {
        return db.get('SELECT id FROM inventory WHERE id = ?', [req.params.id], (readError, row) => {
          if (readError) return failure(res, readError);
          res.status(row ? 409 : 404).json({ error: row ? 'This item is referenced by an active session. Archive it instead.' : 'Inventory item was not found.' });
        });
      }
      res.json({ id: req.params.id, message: 'Inventory item deleted.' });
    });
  });
}
module.exports = { registerInventoryRoutes };
