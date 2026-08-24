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
export async function getProjectDetail(projectId: string): Promise<ProjectDetail | null> {
  const res = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Could not load project (${res.status})`);
  }
  return (await res.json()) as ProjectDetail;
}
