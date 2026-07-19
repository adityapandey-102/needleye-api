import { env } from "./config/env";
import { createApp } from "./app";

const app = createApp();

app.listen(env.API_PORT, () => {
  console.log(`Needle Eye API listening on http://localhost:${env.API_PORT}`);
});
