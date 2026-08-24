import { SignInButton } from "@/components/auth/sign-in-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Sign-in screen (phase-01 §3/§17 step 10). Lives in the `(marketing)` group — the
 * public, unauthenticated surface — because a signed-out user has to be able to reach
 * it; putting it under `(app)` would make it redirect to itself.
 *
 * Visual polish is explicitly not a goal in this phase (§3); this is the minimum that
 * starts the OAuth flow and reports a failed one.
 */

/**
 * Auth.js's own error codes, which arrive here via the `/auth/error` bridge route in
 * `apps/api` (see apps/api/src/routes/auth.routes.ts). They are a fixed vocabulary from
 * `@auth/core`, never user input — but they are still mapped to messages rather than
 * displayed, both because the raw codes mean nothing to a user and because rendering an
 * arbitrary query parameter is how reflected-content bugs start.
 */
const ERROR_MESSAGES: Record<string, string> = {
  AccessDenied:
    "You cancelled the GitHub authorization, or GitHub declined it. Nothing was saved — you can try again.",
  OAuthCallbackError:
    "GitHub sign-in could not be completed. If you revoked this app's access, authorize it again and retry.",
  OAuthAccountNotLinked: "That GitHub account is already linked to a different sign-in method.",
  OAuthSignInError: "GitHub could not be reached to start sign-in. Please try again.",
  Configuration:
    "Sign-in is misconfigured on the server. The most likely cause is a GitHub OAuth callback URL that does not match this environment.",
  Verification: "That sign-in link is no longer valid. Please start again.",
};

const FALLBACK_ERROR_MESSAGE = "Sign-in failed. Please try again.";

export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  const params = await searchParams;

  const errorParam = typeof params.error === "string" ? params.error : undefined;
  const errorMessage = errorParam ? (ERROR_MESSAGES[errorParam] ?? FALLBACK_ERROR_MESSAGE) : undefined;

  const requested = typeof params.callbackUrl === "string" ? params.callbackUrl : undefined;
  // Only same-origin paths are accepted as a post-sign-in destination — an absolute URL
  // from the query string would be an open redirect.
  const callbackPath = requested?.startsWith("/") && !requested.startsWith("//") ? requested : "/dashboard";

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Use your GitHub account to continue.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {errorMessage && (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {errorMessage}
            </div>
          )}
          <SignInButton callbackUrl={callbackPath} />
          <p className="text-xs text-muted-foreground">
            Only your public GitHub profile and email are requested. Repository access is granted separately, later.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
