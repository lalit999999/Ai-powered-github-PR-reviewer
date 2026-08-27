import { ExpressAuth } from "@auth/express";
import { Router, type Request, type Response } from "express";
import { env } from "../config/env.js";
import { authConfig } from "../lib/auth/config.js";
import { withRoute } from "../lib/http.js";

/**
 * Mounted at app.use("/api/auth", authHandler) in app.ts — top-level rather than
 * nested under the withRoute-wrapped feature router, because ExpressAuth is a
 * complete sub-application with its own request handling, not a single
 * business-logic route; it owns its own error rendering for the OAuth dance
 * (phase-01 §12). See app.ts for why the mount path has no trailing wildcard,
 * despite @auth/express's own docs using one.
 */
export const authHandler = ExpressAuth(authConfig);

/**
 * Bridge from Auth.js's own page routes to the frontend's.
 *
 * `@auth/core` builds its sign-in/error page URLs as
 * `${request.url.origin}${config.pages[kind]}` (read from
 * node_modules/@auth/core/index.js, not assumed) — so `pages` entries are **paths on
 * the API origin**, and cannot be absolute URLs pointing at `apps/web`. In this repo's
 * split topology the UI lives on a different origin, so `authConfig.pages` points at
 * these two routes and they redirect on to the real pages.
 *
 * Without this, a user who denies the GitHub authorization lands on Auth.js's built-in
 * error page served by the API (a clean page, but a dead end outside the app). With it,
 * every auth failure ends up on the frontend's own sign-in screen with an `error` code
 * it can render (phase-01 §14 Failure Verification).
 *
 * `error` is passed through verbatim: it is one of Auth.js's own fixed error types
 * (`AccessDenied`, `OAuthCallbackError`, `Configuration`, …), never user input, and the
 * frontend maps it to a message rather than displaying it raw.
 */
const authPagesRouter = Router();

function redirectToFrontendSignIn(req: Request, res: Response): void {
  const target = new URL("/signin", env.FRONTEND_URL);
  const error =
    typeof req.query.error === "string" ? req.query.error : undefined;
  if (error) {
    target.searchParams.set("error", error);
  }
  res.redirect(302, target.toString());
}

authPagesRouter.get(
  "/signin",
  withRoute(redirectToFrontendSignIn, { component: "api.auth-pages" }),
);
authPagesRouter.get(
  "/error",
  withRoute(redirectToFrontendSignIn, { component: "api.auth-pages" }),
);

export { authPagesRouter };
