import { handler } from "./handler";

/** A clean, unambiguous same-package named import (rule 2) — `handler` here
 * resolves specifically to `./handler.ts`'s export, not the `webhooks/handler.ts`
 * collision, because the import specifier names the file directly. */
export function route(body: string): string {
  return handler(body);
}
