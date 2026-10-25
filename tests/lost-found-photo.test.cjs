const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const page=fs.readFileSync(path.resolve(__dirname,'../src/app/pages/LostAndFound.tsx'),'utf8');
function saveFixture({uploadStatus=201,url='/api/images/11111111-1111-4111-8111-111111111111',saveError=false}={}){
 const state={form:{itemName:' QA wallet ',description:' QA black wallet ',image:'blob:preview'},file:new Blob(['QA photo'],{type:'image/png'}),calls:[],flashes:[],submitting:false,modal:true};
 const context={mounted:{current:true},form:state.form,imageFile:state.file,isSubmitting:false,FormData,Error,Date,setIsSubmitting:v=>{state.submitting=v;},localFetch:async()=>{state.calls.push('upload');return{ok:uploadStatus===201,json:async()=>({url})};},setForm:value=>{state.form=typeof value==='function'?value(state.form):value;},setImageFile:value=>{state.file=value;},setShowModal:value=>{state.modal=value;},flash:(message,type)=>state.flashes.push({message,type}),addLostItem:async value=>{state.calls.push(value);if(saveError)throw Error('QA save failed');}};
 const source=page.slice(page.indexOf('  const handleSave ='),page.indexOf('  const handleClaim =')).replace('(e: React.FormEvent)','(e)');const save=vm.runInNewContext(source+';handleSave',context);
 return{state,save:()=>save({preventDefault(){}})};
}
test('lost photo upload failure never records item, clears form or reports success',async()=>{
 const f=saveFixture({uploadStatus:503});await f.save();assert.deepEqual(f.state.calls,['upload']);assert.equal(f.state.form.image,'blob:preview');assert.equal(f.state.modal,true);assert.equal(f.state.submitting,false);assert.ok(f.state.flashes.every(x=>x.type==='error'));
});
test('upload precedes awaited item save and failed save retains confirmed durable photo for retry',async()=>{
 const f=saveFixture({saveError:true});await f.save();assert.equal(f.state.calls[0],'upload');assert.equal(f.state.calls[1].image,'/api/images/11111111-1111-4111-8111-111111111111');assert.equal(f.state.form.image,f.state.calls[1].image);assert.equal(f.state.file,null);assert.equal(f.state.modal,true);assert.equal(f.state.form.itemName,' QA wallet ');assert.ok(f.state.flashes.every(x=>x.type==='error'));
 const source=page.slice(page.indexOf('  const handleSave ='),page.indexOf('  const handleClaim =')).replace('(e: React.FormEvent)','(e)');let uploads=0,saved;
 const retry=vm.runInNewContext(source+';handleSave',{mounted:{current:true},form:f.state.form,imageFile:null,isSubmitting:false,FormData,Error,Date,setIsSubmitting(){},localFetch:async()=>{uploads++;throw Error('unexpected reupload');},addLostItem:async value=>{saved=value;},setForm(){},setImageFile(){},setShowModal(){},flash(){}});await retry({preventDefault(){}});assert.equal(uploads,0);assert.equal(saved.image,f.state.form.image);
});
test('confirmed save alone closes the form and localhost/IPv4/dev image URLs retain the correct API host',async()=>{
 const f=saveFixture();await f.save();assert.equal(f.state.calls.length,2);assert.equal(f.state.calls[1].itemName,'QA wallet');assert.equal(f.state.modal,false);assert.equal(f.state.form.image,'');assert.equal(f.state.flashes.at(-1).type,'success');
 const source=page.slice(page.indexOf('export function lostPhotoUrl'),page.indexOf('export function LostAndFound')).replace('export ','').replace('(image: string)','(image)');
 for(const [hostname,port,origin,expected]of [['127.0.0.1','3001','http://127.0.0.1:3001','http://127.0.0.1:3001'],['localhost','3001','http://localhost:3001','http://localhost:3001'],['localhost','5173','http://localhost:5173','http://localhost:3001']]){const resolve=vm.runInNewContext(source+';lostPhotoUrl',{window:{location:{hostname,port,origin}}});assert.equal(resolve('/api/images/qa'),expected+'/api/images/qa');}
});
test('AppContext adds lost item and activity only after confirmed DB save and never into a changed identity',async()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../src/app/context/AppContext.tsx'),'utf8');const body=source.slice(source.indexOf('  const addLostItem ='),source.indexOf('  const saveLostTransition =')).replace("(i: Omit<LostItem, 'id'>)",'(i)');
 for(const mode of ['failed','changed','saved']){let items=0,activities=0;const identityRef={current:'qa'},identityGeneration={current:1};const add=vm.runInNewContext(body+';addLostItem',{crypto:require('node:crypto'),Error,identityRef,identityGeneration,authMutationInFlight:{current:false},syncToDB:async(_endpoint,_method,item)=>{assert.equal(items,0);if(mode==='failed')throw Error('QA failed');if(mode==='changed')identityGeneration.current++;return{id:item.id,record:item};},setLostItems:()=>{items++;},addActivity:()=>{activities++;},runCloudBackup(){}});if(mode==='saved')await add({itemName:'QA'});else await assert.rejects(add({itemName:'QA'}));assert.equal(items,mode==='saved'?1:0);assert.equal(activities,mode==='saved'?1:0);}
});

test('leaving the page while upload completes cannot submit a stale lost item into the next session',async()=>{
 const source=page.slice(page.indexOf('  const handleSave ='),page.indexOf('  const handleClaim =')).replace('(e: React.FormEvent)','(e)');const mounted={current:true};let saves=0;
 const save=vm.runInNewContext(source+';handleSave',{mounted,form:{itemName:'QA',description:'QA',image:'blob:preview'},imageFile:new Blob(['QA']),isSubmitting:false,FormData,Error,Date,setIsSubmitting(){},localFetch:async()=>({ok:true,json:async()=>{mounted.current=false;return{url:'/api/images/11111111-1111-4111-8111-111111111111'};}}),addLostItem:async()=>{saves++;},setForm(){throw Error('stale form');},setImageFile(){},setShowModal(){},flash(){throw Error('stale toast');}});await save({preventDefault(){}});assert.equal(saves,0);
});
