// Deliberate boundary violation fixture — Rule C.
// An Inngest function (apps/worker) must not import the API layer's routes/controllers
// directly. Excluded from the normal lint run (see eslint.config.mjs ignores); linted
// directly by apps/api/src/lib/boundaries.test.ts to prove Rule C fires.
import { getHealth } from "../../../../api/src/routes/health.routes";

export const noopHandler = () => getHealth;
