import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { env } from "./config/env.js";
import { ValidationError } from "./lib/errors.js";
import { errorHandler, requestContext } from "./lib/http.js";
import { notFoundMiddleware } from "./middleware/not-found.middleware.js";
import { MAX_WEBHOOK_PAYLOAD_BYTES } from "./modules/webhooks/webhook-verification.js";
import { WEBHOOK_GITHUB_PATH } from "./modules/webhooks/webhook.routes-path.js";
import { authHandler, authPagesRouter } from "./routes/auth.routes.js";
import apiRoutes from "./routes/index.js";

const app = express();

/**
 * Express's own reaction to `express.raw()`'s `limit` option — a `PayloadTooLargeError`
 * with `type: "entity.too.large"`, `status: 413` (verified empirically against the
 * installed express@5.2.1, not assumed from docs). Left alone, that error is not an
 * `AppError`, so it would fall through to `errorHandler`'s generic `INTERNAL_ERROR` 500
 * — but §12 requires a 400 for an oversized webhook delivery, since nothing about the
 * request would be different on a retry. This is a path-scoped error-handling
 * middleware (4 arguments, mounted at the same path immediately after the raw-body
 * parser below) rather than a change to the shared `errorHandler`: Express only routes
 * an error thrown by middleware mounted at a path to error-handling middleware mounted
 * at that same path or later, so this intercepts the one error this specific mount can
 * produce and translates it before it ever reaches the app-wide handler.
 */
function translateOversizedWebhookBody(err: unknown, _req: Request, _res: Response, next: NextFunction): void {
  if (typeof err === "object" && err !== null && (err as { type?: unknown }).type === "entity.too.large") {
    next(new ValidationError("Webhook payload exceeds the maximum allowed size"));
    return;
  }
  next(err);
}

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
// Phase 06 — mounted BEFORE express.json(), and this ordering is load-bearing. GitHub
// signs the exact bytes it sends; webhook-verification.ts's HMAC must be computed over
// those same bytes. express.json() below consumes the request stream and replaces
// req.body with a parsed-then-reconstructed object — a Buffer -> string -> object round
// trip that can silently change whitespace/key order, which changes the byte sequence
// without changing the parsed value. Signing that reconstruction instead of the
// original bytes is `plan.md` §45's named #1 way this phase gets implemented wrong: it
// passes in a test that signs the same reconstruction it verifies against, and fails
// against GitHub's real deliveries. Moving this mount below express.json(), or swapping
// it for express.json() on this path "for consistency," reintroduces exactly that bug.
//
// `type: "*/*"`, not `"application/json"` — GitHub can be configured to send
// `application/x-www-form-urlencoded`, and any content-type this mount does not
// recognize must still reach the handler as raw bytes so signature verification is what
// rejects it, not a silent fall-through to express.json() with an empty body.
//
// `req.body` is not guaranteed to be a `Buffer` by the time the handler runs — verified
// empirically against the installed express@5.2.1, not assumed: with a Content-Type
// header present (matching "*/*"), req.body is a `Buffer` even for a zero-length body;
// with **no** Content-Type and no body at all, express.raw() never runs its parser and
// req.body is `undefined`. The controller must check `Buffer.isBuffer(req.body)` rather
// than assume either shape.
//
// The `limit` is the same MAX_WEBHOOK_PAYLOAD_BYTES webhook-verification.ts defines, so
// the two can never drift into disagreeing about the cap. Exceeding it throws Express's
// own PayloadTooLargeError, translated to a 400 by translateOversizedWebhookBody
// immediately below rather than left to surface as a bare 413.
app.use(WEBHOOK_GITHUB_PATH, express.raw({ type: "*/*", limit: MAX_WEBHOOK_PAYLOAD_BYTES }));
app.use(WEBHOOK_GITHUB_PATH, translateOversizedWebhookBody);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mounted before the withRoute-wrapped feature routes: ExpressAuth is a complete
// sub-application (OAuth dance, its own session/csrf/provider endpoints) rather than
// a single business route, so it renders its own responses instead of going through
// withRoute/errorHandler (docs/decisions/phase-01-log.md).
//
// Deliberately NOT "/api/auth/*" — @auth/express's own docs mount with a trailing
// wildcard, but that pattern is incompatible with the installed
// express@5.2.1/path-to-regexp@8.4.2: a bare "*" fails to compile at all, and the
// named-wildcard form ("*splat") makes Express set req.baseUrl to the *full* request
// path instead of the mounted prefix, which corrupts @auth/express's own internal
// basePath computation (used to build OAuth callback/session URLs) on every request.
// A plain prefix mount is what Express 5's router actually needs here — verified
// empirically, not from the docs — see docs/decisions/phase-01-log.md.
app.use("/api/auth", authHandler);

// Auth.js's `pages.signIn`/`pages.error` targets — paths on this origin that redirect
// to apps/web's own sign-in screen (see routes/auth.routes.ts). Mounted outside
// "/api/auth" so the ExpressAuth sub-application never sees them.
app.use("/auth", authPagesRouter);

app.use("/api", apiRoutes);

app.use(notFoundMiddleware);
app.use(errorHandler);

export default app;
