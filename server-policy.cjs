const sqlite3 = require('sqlite3');
const { createHash, randomUUID } = require('node:crypto');
const RATES = ['hourlyRate','overtimeRate','downPaymentPercent','bookingCutoffMinutes','weekdayStartTime','weekdayEndTime','isWeekdayHappyHourActive','weekdayHappyHourRate','weekdayHappyHourStart','weekdayHappyHourEnd','weekdayOnlineCapacityLimit','weekendStartTime','weekendEndTime','isWeekendHappyHourActive','weekendHappyHourRate','weekendHappyHourStart','weekendHappyHourEnd','weekendOnlineCapacityLimit'];
const TERMS = ['minHours','maxHours','cancellationHours','advanceBookingHours','cancellationPolicy','termsAndConditions','weekdayMinPartySize','weekdayMaxPartySize','weekendMinPartySize','weekendMaxPartySize'];
const MONEY = new Set(['hourlyRate','overtimeRate','weekdayHappyHourRate','weekendHappyHourRate']);
const TIMES = new Set(['weekdayStartTime','weekdayEndTime','weekdayHappyHourStart','weekdayHappyHourEnd','weekendStartTime','weekendEndTime','weekendHappyHourStart','weekendHappyHourEnd']);
const BOOLEANS = new Set(['isWeekdayHappyHourActive','isWeekendHappyHourActive']);
const TEXT = new Set(['cancellationPolicy','termsAndConditions']);
const fail = (status,code,message) => Object.assign(new Error(message),{status,code});
const run = (db,sql,args=[]) => new Promise((resolve,reject)=>db.run(sql,args,function(error){error?reject(error):resolve(this);}));
const all = (db,sql,args=[]) => new Promise((resolve,reject)=>db.all(sql,args,(error,rows)=>error?reject(error):resolve(rows)));
const close = db => new Promise(resolve=>db.close(()=>resolve()));
const object = value => value && typeof value==='object' && !Array.isArray(value);
function allowedShape(value,keys) {
  return object(value) && Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
}
function validField(key,value) {
  if (BOOLEANS.has(key)) return typeof value==='boolean';
  if (TIMES.has(key)) return typeof value==='string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
  if (TEXT.has(key)) return typeof value==='string' && value.length<=20000;
  if (typeof value!=='number' || !Number.isFinite(value)) return false;
  if (MONEY.has(key) || key==='downPaymentPercent') {
    return value>=(['hourlyRate','overtimeRate'].includes(key)?0.01:0) && value<=(key==='downPaymentPercent'?100:5000) && Number(value.toFixed(2))===value;
  }
  const upper=key==='bookingCutoffMinutes'?1440:['cancellationHours','advanceBookingHours'].includes(key)?168:['minHours','maxHours'].includes(key)?24:key.endsWith('OnlineCapacityLimit')?500:1000;
  const lower=['minHours','maxHours'].includes(key) || key.endsWith('PartySize')?1:0;
  return Number.isSafeInteger(value) && value>=lower && value<=upper;
}
function validatePolicy(rates,terms) {
  if (!allowedShape(rates,RATES) || !allowedShape(terms,TERMS)) throw fail(400,'INVALID_POLICY_FIELDS','Review every rate and policy field; unknown or missing fields cannot be saved.');
  for (const [key,value] of Object.entries({...rates,...terms})) if (!validField(key,value)) throw fail(400,'INVALID_POLICY_VALUE',`Review the value for ${key}.`);
  for (const prefix of ['weekday','weekend']) {
    if (rates[`${prefix}StartTime`]===rates[`${prefix}EndTime`]) throw fail(400,'INVALID_POLICY_RANGE','Opening and closing times must differ.');
    if (rates[`is${prefix[0].toUpperCase()+prefix.slice(1)}HappyHourActive`] && (rates[`${prefix}HappyHourRate`]<=0 || rates[`${prefix}HappyHourStart`]===rates[`${prefix}HappyHourEnd`])) throw fail(400,'INVALID_POLICY_RANGE','Active happy hours require a positive rate and different start and end times.');
  }
  if (terms.minHours>terms.maxHours || terms.weekdayMinPartySize>terms.weekdayMaxPartySize || terms.weekendMinPartySize>terms.weekendMaxPartySize) throw fail(400,'INVALID_POLICY_RANGE','Minimum hours and party sizes cannot exceed their maximums.');
}
function typedValue(key,raw) {
  let value=raw;
  if (BOOLEANS.has(key)) value=raw==='true'?true:raw==='false'?false:null;
  else if (!TIMES.has(key) && !TEXT.has(key)) value=typeof raw==='string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)?Number(raw):null;
  return validField(key,value)?value:null;
}
function snapshot(rows,actorId) {
  const raw=new Map(rows.map(row=>[row.keyName,row.settingValue]));
  const missingKeys=[],invalidKeys=[];
  const group=keys=>Object.fromEntries(keys.map(key=>{
    if (!raw.has(key)) {missingKeys.push(key);return [key,null];}
    const value=typedValue(key,raw.get(key));
    if (value===null) invalidKeys.push(key);
    return [key,value];
  }));
  const settings={rates:group(RATES),terms:group(TERMS)};
  const revision=createHash('sha256').update(JSON.stringify(rows.map(row=>[row.keyName,row.settingValue]))).digest('hex');
  return {actorId,settings,revision,missingKeys,invalidKeys};
}
async function open(filename,readonly) {
  return new Promise((resolve,reject)=>{
    const db=new sqlite3.Database(filename,readonly?sqlite3.OPEN_READONLY:sqlite3.OPEN_READWRITE,error=>{
      if (error) {db.close(()=>{});reject(error);} else {db.configure('busyTimeout',5000);resolve(db);}
    });
  });
}
function assertAdmin(req) {
  const user=req.staff;
  if (!user || typeof user.id!=='string' || !user.id || ![true,1].includes(user.isAdmin) || [false,0].includes(user.isActive) || [true,1].includes(user.isFirstLogin)) throw fail(403,'ADMIN_REQUIRED','Administrator access is required.');
}
function registerPolicyRoutes(app,dbPath,{requireAdmin, cooldownMs=0, now=Date.now, ready=Promise.resolve()}={}) {
  if (typeof requireAdmin!=='function' && (!Array.isArray(requireAdmin) || !requireAdmin.length || requireAdmin.some(guard=>typeof guard!=='function'))) throw new Error('Policy routes require administrator authentication middleware.');
  const guards=Array.isArray(requireAdmin)?requireAdmin:[requireAdmin];
  const privateResponse=(req,res,next)=>{res.set('Cache-Control','no-store');res.set('Pragma','no-cache');next();};
  const rateHistory = 'policy_rate_history';
  const handler = (mode) => async (req,res) => {
    const write = mode === 'replace' || mode === 'patch';
    let db, begun = false;
    try {
      assertAdmin(req);
      await ready;
      if (write && (!object(req.body) || req.body.expectedActorId !== req.staff.id)) {
        throw fail(409,'POLICY_ACTOR_CHANGED','The administrator account changed. Reload before saving.');
      }
      db = await open(dbPath, !write);
      if (write) { await run(db,'BEGIN IMMEDIATE'); begun = true; }
      if (mode === 'history') {
        const rows = await all(db, `SELECT savedAt, actorName, previousRates FROM ${rateHistory}
          WHERE ratesChanged = 1 ORDER BY id DESC LIMIT 30`);
        return res.json(rows.map(row => ({ ...row, previousRates: JSON.parse(row.previousRates) })));
      }
      const read = async () => snapshot(await all(db,'SELECT keyName,settingValue FROM systemSettings ORDER BY keyName COLLATE BINARY'), req.staff.id);
      const current = await read();
      const latest = cooldownMs ? (await all(db, `SELECT savedAt FROM ${rateHistory} ORDER BY id DESC LIMIT 1`))[0] : null;
      const nextSaveAt = latest ? latest.savedAt + cooldownMs : 0;
      if (!write) return res.json({ ...current, ...(cooldownMs ? { nextSaveAt } : {}) });

      const body = req.body;
      if (!allowedShape(body,['expectedActorId','expectedRevision','rates','terms']) || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) {
        throw fail(400,'INVALID_POLICY_REQUEST','Reload and review the policy before saving.');
      }
      if (body.expectedRevision !== current.revision) throw fail(409,'POLICY_STALE','Rates or policies changed. Reload and review before saving.');
      const next = mode === 'patch'
        ? { rates: { ...current.settings.rates, ...body.rates }, terms: { ...current.settings.terms, ...body.terms } }
        : { rates: body.rates, terms: body.terms };
      validatePolicy(next.rates, next.terms);
      const keys = [...RATES,...TERMS];
      const proposed = { ...next.rates, ...next.terms };
      const prior = { ...current.settings.rates, ...current.settings.terms };
      const changed = keys.filter(key => proposed[key] !== prior[key]);
      if (!changed.length && cooldownMs) {
        await run(db,'COMMIT'); begun = false;
        return res.json({ ...current, nextSaveAt });
      }
      const savedAt = now();
      if (nextSaveAt > savedAt) {
        res.set('Retry-After', String(Math.ceil((nextSaveAt - savedAt) / 1000)));
        return res.status(429).json({ error: 'Wait for the settings save cooldown to finish.', nextSaveAt });
      }
      for (const key of changed) {
        await run(db,'INSERT INTO systemSettings(keyName,settingValue) VALUES(?,?) ON CONFLICT(keyName) DO UPDATE SET settingValue=excluded.settingValue,updatedAt=CURRENT_TIMESTAMP',[key,String(proposed[key])]);
      }
      const saved = await read();
      if (saved.missingKeys.length || saved.invalidKeys.length || keys.some(key => (Object.hasOwn(saved.settings.rates,key) ? saved.settings.rates[key] : saved.settings.terms[key]) !== proposed[key])) {
        throw fail(503,'POLICY_ACK_INVALID','The saved configuration could not be verified.');
      }
      let activity;
      if (cooldownMs) {
        const actorName = req.staff.fullName || req.staff.username || req.staff.id;
        await run(db, `INSERT INTO ${rateHistory} (savedAt,actorName,previousRates,ratesChanged) VALUES (?,?,?,?)`,
          [savedAt, actorName, JSON.stringify(current.settings.rates), Number(RATES.some(key => changed.includes(key)))]);
        activity = {
          id: randomUUID(), type: 'admin_action', description: 'Saved policy and rate settings.',
          timestamp: new Date(savedAt).toISOString(),
          metadata: { actorId: req.staff.id, actorName, settingChanges: changed.map(key => ({
            field: key,
            ...(TEXT.has(key) ? {} : { before: prior[key], after: proposed[key] }),
          })) },
        };
        await run(db, 'INSERT INTO activities (id,type,description,timestamp,metadata) VALUES (?,?,?,?,?)',
          [activity.id, activity.type, activity.description, activity.timestamp, JSON.stringify(activity.metadata)]);
      }
      await run(db,'COMMIT'); begun = false;
      res.json({ ...saved, ...(cooldownMs ? { nextSaveAt: savedAt + cooldownMs, activity } : {}) });
    } catch (error) {
      res.status(error.status||503).json({error:error.status?error.message:'Policy storage is unavailable. No settings save was confirmed.',code:error.code&&error.status?error.code:'POLICY_STORAGE_UNAVAILABLE'});
    } finally {
      if (begun) await run(db,'ROLLBACK').catch(() => {});
      if (db) await close(db);
    }
  };
  app.get('/api/settings/policy',privateResponse,...guards,handler('read'));
  app.put('/api/settings/policy',privateResponse,...guards,handler('replace'));
  if (cooldownMs) {
    app.patch('/api/settings/policy',privateResponse,...guards,handler('patch'));
    app.get('/api/settings/policy/history',privateResponse,...guards,handler('history'));
  }
}
module.exports={registerPolicyRoutes,RATES,TERMS};
