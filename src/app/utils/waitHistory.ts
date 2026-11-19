export type ReservationHistory = { status: string; durationHours?: number | string };

export function completedReservationStats(reservations: ReservationHistory[]) {
  const minutes = reservations
    .filter(row => row.status === 'completed')
    .map(row => Number(row.durationHours) * 60)
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const count = minutes.length;
  const middle = Math.floor(count / 2);
  const typicalBookedMinutes = count ? (minutes[middle] + minutes[Math.floor((count - 1) / 2)]) / 2 : null;
  return { count, typicalBookedMinutes };
}

export function openTimeRemaining(startTime: Date | string, now: Date, typicalMinutes: number) {
  const elapsed = Math.max(0, (now.getTime() - new Date(startTime).getTime()) / 60000);
  return elapsed < typicalMinutes ? Math.ceil(typicalMinutes - elapsed) : 30;
}
