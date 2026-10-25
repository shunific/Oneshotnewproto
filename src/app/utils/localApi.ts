let sessionEpoch = 0;
export const localFetch: typeof fetch = async (input, init) => {
  if (typeof input === 'string' && input.startsWith('http://localhost:3001/') && ['localhost', '127.0.0.1'].includes(window.location.hostname) && window.location.port !== '5173') input = window.location.origin + input.slice('http://localhost:3001'.length);
  const requestEpoch = sessionEpoch;
  const response = await fetch(input, { ...init, credentials: 'include' });
  if (response.status === 401 && requestEpoch === sessionEpoch && !String(input).includes('/api/auth/')) window.dispatchEvent(new Event('oneshot-session-ended'));
  return response;
};

export async function authRequest(path: string, payload?: unknown) {
  const response = await localFetch(`http://localhost:3001/api/auth/${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  if (response.ok && ['login', 'logout', 'change-password', 'recover'].includes(path)) sessionEpoch++;
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Authentication request failed.'), { status: response.status });
  return data;
}
