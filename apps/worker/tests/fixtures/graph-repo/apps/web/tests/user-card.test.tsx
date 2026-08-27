import { describe, expect, it } from "vitest";
import { UserCard } from "../src/components/user-card";

/** A test file detected by **path pattern** (`.test.tsx`) — see
 * `src/checks/verify-utils.ts` for a test file detected only by framework
 * import. Its import of `UserCard` (a non-test file) is expected to produce
 * a TESTS edge. */
describe("UserCard", () => {
  it("exists", () => {
    expect(typeof UserCard).toBe("function");
  });
});
