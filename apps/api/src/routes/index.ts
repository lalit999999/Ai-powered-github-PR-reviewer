import { Router } from "express";
import healthRoutes from "./health.routes.js";
import projectsRoutes from "./projects.routes.js";

const router = Router();

router.use("/health", healthRoutes);
router.use("/projects", projectsRoutes);

// Future modules:
// router.use("/github", githubRoutes);
// router.use("/repositories", repositoriesRoutes);
// router.use("/pull-requests", pullRequestsRoutes);
// router.use("/reviews", reviewsRoutes);
// router.use("/users", usersRoutes);
// router.use("/subscriptions", subscriptionsRoutes);

export default router;
