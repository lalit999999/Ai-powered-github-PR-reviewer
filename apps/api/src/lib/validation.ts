import { z } from "zod";
import { ValidationError } from "./errors.js";

/**
 * Every future handler validates input through this — no route parses raw input itself.
 * Throws a ValidationError (400) with field-level details on failure.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const { fieldErrors, formErrors } = z.flattenError(result.error);
    throw new ValidationError("Validation failed", {
      details: { fieldErrors, formErrors },
    });
  }
  return result.data;
}
