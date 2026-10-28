let sessionEpoch = 0;
export const localFetch: typeof fetch = async (input, init) => {
  let target = input;
  if (typeof target === 'string') {
    if (target.startsWith('http://localhost:3001/') || target.startsWith('http://127.0.0.1:3001/')) {
      target = target.replace(/^http:\/\/(?:localhost|127\.0\.0\.1):3001/, '');
    }
  }
  const requestEpoch = sessionEpoch;
  const response = await fetch(target, { ...init, credentials: 'include' });
  if (response.status === 401 && requestEpoch === sessionEpoch && !String(target).includes('/api/auth/')) {
    window.dispatchEvent(new Event('oneshot-session-ended'));
  }
  return response;
};

export async function authRequest(path: string, payload?: unknown) {
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  const response = await localFetch(`/api/auth/${cleanPath}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  if (response.ok && ['login', 'logout', 'change-password', 'recover'].includes(cleanPath)) sessionEpoch++;
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Authentication request failed.'), { status: response.status });
  return data;
}
