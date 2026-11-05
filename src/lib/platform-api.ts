/**
 * Client helper for the platform (super admin) API.
 *
 * Deliberatly separate from `api.ts`: the platform session has its own cookie
 * and its own CSRF token, so a restaurant staff session and a platform session
 * can coexist in one browser without either one weakening the other.
 */
import { PLATFORM_CSRF_COOKIE } from "@/lib/session-keys";

export class PlatformApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "PlatformApiError";
  }
}

function readPlatformCsrf(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PLATFORM_CSRF_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(PLATFORM_CSRF_COOKIE.length + 1)) : "";
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  if (method !== "GET") {
    const csrf = readPlatformCsrf();
    if (csrf) headers["x-platform-csrf-token"] = csrf;
  }

  const response = await fetch(`/api/platform/${path.replace(/^\/+/, "")}`, {
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
    throw new PlatformApiError(response.status, message);
  }
  return parsed as T;
}

export const platformApi = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
};

export function platformErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
