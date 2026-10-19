const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const COOKIE = 'oneshot_session';
const PUBLIC_FIELDS = ['id', 'username', 'fullName', 'role', 'phone', 'joinedDate', 'avatarImg'];
const publicStaff = row => row && ({ ...Object.fromEntries(PUBLIC_FIELDS.map(key => [key, row[key]])), isActive: Boolean(row.isActive), isAdmin: Boolean(row.isAdmin), isFirstLogin: Boolean(row.isFirstLogin), recoveryPinSet: typeof row.recoveryPin === 'string' && /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(row.recoveryPin) });
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (left, right) => typeof left === 'string' && typeof right === 'string' && left.length === right.length && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function(error) { error ? reject(error) : resolve({ changes: this.changes }); }));
const get = (db, sql, args = []) => new Promise((resolve, reject) => db.get(sql, args, (error, row) => error ? reject(error) : resolve(row)));
const all = (db, sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (error, rows) => error ? reject(error) : resolve(rows)));
const LEGACY_BOOTSTRAP_DIGEST = '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9';
const validPassword = value => typeof value === 'string' && value.length >= 8 && value.length <= 256 && /[a-zA-Z]/.test(value) && /[0-9]/.test(value) && value !== 'oneshotstaff';
const validPin = value => typeof value === 'string' && /^\d{4,12}$/.test(value);
const bool = value => value === true || value === 1;

async function hashSecret(value) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(value, salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
}
async function verifySecret(value, stored, legacyDigest = false) {
  if (typeof stored !== 'string' || typeof value !== 'string') return false;
  if (!stored.startsWith('scrypt$')) return equal(legacyDigest ? digest(value) : value, stored);
  const parts = stored.split('$');
  if (parts.length !== 3 || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{128}$/.test(parts[2])) return false;
  return equal((await scrypt(legacyDigest ? digest(value) : value, parts[1], 64)).toString('hex'), parts[2]);
}

