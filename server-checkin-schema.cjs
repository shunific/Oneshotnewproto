const checkinDefinitions = [
      ['native_checkin_device', 'CREATE TABLE IF NOT EXISTS native_checkin_device (singleton INTEGER PRIMARY KEY CHECK(singleton=1), device_id TEXT NOT NULL UNIQUE)'],
      ['native_checkin_operations', `CREATE TABLE IF NOT EXISTS native_checkin_operations (
      request_id TEXT PRIMARY KEY, local_staff_id TEXT NOT NULL, cloud_user_id TEXT NOT NULL,
      device_id TEXT NOT NULL, reservation_id TEXT NOT NULL UNIQUE, table_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL, request_json TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('prepared','claimed','admitted')),
      claim_id TEXT UNIQUE, claim_json TEXT, admission_fingerprint TEXT, response_json TEXT,
      created_at TEXT NOT NULL,
      CHECK((phase='prepared' AND claim_id IS NULL AND claim_json IS NULL AND admission_fingerprint IS NULL AND response_json IS NULL)
        OR (phase='claimed' AND claim_id IS NOT NULL AND claim_json IS NOT NULL AND admission_fingerprint IS NULL AND response_json IS NULL)
        OR (phase='admitted' AND claim_id IS NOT NULL AND claim_json IS NOT NULL AND admission_fingerprint IS NOT NULL AND response_json IS NOT NULL)))`],
      ['native_checkin_outbox', `CREATE TABLE IF NOT EXISTS native_checkin_outbox (
      event_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, claim_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type='admission'), payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL, delivered_at TEXT)`],
    ];
const normalizeSql = sql => sql.replace(' IF NOT EXISTS', '').replace(/\s+/g, ' ').trim();
module.exports = { checkinDefinitions, normalizeSql };
