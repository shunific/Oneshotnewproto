const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),crypto=require('node:crypto');
const esbuild=require('esbuild'),express=require('express'),sqlite3=require('sqlite3');
const {registerAuthRoutes,hashSecret}=require('../server-auth.cjs');
const employee={id:'qa_employee',username:'qaemployee',fullName:'Original QA',phone:'09111111111',role:'cashier'};
const filename=path.resolve(__dirname,'../src/app/components/EmployeeProfileEditor.tsx');
const code=esbuild.transformSync(fs.readFileSync(filename,'utf8'),{loader:'tsx',format:'cjs',jsx:'automatic'}).code;
function harness(options={}){
 let slots=[],cursor=0,saved=0,cancelled=0;
 const hooks={useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>{slots[i]=typeof value==='function'?value(slots[i]):value;}];},useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];}};
 const compiled=new Module(filename,module);compiled.filename=filename;compiled.paths=module.paths;const originalRequire=compiled.require.bind(compiled);compiled.require=name=>name==='react'?hooks:originalRequire(name);compiled._compile(code,filename);
 const props={employee,currentUserId:'qa_admin',save:async()=>{},onSaved:()=>saved++,onCancel:()=>cancelled++,...options};
 function render(){cursor=0;return compiled.exports.EmployeeProfileEditor(props);}
 function find(predicate,node=render()){if(!node||typeof node!=='object')return null;if(predicate(node))return node;for(const child of [].concat(node.props?.children||[])){const match=find(predicate,child);if(match)return match;}return null;}
 return{render,find,input:label=>find(node=>node.props?.['aria-label']===label),submit:()=>find(node=>node.type==='form').props.onSubmit({preventDefault(){}}),counts:()=>({saved,cancelled})};
}
test('editor saves only profile fields, waits for acknowledgement and blocks duplicate submission/cancel',async()=>{
 let release,patches=[];const pending=new Promise(resolve=>release=resolve);const h=harness({save:async(...args)=>{patches.push(args);await pending;}});
 h.input('Employee full name').props.onChange({target:{value:'  Updated QA  '}});h.input('Employee phone').props.onChange({target:{value:' 09222222222 '}});h.input('Employee role').props.onChange({target:{value:'manager'}});
 const first=h.submit();await h.submit();assert.deepEqual(patches,[[employee.id,{fullName:'Updated QA',phone:'09222222222',role:'manager'}]]);assert.equal(h.counts().saved,0);assert.equal(h.input('Employee full name').props.disabled,true);
 h.find(node=>node.type==='button'&&node.props.type==='button').props.onClick();assert.equal(h.counts().cancelled,0);
 release();await first;assert.equal(h.counts().saved,1);
});
test('failure preserves editable draft and exposes an error rather than closing or claiming success',async()=>{
 let calls=0;const h=harness({save:async()=>{calls++;throw new Error('synthetic SQL unavailable');}});h.input('Employee full name').props.onChange({target:{value:'Retain QA draft'}});await h.submit();assert.equal(h.counts().saved,0);assert.equal(h.input('Employee full name').props.value,'Retain QA draft');assert.equal(h.input('Employee full name').props.disabled,false);assert.match(h.find(node=>node.props?.role==='alert').props.children,/not saved.*preserved/);await h.submit();assert.equal(calls,2);
});
test('self and Master Super Admin roles are disabled and omitted, including forged UI role changes',async()=>{
 for(const row of [{...employee,id:'qa_admin'},{...employee,id:'admin_001'},{...employee,username:'superadmin'}]){
  let patch;const h=harness({employee:row,save:async(_id,value)=>patch=value});assert.equal(h.input('Employee role').props.disabled,true);h.input('Employee role').props.onChange({target:{value:'manager'}});await h.submit();assert.deepEqual(patch,{fullName:employee.fullName,phone:employee.phone});
 }
});
test('empty names do not issue updates and existing credentials are never requested by the editor',async()=>{
 let writes=0;const h=harness({save:async()=>writes++});h.input('Employee full name').props.onChange({target:{value:'  '}});await h.submit();assert.equal(writes,0);assert.match(h.find(n=>n.props?.role==='alert').props.children,/full name/);assert.equal(h.find(n=>n.type==='input'&&n.props.type==='password'),null);
});
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,e=>e?reject(e):resolve()));
test('actual editor patch persists through HTTP and reload, preserves privileges/password, and cannot edit as cashier',async t=>{
 const db=new sqlite3.Database(':memory:');await run(db,'CREATE TABLE staff (id TEXT PRIMARY KEY, username TEXT, password TEXT, fullName TEXT, role TEXT, phone TEXT, joinedDate TEXT, avatarImg TEXT, isActive INTEGER, isAdmin INTEGER, recoveryPin TEXT, isFirstLogin INTEGER)');
 const pin=await hashSecret('123456');const sha=s=>crypto.createHash('sha256').update(s).digest('hex');for(const[id,admin]of[['qa_admin',1],[employee.id,0],['admin_001',1]])await run(db,'INSERT INTO staff VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[id,id,sha('qa-safe-password'),id,'cashier','','','',1,admin,pin,0]);
 const app=express();app.use(express.json());const auth=registerAuthRoutes(app,db);await auth.ready;const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(async()=>{auth.close();await new Promise(r=>server.close(r));await new Promise(r=>db.close(r));});
 const call=async(route,method='GET',body,cookie)=>{const response=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 const admin=await call('/api/auth/login','POST',{username:'qa_admin',password:'qa-safe-password'});assert.equal(admin.status,200);
 const save=async(id,patch)=>{const result=await call('/api/staff/'+id,'PUT',patch,admin.cookie);assert.equal(result.status,200);assert.equal(result.body.id,id);};
 const h=harness({save});h.input('Employee full name').props.onChange({target:{value:'HTTP QA employee'}});h.input('Employee phone').props.onChange({target:{value:'09999999999'}});h.input('Employee role').props.onChange({target:{value:'manager'}});await h.submit();assert.equal(h.counts().saved,1);
 const users=await call('/api/staff','GET',undefined,admin.cookie);const saved=users.body.find(row=>row.id===employee.id);assert.equal(saved.fullName,'HTTP QA employee');assert.equal(saved.phone,'09999999999');assert.equal(saved.role,'manager');assert.equal(saved.username,employee.id);assert.equal(saved.isAdmin,false);assert.equal(saved.isActive,true);assert.equal(saved.password,undefined);
 const cashier=await call('/api/auth/login','POST',{username:employee.id,password:'qa-safe-password'});assert.equal(cashier.status,200);assert.equal((await call('/api/staff/admin_001','PUT',{fullName:'Denied'},cashier.cookie)).status,403);
 for(const id of ['qa_admin','admin_001']){const own=harness({employee:{...employee,id},currentUserId:'qa_admin',save});await own.submit();assert.equal(own.counts().saved,1);}
 const fresh=await call('/api/staff','GET',undefined,admin.cookie);assert.equal(fresh.body.find(row=>row.id==='admin_001').isAdmin,true);
 await run(db,'UPDATE staff SET isActive=0 WHERE id=?',[employee.id]);const archived=harness({save});archived.input('Employee full name').props.onChange({target:{value:'Archived QA edit'}});await archived.submit();assert.equal(archived.counts().saved,1);const reloaded=await call('/api/staff','GET',undefined,admin.cookie);const archivedRow=reloaded.body.find(row=>row.id===employee.id);assert.equal(archivedRow.fullName,'Archived QA edit');assert.equal(archivedRow.isActive,false);assert.equal((await call('/api/auth/login','POST',{username:employee.id,password:'qa-safe-password'})).status,401);
});
