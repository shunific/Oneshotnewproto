import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isValidPhone, submitFeedback, readPendingFeedback, clearPendingFeedback } from './feedbackSubmission.js';
const user = { id: '11111111-1111-4111-8111-111111111111', email_confirmed_at: '2026-10-19T00:00:00Z' };
const feedback = { customerName: ' QA Customer ', contactInfo: '09123456789', comment: ' Test message ', feedbackType: 'suggestion' };
const saved = { id: '22222222-2222-4222-8222-222222222222', customer_user_id: user.id, status: 'pending', date: '2026-10-19T00:00:00Z' };
function storage() { const rows = new Map(); return { get length() { return rows.size; }, key: index => [...rows.keys()][index], getItem: key => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key) }; }
function client(rpc, account = user) { return { auth: { getUser: async () => ({ data: { user: account } }) }, rpc, from: () => assert.fail('Direct feedback table access is forbidden') }; }

test('feedback rejects short numbers and accepts Philippine mobile formats', () => {
  for (const phone of ['123', '', '091234567890', '08123456789', null]) assert.equal(isValidPhone(phone), false);
  for (const phone of ['09123456789', '639123456789', '+639123456789']) assert.equal(isValidPhone(phone), true);
});
test('invalid feedback makes no database request', async () => {
  const api = client(() => assert.fail('Invalid input was submitted'));
  for (const changes of [{ contactInfo: '123' }, { customerName: ' ' }, { comment: ' ' }, { feedbackType: 'invalid' }, { contactInfo: 'qa@example.test' }, { comment: 'x'.repeat(4001) }, { customerName: 'x'.repeat(121) }]) await assert.rejects(submitFeedback(api, { ...feedback, ...changes }, { storage: storage() }));
});
test('confirmed feedback uses authenticated RPC and returns server acknowledgement only', async () => {
  let calls = 0;
  const api = client(async (name, { payload }) => {
    calls++; assert.equal(name, 'oneshot_feedback_create'); assert.equal(payload.customerName, 'QA Customer'); assert.equal(payload.comment, 'Test message');
    assert.equal(payload.expectedCustomerId, user.id); assert.match(payload.requestId, /^[a-f0-9-]{36}$/);
    for (const key of ['status', 'date', 'notes', 'tags', 'customer_user_id', 'customer_email']) assert.equal(Object.hasOwn(payload, key), false);
    return { data: { feedback: saved } };
  });
  assert.deepEqual(await submitFeedback(api, feedback, { storage: storage() }), saved); assert.equal(calls, 1);
});
test('booking issue reports may use the signed-in customer email', async () => {
  const api = client(async () => ({ data: { feedback: saved } }));
  assert.deepEqual(await submitFeedback(api, { ...feedback, contactInfo: 'qa@example.test', reservationId: 'QA123' }, { allowEmail: true, storage: storage() }), saved);
});
test('denied feedback saves reject without a fallback write', async () => {
  let calls = 0; const store = storage();
  await assert.rejects(submitFeedback(client(async () => { calls++; return { error: { code: '42501', message: 'Permission denied' } }; }), feedback, { storage: store }));
  assert.equal(calls, 1); assert.equal(store.length, 0);
});
test('guest feedback requires verified sign-in even when contact and message are valid', async () => {
  await assert.rejects(submitFeedback(client(() => assert.fail('Guest RPC was sent'), null), feedback, { storage: storage() }), /verified customer/);
});
test('anonymous and unverified accounts cannot send feedback', async () => {
  for (const account of [{ ...user, is_anonymous: true }, { ...user, email_confirmed_at: null }]) await assert.rejects(submitFeedback(client(() => assert.fail('Unverified RPC was sent'), account), feedback, { storage: storage() }), /verified customer/);
});
test('a lost acknowledgement persists the same request ID across same-tab reload retry', async () => {
  const store = storage(); const ids = [];
  const api = client(async (_, { payload }) => { ids.push(payload.requestId); if (ids.length === 1) throw new Error('Connection lost after commit'); return { data: { feedback: saved, replayed: true } }; });
  await assert.rejects(submitFeedback(api, feedback, { storage: store }), /unknown/);
  const pending = readPendingFeedback(store, user.id); assert.ok(pending);
  assert.deepEqual(await submitFeedback(api, pending.input, { storage: store, retry: true }), saved);
  assert.equal(ids[0], ids[1]); assert.equal(store.length, 0);
});
test('a pending unknown result blocks changed feedback before another dispatch', async () => {
  let calls = 0; const store = storage(); const api = client(async () => { calls++; throw new Error('Timeout'); });
  await assert.rejects(submitFeedback(api, feedback, { storage: store }));
  await assert.rejects(submitFeedback(api, { ...feedback, comment: 'Changed' }, { storage: store }), /previous feedback/);
  assert.equal(calls, 1);
});
test('missing, foreign, malformed or non-pending acknowledgements cannot report success', async () => {
  for (const response of [null, { ...saved, id: 'bad' }, { ...saved, customer_user_id: 'foreign' }, { ...saved, date: null }, { ...saved, status: 'resolved' }]) {
    const store = storage(); await assert.rejects(submitFeedback(client(async () => ({ data: { feedback: response } })), feedback, { storage: store }), /not confirmed/);
    assert.ok(readPendingFeedback(store, user.id));
  }
});
test('storage failure prevents an unrecoverable feedback request from being sent', async () => {
  const store = storage(); store.setItem = () => { throw new Error('Storage unavailable'); };
  await assert.rejects(submitFeedback(client(() => assert.fail('RPC sent without retry record')), feedback, { storage: store }), /Storage unavailable/);
});
test('account changes before dispatch reject old-form feedback', async () => {
  await assert.rejects(submitFeedback(client(() => assert.fail('Old account form sent')), feedback, { storage: storage(), expectedOwnerId: 'other-owner' }), /account changed/);
});
test('in-flight account changes clear private retry drafts for success and lost responses', async () => {
  for (const lost of [false, true]) {
    let active = true, resolve, reject; const store = storage();
    const pending = submitFeedback(client(() => new Promise((done, fail) => { resolve = done; reject = fail; })), feedback, { storage: store, isCurrentOwner: () => active });
    await new Promise(done => setTimeout(done, 0)); assert.ok(readPendingFeedback(store, user.id)); active = false; clearPendingFeedback(store);
    if (lost) reject(new Error('Lost response')); else resolve({ data: { feedback: saved } });
    await assert.rejects(pending); assert.equal(store.length, 0);
  }
});
test('auth changes clear only private feedback drafts and preserve current-owner reload drafts', () => {
  const store = storage(); store.setItem(`oneshot_pending_feedback_v1:${user.id}`, '{}'); store.setItem('oneshot_pending_feedback_v1:other', '{}'); store.setItem('unrelated', 'keep');
  clearPendingFeedback(store, user.id); assert.equal(store.length, 2); clearPendingFeedback(store); assert.equal(store.length, 1);
});
test('client metadata, status, notes, owner and tags cannot enter trusted command', async () => {
  for (const key of ['rating', 'tags', 'status', 'date', 'notes', 'customer_user_id', 'customer_email']) await assert.rejects(submitFeedback(client(() => assert.fail('Forged fields sent')), { ...feedback, [key]: 'forged' }, { storage: storage() }), /Unsupported/);
});
test('server transport errors retain retry identity; definitive quota rejection releases it', async () => {
  for (const [error, remains] of [[{ code: 'PGRST301', message: 'Expired JWT' }, true], [{ code: 'P0001', message: 'FEEDBACK_RATE_LIMIT' }, false], [{ message: 'Upstream unavailable' }, true]]) {
    const store = storage(); await assert.rejects(submitFeedback(client(async () => ({ error })), feedback, { storage: store })); assert.equal(!!readPendingFeedback(store, user.id), remains);
  }
});
test('malformed private retry records fail closed before dispatch', async () => {
  const store = storage(); store.setItem(`oneshot_pending_feedback_v1:${user.id}`, JSON.stringify({ ownerId: user.id, requestId: 'bad', input: feedback }));
  await assert.rejects(submitFeedback(client(() => assert.fail('Malformed draft sent')), feedback, { storage: store }), /Pending feedback/);
});


