import type { Middleware } from "./middleware-types";

/** `implements` a same-file... no, cross-file interface — rule 2 (NAMED_IMPORT)
 * for heritage resolution, exercised via a **type-only** import. Heritage rule 2
 * (`resolveHeritageName` in graph-builder.ts) explicitly excludes type-only
 * imports (`!i.isTypeOnly`), so this deliberately demonstrates the documented
 * recall gap: this `implements` edge is expected to resolve only via the
 * repo-wide/per-package fallback (rule 3/4), not rule 2 — see
 * graph-repo-labels.json and docs/parsing.md.
 */
export class AuthMiddleware implements Middleware {
  checkAuth(): boolean {
    return this.hasToken() && this.hasValidHeader();
  }

  run(headerValue: string): boolean {
    this.recordAttempt(headerValue);
    return this.checkAuth();
  }

  private hasToken(): boolean {
    return true;
  }

  private hasValidHeader(): boolean {
    return true;
  }

  private recordAttempt(headerValue: string): void {
    this.lastAttemptLength = headerValue.trim().length;
  }

  private lastAttemptLength = 0;
}
