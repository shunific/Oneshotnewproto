// ====================================================================
// ONE SHOT BAR & BILLIARDS: LOCAL EDGE SERVER (CommonJS)
// ====================================================================
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

const envPath = process.env.NODE_ENV === 'production'
  ? path.join(process.resourcesPath || __dirname, '.env')
  : path.join(__dirname, '.env');
dotenv.config({ path: envPath });

const express = require('express');
const { createApiGuard } = require('./server-security.cjs');
const sqlite3Pkg = require('sqlite3');
const { registerAuthRoutes } = require('./server-auth.cjs');
const {createNativeReservationRuntime}=require('./server-native-runtime.cjs');
const { registerCloudRoutes } = require('./server-cloud.cjs');
const { registerCloudStaffRoutes } = require('./server-cloud-staff.cjs');
const { registerSessionStateRoutes } = require('./server-session-state.cjs');
const { registerQueueRoutes } = require('./server-queue.cjs');
const {startTableSession,registerVenueAvailabilityRoutes}=require('./server-table-start.cjs');
const { registerCheckoutRoutes, initializeCheckoutSchema, canonicalSession, calculateCheckout } = require('./server-checkout.cjs');
const { registerRefundRoutes } = require('./server-refunds.cjs');
const { registerPolicyRoutes } = require('./server-policy.cjs');
const { selectWalkInStartPricing } = require('./session-billing.mjs');
const brain = require('brain.js'); // 🧠 QUEUE AI LIBRARY

// An unknown failure must stop the owned backend instead of leaving a stalled
// helper alive. SQLite rolls back unfinished transactions on process exit.
const stopAfterUnexpectedFailure = () => {
  console.error('Local server stopped after an unexpected failure. Restart and recover any unconfirmed operation.');
  process.exit(1);
};
process.on('uncaughtException', stopAfterUnexpectedFailure);
process.on('unhandledRejection', stopAfterUnexpectedFailure);

// 🟢 SAFE JSON PARSER: Prevents malformed JSON strings from crashing requests
const safeParseJSON = (str, fallback = null) => {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch (e) {
    return Array.isArray(fallback) ? [str] : str;
  }
};

// 🟢 SAFE DATE SANITIZER: Handles comma-separated dates, ranges, and ISO dates for PostgreSQL
const sanitizeDate = (val) => {
  if (!val) return null;
  const str = String(val).trim();
  if (!str) return null;
  // If comma-separated dates (e.g. "2026-10-12,2026-10-13"), take the first date
  const first = str.includes(",") ? str.split(",")[0].trim() : str;
  const clean = first.split(" ")[0].trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;
  const parsed = new Date(clean);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
};

const sqlite3 = sqlite3Pkg.verbose();
const app = express();
app.set('case sensitive routing', true);
const PORT = process.env.PORT || 3001;


