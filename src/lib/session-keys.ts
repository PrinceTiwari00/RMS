/**
 * Cookie names shared between the server and the browser.
 *
 * Deliberately free of Node-only imports. `src/lib/api.ts` is a client module
 * that only needs the CSRF cookie name to build its double-submit header, and
 * pulling `node:crypto` or `next/headers` in here would drag a server-only API
 * into the browser bundle. Everything else in `src/lib/session.ts` stays
 * server-side behind that constant.
 */
export const SESSION_COOKIE = "rms_session";
export const CSRF_COOKIE = "rms_csrf";
