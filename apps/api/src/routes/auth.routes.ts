import { ExpressAuth } from "@auth/express";
import { authConfig } from "../lib/auth/config.js";

/**
 * Mounted at app.use("/api/auth/*", authHandler) in app.ts — matches @auth/express's
 * own documented mount pattern (wildcard, top-level in app.ts rather than nested
 * under the withRoute-wrapped feature router) because ExpressAuth is a complete
 * sub-application with its own request handling, not a single business-logic route;
 * it owns its own error rendering for the OAuth dance (phase-01 §12).
 */
export const authHandler = ExpressAuth(authConfig);