app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Pragma', 'no-cache'); next(); });
app.use('/api', createApiGuard({ port: PORT, development: process.env.NODE_ENV === 'development' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ====================================================================
// 🟢 SQLITE DATABASE INITIALIZATION & AUTO-MIGRATIONS
// ====================================================================
// 🟢 SUPABASE CONFIGURATION
const SUPABASE_URL = 
  process.env.SUPABASE_URL || 
  process.env.VITE_SUPABASE_URL || 
  'https://olywhyaozjlkjrnsdydg.supabase.co';
const SUPABASE_SERVICE_KEY = 
  process.env.SUPABASE_SERVICE_KEY || 
  process.env.VITE_SUPABASE_SERVICE_KEY || 
  process.env.SUPABASE_SECRET_KEY || 
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY || 
  process.env.VITE_SUPABASE_ANON_KEY || 
  process.env.SUPABASE_ANON_KEY || 
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9seXdoeWFvempsa2pybnNkeWRnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTg5NjAxNCwiZXhwIjoyMTA1NDcyMDE0fQ.9M87B5oO8bKLtkaH5MIpzZ1KzvhE3qr6y5GApWzStn4';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// 🟢 SUPABASE HEARTBEAT PING (60-second intervals)
setInterval(async () => {
  try {
    await supabase
      .from('system_status')
      .upsert({ id: 1, last_seen_at: new Date().toISOString() });
  } catch (err) {
    // Ignore silent network glitches when offline
  }
}, 60000);

const userDataPath = process.env.USER_DATA_PATH || __dirname;
const dbPath = path.resolve(userDataPath, 'oneshot.db');
let resolveDatabaseReady, rejectDatabaseReady;
const databaseReady = new Promise((resolve, reject) => { resolveDatabaseReady = resolve; rejectDatabaseReady = reject; });
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Error connecting to SQLite database:', err.message);
    rejectDatabaseReady(err);
  } else {
    console.log('✅ Connected to local SQLite database.');
    db.configure('busyTimeout', 5000);
    
    db.serialize(() => {
      db.run('PRAGMA foreign_keys = ON');
      db.run(`CREATE TABLE IF NOT EXISTS systemSettings (keyName TEXT PRIMARY KEY, settingValue TEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      db.run(`CREATE TABLE IF NOT EXISTS cms (keyName TEXT PRIMARY KEY, settingValue TEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      db.run(`CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mimeType TEXT, data BLOB)`);
      db.run(`CREATE TABLE IF NOT EXISTS staff (id TEXT PRIMARY KEY, username TEXT, password TEXT, fullName TEXT, role TEXT, phone TEXT, joinedDate TEXT, avatarImg TEXT, isActive INTEGER DEFAULT 1, isAdmin INTEGER DEFAULT 0, recoveryPin TEXT, isFirstLogin INTEGER DEFAULT 0)`);
      db.run(`CREATE TABLE IF NOT EXISTS tables (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, isActive INTEGER DEFAULT 1, maintenanceReason TEXT, sessionData TEXT)`);
      db.run(`CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, name TEXT, category TEXT, price REAL, stock INTEGER DEFAULT 0, isActive INTEGER DEFAULT 1, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      db.run(`CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, customerName TEXT, contactNumber TEXT, partySize INTEGER, status TEXT, queueNumber INTEGER, notes TEXT, arrivalTime DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      db.run(`CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, customerName TEXT, contactNumber TEXT, email TEXT, date DATETIME, timeSlot TEXT, durationHours INTEGER, partySize INTEGER, tableId TEXT, status TEXT, totalAmount REAL, downPaymentAmount REAL, downPaymentPaid INTEGER DEFAULT 0, balancePaid INTEGER DEFAULT 0, paymentRef TEXT, receiptImg TEXT, cancellationReason TEXT, refundStatus TEXT, refundMethod TEXT, refundNotes TEXT, createdAt TEXT)`);
      db.run(`CREATE TABLE IF NOT EXISTS session_history (id TEXT PRIMARY KEY, customerName TEXT, tableId TEXT, tableName TEXT, startTime DATETIME, endTime DATETIME, durationMinutes INTEGER, totalAmount REAL, amountPaid REAL, orders TEXT)`);
      db.run(`CREATE TABLE IF NOT EXISTS promo_codes (id TEXT PRIMARY KEY, code TEXT UNIQUE, discount_percent REAL, description TEXT, is_active INTEGER DEFAULT 1, is_limited_uses INTEGER DEFAULT 0, max_usage INTEGER DEFAULT 0, usage_count INTEGER DEFAULT 0, start_date DATETIME, expires_at DATETIME)`);
      db.run(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, title TEXT, date TEXT, type TEXT, description TEXT, registrationLink TEXT, bracketLink TEXT, minParticipants INTEGER DEFAULT 8, maxParticipants INTEGER, slotsFull INTEGER DEFAULT 0, attachments TEXT, allowReservations INTEGER DEFAULT 1, reservationTableCount INTEGER DEFAULT 4, caterWalkIns INTEGER DEFAULT 1, walkInTableCount INTEGER DEFAULT 4, walkInTableIds TEXT, reservationTableIds TEXT, eventTableIds TEXT)`);
      db.run(`CREATE TABLE IF NOT EXISTS closed_dates (id TEXT PRIMARY KEY, closed_date TEXT, type TEXT DEFAULT 'specific', day_of_week INTEGER, reason TEXT, is_full_day INTEGER DEFAULT 1, open_time TEXT, close_time TEXT)`);
      db.run(`CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, title TEXT, content TEXT, type TEXT, isActive INTEGER DEFAULT 1, expiresAt DATETIME, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      db.run(`CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, customerName TEXT, contactInfo TEXT, feedbackType TEXT, comment TEXT, reservationId TEXT, tags TEXT, date DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      db.run(`CREATE TABLE IF NOT EXISTS lost_and_found (id TEXT PRIMARY KEY, itemName TEXT, description TEXT, foundDate DATETIME, status TEXT, image TEXT, claimedBy TEXT, claimedDate DATETIME, isArchived INTEGER DEFAULT 0)`);
      db.run(`CREATE TABLE IF NOT EXISTS watchlist (id TEXT PRIMARY KEY, name TEXT, reason TEXT, description TEXT, status TEXT, evidenceLink TEXT, dateAdded DATETIME, resolvedDate DATETIME, isArchived INTEGER DEFAULT 0)`);
      db.run(`CREATE TABLE IF NOT EXISTS activities (id TEXT PRIMARY KEY, type TEXT, description TEXT, timestamp DATETIME, metadata TEXT)`);
      db.run(`CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, customerName TEXT, contactInfo TEXT, feedbackType TEXT, comment TEXT, reservationId TEXT, tags TEXT, date DATETIME DEFAULT CURRENT_TIMESTAMP, status TEXT DEFAULT 'pending', notes TEXT)`);
      
      // 🟢 e-RECEIPTS TABLE FOR PAPERLESS CHECKOUTS
      db.run(`CREATE TABLE IF NOT EXISTS e_receipts (id TEXT PRIMARY KEY, receipt_no TEXT UNIQUE NOT NULL, reservation_id TEXT, customer_name TEXT NOT NULL, customer_email TEXT, customer_phone TEXT, table_id TEXT, table_name TEXT NOT NULL, play_start_time TEXT, play_end_time TEXT, duration_minutes INTEGER DEFAULT 0, table_rate REAL DEFAULT 0, table_charge REAL DEFAULT 0, overtime_charge REAL DEFAULT 0, fnb_charge REAL DEFAULT 0, subtotal REAL DEFAULT 0, discount_amount REAL DEFAULT 0, total_amount REAL DEFAULT 0, amount_paid REAL DEFAULT 0, balance_due REAL DEFAULT 0, payment_method TEXT DEFAULT 'cash', payment_status TEXT DEFAULT 'paid', created_at TEXT DEFAULT (datetime('now')))`);

      db.run('ALTER TABLE staff ADD COLUMN isFirstLogin INTEGER DEFAULT 0', () => {});

      // 🟢 SAFE SELF-HEALING COLUMN MIGRATIONS (No non-constant defaults to avoid SQLite errors)
      const resCols = [
        'createdAt TEXT',
        'email TEXT',
        'refundStatus TEXT',
        'refundMethod TEXT',
        'refundNotes TEXT',
        'cancellationReason TEXT',
        'paymentRef TEXT',
        'receiptImg TEXT',
        'promoCode TEXT',
        'discountAmount REAL DEFAULT 0',
        'closureReason TEXT',
        'closureId TEXT',
        'originalReservationId TEXT',
        'rescheduleCount INTEGER DEFAULT 0',
        'lastNotificationId TEXT'
      ];
      resCols.forEach(col => {
        db.run(`ALTER TABLE reservations ADD COLUMN ${col}`, () => {});
      });

      const newEventCols = [
        'duration TEXT',
        'bracketLink TEXT',
        'minParticipants INTEGER DEFAULT 8',
        'maxParticipants INTEGER DEFAULT 32',
        'allowReservations INTEGER DEFAULT 1',
        'reservationTableCount INTEGER DEFAULT 4',
        'caterWalkIns INTEGER DEFAULT 1',
        'walkInTableCount INTEGER DEFAULT 4',
        'walkInTableIds TEXT',
        'reservationTableIds TEXT',
        'eventTableIds TEXT',
        'createdAt TEXT',
        'isCancelled INTEGER DEFAULT 0',
        'cancelReason TEXT'
      ];
      newEventCols.forEach(col => {
        db.run(`ALTER TABLE events ADD COLUMN ${col}`, () => {});
      });
      const feedbackCols = [
        'status TEXT DEFAULT \'pending\'',
        'notes TEXT'
      ];
      feedbackCols.forEach(col => {
        db.run(`ALTER TABLE feedback ADD COLUMN ${col}`, () => {});
      });

      // 🟢 AI TRAINING TELEMETRY COLUMNS IN SESSION HISTORY
      const historyCols = [
        'status TEXT DEFAULT \'completed\'',
        'closureReason TEXT',
        'partySize INTEGER DEFAULT 2',
        'occupancyRate REAL DEFAULT 0.5'
      ];
      historyCols.forEach(col => {
        db.run(`ALTER TABLE session_history ADD COLUMN ${col}`, () => {});
      });

      const annCols = ['startDate TEXT'];
      annCols.forEach(col => {
        db.run(`ALTER TABLE announcements ADD COLUMN ${col}`, () => {});
      });

      // Preserve legacy sources and existing settings during repeatable upgrades.
      db.run(`INSERT OR IGNORE INTO systemSettings (keyName, settingValue) SELECT key_name, setting_value FROM system_settings`, () => {});
      db.run(`INSERT OR IGNORE INTO cms (keyName, settingValue) SELECT key_name, content_value FROM cms_content`, () => {});

      // 🟢 IRONCLAD SELF-HEALING SUPER ADMIN
      const createSuperAdmin = `
        INSERT OR IGNORE INTO staff (id, username, password, fullName, role, phone, joinedDate, isActive, isAdmin, recoveryPin)
        VALUES ('admin_001', 'superadmin', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9', 'System Administrator', 'Super Admin', '00000000000', datetime('now'), 1, 1, '8492')
      `;
      db.run(createSuperAdmin, (err) => {
        if (err) console.error("❌ Failed to inject Super Admin:", err.message);
        else {
          console.log("🛡️ Super Admin account verified/injected.");

        }
        db.get('SELECT isFirstLogin FROM staff LIMIT 1', [], error => {
          if (error) rejectDatabaseReady(error);
          else resolveDatabaseReady();
        });
      });
    });
  }
});


// ====================================================================
// 🧠 ARTIFICIAL NEURAL NETWORK (QUEUE AI ENGINE)
// ====================================================================
let waitTimeNet = new brain.NeuralNetwork({ hiddenLayers: [5, 5] });
let isAITrained = false;

const trainQueueAI = () => {
  db.all(`SELECT * FROM session_history WHERE status = 'completed'`, [], (err, rows) => {
    if (err) {
      console.error('❌ [Queue AI] Database error during training pull:', err);
      return;
    }

    // 🟢 SYNTHETIC BASELINE: Prevents "empty dataset" crash and establishes logical starting weights
    let trainingData = [
      { input: { dayOfWeek: 0.8, timeOfDay: 0.8, partySize: 0.4, hasOrders: 1, occupancy: 0.8 }, output: { duration: 0.5 } },  // Friday Night, 4 pax, food, busy -> ~3 hrs
      { input: { dayOfWeek: 0.2, timeOfDay: 0.3, partySize: 0.2, hasOrders: 0, occupancy: 0.2 }, output: { duration: 0.16 } }, // Mon Morning, 2 pax, no food, dead -> ~1 hr
      { input: { dayOfWeek: 0.9, timeOfDay: 0.5, partySize: 0.6, hasOrders: 1, occupancy: 0.9 }, output: { duration: 0.66 } }, // Sat Afternoon, 6 pax, food, packed -> ~4 hrs
    ];

    if (rows && rows.length > 0) {
      const historicalData = rows.map(r => {
        const d = new Date(r.startTime);
        return {
          input: {
            dayOfWeek: d.getDay() / 6, // 0 to 1
            timeOfDay: d.getHours() / 24, // 0 to 1
            partySize: Math.min((r.partySize || 2) / 10, 1), // Normalized against 10 max
            hasOrders: (r.orders && r.orders !== '[]' && r.orders !== 'null') ? 1 : 0,
            occupancy: r.occupancyRate || 0.5 // 0 to 1
          },
          output: { 
            duration: Math.min((r.durationMinutes || 60) / 360, 1) // Normalized against max 6 hours
          } 
        };
      });
      trainingData = [...trainingData, ...historicalData];
    }

    // Train the network
    waitTimeNet.train(trainingData, {
      iterations: 2000, 
      errorThresh: 0.01,
      log: false
    });
    
    isAITrained = true;
    console.log(`🧠 [Queue AI] Successfully trained/re-calibrated on ${trainingData.length} data vectors.`);
  });
};

// Train the AI 5 seconds after server boot, and re-train every 6 hours
setTimeout(trainQueueAI, 5000);
setInterval(trainQueueAI, 1000 * 60 * 60 * 6);


// ====================================================================
// 🚀 READ ROUTES (GET)
// ====================================================================
let cloudStaff;
const auth = registerAuthRoutes(app, db, { onSessionEnd: token => cloudStaff?.disposeSession(token) });
app.use('/api', auth.requireAuth);
app.use('/api', (req, res, next) => {
  const adminResources = /^\/(staff|cms|settings|promo-codes|closed-dates|announcements|events)(?:\/|$)/;
  const inventoryWrite = /^\/inventory(?:\/|$)/.test(req.path) && req.method !== 'GET';
  const administrativeWrite = adminResources.test(req.path) && req.method !== 'GET';
  const tableAdminWrite = (req.path === '/tables' && req.method === 'POST') || (req.path.startsWith('/tables/') && req.method === 'DELETE');
  const sessionVoid = req.method === 'POST' && /^\/tables\/[^/]+\/checkout$/.test(req.path) && req.body?.closureKind === 'void';
  const orderVoid = /^\/tables\/[^/]+\/orders\/[^/]+\/void$/.test(req.path);
  if (inventoryWrite || administrativeWrite || tableAdminWrite || orderVoid || sessionVoid || req.path === '/cache-reservations') {
    if (!req.staff.isAdmin) return res.status(403).json({ error: 'Administrator access required.' });
  }
  next();
});
const editableColumns = {
  watchlist: ['name', 'reason', 'description', 'status', 'evidenceLink', 'resolvedDate', 'isArchived'],
  'lost-and-found': ['expectedRecord', 'patch'],
  announcements: ['title', 'content', 'type', 'isActive', 'expiresAt', 'startDate'],
  feedback: ['status', 'notes', 'expectedActorId'],
  reservations: ['customerName', 'contactNumber', 'email', 'date', 'timeSlot', 'durationHours', 'partySize', 'tableId', 'status', 'totalAmount', 'downPaymentAmount', 'downPaymentPaid', 'balancePaid', 'paymentRef', 'receiptImg', 'cancellationReason', 'refundStatus', 'refundMethod', 'refundNotes', 'promoCode', 'discountAmount', 'closureReason', 'closureId', 'originalReservationId', 'rescheduleCount', 'lastNotificationId'],
};
app.use('/api', (req, res, next) => {
  const columns = editableColumns[req.path.split('/')[1]];
  if (req.method === 'PUT' && columns && Object.keys(req.body || {}).some(key => !columns.includes(key))) return res.status(400).json({ error: 'Unknown update field.' });
  next();
});
require('./server-backup.cjs').registerBackupRoutes(app, db, { requireAdmin: auth.requireAdmin });
require('./server-images.cjs').registerImageRoutes(app, db, { requireAuth: auth.requireAuth });
require('./server-content-create.cjs').registerContentCreateRoutes(app, dbPath, { requireAdmin: auth.requireAdmin, resolveActor: auth.resolveSessionActor, isActorCurrent: (token, actor) => auth.isSessionCurrent(token, actor.localStaffId), readyBefore: databaseReady });
registerCloudRoutes(app);
cloudStaff = registerCloudStaffRoutes(app, { isLocalSessionActive: auth.isSessionActive });
const checkoutSchemaReady = databaseReady.then(() => initializeCheckoutSchema(db));
const nativeReservationRuntime=databaseReady.then(async()=>{
  await checkoutSchemaReady;
  await auth.ready;
  await sessionState.ready;
  await require('./server-native-delivery.cjs').initializeNativePositionUpgrade(db);
  const runtime=createNativeReservationRuntime(dbPath,{auth,cloudStaff});
  return runtime.ready.then(()=>runtime);
});

registerCheckoutRoutes(app, dbPath);
registerRefundRoutes(app, dbPath, { requireAdmin: auth.requireAdmin });
registerPolicyRoutes(app, dbPath, { requireAdmin: auth.requireAdmin });
registerVenueAvailabilityRoutes(app,dbPath);
require('./server-cms.cjs').registerCmsRoutes(app,dbPath,{requireAuth:auth.requireAuth,requireAdmin:auth.requireAdmin,resolveActor:auth.resolveSessionActor,isActorCurrent:(token,actor)=>auth.isSessionCurrent(token,actor.localStaffId),readyBefore:databaseReady});
require('./server-venue-content.cjs').registerVenueContentRoutes(app,dbPath,{requireAuth:auth.requireAuth,requireAdmin:auth.requireAdmin,resolveActor:auth.resolveSessionActor,isActorCurrent:(token,actor)=>auth.isSessionCurrent(token,actor.localStaffId),readyBefore:databaseReady});
const reservationMoves={move:async(...args)=>(await nativeReservationRuntime).move(...args),recover:async(...args)=>(await nativeReservationRuntime).recoverMove(...args)};
const sessionState = registerSessionStateRoutes(app, dbPath, {reservationMoves,readyBefore:Promise.all([checkoutSchemaReady,auth.ready]),resolveActor:auth.resolveSessionActor,isActorCurrent:(token,actor)=>auth.isSessionCurrent(token,actor.localStaffId)});
const queueOperations = registerQueueRoutes(app, dbPath, {readyBefore:nativeReservationRuntime,requireAuth:auth.requireAuth,resolveActor:auth.resolveSessionActor,isActorCurrent:(token,actor)=>auth.isSessionCurrent(token,actor.localStaffId)});
require('./server-native-move-routes.cjs').registerNativeMoveRoutes(app,{requireAuth:auth.requireAuth,runtime:nativeReservationRuntime,listPendingMoves:()=>require('./server-reservation-moves.cjs').listPendingReservationMoves(dbPath)});
require('./server-native-reservation-routes.cjs').registerNativeReservationRoutes(app,{requireAuth:auth.requireAuth,runtime:nativeReservationRuntime});

app.get('/api/promo-codes', (req, res) => {
  db.all(`SELECT * FROM promo_codes`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({
      id: r.id, code: r.code, discountPercent: r.discount_percent, description: r.description,
      isActive: r.is_active === 1, isLimitedUses: r.is_limited_uses === 1, maxUsage: r.max_usage,
      usageCount: r.usage_count, startDate: r.start_date, expiresAt: r.expires_at
    })));
  });
});

app.get('/api/tables', (req, res) => {
  db.all(`SELECT * FROM tables`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({ ...r, isActive: r.isActive === 1, session: safeParseJSON(r.sessionData, undefined) })));
  });
});

app.get('/api/reservations', (req, res) => {
  db.all(`SELECT * FROM reservations ORDER BY rowid DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const normalized = rows.map(r => ({
      ...r,
      id: r.id,
      customerName: r.customerName || r.customer_name || 'Guest',
      contactNumber: r.contactNumber || r.contact_number || '',
      email: r.email || null,
      date: sanitizeDate(r.date || r.reservation_date),
      timeSlot: r.timeSlot || r.time_slot || '',
      durationHours: r.durationHours || r.duration_hours || 1,
      partySize: r.partySize || r.party_size || 1,
      tableId: r.tableId || r.table_id || '',
      status: r.status || 'pending',
      totalAmount: r.totalAmount || r.total_amount || 0,
      downPaymentAmount: r.downPaymentAmount || r.down_payment_amount || 0,
      downPaymentPaid: (r.downPaymentPaid === 1 || r.down_payment_paid === 1),
      balancePaid: (r.balancePaid === 1 || r.balance_paid === 1),
      paymentRef: r.paymentRef || r.payment_ref || null,
      receiptImg: r.receiptImg || r.receipt_img_url || null,
      cancellationReason: r.cancellationReason || r.cancellation_reason || null,
      refundStatus: r.refundStatus || r.refund_status || null,
      refundMethod: r.refundMethod || r.refund_method || null,
      refundNotes: r.refundNotes || r.refund_notes || null,
      createdAt: r.createdAt || r.created_at || new Date().toISOString()
    }));
    res.json(normalized);
  });
});

app.get('/api/inventory', (req, res) => {
  db.all(`SELECT * FROM inventory`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({ ...r, isActive: r.isActive === 1 })));
  });
});

app.get('/api/queue', (req, res) => {
  db.all(`SELECT * FROM queue WHERE status IN ('waiting', 'called') ORDER BY queueNumber ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/activities', (req, res) => {
  db.run(`CREATE TABLE IF NOT EXISTS activities (id TEXT PRIMARY KEY, type TEXT, description TEXT, timestamp DATETIME, metadata TEXT)`, () => {
    db.all(`SELECT * FROM activities ORDER BY timestamp DESC LIMIT 200`, [], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows.map(r => ({ ...r, metadata: safeParseJSON(r.metadata, undefined) })));
    });
  });
});



app.get('/api/feedback', (req, res) => {
  db.all(`SELECT * FROM feedback ORDER BY date DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(f => ({ ...f, tags: safeParseJSON(f.tags, []) })));
  });
});

