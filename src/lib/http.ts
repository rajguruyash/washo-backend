/** Thin fetch wrapper for the WASHO API. Same-origin, cookie session, JSON in/out. */

export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, any>;
  constructor(status: number, code: string, message: string, details?: Record<string, any>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  /** Field-level validation messages from the server, if any. */
  get fields(): Record<string, string> {
    return (this.details?.fields as Record<string, string>) ?? {};
  }
}

type Listener = () => void;
const unauthListeners = new Set<Listener>();
/** Called whenever the API says the session is gone, so the UI can drop to the login screen. */
export const onUnauthenticated = (fn: Listener) => {
  unauthListeners.add(fn);
  return () => {
    unauthListeners.delete(fn);
  };
};

export async function request<T = any>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', "We couldn't reach WASHO. Check your connection and try again.");
  }

  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }

  if (!res.ok) {
    const err = new ApiError(res.status, data?.code ?? 'error', data?.message ?? 'Something went wrong. Please try again.', data?.details);
    if (res.status === 401 && err.code === 'unauthenticated') unauthListeners.forEach((fn) => fn());
    throw err;
  }
  return data as T;
}

export const get = <T = any>(path: string) => request<T>('GET', path);
export const post = <T = any>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
export const put = <T = any>(path: string, body?: unknown) => request<T>('PUT', path, body);
export const del = <T = any>(path: string) => request<T>('DELETE', path);
