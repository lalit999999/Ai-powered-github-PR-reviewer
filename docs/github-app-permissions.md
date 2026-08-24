# What this GitHub App can and cannot do

*A plain-language description of the access this application requests, written for
review by anyone evaluating whether to install it.*

This application reviews pull requests. To do that it needs to read your code and post
review comments. This page lists exactly what it asks for, why each item is needed, and
— just as importantly — what it deliberately does **not** ask for.

Access is granted through a GitHub App installation, which means three things worth
knowing up front:

- **You choose the repositories.** At install time you can grant access to selected
  repositories rather than all of them, and you can change that selection at any time.
- **Access is revocable at any time**, from your organization's or account's Installed
  GitHub Apps settings. Revoking takes effect immediately.
- **Credentials are short-lived.** The application does not hold a long-lived token for
  your account. It mints an access token that GitHub expires after one hour, keeps it
  only in an in-memory/Redis cache for at most 50 minutes, and never writes it to a
  database or a log file.

---

## Permissions requested

| Permission | Level | What it allows | Why it is needed |
|---|---|---|---|
| **Contents** | Read-only | Read files and directory listings on the branches of the repositories you select | The reviewer has to read your source code to understand what a pull request changes. Without it, a review could only see the diff, with no surrounding context — which is the difference between a useful review and a guess. |
| **Pull requests** | Read **and write** | Read pull requests, their diffs and metadata; create and update review comments | Reading is how the reviewer knows what changed. Writing is how it delivers the review: the comments it leaves on your pull request. This is the only write permission requested anywhere. |
| **Metadata** | Read-only | Read basic repository information — name, default branch, visibility, size | Mandatory. GitHub grants this to every App and it cannot be removed. It is also what the application uses to validate a repository before connecting it (that it exists, is not empty, and is within the supported size). |

No organization-level permissions and no account-level permissions are requested.

## Deliberately **not** requested

These are the permissions people most often expect a code tool to ask for. Each is
omitted on purpose.

| Not requested | What it would have allowed | Why it is refused |
|---|---|---|
| **Contents: write** | Pushing commits, creating or modifying branches, changing files | A code-review tool that can write to your repositories is a supply-chain attack surface. If this application were ever compromised, write access would mean an attacker could introduce code into your repositories. Read-only means the worst case is disclosure of code that the tool was already trusted to read — bad, but not a path to shipping malicious code. |
| **Administration** | Changing repository settings, managing collaborators and access, deleting repositories | Nothing about reviewing a pull request requires changing who can access a repository. Requesting it would grant permanent, org-wide blast radius for no functional gain. |
| **Actions** | Reading and triggering CI workflows, reading workflow secrets and logs | The application does not run or inspect your CI. Workflow logs routinely contain secrets, so this is access we prefer not to be able to have. |
| **Members / Organization administration** | Reading or changing organization membership and roles | The application has no concept of your org chart and no reason to acquire one. |
| **Secrets / Environments / Deployments** | Reading repository or environment secrets, triggering deployments | Never needed for review, and among the most sensitive access GitHub offers. |
| **Webhooks (repository-level administration)** | Creating and modifying repository webhooks | The App receives events through its own App-level webhook, which you can see and revoke with the installation. It does not need to install webhooks into your repositories. |

## What leaves your repository

- **Code from the repositories you select** is read and processed to build the review —
  including being sent to the AI model provider that generates review comments. Only
  content relevant to a pull request under review is used.
- **Pull request metadata** (titles, descriptions, diffs, file paths, commit SHAs).
- **Nothing is written back to your repository** except pull request review comments.

## What is stored

- Repository metadata (name, owner, default branch, visibility, size) and the index this
  application builds from your code so it can find relevant context during a review.
- **Not stored:** your GitHub access tokens, the App's own installation tokens, or your
  account password (this application never sees one — sign-in goes through GitHub OAuth).

## Revoking access

From **Settings → Integrations → Applications → Installed GitHub Apps** (personal) or
your organization's equivalent, you can change which repositories are shared or uninstall
the application entirely. Uninstalling immediately invalidates its ability to mint access
tokens; the next attempt fails and the affected repositories are marked as having lost
access.

---

*Scope of this document.* This is the permission rationale `plan.md` §17 asks to have in
writing from Phase 02 onward. The full security audit — data retention periods, sub-
processor list, deletion guarantees — is Phase 17 and is not covered here.
