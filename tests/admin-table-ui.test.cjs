const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const source = fs.readFileSync(path.join(__dirname, '../src/app/pages/AdminTableManagement.tsx'), 'utf8');
const handlers = ['handleAdd','handleUpdateName','handleConfirmMaintenance','handleReactivateTable','handleForceClear'];
function load(name, env) {
  const start = source.indexOf(`  const ${name} =`);
  const end = source.indexOf('\n  const ',start+1);
  const code = esbuild.transformSync(source.slice(start,end),{loader:'tsx'}).code;
  return vm.runInNewContext(`${code}; ${name}`,env);
}
function environment(fails, occupied = false) {
  const writes=[], closes=[], busy=[], notices=[];
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const write=async(...args)=>{writes.push(args);await gate;if(fails)throw new Error('Unable to save: stale table.');};
  const table={id:'table-1',name:'QA Table',status:occupied?'occupied':'maintenance',isActive:false,...(occupied?{session:{customerName:'QA guest'}}:{})};
  const env={
    tables:[table],newName:'New QA Table',editName:'Renamed QA Table',isSubmitting:false,isLoading:false,isConfirming:false,
    maintenanceModal:{tableId:table.id,tableName:table.name,targetActive:false},selectedReason:'QA felt repair',customReason:'',
    addTable:write,updateTable:write,updateTableState:write,
    setIsSubmitting:value=>busy.push(value),setIsLoading:value=>busy.push(value),setIsConfirming:value=>busy.push(value),
    setLoadingMsg(){},setOpenDropdownId(){},setNewName:value=>closes.push(['newName',value]),setShowAddForm:value=>closes.push(['add',value]),setEditingId:value=>closes.push(['edit',value]),setMaintenanceModal:value=>closes.push(['maintenance',value]),setCustomReason:value=>closes.push(['reason',value]),
    flash:(message,type='success')=>notices.push({message,type}),
  };
  return{env,table,writes,closes,busy,notices,release};
}

test('table administration handlers await exactly one confirmed write and preserve forms on save failure', async()=>{
  for(const name of handlers)for(const fails of [false,true]){
    const f=environment(fails);const handler=load(name,f.env);
    const promise=name==='handleAdd'||name==='handleConfirmMaintenance'?handler({preventDefault(){}}):name==='handleUpdateName'?handler(f.table.id):handler(f.table);
    assert.equal(f.writes.length,1,name);
    assert.equal(f.closes.length,0,`${name}: no premature close`);
    assert.equal(f.notices.length,0,`${name}: no premature success`);
    f.release();await promise;
    assert.equal(f.busy.at(-1),false,name);
    if(fails){assert.equal(f.closes.length,0,name);assert.equal(f.notices.at(-1).type,'error',name);}
    else{assert.equal(f.notices.at(-1).type,'success',name);if(['handleAdd','handleUpdateName','handleConfirmMaintenance'].includes(name))assert.ok(f.closes.length>0,name);}
    if(name==='handleConfirmMaintenance')assert.equal(f.writes[0][1].isActive,false);
    if(name==='handleReactivateTable')assert.equal(f.writes[0][1].isActive,true);
  }
});

test('occupied table maintenance/reactivation/reset never dispatches a destructive write', async()=>{
  for(const name of ['handleConfirmMaintenance','handleReactivateTable','handleForceClear']){
    const f=environment(false,true);const handler=load(name,f.env);
    await(name==='handleConfirmMaintenance'?handler({preventDefault(){}}):handler(f.table));
    assert.equal(f.writes.length,0,name);assert.equal(f.closes.length,0,name);
    assert.equal(f.notices.at(-1).type,'error',name);assert.match(f.notices.at(-1).message,/Staff Table Monitor/);
  }
});
