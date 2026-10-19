const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createCloudStaffService,
  PROJECT_URL,
} = require("../server-cloud-staff.cjs");
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
const identity = (id = A) => ({
  userId: id,
  venueId: "oneshot",
  role: "cashier",
  email: `${id}@example.invalid`,
});
const response = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
function fixture(overrides = {}) {
  const calls = [];
  let active = true,
    time = 0;
  const api = {
    enabled: true,
    key: "sb_publishable_" + "x".repeat(30),
    isLocalSessionActive: async () => active,
    now: () => time,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.ok(url.startsWith(PROJECT_URL + "/"));
      assert.equal(init.redirect, "error");
      if (overrides.fetchImpl) return overrides.fetchImpl(url, init, calls);
      if (url.includes("/auth/v1/token"))
        return response({
          access_token: "ACCESS_PRIVATE",
          refresh_token: "REFRESH_PRIVATE",
          expires_in: 3600,
        });
      if (url.endsWith("/oneshot_staff_identity")) return response(identity());
      if (url.includes("/logout")) return response({});
      if (url.endsWith("/oneshot_staff_reservations"))
        return response({ reservations: [] });
      throw Error("Unexpected cloud request");
    },
  };
  return {
    service: createCloudStaffService({
      ...api,
      ...Object.fromEntries(
        Object.entries(overrides).filter(([k]) => k !== "fetchImpl"),
      ),
    }),
    calls,
    setActive: (value) => (active = value),
    setTime: (value) => (time = value),
  };
}
async function connect(f, token = "local-A") {
  return f.service.connect(
    token,
    "staff@example.invalid",
    "existing-cloud-password",
  );
}
test("unconfigured or privileged-key configuration never sends cloud credentials", async () => {
  for (const config of [
    { enabled: false },
    { key: "sb_secret_unsafe" },
    {
      key:
        "a." +
        Buffer.from(JSON.stringify({ role: "service_role" })).toString(
          "base64url",
        ) +
        ".b",
    },
  ]) {
    const f = fixture(config);
    assert.equal((await f.service.status("local-A")).configured, false);
    await assert.rejects(connect(f), { code: "CLOUD_NOT_CONFIGURED" });
    assert.equal(f.calls.length, 0);
  }
});
test("cloud tokens remain behind local session and never appear in renderer response", async () => {
  const f = fixture();
  const result = await connect(f);
  assert.equal(result.identity.userId, A);
  assert.doesNotMatch(JSON.stringify(result), /ACCESS_PRIVATE|REFRESH_PRIVATE/);
  assert.equal((await f.service.status("local-B")).connected, false);
  assert.equal(
    (await f.service.reservations("local-A", "2026-10-19", "2026-11-19"))
      .reservations.length,
    0,
  );
  assert.ok(
    f.calls.some(
      (c) => c.init.headers.Authorization === "Bearer ACCESS_PRIVATE",
    ),
  );
  assert.equal(
    (await f.service.disconnect("local-A")).remoteRevocationConfirmed,
    true,
  );
  assert.equal((await f.service.status("local-A")).connected, false);
  assert.ok(f.calls.find((c) => c.url.includes("/logout?scope=local")));
});
test("a cloud customer cannot pass membership checks and failed login is locally scoped", async () => {
  const f = fixture({
    fetchImpl: async (url) =>
      url.includes("/token")
        ? response({
            access_token: "customer",
            refresh_token: "refresh",
            expires_in: 3600,
          })
        : url.includes("/logout")
          ? response({})
          : response({ message: "STAFF_REQUIRED" }, 403),
  });
  await assert.rejects(connect(f), { code: "CLOUD_SIGN_IN_REQUIRED" });
  assert.equal((await f.service.status("local-A")).connected, false);
});
test("local session ending during sign-in cannot install a cloud connection", async () => {
  let release;
  const gate = new Promise((done) => (release = done));
  const f = fixture({
    fetchImpl: async (url) => {
      if (url.includes("/token")) {
        await gate;
        return response({
          access_token: "a",
          refresh_token: "r",
          expires_in: 3600,
        });
      }
      return response(url.includes("/logout") ? {} : identity());
    },
  });
  const pending = connect(f);
  await new Promise(setImmediate);
  f.setActive(false);
  f.service.disposeSession("local-A");
  release();
  await assert.rejects(pending, { code: "LOCAL_SESSION_ENDED" });
  f.setActive(true);
  assert.equal((await f.service.status("local-A")).connected, false);
});
test("disconnect cancels an in-flight connect and concurrent connect cannot race identities", async () => {
  let release;
  const gate = new Promise((done) => (release = done));
  const f = fixture({
    fetchImpl: async (url) => {
      if (url.includes("/token")) {
        await gate;
        return response({
          access_token: "a",
          refresh_token: "r",
          expires_in: 3600,
        });
      }
      return response(url.includes("/logout") ? {} : identity());
    },
  });
  const first = connect(f);
  await new Promise(setImmediate);
  await assert.rejects(connect(f), { code: "CLOUD_CONNECT_BUSY" });
  await f.service.disconnect("local-A");
  release();
  await assert.rejects(first, { code: "CLOUD_ACCOUNT_CHANGED" });
  assert.equal((await f.service.status("local-A")).connected, false);
});
test("membership revocation removes the old connection without exposing cloud data", async () => {
  let revoked = false;
  const f = fixture({
    fetchImpl: async (url) =>
      url.includes("/token")
        ? response({ access_token: "a", refresh_token: "r", expires_in: 3600 })
        : url.includes("/logout")
          ? response({})
          : revoked
            ? response({}, 403)
            : response(identity()),
  });
  await connect(f);
  revoked = true;
  await assert.rejects(f.service.status("local-A"), {
    code: "CLOUD_SIGN_IN_REQUIRED",
  });
  assert.equal((await f.service.status("local-A")).connected, false);
});
test("stale forbidden response cannot disconnect a newer cloud account", async () => {
  let block = false,
    release;
  const gate = new Promise((done) => (release = done));
  let auths = 0;
  const f = fixture({
    fetchImpl: async (url, init) => {
      if (url.includes("/token"))
        return response({
          access_token: ++auths === 1 ? "old" : "new",
          refresh_token: "r",
          expires_in: 3600,
        });
      if (url.includes("/logout")) return response({});
      if (init.headers.Authorization === "Bearer old" && block) {
        await gate;
        return response({}, 403);
      }
      return response(
        identity(init.headers.Authorization === "Bearer old" ? A : B),
      );
    },
  });
  await connect(f);
  block = true;
  const stale = f.service.status("local-A");
  await new Promise(setImmediate);
  await connect(f);
  release();
  await assert.rejects(stale);
  assert.equal((await f.service.status("local-A")).identity.userId, B);
});
test("expired cloud tokens refresh once while concurrent callers retain the same identity", async () => {
  let refreshes = 0;
  const f = fixture({
    fetchImpl: async (url) => {
      if (url.includes("grant_type=refresh_token")) {
        refreshes++;
        await new Promise(setImmediate);
        return response({
          access_token: "fresh",
          refresh_token: "new-refresh",
          expires_in: 3600,
        });
      }
      if (url.includes("/token"))
        return response({
          access_token: "old",
          refresh_token: "refresh",
          expires_in: 60,
        });
      return response(identity());
    },
  });
  await connect(f);
  f.setTime(40000);
  await Promise.all([f.service.status("local-A"), f.service.status("local-A")]);
  assert.equal(refreshes, 1);
});
test("refresh cannot silently replace the staff account", async () => {
  const f = fixture({
    fetchImpl: async (url, init) =>
      url.includes("/token")
        ? response({
            access_token: url.includes("refresh_token") ? "other" : "old",
            refresh_token: "r",
            expires_in: 60,
          })
        : url.includes("/logout")
          ? response({})
          : response(
              identity(init.headers.Authorization === "Bearer other" ? B : A),
            ),
  });
  await connect(f);
  f.setTime(40000);
  await assert.rejects(f.service.status("local-A"), {
    code: "CLOUD_ACCOUNT_CHANGED",
  });
  assert.equal((await f.service.status("local-A")).connected, false);
});
test("payment input fields and expected actor are checked before financial RPC dispatch", async () => {
  const f = fixture();
  await connect(f);
  const input = {
    requestId: crypto.randomUUID(),
    id: "QA",
    expectedRevision: 1,
    paymentKind: "deposit",
    method: "cash",
    expectedAmountCents: 6000,
    expectedStaffId: A,
  };
  await assert.rejects(
    f.service.confirm("local-A", { ...input, totalAmount: 0 }),
    { code: "INVALID_PAYMENT_VERIFICATION" },
  );
  await assert.rejects(
    f.service.confirm("local-A", { ...input, expectedStaffId: B }),
    { code: "CLOUD_ACCOUNT_CHANGED" },
  );
  assert.ok(
    !f.calls.some((c) => c.url.endsWith("oneshot_staff_confirm_payment")),
  );
});
test("network errors remain unknown and untrusted cloud error bodies are not returned", async () => {
  const f = fixture({
    fetchImpl: async () => {
      throw Error("PRIVATE upstream diagnostic");
    },
  });
  await assert.rejects(
    connect(f),
    (error) =>
      error.code === "CLOUD_UNAVAILABLE" && !error.message.includes("PRIVATE"),
  );
  const g = fixture({
    fetchImpl: async () =>
      response({ message: "PRIVATE arbitrary server text" }, 500),
  });
  await assert.rejects(
    connect(g),
    (error) => !error.message.includes("PRIVATE"),
  );
});
test("oversized JSON responses are rejected while streaming", async () => {
  const f = fixture({
    fetchImpl: async () => new Response("x".repeat(4 * 1024 * 1024 + 1)),
  });
  await assert.rejects(connect(f), { code: "CLOUD_RESPONSE_INVALID" });
});
test("private receipt lookup rejects external URLs and never follows them", async () => {
  const f = fixture({
    fetchImpl: async (url) =>
      url.includes("/token")
        ? response({ access_token: "a", refresh_token: "r", expires_in: 3600 })
        : url.endsWith("oneshot_staff_receipt")
          ? response({
              reservationId: "QA",
              path: "https://private.invalid/secret",
            })
          : response(identity()),
  });
  await connect(f);
  await assert.rejects(f.service.receipt("local-A", "QA"), {
    code: "PRIVATE_RECEIPT_REQUIRED",
  });
  assert.ok(!f.calls.some((c) => c.url.includes("private.invalid")));
});
test("booking approval uses fixed trusted RPC with exact staff and zero-deposit confirmation", async () => {
  const f = fixture({
    fetchImpl: async (url, init) => {
      if (url.includes("/token"))
        return response({
          access_token: "ACCESS_PRIVATE",
          refresh_token: "REFRESH_PRIVATE",
          expires_in: 3600,
        });
      if (url.endsWith("/oneshot_staff_identity")) return response(identity());
      if (url.endsWith("/oneshot_staff_approve_booking"))
        return response({ accepted: JSON.parse(init.body).payload });
      throw Error("Unexpected request");
    },
  });
  await connect(f);
  const p = {
    requestId: "33333333-3333-4333-8333-333333333333",
    id: "booking-zero",
    expectedRevision: 1,
    expectedStaffId: A,
    expectedTotalCents: 30000,
    expectedDownPaymentCents: 0,
  };
  assert.deepEqual((await f.service.approve("local-A", p)).accepted, p);
  for (const bad of [
    { ...p, expectedDownPaymentCents: 1 },
    { ...p, expectedTotalCents: -1 },
    { ...p, expectedTotalCents: 240000001 },
    { ...p, id: "" },
    { ...p, expectedRevision: 0 },
    { ...p, paymentKind: "deposit" },
    { ...p, expectedStaffId: B },
  ])
    await assert.rejects(f.service.approve("local-A", bad));
  assert.equal(
    f.calls.filter((c) => c.url.endsWith("/oneshot_staff_approve_booking"))
      .length,
    1,
  );
  f.setActive(false);
  await assert.rejects(f.service.approve("local-A", p), {
    code: "LOCAL_SESSION_ENDED",
  });
});

