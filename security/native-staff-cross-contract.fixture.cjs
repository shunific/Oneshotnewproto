// Disposable actual coordinator/order/checkout fixture; no device key provisioning.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const nativeRoot = process.env.ONESHOT_PROOF_PACKAGE_ARCHIVE || path.resolve(__dirname,'..');
const sqlite3 = require(path.join(nativeRoot,'node_modules/sqlite3'));
const express = require(path.join(nativeRoot,'node_modules/express'));
const { createCheckinCoordinator } = require(path.join(nativeRoot,'server-checkin.cjs'));
const { checkinDefinitions } = require(path.join(nativeRoot,'server-checkin-schema.cjs'));
const { registerCheckoutRoutes } = require(path.join(nativeRoot,'server-checkout.cjs'));
const { registerOrderRoutes } = require(path.join(nativeRoot,'server-orders.cjs'));
async function withNativeStaffFixture(input, inspect) {
  const { command, result } = input;
  const folder = await fs.mkdtemp(path.join(os.tmpdir(),'oneshot-device-contract-'));
  const file = path.join(folder,'qa.sqlite');
  let db, server;
  try {
    db = await new Promise((resolve,reject)=>{const c=new sqlite3.Database(file,e=>e?reject(e):resolve(c));});
    const run=(sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,e=>e?reject(e):resolve()));
    for(const ddl of [
      'CREATE TABLE tables(id TEXT PRIMARY KEY,name TEXT,status TEXT,isActive INTEGER,sessionData TEXT)',
      'CREATE TABLE systemSettings(keyName TEXT PRIMARY KEY,settingValue TEXT)',
      'CREATE TABLE session_history(id TEXT PRIMARY KEY,customerName TEXT,tableId TEXT,tableName TEXT,startTime TEXT,endTime TEXT,durationMinutes INTEGER,totalAmount REAL,amountPaid REAL,orders TEXT,status TEXT,closureReason TEXT,partySize INTEGER)',
      'CREATE TABLE e_receipts(id TEXT PRIMARY KEY,receipt_no TEXT UNIQUE,reservation_id TEXT,customer_name TEXT,table_id TEXT,table_name TEXT,play_start_time TEXT,play_end_time TEXT,duration_minutes INTEGER,table_rate REAL,table_charge REAL,overtime_charge REAL,fnb_charge REAL,subtotal REAL,discount_amount REAL,total_amount REAL,amount_paid REAL,balance_due REAL,payment_method TEXT,payment_status TEXT,created_at TEXT)',
      'CREATE TABLE watchlist(id TEXT PRIMARY KEY,name TEXT,reason TEXT,description TEXT,status TEXT,dateAdded TEXT,isArchived INTEGER)',
      'CREATE TABLE inventory(id TEXT PRIMARY KEY,name TEXT,price REAL,stock INTEGER,isActive INTEGER)',
      checkinDefinitions[0][1],
    ]) await run(ddl);
    await run('INSERT INTO native_checkin_device(singleton,device_id) VALUES(1,?)',[command.deviceId]);
    await run('INSERT INTO tables VALUES(?,?,?,?,?)',[command.tableId,'QA proof table','available',1,null]);
    await run("INSERT INTO systemSettings VALUES('overtimeRate','300')");
    await run("INSERT INTO inventory VALUES('qa-proof-drink','QA proof drink',25,2,1)");
    const context={localStaffId:'qa-native-proof',cloudUserId:command.expectedStaffId,generation:1,active:true};
    const resolveActor=async()=>context.active?{localStaffId:context.localStaffId,cloudUserId:context.cloudUserId,generation:context.generation}:null;
    const isActorCurrent=(_,a)=>context.active&&a.localStaffId===context.localStaffId&&a.cloudUserId===context.cloudUserId&&a.generation===context.generation;
    const coordinator=createCheckinCoordinator(file,{resolveActor,isActorCurrent,claimCheckin:async(_,p)=>{assert.deepEqual(p,command);return result;}});
    const {deviceId,...nativeCommand}=command;
    await coordinator.claim('qa-token',nativeCommand);
    const admission=await coordinator.admit('qa-token',{requestId:command.requestId,expectedOvertimeRate:300});
    const app=express();app.use(express.json());app.use((req,_res,next)=>{req.staff={id:context.localStaffId};next();});registerCheckoutRoutes(app,file);registerOrderRoutes(app,file);
    server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const request=async(route,payload)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
    const checkout=async()=>{
      const ordered=await request('/api/tables/'+command.tableId+'/orders',{requestId:'qa_device_proof_order',expectedSessionStartTime:admission.table.session.startTime,cart:[{id:'qa-proof-drink',qty:1}]});
      const due=result.claim.netTotalCents/100+25-result.claim.verifiedPaidCents/100;
      return request('/api/tables/'+command.tableId+'/checkout',{requestId:'qa_device_proof_checkout',expectedSession:ordered.session,expectedSessionStartTime:ordered.session.startTime,paymentStatus:'paid',paymentMethod:'cash',tendered:due,useProrated:false});
    };
    return await inspect({db,file,run,context,admission,checkout});
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));
    if(db)await new Promise(resolve=>db.close(resolve));
    await fs.rm(folder,{recursive:true,force:true});
  }
}
module.exports={withNativeStaffFixture};
