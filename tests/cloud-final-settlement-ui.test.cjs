const test=require('node:test'),assert=require('node:assert/strict');
const esbuild=require('esbuild'),Module=require('node:module'),path=require('node:path');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const filename=path.resolve(__dirname,'cloud-final-summary.compiled.cjs');
const code=esbuild.buildSync({entryPoints:[path.resolve(__dirname,'../src/app/components/CloudStaffAccess.tsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',external:['react','react/jsx-runtime']}).outputFiles[0].text;
const compiled=new Module(filename,module);compiled.filename=filename;compiled.paths=module.paths;compiled._compile(code,filename);
const render=r=>renderToStaticMarkup(React.createElement(compiled.exports.CloudBookingAmounts,{reservation:r}));
const booking={tableId:'QA table',status:'completed',total_amount_cents:20100,paymentSummary:{verifiedPaidCents:4020,remainingCents:16080}};
const final=extra=>({originalVerifiedBookingCreditCents:4020,nativeCollectedNowCents:0,grandTotalCents:0,remainingCents:0,refundDueCents:4020,allocation:'voided',...extra});
test('a void displays its final zero bill and original refund without presenting the legacy booking balance as collectible',()=>{
 const html=render({...booking,settlement:final()});assert.match(html,/Voided session/);assert.match(html,/Balance at checkout ₱0\.00/);assert.match(html,/Refund due at checkout ₱40\.20/);assert.doesNotMatch(html,/160\.80|Booking balance/);assert.match(html,/Verified booking payments ₱40\.20/);
});
test('a partially settled final bill distinguishes checkout debt from immutable booking credit and POS collection',()=>{
 const html=render({...booking,settlement:final({allocation:'unallocated-partial',grandTotalCents:22600,nativeCollectedNowCents:100,remainingCents:18480,refundDueCents:0})});
 assert.match(html,/Total ₱226\.00/);assert.match(html,/Collected at checkout ₱1\.00/);assert.match(html,/Balance at checkout ₱184\.80/);assert.match(html,/Payment allocation requires review/);assert.match(html,/Verified booking payments ₱40\.20/);assert.doesNotMatch(html,/160\.80/);
});
test('completed rows with missing or malformed final data require reconciliation instead of inventing a payable balance',()=>{
 for(const settlement of [undefined,final({remainingCents:-1}),final({grandTotalCents:'0'}),final({allocation:'refunded'})]){
  const html=render({...booking,settlement});assert.match(html,/Final session bill needs reconciliation/);assert.doesNotMatch(html,/160\.80|Booking balance/);
 }
});
test('active bookings retain their authoritative original booking balance',()=>{
 const html=render({...booking,status:'confirmed'});assert.match(html,/Booking balance ₱160\.80/);assert.doesNotMatch(html,/Final session bill|Balance at checkout/);
});
