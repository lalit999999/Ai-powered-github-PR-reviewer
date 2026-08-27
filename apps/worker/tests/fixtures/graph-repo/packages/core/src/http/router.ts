import { handler } from "./handler";
import { handler as webhookHandler } from "../webhooks/handler";

/** A clean, unambiguous same-package named import (rule 2) — `handler` here
 * resolves specifically to `./handler.ts`'s export, not the `webhooks/handler.ts`
 * collision, because the import specifier names the file directly. */
export function route(body: string): string {
  return handler(body);
}

/** A second clean rule-2 positive case, aliased on import (`as webhookHandler`)
 * so the caller-visible name differs from the declared symbol name — proves
 * resolution follows the *local bound* name, per `ParsedImport.named`'s own
 * contract, and resolves to the *other* of the two `handler` collisions. */
export function routeWebhook(event: string): string {
  return webhookHandler(event);
}