app.get('/api/announcements', (req, res) => {
  db.all(`SELECT * FROM announcements ORDER BY createdAt DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(a => ({ ...a, isActive: a.isActive === 1 })));
  });
});

app.get('/api/session-history', (req, res) => {
  db.all(`SELECT h.*, CASE WHEN r.id IS NULL THEN NULL ELSE json_object('id', r.id, 'receipt_no', r.receipt_no, 'reservation_id', r.reservation_id, 'customer_name', r.customer_name, 'table_id', r.table_id, 'table_name', r.table_name, 'play_start_time', r.play_start_time, 'play_end_time', r.play_end_time, 'duration_minutes', r.duration_minutes, 'table_charge', r.table_charge, 'overtime_charge', r.overtime_charge, 'fnb_charge', r.fnb_charge, 'subtotal', r.subtotal, 'discount_amount', r.discount_amount, 'total_amount', r.total_amount, 'amount_paid', r.amount_paid, 'balance_due', r.balance_due, 'refund_due', r.refund_due, 'refund_status', r.refund_status, 'payment_status', r.payment_status, 'void_reason', r.void_reason) END AS receiptJson
    FROM session_history h LEFT JOIN e_receipts r ON r.id=h.id ORDER BY h.endTime DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(({ receiptJson, ...row }) => ({ ...row, orders: safeParseJSON(row.orders, []), receipt: safeParseJSON(receiptJson, null) })));
  });
});

