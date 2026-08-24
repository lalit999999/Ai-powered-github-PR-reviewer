import express from "express";
import { serve } from "inngest/express";
import { inngest } from "./inngest/client.js";
import { noopHandler } from "./inngest/functions/noop.js";

const app = express();

app.use(express.json());

app.use("/api/inngest", serve({ client: inngest, functions: [noopHandler] }));

export default app;
