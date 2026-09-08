import { env } from "./config/env";
import { createApp } from "./app";
import { db } from "./common/database/drizzle-client";
import { logger } from "./common/logger/logger";

const app = createApp();

const server = app.listen(env.API_PORT, () => {
  logger.info(`Needle Eye API listening on http://localhost:${env.API_PORT}`);
});

/**
 * Graceful shutdown: on a container stop/redeploy (SIGTERM) or Ctrl-C
 * (SIGINT), stop accepting new connections, let in-flight requests finish,
 * then drain the Postgres pool before exiting -- so a deploy doesn't kill
 * active requests or leak DB connections. A hard 10s cap guarantees the
 * process still exits even if a request hangs.
 */
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received -- shutting down gracefully`);

  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out -- forcing exit");
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(() => {
    void db.$client
      .end()
      .then(() => {
        logger.info("Shutdown complete");
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, "Error draining DB pool during shutdown");
        process.exit(1);
      });
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/**
 * Last-resort crash net. Without these, an uncaught exception or an unhandled
 * promise rejection prints to stderr (outside the structured pino log) and the
 * process exits silently -- exactly the "the API just stopped with no message"
 * situation that's impossible to diagnose. Log it structurally first.
 *
 * uncaughtException: the process may be in a corrupt state, so log and exit(1)
 * and let the supervisor (container/systemd/tsx-watch) restart it cleanly.
 * unhandledRejection: log and keep serving -- a single stray rejection
 * shouldn't take the whole API down (the default Node behaviour would crash).
 */
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception -- exiting");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
});