app.get('/api/e-receipts/:id', (req, res) => {
  if (typeof req.params.id !== 'string' || !req.params.id || req.params.id.length > 120) return res.status(400).json({ error: 'Choose a saved receipt.' });
  db.get('SELECT * FROM e_receipts WHERE id = ?', [req.params.id], (error, receipt) => {
    if (error) return res.status(503).json({ error: 'The saved receipt could not be loaded.' });
    if (!receipt) return res.status(404).json({ error: 'Saved receipt was not found.' });
    res.json(receipt);
  });
});

app.get('/api/e-receipts', (req, res) => {
  db.all(`SELECT * FROM e_receipts ORDER BY created_at DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

const getSettingsHandler = (req, res) => {
  db.all(`SELECT keyName, settingValue FROM systemSettings`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const config = {};
    rows.forEach(row => {
      let val = row.settingValue;
      if (val === 'true') val = true;
      else if (val === 'false') val = false;
      else if (!isNaN(val) && val.trim() !== '' && !val.includes(':')) val = Number(val);
      config[row.keyName] = val;
    });
    res.json(config);
  });
};
app.get('/api/settings/rates', getSettingsHandler);
app.get('/api/settings/terms', getSettingsHandler);



app.get('/api/lost-and-found', (req, res) => {
  db.all(`SELECT * FROM lost_and_found ORDER BY foundDate DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({ ...r, isArchived: r.isArchived === 1 })));
  });
});

