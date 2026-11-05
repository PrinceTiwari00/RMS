/**
 * HTTP-facing error type and constructors.
 *
 * Deliberately free of Next.js imports so services used by CLI scripts and by
 * the control plane can throw the same errors the API translates into status
 * codes. `router.ts` re-exports these for route modules.
 */

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

export const badRequest = (message: string) => new ApiError(400, message);
export const unauthorized = (message = "Sign in to continue") => new ApiError(401, message);
export const forbidden = (message = "You do not have permission to do that") => new ApiError(403, message);
export const notFound = (message = "Not found") => new ApiError(404, message);
export const conflict = (message: string) => new ApiError(409, message);
