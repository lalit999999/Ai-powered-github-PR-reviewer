import { cookies } from "next/headers";
import { API_URL } from "./api-url";

/**
 * Server-side client for `apps/api`.
 *
 * `apps/web` is a pure frontend (docs/decisions/phase-00-log.md §1) — plan.md §29.2's
 * "RSC calls the service layer directly" does not apply in this topology, so RSCs reach
 * the API over HTTP and forward the caller's cookie so the API resolves the same
 * session the browser holds.
 *
 * `cache: "no-store"` on every call: these responses are per-user and authorization
 * depends on them. A cached project list would be a cross-tenant leak of exactly the
 * kind the API-side tenancy check exists to prevent.
 */

export interface SessionUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  githubLogin?: string | null;
  avatarUrl?: string | null;
}

export interface Session {
  user?: SessionUser;
  expires: string;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

async function apiFetch(path: string): Promise<Response> {
  const cookieHeader = (await cookies()).toString();
  return fetch(`${API_URL}${path}`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
    cache: "no-store",
  });
}

/**
 * The authoritative signed-in check for server components: it resolves the session
 * against the database rather than trusting the presence of a cookie. `src/middleware.ts`
 * only pre-filters; this is what actually decides (phase-01 §4 — a session lookup never
 * fails open).
 */
export async function getServerSession(): Promise<Session | null> {
  const res = await apiFetch("/api/auth/session");
  if (!res.ok) return null;
  const body: unknown = await res.json();
  if (!body || typeof body !== "object") return null;
  const session = body as Session;
  return session.user?.id ? session : null;
}

export async function listProjects(): Promise<Project[]> {
  const res = await apiFetch("/api/projects");
  if (!res.ok) {
    throw new Error(`Could not load projects (${res.status})`);
  }
  const body = (await res.json()) as { projects: Project[] };
  return body.projects;
}

/**
 * A connected GitHub repository as `GET /api/projects/:id` and
 * `GET /api/repositories/:id` return it (phase-02 §7).
 *
 * `installationId` and `githubRepoId` are **strings**, not numbers. They are `BigInt`
 * columns server-side and JSON has no bigint, so the API converts them explicitly at
 * the DTO boundary. Parsing them back into `number` here would silently lose precision
 * on ids past 2^53 — treat them as opaque identifiers.
 */
export interface Repository {
  id: string;
  projectId: string;
  installationId: string;
  githubRepoId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  htmlUrl: string;
  sizeBytes: number | null;
  connectionStatus: "ACTIVE" | "DISCONNECTED" | "ACCESS_LOST";
  indexStatus: string;
  indexedCommitSha: string | null;
  indexedFileCount: number;
  lastIndexedAt: string | null;
  /** Phase 03: `{ code, message }`, or `null`. Mirrors `RepositoryDto.indexError`
   * (apps/api). */
  indexError: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail {
  project: Project;
  /** The project's active repositories — `DISCONNECTED` ones are excluded server-side.
   * Was `never[]` until Phase 02 connected repositories (phase-01 §7). */
  repositories: Repository[];
}

/** `null` means "not yours, or gone" — the API answers 404 for both, deliberately
 * (see requireTenantAccess in apps/api). */
export async function getProjectDetail(
  projectId: string,
): Promise<ProjectDetail | null> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Could not load project (${res.status})`);
  }
  return (await res.json()) as ProjectDetail;
}

/** A `GithubInstallation` row as `GET /api/github/installations` returns it
 * (phase-02 §7). `installationId` is a decimal string for the same BigInt-safety
 * reason `Repository`'s ids are. */
export interface Installation {
  id: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  suspended: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InstallationsResponse {
  installations: Installation[];
  /** The App's public install link (`https://github.com/apps/{slug}/installations/new`),
   * built server-side from `GITHUB_APP_SLUG` (sub-task 3.5). Returned by the API rather
   * than duplicated into a `NEXT_PUBLIC_*` variable here — one source of truth for a
   * value that would otherwise have to be kept in sync across two deploy targets. */
  installUrl: string;
}

/**
 * A 401 here is real and distinct from an invalid *session* (which never reaches this
 * far — `(app)/layout.tsx` already checked it): it means the caller's stored GitHub
 * *OAuth token* is missing or was revoked (`repository.service.ts`'s
 * `syncInstallations`). That is an actionable, expected state, not a crash — so this
 * is a discriminated result rather than a throw, the same "distinct signal, not an
 * exception" treatment `getProjectDetail`'s 404-means-null gets.
 */
export type InstallationsResult =
  | ({ ok: true } & InstallationsResponse)
  | { ok: false; reason: "UNAUTHENTICATED" };

/**
 * `GET /api/github/installations` — syncs from GitHub first (§10's polling fallback,
 * temporary until Phase 06's webhooks), so this call itself IS the "Refresh" action;
 * the frontend's Refresh button just calls this again.
 */
