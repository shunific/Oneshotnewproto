// ====================================================================
// ONE SHOT BAR & BILLIARDS: LOCAL EDGE SERVER (CommonJS)
// ====================================================================
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envPath = process.env.NODE_ENV === 'production'
  ? path.join(process.resourcesPath, '.env')
  : path.join(__dirname, '.env');

const envResult = dotenv.config({ path: envPath });

if (envResult.error) {
  console.error(`❌ [ENV ERROR]: Could not load ${envPath}`);
} else {
  console.log(`✅ [ENV]: Loaded ${Object.keys(envResult.parsed || {}).length} variables from ${envPath}`);
}

const express = require('express');
const cors = require('cors');
const sqlite3Pkg = require('sqlite3');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const brain = require('brain.js'); // 🧠 QUEUE AI LIBRARY

// 🟢 GLOBAL CRASH GUARDS: Prevent server shutdowns from unhandled errors
process.on('uncaughtException', (err) => {
  console.error('⚠️ [Uncaught Exception Guard]:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [Unhandled Rejection Guard]:', reason);
});

// 🟢 SAFE JSON PARSER: Prevents malformed JSON strings from crashing requests
const safeParseJSON = (str, fallback = null) => {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch (e) {
    return Array.isArray(fallback) ? [str] : str;
  }
};

const sqlite3 = sqlite3Pkg.verbose();
const app = express();
const PORT = process.env.PORT || 3001;

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
  '';

if (!SUPABASE_SERVICE_KEY) {
  console.error('❌ [CONFIG ERROR]: Supabase key is empty! Check your variable names in .env');
}

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

const upload = multer({ storage: multer.memoryStorage() });

