import app from "./app.js";
import { env } from "./config/env.js";
import { createLogger } from "@repo/observability";

const logger = createLogger("server");

app.listen(env.PORT, () => {
  logger.info("server started", { port: env.PORT, nodeEnv: env.NODE_ENV });
});
