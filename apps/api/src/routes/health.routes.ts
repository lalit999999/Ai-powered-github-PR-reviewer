import { Router } from "express";
import { getHealth } from "../controllers/health.controller.js";
import { withRoute } from "../lib/http.js";

const router = Router();

router.get("/", withRoute(getHealth, { component: "api.health" }));

export default router;
