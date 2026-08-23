import { ExpressAuth } from "@auth/express";
import { authConfig } from "../lib/auth/config.js";

/**
 * Mounted at app.use("/api/auth", authHandler) in app.ts — top-level rather than
 * nested under the withRoute-wrapped feature router, because ExpressAuth is a
 * complete sub-application with its own request handling, not a single
 * business-logic route; it owns its own error rendering for the OAuth dance
 * (phase-01 §12). See app.ts for why the mount path has no trailing wildcard,
 * despite @auth/express's own docs using one.
 */
export const authHandler = ExpressAuth(authConfig);