app.use(cors()); 
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ====================================================================
// 🟢 SQLITE DATABASE INITIALIZATION & AUTO-MIGRATIONS
// ====================================================================
const userDataPath = process.env.USER_DATA_PATH || __dirname;
const dbPath = path.resolve(userDataPath, 'oneshot.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Error connecting to SQLite database:', err.message);
  } else {
    console.log('✅ Connected to local SQLite database.');
    db.configure('busyTimeout', 5000);
    
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS systemSettings (keyName TEXT PRIMARY KEY, settingValue TEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      db.run(`CREATE TABLE IF NOT EXISTS cms (keyName TEXT PRIMARY KEY, settingValue TEXT, updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      db.run(`CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, mimeType TEXT, data BLOB)`);
      db.run(`CREATE TABLE IF NOT EXISTS staff (id TEXT PRIMARY KEY, username TEXT, password TEXT, fullName TEXT, role TEXT, phone TEXT, joinedDate TEXT, avatarImg TEXT, isActive INTEGER DEFAULT 1, isAdmin INTEGER DEFAULT 0, recoveryPin TEXT)`);
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

      db.run(`INSERT OR IGNORE INTO systemSettings (keyName, settingValue) SELECT key_name, setting_value FROM system_settings`, (err) => {
        if (!err) {
          db.run(`DELETE FROM systemSettings WHERE keyName LIKE '%_%'`);
          db.run(`DROP TABLE IF EXISTS system_settings`);
        }
      });
      db.run(`INSERT OR IGNORE INTO cms (keyName, settingValue) SELECT key_name, content_value FROM cms_content`, (err) => {
        if (!err) db.run(`DROP TABLE IF EXISTS cms_content`);
      });

        // 🟢 IRONCLAD SELF-HEALING SUPER ADMIN
      // 🟢 IRONCLAD SELF-HEALING SUPER ADMIN
      const createSuperAdmin = `
        INSERT OR IGNORE INTO staff (id, username, password, fullName, role, phone, joinedDate, isActive, isAdmin, recoveryPin)
        VALUES ('admin_001', 'superadmin', '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9', 'System Administrator', 'Super Admin', '00000000000', datetime('now'), 1, 1, '8492')
      `;
      db.run(createSuperAdmin, (err) => {
        if (err) console.error("❌ Failed to inject Super Admin:", err.message);
        else console.log("🛡️ Super Admin account verified/injected.");
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
app.get('/api/staff', (req, res) => {
  db.all(`SELECT * FROM staff`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({ ...r, isActive: r.isActive === 1, isAdmin: r.isAdmin === 1 })));
  });
});

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

app.get('/api/images/:id', (req, res) => {
  db.get(`SELECT mimeType, data FROM images WHERE id = ?`, [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).send('Image not found');
    res.setHeader('Content-Type', row.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000'); 
    res.send(row.data); 
  });
});

app.get('/api/closed-dates', (req, res) => {
  db.all(`SELECT * FROM closed_dates ORDER BY closed_date ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({
      id: r.id, date: r.closed_date, type: r.type || 'specific', dayOfWeek: r.day_of_week,
      reason: r.reason, isFullDay: r.is_full_day === 1, openTime: r.open_time, closeTime: r.close_time
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
      date: r.date || r.reservation_date,
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

app.get('/api/events', (req, res) => {
  db.all(`SELECT * FROM events ORDER BY rowid DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(e => ({ 
      ...e,
      id: e.id,
      duration: e.duration || 'Whole Day',
      slotsFull: e.slotsFull === 1, 
      allowReservations: e.allowReservations !== 0,
      caterWalkIns: e.caterWalkIns !== 0,
      walkInTableCount: e.walkInTableCount ?? 4,
      reservationTableCount: e.reservationTableCount ?? 4,
      minParticipants: e.minParticipants ?? 8,
      maxParticipants: e.maxParticipants ?? 32,
      attachments: safeParseJSON(e.attachments, []),
      walkInTableIds: safeParseJSON(e.walkInTableIds, []),
      reservationTableIds: safeParseJSON(e.reservationTableIds, []),
      eventTableIds: safeParseJSON(e.eventTableIds, [])
    })));
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
  db.all(`SELECT * FROM session_history ORDER BY endTime DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => ({ ...r, orders: safeParseJSON(r.orders, []) })));
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

app.get('/api/cms', (req, res) => {
  db.all(`SELECT keyName, settingValue FROM cms`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const config = {};
    rows.forEach(row => {
      const val = row.settingValue;
      if (val && (val.startsWith('[') || val.startsWith('{'))) {
        config[row.keyName] = safeParseJSON(val, val);
      } else {
        config[row.keyName] = val;
      }
    });
    res.json(config);
  });
});

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


app.put('/api/cms', (req, res) => {
  const payload = req.body;
  const keys = Object.keys(payload);
  if (keys.length === 0) return res.json({ message: "No CMS content to update" });
  let index = 0;
  let errors = [];
  
  const processNextKey = () => {
    if (index >= keys.length) {
      if (errors.length > 0) return res.status(500).json({ error: "Some CMS fields failed to save.", details: errors });
      return res.json({ message: "CMS content updated successfully." });
    }
    const key = keys[index];
    const rawVal = payload[key];
    const value = (typeof rawVal === 'object' && rawVal !== null) ? JSON.stringify(rawVal) : String(rawVal ?? '');
    
    db.run(
      `INSERT INTO cms (keyName, settingValue, updatedAt) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(keyName) DO UPDATE SET settingValue = excluded.settingValue, updatedAt = CURRENT_TIMESTAMP`,
      [key, value],
      function(err) {
        if (err) { errors.push({ key, error: err.message }); }
        index++;
        processNextKey();
      }
    );
  };
  processNextKey();
});

app.post('/api/cache-reservations', (req, res) => {
  const { reservations } = req.body;
  if (!Array.isArray(reservations)) return res.status(400).json({ error: 'Invalid payload' });

  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO reservations (id, customerName, contactNumber, email, date, timeSlot, durationHours, partySize, tableId, status, totalAmount, downPaymentAmount, downPaymentPaid, balancePaid, paymentRef, receiptImg, cancellationReason, refundStatus, refundMethod, refundNotes, createdAt) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    reservations.forEach(r => {
      stmt.run([r.id, r.customerName, r.contactNumber, r.email||null, typeof r.date === 'string' ? r.date : new Date(r.date).toISOString(), r.timeSlot, r.durationHours, r.partySize, r.tableId||null, r.status, r.totalAmount, r.downPaymentAmount, r.downPaymentPaid?1:0, r.balancePaid?1:0, r.paymentRef||null, r.receiptImg||null, r.cancellationReason||null, r.refundStatus||null, r.refundMethod||null, r.refundNotes||null, typeof r.createdAt === 'string' ? r.createdAt : new Date(r.createdAt).toISOString()]);
    });
    stmt.finalize();
    db.run('COMMIT', (err) => {
      if (err) return res.status(500).json({ error: err.message });
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
            const payload = rows.map(mapFn);
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
      syncTable('cms', 'cms', r => ({ keyName: r.keyName, settingValue: r.settingValue }), 'keyName'),
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
      syncTable('events', 'events', r => ({ id: r.id, title: r.title, date: r.date || null, type: r.type, description: r.description || '', duration: r.duration || 'Whole Day', registrationLink: r.registrationLink || null, bracketLink: r.bracketLink || null, minParticipants: r.minParticipants || 8, maxParticipants: r.maxParticipants || 32, slotsFull: r.slotsFull ? 1 : 0, attachments: r.attachments || null, allowReservations: r.allowReservations !== 0 ? 1 : 0, reservationTableCount: r.reservationTableCount || 4, caterWalkIns: r.caterWalkIns !== 0 ? 1 : 0, walkInTableCount: r.walkInTableCount || 4, isCancelled: r.isCancelled ? 1 : 0, cancelReason: r.cancelReason || null }), 'id'),
      syncTable('announcements', 'announcements', r => ({ id: r.id, title: r.title, content: r.content, type: r.type, isActive: r.isActive ? 1 : 0, expiresAt: r.expiresAt || null, createdAt: r.createdAt || new Date().toISOString() }), 'id'),
      syncTable('closed_dates', 'closed_dates', r => ({ id: r.id, closed_date: r.closed_date || null, type: r.type, day_of_week: r.day_of_week, reason: r.reason, is_full_day: !!r.is_full_day, open_time: r.open_time, close_time: r.close_time }), 'id'),
      syncTable('inventory', 'inventory', r => ({ id: r.id, name: r.name, category: r.category, price: r.price, stock: r.stock, isActive: r.isActive ? 1 : 0 }), 'id'),
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
  db.run(`INSERT INTO lost_and_found (id, itemName, description, foundDate, status, image, claimedBy, claimedDate, isArchived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  [id, itemName, description, foundDate, status, image, claimedBy, claimedDate], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ message: "Lost item added." });
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

app.post('/api/session-history', (req, res) => {
  const { id, customerName, tableId, tableName, startTime, endTime, durationMinutes, totalAmount, amountPaid, orders, partySize, occupancyRate } = req.body;
  db.run(`INSERT INTO session_history (id, customerName, tableId, tableName, startTime, endTime, durationMinutes, totalAmount, amountPaid, orders, partySize, occupancyRate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, customerName, tableId, tableName, startTime, endTime, durationMinutes, totalAmount, amountPaid, JSON.stringify(orders || []), partySize || 2, occupancyRate || 0.5], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ message: "Session history logged with AI telemetry." });
  });
});

app.post('/api/e-receipts', (req, res) => {
  const { id, receipt_no, reservation_id, customer_name, customer_email, customer_phone, table_id, table_name, play_start_time, play_end_time, duration_minutes, table_rate, table_charge, overtime_charge, fnb_charge, subtotal, discount_amount, total_amount, amount_paid, balance_due, payment_method, payment_status } = req.body;
  db.run(`INSERT INTO e_receipts (id, receipt_no, reservation_id, customer_name, customer_email, customer_phone, table_id, table_name, play_start_time, play_end_time, duration_minutes, table_rate, table_charge, overtime_charge, fnb_charge, subtotal, discount_amount, total_amount, amount_paid, balance_due, payment_method, payment_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, receipt_no, reservation_id, customer_name, customer_email, customer_phone, table_id, table_name, play_start_time, play_end_time, duration_minutes, table_rate, table_charge, overtime_charge, fnb_charge, subtotal, discount_amount, total_amount, amount_paid, balance_due, payment_method, payment_status], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ message: "e-Receipt saved." });
  });
});

app.post('/api/promo-codes', (req, res) => {
  const { id, code, discountPercent, description, isActive, isLimitedUses, maxUsage, startDate, expiresAt } = req.body;
  db.run(`INSERT INTO promo_codes (id, code, discount_percent, description, is_active, is_limited_uses, max_usage, start_date, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
  [id, code, discountPercent, description, isActive ? 1 : 0, isLimitedUses ? 1 : 0, maxUsage, startDate, expiresAt], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ message: "Promo added to DB." });
  });
});

app.post('/api/images', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const fileExt = req.file.originalname.split('.').pop();
  const fileName = `img_${Date.now()}_${Math.round(Math.random() * 1000)}.${fileExt}`;

  try {
    const { error: uploadError } = await supabase.storage
      .from('oneshot-assets')
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });

    if (uploadError) {
      return res.status(500).json({ error: uploadError.message });
    }

    const { data: publicUrlData } = supabase.storage
      .from('oneshot-assets')
      .getPublicUrl(fileName);

    res.status(201).json({ url: publicUrlData.publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tables', (req, res) => {
  const { id, name, status, isActive } = req.body;
  db.run(
    `INSERT INTO tables (id, name, status, isActive) VALUES (?, ?, ?, ?)`,
    [id, name, status || 'available', isActive ? 1 : 0],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ message: 'Table created successfully', id: id });
    }
  );
});

