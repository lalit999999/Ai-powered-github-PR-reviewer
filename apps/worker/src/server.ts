import app from "./app.js";
import { env } from "./config/env.js";
import { createLogger } from "@repo/observability";

const logger = createLogger("server");

app.listen(env.WORKER_PORT, () => {
  logger.info("worker started", { port: env.WORKER_PORT, nodeEnv: env.NODE_ENV });
});
