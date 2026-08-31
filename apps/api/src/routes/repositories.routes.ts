import { Router } from "express";
import {
  connectRepository,
  disconnectRepository,
  getIndexStatus,
  getKnowledge,
  getRecentWebhookDeliveries,
  getRepository,
  triggerIndex,
} from "../controllers/repositories.controller.js";
import { withRoute } from "../lib/http.js";

/** Mounted at `/api/repositories` (see routes/index.ts). */
const router = Router();

router.get(
  "/:repositoryId",
  withRoute(getRepository, { component: "api.repositories" }),
);
router.delete(
  "/:repositoryId",
  withRoute(disconnectRepository, { component: "api.repositories" }),
);
router.get(
  "/:repositoryId/index-status",
  withRoute(getIndexStatus, { component: "api.repositories" }),
);
router.post(
  "/:repositoryId/index",
  withRoute(triggerIndex, { component: "api.repositories" }),
);
router.get(
  "/:repositoryId/knowledge",
  withRoute(getKnowledge, { component: "api.repositories" }),
);
router.post(
  "/:repositoryId/webhook-test",
  withRoute(getRecentWebhookDeliveries, { component: "api.repositories" }),
);

export default router;

/**
 * `POST /api/projects/:projectId/repositories` (phase-02 §7) — the one route in this
 * phase whose URL belongs to projects but whose handler belongs to repositories.
 *
 * **The mounting decision, made once and recorded:** it lives here, in the repositories
 * module's route file, and is mounted as a nested router from `projects.routes.ts`. The
 * alternative — registering the full `/projects/:projectId/repositories` path from
 * `repositories.routes.ts` at the top level — would put a `/projects/...` path in a
 * file mounted at `/repositories`, so the URL a reader sees in the file would not be
 * the URL the server serves. Nesting keeps the handler with its module and the URL
 * shape with its parent.
 *
 * **`mergeParams: true` is load-bearing, not decoration.** Express does not propagate a
 * parent router's params into a child router by default: without it, `req.params` in
 * this handler contains only what *this* router matched, and `:projectId` — matched by
 * the parent mount path — is silently `undefined`. It would not throw; it would parse
 * as a validation failure or resolve tenancy against `undefined`. `repositories.routes.test.ts`
 * asserts the projectId actually arrives, so a future refactor that drops this flag
 * fails a test rather than shipping.
 */
export const projectRepositoriesRouter = Router({ mergeParams: true });

projectRepositoriesRouter.post(
  "/",
  withRoute(connectRepository, { component: "api.repositories" }),
);
