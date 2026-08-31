export { prisma } from "./client.js";
export { authAdapter } from "./auth-adapter.js";

// The raw-SQL composition namespace (`Prisma.sql` / `.join` / `.raw` / `.empty`) — the
// only sanctioned way to build a parameterized `$executeRaw`/`$queryRaw` query
// (plan.md §35.11 forbids string interpolation into SQL). Imported from
// `./generated/client.js`, not `./client.js`: the latter is this package's hand-written
// wrapper that constructs the real `PrismaClient` instance and throws at import time if
// `DATABASE_URL` is unset (`packages/db/src/client.ts`) — a deliberate fail-fast for a
// real connection. `./generated/client.js` is Prisma's own generated module; importing
// it touches no environment variable and opens no connection, so re-exporting `Prisma`
// from it adds no new footgun for a consumer that only wants the query-building helpers.
export { Prisma } from "./generated/client.js";

// Phase 05 prompt 2: the pgvector VectorStore implementation. Exported progressively as
// sub-tasks 2.2/2.3/2.5 land the individual functions and, once every method exists,
// the assembled `pgvectorStore: VectorStore` instance — see sub-task 2.7's own export
// block below for the final, fully-commented surface.
export {
  deleteByFilePaths,
  deleteByRepository,
  upsertChunks,
  VectorDimensionError,
} from "./vector/pgvector.store.js";
export type { ChunkUpsertInput } from "./vector/vector-store.interface.js";
