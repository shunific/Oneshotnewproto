// Synthetic local proof key only; never an enrolled owner key.
module.exports = {
  "command": {
    "requestId": "26de4712-a9e9-49c8-bb80-8d6104f7c9a1",
    "id": "QA-CHECKIN-1",
    "expectedRevision": 2,
    "expectedStaffId": "11111111-1111-4111-8111-111111111111",
    "deviceId": "55555555-5555-4555-8555-555555555555",
    "tableId": "LOCAL-1"
  },
  "result": {
    "claim": {
      "email": "owner@example.invalid",
      "state": "claim-pending",
      "claimId": "88007050-d3ca-4ae2-8657-a6ba72886baa",
      "tableId": "LOCAL-1",
      "deviceId": "55555555-5555-4555-8555-555555555555",
      "timeSlot": "23:59",
      "actorRole": "cashier",
      "partySize": 2,
      "requestId": "26de4712-a9e9-49c8-bb80-8d6104f7c9a1",
      "actorUserId": "11111111-1111-4111-8111-111111111111",
      "bookingDate": "2026-10-19",
      "ownerUserId": "33333333-3333-4333-8333-333333333333",
      "cloudTableId": "CLOUD-1",
      "customerName": "QA Owner",
      "claimRevision": 3,
      "contactNumber": "09123456789",
      "discountCents": 5000,
      "netTotalCents": 30000,
      "reservationId": "QA-CHECKIN-1",
      "sourceRevision": 2,
      "durationMinutes": 120,
      "grossTotalCents": 35000,
      "verifiedPaidCents": 6000,
      "requiredDepositCents": 6000
    },
    "replayed": false,
    "recordType": "reservation-check-in-claim",
    "fundsTransferred": false
  },
  "keyId": "77777777-7777-4777-8777-777777777777",
  "keyHex": "4242424242424242424242424242424242424242424242424242424242424242"
};
