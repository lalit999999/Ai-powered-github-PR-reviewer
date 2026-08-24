import { Router } from "express";
import { listInstallationRepos, listInstallations } from "../controllers/github.controller.js";
import { withRoute } from "../lib/http.js";

const router = Router();

// Every handler goes through withRoute so a thrown AppError reaches the shared error
// middleware as the standard envelope, and the request-completion log line is tagged
// with this component (phase-00 §7).
router.get("/installations", withRoute(listInstallations, { component: "api.github" }));
router.get("/installations/:installationId/repos", withRoute(listInstallationRepos, { component: "api.github" }));

export default router;
