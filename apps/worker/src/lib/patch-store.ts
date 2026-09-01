import { createLogger } from "@repo/observability";
import { PATCH_INLINE_MAX_BYTES } from "@repo/shared";
import * as patchBlobRepository from "../reviews/patch-blob.repository.js";

/**
 * Sub-task 1.6 — the seam that decides where a `PullRequestFile`'s patch text lives.
 * Lives in `apps/worker` because only the worker ever writes a patch; `apps/api` reads
 * `PullRequestFile` rows and never needs the patch body in this phase.
 *
 * This file itself must not import `@repo/db` (Rule B, phase-00 §3) — all Prisma access
 * goes through `../reviews/patch-blob.repository.ts`, the one `*.repository.ts` file
 * this module calls.
 */

const logger = createLogger("worker.patch-store");

const INLINE_PREFIX = "inline:";
const BLOB_PREFIX = "blob:";

/**
 * `inline:<text>` | `blob:<PatchBlob.id>` | `null`. The scheme prefix is the whole
 * point: it makes the storage backend swappable (a future `s3:<key>`) without a schema
 * migration and without any consumer having to guess which shape it is holding.
 */
export type PatchRef = string;

export interface StoredPatch {
  patchRef: PatchRef | null;
  patchBytes: number;
}

/**
 * Stores one file's patch, choosing inline vs blob by {@link PATCH_INLINE_MAX_BYTES}
 * (`@repo/shared`) — the boundary is **inclusive**: a patch at exactly the cap stays
 * inline. A null/undefined/empty patch (GitHub omits it for binary and very large files)
 * is a normal outcome, not an error: it returns `{ patchRef: null, patchBytes: 0 }`.
 *
 * `patchBytes` is measured with `Buffer.byteLength(patch, "utf8")` — **byte length, not
 * `string.length`.** A patch full of multibyte characters (`string.length` counts UTF-16
 * code units, not bytes) would otherwise be measured wrong and could be stored inline
 * when its real byte size is over the cap.
 */
export async function storePatch(input: {
  reviewId: string;
  path: string;
  patch: string | null | undefined;
}): Promise<StoredPatch> {
  const { reviewId, path, patch } = input;

  if (!patch) {
    return { patchRef: null, patchBytes: 0 };
  }

  const patchBytes = Buffer.byteLength(patch, "utf8");

  if (patchBytes <= PATCH_INLINE_MAX_BYTES) {
    return { patchRef: `${INLINE_PREFIX}${patch}`, patchBytes };
  }

  logger.debug("patch exceeds the inline threshold — storing as a blob", {
    reviewId,
    path,
    byteSize: patchBytes,
  });

  const blob = await patchBlobRepository.upsertBlob({
    reviewId,
    path,
    content: patch,
    byteSize: patchBytes,
  });

  return { patchRef: `${BLOB_PREFIX}${blob.id}`, patchBytes };
}

/**
 * Resolves a {@link PatchRef} back to text. Returns `null` for a `null` ref or a blob
 * row that no longer exists (a review can be cascade-deleted between read and resolve —
 * see `patch-blob.repository.ts`'s own comment on `findBlobContentById`). Phase 08+ is
 * the real consumer; it exists now so the round trip is testable in this phase.
 *
 * Throws for a `patchRef` carrying a scheme this store does not recognize, rather than
 * silently returning `null` or garbage — an unrecognized scheme is a programming error
 * (a future `s3:` scheme this function was never updated to handle, or a hand-corrupted
 * row), not a normal "no patch" outcome, and should fail loudly rather than read as an
 * empty patch.
 */
export async function resolvePatch(
  patchRef: PatchRef | null,
): Promise<string | null> {
  if (patchRef === null) {
    return null;
  }

  if (patchRef.startsWith(INLINE_PREFIX)) {
    return patchRef.slice(INLINE_PREFIX.length);
  }

  if (patchRef.startsWith(BLOB_PREFIX)) {
    const id = patchRef.slice(BLOB_PREFIX.length);
    return patchBlobRepository.findBlobContentById(id);
  }

  throw new Error(`patch-store: unrecognized patchRef scheme: "${patchRef}"`);
}
