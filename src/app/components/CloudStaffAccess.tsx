import { NativeReservationAccess } from './NativeReservationAccess';
import { useEffect, useRef, useState } from "react";
import { localFetch } from "../utils/localApi";
import {
  confirmCloudPayment,
  approveCloudBooking,
  pendingCloudPayment,
  clearCloudPaymentDrafts,
  cloudPaymentKey,
} from "../utils/cloudStaffPersistence";

async function cloudRequest(path: string, body?: unknown) {
  const response = await localFetch(
    `http://localhost:3001/api/cloud/staff/${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(value.error || "Cloud request was not confirmed."),
      { status: response.status, code: value.code },
    );
  return value;
}
const money = (cents: number) =>
  Number.isSafeInteger(cents) && cents >= 0
    ? new Intl.NumberFormat("en-PH", {
        style: "currency",
        currency: "PHP",
      }).format(cents / 100)
    : "Needs reconciliation";
export function CloudBookingAmounts({ reservation: r }: { reservation: any }) {
  const final = r.settlement;
  const validFinal = final && ["full-bill-settled", "unallocated-partial", "voided"].includes(final.allocation) &&
    ["originalVerifiedBookingCreditCents", "nativeCollectedNowCents", "grandTotalCents", "remainingCents", "refundDueCents"].every(key => Number.isSafeInteger(final[key]) && final[key] >= 0);
  return <div className="text-neutral-400">
    <p>{r.tableId} · {r.status} · Booking quote {money(r.total_amount_cents)} · Verified booking payments {money(r.paymentSummary?.verifiedPaidCents)}</p>
    {r.status === "completed" ? validFinal ? <p>
      {final.allocation === "voided" ? "Voided session" : "Final session bill"} · Total {money(final.grandTotalCents)} · Collected at checkout {money(final.nativeCollectedNowCents)} · Balance at checkout {money(final.remainingCents)} · Refund due at checkout {money(final.refundDueCents)}
      {final.allocation === "unallocated-partial" && " · Payment allocation requires review"}
    </p> : <p>Final session bill needs reconciliation.</p> : <p>Booking balance {money(r.paymentSummary?.remainingCents)}</p>}
  </div>;
}

export function CloudStaffAccess({ localStaffId }: { localStaffId: string }) {
  const [status, setStatus] = useState<any>(null),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState("");
  const [rows, setRows] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [selected, setSelected] = useState<any>(null),
    [kind, setKind] = useState("deposit"),
    [method, setMethod] = useState("gcash"),
    [reference, setReference] = useState(""),
    [checked, setChecked] = useState(false),
    [pending, setPending] = useState<any>(null);
  const [receipt, setReceipt] = useState<string | null>(null),
    generation = useRef(0),
    identity = useRef<string | null>(null),
    imageUrl = useRef<string | null>(null),
    mounted = useRef(true);
  const revokeImage = () => {
    if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    imageUrl.current = null;
    setReceipt(null);
  };
  const adopt = (value: any) => {
    const next = value.connected ? value.identity?.userId : null;
    if (identity.current !== next) {
      clearCloudPaymentDrafts(
        sessionStorage,
        next ? cloudPaymentKey(localStaffId, next) : null,
      );
      generation.current++;
      setRows([]);
      setSelected(null);
      setReference("");
      setChecked(false);
      revokeImage();
    }
    identity.current = next;
    setStatus(value);
    setPending(
      next ? pendingCloudPayment(sessionStorage, localStaffId, next) : null,
    );
  };
  useEffect(() => {
    let stopped = false;
    mounted.current = true;
    setBusy(false);
    void cloudRequest("status")
      .then((v) => {
        if (!stopped) adopt(v);
      })
      .catch((e) => {
        if (!stopped) showError(e);
      });
    return () => {
      stopped = true;
      mounted.current = false;
      generation.current++;
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    };
  }, [localStaffId]);
  const showError = (e: any) => {
    if (e.status === 403) {
      adopt({ configured: true, connected: false });
      clearCloudPaymentDrafts(sessionStorage);
    }
    setMessage(e.message);
  };
  const load = async () => {
    const current = generation.current;
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Manila",
    });
    const date = new Date();
    date.setDate(date.getDate() + 30);
    const end = date.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
    const result = await cloudRequest(`reservations?from=${today}&to=${end}`);
    if (current === generation.current) setRows(result.reservations);
  };
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const value = await cloudRequest("connect", { email, password });
      setPassword("");
      adopt(value);
      await load();
    } catch (e: any) {
      setPassword("");
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await cloudRequest("disconnect", {});
      adopt({ configured: true, connected: false });
      clearCloudPaymentDrafts(sessionStorage);
      setMessage(
        result.remoteRevocationConfirmed
          ? "Cloud session disconnected."
          : "Disconnected on this device. Remote sign-out was not confirmed; review active sessions before using a shared device.",
      );
    } catch (e: any) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  const due = selected
    ? kind === "deposit"
      ? Math.max(
          0,
          selected.down_payment_amount_cents -
            (selected.paymentSummary?.verifiedPaidCents || 0),
        )
      : selected.paymentSummary?.remainingCents
    : null;
  const submit = async (input: any) => {
    const account = identity.current,
      epoch = generation.current;
    if (!account) return;
    const isCurrent = () =>
      mounted.current &&
      identity.current === account &&
      generation.current === epoch;
    let handledError = false;
    setBusy(true);
    setMessage("");
    try {
      const approval = Object.hasOwn(input, "expectedTotalCents");
      await (approval ? approveCloudBooking : confirmCloudPayment)(
        (p: any) => cloudRequest(approval ? "approvals" : "payments", p),
        sessionStorage,
        localStaffId,
        account,
        input,
        isCurrent,
      );
      setSelected(null);
      setChecked(false);
      setReference("");
      await load();
      if (!isCurrent()) return;
      setMessage(
        approval
          ? "Booking approved with no deposit due. Any remaining balance is still unpaid."
          : "Payment verification recorded. This app did not transfer any money.",
      );
    } catch (e: any) {
      if (isCurrent()) {
        handledError = true;
        showError(e);
      }
    } finally {
      if (
        isCurrent() ||
        (mounted.current && handledError && identity.current === null)
      )
        setBusy(false);
      if (
        mounted.current &&
        identity.current === account &&
        generation.current === epoch
      ) {
        setPending(pendingCloudPayment(sessionStorage, localStaffId, account));
      }
    }
  };
  const viewReceipt = async (id: string) => {
    if (busy) return;
    setBusy(true);
    const epoch = generation.current;
    try {
      const response = await localFetch(
        `http://localhost:3001/api/cloud/staff/receipt?id=${encodeURIComponent(id)}`,
      );
      if (!response.ok) {
        const error = await response.json();
        throw Object.assign(new Error(error.error || "Receipt unavailable."), {
          status: response.status,
          code: error.code,
        });
      }
      const blob = await response.blob();
      if (epoch !== generation.current) return;
      revokeImage();
      imageUrl.current = URL.createObjectURL(blob);
      setReceipt(imageUrl.current);
    } catch (e: any) {
      showError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="space-y-4 rounded-2xl border border-neutral-800 bg-neutral-950 p-5">
      <h3 className="text-lg font-bold text-white">Cloud staff access</h3>
      <p className="text-sm text-neutral-400">
        Connect your approved One Shot cloud staff account to review online
        bookings and record payments you have verified. Local POS access and
        cloud staff approval are separate.
      </p>
      {message && (
        <p role="alert" className="text-sm text-amber-300">
          {message}
        </p>
      )}
      {status?.configured === false ? (
        <p className="text-sm text-amber-300">
          Cloud staff access is not configured on this device. Ask the release
          owner to complete the secure cloud setup.
        </p>
      ) : !status?.connected ? (
        <form onSubmit={connect} className="space-y-3">
          <label className="block text-sm">
            Cloud staff email
            <input
              aria-label="Cloud staff email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
              className="mt-1 w-full rounded bg-neutral-800 p-2"
            />
          </label>
          <label className="block text-sm">
            Cloud staff password
            <input
              aria-label="Cloud staff password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="mt-1 w-full rounded bg-neutral-800 p-2"
            />
          </label>
          <button
            disabled={busy || !status}
            className="rounded bg-emerald-700 px-4 py-2 disabled:opacity-50"
          >
            {busy ? "Connecting…" : "Connect cloud account"}
          </button>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>
              {status.identity.email} · {status.identity.role}
            </span>
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void load()
                  .catch(showError)
                  .finally(() => setBusy(false));
              }}
              className="rounded border border-neutral-700 px-3 py-2"
            >
              Refresh online bookings
            </button>
            <button disabled={busy} onClick={disconnect} className="underline">
              Disconnect
            </button>
          </div>
          {pending && (
            <div
              role="alert"
              className="rounded border border-amber-700 p-3 text-sm text-amber-300"
            >
              A staff operation is unconfirmed. Retry the same request before
              recording another payment or approval.{" "}
              <button
                disabled={busy}
                onClick={() => submit(pending)}
                className="underline"
              >
                Retry pending verification
              </button>
            </div>
          )}
          <NativeReservationAccess key={`${localStaffId}:${status.identity.userId}`} localStaffId={localStaffId} cloudUserId={status.identity.userId} reservations={rows} onRefreshBookings={load} onAccountError={showError} />
          <p className="text-xs text-neutral-500">
            Online check-in and final session status use the recovery controls above. Refund transfers are recorded outside this app.
          </p>
          <div className="space-y-3">
            {rows.map((r) => (
              <article
                key={r.id}
                className="rounded-xl border border-neutral-800 p-4 text-sm"
              >
                <p className="font-semibold">
                  {r.customerName} · {r.date} {r.timeSlot}
                </p>
                <CloudBookingAmounts reservation={r} />
                <div className="mt-2 flex gap-3">
                  <button
                    disabled={busy}
                    onClick={() => viewReceipt(r.id)}
                    className="underline"
                  >
                    Review private receipt
                  </button>
                  {r.status === "pending" &&
                    r.down_payment_amount_cents === 0 &&
                    Number.isSafeInteger(r.total_amount_cents) &&
                    r.total_amount_cents >= 0 &&
                    r.paymentSummary?.verifiedPaidCents === 0 && (
                      <button
                        disabled={busy || !!pending}
                        className="underline disabled:opacity-40"
                        onClick={() => {
                          setSelected(r);
                          setKind("approval");
                          setChecked(false);
                        }}
                      >
                        Approve booking (no deposit due)
                      </button>
                    )}
                  <button
                    disabled={
                      busy ||
                      !!pending ||
                      !["pending", "confirmed"].includes(r.status) ||
                      !Number.isSafeInteger(r.total_amount_cents)
                    }
                    onClick={() => {
                      setSelected(r);
                      setKind("deposit");
                      setReference("");
                      setChecked(false);
                    }}
                    className="underline disabled:opacity-40"
                  >
                    Record verified payment
                  </button>
                </div>
              </article>
            ))}
          </div>
          {selected && (
            <form
              className="space-y-3 rounded-xl border border-neutral-700 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!checked || busy || pending) return;
                if (kind === "approval") {
                  void submit({
                    requestId: crypto.randomUUID(),
                    id: selected.id,
                    expectedRevision: selected.revision,
                    expectedStaffId: identity.current,
                    expectedTotalCents: selected.total_amount_cents,
                    expectedDownPaymentCents: 0,
                  });
                  return;
                }
                if (!Number.isSafeInteger(due) || due < 1) return;
                void submit({
                  requestId: crypto.randomUUID(),
                  id: selected.id,
                  expectedRevision: selected.revision,
                  paymentKind: kind,
                  method,
                  reference,
                  expectedAmountCents: due,
                  expectedStaffId: identity.current,
                });
              }}
            >
              <h4 className="font-semibold">
                {kind === "approval"
                  ? "Approve booking for"
                  : "Verify payment for"}{" "}
                {selected.customerName}
              </h4>
              {kind === "approval" ? (
                <p>
                  No deposit is due. Approving confirms this booking without
                  recording a payment. Remaining balance:{" "}
                  {money(selected.total_amount_cents)}.
                </p>
              ) : (
                <>
                  <label className="block text-sm">
                    Payment portion
                    <select
                      aria-label="Payment portion"
                      value={kind}
                      onChange={(e) => {
                        setKind(e.target.value);
                        setChecked(false);
                      }}
                      className="ml-2 bg-neutral-800 p-2"
                    >
                      <option value="deposit">Deposit</option>
                      <option value="balance">Remaining balance</option>
                    </select>
                  </label>
                  <label className="block text-sm">
                    Payment method
                    <select
                      aria-label="Payment method"
                      value={method}
                      onChange={(e) => setMethod(e.target.value)}
                      className="ml-2 bg-neutral-800 p-2"
                    >
                      <option value="gcash">GCash</option>
                      <option value="cash">Cash</option>
                    </select>
                  </label>
                  <label className="block text-sm">
                    Payment reference
                    <input
                      aria-label="Payment reference"
                      required={method === "gcash"}
                      maxLength={120}
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      className="ml-2 rounded bg-neutral-800 p-2"
                    />
                  </label>
                  <p>Amount to verify: {money(due)}</p>
                </>
              )}
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                {kind === "approval"
                  ? "I reviewed this booking and approve it with no deposit due. Any balance remains unpaid."
                  : "I checked the payment outside this app and verified this amount was received."}
              </label>
              <div className="flex gap-3">
                <button
                  disabled={
                    busy ||
                    !checked ||
                    (kind !== "approval" &&
                      (!Number.isSafeInteger(due) || due < 1)) ||
                    !!pending
                  }
                  className="rounded bg-emerald-700 px-3 py-2 disabled:opacity-40"
                >
                  {kind === "approval"
                    ? "Approve booking"
                    : "Record verification"}
                </button>
                <button type="button" onClick={() => setSelected(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {receipt && (
        <div
          role="dialog"
          aria-label="Private payment receipt"
          className="space-y-2 rounded-xl border border-neutral-700 p-3"
        >
          <button onClick={revokeImage} className="underline">
            Close receipt
          </button>
          <img
            src={receipt}
            alt="Private payment evidence"
            className="max-h-96 max-w-full"
          />
        </div>
      )}
    </section>
  );
}
