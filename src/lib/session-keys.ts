/**
 * Cookie names shared between the server and the browser.
 *
 * Deliberately free of Node-only imports. `src/lib/api.ts` is a client module
 * that only needs the CSRF cookie names to build its double-submit headers, and
 * pulling `node:crypto` or `next/headers` in here would drag a server-only API
 * into the browser bundle. Everything else in `src/lib/session.ts` stays
 * server-side behind those constants.
 */

/** Restaurant staff session (PIN pad). */
export const SESSION_COOKIE = "rms_session";
export const CSRF_COOKIE = "rms_csrf";

/** Platform (super admin) session. Completely separate from staff cookies. */
export const PLATFORM_SESSION_COOKIE = "rms_platform";
export const PLATFORM_CSRF_COOKIE = "rms_platform_csrf";

/**
 * Remembers which restaurant this browser last opened, so the PIN pad, guest
 * pages and the customer display can find the right database without repeating
 * the restaurant code in every URL. It is not an authority on its own: the
 * staff session's signed tenant id always wins.
 */
export const TENANT_COOKIE = "rms_tenant";