app.get('/api/watchlist', (req, res) => {
  db.all(`SELECT * FROM watchlist ORDER BY dateAdded DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({ ...r, isArchived: r.isArchived === 1 })));
  });
});

// ====================================================================
// 🧠 AI INFERENCE ROUTE (POST)
// ====================================================================
app.post('/api/ai/predict-wait-time', (req, res) => {
  if (!isAITrained) {
    // Fallback if network hasn't trained yet
    return res.json({ estimatedMinutes: 45, confidence: 'baseline' });
  }
  
  const { partySize, hasOrders, currentOccupancyRate } = req.body;
  const now = new Date();
  
  const inputVector = {
    dayOfWeek: now.getDay() / 6,
    timeOfDay: now.getHours() / 24,
    partySize: Math.min((partySize || 2) / 10, 1),
    hasOrders: hasOrders ? 1 : 0,
    occupancy: currentOccupancyRate || 0.5
  };

  const result = waitTimeNet.run(inputVector);
  
  // result.duration is 0-1. Multiply by max duration limit (360 mins / 6 hrs)
  const estimatedMinutes = Math.round((result.duration || 0.16) * 360);
  
  res.json({
    estimatedMinutes: Math.max(15, estimatedMinutes), // Set 15m absolute minimum boundary
    rawPrediction: result.duration
  });
});

// ====================================================================
// 📥 WRITE ROUTES (POST/PUT/DELETE)
// ====================================================================




app.post('/api/cache-reservations', (req, res) => {
  const { reservations } = req.body;
  if (!Array.isArray(reservations)) return res.status(400).json({ error: 'Invalid payload' });

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO reservations (id, customerName, contactNumber, email, date, timeSlot, durationHours, partySize, tableId, status, totalAmount, downPaymentAmount, downPaymentPaid, balancePaid, paymentRef, receiptImg, cancellationReason, refundStatus, refundMethod, refundNotes, createdAt, promoCode, discountAmount) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    reservations.forEach(r => {
      stmt.run([r.id, r.customerName, r.contactNumber, r.email||null, typeof r.date === 'string' ? r.date : new Date(r.date).toISOString(), r.timeSlot, r.durationHours, r.partySize, r.tableId||null, r.status, r.totalAmount, r.downPaymentAmount, r.downPaymentPaid?1:0, r.balancePaid?1:0, r.paymentRef||null, r.receiptImg||null, r.cancellationReason||null, r.refundStatus||null, r.refundMethod||null, r.refundNotes||null, typeof r.createdAt === 'string' ? r.createdAt : new Date(r.createdAt).toISOString(), r.promoCode||null, r.discountAmount||0]);
    });
    stmt.finalize();
    db.run('COMMIT', (err) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // 🟢 Recalculate local promo_codes usage count from cached reservations
      db.run(`
        UPDATE promo_codes 
        SET usage_count = (
          SELECT COUNT(*) FROM reservations 
          WHERE UPPER(TRIM(reservations.promoCode)) = UPPER(TRIM(promo_codes.code))
        )
        WHERE code IN (SELECT DISTINCT promoCode FROM reservations WHERE promoCode IS NOT NULL)
      `);
      
      res.json({ message: "Successfully cached cloud reservations to local SQLite." });
    });
  });
});

app.post('/api/sync-to-cloud', async (req, res) => {
  let syncErrors = [];
  try {

    const syncTable = (localTable, cloudTable, mapFn, conflictKey = 'id') => {
      return new Promise((resolve) => {
        db.all(`SELECT * FROM ${localTable}`, [], async (err, rows) => {
          if (err || !rows || rows.length === 0) return resolve();
          try {
            const rawPayload = rows.map(mapFn);
            const payload = rawPayload.filter(item => {
              if (!item) return false;
              if (cloudTable === "cms") return item.keyname && String(item.keyname).trim() !== "" && item.settingvalue !== null && item.settingvalue !== undefined;
              return true;
            });
            if (payload.length === 0) return resolve();
            console.log(`☁️ Syncing ${localTable}: ${payload.length} row(s)`);

const { data, error } = await supabase
  .from(cloudTable)
  .upsert(payload, { onConflict: conflictKey })
  .select();

if (error) {
  console.error(`❌ ${cloudTable} sync failed:`, error.message);
  syncErrors.push(`${cloudTable}: ${error.message}`);
} else {
  console.log(`✅ ${cloudTable} synced: ${data?.length || 0} row(s)`);
}
          } catch (e) {
            syncErrors.push(`${cloudTable}: ${e.message}`);
          }
          resolve();
        });
      });
    };

   await Promise.all([
      syncTable("cms", "cms", r => {
        const k = (r.keyName || r.keyname || "").trim();
        if (!k) return null;
        const rawVal = (r.settingValue !== undefined && r.settingValue !== null) ? r.settingValue : (r.settingvalue ?? "");
        return {
          keyname: k,
          settingvalue: typeof rawVal === "object" ? JSON.stringify(rawVal) : String(rawVal)
        };
      }, "keyname"),
      syncTable('systemSettings', 'system_settings', r => ({ key_name: r.keyName, setting_value: r.settingValue }), 'key_name'),
      syncTable('tables', 'tables', r => ({ id: r.id, name: r.name, status: r.status, isActive: r.isActive ? 1 : 0, maintenanceReason: r.maintenanceReason, sessionData: r.sessionData }), 'id'),
      
      // 🟢 AI FEATURES ADDED TO HISTORY SYNC
      syncTable('session_history', 'session_history', r => ({ 
        id: r.id, customerName: r.customerName, tableId: r.tableId, tableName: r.tableName, 
        startTime: r.startTime, endTime: r.endTime, durationMinutes: r.durationMinutes, 
        totalAmount: r.totalAmount, amountPaid: r.amountPaid, orders: r.orders, 
        status: r.status || 'completed', closureReason: r.closureReason || null,
        partySize: r.partySize || 2, occupancyRate: r.occupancyRate || 0.5 
      }), 'id'),
      
      syncTable('queue', 'queue', r => ({ id: r.id, customerName: r.customerName, contactNumber: r.contactNumber, partySize: r.partySize, status: r.status, queueNumber: r.queueNumber, notes: r.notes, arrivalTime: r.arrivalTime || new Date().toISOString() }), 'id'),
      syncTable('promo_codes', 'promo_codes', r => ({ id: r.id, code: r.code, discount_percent: r.discount_percent, description: r.description, is_active: !!r.is_active, is_limited_uses: !!r.is_limited_uses, max_usage: r.max_usage, usage_count: r.usage_count, start_date: r.start_date || null, expires_at: r.expires_at || null }), 'id'),
      syncTable('events', 'events', r => ({ 
        id: r.id, 
        title: r.title, 
        date: sanitizeDate(r.date), 
        type: r.type, 
        description: r.description || '', 
        duration: r.duration || 'Whole Day', 
        registrationlink: r.registrationLink || null, 
        bracketlink: r.bracketLink || null, 
        minparticipants: r.minParticipants || 8, 
        maxparticipants: r.maxParticipants || 32, 
        slotsfull: r.slotsFull ? 1 : 0, 
        attachments: r.attachments || null, 
        allowreservations: r.allowReservations !== 0 ? 1 : 0, 
        reservationtablecount: r.reservationTableCount || 4, 
        caterwalkins: r.caterWalkIns !== 0 ? 1 : 0, 
        walkintablecount: r.walkInTableCount || 4, 
        iscancelled: r.isCancelled ? 1 : 0, 
        cancelreason: r.cancelReason || null,
        createdat: r.createdAt || new Date().toISOString()
      }), 'id'),
      syncTable('announcements', 'announcements', r => ({ 
        id: r.id, 
        title: r.title, 
        content: r.content, 
        type: r.type, 
        isactive: r.isActive ? 1 : 0, 
        expiresat: r.expiresAt || null, 
        createdat: r.createdAt || new Date().toISOString() 
      }), 'id'),
      syncTable('closed_dates', 'closed_dates', r => ({ id: r.id, closed_date: sanitizeDate(r.closed_date), type: r.type, day_of_week: r.day_of_week, reason: r.reason, is_full_day: !!r.is_full_day, open_time: r.open_time, close_time: r.close_time }), 'id'),
      syncTable('inventory', 'inventory', r => ({ 
        id: r.id, 
        name: r.name, 
        category: r.category, 
        price: r.price, 
        stock: r.stock, 
        isactive: r.isActive ? 1 : 0 
      }), 'id'),
      syncTable('lost_and_found', 'lost_and_found', r => ({ id: r.id, itemName: r.itemName, description: r.description, foundDate: r.foundDate || null, status: r.status, image: r.image || null, claimedBy: r.claimedBy || null, claimedDate: r.claimedDate || null, isArchived: r.isArchived ? 1 : 0 }), 'id'),
      syncTable('feedback', 'feedback', r => ({ id: r.id, customerName: r.customerName, contactInfo: r.contactInfo, feedbackType: r.feedbackType, comment: r.comment, reservationId: r.reservationId, tags: r.tags, date: r.date || new Date().toISOString(), status: r.status || 'pending', notes: r.notes || null }), 'id'),
      syncTable('watchlist', 'watchlist', r => ({ id: r.id, name: r.name, reason: r.reason, description: r.description, status: r.status, evidenceLink: r.evidenceLink || null, dateAdded: r.dateAdded || null, resolvedDate: r.resolvedDate || null, isArchived: r.isArchived ? 1 : 0 }), 'id'),
      syncTable('activities', 'activities', r => ({ id: r.id, type: r.type, description: r.description, timestamp: r.timestamp || new Date().toISOString(), metadata: r.metadata || null }), 'id'),
      
      // 🟢 e-RECEIPTS CLOUD SYNC
      syncTable('e_receipts', 'e_receipts', r => ({
        id: r.id, receipt_no: r.receipt_no, reservation_id: r.reservation_id, customer_name: r.customer_name, customer_email: r.customer_email, customer_phone: r.customer_phone, table_id: r.table_id, table_name: r.table_name, play_start_time: r.play_start_time, play_end_time: r.play_end_time, duration_minutes: r.duration_minutes, table_rate: r.table_rate, table_charge: r.table_charge, overtime_charge: r.overtime_charge, fnb_charge: r.fnb_charge, subtotal: r.subtotal, discount_amount: r.discount_amount, total_amount: r.total_amount, amount_paid: r.amount_paid, balance_due: r.balance_due, payment_method: r.payment_method, payment_status: r.payment_status, created_at: r.created_at || new Date().toISOString()
      }), 'id')
    ]);

    if (syncErrors.length > 0) {
      res.status(500).json({ error: 'Supabase rejected some tables', details: syncErrors.join(' | ') });
    } else {
      res.status(200).json({ message: 'Cloud sync dispatched successfully.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to dispatch cloud sync.' });
  }
});

app.post('/api/lost-and-found', (req, res) => {
  const { id, itemName, description, foundDate, status, image, claimedBy, claimedDate } = req.body;
  db.get(`INSERT INTO lost_and_found (id, itemName, description, foundDate, status, image, claimedBy, claimedDate, isArchived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) RETURNING *`,
  [id, itemName, description, foundDate, status, image, claimedBy, claimedDate], function(err,row) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({id:row.id,record:{...row,isArchived:row.isArchived===1}});
  });
});

app.post('/api/watchlist', (req, res) => {
  const { id, name, reason, description, status, evidenceLink, dateAdded, resolvedDate } = req.body;
  db.run(`INSERT INTO watchlist (id, name, reason, description, status, evidenceLink, dateAdded, resolvedDate, isArchived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  [id, name, reason, description, status, evidenceLink, dateAdded, resolvedDate], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ message: "Watchlist item added." });
  });
});