app.put('/api/tables/:id', (req, res) => {
  const { status, session, isActive, name, maintenanceReason } = req.body;
  const sessionData = session ? JSON.stringify(session) : null;
  let updates = [], params = [];
  if (status !== undefined) { updates.push("status = ?"); params.push(status); }
  if (session !== undefined || req.body.hasOwnProperty('session')) { updates.push("sessionData = ?"); params.push(sessionData); }
  if (isActive !== undefined) { updates.push("isActive = ?"); params.push(isActive ? 1 : 0); }
  if (name !== undefined) { updates.push("name = ?"); params.push(name); }
  if (maintenanceReason !== undefined) { updates.push("maintenanceReason = ?"); params.push(maintenanceReason); }
  if (updates.length === 0) return res.json({ message: "Nothing to update" });
  params.push(req.params.id);
  db.run(`UPDATE tables SET ${updates.join(', ')} WHERE id = ?`, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Table updated successfully." });
  });
});

app.post('/api/queue', (req, res) => {
  const { id, customerName, contactNumber, partySize, status, queueNumber, notes } = req.body;
  db.run(`INSERT INTO queue (id, customerName, contactNumber, partySize, status, queueNumber, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
  [id, customerName, contactNumber, partySize, status, queueNumber, notes || ''], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ message: 'Added to queue' });
  });
});

app.put('/api/queue/:id', (req, res) => {
  const updates = req.body;
  const keys = Object.keys(updates);
  if (keys.length === 0) return res.json({ message: "Nothing to update" });

  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => updates[k]);
  values.push(req.params.id);

  db.run(`UPDATE queue SET ${setClause} WHERE id = ?`, values, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Queue updated." });
  });
});

app.delete('/api/queue/:id', (req, res) => {
  db.run(`DELETE FROM queue WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Queue item deleted." });
  });
});

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