export async function listInstallations(): Promise<InstallationsResult> {
  const res = await apiFetch("/api/github/installations");
  if (res.status === 401) return { ok: false, reason: "UNAUTHENTICATED" };
  if (!res.ok) {
    throw new Error(`Could not load installations (${res.status})`);
  }
  const body = (await res.json()) as InstallationsResponse;
  return { ok: true, ...body };
}

/**
 * `GET /api/repositories/:id` response body (phase-02 §7, widened in Phase 03). Mirrors
 * `IndexJobSummaryDto`/`RepositoryDetail` (apps/api) — `indexJob` is `null` when the
 * repository has never had an index run, otherwise the latest job's summary. Consuming
 * this (an index-status card with live polling) is Prompt 3's work
 * (phase-03-repository-indexing.md §18); this type only needs to compile against real
 * server responses starting now.
 */
export interface IndexJobSummary {
  id: string;
  status: string;
  currentStep: string | null;
  progressPercent: number;
  filesTotal: number;
  filesProcessed: number;
  filesSkipped: number;
  error: unknown;
}

export interface RepositoryDetail {
  repository: Repository;
  indexJob: IndexJobSummary | null;
}

/** `null` means "not yours, or gone" — same 404-for-both convention as
 * `getProjectDetail`. */
export async function getRepository(
  repositoryId: string,
): Promise<RepositoryDetail | null> {
  const res = await apiFetch(
    `/api/repositories/${encodeURIComponent(repositoryId)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Could not load repository (${res.status})`);
  }
  return (await res.json()) as RepositoryDetail;
}

/**
 * `GET /api/repositories/:id/index-status` response body (phase-03 §7) — the exact six
 * fields that endpoint returns, deliberately narrower than `IndexJobSummary` above (no
 * `id`, no `filesSkipped`) since this is the cheap-poll shape a client hits repeatedly.
 *
 * This server-side helper exists for the same reason `getRepository` does — an RSC that
 * wants a repository's index state without a full detail fetch — but
 * `index-status-poller.tsx`'s own live polling loop runs client-side and cannot use it
 * (`apiFetch` reads `next/headers` cookies, which only work in a Server Component); that
 * component does its own `credentials: "include"` fetch instead, following
 * `disconnect-repository-button.tsx`'s established pattern.
 */
export interface IndexStatus {
  status: string;
  currentStep: string | null;
  progressPercent: number;
  filesTotal: number;
  filesProcessed: number;
  error: unknown;
}

/** `null` means "not yours, or gone" — same 404-for-both convention as `getRepository`. */
export async function getIndexStatus(
  repositoryId: string,
): Promise<IndexStatus | null> {
  const res = await apiFetch(
    `/api/repositories/${encodeURIComponent(repositoryId)}/index-status`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Could not load index status (${res.status})`);
  }
  return (await res.json()) as IndexStatus;
}

/**
 * `GET /api/repositories/:id/knowledge` response body (phase-04 §7), mirroring
 * `RepositoryKnowledgeDto` (apps/api) field-for-field. Only the *type* lives here —
 * `knowledge-panel.tsx` does its own `credentials: "include"` client-side fetch, the same
 * reason `index-status-poller.tsx`'s own `fetchIndexStatus` is local to that component
 * rather than added as a function here (`apiFetch`, above, reads `next/headers` and only
 * works in a Server Component).
 */
export interface TopFileByInboundEdges {
  fileId: string;
  path: string;
  inboundEdgeCount: number;
}

export interface TopUnresolvedSpecifier {
  rawSpecifier: string | null;
  count: number;
}

export interface RepositoryKnowledge {
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  unresolvedImportRatio: number;
  topFilesByInboundEdges: TopFileByInboundEdges[];
  edgeCountByKind: Record<string, number>;
  parseStateCounts: Record<string, number>;
  topUnresolvedSpecifiers: TopUnresolvedSpecifier[];
}

/**
 * A `WebhookEvent` row as `POST /api/repositories/:id/webhook-test` returns it
 * (phase-06 §7) — despite the route's name, this reads recorded deliveries; nothing is
 * sent. Mirrors `WebhookDeliveryDto` (apps/api). No bigint fields: unlike `Repository`/
 * `Installation` above, `installationId` is not part of this DTO at all — the API's own
 * `WEBHOOK_EVENT_SELECT` doesn't select it for this read.
 *
 * No server-side fetcher is added here for this one, unlike `getRepository`/
 * `getIndexStatus` above — `webhook-status-panel.tsx`'s own live fetch runs client-side
 * (`credentials: "include"`, matching `index-status-poller.tsx`'s established pattern)
 * and cannot use `apiFetch`, which reads `next/headers` cookies and only works in a
 * Server Component. Only the type is shared here; the fetch itself lives with the
 * component that uses it, exactly as `index-status-poller.tsx`'s own header comment
 * explains for `IndexStatus`.
 */
export interface WebhookDelivery {
  id: string;
  deliveryId: string;
  eventType: string;
  action: string | null;
  status: string;
  dispatchedAt: string | null;
  error: unknown;
  createdAt: string;
}