app.post('/api/tables', auth.requireAdmin, (req, res) => {
  const body = req.body || {};
  const allowed = new Set(['id', 'name', 'status', 'isActive', 'session']);
  if (Object.keys(body).some(key => !allowed.has(key)) || typeof body.id !== 'string' || !body.id.trim() || body.id.length > 100 || typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 50 || (body.status !== undefined && body.status !== 'available') || (body.session !== undefined && body.session !== null) || (body.isActive !== undefined && typeof body.isActive !== 'boolean')) return res.status(400).json({ error: 'New tables need a valid ID and name and must start empty and available.' });
  db.run(
    `INSERT INTO tables (id, name, status, isActive, sessionData) SELECT ?, ?, 'available', ?, NULL WHERE NOT EXISTS (SELECT 1 FROM tables WHERE lower(trim(name)) = lower(?))`,
    [body.id, body.name.trim(), body.isActive === false ? 0 : 1, body.name.trim()],
    function (error) {
      if (error) return res.status(error.code === 'SQLITE_CONSTRAINT' ? 409 : 503).json({ error: 'Table could not be created.' });
      if (this.changes !== 1) return res.status(409).json({ error: 'That table name is already in use.' });
      res.status(201).json({ id: body.id });
    }
  );
});

app.delete('/api/tables/:id', auth.requireAdmin, (req, res) => {
  const body = req.body || {};
  if (Object.keys(body).some(key => !['expectedStatus', 'expectedSession'].includes(key)) || !['available', 'reserved', 'maintenance', 'event'].includes(body.expectedStatus) || body.expectedSession !== null) return res.status(400).json({ error: 'Confirm the current empty table state before deleting.' });
  db.run('DELETE FROM tables WHERE id = ? AND status = ? AND status != ? AND sessionData IS NULL AND NOT EXISTS (SELECT 1 FROM native_reservation_move_holds WHERE table_id = tables.id)', [req.params.id, body.expectedStatus, 'occupied'], function (error) {
    if (error) return res.status(503).json({ error: 'Table could not be deleted.' });
    if (this.changes !== 1) return res.status(409).json({ error: 'Table changed or has an active session. End its session through checkout before deleting.' });
    res.json({ id: req.params.id });
  });
});

app.put('/api/tables/:id', (req, res) => {
  const body = req.body || {};
  let pricingGuard = null;
  const allowed = new Set(['status', 'session', 'isActive', 'name', 'maintenanceReason', 'expectedSession', 'expectedStatus']);
  if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.has(key))) return res.status(400).json({ error: 'Invalid table update.' });
  if (body.status !== undefined && !['available', 'occupied', 'reserved', 'maintenance', 'event'].includes(body.status)) return res.status(400).json({ error: 'Invalid table status.' });
  if ((body.isActive !== undefined && typeof body.isActive !== 'boolean') || (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 50)) || (body.maintenanceReason !== undefined && body.maintenanceReason !== null && (typeof body.maintenanceReason !== 'string' || body.maintenanceReason.length > 1000))) return res.status(400).json({ error: 'Invalid table details.' });
  if ((body.name !== undefined || body.isActive !== undefined || ['maintenance', 'event'].includes(body.status)) && !req.staff.isAdmin) return res.status(403).json({ error: 'Administrator access required.' });
  if(body.session && body.expectedSession===null)return startTableSession(dbPath,req,res,{resolveActor:auth.resolveSessionActor,isActorCurrent:(token,actor)=>auth.isSessionCurrent(token,actor.localStaffId)});
  db.get('SELECT * FROM tables WHERE id = ?', [req.params.id], (error, row) => {
    if (error) return res.status(503).json({ error: 'Table service unavailable.' });
    if (!row) return res.status(404).json({ error: 'Table not found.' });
    let current;
    try { current = row.sessionData ? JSON.parse(row.sessionData) : null; } catch { return res.status(409).json({ error: 'Stored session needs reconciliation.' }); }
    const mutatesSession = Object.hasOwn(body, 'session') || body.status !== undefined;
    if (mutatesSession && (body.expectedStatus !== row.status || !Object.hasOwn(body, 'expectedSession') || canonicalSession(current) !== canonicalSession(body.expectedSession))) return res.status(409).json({ error: 'The table changed. Refresh before saving.' });
    if (current && (body.isActive === false || body.session === null || (body.status !== undefined && body.status !== 'occupied'))) return res.status(409).json({ error: 'Use checkout to close an occupied session.' });
    if (!current && body.status === 'occupied' && !body.session) return res.status(400).json({ error: 'A reviewed session is required to occupy a table.' });
    if (body.session !== undefined && body.session !== null) {
      const candidate = body.session;
      if (!candidate || typeof candidate.isOpenTime !== 'boolean' || !Array.isArray(candidate.orders || []) || !Array.isArray(candidate.processedOrderOperations || []) || typeof candidate !== 'object' || Array.isArray(candidate) || !Number.isFinite(Date.parse(candidate.startTime)) || typeof candidate.customerName !== 'string' || !candidate.customerName.trim() || !Number.isFinite(candidate.hourlyRate) || candidate.hourlyRate <= 0 || !Number.isFinite(candidate.amountPaid) || candidate.amountPaid < 0 || (!candidate.isOpenTime && (!Number.isSafeInteger(candidate.durationMinutes) || candidate.durationMinutes <= 0))) return res.status(400).json({ error: 'Invalid session.' });
      if (current && canonicalSession(candidate) !== canonicalSession(current)) return res.status(409).json({ error: 'Use the session extension or order service to change an active bill.' });
      if (!current && ['reservationId','reservationPricing','claimId','ownerUserId'].some(key => Object.hasOwn(candidate, key))) return res.status(400).json({ error: 'Reservation linkage requires the trusted check-in service.' });
      if (!current && ((candidate.orders || []).length || (candidate.processedOrderOperations || []).length)) return res.status(400).json({ error: 'A new session must start with an empty bill.' });
      if (!current) {
        if (row.status !== 'available' || row.isActive !== 1 || body.status !== 'occupied' || body.isActive === false) return res.status(409).json({ error: 'Only an active available table can start a session.' });
        const maxPrepaid = candidate.isOpenTime ? 0 : Math.round(candidate.hourlyRate * candidate.durationMinutes / 60 * 100) / 100;
        if (!Number.isSafeInteger(Math.round(candidate.amountPaid * 100)) || Math.abs(candidate.amountPaid * 100 - Math.round(candidate.amountPaid * 100)) > 0.000001 || candidate.amountPaid > maxPrepaid || Date.parse(candidate.startTime) > Date.now() + 60000 || Date.parse(candidate.startTime) < Date.now() - 300000) return res.status(400).json({ error: 'Invalid new-session prepayment or start time.' });
        if (typeof candidate.overtimeRate !== 'number' || !Number.isFinite(candidate.overtimeRate) || candidate.overtimeRate <= 0 || (candidate.pricingVersion !== undefined && candidate.pricingVersion !== 1)) return res.status(400).json({ error: 'Review the configured overtime rate before starting a session.' });
        const pricingKeys = ['hourlyRate','overtimeRate','isWeekdayHappyHourActive','weekdayHappyHourRate','weekdayHappyHourStart','weekdayHappyHourEnd','isWeekendHappyHourActive','weekendHappyHourRate','weekendHappyHourStart','weekendHappyHourEnd'];
        return db.all(`SELECT keyName, settingValue FROM systemSettings WHERE keyName IN (${pricingKeys.map(() => '?').join(',')})`, pricingKeys, (err, savedRates) => {
          if (err) return res.status(503).json({ error: 'Saved pricing could not be read.' });
          const settings = new Map((savedRates || []).map(rate => [rate.keyName, rate.settingValue]));
          const startedAt = Date.now();
          let selected;
          try { selected = selectWalkInStartPricing(Object.fromEntries(settings), startedAt); }
          catch (error) { return res.status(409).json({ error: error.message }); }
          if (candidate.hourlyRate !== selected.hourlyRate || candidate.overtimeRate !== selected.overtimeRate) return res.status(409).json({ error: 'Session rates changed. Review the current start-time rate and overtime rate.' });
          pricingGuard = pricingKeys.map(key => [key, settings.get(key) ?? null]);
          candidate.startTime = new Date(startedAt).toISOString();
          candidate.pricingVersion = 1;
          try { calculateCheckout(candidate, Date.now(), false); }
          catch { return res.status(400).json({ error: 'The new session cannot produce a valid bill. Review its time, duration and payment.' }); }
          save();
        });
      }
    }
    save();
    function save() {
      const columns = { status: 'status', session: 'sessionData', name: 'name', isActive: 'isActive', maintenanceReason: 'maintenanceReason' };
      const keys = Object.keys(columns).filter(key => Object.hasOwn(body, key));
      if (!keys.length) return res.status(400).json({ error: 'No changes provided.' });
      const values = keys.map(key => key === 'session' ? (body.session === null ? null : JSON.stringify(body.session)) : key === 'isActive' ? Number(!!body[key]) : body[key]);
      // Compare against the raw stored row in the same UPDATE so a concurrent order cannot slip between read and write.
      values.push(req.params.id, row.status, row.sessionData);
      // The write must still see the exact pricing rows reviewed above. A policy
      // transaction that commits between read and write cannot silently reprice play.
      const rateCondition = pricingGuard ? ' AND isActive = 1' + pricingGuard.map(() => ' AND (SELECT settingValue FROM systemSettings WHERE keyName=?) IS ?').join('') : '';
      if (pricingGuard) values.push(...pricingGuard.flat());
      db.run(`UPDATE tables SET ${keys.map(key => columns[key] + ' = ?').join(', ')} WHERE id = ? AND status = ? AND sessionData IS ? AND NOT EXISTS (SELECT 1 FROM native_reservation_move_holds WHERE table_id = tables.id)${rateCondition}`, values, function(err) {
        if (err) return res.status(503).json({ error: 'Could not save the table.' });
        if (this.changes !== 1) return res.status(409).json({ error: 'The table changed. Refresh before saving.' });
        res.json({ id: req.params.id });
      });
    }
  });
});

