import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";

interface AppError extends Error {
  statusCode?: number;
}

// `next` is unused but required so Express recognizes this as the error handler.
export function errorMiddleware(err: AppError, req: Request, res: Response, next: NextFunction) {
  const statusCode = err.statusCode ?? 500;

  console.error(err);

  const message =
    statusCode === 500 && env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message || "Internal server error";

  res.status(statusCode).json({
    success: false,
    error: {
      message,
    },
  });
}