app.put('/api/lost-and-found/:id', (req, res) => {
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

  db.run(`UPDATE lost_and_found SET ${setClause} WHERE id = ?`, values, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Lost and found updated." });
  });
});

app.delete('/api/lost-and-found/:id', (req, res) => {
  db.run(`UPDATE lost_and_found SET isArchived = 1 WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Lost and found item archived." });
  });
});

app.post('/api/reservations', (req, res) => {
  const { id, customerName, contactNumber, email, date, timeSlot, durationHours, partySize, status, totalAmount, downPaymentAmount, downPaymentPaid, balancePaid, paymentRef, receiptImg } = req.body;
  const createdAt = new Date().toISOString();
  db.run(`INSERT INTO reservations (id, customerName, contactNumber, email, date, timeSlot, durationHours, partySize, status, totalAmount, downPaymentAmount, downPaymentPaid, balancePaid, paymentRef, receiptImg, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
  [id, customerName, contactNumber, email || null, date, timeSlot, durationHours, partySize, status, totalAmount, downPaymentAmount, downPaymentPaid ? 1 : 0, balancePaid ? 1 : 0, paymentRef || null, receiptImg || null, createdAt], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ message: 'Reservation created successfully', id: id });
  });
});

app.post('/api/events', (req, res) => {
  const { 
    title, date, type, description, duration, registrationLink, bracketLink, 
    minParticipants, maxParticipants, slotsFull, attachments, allowReservations, 
    reservationTableCount, caterWalkIns, walkInTableCount, walkInTableIds, 
    reservationTableIds, eventTableIds 
  } = req.body;

  const id = req.body.id || ('ev_' + Date.now() + '_' + Math.round(Math.random() * 1000));
  const createdAt = new Date().toISOString();

  db.run(
    `INSERT INTO events (id, title, date, type, description, duration, registrationLink, bracketLink, minParticipants, maxParticipants, slotsFull, attachments, allowReservations, reservationTableCount, caterWalkIns, walkInTableCount, walkInTableIds, reservationTableIds, eventTableIds, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, title, date, type, description, duration || 'Whole Day',
      registrationLink || '', bracketLink || '',
      minParticipants || 8, maxParticipants || 32, slotsFull ? 1 : 0,
      JSON.stringify(attachments || []),
      allowReservations ? 1 : 0, reservationTableCount || 4,
      caterWalkIns ? 1 : 0, walkInTableCount || 4,
      JSON.stringify(walkInTableIds || []),
      JSON.stringify(reservationTableIds || []),
      JSON.stringify(eventTableIds || []),
      createdAt
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ message: "Event created.", id });
    }
  );
});

app.post('/api/announcements', (req, res) => {
  const { id, title, content, type, isActive, expiresAt, createdAt, startDate } = req.body;
  db.run(
    `INSERT INTO announcements (id, title, content, type, isActive, expiresAt, createdAt, startDate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, title, content, type, isActive ? 1 : 0, expiresAt || null, createdAt || new Date().toISOString(), startDate || null],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ message: "Announcement added.", id });
    }
  );
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
    res.json({ message: "Announcement updated." });
  });
});