test('private native actor generation changes on same-user reconnect and cannot revive after disconnect',async()=>{
 const f=fixture();await connect(f);const first=await f.service.resolveNativeActor('local-A');
 assert.equal(first.cloudUserId,A);assert.ok(Number.isSafeInteger(first.generation));assert.equal(f.service.isNativeActorCurrent('local-A',first),true);
 await connect(f);const second=await f.service.resolveNativeActor('local-A');assert.notEqual(second.generation,first.generation);assert.equal(f.service.isNativeActorCurrent('local-A',first),false);
 await f.service.disconnect('local-A');assert.equal(f.service.isNativeActorCurrent('local-A',second),false);
 await connect(f);const third=await f.service.resolveNativeActor('local-A');assert.ok(third.generation>second.generation);assert.equal(f.service.isNativeActorCurrent('local-A',second),false);
 f.service.disposeSession('local-A');assert.equal(f.service.isNativeActorCurrent('local-A',third),false);
});
test('token refresh keeps one logical actor generation but expiry and local logout invalidate its fast guard',async()=>{
 const f=fixture();await connect(f);const before=await f.service.resolveNativeActor('local-A');
 f.setTime(3580000);const after=await f.service.resolveNativeActor('local-A');assert.deepEqual(after,before);assert.equal(f.service.isNativeActorCurrent('local-A',before),true);
 f.setTime(7200000);assert.equal(f.service.isNativeActorCurrent('local-A',before),false);
 f.setTime(3580000);f.setActive(false);await assert.rejects(f.service.resolveNativeActor('local-A'),{code:'LOCAL_SESSION_ENDED'});assert.equal(f.service.isNativeActorCurrent('local-A',before),false);
});
