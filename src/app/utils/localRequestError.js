const messages = {
  CLOUD_NOT_CONFIGURED: 'Cloud access is not configured on this device. Ask an administrator to connect it, then retry the original action.',
  NATIVE_MOVE_NOT_STARTED: 'This transfer did not start. Refresh the tables and choose an available destination.',
  NATIVE_MOVE_TABLE_HELD: 'This table is held by an unconfirmed transfer. Resolve the original transfer in Table Monitor first.',
  NATIVE_MOVE_CANCEL_PENDING: 'Cancellation is already pending. Retry its original cancellation in Table Monitor.',
  NATIVE_MOVE_ALREADY_COMMITTED: 'The session has already moved. Retry the original transfer to confirm it.',
  NATIVE_DELIVERY_ACCOUNT_CHANGED: 'Your staff session changed. Sign in again and recover the original action.',
  NATIVE_DELIVERY_RECONCILIATION_REQUIRED: 'The saved action needs reconciliation. Keep the original request and ask an administrator to review it.',
  NATIVE_MOVE_RECONCILIATION_REQUIRED: 'The saved transfer needs reconciliation. Keep the original request and ask an administrator to review it.',
};
export function localRequestError(status, response) {
  const fallback = status === 401 ? 'Your staff session has ended. Sign in again before retrying.'
    : status === 403 ? 'This account cannot perform this action. Ask an authorized staff member to review it.'
    : status === 400 ? 'The request could not be accepted. Review the entered values before retrying.'
    : status === 404 ? 'This record is no longer available. Refresh before continuing.'
    : status === 409 ? 'This record changed or needs recovery. Refresh its current state and retry the original unconfirmed action.'
    : 'The save could not be confirmed. Keep the original action and retry when the local service is available.';
  const code = typeof response?.code === 'string' ? response.code : '';
  return Object.assign(new Error(Object.hasOwn(messages, code) ? messages[code] : fallback), { status, response });
}
