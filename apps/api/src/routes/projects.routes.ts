import { Router } from "express";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
} from "../controllers/projects.controller.js";
import { withRoute } from "../lib/http.js";

const router = Router();

// Every handler goes through withRoute so a thrown AppError reaches the shared error
// middleware as the standard envelope, and the request-completion log line is tagged
// with this component (phase-00 §7).
router.get("/", withRoute(listProjects, { component: "api.projects" }));
router.post("/", withRoute(createProject, { component: "api.projects" }));
router.get("/:projectId", withRoute(getProject, { component: "api.projects" }));
router.delete("/:projectId", withRoute(deleteProject, { component: "api.projects" }));

export default router;
