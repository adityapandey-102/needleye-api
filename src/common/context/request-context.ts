import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped context carried implicitly through the async call stack via
 * AsyncLocalStorage (a Node built-in -- not an external dependency, and the
 * idiomatic way to propagate per-request data without threading it through
 * every function signature). Populated once per request by
 * request-context.middleware.ts and read by any deep code that needs to
 * correlate to the current request but doesn't have the Express `req`:
 * the audit logger and the slow-query logger, primarily.
 *
 * Everything here is best-effort: code that runs outside a request (the seed
 * script, startup) simply gets `undefined`, and callers degrade gracefully.
 */
export interface RequestContext {
  requestId: string;
  /** Set after requireAuth succeeds -- absent on unauthenticated routes (login, bootstrap, etc.). */
  userId?: string;
  role?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` (and everything it awaits) with the given context in scope. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The current request's context, or undefined outside any request. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Attaches the authenticated identity to the current context (called by requireAuth). No-op outside a request. */
export function setRequestUser(userId: string, role: string): void {
  const context = storage.getStore();
  if (context) {
    context.userId = userId;
    context.role = role;
  }
}
