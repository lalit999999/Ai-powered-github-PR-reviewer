// Type-only imports (§14): whole-statement and per-specifier (mixed) forms.
import type { Request, Response } from "express";
import { type NextFunction, Router } from "express";

export function registerRoute(router: Router): void {
  router.get("/health", (_req: Request, res: Response, _next: NextFunction) => {
    res.sendStatus(200);
  });
}