app.delete('/api/announcements/:id', (req, res) => {
  db.run(`DELETE FROM announcements WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Announcement deleted." });
  });
});

app.put('/api/events/:id', (req, res) => {
  const updates = req.body;
  const keys = Object.keys(updates);
  if (keys.length === 0) return res.json({ message: "Nothing to update" });

  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => {
    const val = updates[k];
    if (typeof val === 'boolean') return val ? 1 : 0;
    if (Array.isArray(val)) return JSON.stringify(val);
    return val;
  });
  values.push(req.params.id);

  db.run(`UPDATE events SET ${setClause} WHERE id = ?`, values, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Event updated." });
  });
});

app.delete('/api/events/:id', (req, res) => {
  db.run(`DELETE FROM events WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Event deleted." });
  });
});

app.post('/api/closed-dates', (req, res) => {
  const { id, date, type, dayOfWeek, reason, isFullDay, openTime, closeTime } = req.body;
  db.run(
    `INSERT INTO closed_dates (id, closed_date, type, day_of_week, reason, is_full_day, open_time, close_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, date || '', type || 'specific', dayOfWeek || 0, reason, isFullDay ? 1 : 0, openTime || '12:00', closeTime || '22:00'],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ message: "Closed date added.", id });
    }
  );
});
app.post('/api/feedback', (req, res) => {
  const { id, customerName, contactInfo, feedbackType, comment, reservationId, tags, date, status, notes } = req.body;
  const tagsStr = tags ? JSON.stringify(tags) : '[]';
  db.run(`INSERT INTO feedback (id, customerName, contactInfo, feedbackType, comment, reservationId, tags, date, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, customerName, contactInfo, feedbackType, comment, reservationId, tagsStr, date || new Date().toISOString(), status || 'pending', notes || null], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ message: "Feedback submitted." });
  });
});
app.put('/api/feedback/:id', (req, res) => {
  const updates = req.body;
  const keys = Object.keys(updates);
  if (keys.length === 0) return res.json({ message: "Nothing to update" });

  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => updates[k]);
  values.push(req.params.id);

  db.run(`UPDATE feedback SET ${setClause} WHERE id = ?`, values, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Feedback updated." });
  });
});
app.put('/api/closed-dates/:id', (req, res) => {
  const updates = req.body;
  const keys = Object.keys(updates);
  if (keys.length === 0) return res.json({ message: "Nothing to update" });

  const setClause = keys.map((k) => {
    if (k === 'date') return 'closed_date = ?';
    if (k === 'dayOfWeek') return 'day_of_week = ?';
    if (k === 'isFullDay') return 'is_full_day = ?';
    if (k === 'openTime') return 'open_time = ?';
    if (k === 'closeTime') return 'close_time = ?';
    return `${k} = ?`;
  }).join(', ');

  const values = keys.map((k) => {
    const val = updates[k];
    if (typeof val === 'boolean') return val ? 1 : 0;
    return val;
  });
  values.push(req.params.id);

  db.run(`UPDATE closed_dates SET ${setClause} WHERE id = ?`, values, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Closed date updated." });
  });
});

