import type { NextFunction, Request, Response } from "express";
import { NotFoundError } from "../lib/errors.js";

export function notFoundMiddleware(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl} not found`));
}
