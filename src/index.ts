import { env } from "./config/env";
import { createApp } from "./app";
import { logger } from "./common/logger/logger";

const app = createApp();

app.listen(env.API_PORT, () => {
  logger.info(`Needle Eye API listening on http://localhost:${env.API_PORT}`);
});
