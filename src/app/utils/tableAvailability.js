export function readTableAvailability(tables, pendingMoves, recoveryError = '') {
  const heldTableIds = new Set(pendingMoves.flatMap(move => [move.sourceId, move.targetId]));
  const availableTables = recoveryError ? [] : tables.filter(table => table.isActive && table.status === 'available' && table.session == null && !heldTableIds.has(table.id));
  return { heldTableIds, availableTables };
}
