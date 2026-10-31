const PREFIX = "oneshot_cloud_staff_pending:";
export function cloudPaymentKey(localId, cloudId) {
  return `${PREFIX}${localId}:${cloudId}`;
}
export function clearCloudPaymentDrafts(storage, keepKey = null) {
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key?.startsWith(PREFIX) && key !== keepKey) storage.removeItem(key);
  }
}
export function pendingCloudPayment(storage, localId, cloudId) {
  const raw = storage.getItem(cloudPaymentKey(localId, cloudId));
  if (!raw) return null;
  const value = JSON.parse(raw);
  if (
    value.expectedStaffId !== cloudId ||
    typeof value.requestId !== "string" ||
    typeof value.id !== "string" ||
    !(isApproval(value)
      ? Number.isSafeInteger(value.expectedTotalCents) &&
        value.expectedTotalCents >= 0 &&
        value.expectedDownPaymentCents === 0
      : Number.isSafeInteger(value.expectedAmountCents) &&
        value.expectedAmountCents > 0)
  )
    throw new Error(
      "Pending payment verification needs review. Refresh cloud bookings before continuing.",
    );
  return value;
}
const isApproval = (input) => Object.hasOwn(input, "expectedTotalCents");
async function confirmCloudOperation(
  request,
  storage,
  localId,
  cloudId,
  input,
  isCurrent = () => true,
) {
  if (!isCurrent() || input.expectedStaffId !== cloudId)
    throw new Error("Cloud staff account changed.");
  const key = cloudPaymentKey(localId, cloudId),
    old = pendingCloudPayment(storage, localId, cloudId);
  if (old && JSON.stringify(old) !== JSON.stringify(input))
    throw new Error(
      "Retry the pending verification before recording another payment.",
    );
  const serialized = JSON.stringify(input);
  const clearOwnDraft = () => {
    if (storage.getItem(key) === serialized) storage.removeItem(key);
  };
  storage.setItem(key, serialized);
  let result;
  try {
    result = await request(input);
  } catch (error) {
    if (isCurrent() && (error.status === 400 || error.status === 409))
      clearOwnDraft();
    throw error;
  }
  if (!isCurrent()) {
    throw new Error(
      "Cloud staff account changed. Refresh the original account to review the result.",
    );
  }
  const v = isApproval(input) ? result?.approval : result?.verification,
    r = result?.reservation;
  if (
    !r ||
    r.id !== input.id ||
    !Number.isSafeInteger(r.revision) ||
    r.revision <= input.expectedRevision ||
    !v?.id ||
    v.actorUserId !== cloudId ||
    (isApproval(input)
      ? v.recordType !== "no-payment-due-approval" ||
        r.status !== "confirmed" ||
        r.total_amount_cents !== input.expectedTotalCents ||
        r.down_payment_amount_cents !== 0 ||
        r.paymentSummary?.verifiedPaidCents !== 0 ||
        r.paymentSummary?.remainingCents !== input.expectedTotalCents ||
        r.downPaymentPaid !== 0 ||
        r.balancePaid !== 0 ||
        r.balancepaid !== 0
      : v.amountCents !== input.expectedAmountCents ||
        v.paymentKind !== input.paymentKind ||
        v.recordType !== "external-payment-verification") ||
    v.fundsTransferred !== false
  )
    throw new Error(
      "Payment verification result is unknown. Retry the same request before recording another payment.",
    );
  clearOwnDraft();
  return result;
}

export async function confirmCloudPayment(...args) {
  if (isApproval(args[4])) throw new Error("Use the booking approval action.");
  return confirmCloudOperation(...args);
}
export async function approveCloudBooking(...args) {
  if (!isApproval(args[4]) || args[4].expectedDownPaymentCents !== 0)
    throw new Error("A zero deposit is required for booking approval.");
  return confirmCloudOperation(...args);
}
