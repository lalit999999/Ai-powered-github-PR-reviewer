// Namespace imports (§14).
import * as path from "node:path";

export function joinPaths(a: string, b: string): string {
  return path.join(a, b);
}
