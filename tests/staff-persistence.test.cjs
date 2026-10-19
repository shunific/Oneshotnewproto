const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const sqlite3 = require('sqlite3');

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

function venueWindow(){const local=new Date(Date.now()+8*3600000),m=local.getUTCHours()*60+local.getUTCMinutes(),time=n=>`${String(Math.floor((n%1440)/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;return{from:time((m+1440-180)%1440),to:time((m+180)%1440)};}

async function legacyDatabase(dir) {
  const db = new sqlite3.Database(path.join(dir, 'oneshot.db'));
  const run = statement => new Promise((resolve, reject) => db.run(statement, err => err ? reject(err) : resolve()));
  await run('CREATE TABLE staff (id TEXT PRIMARY KEY, username TEXT, password TEXT, fullName TEXT, role TEXT, phone TEXT, joinedDate TEXT, avatarImg TEXT, isActive INTEGER DEFAULT 1, isAdmin INTEGER DEFAULT 0, recoveryPin TEXT)');
  await run('CREATE TABLE system_settings (key_name TEXT PRIMARY KEY, setting_value TEXT)');
  await run("INSERT INTO system_settings VALUES ('hourlyRate','150'),('custom_key','legacy-conflict')");
  await run('CREATE TABLE systemSettings (keyName TEXT PRIMARY KEY, settingValue TEXT, updatedAt TEXT)');
  await run("INSERT INTO systemSettings VALUES ('custom_key','modern-preserved',null),('overtimeRate','150',null),('isWeekdayHappyHourActive','false',null),('isWeekendHappyHourActive','false',null)");
  const window=venueWindow();
  for(const [key,value]of Object.entries({weekdayStartTime:window.from,weekdayEndTime:window.to,weekendStartTime:window.from,weekendEndTime:window.to,bookingCutoffMinutes:'0'}))await run(`INSERT INTO systemSettings VALUES ('${key}','${value}',null)`);
  await run('CREATE TABLE cms_content (key_name TEXT PRIMARY KEY, content_value TEXT)');
  await run("INSERT INTO cms_content VALUES ('welcomeTitle','Legacy welcome'),('legacyFooter','Legacy footer')");
  await run('CREATE TABLE cms (keyName TEXT PRIMARY KEY, settingValue TEXT, updatedAt TEXT)');
  await run("INSERT INTO cms VALUES ('welcomeTitle','Modern welcome',null)");
  await new Promise(resolve => db.close(resolve));
}

async function legacySources(dir) {
  const db = new sqlite3.Database(path.join(dir, 'oneshot.db'), sqlite3.OPEN_READONLY);
  const read = query => new Promise((resolve, reject) => db.all(query, [], (error, rows) => error ? reject(error) : resolve(rows)));
  try {
    return { settings: await read('SELECT * FROM system_settings ORDER BY key_name'), cms: await read('SELECT * FROM cms_content ORDER BY key_name') };
  } finally { await new Promise(resolve => db.close(resolve)); }
}

async function startServer(dir, port) {
  const child = spawn(process.execPath, ['server.cjs'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'test', USER_DATA_PATH: dir, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Test server startup timeout: ${logs}`)), 10000);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited ${code}: ${logs}`)); });
    child.stderr.on('data', data => { logs += data; });
    child.stdout.on('data', data => { logs += data; });
    child.on('message', message => {
      if (message.type === 'backend-ready' && message.port === port) { clearTimeout(timer); resolve(); }
    });
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.disconnect();
    await exited;
  };
  try { await ready; } catch (error) { await stop(); throw error; }
  return stop;
}

test('full server enforces authenticated durable staff accounts across migration and restart', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oneshot-staff-test-'));
  const port = await freePort();
  await legacyDatabase(dir);
  let stop = await startServer(dir, port);
  t.after(async () => { await stop(); await rm(dir, { recursive: true }); });
  const actor = () => {
    let cookie = '';
    return (route, method = 'GET', body, headers = {}) => new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(`http://127.0.0.1:${port}${route}`, {
        method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
      }, response => {
        const setCookie = response.headers['set-cookie'];
        if (setCookie?.length) cookie = setCookie[0].split(';')[0];
        let text = '';
        response.on('data', data => { text += data; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, json: async () => JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(payload);
    });
  };
  const anon = actor(); const admin = actor(); const cashier = actor();
  const adminDetails = { username: 'qaAdmin', fullName: 'QA Synthetic Administrator', password: 'qa-integration-admin-unique9', recoveryPin: '823745' };
  const account = { id: 'qa_cashier', username: 'qaCashier', fullName: 'QA Synthetic Cashier', password: 'qa-temporary-staff-unique9', role: 'cashier', isActive: true, isAdmin: false };
  const newPassword = 'qa-changed-staff-unique9';
  let recoveryPin;
  const login = (request, username, password) => request('/api/auth/login', 'POST', { username, password });
  await t.test('all operational datasets deny unauthenticated reads before any account exists', async () => {
    for (const endpoint of ['staff', 'tables', 'inventory', 'reservations', 'queue', 'activities', 'events', 'feedback', 'announcements', 'session-history', 'e-receipts', 'settings/rates', 'cms', 'lost-and-found', 'watchlist', 'closed-dates', 'promo-codes']) {
      assert.equal((await anon(`/api/${endpoint}`)).status, 401, endpoint);
    }
    assert.equal((await anon('/api/auth/status')).status, 200);
    assert.equal((await (await anon('/api/auth/status')).json()).needsBootstrap, true);
    assert.equal((await anon('/api/staff', 'GET', undefined, { Cookie: 'oneshot_session=forged-token', 'X-Staff-Role': 'admin' })).status, 401);
  });
  await t.test('first administrator is explicitly created once; server cookie is HttpOnly', async () => {
    assert.equal((await anon('/api/auth/bootstrap', 'POST', adminDetails)).status, 201);
    assert.equal((await anon('/api/auth/bootstrap', 'POST', adminDetails)).status, 409);
    const signedIn = await login(admin, adminDetails.username, adminDetails.password);
    assert.equal(signedIn.status, 200);
    assert.match(signedIn.headers['set-cookie'][0], /HttpOnly/);
    assert.match(signedIn.headers['set-cookie'][0], /SameSite=Strict/);
    assert.equal((await signedIn.json()).user.isAdmin, true);
  });
  await t.test('upgrade imports legacy settings and CMS without deleting sources or overwriting newer values', async () => {
    const rates = await (await admin('/api/settings/rates')).json();
    assert.equal(rates.hourlyRate, 150);
    assert.equal(rates.custom_key, 'modern-preserved');
    const cms = await (await admin('/api/cms')).json();
    assert.equal(cms.welcomeTitle, 'Modern welcome');
    assert.equal(cms.legacyFooter, 'Legacy footer');
    const sources = await legacySources(dir);
    assert.deepEqual(sources.settings, [{ key_name: 'custom_key', setting_value: 'legacy-conflict' }, { key_name: 'hourlyRate', setting_value: '150' }]);
    assert.deepEqual(sources.cms, [{ key_name: 'legacyFooter', content_value: 'Legacy footer' }, { key_name: 'welcomeTitle', content_value: 'Legacy welcome' }]);
  });
  await t.test('staff creation acknowledges durable ID without disclosing password or recovery PIN', async () => {
    const created = await admin('/api/staff', 'POST', account);
    assert.equal(created.status, 201);
    assert.equal((await created.json()).id, account.id);
    const saved = (await (await admin('/api/staff')).json()).find(user => user.id === account.id);
    assert.equal(saved.isFirstLogin, true);
    assert.equal(saved.isActive, true);
    assert.equal(saved.isAdmin, false);
    assert.equal(Object.hasOwn(saved, 'password'), false);
    assert.equal(Object.hasOwn(saved, 'recoveryPin'), false);
    assert.equal((await admin('/api/staff', 'POST', { ...account, id: 'qa_duplicate', username: ' QACASHIER ' })).status, 409);
  });
  await t.test('temporary password requires authenticated first-login setup before operational access', async () => {
    assert.equal((await login(cashier, account.username, 'oneshotstaff')).status, 401);
    const signedIn = await login(cashier, ' QACASHIER ', account.password);
    assert.equal(signedIn.status, 200);
    assert.equal((await signedIn.json()).requiresPasswordChange, true);
    assert.equal((await cashier('/api/tables')).status, 403);
    assert.equal((await cashier('/api/staff/qa_cashier', 'PUT', { isFirstLogin: false, recoveryPin })).status, 403);
    const setup = await cashier('/api/auth/setup', 'POST', { currentPassword: account.password, newPassword });
    assert.equal(setup.status, 200);
    const issued = await setup.json();
    recoveryPin = issued.recoveryPin;
    assert.match(recoveryPin, /^\d{4}$/);
    assert.equal((await cashier('/api/tables')).status, 403);
    const acknowledged = await cashier('/api/auth/acknowledge-pin', 'POST', { acknowledged: true });
    assert.equal(acknowledged.status, 200);
    assert.equal((await acknowledged.json()).requiresPasswordChange, false);
    assert.equal((await cashier('/api/tables')).status, 200);
    const ownUsers = await (await cashier('/api/staff')).json();
    assert.deepEqual(ownUsers.map(user => user.id), [account.id]);
    assert.equal(ownUsers[0].recoveryPinSet, true);
  });
  await t.test('cashier cannot bypass admin writes using route capitalization or client profile claims', async () => {
    for (const [route, method] of [['/api/inventory', 'POST'], ['/api/inventory/QA', 'PUT'], ['/api/cms', 'PUT'], ['/api/settings/rates', 'PUT'], ['/api/promo-codes', 'POST'], ['/api/closed-dates', 'POST'], ['/api/announcements', 'POST'], ['/api/events', 'POST'], ['/api/tables', 'POST'], ['/api/tables/QA/orders/0/void', 'POST'], ['/api/cache-reservations', 'POST']]) {
      assert.equal((await cashier(route, method, {})).status, 403, route);
    }
    for (const [route, method] of [['/api/INVENTORY', 'POST'], ['/api/CMS', 'PUT'], ['/api/tables/QA/ORDERS/0/VOID', 'POST']]) {
      assert.equal((await cashier(route, method, {})).status, 404, route);
    }
    assert.equal((await cashier('/api/staff/admin_001', 'PUT', { isAdmin: true }, { 'X-Staff-Role': 'admin' })).status, 403);
    assert.equal((await anon('/api/tables', 'GET', undefined, { 'X-Staff-Id': 'admin_001', 'X-Staff-Role': 'admin' })).status, 401);
  });
  await t.test('unknown accounts and request-controlled SQL identifiers cannot report a successful save', async () => {
    assert.equal((await admin('/api/staff/not-an-id', 'PUT', { isActive: false })).status, 409);
    assert.equal((await admin('/api/staff/qa_cashier', 'PUT', { 'isAdmin = 1 WHERE 1=1 --': true })).status, 400);
    const queueBefore = await (await admin('/api/queue')).json();
    assert.equal((await admin('/api/queue/QA', 'PUT', { 'status = 1 WHERE 1=1 --': true })).status, 410);
    assert.deepEqual(await (await admin('/api/queue')).json(), queueBefore);
    assert.equal((await admin('/api/staff', 'POST', { ...account, id: 'bad_password', username: 'otherCashier', password: 'short' })).status, 400);
  });
  await t.test('hostile browser requests and legacy reset/history/receipt write endpoints remain blocked', async () => {
    assert.equal((await admin('/api/staff', 'GET', undefined, { Origin: 'https://unrelated.example' })).status, 403);
    assert.equal((await admin('/api/staff', 'GET', undefined, { Host: `attacker.example:${port}` })).status, 403);
    assert.equal((await admin('/api/staff/qa_cashier', 'PUT', { isAdmin: true }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    for (const route of ['/api/debug/reset', '/api/session-history', '/api/e-receipts']) assert.equal((await admin(route, 'POST', {})).status, 404, route);
    assert.equal((await cashier('/api/sync-to-cloud', 'POST', {})).status, 503);
    const saved = (await (await admin('/api/staff')).json()).find(user => user.id === account.id);
    assert.equal(saved.isAdmin, false);
  });
  await t.test('table administration persists one guarded state change and never deletes an occupied bill', async () => {
    const empty = { id: 'qa_table_admin', name: 'QA Admin Table', status: 'available', isActive: true };
    assert.equal((await admin('/api/tables', 'POST', empty)).status, 201);
    assert.equal((await admin('/api/tables', 'POST', { ...empty, id: 'qa_duplicate_table', name: ' qa admin table ' })).status, 409);
    for (const patch of [{ name: '' }, { name: 'x'.repeat(51) }, { status: 'occupied' }, { session: { customerName: 'Bypass' } }, { isActive: 1 }, { unknown: true }]) {
      assert.equal((await admin('/api/tables', 'POST', { ...empty, id: 'qa_bad_table', ...patch })).status, 400);
    }
    const maintenance = { status: 'maintenance', maintenanceReason: 'QA felt repair', isActive: false, expectedStatus: 'available', expectedSession: null };
    assert.equal((await admin('/api/tables/qa_table_admin', 'PUT', maintenance)).status, 200);
    assert.equal((await admin('/api/tables/qa_table_admin', 'PUT', maintenance)).status, 409);
    let saved = (await (await admin('/api/tables')).json()).find(table => table.id === empty.id);
    assert.equal(saved.status, 'maintenance'); assert.equal(saved.isActive, false); assert.equal(saved.maintenanceReason, 'QA felt repair');
    assert.equal((await admin('/api/tables/qa_table_admin', 'PUT', { status: 'available', session: null, maintenanceReason: '', isActive: true, expectedStatus: 'maintenance', expectedSession: null })).status, 200);
    const deleting = { expectedStatus: 'available', expectedSession: null };
    assert.equal((await cashier('/api/tables/qa_table_admin', 'DELETE', deleting)).status, 403);
    const deletions = await Promise.all([admin('/api/tables/qa_table_admin', 'DELETE', deleting), admin('/api/tables/qa_table_admin', 'DELETE', deleting)]);
    assert.deepEqual(deletions.map(response => response.status).sort(), [200,409]);
    assert.equal((await (await deletions.find(response => response.status === 200).json()).id), empty.id);
    assert.equal((await admin('/api/tables', 'POST', { ...empty, id: 'qa_guarded_table', name: 'QA Guarded Table' })).status, 201);
    const session = { customerName: 'QA protected bill', startTime: new Date().toISOString(), durationMinutes: 60, hourlyRate: 150, overtimeRate: 150, pricingVersion: 1, amountPaid: 0, isOpenTime: false, orders: [] };
    const guardedStart=await cashier('/api/tables/qa_guarded_table', 'PUT', { status: 'occupied', session, expectedStatus: 'available', expectedSession: null });
    assert.equal(guardedStart.status,200,JSON.stringify(await guardedStart.json()));
    Object.assign(session, (await (await cashier('/api/tables')).json()).find(t => t.id === 'qa_guarded_table').session);
    assert.equal((await admin('/api/tables/qa_guarded_table', 'DELETE', deleting)).status, 409);
    assert.equal((await admin('/api/tables/qa_guarded_table', 'PUT', { isActive: false })).status, 409);
    assert.equal((await admin('/api/tables/qa_guarded_table', 'PUT', { isActive: 0 })).status, 400);
    assert.equal((await admin('/api/tables/qa_guarded_table', 'PUT', { status: 'maintenance', isActive: false, expectedStatus: 'occupied', expectedSession: session })).status, 409);
    saved = (await (await admin('/api/tables')).json()).find(table => table.id === 'qa_guarded_table');
    assert.deepEqual(saved.session, session);
  });
  await t.test('authenticated checkout uses saved stock and prices, rejects stale/forged bills and commits only once', async () => {
    assert.equal((await admin('/api/settings/rates', 'PUT', { hourlyRate: 150 })).status, 404);
    const policy = await (await admin('/api/settings/policy')).json();
    const window=venueWindow();
    const policySave = await admin('/api/settings/policy', 'PUT', {
      expectedActorId: (await (await admin('/api/auth/me')).json()).user.id, expectedRevision: policy.revision,
      rates: { hourlyRate: 150, overtimeRate: 150, downPaymentPercent: 20, bookingCutoffMinutes: 60,
        weekdayStartTime: window.from, weekdayEndTime: window.to, isWeekdayHappyHourActive: false, weekdayHappyHourRate: 0, weekdayHappyHourStart: '15:00', weekdayHappyHourEnd: '18:00', weekdayOnlineCapacityLimit: 1,
        weekendStartTime: window.from, weekendEndTime: window.to, isWeekendHappyHourActive: false, weekendHappyHourRate: 0, weekendHappyHourStart: '15:00', weekendHappyHourEnd: '18:00', weekendOnlineCapacityLimit: 1 },
      terms: { minHours: 1, maxHours: 24, advanceBookingHours: 1, cancellationHours: 12, cancellationPolicy: 'QA TEST ONLY', termsAndConditions: 'QA TEST ONLY', weekdayMinPartySize: 1, weekdayMaxPartySize: 8, weekendMinPartySize: 1, weekendMaxPartySize: 8 },
    });
    assert.equal(policySave.status, 200, JSON.stringify(await policySave.json()));
    assert.equal((await admin('/api/tables', 'POST', { id: 'qa_checkout_table', name: 'QA Checkout Table', status: 'available', isActive: true })).status, 201);
    assert.equal((await admin('/api/inventory', 'POST', { id: 'qa_checkout_drink', name: 'QA Drink', category: 'drinks', price: 25, stock: 5, isActive: true })).status, 201);
    const session = { customerName: 'QA Integration Checkout', startTime: new Date().toISOString(), durationMinutes: 60, hourlyRate: 150, overtimeRate: 150, pricingVersion: 1, amountPaid: 0, isOpenTime: false, orders: [], partySize: 2 };
    const assign = candidate => cashier('/api/tables/qa_checkout_table', 'PUT', { status: 'occupied', session: candidate, expectedStatus: 'available', expectedSession: null });
    assert.equal((await assign({ ...session, hourlyRate: 0.01 })).status, 409);
    assert.equal((await assign({ ...session, amountPaid: 151 })).status, 400);
    assert.equal((await assign(session)).status, 200);
    Object.assign(session, (await (await cashier('/api/tables')).json()).find(t => t.id === 'qa_checkout_table').session);
    for (const changes of [{ overtimeRate: 999 }, { pricingVersion: 2 }, { hourlyRate: 0.01 }, { amountPaid: 150 }, { durationMinutes: 1 }, { orders: [{ id: 'qa_checkout_drink', price: 0, qty: 9 }] }]) {
      assert.equal((await cashier('/api/tables/qa_checkout_table', 'PUT', { status: 'occupied', session: { ...session, ...changes }, expectedStatus: 'occupied', expectedSession: session })).status, 409);
    }
    assert.equal((await cashier('/api/tables/qa_checkout_table', 'PUT', { status: 'available', session: null, expectedStatus: 'occupied', expectedSession: session })).status, 409);
    const ordered = await cashier('/api/tables/qa_checkout_table/orders', 'POST', { requestId: 'qa-real-order-0001', expectedSessionStartTime: session.startTime, cart: [{ id: 'qa_checkout_drink', qty: 2, price: 0.01 }] });
    assert.equal(ordered.status, 200);
    const savedSession = (await ordered.json()).session;
    assert.equal(savedSession.orders[0].price, 25);
    assert.equal(savedSession.overtimeRate, 150); assert.equal(savedSession.pricingVersion, 1);
    const checkout = { requestId: 'qa-real-checkout-0001', expectedSessionStartTime: session.startTime, expectedSession: session, paymentStatus: 'paid', paymentMethod: 'cash', tendered: 250, useProrated: false, closureKind: 'checkout' };
    assert.equal((await cashier('/api/tables/qa_checkout_table/checkout', 'POST', checkout)).status, 409);
    checkout.expectedSession = savedSession;
    const paid = await cashier('/api/tables/qa_checkout_table/checkout', 'POST', checkout);
    assert.equal(paid.status, 200);
    const result = await paid.json();
    assert.equal(result.receipt.total_amount, 200);
    assert.equal(result.receipt.amount_paid, 200);
    assert.equal(result.receipt.balance_due, 0);
    assert.equal(result.change, 50);
    assert.equal(result.replayed, false);
    const replay = await cashier('/api/tables/qa_checkout_table/checkout', 'POST', checkout);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).replayed, true);
    assert.equal((await cashier('/api/tables/qa_checkout_table/checkout', 'POST', { ...checkout, tendered: 300 })).status, 409);
    const receipts = await (await cashier('/api/e-receipts')).json();
    const history = await (await cashier('/api/session-history')).json();
    const table = (await (await cashier('/api/tables')).json()).find(row => row.id === 'qa_checkout_table');
    const item = (await (await cashier('/api/inventory')).json()).find(row => row.id === 'qa_checkout_drink');
    assert.equal(receipts.filter(row => row.table_id === 'qa_checkout_table').length, 1);
    assert.equal(history.filter(row => row.tableId === 'qa_checkout_table').length, 1);
    assert.equal(table.status, 'available');
    assert.equal(table.sessionData, null);
    assert.equal(item.stock, 3);
  });
  await t.test('overpaid early checkout persists a pending refund without claiming money was returned', async () => {
    assert.equal((await admin('/api/tables', 'POST', { id: 'qa_refund_table', name: 'QA Refund Table', status: 'available', isActive: true })).status, 201);
    const session = { customerName: 'QA Integration Refund', startTime: new Date().toISOString(), durationMinutes: 120, hourlyRate: 150, overtimeRate: 150, pricingVersion: 1, amountPaid: 300, isOpenTime: false, orders: [], partySize: 2 };
    assert.equal((await cashier('/api/tables/qa_refund_table', 'PUT', { status: 'occupied', session, expectedStatus: 'available', expectedSession: null })).status, 200);
    Object.assign(session, (await (await cashier('/api/tables')).json()).find(t => t.id === 'qa_refund_table').session);
    const response = await cashier('/api/tables/qa_refund_table/checkout', 'POST', { requestId: 'qa-real-refund-0001', expectedSessionStartTime: session.startTime, expectedSession: session, paymentStatus: 'paid', paymentMethod: 'cash', tendered: 0, useProrated: true, closureKind: 'checkout' });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.refundDue, 150);
    assert.equal(saved.history.status, 'refund_pending');
    assert.equal(saved.receipt.refund_due, 150);
    assert.equal(saved.receipt.refund_status, 'pending');
    assert.equal(saved.receipt.payment_status, 'refund_pending');
    const persisted = (await (await cashier('/api/e-receipts')).json()).find(row => row.table_id === 'qa_refund_table');
    assert.equal(persisted.refund_due, 150);
    assert.equal(persisted.refund_status, 'pending');
  });
  await t.test('password setup persists across restart while old session cookies are invalidated', async () => {
    await stop(); stop = await startServer(dir, port);
    assert.equal((await admin('/api/staff')).status, 401);
    assert.equal((await cashier('/api/tables')).status, 401);
    assert.equal((await login(cashier, account.username, account.password)).status, 401);
    assert.equal((await login(cashier, account.username, newPassword)).status, 200);
    assert.equal((await login(admin, adminDetails.username, adminDetails.password)).status, 200);
    const users = await (await admin('/api/staff')).json();
    const saved = users.find(user => user.id === account.id);
    assert.equal(saved.isFirstLogin, false);
    assert.equal(saved.recoveryPinSet, true);
    assert.equal(users.filter(user => user.username.toLowerCase() === 'qacashier').length, 1);
    assert.equal(users.some(user => user.password || user.recoveryPin), false);
    const rates = await (await admin('/api/settings/rates')).json();
    assert.equal(rates.hourlyRate, 150);
    assert.equal(rates.custom_key, 'modern-preserved');
    const cms = await (await admin('/api/cms')).json();
    assert.equal(cms.welcomeTitle, 'Modern welcome');
    assert.equal(cms.legacyFooter, 'Legacy footer');
    const sources = await legacySources(dir);
    assert.equal(sources.settings.length, 2);
    assert.equal(sources.cms.length, 2);
    assert.equal(sources.settings.find(row => row.key_name === 'custom_key').setting_value, 'legacy-conflict');
    assert.equal(sources.cms.find(row => row.key_name === 'welcomeTitle').content_value, 'Legacy welcome');
  });
  await t.test('persisted recovery secret works after restart and revokes existing cashier sessions', async () => {
    const recoveredPassword = 'qa-recovered-staff-unique9';
    assert.equal((await anon('/api/auth/recover', 'POST', { username: account.username, recoveryPin, newPassword: recoveredPassword })).status, 200);
    assert.equal((await cashier('/api/tables')).status, 401);
    assert.equal((await login(cashier, account.username, newPassword)).status, 401);
    assert.equal((await login(cashier, account.username, recoveredPassword)).status, 200);
  });
});
