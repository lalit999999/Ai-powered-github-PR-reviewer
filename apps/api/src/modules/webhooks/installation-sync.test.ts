import { describe, expect, it, vi } from "vitest";
import type {
  ParsedInstallationEvent,
  ParsedInstallationRepositoriesEvent,
  ParsedRepositoryEvent,
} from "./webhook.schema.js";

vi.mock("../repositories/installation.repository.js", () => ({
  updateInstallationMetadataIfExists: vi.fn(),
  setInstallationSuspendedAt: vi.fn(),
}));
vi.mock("../repositories/repository.repository.js", () => ({
  markAccessLostByInstallation: vi.fn(),
  restoreActiveByInstallation: vi.fn(),
  markAccessLostByGithubRepoId: vi.fn(),
  renameByGithubRepoId: vi.fn(),
  restoreActiveByGithubRepoId: vi.fn(),
}));

const installationRepository =
  await import("../repositories/installation.repository.js");
const repositoryRepository =
  await import("../repositories/repository.repository.js");
const {
  syncInstallationEvent,
  syncInstallationRepositoriesEvent,
  syncRepositoryEvent,
} = await import("./installation-sync.js");

function installationEvent(
  action: string,
  overrides: Partial<ParsedInstallationEvent["installation"]> = {},
): ParsedInstallationEvent {
  return {
    action,
    installation: {
      id: 555n,
      account: { login: "octocat", type: "Organization" },
      suspended_at: null,
      ...overrides,
    },
  };
}

describe("syncInstallationEvent — installation.created is update-only (phase-06 §2)", () => {
  it("with an existing row: updates accountLogin/accountType/suspendedAt, and userId is never touched", async () => {
    vi.mocked(installationRepository.updateInstallationMetadataIfExists)
      .mockReset()
      .mockResolvedValueOnce({ updated: true });

    const outcome = await syncInstallationEvent(installationEvent("created"));

    expect(outcome.reason).toBe("INSTALLATION_CREATED_UPDATED");
    expect(
      installationRepository.updateInstallationMetadataIfExists,
    ).toHaveBeenCalledWith({
      installationId: 555n,
      accountLogin: "octocat",
      accountType: "Organization",
      suspendedAt: null,
    });
    // The regression guard for §2's decision: the call carries no userId field at all.
    const call = vi.mocked(
      installationRepository.updateInstallationMetadataIfExists,
    ).mock.calls[0]![0];
    expect(call).not.toHaveProperty("userId");
  });

  it("with no existing row: nothing is written beyond the no-op check, and it does not throw", async () => {
    vi.mocked(installationRepository.updateInstallationMetadataIfExists)
      .mockReset()
      .mockResolvedValueOnce({ updated: false, reason: "NOT_FOUND" });
    vi.mocked(repositoryRepository.markAccessLostByInstallation).mockReset();

    const outcome = await syncInstallationEvent(installationEvent("created"));

    expect(outcome.reason).toBe("INSTALLATION_CREATED_NO_EXISTING_ROW");
    expect(
      repositoryRepository.markAccessLostByInstallation,
    ).not.toHaveBeenCalled();
  });
});

describe("syncInstallationEvent — deleted/suspend/unsuspend", () => {
  it("installation.deleted marks every repository under the installation ACCESS_LOST", async () => {
    vi.mocked(repositoryRepository.markAccessLostByInstallation)
      .mockReset()
      .mockResolvedValueOnce(2);

    const outcome = await syncInstallationEvent(installationEvent("deleted"));

    expect(outcome.reason).toBe("INSTALLATION_DELETED");
    expect(
      repositoryRepository.markAccessLostByInstallation,
    ).toHaveBeenCalledWith(555n);
  });

  it("installation.suspend sets suspendedAt and marks repositories ACCESS_LOST", async () => {
    vi.mocked(installationRepository.setInstallationSuspendedAt)
      .mockReset()
      .mockResolvedValueOnce(1);
    vi.mocked(repositoryRepository.markAccessLostByInstallation)
      .mockReset()
      .mockResolvedValueOnce(1);

    const outcome = await syncInstallationEvent(installationEvent("suspend"));

    expect(outcome.reason).toBe("INSTALLATION_SUSPENDED");
    expect(
      installationRepository.setInstallationSuspendedAt,
    ).toHaveBeenCalledWith(555n, expect.any(Date));
    expect(
      repositoryRepository.markAccessLostByInstallation,
    ).toHaveBeenCalledWith(555n);
  });

  it("installation.unsuspend clears suspendedAt and restores repositories to ACTIVE", async () => {
    vi.mocked(installationRepository.setInstallationSuspendedAt)
      .mockReset()
      .mockResolvedValueOnce(1);
    vi.mocked(repositoryRepository.restoreActiveByInstallation)
      .mockReset()
      .mockResolvedValueOnce(1);

    const outcome = await syncInstallationEvent(installationEvent("unsuspend"));

    expect(outcome.reason).toBe("INSTALLATION_UNSUSPENDED");
    expect(
      installationRepository.setInstallationSuspendedAt,
    ).toHaveBeenCalledWith(555n, null);
    expect(
      repositoryRepository.restoreActiveByInstallation,
    ).toHaveBeenCalledWith(555n);
  });
});

