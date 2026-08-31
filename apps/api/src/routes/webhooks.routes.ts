import { Router } from "express";
import { receiveGithubWebhook } from "../controllers/webhooks.controller.js";
import { withRoute } from "../lib/http.js";

/**
 * Mounted at `/api/webhooks` (see routes/index.ts). This router's own `/github` path,
 * combined with that mount prefix, produces exactly `WEBHOOK_GITHUB_PATH`
 * (`modules/webhooks/webhook.routes-path.ts`) — the same full path `app.ts`'s raw-body
 * mount matches ahead of `express.json()`. If either half of that combination ever
 * changes, update the constant (and re-check the mount in app.ts) in the same commit.
 */
const router = Router();

router.post(
  "/github",
  withRoute(receiveGithubWebhook, { component: "api.webhooks" }),
);

export default router;
