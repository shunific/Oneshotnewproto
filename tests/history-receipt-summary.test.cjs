const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),Module=require('node:module');
const esbuild=require('esbuild'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server'),express=require('express');
const {withNativeDeviceFixture}=require('../security/native-device-cross-contract.cjs');
const input=require('./native-device-proof-fixture.cjs');
const {registerCheckoutRoutes}=require('../server-checkout.cjs');
const {registerRefundRoutes}=require('../server-refunds.cjs');
const get=(db,sql,args=[])=>new Promise((resolve,reject)=>db.get(sql,args,(e,r)=>e?reject(e):resolve(r)));
const filename=path.resolve(__dirname,'history-receipt-summary.compiled.cjs');
const source=esbuild.buildSync({entryPoints:[path.resolve(__dirname,'../src/app/components/HistoryReceiptSummary.tsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']}).outputFiles[0].text;
const compiled=new Module(filename,module);compiled.filename=filename;compiled.paths=module.paths;compiled._compile(source,filename);
const render=(record,receipt,state='loaded')=>renderToStaticMarkup(React.createElement(compiled.exports.HistoryReceiptSummary,{record,receipt,state}));
const serverSource=fs.readFileSync(path.resolve(__dirname,'../server.cjs'),'utf8');
const routeStart=serverSource.indexOf("app.get('/api/e-receipts/:id',"),routeEnd=serverSource.indexOf("app.get('/api/e-receipts',",routeStart);
assert.ok(routeStart>0&&routeEnd>routeStart);const receiptRoute=serverSource.slice(routeStart,routeEnd);
async function withReceipt(options,inspect){return withNativeDeviceFixture(input,async f=>{
 const session={customerName:'QA saved customer',startTime:new Date(Date.now()-10*60000).toISOString(),durationMinutes:60,isOpenTime:false,hourlyRate:75,overtimeRate:300,pricingVersion:1,amountPaid:options.prior??50,orders:options.orders||[]};
 await f.run('UPDATE tables SET sessionData=? WHERE id=?',[JSON.stringify(session),input.command.tableId]);
 const app=express();app.use(express.json());app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});app.use('/api',(req,res,next)=>{if(req.headers.authorization!=='QA synthetic')return res.status(401).json({error:'Sign in.'});req.staff={id:'qa_history_admin',fullName:'QA History Admin',isAdmin:true};next();});
 registerCheckoutRoutes(app,f.file);registerRefundRoutes(app,f.file,{requireAdmin:(_req,_res,next)=>next()});vm.runInNewContext(receiptRoute,{app,db:f.db});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base=`http://127.0.0.1:${server.address().port}`;
 const call=async(route,body,auth=true)=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(auth?{authorization:'QA synthetic'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,headers:response.headers,body:await response.json()};};
 try{
  const body={requestId:'qa_history_checkout',expectedSession:session,expectedSessionStartTime:session.startTime,paymentStatus:options.void?'unpaid':'paid',paymentMethod:'cash',tendered:options.void?0:options.tendered??40,useProrated:false,...(options.void?{closureKind:'void',reason:'QA incorrect session'}:{})};
  const checkout=await call(`/api/tables/${input.command.tableId}/checkout`,body);assert.equal(checkout.status,200,JSON.stringify(checkout.body));
  const history=await get(f.db,'SELECT * FROM session_history WHERE id=?',[checkout.body.receipt.id]);const record={...history,source:'table_session',orders:JSON.parse(history.orders)};
  const loaded=await call('/api/e-receipts/'+history.id);assert.equal(loaded.status,200);assert.equal(loaded.headers.get('cache-control'),'no-store');
  return await inspect({f,call,record,receipt:loaded.body,checkout:checkout.body});
 }finally{await new Promise(resolve=>server.close(resolve));}
});}
test('actual reloaded receipt with prior50/current25 never mislabels allocated75 as tendered or refund as change',async()=>withReceipt({prior:50,tendered:40},async({record,receipt,checkout})=>{
 assert.equal(checkout.alreadyPaid,50);assert.equal(checkout.totalPaidNow,25);assert.equal(checkout.tendered,40);assert.equal(checkout.change,15);assert.equal(receipt.total_amount,75);assert.equal(receipt.amount_paid,75);
 const html=render(record,receipt);assert.match(html,/START:/);assert.match(html,/END:/);assert.match(html,new RegExp(`DURATION: ${receipt.duration_minutes} mins`));assert.match(html,/PHT/);assert.match(html,/AMOUNT APPLIED<\/span><span>₱75\.00/);assert.match(html,/BALANCE DUE<\/span><span>₱0\.00/);assert.doesNotMatch(html,/TENDERED|CHANGE|₱40\.00|₱15\.00/);assert.match(html,/QA saved customer/);
}));
test('paid receipt without prior credit still labels canonical allocated payment truthfully',async()=>withReceipt({prior:0,tendered:100},async({record,receipt,checkout})=>{
 assert.equal(checkout.totalPaidNow,75);assert.equal(checkout.change,25);const html=render(record,receipt);assert.match(html,/AMOUNT APPLIED<\/span><span>₱75\.00/);assert.doesNotMatch(html,/TENDERED|CHANGE|₱100\.00/);
}));
test('voided receipt retains original charges/waiver and separates prepaid refund pending from allocated zero',async()=>withReceipt({void:true,prior:50},async({record,receipt})=>{
 assert.equal(receipt.total_amount,0);assert.equal(receipt.amount_paid,0);assert.equal(receipt.refund_due,50);const html=render(record,receipt);assert.match(html,/VOIDED.*QA incorrect session/);assert.match(html,/DISCOUNT \/ WAIVER<\/span><span>₱75\.00/);assert.match(html,/AMOUNT APPLIED<\/span><span>₱0\.00/);assert.match(html,/REFUND PENDING RETURN<\/span><span>₱50\.00/);assert.doesNotMatch(html,/TENDERED|CHANGE|Settled/);
}));
test('prepaid overage and recorded refund return stay distinct after actual refund audit and receipt reload',async()=>withReceipt({prior:100,tendered:0},async({record,receipt,call})=>{
 assert.equal(receipt.amount_paid,75);assert.equal(receipt.refund_due,25);assert.match(render(record,receipt),/REFUND PENDING RETURN<\/span><span>₱25\.00/);
 const result=await call(`/api/e-receipts/${receipt.id}/refund-return`,{requestId:'qa_history_return',expectedActorId:'qa_history_admin',expectedRefundDueCents:2500,method:'cash',reason:'QA already returned outside app',acknowledgedReturned:true});assert.equal(result.status,200);assert.equal(result.body.fundsTransferred,false);
 const reloaded=await call('/api/e-receipts/'+receipt.id);assert.equal(reloaded.body.refund_due,25);assert.equal(reloaded.body.refund_status,'returned');const html=render(record,reloaded.body);assert.match(html,/REFUND RECORDED RETURNED<\/span><span>₱25\.00/);assert.doesNotMatch(html,/REFUND PENDING RETURN|TENDERED|CHANGE/);
}));
test('canonical F&B totals survive missing or inconsistent archived item details',async()=>withReceipt({prior:50,tendered:50,orders:[{id:'water',name:'QA water',price:25,qty:1}]},async({record,receipt})=>{
 assert.equal(receipt.fnb_charge,25);assert.match(render(record,receipt),/FOOD &amp; DRINK<\/span><span>₱25\.00/);assert.match(render(record,receipt),/QA water/);
 const html=render({...record,orders:[{id:'x',name:'QA wrong item',price:99,qty:1}]},receipt);assert.match(html,/FOOD &amp; DRINK<\/span><span>₱25\.00/);assert.doesNotMatch(html,/QA wrong item|₱99\.00/);
}));
test('missing legacy receipt or loading/error state only shows labelled history values without inventing refund/cash',()=>{
 const record={id:'legacy',source:'table_session',totalAmount:75,amountPaid:100,status:'refund_pending'};
 for(const state of ['missing','loading','error']){const html=render(record,null,state);assert.match(html,/RECORDED BILL<\/span><span>₱75\.00/);assert.match(html,/RECORDED PAID<\/span><span>₱100\.00/);assert.doesNotMatch(html,/TENDERED|CHANGE|₱25\.00|Saved receipt ·/);assert.match(html,/role="status"/);}
});
test('selected receipt read requires authentication, returns one record only, and foreign-session projections cannot expose it',async()=>withReceipt({},async({f,record,receipt,call})=>{
 await f.run("INSERT INTO e_receipts(id,receipt_no,customer_name,table_name) VALUES('qa_other_private','QA-other','QA_OTHER_PRIVATE_PERSON','QA other table')");
 assert.equal((await call('/api/e-receipts/'+receipt.id,undefined,false)).status,401);const selected=await call('/api/e-receipts/'+receipt.id);assert.equal(selected.body.id,receipt.id);assert.doesNotMatch(JSON.stringify(selected.body),/QA_OTHER_PRIVATE_PERSON/);assert.equal((await call('/api/e-receipts/qa_missing')).status,404);
 for(const patch of [{id:'qa_other_private'},{table_id:'other-table'},{customer_name:'QA_OTHER_PRIVATE_PERSON'},{play_start_time:new Date(0).toISOString()},{play_end_time:new Date(0).toISOString()}]){const html=render(record,{...receipt,...patch,total_amount:999});assert.match(html,/could not be verified/);assert.doesNotMatch(html,/QA_OTHER_PRIVATE_PERSON|₱999\.00|Saved receipt ·/);}
}));

test('projection preserves saved session times and duration while null duration stays unavailable instead of being estimated',async()=>withReceipt({},async({record,receipt})=>{
 const {projectHistoryReceipt}=await import('../src/app/utils/historyReceiptProjection.js');const projected=projectHistoryReceipt(record,receipt);assert.equal(projected.startTime,receipt.play_start_time);assert.equal(projected.endTime,receipt.play_end_time);assert.equal(projected.durationMinutes,receipt.duration_minutes);
 const missing=render(record,{...receipt,duration_minutes:null});assert.match(missing,/DURATION: Unavailable/);assert.match(missing,/START:/);assert.match(missing,/END:/);
 for(const duration of [-1,1.5,'10',Infinity])assert.match(render(record,{...receipt,duration_minutes:duration}),/could not be verified/);
 for(const patch of [{play_start_time:null},{play_end_time:null},{play_start_time:'invalid'}])assert.match(render(record,{...receipt,...patch}),/could not be verified/);
 const legacy=render({...record,durationMinutes:10},null,'missing');assert.match(legacy,/RECORDED START:/);assert.match(legacy,/RECORDED END:/);assert.match(legacy,/RECORDED DURATION: 10 mins/);
}));
