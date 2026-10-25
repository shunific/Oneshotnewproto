const sqlite3=require('sqlite3');
const {checkinDefinitions,normalizeSql}=require('../server-checkin-schema.cjs');
const fail=()=>Object.assign(new Error('The persisted native device identity is unavailable.'),{code:'DEVICE_KEY_UNAVAILABLE'});
const get=(db,sql,args=[])=>new Promise((resolve,reject)=>db.get(sql,args,(error,row)=>error?reject(error):resolve(row)));
async function readNativeDeviceId(filename){
 let db;
 try{
  db=await new Promise((resolve,reject)=>{const connection=new sqlite3.Database(filename,sqlite3.OPEN_READONLY,error=>error?reject(error):resolve(connection));});
  db.configure('busyTimeout',1000);
  const schema=await get(db,"SELECT sql FROM sqlite_master WHERE type='table' AND name='native_checkin_device'");
  if(!schema||normalizeSql(schema.sql)!==normalizeSql(checkinDefinitions[0][1]))throw fail();
  const row=await get(db,'SELECT device_id FROM native_checkin_device WHERE singleton=1');
  if(typeof row?.device_id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.device_id))throw fail();
  return row.device_id;
 }catch{throw fail();}
 finally{if(db)await new Promise(resolve=>db.close(resolve));}
}
module.exports={readNativeDeviceId};