const legacyQueueWrite = (_req, res) => res.status(410).json({ error: 'Refresh the app and use the confirmed queue operation service.', code: 'QUEUE_LEGACY_WRITE_DISABLED' });
app.post('/api/queue', legacyQueueWrite);
app.put('/api/queue/:id', legacyQueueWrite);
app.delete('/api/queue/:id', legacyQueueWrite);

app.put('/api/watchlist/:id', (req, res) => {
  const updates = req.body;
  const keys = Object.keys(updates);
  if (keys.length === 0) return res.json({ message: "Nothing to update" });

  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => {
    const val = updates[k];
    if (typeof val === 'boolean') return val ? 1 : 0;
    return val;
  });
  values.push(req.params.id);

  db.run(`UPDATE watchlist SET ${setClause} WHERE id = ?`, values, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Watchlist updated." });
  });
});

app.delete('/api/watchlist/:id', (req, res) => {
  db.run(`UPDATE watchlist SET isArchived = 1 WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Watchlist item archived." });
  });
});

const lostRecordFields = ['id','itemName','description','foundDate','status','image','claimedBy','claimedDate','isArchived'];
const lostRecord = row => ({ ...row, isArchived: row.isArchived === 1 });
const validLostOriginal = (record, id) => record && typeof record === 'object' && !Array.isArray(record) &&
  Object.keys(record).length === lostRecordFields.length && lostRecordFields.every(key => Object.hasOwn(record,key)) &&
  record.id === id && typeof record.isArchived === 'boolean' && ['found','claimed'].includes(record.status) &&
  ['itemName','description','foundDate'].every(key => typeof record[key] === 'string') &&
  ['image','claimedBy','claimedDate'].every(key => record[key] === null || typeof record[key] === 'string');
function saveLostTransition(req,res,archive) {
  const original = req.body?.expectedRecord, patch = req.body?.patch;
  if (!validLostOriginal(original,req.params.id) || Object.keys(req.body).some(key => !(archive ? ['expectedRecord'] : ['expectedRecord','patch']).includes(key))) return res.status(400).json({error:'Reload the original lost-item record before changing it.'});
  let next;
  if (archive) {
    if (original.status !== 'found' || original.isArchived) return res.status(409).json({error:'Only an unclaimed, active item can be archived.'});
    next = {...original,isArchived:true};
  } else {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length !== 4 || !['status','claimedBy','claimedDate','isArchived'].every(key=>Object.hasOwn(patch,key))) return res.status(400).json({error:'Review the complete claim or revert action.'});
    const claim = patch.status === 'claimed' && original.status === 'found' && !original.isArchived && patch.isArchived === true && typeof patch.claimedBy === 'string' && patch.claimedBy.trim().length > 0 && patch.claimedBy.length <= 200 && typeof patch.claimedDate === 'string' && Number.isFinite(Date.parse(patch.claimedDate)) && new Date(patch.claimedDate).toISOString() === patch.claimedDate;
    const revert = patch.status === 'found' && original.status === 'claimed' && patch.isArchived === false && patch.claimedBy === null && patch.claimedDate === null;
    if (!claim && !revert) return res.status(400).json({error:'The claim or revert details are invalid.'});
    next = {...original,...patch,...(claim ? {claimedBy:patch.claimedBy.trim()} : {})};
  }
  const parameters = [next.status,next.claimedBy,next.claimedDate,next.isArchived?1:0,...lostRecordFields.map(key=>key==='isArchived'?(original[key]?1:0):original[key])];
  db.get(`UPDATE lost_and_found SET status=?,claimedBy=?,claimedDate=?,isArchived=? WHERE id IS ? AND itemName IS ? AND description IS ? AND foundDate IS ? AND status IS ? AND image IS ? AND claimedBy IS ? AND claimedDate IS ? AND isArchived IS ? RETURNING *`,parameters,(error,row)=>{
    if (error) return res.status(503).json({error:'Lost-item change was not confirmed. Reload the record before retrying.'});
    if (row) return res.json({id:row.id,record:lostRecord(row)});
    db.get('SELECT id FROM lost_and_found WHERE id=?',[req.params.id],(_error,existing)=>res.status(_error?503:existing?409:404).json({error:'Lost-item record changed or is missing. Reload it before trying again.'}));
  });
}
app.put('/api/lost-and-found/:id', (req,res)=>saveLostTransition(req,res,false));
app.delete('/api/lost-and-found/:id', (req,res)=>saveLostTransition(req,res,true));

app.post('/api/reservations', (req, res) => {
  const { id, customerName, contactNumber, email, date, timeSlot, durationHours, partySize, status, totalAmount, downPaymentAmount, downPaymentPaid, balancePaid, paymentRef, receiptImg } = req.body;
  const createdAt = new Date().toISOString();
  db.run(`INSERT INTO reservations (id, customerName, contactNumber, email, date, timeSlot, durationHours, partySize, status, totalAmount, downPaymentAmount, downPaymentPaid, balancePaid, paymentRef, receiptImg, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
  [id, customerName, contactNumber, email || null, date, timeSlot, durationHours, partySize, status, totalAmount, downPaymentAmount, downPaymentPaid ? 1 : 0, balancePaid ? 1 : 0, paymentRef || null, receiptImg || null, createdAt], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ message: 'Reservation created successfully', id: id });
  });
});



