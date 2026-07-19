/**
 * Typed error hierarchy -- every route/service throws one of these instead
 * of manually calling res.status().json(). A single error-handling
 * middleware (shared/middleware/errorHandler.ts) is the only place that
 * turns them into HTTP responses, so every error the API returns has the
 * same shape: { error: string, code: string, details?: unknown }.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, message: string, code: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Invalid request", details?: unknown) {
    super(400, message, "BAD_REQUEST", details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, message, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have access to perform this action") {
    super(403, message, "FORBIDDEN");
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, message, "NOT_FOUND");
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflicting state") {
    super(409, message, "CONFLICT");
  }
}

/** For unexpected persistence/infra failures -- message is safe to show, real detail goes to server logs only. */
export class InternalError extends AppError {
  constructor(message = "Internal server error") {
    super(500, message, "INTERNAL");
  }
}
