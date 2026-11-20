import { EXTENSION_DECISION_MINUTES } from '../../../session-billing.mjs';

export function readTableAvailability(tables, pendingMoves, recoveryError = '') {
  const heldTableIds = new Set(pendingMoves.flatMap(move => [move.sourceId, move.targetId]));
  const availableTables = recoveryError ? [] : tables.filter(table => table.isActive && table.status === 'available' && table.session == null && !heldTableIds.has(table.id));
  return { heldTableIds, availableTables };
}

export function isOvertimeTable(table) {
  const session = table.session;
  if (!table.isActive || table.status !== 'occupied' || !session) return false;
  if (session.isOpenTime || session.durationMinutes === null) return true;
  const overtimeStarts = new Date(session.startTime).getTime()
    + session.durationMinutes * 60_000
    + EXTENSION_DECISION_MINUTES * 60_000;
  return Date.now() > overtimeStarts;
}
