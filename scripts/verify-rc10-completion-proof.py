"""Parent read-only reconciliation of packaged late-failure and retry evidence."""
import hashlib
import json
import sqlite3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root.parent / 'native-completion-qa-fixture-20261019.json').read_text())
folder = Path(manifest['userData'])
assert folder.name.startswith('oneshot-reservation-qa-')
artifacts = root / 'output/playwright'
recorded = json.loads((artifacts / 'rc10-completion-all-proof.json').read_text())
rollback = json.loads((artifacts / 'rc10-completion-rollback-readonly-proof.json').read_text())
assert rollback['counts'] == {'receipt': 0, 'history': 0, 'checkout': 0, 'completion': 0}
assert rollback['table']['status'] == 'occupied' and rollback['stock']['stock'] == 3
assert json.loads(rollback['table']['sessionData'])['amountPaid'] == 60
failure, recovery = recorded['qa_rc10_failure_proof'], recorded['qa_rc10_recovery_proof']
assert failure['status'] == 503
assert recovery['committed']['status'] == 200
committed, replay = recovery['committed']['body'], recovery['replay']
assert replay['replayed'] is True and committed['receipt']['id'] == replay['receipt']['id']
assert committed['requestId'] == replay['requestId'] == failure['request']['requestId']
assert committed['reservationCompletion'] == replay['reservationCompletion']
assert replay['reservationCompletion']['cloudAcknowledged'] is False
db = sqlite3.connect('file:' + str(folder / 'oneshot.db') + '?mode=ro', uri=True)
db.row_factory = sqlite3.Row
def rows(sql, args=()):
    return [dict(r) for r in db.execute(sql, args)]
events = rows('SELECT * FROM native_reservation_completion_outbox WHERE claim_id=?', (replay['receipt']['reservation_claim_id'],))
assert len(events) == 1
event = events[0]
assert event['delivered_at'] is None and event['event_id'] == replay['reservationCompletion']['eventId']
payload = json.loads(event['payload_json'])
canonical = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
assert hashlib.sha256(canonical.encode()).hexdigest() == event['payload_sha256']
assert payload['amounts'] == {'bookedGrossCents': 35000, 'bookingDiscountCents': 5000, 'bookedNetCents': 30000, 'overtimeCents': 0, 'foodAndDrinkCents': 2500, 'sessionWaiverCents': 0, 'totalCents': 32500, 'allocatedPaidCents': 32500, 'balanceCents': 0}
assert (payload['priorPaymentCents'], payload['collectedNowCents'], payload['tenderedCents'], payload['changeCents']) == (6000, 26500, 50000, 23500)
receipt = rows('SELECT * FROM e_receipts WHERE id=?', (event['receipt_id'],))
history = rows('SELECT * FROM session_history WHERE id=?', (event['receipt_id'],))
operation = rows('SELECT * FROM checkout_operations WHERE request_id=?', (replay['requestId'],))
assert len(receipt) == len(history) == len(operation) == 1
for key, value in payload['receipt'].items():
    assert receipt[0][key] == value, key
for key, value in payload['history'].items():
    assert (json.loads(history[0][key]) if key == 'orders' else history[0][key]) == value, key
assert json.loads(operation[0]['response_json']) == committed
claim = rows('SELECT * FROM native_checkin_operations WHERE claim_id=?', (event['claim_id'],))[0]
admission = rows('SELECT * FROM native_checkin_outbox WHERE request_id=?', (claim['request_id'],))
assert claim['phase'] == 'admitted' and len(admission) == 1
assert payload['admissionEventId'] == admission[0]['event_id']
assert payload['admissionLocalStaffId'] == claim['local_staff_id'] == payload['checkoutLocalStaffId']
assert payload['admissionCloudUserId'] == claim['cloud_user_id']
assert payload['deviceId'] == claim['device_id'] == event['device_id']
assert payload['reservationId'] == claim['reservation_id'] == event['reservation_id']
assert rows('SELECT stock FROM inventory WHERE id=?', ('qa_release_drink',))[0]['stock'] == 3
assert rows('SELECT status,sessionData FROM tables WHERE id=?', ('LOCAL-1',))[0] == {'status': 'available', 'sessionData': None}
assert not rows("SELECT name FROM sqlite_master WHERE type='trigger' AND name='qa_fail_completion'")
proof = {'PASS': True, 'scope': 'Independent read-only reconciliation of recorded actual packaged RC10 HTTP/SQLite failure and recovery', 'receiptId': event['receipt_id'], 'completionEventId': event['event_id'], 'checkoutRequestId': replay['requestId'], 'lateFailureRollback': True, 'sameRequestAfterFailureAndLostResponse': True, 'receiptHistoryCheckoutCompletionCounts': [1,1,1,1], 'stockAfter': 3, 'cloudAcknowledged': False, 'completionDelivered': False, 'liveWrites': False, 'limits': ['External admission Auth/RPC controlled; no public check-in, hosted completion/sync or real funds.']}
(artifacts / 'rc10-completion-parent-readonly-proof.json').write_text(json.dumps(proof, indent=2) + '\n')
db.close()
print(json.dumps(proof))
