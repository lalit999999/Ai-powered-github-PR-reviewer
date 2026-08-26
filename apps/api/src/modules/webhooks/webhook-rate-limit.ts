/**
 * The per-installation webhook burst guard (phase-06 §4/§13): rate-limiting inbound
 * webhook processing "independent of GitHub's own delivery retry behavior," so a
 * compromised or leaked `GITHUB_APP_WEBHOOK_SECRET` cannot be used to flood the internal
 * event queue by replaying or forging signed deliveries.
 *
 * **Why a short window, not `lib/rate-limit.ts`'s original one-hour default.** An
 * hour-scale window is right for `POST /api/repositories/:id/index` — a manual,
 * user-initiated action — but wrong here: webhook deliveries are GitHub-initiated and
 * arrive in bursts by nature (a force-push touching many commits, a bulk PR import, CI
 * re-running a matrix that opens/closes several PRs). The useful guard is a **burst**
 * guard measured in seconds, not an hourly quota that would either be too loose to catch
 * a real flood within the hour or too tight for a legitimately busy installation.
 *
 * **The numbers.** `WEBHOOK_RATE_LIMIT_WINDOW_SECONDS = 60`,
 * `WEBHOOK_RATE_LIMIT_PER_INSTALLATION = 100` — scoped per installation, which can cover
 * many repositories at once, not per repository. A single busy repository under active,
 * parallel development can plausibly produce a `synchronize` delivery every few seconds
 * per open PR; an installation covering, say, five such repositories during a
 * synchronized push/CI burst could reasonably see on the order of a few dozen deliveries
 * in a minute. 100/minute is generous enough to absorb that kind of legitimate spike
 * without false-positiving a real team, while still bounding the worst case from a
 * compromised secret to a fixed, small multiple of realistic traffic rather than an
 * unbounded flood.
 */
export const WEBHOOK_RATE_LIMIT_WINDOW_SECONDS = 60;
export const WEBHOOK_RATE_LIMIT_PER_INSTALLATION = 100;
