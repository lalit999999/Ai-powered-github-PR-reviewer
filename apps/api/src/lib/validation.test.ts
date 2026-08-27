import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ValidationError } from "./errors.js";
import { parseOrThrow } from "./validation.js";

describe("parseOrThrow", () => {
  const schema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive(),
  });

  it("returns the parsed value on success", () => {
    const result = parseOrThrow(schema, { name: "Ada", age: 30 });
    expect(result).toEqual({ name: "Ada", age: 30 });
  });

  it("throws a ValidationError (400) with field-level details on failure", () => {
    expect.assertions(4);
    try {
      parseOrThrow(schema, { name: "", age: -1 });
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const validationError = err as ValidationError;
      expect(validationError.httpStatus).toBe(400);
      expect(validationError.code).toBe("VALIDATION_ERROR");
      const fieldErrors = validationError.details.fieldErrors as Record<
        string,
        string[]
      >;
      expect(Object.keys(fieldErrors).sort()).toEqual(["age", "name"]);
    }
  });

  it("names every missing required field", () => {
    expect.assertions(1);
    try {
      parseOrThrow(schema, {});
    } catch (err) {
      const fieldErrors = (err as ValidationError).details
        .fieldErrors as Record<string, string[]>;
      expect(Object.keys(fieldErrors).sort()).toEqual(["age", "name"]);
    }
  });
});
