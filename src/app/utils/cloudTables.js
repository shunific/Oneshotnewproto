export function hasTimedSession(session) {
  return !!session?.startTime && Number.isFinite(new Date(session.startTime).getTime())
    && Number.isFinite(Number(session.durationMinutes)) && Number(session.durationMinutes) > 0;
}

export function mapCloudTable(row) {
  const active = row.isActive ?? row.is_active ?? row.isactive;
  const rawSession = row.sessionData ?? row.session_data ?? row.sessiondata;
  let session;
  let invalidSession = false;
  try {
    session = typeof rawSession === 'string' ? JSON.parse(rawSession) : rawSession;
    invalidSession = session != null && (typeof session !== 'object' || Array.isArray(session));
  } catch {
    invalidSession = true;
  }
  return {
    ...row,
    isActive: active === true || active === 1 || active === 'true' || active === '1',
    status: invalidSession || (row.status === 'occupied' && !hasTimedSession(session)) ? 'maintenance' : row.status,
    session: invalidSession ? undefined : session ?? undefined,
  };
}
