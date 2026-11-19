export function readTableAvailability(tables, pendingMoves, recoveryError = '') {
  const heldTableIds = new Set(pendingMoves.flatMap(move => [move.sourceId, move.targetId]));
  const availableTables = recoveryError ? [] : tables.filter(table => table.isActive && table.status === 'available' && table.session == null && !heldTableIds.has(table.id));
  return { heldTableIds, availableTables };
}

export function isOvertimeTable(table) {
  const session = table.session;
  if (!table.isActive || table.status !== 'occupied' || !session) return false;
  if (session.isOpenTime || session.durationMinutes === null) return true;
  return Date.now() > new Date(session.startTime).getTime() + session.durationMinutes * 60_000;
}
