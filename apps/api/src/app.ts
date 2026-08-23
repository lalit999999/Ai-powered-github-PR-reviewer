import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { errorHandler, requestContext } from "./lib/http.js";
import { notFoundMiddleware } from "./middleware/not-found.middleware.js";
import { authHandler } from "./routes/auth.routes.js";
import apiRoutes from "./routes/index.js";

const app = express();

// Auth.js reads the request's protocol via `req.protocol`; without this, a request
// arriving through a staging load balancer/proxy over HTTPS looks like plain HTTP to
// Express, which would make @auth/core's useSecureCookies detection drop the
// `secure` flag it's supposed to have (phase-01 §4/§13). See
// https://expressjs.com/en/guide/behind-proxies.html
app.set("trust proxy", true);

app.use(requestContext);
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mounted before the withRoute-wrapped feature routes: ExpressAuth is a complete
// sub-application (OAuth dance, its own session/csrf/provider endpoints) rather than
// a single business route, so it renders its own responses instead of going through
// withRoute/errorHandler (docs/decisions/phase-01-log.md).
app.use("/api/auth/*", authHandler);

app.use("/api", apiRoutes);

app.use(notFoundMiddleware);
app.use(errorHandler);

export default app;
