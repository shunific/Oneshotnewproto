"""Read-only verification of the explicitly isolated RC7 synthetic fixture."""
import json
import sqlite3
from pathlib import Path

native = Path(__file__).resolve().parent.parent
base = native.parent
fixture = json.loads((base / 'native-integrity-qa-fixture-20261019.json').read_text())
folder = Path(fixture['userData'])
assert folder.name.startswith('oneshot-integrity-qa-') and fixture['port'] == 31375
out = native / 'output/playwright'
proof = json.loads((out / 'rc7-integrity-all-proof.json').read_text())
legacy = json.loads((out / 'rc7-integrity-legacy-intervention.json').read_text())
replay = proof['qa_rc7_checkout_replay']['replay']
receipt = replay['receipt']
db = sqlite3.connect('file:' + str(folder / 'oneshot.db') + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
rows = lambda sql, args=(): [dict(row) for row in db.execute(sql, args)]
assert rows('SELECT * FROM e_receipts WHERE customer_name=?', ('QA RC7 Integrity TEST ONLY',))[0]['id'] == receipt['id']
assert len(rows('SELECT * FROM e_receipts WHERE customer_name=?', ('QA RC7 Integrity TEST ONLY',))) == 1
assert len(rows('SELECT * FROM session_history WHERE id=?', (receipt['id'],))) == 1
assert len(rows('SELECT * FROM checkout_operations WHERE request_id=?', (replay['requestId'],))) == 1
payments = rows('SELECT * FROM session_payments WHERE session_start=?', (receipt['play_start_time'],))
assert len(payments) == 1 and payments[0]['amount'] == 150
ops = rows('SELECT * FROM session_state_operations WHERE session_start=?', (receipt['play_start_time'],))
assert len(ops) == 2
assert not rows("SELECT * FROM session_state_operations WHERE request_id LIKE 'qa_rc7_invalid_%'")
assert rows('SELECT stock FROM inventory WHERE id=?', ('qa_release_drink',))[0]['stock'] == 4
assert all(row['status'] == 'available' and row['sessionData'] is None for row in rows('SELECT * FROM tables WHERE id IN (?,?)', ('qa_release_table', 'qa_overtime_target')))
assert rows('SELECT response_json FROM checkout_operations WHERE request_id=?', (legacy['requestId'],))[0]['response_json'] == legacy['originalResponseRaw']
assert len(rows('SELECT id FROM e_receipts WHERE id=?', ('6e60e2dd-1ebe-4830-b8f9-3bcc44e341dd',))) == 1
assert receipt['table_charge'] * 100 + receipt['overtime_charge'] * 100 + receipt['fnb_charge'] * 100 == receipt['total_amount'] * 100 == 32500
assert replay['totalPaidNow'] == receipt['total_amount'] - replay['alreadyPaid'] == 175
assert replay['change'] == replay['tendered'] - replay['totalPaidNow'] == 325
assert all(result['status'] == 409 for result in proof['qa_rc7_negative_proof']['statuses'])
assert proof['qa_rc7_order_proof']['changed']['status'] == 409 and proof['qa_rc7_order_proof']['exact']['status'] == 200
assert 'OVERTIME\n' in proof['qa_rc7_legacy_proof']['text'] and 'undefined' not in proof['qa_rc7_legacy_proof']['text']
db.close()
result = {'PASS': True, 'databaseMode': 'ro', 'totalCents': 32500, 'paidBeforeCents': 15000, 'paidNowCents': 17500, 'changeCents': 32500, 'exactlyOneReceiptHistoryCheckout': True, 'stock': 4, 'legacyOriginalResponseRestored': True, 'scope': 'Isolated synthetic packaged runtime only; no real funds or hosted acceptance'}
(out / 'rc7-integrity-parent-readonly-proof.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result))
