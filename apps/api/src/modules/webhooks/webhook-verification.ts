import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The security core of Phase 06 (phase-06-webhook-ingestion.md §0/§4/§35.3, plan.md
 * §45). GitHub signs every webhook delivery with an HMAC-SHA256 over the **exact bytes**
 * it sent, and this module's entire job is to reproduce that HMAC over the exact bytes
 * this server received — nothing more.
 *
 * `plan.md` §45 names body-parsing corruption of the HMAC as the single most common
 * implementation bug for this phase, and it is a body-parsing bug, not a crypto bug: any
 * `Buffer` → `string` → re-encoded-`Buffer` round trip along the way (whitespace
 * normalization, key reordering, a different string encoding) produces a byte sequence
 * that no longer matches what GitHub signed, even though the *parsed* payload is
 * semantically identical. So this module is deliberately narrow and deliberately
 * dependency-light:
 *
 * - **No Express.** The caller (Prompt 2's route) is responsible for getting a `Buffer`
 *   out of the request — via `express.raw()`, never `express.json()`, because Express's
 *   JSON body parser corrupts the exact byte sequence this function must verify (see
 *   `isPayloadTooLarge`'s doc comment for the size-cap half of that same requirement).
 *   This module does not know Express exists, so it cannot be tempted to reach for
 *   `req.body` in its parsed form.
 * - **No `../config/env.js`.** The caller resolves `GITHUB_APP_WEBHOOK_SECRET` through
 *   the validated `env` module (rule 6, phase-00 §19) and passes the secret in — this
 *   module takes it as a plain argument so it has no opinion on where secrets live and
 *   can be unit-tested with a synthetic one.
 * - **No `@repo/observability`.** This module never logs. `MISSING_SIGNATURE` and
 *   `MISMATCH` are returned as distinct outcomes specifically so the *caller* can decide
 *   what to log at what level (Prompt 3's observability separates "misconfigured
 *   sender" from "possible attack") — a module that logged its own findings would be
 *   making that policy decision for every future caller.
 */

/**
 * GitHub's own hard cap on delivery size is much larger than any payload this system
 * expects to see; this cap exists as this server's own defensive limit, not a mirror of
 * GitHub's. The single definition lives here so a payload-size check anywhere in the
 * webhook path (the route's `express.raw({ limit })` option and this module's own
 * `isPayloadTooLarge`) can reference the same number instead of two constants drifting
 * apart.
 */
export const MAX_WEBHOOK_PAYLOAD_BYTES = 5 * 1024 * 1024;

/** True once `rawBody` exceeds {@link MAX_WEBHOOK_PAYLOAD_BYTES}. Exists so the 5 MB
 * figure has exactly one definition in the codebase — see this module's header comment. */
export function isPayloadTooLarge(rawBody: Buffer): boolean {
  return rawBody.byteLength > MAX_WEBHOOK_PAYLOAD_BYTES;
}

/**
 * `MISSING_SIGNATURE` and `MISMATCH` are kept distinct even though both resolve to the
 * same 401 at the HTTP layer — the distinction never reaches the caller's response body,
 * only its logs. A missing header means the sender did not attempt to sign the request
 * at all (a misconfigured endpoint, or a request that is not from GitHub in the first
 * place); a mismatch means a signature was presented and did not verify (tampering, a
 * wrong secret, or exactly the body-corruption bug this module exists to catch).
 * Collapsing them into one outcome would make those two very different situations
 * indistinguishable in an incident.
 *
 * `MALFORMED_SIGNATURE` is its own outcome rather than folded into `MISMATCH` because it
 * covers a header that is structurally not a signature at all (no `sha256=` prefix, or
 * the wrong length) — a case `timingSafeEqual` cannot even be asked about, since it
 * throws on mismatched buffer lengths (see {@link verifyWebhookSignature}'s own comment).
 */
export type SignatureVerificationResult =
  | { ok: true }
  | {
      ok: false;
      reason: "MISSING_SIGNATURE" | "MALFORMED_SIGNATURE" | "MISMATCH";
    };

const SIGNATURE_PREFIX = "sha256=";

/**
 * Verifies GitHub's `X-Hub-Signature-256` header against `rawBody`.
 *
 * **`rawBody` is hashed exactly as given — no `.toString()`, no re-encode, no
 * normalization.** This is the one invariant the whole module exists to protect; see the
 * header comment for why a round trip through a string is the named failure mode for
 * this entire phase, not a hypothetical.
 *
 * The expected value is computed the same way GitHub computes it:
 * `"sha256=" + hmac("sha256", secret).update(rawBody).digest("hex")`.
 *
 * Comparison uses `crypto.timingSafeEqual` rather than `===` or `Buffer.equals`, per
 * `plan.md` §35.3 — a variable-time string comparison leaks how many leading bytes of a
 * guessed signature were correct, letting an attacker recover a valid signature one byte
 * at a time. **`timingSafeEqual` itself throws if the two buffers differ in length**, so
 * this function compares lengths first and returns `MALFORMED_SIGNATURE` instead of
 * letting that throw escape to the caller. This length pre-check does not reintroduce a
 * timing oracle: the length being compared against is a constant of the algorithm
 * (`"sha256=" + 64 hex chars`, always the same number of bytes for a well-formed header),
 * not a secret — an attacker already knows exactly how long a valid signature header is
 * without probing this function at all.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): SignatureVerificationResult {
  if (!signatureHeader) {
    return { ok: false, reason: "MISSING_SIGNATURE" };
  }

  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, reason: "MALFORMED_SIGNATURE" };
  }

  const expectedHeader =
    SIGNATURE_PREFIX +
    createHmac("sha256", secret).update(rawBody).digest("hex");
  const expected = Buffer.from(expectedHeader, "utf8");
  const actual = Buffer.from(signatureHeader, "utf8");

  // See the doc comment above: timingSafeEqual throws on a length mismatch, and a
  // malformed header (wrong hex length, garbage suffix) is exactly how that mismatch
  // happens in practice.
  if (expected.length !== actual.length) {
    return { ok: false, reason: "MALFORMED_SIGNATURE" };
  }

  return timingSafeEqual(expected, actual)
    ? { ok: true }
    : { ok: false, reason: "MISMATCH" };
}
