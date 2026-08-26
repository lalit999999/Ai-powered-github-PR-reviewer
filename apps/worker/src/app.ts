import express from "express";
import { serve } from "inngest/express";
import { repositoryIndex } from "./inngest/functions/repository-index.js";
import { staleIndexSweeper } from "./inngest/functions/stale-index-sweeper.js";
import { webhookSweeper } from "./inngest/functions/webhook-sweeper.js";
import { inngest } from "./inngest/client.js";

const app = express();

app.use(express.json());

// `noop-handler` (phase-00/02's diagnostic-only function) is deleted, not kept
// alongside this one — repository-index now proves the worker is discoverable and
// wired up better than the noop ever could (docs/decisions/phase-03-log.md).
app.use("/api/inngest", serve({ client: inngest, functions: [repositoryIndex, staleIndexSweeper, webhookSweeper] }));

export default app;
