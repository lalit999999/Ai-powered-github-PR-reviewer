import type { Request, Response } from "express";

export function getHealth(_req: Request, res: Response) {
  res.status(200).json({
    success: true,
    message: "API is healthy",
    timestamp: new Date().toISOString(),
  });
}