app.delete('/api/closed-dates/:id', (req, res) => {
  db.run(`DELETE FROM closed_dates WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Closed date deleted." });
  });
});

app.put('/api/promo-codes/:id', (req, res) => {
  const updates = req.body;
  const keys = Object.keys(updates);
  if (keys.length === 0) return res.json({ message: "Nothing to update" });

  const setClause = keys.map((k) => {
    if (k === 'discountPercent') return 'discount_percent = ?';
    if (k === 'isActive') return 'is_active = ?';
    if (k === 'isLimitedUses') return 'is_limited_uses = ?';
    if (k === 'maxUsage') return 'max_usage = ?';
    if (k === 'usageCount') return 'usage_count = ?';
    if (k === 'startDate') return 'start_date = ?';
    if (k === 'expiresAt') return 'expires_at = ?';
    return `${k} = ?`;
  }).join(', ');

  const values = keys.map((k) => {
    const val = updates[k];
    if (typeof val === 'boolean') return val ? 1 : 0;
    return val;
  });
  values.push(req.params.id);

  db.run(`UPDATE promo_codes SET ${setClause} WHERE id = ?`, values, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Promo updated." });
  });
});

app.delete('/api/promo-codes/:id', (req, res) => {
  db.run(`DELETE FROM promo_codes WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Promo deleted." });
  });
});