function installationRepositoriesEvent(
  action: string,
  overrides: Partial<ParsedInstallationRepositoriesEvent> = {},
): ParsedInstallationRepositoriesEvent {
  return {
    action,
    installation: { id: 555n },
    ...overrides,
  };
}

describe("syncInstallationRepositoriesEvent", () => {
  it("added is a no-op for connection status", async () => {
    vi.mocked(repositoryRepository.markAccessLostByGithubRepoId).mockReset();

    const outcome = await syncInstallationRepositoriesEvent(
      installationRepositoriesEvent("added", {
        repositories_added: [
          {
            id: 111n,
            full_name: "octocat/hello-world",
            name: "hello-world",
            owner: { login: "octocat" },
            html_url: "https://github.com/octocat/hello-world",
          },
        ],
      }),
    );

    expect(outcome.reason).toBe("INSTALLATION_REPOSITORIES_ADDED");
    expect(
      repositoryRepository.markAccessLostByGithubRepoId,
    ).not.toHaveBeenCalled();
  });

  it("removed marks the named repositories ACCESS_LOST, keyed by githubRepoId", async () => {
    vi.mocked(repositoryRepository.markAccessLostByGithubRepoId)
      .mockReset()
      .mockResolvedValue(1);

    const outcome = await syncInstallationRepositoriesEvent(
      installationRepositoriesEvent("removed", {
        repositories_removed: [
          {
            id: 111n,
            full_name: "octocat/a",
            name: "a",
            owner: { login: "octocat" },
            html_url: "https://github.com/octocat/a",
          },
          {
            id: 222n,
            full_name: "octocat/b",
            name: "b",
            owner: { login: "octocat" },
            html_url: "https://github.com/octocat/b",
          },
        ],
      }),
    );

    expect(outcome.reason).toBe("INSTALLATION_REPOSITORIES_REMOVED");
    expect(
      repositoryRepository.markAccessLostByGithubRepoId,
    ).toHaveBeenCalledWith(111n);
    expect(
      repositoryRepository.markAccessLostByGithubRepoId,
    ).toHaveBeenCalledWith(222n);
    expect(
      repositoryRepository.markAccessLostByGithubRepoId,
    ).toHaveBeenCalledTimes(2);
  });
});

function repositoryEvent(
  action: string,
  overrides: Partial<ParsedRepositoryEvent["repository"]> = {},
): ParsedRepositoryEvent {
  return {
    action,
    repository: {
      id: 111n,
      full_name: "octocat/hello-world",
      name: "hello-world",
      owner: { login: "octocat" },
      html_url: "https://github.com/octocat/hello-world",
      ...overrides,
    },
  };
}

describe("syncRepositoryEvent", () => {
  it("renamed updates owner/name/fullName/htmlUrl for every connected project", async () => {
    vi.mocked(repositoryRepository.renameByGithubRepoId)
      .mockReset()
      .mockResolvedValueOnce(2);

    const outcome = await syncRepositoryEvent(
      repositoryEvent("renamed", {
        name: "renamed-repo",
        full_name: "octocat/renamed-repo",
        html_url: "https://github.com/octocat/renamed-repo",
      }),
    );

    expect(outcome.reason).toBe("REPOSITORY_RENAMED");
    expect(repositoryRepository.renameByGithubRepoId).toHaveBeenCalledWith(
      111n,
      {
        owner: "octocat",
        name: "renamed-repo",
        fullName: "octocat/renamed-repo",
        htmlUrl: "https://github.com/octocat/renamed-repo",
      },
    );
  });

  it("deleted marks every connected project's repository row ACCESS_LOST", async () => {
    vi.mocked(repositoryRepository.markAccessLostByGithubRepoId)
      .mockReset()
      .mockResolvedValueOnce(2);

    const outcome = await syncRepositoryEvent(repositoryEvent("deleted"));

    expect(outcome.reason).toBe("REPOSITORY_DELETED");
    expect(
      repositoryRepository.markAccessLostByGithubRepoId,
    ).toHaveBeenCalledWith(111n);
  });

  it("archived marks every connected project's repository row ACCESS_LOST (no ARCHIVED status exists)", async () => {
    vi.mocked(repositoryRepository.markAccessLostByGithubRepoId)
      .mockReset()
      .mockResolvedValueOnce(1);

    const outcome = await syncRepositoryEvent(repositoryEvent("archived"));

    expect(outcome.reason).toBe("REPOSITORY_ARCHIVED");
    expect(
      repositoryRepository.markAccessLostByGithubRepoId,
    ).toHaveBeenCalledWith(111n);
  });

  it("unarchived restores every connected project's repository row to ACTIVE", async () => {
    vi.mocked(repositoryRepository.restoreActiveByGithubRepoId)
      .mockReset()
      .mockResolvedValueOnce(1);

    const outcome = await syncRepositoryEvent(repositoryEvent("unarchived"));

    expect(outcome.reason).toBe("REPOSITORY_UNARCHIVED");
    expect(
      repositoryRepository.restoreActiveByGithubRepoId,
    ).toHaveBeenCalledWith(111n);
  });
});
