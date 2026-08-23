import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { errorHandler, requestContext } from "./lib/http.js";
import { notFoundMiddleware } from "./middleware/not-found.middleware.js";
import apiRoutes from "./routes/index.js";

const app = express();

app.use(requestContext);
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", apiRoutes);

app.use(notFoundMiddleware);
app.use(errorHandler);

export default app;
