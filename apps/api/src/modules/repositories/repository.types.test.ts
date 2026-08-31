import { describe, expect, it } from "vitest";
import {
  isConnectionStatus,
  toInstallationDto,
  toRepositoryDto,
  toWebhookDeliveryDto,
  type InstallationRecord,
  type RepositoryRecord,
} from "./repository.types.js";

/**
 * The BigInt boundary. `project.types.ts`'s doc comment warned that Phase 02 is where
 * this stops being hypothetical: `installationId` and `githubRepoId` are real `bigint`
 * columns, and `JSON.stringify` **throws** on a bigint. A DTO that carried one through
 * would be a 500 in production, on the happy path, on the first successful connect.
 *
 * These assertions are what make that impossible to reintroduce with a `...record`
 * spread.
 */

function repositoryRow(
  overrides: Partial<RepositoryRecord> = {},
): RepositoryRecord {
  return {
    id: "repo-1",
    projectId: "project-1",
    installationId: 12345678901234n,
    githubRepoId: 9223372036854775807n,
    owner: "octocat",
    name: "hello-world",
    fullName: "octocat/hello-world",
    defaultBranch: "main",
    isPrivate: true,
    htmlUrl: "https://github.com/octocat/hello-world",
    sizeBytes: 2048,
    connectionStatus: "ACTIVE",
    indexStatus: "PENDING",
    indexedCommitSha: null,
    indexVersion: 1,
    indexedFileCount: 0,
    skippedFileCount: 0,
    lastIndexedAt: null,
    indexError: null,
    settings: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

describe("toRepositoryDto — no bigint may reach a JSON response", () => {
  it("converts both bigint columns to decimal strings", () => {
    const dto = toRepositoryDto(repositoryRow());

    expect(dto.installationId).toBe("12345678901234");
    expect(dto.githubRepoId).toBe("9223372036854775807");
    expect(typeof dto.installationId).toBe("string");
    expect(typeof dto.githubRepoId).toBe("string");
  });

  it("survives JSON.stringify — the failure project.types.ts warned about", () => {
    // Without the explicit conversions above this line throws
    // `TypeError: Do not know how to serialize a BigInt`.
    const json = JSON.stringify(toRepositoryDto(repositoryRow()));

    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json)).toMatchObject({
      githubRepoId: "9223372036854775807",
    });
  });

  it("carries no bigint on any field, however deeply the DTO grows", () => {
    // Guards the whole shape rather than the two fields known today: a field added
    // later by spread would fail here rather than in production.
    for (const [key, value] of Object.entries(
      toRepositoryDto(repositoryRow()),
    )) {
      expect(typeof value, `field ${key}`).not.toBe("bigint");
    }
  });

  it("renders dates as ISO strings and a null lastIndexedAt as null", () => {
    const dto = toRepositoryDto(repositoryRow());
    expect(dto.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(dto.lastIndexedAt).toBeNull();

    const indexed = toRepositoryDto(
      repositoryRow({ lastIndexedAt: new Date("2026-02-03T04:05:06.000Z") }),
    );
    expect(indexed.lastIndexedAt).toBe("2026-02-03T04:05:06.000Z");
  });

  it("falls back to ACTIVE for a connectionStatus the column allowed but the union does not", () => {
    // The column is a plain String (phase-02-log §5), so a hand-edited row can hold
    // anything. A read must not 500 because of one.
    expect(
      toRepositoryDto(repositoryRow({ connectionStatus: "WHATEVER" }))
        .connectionStatus,
    ).toBe("ACTIVE");
    expect(
      toRepositoryDto(repositoryRow({ connectionStatus: "ACCESS_LOST" }))
        .connectionStatus,
    ).toBe("ACCESS_LOST");
  });
});

describe("toInstallationDto", () => {
  function installationRow(
    overrides: Partial<InstallationRecord> = {},
  ): InstallationRecord {
    return {
      id: "inst-1",
      installationId: 87654321n,
      accountLogin: "octocat",
      accountType: "User",
      userId: "user-a",
      suspendedAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      ...overrides,
    };
  }

  it("converts installationId to a string and survives JSON.stringify", () => {
    const dto = toInstallationDto(installationRow());
    expect(dto.installationId).toBe("87654321");
    expect(() => JSON.stringify(dto)).not.toThrow();
  });

  it("exposes suspension as a boolean, not the timestamp", () => {
    expect(toInstallationDto(installationRow()).suspended).toBe(false);
    expect(
      toInstallationDto(installationRow({ suspendedAt: new Date() })).suspended,
    ).toBe(true);
  });

  it("does not leak the owning userId into the DTO", () => {
    // The caller is the owner by construction — every route resolves ownership first.
    expect(Object.keys(toInstallationDto(installationRow()))).not.toContain(
      "userId",
    );
  });
});

describe("toWebhookDeliveryDto", () => {
  function deliveryRow(
    overrides: Partial<Parameters<typeof toWebhookDeliveryDto>[0]> = {},
  ) {
    return {
      id: "event-1",
      deliveryId: "01234567-89ab-cdef-0123-456789abcdef",
      eventType: "pull_request",
      action: "opened",
      status: "DISPATCHED",
      dispatchedAt: new Date("2026-01-01T00:00:05.000Z"),
      error: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      ...overrides,
    };
  }

  it("renders dates as ISO strings and a null dispatchedAt as null", () => {
    const dto = toWebhookDeliveryDto(deliveryRow());
    expect(dto.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(dto.dispatchedAt).toBe("2026-01-01T00:00:05.000Z");

    expect(
      toWebhookDeliveryDto(deliveryRow({ dispatchedAt: null })).dispatchedAt,
    ).toBeNull();
  });

  it("survives JSON.stringify", () => {
    const json = JSON.stringify(toWebhookDeliveryDto(deliveryRow()));
    expect(() => JSON.parse(json)).not.toThrow();
    expect(JSON.parse(json)).toMatchObject({
      status: "DISPATCHED",
      eventType: "pull_request",
    });
  });

  it("carries no bigint on any field", () => {
    for (const [key, value] of Object.entries(
      toWebhookDeliveryDto(deliveryRow()),
    )) {
      expect(typeof value, `field ${key}`).not.toBe("bigint");
    }
  });
});

describe("isConnectionStatus", () => {
  it.each([["ACTIVE"], ["DISCONNECTED"], ["ACCESS_LOST"]])(
    "accepts %s",
    (value) => {
      expect(isConnectionStatus(value)).toBe(true);
    },
  );

  it.each([["active"], [""], ["PENDING"], [null], [42]])(
    "rejects %j",
    (value) => {
      expect(isConnectionStatus(value)).toBe(false);
    },
  );
});