app.put('/api/announcements/:id', (req, res) => {
  const updates = req.body;
  const keys = Object.keys(updates);
  if (keys.length === 0) return res.json({ message: "Nothing to update" });

  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => {
    const val = updates[k];
    if (typeof val === 'boolean') return val ? 1 : 0;
    return val;
  });
  values.push(req.params.id);

  db.run(`UPDATE announcements SET ${setClause} WHERE id = ?`, values, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes !== 1) return res.status(404).json({ error: 'Announcement was not found. Refresh before editing.' });
    res.json({ message: "Announcement updated." });
  });
});

app.delete('/api/announcements/:id', (req, res) => {
  db.run(`DELETE FROM announcements WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Announcement deleted." });
  });
});

app.post('/api/feedback', (req, res) => {
  const { id, customerName, contactInfo, feedbackType, comment, reservationId, tags, date, status, notes } = req.body;
  if ((status !== undefined && status !== 'pending') || (notes !== undefined && notes !== null && notes !== '')) return res.status(400).json({ error: 'New feedback must be pending without resolution notes.' });
  const tagsStr = tags ? JSON.stringify(tags) : '[]';
  db.run(`INSERT INTO feedback (id, customerName, contactInfo, feedbackType, comment, reservationId, tags, date, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, customerName, contactInfo, feedbackType, comment, reservationId, tagsStr, date || new Date().toISOString(), status || 'pending', notes || null], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ message: "Feedback submitted." });
  });
});
require('./server-feedback.cjs').registerFeedbackResolutionRoutes(app, db, { requireAdmin: auth.requireAdmin });


app.put('/api/promo-codes/:id', (req, res) => {
  const updates = req.body;
  const allowedCols = {
    code: 'code',
    discountPercent: 'discount_percent',
    discount_percent: 'discount_percent',
    description: 'description',
    isActive: 'is_active',
    is_active: 'is_active',
    isLimitedUses: 'is_limited_uses',
    is_limited_uses: 'is_limited_uses',
    maxUsage: 'max_usage',
    max_usage: 'max_usage',
    usageCount: 'usage_count',
    usage_count: 'usage_count',
    startDate: 'start_date',
    start_date: 'start_date',
    expiresAt: 'expires_at',
    expires_at: 'expires_at'
  };

  const keys = Object.keys(updates).filter(k => allowedCols[k]);
  if (keys.length === 0) return res.json({ message: "Nothing to update" });

  const setClause = keys.map((k) => `${allowedCols[k]} = ?`).join(', ');
  const values = keys.map((k) => {
    const val = updates[k];
    if (typeof val === 'boolean') return val ? 1 : 0;
    if (k === 'startDate' || k === 'expiresAt') return val ? new Date(val).toISOString() : null;
    return val;
  });
  values.push(req.params.id);

  db.run(`UPDATE promo_codes SET ${setClause} WHERE id = ?`, values, function (err) {
    if (err) {
      console.error('❌ Failed to update promo code in SQLite:', err.message);
      return res.status(500).json({ error: err.message });
    }
    if (this.changes !== 1) return res.status(404).json({ error: 'Promo was not found. Refresh before editing.' });
    res.json({ message: "Promo updated." });
  });
});

app.delete('/api/promo-codes/:id', (req, res) => {
  db.run(`DELETE FROM promo_codes WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Promo deleted." });
  });
});

app.post('/api/activities', (req, res) => {
  const { id, type } = req.body;
  const inputMetadata = req.body.metadata;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(id) || typeof type !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(type) || typeof req.body.description !== 'string' || !req.body.description.trim() || req.body.description.length > 4000 || (inputMetadata !== undefined && (!inputMetadata || typeof inputMetadata !== 'object' || Array.isArray(inputMetadata))) || JSON.stringify(inputMetadata || {}).length > 20000) return res.status(400).json({error:'Activity details are invalid.'});
  const timestamp = new Date().toISOString();
  const description = String(req.body.description || '').replace(/ \(Action by:.*\)$/, '') + ` (Action by: ${req.staff.fullName})`;
  const metadata = { ...(req.body.metadata || {}), actorId: req.staff.id, actorName: req.staff.fullName };
  const metaStr = metadata ? JSON.stringify(metadata) : null;
  db.get(
    `INSERT INTO activities (id, type, description, timestamp, metadata) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING *`,
    [id, type, description, timestamp, metaStr],
    function (err,row) {
      if (err) return res.status(503).json({error:'Activity log save was not confirmed.'});
      const respond = (saved,status) => res.status(status).json({...saved,metadata:JSON.parse(saved.metadata)});
      if (row) return respond(row,201);
      db.get('SELECT * FROM activities WHERE id=?',[id],(readError,saved)=>{
        if (readError || !saved) return res.status(503).json({error:'Activity log save was not confirmed.'});
        let previous; try { previous=JSON.parse(saved.metadata); } catch { return res.status(409).json({error:'The existing activity needs review.'}); }
        const canonical = value => JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
        if (saved.type !== type || saved.description !== description || canonical(previous) !== canonical(metadata)) return res.status(409).json({error:'Activity ID already belongs to different details.'});
        respond(saved,200);
      });
    }
  );
});

app.put('/api/reservations/:id', (req, res) => {
  const updates = req.body;
  const keys = Object.keys(updates);
  if (keys.length === 0) return res.json({ message: "Nothing to update" });

  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => {
    const val = updates[k];
    if (typeof val === 'boolean') return val ? 1 : 0;
    return val;
  });
  values.push(req.params.id);

  db.run(`UPDATE reservations SET ${setClause} WHERE id = ?`, values, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Reservation updated." });
  });
});

app.delete('/api/reservations/:id', (req, res) => {
  db.run(`DELETE FROM reservations WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Reservation deleted." });
  });
});

require('./server-inventory.cjs').registerInventoryRoutes(app, db);
require('./server-orders.cjs').registerOrderRoutes(app, dbPath);

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));

const isProduction = process.env.NODE_ENV === 'production';
if (isProduction) {
  const distPath = path.join(__dirname, 'dist');
  app.use(express.static(distPath));
  
  app.get('/favicon.ico', (_req, res) => res.status(204).end());
  app.get(/(.*)/, (req, res) => {
    res.sendFile('index.html', { root: distPath });
  });
}
// ====================================================================
// 🚀 SERVER STARTUP
// ====================================================================
Promise.all([databaseReady, auth.ready, sessionState.ready, queueOperations.ready, nativeReservationRuntime, checkoutSchemaReady]).then(() => {
  const server = app.listen(PORT, '127.0.0.1', () => {
    if (process.send) process.send({ type: 'backend-ready', port: server.address().port });
    console.log(`One Shot Edge Server is running on http://127.0.0.1:${server.address().port}`);
  });
  server.on('error', error => { console.error('Local server could not start:', error.message); process.exit(1); });
}).catch(error => { console.error('Local database initialization failed:', error.message); process.exit(1); });
// The Electron parent owns this backend; a crashed parent must not leave a helper behind.
process.on('disconnect', () => process.exit(0));
