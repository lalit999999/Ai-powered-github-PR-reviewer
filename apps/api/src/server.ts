import app from "./app.js";
import { env } from "./config/env.js";
import { createLogger } from "./lib/logger.js";

const logger = createLogger("server");

app.listen(env.PORT, () => {
  logger.info("server started", { port: env.PORT, nodeEnv: env.NODE_ENV });
});