test('late duplicate feedback responses cannot erase a newer pending message', async () => {
 for(const outcome of ['success','definitive','authchange','lost']) {
  const store=storage(), waits=[];let current=true;
  const api=client(()=>new Promise((resolve,reject)=>waits.push({resolve,reject})));
  const first=submitFeedback(api,feedback,{storage:store,isCurrentOwner:()=>current});
  await new Promise(done=>setTimeout(done,0));
  const duplicate=submitFeedback(api,feedback,{storage:store,retry:true,isCurrentOwner:()=>current});
  await new Promise(done=>setTimeout(done,0));
  waits[0].resolve({data:{feedback:saved}});await first;
  const newRecord={ownerId:user.id,requestId:crypto.randomUUID(),input:{customerName:'QA Customer',contactInfo:feedback.contactInfo,feedbackType:'suggestion',comment:'New message'}};
  store.setItem(`oneshot_pending_feedback_v1:${user.id}`,JSON.stringify(newRecord));
  if(outcome==='authchange')current=false;
  if(outcome==='lost') { current=false; waits[1].reject(Error('Lost ACK')); }
  else waits[1].resolve(outcome==='definitive'?{error:{code:'P0001',message:'REJECTED'}}:{data:{feedback:saved}});
  await assert.rejects(duplicate);
  assert.deepEqual(readPendingFeedback(store,user.id),newRecord);
 }
});
