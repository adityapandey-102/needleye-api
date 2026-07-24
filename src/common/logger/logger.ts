import pino from "pino";
import { env } from "../../config/env";

/**
 * One logger for the whole process. JSON on stdout always (so it's
 * pipeable to any log aggregator in prod); pretty-printed only in
 * development, where a human is actually watching the terminal.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" } }
      : undefined,
});
