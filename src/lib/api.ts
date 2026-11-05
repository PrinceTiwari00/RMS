/**
 * Client API helper.
 *
 * Every URL is relative: the app is served behind a proxy in the preview, so a
 * hardcoded `localhost` origin would break. Mutating calls carry the
 * double-submit CSRF token read from the non-httpOnly cookie.
 */
import { CSRF_COOKIE } from "@/lib/session-keys";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function readCsrf(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CSRF_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(CSRF_COOKIE.length + 1)) : "";
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (method !== "GET") {
    const csrf = readCsrf();
    if (csrf) headers["x-csrf-token"] = csrf;
  }

  const response = await fetch(`/api/${path.replace(/^\/+/, "")}`, {
    method,
    headers,
    body: payload,
    credentials: "same-origin",
    cache: "no-store",
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text.slice(0, 200) };
    }
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `Request failed (${response.status})`;
    throw new ApiError(response.status, message);
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body ?? {}),
};

/** Turn a params object into a query string, dropping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}