app.post('/api/staff', (req, res) => {
  const { id, username, password, fullName, role, phone, joinedDate, avatarImg, isActive, isAdmin, recoveryPin } = req.body;
  db.run(
    `INSERT INTO staff (id, username, password, fullName, role, phone, joinedDate, avatarImg, isActive, isAdmin, recoveryPin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, username, password, fullName, role || 'cashier', phone || '', joinedDate || new Date().toISOString(), avatarImg || '', isActive ? 1 : 0, isAdmin ? 1 : 0, recoveryPin || ''],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ message: "Staff user created successfully.", id });
    }
  );
});

app.put('/api/staff/:id', (req, res) => {
  const updates = req.body;

  if (req.params.id === 'admin_001') {
    delete updates.isActive; // Cannot deactivate
    delete updates.isAdmin;  // Cannot remove admin rights
    delete updates.role;     // Cannot change role
    delete updates.username; // Cannot change root username
  }

  const keys = Object.keys(updates);
  if (keys.length === 0) return res.json({ message: "Nothing to update" });

  const setClause = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => {
    const val = updates[k];
    if (typeof val === 'boolean') return val ? 1 : 0;
    return val;
  });
  values.push(req.params.id);

  db.run(`UPDATE staff SET ${setClause} WHERE id = ?`, values, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Staff user updated successfully." });
  });
});

app.post('/api/activities', (req, res) => {
  const { id, type, description, timestamp, metadata } = req.body;
  const metaStr = metadata ? JSON.stringify(metadata) : null;
  db.run(
    `INSERT OR IGNORE INTO activities (id, type, description, timestamp, metadata) VALUES (?, ?, ?, ?, ?)`,
    [id, type, description, timestamp, metaStr],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ message: "Activity logged." });
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

app.post('/api/inventory', (req, res) => {
  const { id, name, category, price, stock, isActive } = req.body;
  db.run(`INSERT INTO inventory (id, name, category, price, stock, isActive) VALUES (?, ?, ?, ?, ?, ?)`, [id, name, category, price, stock, isActive ? 1 : 0], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ message: "Inventory item saved to DB." });
  });
});

const updateSettingsHandler = (req, res) => {
  const payload = req.body;
  const keys = Object.keys(payload);
  if (keys.length === 0) return res.json({ message: "No settings to update" });
  let index = 0; let errors = [];
  const processNextKey = () => {
    if (index >= keys.length) {
      if (errors.length > 0) return res.status(500).json({ error: "Some settings failed to save.", details: errors });
      return res.json({ message: "Settings updated successfully." });
    }
    const key = keys[index];
    const value = typeof payload[key] === 'boolean' ? String(payload[key]) : (payload[key] ?? '').toString();
    db.run(`INSERT INTO systemSettings (keyName, settingValue) VALUES (?, ?) ON CONFLICT(keyName) DO UPDATE SET settingValue = excluded.settingValue, updatedAt = CURRENT_TIMESTAMP`, [key, value], function(err) {
      if (err) { errors.push({ key, error: err.message }); }
      index++; processNextKey();
    });
  };
  processNextKey();
};
app.put('/api/settings/rates', updateSettingsHandler);
app.put('/api/settings/terms', updateSettingsHandler);

const isProduction = process.env.NODE_ENV === 'production';
if (isProduction) {
  const distPath = path.join(__dirname, 'dist');
  app.use(express.static(distPath));
  
  app.get(/(.*)/, (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}
// ====================================================================
// ⚠️ DEBUG ROUTE: TOTAL DAY-1 NUKE (FOR ALPHA TESTING)
// ====================================================================
app.post('/api/debug/reset', async (req, res) => {
  try {
    console.log("🧹 Initiating Total Day-1 Database Nuke...");

    // 1. WIPE CLOUD (SUPABASE)
    // 🟢 SAFE FILTER: .not('id', 'is', null) safely wipes UUIDs and Text IDs.
    // 🟢 SCHEMA MATCH: Only targets tables that actually exist in Supabase.
    const cloudWipes = await Promise.all([
      supabase.from('queue').delete().not('id', 'is', null),
      supabase.from('reservations').delete().not('id', 'is', null),
      supabase.from('session_history').delete().not('id', 'is', null),
      supabase.from('activities').delete().not('id', 'is', null),
      supabase.from('feedback').delete().not('id', 'is', null),
      supabase.from('e_receipts').delete().not('id', 'is', null),
      supabase.from('watchlist').delete().not('id', 'is', null),
      supabase.from('lost_and_found').delete().not('id', 'is', null),
      supabase.from('tables').delete().not('id', 'is', null),
      supabase.from('inventory').delete().not('id', 'is', null),
      supabase.from('events').delete().not('id', 'is', null),
      supabase.from('promo_codes').delete().not('id', 'is', null),
      supabase.from('announcements').delete().not('id', 'is', null),
      supabase.from('closed_dates').delete().not('id', 'is', null)
    ]);

    const cloudErrors = cloudWipes.filter(r => r.error).map(r => r.error.message);
    if (cloudErrors.length > 0) {
       console.error("⚠️ Cloud Wipe Blocked:", cloudErrors);
       return res.status(500).json({ error: "Cloud Wipe Failed: " + cloudErrors[0] });
    }
    console.log("✅ Cloud Supabase Nuke Successful.");

    // 2. WIPE LOCAL SQLITE DATA
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      db.run(`DELETE FROM queue`);
      db.run(`DELETE FROM reservations`);
      db.run(`DELETE FROM session_history`);
      db.run(`DELETE FROM activities`);
      db.run(`DELETE FROM feedback`);
      db.run(`DELETE FROM e_receipts`);
      db.run(`DELETE FROM watchlist`);
      db.run(`DELETE FROM lost_and_found`);
      db.run(`DELETE FROM tables`);
      db.run(`DELETE FROM inventory`);
      db.run(`DELETE FROM events`);
      db.run(`DELETE FROM promo_codes`);
      db.run(`DELETE FROM announcements`);
      db.run(`DELETE FROM closed_dates`);
      // Protects the Local Super Admin so you don't get locked out
      db.run(`DELETE FROM staff WHERE username != 'superadmin'`); 
      
      // Reset the SQLite auto-increment counters for a clean state
      db.run(`VACUUM`);

      db.run('COMMIT', (err) => {
        if (err) return res.status(500).json({ error: err.message });
        console.log("✅ Local SQLite Nuke Successful.");
        res.status(200).json({ message: "Full Day 1 Reset completed across Local and Cloud." });
      });
    });
  } catch (err) {
    console.error("Cloud wipe error:", err);
    res.status(500).json({ error: "Failed to wipe cloud data: " + err.message });
  }
});

// ====================================================================
// 🚀 SERVER STARTUP
// ====================================================================
app.listen(PORT, () => {
  console.log(`\n🎱 One Shot Edge Server is running on http://localhost:${PORT}`);
});