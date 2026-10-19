"""Read-only reconciliation of the isolated RC8 cashier acceptance fixture."""
import json
import sqlite3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
base = root.parent
manifest = json.loads((base / 'native-reservation-qa-fixture-20261019.json').read_text())
folder = Path(manifest['userData'])
assert folder.name.startswith('oneshot-reservation-qa-')
runtime = json.loads((root / 'output/playwright/rc8-reservation-all-proof.json').read_text())
observed = runtime['qa_rc8_checkout_proof']
replay = observed['replay']
receipt_id = replay['receipt']['id']
db = sqlite3.connect('file:' + str(folder / 'oneshot.db') + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row

def rows(sql, args=()):
    return [dict(row) for row in db.execute(sql, args)]

receipt = rows('SELECT * FROM e_receipts WHERE id=?', (receipt_id,))
assert len(receipt) == 1
receipt = receipt[0]
for key, value in {'table_charge': 350, 'fnb_charge': 25, 'subtotal': 375,
                   'booking_discount_amount': 50, 'discount_amount': 50,
                   'total_amount': 325, 'amount_paid': 325, 'balance_due': 0,
                   'table_rate': None, 'pricing_version': 2,
                   'reservation_id': 'QA-CHECKIN-1',
                   'reservation_claim_id': runtime['qa_rc8_config']['admittedSession']['reservationPricing']['claimId'],
                   'owner_user_id': '33333333-3333-4333-8333-333333333333',
                   'customer_email': 'owner@example.invalid', 'customer_phone': '09123456789'}.items():
    assert receipt[key] == value, (key, receipt[key], value)
assert len(rows('SELECT id FROM e_receipts WHERE reservation_id=?', ('QA-CHECKIN-1',))) == 1
history = rows('SELECT * FROM session_history WHERE id=?', (receipt_id,))
assert len(history) == 1 and history[0]['totalAmount'] == 325 and history[0]['amountPaid'] == 325
assert rows('SELECT stock FROM inventory WHERE id=?', ('qa_release_drink',))[0]['stock'] == 3
table = rows('SELECT status,sessionData FROM tables WHERE id=?', ('LOCAL-1',))[0]
assert table == {'status': 'available', 'sessionData': None}
operation = rows('SELECT * FROM checkout_operations WHERE request_id=?', (replay['requestId'],))
assert len(operation) == 1
claim = rows('SELECT * FROM native_checkin_operations WHERE reservation_id=?', ('QA-CHECKIN-1',))
assert len(claim) == 1 and claim[0]['phase'] == 'admitted'
outbox = rows('SELECT * FROM native_checkin_outbox WHERE request_id=?', (claim[0]['request_id'],))
assert len(outbox) == 1 and outbox[0]['event_type'] == 'admission' and outbox[0]['delivered_at'] is None
assert replay['replayed'] is True
assert replay['alreadyPaid'] == 60 and replay['totalPaidNow'] == 265
assert replay['tendered'] == 500 and replay['change'] == 235
assert observed['final']['pending'] == [] and observed['final']['errors'] == []
proof = {'PASS': True, 'scope': 'Read-only SQLite + recorded actual packaged RC8 browser acceptance',
         'receiptId': receipt_id, 'reservationId': receipt['reservation_id'],
         'subtotal': 375, 'bookingDiscount': 50, 'netTotal': 325,
         'priorPayment': 60, 'collectedNow': 265, 'tendered': 500, 'change': 235,
         'receiptRows': 1, 'historyRows': 1, 'checkoutOperations': 1,
         'stockAfter': 3, 'tableAvailable': True, 'admissionEvents': 1,
         'cloudAcknowledged': False, 'liveWrites': False,
         'limits': ['Synthetic isolated fixture; no hosted sync, cloud ACK, public admission or real funds.']}
(root / 'output/playwright/rc8-reservation-parent-readonly-proof.json').write_text(json.dumps(proof, indent=2) + '\n')
db.close()
print(json.dumps(proof))
