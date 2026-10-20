const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const moduleSource = fs.readFileSync(
  require("node:path").join(
    __dirname,
    "../src/app/utils/cloudStaffPersistence.js",
  ),
  "utf8",
);
const loaded = () =>
  import(
    "data:text/javascript;base64," +
      Buffer.from(moduleSource).toString("base64")
  );
const storage = () => {
  const values = new Map();
  return {
    getItem: (k) => values.get(k) || null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
    key: (i) => [...values.keys()][i],
    get length() {
      return values.size;
    },
  };
};
const input = {
  requestId: "request-QA",
  id: "booking-QA",
  expectedStaffId: "cloud-QA",
  expectedAmountCents: 6000,
  expectedRevision: 1,
  paymentKind: "deposit",
};
const ack = {
  reservation: { id: "booking-QA", revision: 2 },
  verification: {
    id: "verification-QA",
    actorUserId: "cloud-QA",
    amountCents: 6000,
    paymentKind: "deposit",
    recordType: "external-payment-verification",
    fundsTransferred: false,
  },
};
test("lost payment acknowledgement preserves original request and confirmed retry clears it", async () => {
  const m = await loaded(),
    s = storage();
  await assert.rejects(
    m.confirmCloudPayment(
      async () => {
        throw Error("Lost");
      },
      s,
      "local",
      "cloud-QA",
      input,
    ),
  );
  assert.equal(
    m.pendingCloudPayment(s, "local", "cloud-QA").requestId,
    input.requestId,
  );
  let sent;
  await m.confirmCloudPayment(
    async (value) => {
      sent = value;
      return ack;
    },
    s,
    "local",
    "cloud-QA",
    input,
  );
  assert.deepEqual(sent, input);
  assert.equal(s.length, 0);
});
test("changed payload, unavailable storage and invalid acknowledgement never confirm payment", async () => {
  const m = await loaded(),
    s = storage();
  await assert.rejects(
    m.confirmCloudPayment(async () => ({}), s, "local", "cloud-QA", input),
  );
  await assert.rejects(
    m.confirmCloudPayment(
      async () => assert.fail("Sent changed operation"),
      s,
      "local",
      "cloud-QA",
      { ...input, expectedAmountCents: 1 },
    ),
  );
  const broken = storage();
  broken.setItem = () => {
    throw Error("Storage failed");
  };
  await assert.rejects(
    m.confirmCloudPayment(
      async () => assert.fail("Sent unrecoverable operation"),
      broken,
      "local",
      "cloud-QA",
      input,
    ),
  );
});
test("wrong actor, amount, revision or money-transfer claim leaves verification pending", async () => {
  const m = await loaded();
  for (const value of [
    { ...ack, verification: { ...ack.verification, actorUserId: "other" } },
    { ...ack, verification: { ...ack.verification, amountCents: 1 } },
    { ...ack, reservation: { ...ack.reservation, revision: 1 } },
    { ...ack, verification: { ...ack.verification, fundsTransferred: true } },
  ]) {
    const s = storage();
    await assert.rejects(
      m.confirmCloudPayment(async () => value, s, "local", "cloud-QA", input),
    );
    assert.equal(s.length, 1);
  }
});
test("account switch cannot retain private pending state or accept an old response", async () => {
  const m = await loaded(),
    s = storage();
  let active = true;
  await assert.rejects(
    m.confirmCloudPayment(
      async () => {
        active = false;
        m.clearCloudPaymentDrafts(s);
        return ack;
      },
      s,
      "local",
      "cloud-QA",
      input,
      () => active,
    ),
  );
  assert.equal(s.length, 0);
});
const approvalInput = {
  requestId: "approval-QA",
  id: "booking-zero",
  expectedStaffId: "cloud-QA",
  expectedRevision: 1,
  expectedTotalCents: 30000,
  expectedDownPaymentCents: 0,
};
const approvalAck = {
  reservation: {
    id: "booking-zero",
    revision: 2,
    status: "confirmed",
    total_amount_cents: 30000,
    down_payment_amount_cents: 0,
    downPaymentPaid: 0,
    balancePaid: 0,
    balancepaid: 0,
    paymentSummary: { verifiedPaidCents: 0, remainingCents: 30000 },
  },
  approval: {
    id: "approval-ledger-QA",
    actorUserId: "cloud-QA",
    actorRole: "cashier",
    recordType: "no-payment-due-approval",
    fundsTransferred: false,
  },
};
test("zero-deposit approval retries across reload without inventing payment and blocks another operation", async () => {
  const m = await loaded(),
    s = storage();
  await assert.rejects(
    m.approveCloudBooking(
      async () => {
        throw Error("Lost ACK");
      },
      s,
      "local",
      "cloud-QA",
      approvalInput,
    ),
  );
  const retry = m.pendingCloudPayment(s, "local", "cloud-QA");
  assert.deepEqual(retry, approvalInput);
  await assert.rejects(
    m.confirmCloudPayment(
      async () => assert.fail("Sent during pending approval"),
      s,
      "local",
      "cloud-QA",
      input,
    ),
  );
  await m.approveCloudBooking(
    async (sent) => {
      assert.deepEqual(sent, approvalInput);
      return approvalAck;
    },
    s,
    "local",
    "cloud-QA",
    retry,
  );
  assert.equal(s.length, 0);
});
test("approval cannot accept a payment ACK, changed finances, false paid flags or wrong actor", async () => {
  const m = await loaded();
  for (const value of [
    ack,
    {
      ...approvalAck,
      reservation: { ...approvalAck.reservation, total_amount_cents: 1 },
    },
    {
      ...approvalAck,
      reservation: { ...approvalAck.reservation, downPaymentPaid: 1 },
    },
    {
      ...approvalAck,
      reservation: {
        ...approvalAck.reservation,
        paymentSummary: { verifiedPaidCents: 1, remainingCents: 29999 },
      },
    },
    {
      ...approvalAck,
      approval: { ...approvalAck.approval, actorUserId: "other" },
    },
    {
      ...approvalAck,
      approval: { ...approvalAck.approval, fundsTransferred: true },
    },
  ]) {
    const s = storage();
    await assert.rejects(
      m.approveCloudBooking(
        async () => value,
        s,
        "local",
        "cloud-QA",
        approvalInput,
      ),
    );
    assert.deepEqual(
      m.pendingCloudPayment(s, "local", "cloud-QA"),
      approvalInput,
    );
  }
});
test("free approval acknowledges zero total and account switches discard private drafts", async () => {
  const m = await loaded(),
    s = storage();
  const free = { ...approvalInput, expectedTotalCents: 0 };
  const result = {
    ...approvalAck,
    reservation: {
      ...approvalAck.reservation,
      total_amount_cents: 0,
      paymentSummary: { verifiedPaidCents: 0, remainingCents: 0 },
    },
  };
  await m.approveCloudBooking(async () => result, s, "local", "cloud-QA", free);
  assert.equal(s.length, 0);
  let active = true;
  await assert.rejects(
    m.approveCloudBooking(
      async () => {
        active = false;
        m.clearCloudPaymentDrafts(s);
        return result;
      },
      s,
      "local",
      "cloud-QA",
      free,
      () => active,
    ),
  );
  assert.equal(s.length, 0);
  await assert.rejects(
    m.approveCloudBooking(
      async () => assert.fail("Sent nonzero deposit"),
      s,
      "local",
      "cloud-QA",
      { ...free, expectedDownPaymentCents: 1 },
    ),
  );
});
test("account adoption prunes other private drafts while preserving its own reload retry", async () => {
  const m = await loaded(),
    s = storage();
  const keep = m.cloudPaymentKey("local", "cloud-QA");
  s.setItem(keep, JSON.stringify(approvalInput));
  s.setItem(m.cloudPaymentKey("local", "other-cloud"), "private old draft");
  s.setItem("unrelated-setting", "keep");
  m.clearCloudPaymentDrafts(s, keep);
  assert.deepEqual(
    m.pendingCloudPayment(s, "local", "cloud-QA"),
    approvalInput,
  );
  assert.equal(s.getItem(m.cloudPaymentKey("local", "other-cloud")), null);
  assert.equal(s.getItem("unrelated-setting"), "keep");
});
test("stale approval completion cannot erase a newer same-account operation", async () => {
  const m = await loaded(),
    s = storage();
  const newer = { ...approvalInput, requestId: "newer-QA" };
  let current = true;
  await assert.rejects(
    m.approveCloudBooking(
      async () => {
        current = false;
        s.setItem(
          m.cloudPaymentKey("local", "cloud-QA"),
          JSON.stringify(newer),
        );
        return approvalAck;
      },
      s,
      "local",
      "cloud-QA",
      approvalInput,
      () => current,
    ),
  );
  assert.deepEqual(m.pendingCloudPayment(s, "local", "cloud-QA"), newer);
});

test("navigation during an unknown approval preserves the original request for later retry", async () => {
  const m = await loaded(),
    s = storage();
  let mounted = true;
  await assert.rejects(
    m.approveCloudBooking(
      async () => {
        mounted = false;
        throw Error("Network interrupted after leaving settings");
      },
      s,
      "local",
      "cloud-QA",
      approvalInput,
      () => mounted,
    ),
  );
  assert.deepEqual(
    m.pendingCloudPayment(s, "local", "cloud-QA"),
    approvalInput,
  );
  await m.approveCloudBooking(
    async () => approvalAck,
    s,
    "local",
    "cloud-QA",
    approvalInput,
  );
  assert.equal(s.length, 0);
});
