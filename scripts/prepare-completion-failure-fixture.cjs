// QA-only fault injection; the target must be a separate synthetic database copy.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
async function main() {
  const base = path.resolve(__dirname, '../..');
  const fixture = JSON.parse(fs.readFileSync(path.join(base, 'native-completion-qa-fixture-20261019.json')));
  assert.ok(path.basename(fixture.userData).startsWith('oneshot-reservation-qa-'));
  const archive = path.resolve(process.argv[2]);
  const sqlite3 = require(path.join(archive, 'node_modules/sqlite3'));
  const { initializeCompletionSchema } = require(path.join(archive, 'server-reservation-completion.cjs'));
  const db = await new Promise((resolve,reject)=>{const c=new sqlite3.Database(path.join(fixture.userData,'oneshot.db'),sqlite3.OPEN_READWRITE,e=>e?reject(e):resolve(c));});
  await initializeCompletionSchema(db);
  await new Promise((resolve,reject)=>db.run("CREATE TRIGGER qa_fail_completion BEFORE INSERT ON native_reservation_completion_outbox BEGIN SELECT RAISE(ABORT,'QA synthetic completion disk failure'); END",e=>e?reject(e):resolve()));
  await new Promise(resolve=>db.close(resolve));
  console.log('Prepared one completion-insert failure trigger in the isolated RC10 QA copy.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
