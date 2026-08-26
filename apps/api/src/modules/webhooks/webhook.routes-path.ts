/**
 * The exact path GitHub webhook deliveries hit. Shared between `app.ts`'s raw-body
 * mount — which must match this path precisely to run before `express.json()` — and
 * the route registration itself (`routes/index.ts` mounting `webhooks.routes.ts` at
 * `/api/webhooks`, which then defines `POST /github`), so the two halves of that
 * combination cannot drift apart on the URL a byte-level raw-body mount has to match
 * exactly. See `app.ts`'s own comment at the mount point for why the ordering matters.
 */
export const WEBHOOK_GITHUB_PATH = "/api/webhooks/github";