function registerAuthRoutes(app, db, options = {}) {
  const sessions = new Map();
  const now = options.now || Date.now;
  const sessionLifetime = options.sessionLifetime || 8 * 60 * 60 * 1000;
  // Persist failures so reopening the desktop application cannot reset recovery guesses.
  const ready = run(db, 'CREATE TABLE IF NOT EXISTS auth_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL)');
  const wrap = handler => async (req, res, next) => {
    try { await ready; await handler(req, res, next); }
    catch (error) {
      if (!res.headersSent) res.status(error.code === 'SQLITE_CONSTRAINT' ? 409 : 503).json({ error: error.code === 'SQLITE_CONSTRAINT' ? 'Account details conflict with an existing record.' : 'Account service unavailable. Retry shortly.' });
    }
  };
  const findUser = username => get(db, 'SELECT * FROM staff WHERE lower(trim(username)) = lower(?)', [username]);
  const setCookie = (res, token) => res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionLifetime / 1000)}`);
  const clearCookie = res => res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  const tokenOf = req => {
    const part = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`));
    return part ? part.slice(COOKIE.length + 1) : '';
  };
  const endSession = token => { if (sessions.delete(token)) options.onSessionEnd?.(token); };
  const invalidate = id => { for (const [token, session] of sessions) if (session.id === id) endSession(token); };
  const establish = (res, user) => {
    for (const [key, value] of sessions) if (value.expires <= now()) endSession(key);
    if (sessions.size >= 1000) throw new Error('Session capacity reached');
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { id: user.id, credential: user.password, expires: now() + sessionLifetime });
    setCookie(res, token);
    return token;
  };
  const throttle = async (req, res, kind, username) => {
    const timestamp = now();
    await run(db, 'DELETE FROM auth_attempts WHERE expires <= ?', [timestamp]);
    const keys = [`${kind}:global`, `${kind}:user:${digest(username.toLowerCase())}`];
    for (let index = 0; index < keys.length; index++) {
      // The conditional UPSERT reserves a guess atomically across concurrent requests.
      const reserved = await get(db, 'INSERT INTO auth_attempts (key, attempts, expires) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1 WHERE attempts < ? RETURNING attempts', [keys[index], timestamp + 15 * 60 * 1000, index === 0 ? 50 : 5]);
      if (!reserved) {
        res.setHeader('Retry-After', '900');
        res.status(429).json({ error: 'Too many attempts. Wait 15 minutes and retry.' });
        return false;
      }
    }
    return true;
  };
  const clearAttempts = (kind, username) => run(db, 'DELETE FROM auth_attempts WHERE key = ?', [`${kind}:user:${digest(username.toLowerCase())}`]);
  const requireSession = wrap(async (req, res, next) => {
    const token = tokenOf(req);
    const session = sessions.get(token);
    if (!session || session.expires <= now()) {
      endSession(token);
      return res.status(401).json({ error: 'Sign in to continue.' });
    }
    const user = await get(db, 'SELECT * FROM staff WHERE id = ?', [session.id]);
    if (!user || !bool(user.isActive) || user.password !== session.credential || sessions.get(token) !== session || session.expires <= now()) {
      // A stale request can finish after a different login set the browser cookie.
      // Invalidate its server token without overwriting that newer cookie.
      endSession(token);
      return res.status(401).json({ error: 'Your session has ended. Sign in again.' });
    }
    req.staff = user;
    req.authToken = token;
    next();
  });
  const requireAuth = [requireSession, (req, res, next) => req.staff.isFirstLogin ? res.status(403).json({ error: 'Change your temporary password before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' }) : next()];
  const requireAdmin = [...requireAuth, (req, res, next) => bool(req.staff.isAdmin) ? next() : res.status(403).json({ error: 'Administrator access required.' })];
  const result = user => ({ user: publicStaff(user), requiresPasswordChange: Boolean(user.isFirstLogin) });

  app.post('/api/auth/login', wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !username.trim() || username.length > 100 || typeof password !== 'string' || !password || password.length > 256) return res.status(400).json({ error: 'Enter your username and password.' });
    const name = username.trim();
    if (!await throttle(req, res, 'login', name)) return;
    const user = await findUser(name);
    const matches = await verifySecret(password, user?.password || '0'.repeat(64), true);
    if (!user || !bool(user.isActive) || !matches) return res.status(401).json({ error: 'Invalid username or password.' });
    if ((user.id === 'admin_001' && equal(digest(password), LEGACY_BOOTSTRAP_DIGEST)) || !publicStaff(user).recoveryPinSet) {
      await run(db, 'UPDATE staff SET isFirstLogin = 1 WHERE id = ?', [user.id]);
      user.isFirstLogin = 1;
    }
    if (!user.password.startsWith('scrypt$')) {
      const hashed = await hashSecret(digest(password));
      const changed = await run(db, 'UPDATE staff SET password = ? WHERE id = ? AND password = ?', [hashed, user.id, user.password]);
      if (changed.changes !== 1) return res.status(409).json({ error: 'Account changed. Retry sign in.' });
      user.password = hashed;
    }
    await clearAttempts('login', name);
    establish(res, user);
    res.json(result(user));
  }));
  app.post('/api/auth/bootstrap', wrap(async (req, res) => {
    const { username, fullName, password, recoveryPin } = req.body || {};
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_.@-]{4,100}$/.test(username.trim()) || typeof fullName !== 'string' || !fullName.trim() || fullName.length > 200 || !validPassword(password) || !validPin(recoveryPin)) return res.status(400).json({ error: 'Enter valid initial administrator details, a password of 8–256 characters with letters and numbers, and a recovery PIN.' });
    const saved = await run(db, `INSERT INTO staff (id, username, password, fullName, role, phone, joinedDate, avatarImg, isActive, isAdmin, recoveryPin, isFirstLogin) SELECT 'admin_001', ?, ?, ?, 'manager', '', ?, '', 1, 1, ?, 0 WHERE NOT EXISTS (SELECT 1 FROM staff)`, [username.trim(), await hashSecret(digest(password)), fullName.trim(), new Date().toISOString(), await hashSecret(recoveryPin)]);
    if (saved.changes !== 1) return res.status(409).json({ error: 'Initial setup is already complete.' });
    res.status(201).json({ success: true });
  }));
  app.get('/api/auth/bootstrap', wrap(async (req, res) => res.json({ required: !(await get(db, 'SELECT id FROM staff LIMIT 1')) })));
  app.get('/api/auth/status', wrap(async (req, res) => res.json({ needsBootstrap: !(await get(db, 'SELECT id FROM staff LIMIT 1')) })));
  app.post('/api/auth/change-username', requireAuth, wrap(async (req, res) => {
    const { username, currentPassword } = req.body || {};
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_.@-]{4,100}$/.test(username.trim())) return res.status(400).json({ error: 'Use 4–100 letters, numbers, periods, underscores, hyphens or @.' });
    if (!await throttle(req, res, 'change', req.staff.username)) return;
    if (!await verifySecret(currentPassword, req.staff.password, true)) return res.status(401).json({ error: 'Current password is incorrect.' });
    const saved = await run(db, 'UPDATE staff SET username = ? WHERE id = ? AND password = ? AND NOT EXISTS (SELECT 1 FROM staff WHERE lower(trim(username)) = lower(?) AND id != ?)', [username.trim(), req.staff.id, req.staff.password, username.trim(), req.staff.id]);
    if (saved.changes !== 1) return res.status(409).json({ error: 'Username is already taken or account changed.' });
    await clearAttempts('change', req.staff.username);
    res.json({ id: req.staff.id, user: publicStaff({ ...req.staff, username: username.trim() }) });
  }));
  app.post('/api/auth/verify', requireAuth, wrap(async (req, res) => {
    if (!await throttle(req, res, 'verify', req.staff.username)) return;
    if (!await verifySecret(req.body?.password, req.staff.password, true)) return res.status(401).json({ error: 'Password is incorrect.' });
    await clearAttempts('verify', req.staff.username);
    res.json({ success: true });
  }));
  app.post('/api/staff/:id/reset-password', requireAdmin, wrap(async (req, res) => {
    if (req.params.id === req.staff.id || req.params.id === 'admin_001') return res.status(403).json({ error: 'Use your own account security settings.' });
    if (!validPassword(req.body?.newPassword)) return res.status(400).json({ error: 'Use a temporary password of 8–256 characters with letters and numbers.' });
    const saved = await run(db, 'UPDATE staff SET password = ?, recoveryPin = ?, isFirstLogin = 1 WHERE id = ?', [await hashSecret(digest(req.body.newPassword)), '', req.params.id]);
    if (saved.changes !== 1) return res.status(404).json({ error: 'Account not found.' });
    invalidate(req.params.id);
    res.json({ success: true, id: req.params.id });
  }));
  app.get('/api/auth/me', requireSession, (req, res) => res.json(result(req.staff)));
  app.post('/api/auth/logout', (req, res) => { endSession(tokenOf(req)); clearCookie(res); res.json({ success: true }); });
  app.post('/api/auth/setup', requireSession, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const body = req.body;
    if (!body || Object.keys(body).length !== 2 || Object.keys(body).some(key => !['currentPassword', 'newPassword'].includes(key)) || !validPassword(body.newPassword) || typeof body.currentPassword !== 'string' || body.currentPassword.length > 256) return res.status(400).json({ error: 'Enter your current password and a different new password of 8–256 characters with letters and numbers.' });
    if (!req.staff.isFirstLogin) return res.status(409).json({ error: 'First-login setup is not required.' });
    if (!await throttle(req, res, 'setup', req.staff.username)) return;
    const session = sessions.get(req.authToken);
    if (!await verifySecret(body.currentPassword, req.staff.password, true)) return res.status(401).json({ error: 'Current password is incorrect.' });
    if (body.currentPassword === body.newPassword) return res.status(400).json({ error: 'Choose a different password.' });
    const recoveryPin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    const password = await hashSecret(digest(body.newPassword));
    const pinHash = await hashSecret(recoveryPin);
    if (!session || sessions.get(req.authToken) !== session || session.expires <= now()) return res.status(401).json({ error: 'Sign in again before setting up your account.' });
    const changed = await run(db, 'UPDATE staff SET password = ?, recoveryPin = ? WHERE id = ? AND password = ? AND isFirstLogin = 1 AND isActive = 1', [password, pinHash, req.staff.id, req.staff.password]);
    if (changed.changes !== 1) return res.status(409).json({ error: 'Account changed. Sign in again.' });
    const stillCurrent = sessions.get(req.authToken) === session && session.expires > now();
    invalidate(req.staff.id);
    if (!stillCurrent) return res.status(401).json({ error: 'Password saved. Sign in with your new password and repeat setup to get a replacement PIN.' });
    const token = establish(res, { ...req.staff, password, recoveryPin: pinHash });
    sessions.get(token).pinBackupPending = true;
    res.json({ requiresPinBackup: true, recoveryPin });
  }));
  app.post('/api/auth/acknowledge-pin', requireSession, wrap(async (req, res) => {
    const session = sessions.get(req.authToken);
    if (!req.body || Object.keys(req.body).length !== 1 || req.body.acknowledged !== true) return res.status(400).json({ error: 'Confirm that you have kept your recovery PIN privately.' });
    if (!req.staff.isFirstLogin || !session?.pinBackupPending) return res.status(409).json({ error: 'PIN backup was not issued in this session. Repeat first-login setup.' });
    session.pinBackupPending = false;
    let changed;
    try {
      changed = await run(db, 'UPDATE staff SET isFirstLogin = 0 WHERE id = ? AND password = ? AND recoveryPin = ? AND isFirstLogin = 1 AND isActive = 1', [req.staff.id, req.staff.password, req.staff.recoveryPin]);
    } catch (error) {
      // Retry only when the write demonstrably did not complete and this exact
      // restricted session still owns the unchanged account and issued PIN.
      const current = await get(db, 'SELECT * FROM staff WHERE id = ?', [req.staff.id]).catch(() => null);
      if (sessions.get(req.authToken) === session && session.expires > now() && current && bool(current.isActive) && current.isFirstLogin === 1 && current.password === session.credential && current.recoveryPin === req.staff.recoveryPin) session.pinBackupPending = true;
      throw error;
    }
    if (changed.changes !== 1) return res.status(409).json({ error: 'Account changed. Sign in again.' });
    const stillCurrent = sessions.get(req.authToken) === session && session.expires > now();
    invalidate(req.staff.id);
    if (!stillCurrent) return res.status(401).json({ error: 'Setup completed. Sign in with your new password.' });
    const user = { ...req.staff, isFirstLogin: 0 };
    establish(res, user);
    res.json(result(user));
  }));
  app.post('/api/auth/change-password', requireSession, wrap(async (req, res) => {
    if (req.staff.isFirstLogin) return res.status(403).json({ error: 'Complete first-login setup and recovery PIN backup before continuing.', code: 'PASSWORD_CHANGE_REQUIRED' });
    const { currentPassword, newPassword, recoveryPin } = req.body || {};
    if (!validPassword(newPassword) || (recoveryPin !== undefined && !validPin(recoveryPin))) return res.status(400).json({ error: 'Use a password of 8–256 characters with letters and numbers, and a 4–12 digit recovery PIN.' });
    if (!await throttle(req, res, 'change', req.staff.username)) return;
    if (!await verifySecret(currentPassword, req.staff.password, true)) return res.status(401).json({ error: 'Current password is incorrect.' });
    if (currentPassword === newPassword) return res.status(400).json({ error: 'Choose a different password.' });
    const password = await hashSecret(digest(newPassword));
    const pin = recoveryPin === undefined ? req.staff.recoveryPin : await hashSecret(recoveryPin);
    const changed = await run(db, 'UPDATE staff SET password = ?, recoveryPin = ?, isFirstLogin = 0 WHERE id = ? AND password = ?', [password, pin, req.staff.id, req.staff.password]);
    if (changed.changes !== 1) return res.status(409).json({ error: 'Account changed. Sign in again.' });
    invalidate(req.staff.id);
    const user = { ...req.staff, password, recoveryPin: pin, isFirstLogin: 0 };
    establish(res, user);
    await clearAttempts('change', req.staff.username);
    res.json(result(user));
  }));
  app.post('/api/auth/change-pin', requireAuth, wrap(async (req, res) => {
    const { currentPassword, recoveryPin } = req.body || {};
    if (!validPin(recoveryPin)) return res.status(400).json({ error: 'Enter a 4–12 digit recovery PIN.' });
    if (!await throttle(req, res, 'change', req.staff.username)) return;
    if (!await verifySecret(currentPassword, req.staff.password, true)) return res.status(401).json({ error: 'Current password is incorrect.' });
    await run(db, 'UPDATE staff SET recoveryPin = ? WHERE id = ?', [await hashSecret(recoveryPin), req.staff.id]);
    await clearAttempts('change', req.staff.username);
    res.json({ success: true });
  }));
  app.post('/api/auth/recover', wrap(async (req, res) => {
    const { username, recoveryPin, newPassword } = req.body || {};
    if (typeof username !== 'string' || !username.trim() || username.length > 100 || !validPin(recoveryPin) || !validPassword(newPassword)) return res.status(400).json({ error: 'Enter username, recovery PIN and a new password of 8–256 characters with letters and numbers.' });
    const name = username.trim();
    if (!await throttle(req, res, 'recover', name)) return;
    const user = await findUser(name);
    const matches = await verifySecret(recoveryPin, user?.recoveryPin || 'invalid');
    if (!user || !bool(user.isActive) || !publicStaff(user).recoveryPinSet || !matches) return res.status(401).json({ error: 'Recovery details are incorrect.' });
    const changed = await run(db, 'UPDATE staff SET password = ?, recoveryPin = ?, isFirstLogin = 0 WHERE id = ? AND password = ? AND recoveryPin = ?', [await hashSecret(digest(newPassword)), await hashSecret(recoveryPin), user.id, user.password, user.recoveryPin]);
    if (changed.changes !== 1) return res.status(409).json({ error: 'Account changed. Retry recovery.' });
    // Recovery may target a different account than the browser's current session.
    // Revoke only that account's tokens; explicit logout owns browser cookie clearing.
    invalidate(user.id);
    await clearAttempts('recover', name);
    res.json({ success: true });
  }));
  app.post('/api/auth/unlock', requireAuth, wrap(async (req, res) => {
    const body = req.body;
    const override = body && Object.hasOwn(body, 'username');
    const fields = override ? ['username', 'password'] : ['password'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== fields.length || Object.keys(body).some(key => !fields.includes(key)) || typeof body.password !== 'string' || !body.password || body.password.length > 256 || (override && (typeof body.username !== 'string' || !body.username.trim() || body.username.length > 100))) return res.status(400).json({ error: 'Enter unlock credentials.' });
    const name = override ? body.username.trim() : req.staff.username;
    if (!await throttle(req, res, 'unlock', name)) return;
    const session = sessions.get(req.authToken);
    const user = override ? await findUser(name) : req.staff;
    const matches = await verifySecret(body.password, user?.password || '0'.repeat(64), true);
    if (!user || !bool(user.isActive) || user.isFirstLogin || (override && !bool(user.isAdmin)) || !matches) return res.status(403).json({ error: 'Unlock credentials are incorrect or unavailable.' });
    await clearAttempts('unlock', name);
    // Recheck both accounts after asynchronous password verification. Approval never
    // replaces the cashier session or grants the administrator's permissions.
    const current = await all(db, 'SELECT * FROM staff WHERE id IN (?, ?)', [req.staff.id, user.id]);
    const original = current.find(row => row.id === req.staff.id);
    const approver = current.find(row => row.id === user.id);
    if (!session || sessions.get(req.authToken) !== session || session.expires <= now() || !original || !bool(original.isActive) || original.isFirstLogin || original.password !== session.credential) return res.status(401).json({ error: 'Your session has ended. Sign in again.' });
    if (!approver || !bool(approver.isActive) || approver.isFirstLogin || approver.password !== user.password || (override && !bool(approver.isAdmin))) return res.status(403).json({ error: 'Unlock credentials are incorrect or unavailable.' });
    res.json({ success: true });
  }));
  app.post('/api/auth/verify-admin', requireAuth, wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 100 || password.length > 256) return res.status(400).json({ error: 'Enter administrator credentials.' });
    if (!await throttle(req, res, 'approval', username.trim())) return;
    const user = await findUser(username.trim());
    if (!user || !bool(user.isActive) || !bool(user.isAdmin) || user.isFirstLogin || !await verifySecret(password, user.password, true)) return res.status(403).json({ error: 'Administrator approval failed.' });
    await clearAttempts('approval', username.trim());
    // This verifies UI approval only; privileged endpoints still require their own server authorization.
    res.json({ success: true, id: user.id });
  }));

  app.get('/api/staff', requireAuth, wrap(async (req, res) => {
    const users = bool(req.staff.isAdmin) ? await all(db, 'SELECT * FROM staff') : [req.staff];
    res.json(users.map(publicStaff));
  }));
  app.post('/api/staff', requireAdmin, wrap(async (req, res) => {
    const body = req.body || {};
    const allowed = new Set(['id', 'username', 'password', 'fullName', 'role', 'phone', 'joinedDate', 'avatarImg', 'isActive', 'isAdmin', 'isFirstLogin', 'recoveryPin']);
    if (Object.keys(body).some(key => !allowed.has(key)) || typeof body.id !== 'string' || !body.id.trim() || typeof body.username !== 'string' || !/^[a-zA-Z0-9_.@-]{4,100}$/.test(body.username.trim()) || typeof body.fullName !== 'string' || !body.fullName.trim() || body.fullName.length > 200 || !validPassword(body.password) || !['cashier', 'manager'].includes(body.role || 'cashier')) return res.status(400).json({ error: 'Invalid staff account details. Use an initial password of 8–256 characters with letters and numbers.' });
    const saved = await run(db, `INSERT INTO staff (id, username, password, fullName, role, phone, joinedDate, avatarImg, isActive, isAdmin, recoveryPin, isFirstLogin) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 1 WHERE NOT EXISTS (SELECT 1 FROM staff WHERE lower(trim(username)) = lower(?))`, [body.id, body.username.trim(), await hashSecret(digest(body.password)), body.fullName.trim(), body.role || 'cashier', body.phone || '', new Date().toISOString(), body.avatarImg || '', body.isActive === false ? 0 : 1, Number(bool(body.isAdmin)), body.username.trim()]);
    if (saved.changes !== 1) return res.status(409).json({ error: 'That username is already taken.' });
    res.status(201).json({ id: body.id, user: publicStaff(await get(db, 'SELECT * FROM staff WHERE id = ?', [body.id])) });
  }));
  app.put('/api/staff/:id', requireAuth, wrap(async (req, res) => {
    const body = req.body || {};
    const admin = bool(req.staff.isAdmin);
    const own = req.staff.id === req.params.id;
    const allowed = new Set(admin ? ['username', 'fullName', 'role', 'phone', 'avatarImg', 'isActive', 'isAdmin'] : ['fullName', 'phone', 'avatarImg']);
    if (!admin && !own) return res.status(403).json({ error: 'You can edit only your own profile.' });
    if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.has(key)) || (body.username !== undefined && (typeof body.username !== 'string' || !/^[a-zA-Z0-9_.@-]{4,100}$/.test(body.username.trim()))) || (body.fullName !== undefined && (typeof body.fullName !== 'string' || !body.fullName.trim() || body.fullName.length > 200)) || (body.role !== undefined && !['cashier', 'manager'].includes(body.role)) || ['phone', 'avatarImg'].some(key => body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > (key === 'phone' ? 40 : 2000000))) || ['isActive', 'isAdmin'].some(key => body[key] !== undefined && typeof body[key] !== 'boolean')) return res.status(400).json({ error: 'Invalid staff update. Use account-security actions for passwords and recovery PINs.' });
    if ((own || req.params.id === 'admin_001') && (body.isAdmin === false || body.isActive === false || body.role !== undefined || body.username !== undefined)) return res.status(403).json({ error: 'You cannot rename, demote or deactivate this administrator account.' });
    const updates = Object.fromEntries(Object.entries(body).map(([key, value]) => [key, ['isAdmin', 'isActive'].includes(key) ? Number(value) : typeof value === 'string' ? value.trim() : value]));
    const keys = Object.keys(updates);
    const values = keys.map(key => updates[key]); values.push(req.params.id);
    const duplicate = updates.username === undefined ? '' : ' AND NOT EXISTS (SELECT 1 FROM staff WHERE lower(trim(username)) = lower(?) AND id != ?)';
    if (updates.username !== undefined) values.push(updates.username, req.params.id);
    const saved = await run(db, `UPDATE staff SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE id = ?${duplicate}`, values);
    if (saved.changes !== 1) return res.status(409).json({ error: 'Account missing or username is already taken.' });
    if (keys.some(key => ['isActive','isAdmin','role','username'].includes(key))) invalidate(req.params.id);
    res.json({ id: req.params.id, user: publicStaff(await get(db, 'SELECT * FROM staff WHERE id = ?', [req.params.id])) });
  }));
  const resolveSessionActor = async token => {
    const session = sessions.get(token);
    if (!session || session.expires <= now()) { endSession(token); return null; }
    const user = await get(db, 'SELECT * FROM staff WHERE id = ?', [session.id]);
    const active = user && bool(user.isActive) && !bool(user.isFirstLogin) && user.password === session.credential;
    if (!active) { endSession(token); return null; }
    if (sessions.get(token) !== session || session.expires <= now()) return null;
    return Object.freeze({ localStaffId: session.id });
  };
  const isSessionActive = async token => Boolean(await resolveSessionActor(token));
  const isSessionCurrent = (token, localStaffId) => {
    const session = sessions.get(token);
    return Boolean(session && session.id === localStaffId && session.expires > now());
  };
  return { isSessionActive, resolveSessionActor, isSessionCurrent, ready, requireSession, requireAuth, requireAdmin, publicStaff, invalidate, close: () => { for (const token of [...sessions.keys()]) endSession(token); } };
}
module.exports = { registerAuthRoutes, publicStaff, hashSecret, verifySecret };
