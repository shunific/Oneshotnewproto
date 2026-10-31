import { contentCanonical as canonical, contentExact, normalizeContentPayload, validateContentCommand, validateContentAck, isContentReconciliation } from '../../../content-create-contract.mjs';
const kinds = ['promo','announcement'];
const keyFor = (ownerId,kind) => `oneshot_pending_content_create_v1:${encodeURIComponent(ownerId)}:${kind}`;
const unavailable = () => new Error('Create result is unconfirmed. Retry the saved original request before creating another.');
export function pendingContentCreates(storage,ownerId) {
  if (!ownerId) return [];
  if (!storage || typeof storage.getItem!=='function') throw unavailable();
  return kinds.flatMap(kind=>{
    const raw=storage.getItem(keyFor(ownerId,kind));if(raw===null)return[];
    if(typeof raw!=='string'||raw.length>65536)throw unavailable();
    let record;try{record=JSON.parse(raw);if(!contentExact(record,['ownerId','kind','command'])||record.ownerId!==ownerId||record.kind!==kind||record.command.expectedActorId!==ownerId)throw unavailable();validateContentCommand(kind,record.command);}catch{throw unavailable();}
    return[record];
  });
}
export async function saveContentCreate({storage,ownerId,kind,payload,request,isCurrent=()=>true,retry=false,newId=()=>crypto.randomUUID()}) {
  const current=()=>{if(!ownerId||isCurrent()!==true)throw new Error('Administrator account changed. Sign in as the original administrator to retry.');};
  current();if(!kinds.includes(kind))throw unavailable();
  let record=pendingContentCreates(storage,ownerId).find(item=>item.kind===kind);
  if(retry&&!record)throw new Error('No original pending create request exists. Reload saved records.');
  if(!record){record={ownerId,kind,command:{requestId:newId(),expectedActorId:ownerId,payload:normalizeContentPayload(kind,payload)}};validateContentCommand(kind,record.command);}
  else if(!retry&&canonical(record.command.payload)!==canonical(normalizeContentPayload(kind,payload)))throw new Error('A different create request is unconfirmed. Retry the saved original from recovery first.');
  const key=keyFor(ownerId,kind),raw=canonical(record);
  storage.setItem(key,raw);if(storage.getItem(key)!==raw)throw unavailable();current();
  const removeMatching=()=>{current();const saved=storage.getItem(key);if(saved===null)return;if(saved!==raw)throw unavailable();storage.removeItem(key);if(storage.getItem(key)!==null)throw unavailable();};
  let result;
  try{result=await request(kind==='promo'?'/api/promo-codes':'/api/announcements',JSON.parse(canonical(record.command)));}
  catch(error){current();if(isContentReconciliation(kind,record.command,error?.status,error?.response)){removeMatching();throw Object.assign(new Error('The original record was saved, then '+error.response.state+'. Review saved records before creating another.'),{code:'CONTENT_CREATE_RECONCILE',kind,recordId:error.response.recordId});}throw error;}
  current();let saved;try{saved=validateContentAck(kind,record.command,result);}catch{throw unavailable();}
  let recoveryPending=false;
  try{removeMatching();}catch{current();recoveryPending=true;}
  return{kind,record:saved,replayed:result.replayed,recoveryPending};
}
