const sqlite3=require('sqlite3'),{createHash}=require('node:crypto');
const {contentCanonical:canonical,validateContentCommand,validateCreatedContentRecord,contentRecordId}=require('./content-create-contract.mjs');
const DDL="CREATE TABLE IF NOT EXISTS local_content_create_operations (request_id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL CHECK(schema_version=1),kind TEXT NOT NULL CHECK(kind IN ('promo','announcement')),actor_id TEXT NOT NULL,command_json TEXT NOT NULL,record_json TEXT NOT NULL,journal_sha256 TEXT NOT NULL,created_at TEXT NOT NULL)";
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,function(error){error?reject(error):resolve(this);}));
const get=(db,sql,args=[])=>new Promise((resolve,reject)=>db.get(sql,args,(e,r)=>e?reject(e):resolve(r)));
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const journalHash=(kind,actorId,command,record,createdAt)=>digest({version:1,kind,actorId,command,record,createdAt});
const error=(status,message,code)=>Object.assign(Error(message),{status,code});
const normalizeDDL=value=>value.replace(' IF NOT EXISTS','').replace(/\s+/g,' ').trim();
async function recordOf(db,kind,id){
 const row=await get(db,kind==='promo'?'SELECT * FROM promo_codes WHERE id=?':'SELECT * FROM announcements WHERE id=?',[id]);
 if(!row)return null;
 if(kind==='promo')return{id:row.id,code:row.code,description:row.description,discountPercent:row.discount_percent,isActive:row.is_active===1?true:row.is_active===0?false:row.is_active,isLimitedUses:row.is_limited_uses===1?true:row.is_limited_uses===0?false:row.is_limited_uses,maxUsage:row.max_usage,startDate:row.start_date,expiresAt:row.expires_at,usageCount:row.usage_count};
 return{id:row.id,title:row.title,content:row.content,type:row.type,isActive:row.isActive===1?true:row.isActive===0?false:row.isActive,startDate:row.startDate,expiresAt:row.expiresAt,createdAt:row.createdAt};
}
function registerContentCreateRoutes(app,dbPath,{requireAdmin,resolveActor,isActorCurrent,readyBefore=Promise.resolve()}={}){
 const guards=Array.isArray(requireAdmin)?requireAdmin:[requireAdmin];if(!guards.length||!guards.every(g=>typeof g==='function')||typeof resolveActor!=='function'||typeof isActorCurrent!=='function')throw TypeError('Trusted administrator authorization is required.');
 for(const [kind,path]of [['promo','/api/promo-codes'],['announcement','/api/announcements']])app.post(path,...guards,async(req,res)=>{
  let db,begun=false;
  try{
   let command;try{command=validateContentCommand(kind,req.body);}catch{throw error(400,'Review the original complete create request.');}
   const actorId=command.expectedActorId,token=req.authToken;
   const fresh=async()=>{const actor=await resolveActor(token);if(actor?.localStaffId!==actorId||isActorCurrent(token,actor)!==true)throw error(403,'Administrator account changed. Sign in as the original administrator.');if(db){const staff=await get(db,'SELECT isActive,isAdmin,isFirstLogin FROM staff WHERE id=?',[actorId]);if(!staff||staff.isActive!==1||staff.isAdmin!==1||staff.isFirstLogin!==0||isActorCurrent(token,{localStaffId:actorId})!==true)throw error(403,'Current administrator access is required.');}};
   await fresh();await readyBefore;db=await new Promise((resolve,reject)=>{const d=new sqlite3.Database(dbPath,sqlite3.OPEN_READWRITE,e=>{if(e){d.close(()=>{});reject(e);}else resolve(d);});});db.configure('busyTimeout',5000);
   await run(db,'BEGIN IMMEDIATE');begun=true;await fresh();await run(db,DDL);const schema=await get(db,"SELECT sql FROM sqlite_master WHERE name='local_content_create_operations' AND type='table'");if(!schema||normalizeDDL(schema.sql)!==normalizeDDL(DDL))throw Error('CONTENT_JOURNAL_SCHEMA');
   const id=contentRecordId(kind,command.requestId),prior=await get(db,'SELECT * FROM local_content_create_operations WHERE request_id=?',[command.requestId]);let record,replayed=false;
   if(prior){
    let savedCommand,savedRecord;try{savedCommand=JSON.parse(prior.command_json);savedRecord=JSON.parse(prior.record_json);validateContentCommand(prior.kind,savedCommand);validateCreatedContentRecord(prior.kind,savedCommand,savedRecord);}catch{throw Error('CONTENT_JOURNAL_CORRUPT');}
    if(prior.schema_version!==1||prior.actor_id!==savedCommand.expectedActorId||prior.command_json!==canonical(savedCommand)||prior.record_json!==canonical(savedRecord)||prior.journal_sha256!==journalHash(prior.kind,prior.actor_id,savedCommand,savedRecord,prior.created_at)||typeof prior.created_at!=='string'||!Number.isFinite(Date.parse(prior.created_at)))throw Error('CONTENT_JOURNAL_CORRUPT');
    if(prior.actor_id!==actorId)throw error(403,'This create request belongs to another administrator.');
    if(prior.kind!==kind||prior.command_json!==canonical(command))throw error(409,'This request ID belongs to different original details.','CONTENT_CREATE_REQUEST_CONFLICT');
    record=await recordOf(db,kind,id);
    if(!record||canonical(record)!==prior.record_json){await fresh();await run(db,'COMMIT');begun=false;if(isActorCurrent(token,{localStaffId:actorId})!==true)throw error(403,'Administrator account changed. Retry the original request after sign-in.');return res.status(409).json({error:'The original record was saved, then '+(record?'changed':'deleted')+'. Saved records must be refreshed before creating another.',code:'CONTENT_CREATE_RECONCILE',requestId:command.requestId,kind,actorId,recordId:id,state:record?'changed':'deleted'});}
    replayed=true;
   }else{
    if(await recordOf(db,kind,id))throw error(409,'The record ID already exists. Refresh saved records.','CONTENT_CREATE_REQUEST_CONFLICT');
    const p=command.payload,createdAt=new Date().toISOString();
    const inserted=kind==='promo'?await run(db,'INSERT INTO promo_codes (id,code,discount_percent,description,is_active,is_limited_uses,max_usage,usage_count,start_date,expires_at) VALUES(?,?,?,?,?,?,?,0,?,?)',[id,p.code,p.discountPercent,p.description,Number(p.isActive),Number(p.isLimitedUses),p.maxUsage,p.startDate,p.expiresAt]):await run(db,'INSERT INTO announcements (id,title,content,type,isActive,startDate,expiresAt,createdAt) VALUES(?,?,?,?,?,?,?,?)',[id,p.title,p.content,p.type,Number(p.isActive),p.startDate,p.expiresAt,createdAt]);
    if(inserted.changes!==1)throw Error('CONTENT_WRITE_NOT_CONFIRMED');
    record=validateCreatedContentRecord(kind,command,await recordOf(db,kind,id));
    const saved=await run(db,'INSERT INTO local_content_create_operations VALUES(?,1,?,?,?,?,?,?)',[command.requestId,kind,actorId,canonical(command),canonical(record),journalHash(kind,actorId,command,record,createdAt),createdAt]);if(saved.changes!==1)throw Error('CONTENT_JOURNAL_NOT_CONFIRMED');
   }
   await fresh();await run(db,'COMMIT');begun=false;if(isActorCurrent(token,{localStaffId:actorId})!==true)throw error(403,'Administrator account changed. Retry the original request after sign-in.');res.status(replayed?200:201).json({requestId:command.requestId,kind,actorId,recordType:'local-content-create',record,replayed});
  }catch(e){if(begun)await run(db,'ROLLBACK').catch(()=>{});res.status([400,403,409].includes(e.status)?e.status:503).json({error:[400,403,409].includes(e.status)?e.message:'Create result is unconfirmed. Retry the original saved request.',...(e.code?{code:e.code}:{})});}
  finally{if(db)await new Promise(resolve=>db.close(()=>resolve()));}
 });
}
module.exports={registerContentCreateRoutes,contentCreateDDL:DDL};
