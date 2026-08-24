import { Router } from "express";
import githubRoutes from "./github.routes.js";
import healthRoutes from "./health.routes.js";
import projectsRoutes from "./projects.routes.js";
import repositoriesRoutes from "./repositories.routes.js";

const router = Router();

router.use("/health", healthRoutes);
router.use("/projects", projectsRoutes);
router.use("/github", githubRoutes);
router.use("/repositories", repositoriesRoutes);

// Note: POST /api/projects/:projectId/repositories is mounted as a nested router from
// projects.routes.ts, not here — see repositories.routes.ts for why.

// Future modules:
// router.use("/pull-requests", pullRequestsRoutes);
// router.use("/reviews", reviewsRoutes);
// router.use("/users", usersRoutes);
// router.use("/subscriptions", subscriptionsRoutes);

export default router;
