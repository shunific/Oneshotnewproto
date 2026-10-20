export async function sendPasswordReset(client, email, redirectTo) {
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}

export function assertBookingSnapshot(current, expectedKey) {
  if (!current.ready || !expectedKey || current.key !== expectedKey) {
    throw new Error('Booking availability or rates changed. Refresh and review the booking before submitting.');
  }
}
