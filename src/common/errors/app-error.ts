/**
 * Typed error hierarchy -- every layer (controller/service/repository)
 * throws one of these instead of manually calling res.status().json(). A
 * single error-handling middleware (common/middleware/error.middleware.ts)
 * is the only place that turns them into HTTP responses, so every error the
 * API returns has the same shape: { error: string, code: string, details?: unknown }.
 *
 * Each subclass carries the right HTTP status; the `code` is a **stable
 * application error code** from the ERROR_CODES registry (see error-codes.ts)
 * that clients branch on. Each subclass defaults to a generic code for its
 * status and lets the throw site pass a more specific one.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, code: string, details?: unknown, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Invalid request", code = "BAD_REQUEST", details?: unknown) {
    super(400, message, code, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required", code = "UNAUTHORIZED") {
    super(401, message, code);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to perform this action", code = "FORBIDDEN") {
    super(403, message, code);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found", code = "NOT_FOUND") {
    super(404, message, code);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflicting state", code = "CONFLICT") {
    super(409, message, code);
  }
}

/**
 * For unexpected persistence/infra failures -- message is safe to show,
 * real detail goes to server logs only. `cause` is the original error
 * (e.g. the raw pg/Postgrest error) repositories catch and wrap -- see
 * error.middleware.ts, which logs it. Never put `cause` in `details`:
 * `details` can reach the client response, `cause` never does.
 */
export class InternalError extends AppError {
  constructor(message = "Internal server error", cause?: unknown) {
    super(500, message, "INTERNAL", undefined, cause);
  }
}
