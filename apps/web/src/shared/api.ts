export class ApiError extends Error {
  constructor(public code: string, message: string, public details: any = {}, public status = 0) { super(message); }
}

export async function api<T = any>(method: string, path: string, body?: unknown, sessionToken?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api/v1' + path, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(sessionToken ? { 'X-Session-Token': sessionToken } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('NETWORK', 'Cannot reach the server. Please check the internet connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(e?.code ?? 'ERROR', e?.message ?? 'Something went wrong. Please try again.', e?.details, res.status);
  }
  return data as T;
}
export const get = <T = any>(p: string, t?: string) => api<T>('GET', p, undefined, t);
export const post = <T = any>(p: string, b: unknown = {}, t?: string) => api<T>('POST', p, b, t);
export const patch = <T = any>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>('PUT', p, b);
