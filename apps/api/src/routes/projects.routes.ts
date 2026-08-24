import { Router } from "express";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
} from "../controllers/projects.controller.js";
import { withRoute } from "../lib/http.js";
import { projectRepositoriesRouter } from "./repositories.routes.js";

const router = Router();

// Every handler goes through withRoute so a thrown AppError reaches the shared error
// middleware as the standard envelope, and the request-completion log line is tagged
// with this component (phase-00 §7).
router.get("/", withRoute(listProjects, { component: "api.projects" }));
router.post("/", withRoute(createProject, { component: "api.projects" }));
router.get("/:projectId", withRoute(getProject, { component: "api.projects" }));
router.delete("/:projectId", withRoute(deleteProject, { component: "api.projects" }));

// POST /api/projects/:projectId/repositories — nested here so the URL shape lives with
// projects while the handler lives with the repositories module. The child router is
// created with `mergeParams: true`; without it `:projectId` would be undefined inside
// the handler. See repositories.routes.ts for the full reasoning.
router.use("/:projectId/repositories", projectRepositoriesRouter);

export default router;
