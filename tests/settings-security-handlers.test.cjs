const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const esbuild=require('esbuild');
const source=fs.readFileSync(require.resolve('../src/app/pages/Settings.tsx'),'utf8');
const slice=source.slice(source.indexOf('  const handleSaveSecurity ='),source.indexOf('  const tabs:'));
const code=esbuild.transformSync(slice+'\nglobalThis.handlers={handleSaveSecurity,handleSetNewPin};',{loader:'ts'}).code;
function fixture(extra={}, overrides={}) {
 const calls={api:[],password:[],verify:[],error:[],edit:[],busy:[],profile:[],flash:[]};
 const state={username:'qa-staff',currentPassword:'fixtureCurrent9',newPassword:'',confirmPassword:'',newRecoveryPin:'',...extra};
 const context={secForm:state,pwStrength:{isValid:true},securityInFlight:{current:false},staffProfile:{id:'qa-id',username:'qa-staff'},setSecError:v=>calls.error.push(v),setIsSavingSecurity:v=>calls.busy.push(v),setSecEdit:v=>calls.edit.push(v),setSecForm:update=>{context.secForm=typeof update==='function'?update(context.secForm):update;},flash:(...v)=>calls.flash.push(v),updateStaffProfile:v=>calls.profile.push(v),changeOwnCredentials:async value=>{calls.password.push(value);},authRequest:async(route,value)=>{calls.api.push({route,value});return{user:{id:'qa-id',username:value.username}};},verifyPassword:async value=>{calls.verify.push(value);return true;},...overrides};
 vm.runInNewContext(code,context);return{context,calls,handlers:context.handlers};
}
test('PIN-only change uses protected change-pin, clears confirmed inputs and never retrieves the old PIN',async()=>{
 const f=fixture({newRecoveryPin:'483729'});await f.handlers.handleSaveSecurity();assert.equal(f.calls.password.length,0);assert.equal(f.calls.api.length,1);assert.equal(f.calls.api[0].route,'change-pin');assert.equal(f.calls.api[0].value.recoveryPin,'483729');assert.equal(f.context.secForm.newRecoveryPin,'');assert.equal(f.context.secForm.currentPassword,'');assert.deepEqual(f.calls.edit,[false]);assert.equal(f.calls.profile.length,0);
});
test('password and PIN change share the password update and preserve a blank PIN as undefined',async()=>{
 for(const newRecoveryPin of ['483729','']) {const f=fixture({newPassword:'fixtureChanged9',confirmPassword:'fixtureChanged9',newRecoveryPin});await f.handlers.handleSaveSecurity();assert.equal(f.calls.password.length,1);assert.equal(f.calls.password[0].recoveryPin,newRecoveryPin||undefined);assert.equal(f.calls.api.length,0);assert.equal(f.context.secForm.newRecoveryPin,'');}
});
test('failed PIN write keeps all entered values and the edit form open',async()=>{
 const f=fixture({newRecoveryPin:'483729'},{authRequest:async()=>{throw new Error('Fixture disk failure');}});const before={...f.context.secForm};await f.handlers.handleSaveSecurity();assert.deepEqual({...f.context.secForm},before);assert.equal(f.calls.edit.length,0);assert.match(f.calls.error.at(-1),/Failed to save/);assert.equal(f.context.securityInFlight.current,false);assert.deepEqual(f.calls.busy,[true,false]);
});
test('PIN validation rejects short, long and nondigit values before sending credentials',async()=>{
 for(const value of ['1','1234567890123','12xx34']) {const f=fixture({newRecoveryPin:value});await f.handlers.handleSaveSecurity();assert.equal(f.calls.api.length,0);assert.equal(f.calls.password.length,0);assert.match(f.calls.error.at(-1),/4–12 digits/);}
});
test('username-only change verifies current password and uses no PIN endpoint',async()=>{
 const f=fixture({username:'qa-renamed'});await f.handlers.handleSaveSecurity();assert.equal(f.calls.verify.length,1);assert.equal(f.calls.api[0].route,'change-username');assert.equal(f.calls.profile[0].username,'qa-renamed');
});
test('username failure after confirmed password/PIN save reports partial result and retains usable retry credentials',async()=>{
 const f=fixture({username:'qa-renamed',newPassword:'fixtureChanged9',confirmPassword:'fixtureChanged9',newRecoveryPin:'483729'},{authRequest:async()=>{throw new Error('Username conflict');}});await f.handlers.handleSaveSecurity();assert.equal(f.context.secForm.username,'qa-renamed');assert.equal(f.context.secForm.currentPassword,'fixtureChanged9');assert.equal(f.context.secForm.newPassword,'');assert.equal(f.context.secForm.newRecoveryPin,'');assert.match(f.calls.error.at(-1),/was saved, but the username change failed/);assert.equal(f.calls.edit.length,0);
});
test('repeated save cannot dispatch a second credential mutation while the first is pending',async()=>{
 let resolve;let count=0;const f=fixture({newRecoveryPin:'483729'},{authRequest:()=>{count++;return new Promise(done=>{resolve=done;});}});const first=f.handlers.handleSaveSecurity();await f.handlers.handleSaveSecurity();assert.equal(count,1);resolve({success:true});await first;assert.equal(f.context.securityInFlight.current,false);
});
test('Set a New Recovery PIN opens the editor without fetching or exporting secrets',()=>{
 const f=fixture();f.handlers.handleSetNewPin();assert.deepEqual(f.calls.edit,[true]);assert.equal(f.calls.api.length,0);assert.equal(f.calls.password.length,0);assert.equal(f.calls.profile.length,0);
});

test('password save rejects mismatch, weak input and current-password reuse without sending credential changes',async()=>{
 for(const [changes,overrides,warning]of [
  [{newPassword:'fixtureChanged9',confirmPassword:'Mismatch9'},{},/do not match/],
  [{newPassword:'abcdefgh',confirmPassword:'abcdefgh'},{pwStrength:{isValid:false}},/security requirements/],
  [{newPassword:'fixtureCurrent9',confirmPassword:'fixtureCurrent9'},{},/different password/]
 ]){const f=fixture(changes,overrides);await f.handlers.handleSaveSecurity();assert.equal(f.calls.password.length,0);assert.equal(f.calls.api.length,0);assert.match(f.calls.error.at(-1),warning);assert.equal(f.calls.edit.length,0);}
});
