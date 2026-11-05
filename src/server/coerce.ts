/**
 * Request coercion helpers.
 *
 * Handlers receive an untyped JSON body and URLSearchParams. Rather than
 * sprinkling `Number(body.x)` across the registry — which silently turns a
 * missing field into NaN and writes it to the database — every field goes
 * through here, where a malformed value becomes a 400 with a useful message.
 */
import { badRequest } from "@/server/router";

type Body = Record<string, unknown>;

export function has(body: Body, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined;
}

/** String field. Empty/missing becomes the fallback. */
export function str(body: Body, key: string, fallback = ""): string {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw badRequest(`"${key}" must be a string`);
}

/** String field that must be present and non-empty. */
export function required(body: Body, key: string, label?: string): string {
  const value = str(body, key).trim();
  if (!value) throw badRequest(`${label ?? key} is required`);
  return value;
}

/** Optional string — undefined when the key is absent, so PATCH can tell. */
export function optStr(body: Body, key: string): string | undefined {
  return has(body, key) ? str(body, key) : undefined;
}

/** Numeric field, validated as finite. */
export function num(body: Body, key: string, fallback = 0): number {
  const value = body[key];
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) throw badRequest(`"${key}" must be a number`);
  return parsed;
}

/** Integer field (quantities, counts, capacities). */
export function int(body: Body, key: string, fallback = 0): number {
  const value = num(body, key, fallback);
  return Math.trunc(value);
}

/** Rupee input converted to paisa, the storage unit for all money. */
export function paisa(body: Body, key: string, fallback = 0): number {
  if (!has(body, key)) return fallback;
  const value = body[key];
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) throw badRequest(`"${key}" must be an amount`);
  return Math.round(parsed * 100);
}

/** Optional paisa — undefined when absent. */
export function optPaisa(body: Body, key: string): number | undefined {
  return has(body, key) ? paisa(body, key) : undefined;
}

export function bool(body: Body, key: string, fallback = false): boolean {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off", ""].includes(text)) return false;
  throw badRequest(`"${key}" must be a boolean`);
}

export function optBool(body: Body, key: string): boolean | undefined {
  return has(body, key) ? bool(body, key) : undefined;
}

/** Nullable string field: PATCH may explicitly clear a reference. */
export function nullableStr(body: Body, key: string): string | null | undefined {
  if (!has(body, key)) return undefined;
  const value = body[key];
  if (value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

export function arr(body: Body, key: string, fallback: unknown[] = []): unknown[] {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) throw badRequest(`"${key}" must be an array`);
  return value;
}

export function strArr(body: Body, key: string, fallback: string[] = []): string[] {
  return arr(body, key, fallback).map((entry) => String(entry));
}

export function obj(body: Body, key: string, fallback: Body = {}): Body {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "object" || Array.isArray(value)) throw badRequest(`"${key}" must be an object`);
  return value as Body;
}

// ------------------------------------------------------------------- query args
export function q(query: URLSearchParams, key: string, fallback = ""): string {
  const value = query.get(key);
  return value === null || value === "" ? fallback : value;
}

export function optQ(query: URLSearchParams, key: string): string | undefined {
  const value = query.get(key);
  return value === null || value === "" ? undefined : value;
}

export function qNum(query: URLSearchParams, key: string, fallback = 0): number {
  const value = query.get(key);
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw badRequest(`"?${key}" must be a number`);
  return parsed;
}

export function qInt(query: URLSearchParams, key: string, fallback = 0): number {
  return Math.trunc(qNum(query, key, fallback));
}

export function qBool(query: URLSearchParams, key: string, fallback = false): boolean {
  const value = query.get(key);
  if (value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Restrict a free-form filter to a known set, rejecting anything else. */
export function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
