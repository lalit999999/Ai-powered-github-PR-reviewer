import type { Request, Response } from "express";
import { DbUnavailableError } from "../lib/errors.js";
import { getTraceId } from "@repo/observability";
import { pingDatabase } from "../modules/health/health.repository.js";

/**
 * Phase-00 §7: proves the logging/error envelope end-to-end. Reveals nothing beyond
 * status and traceId — no versions, no stack traces (phase-00 §13).
 */
export async function getHealth(_req: Request, res: Response): Promise<void> {
  try {
    await pingDatabase();
  } catch (err) {
    throw new DbUnavailableError("Database unavailable", { cause: err });
  }

  res.status(200).json({
    status: "ok",
    traceId: getTraceId(),
  });
}
