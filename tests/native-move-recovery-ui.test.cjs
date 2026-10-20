const test=require('node:test'),assert=require('node:assert/strict'),esbuild=require('esbuild'),Module=require('node:module'),path=require('node:path');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const filename=path.resolve(__dirname,'pending-transfers.compiled.cjs');const code=esbuild.buildSync({entryPoints:[path.resolve(__dirname,'../src/app/components/PendingReservationMoves.tsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']}).outputFiles[0].text;
const compiled=new Module(filename,module);compiled.filename=filename;compiled.paths=module.paths;compiled._compile(code,filename);
const record={requestId:'qa_original',moveId:'11111111-1111-4111-8111-111111111111',sourceId:'a',targetId:'b',phase:'prepared'};
const render=(records,error='')=>renderToStaticMarkup(React.createElement(compiled.exports.PendingReservationMoves,{records,error,tables:[{id:'a',name:'QA Source'},{id:'b',name:'QA Destination'}],busy:false,onRecover(){},onRefresh(){}}));
test('unconfirmed transfer offers retry and explicit cancellation using table names',()=>{const html=render([record]);assert.match(html,/QA Source.*QA Destination/);assert.match(html,/>Retry transfer</);assert.match(html,/>Cancel transfer</);});
test('irreversible cancellation retries cancellation only; local commit cannot offer cancellation',()=>{
 const cancel=render([{...record,phase:'aborting'}]);assert.match(cancel,/>Retry cancellation</);assert.doesNotMatch(cancel,/>Retry transfer<|>Cancel transfer</);
 const moved=render([{...record,phase:'local-committed'}]);assert.match(moved,/>Retry transfer</);assert.doesNotMatch(moved,/>Cancel transfer</);
});
test('recovery state failures remain visible and an empty verified floor adds no warning',()=>{assert.equal(render([]),'');assert.match(render([],'Could not load recovery status'),/role="alert"/);assert.match(render([],'Could not load recovery status'),/Refresh transfers/);});
test('held tables expose recovery status and disable every session action',()=>{
 const target=path.resolve(__dirname,'table-card.compiled.cjs');
 const source=esbuild.buildSync({entryPoints:[path.resolve(__dirname,'../src/app/components/TableCard.tsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']}).outputFiles[0].text;
 const view=new Module(target,module);view.filename=target;view.paths=module.paths;view._compile(source,target);
 for(const status of ['available','occupied']){
  const session=status==='occupied'?{customerName:'QA held guest',startTime:new Date(Date.now()-60000).toISOString(),durationMinutes:60,isOpenTime:false,amountPaid:50,hourlyRate:50,orders:[]}:null;
  const html=renderToStaticMarkup(React.createElement(view.exports.TableCard,{table:{id:'qa',name:'QA Long Table Name',status,isActive:true,session},held:true,nextReservation:null,onAssign(){},onExtend(){},onEnd(){},onOrder(){}}));
  assert.match(html,/Transfer held/);assert.doesNotMatch(html,/> Open</);
  const buttons=[...html.matchAll(/<button\b[^>]*>/g)].map(item=>item[0]);assert.ok(buttons.length>0);
  for(const button of buttons)assert.match(button,/disabled=""/);
 }
});
