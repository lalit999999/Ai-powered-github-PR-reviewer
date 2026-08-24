import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as tarStream from "tar-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArchiveTooLargeError,
  extractRepositoryArchive,
  resolveSafePath,
  UnsafeArchiveError,
  type ArchiveExtractorOptions,
} from "./archive-extractor.js";

const TOP_LEVEL = "octocat-hello-world-1a2b3c4";

function noopLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface FixtureEntry {
  header: tarStream.Headers;
  content?: string | Buffer;
}

/** Builds a real, valid gzip(tar(entries)) buffer using tar-stream's own pack() — a
 * crafted fixture assembled programmatically so the repo never contains a genuinely
 * malicious file on disk. */
async function buildTarballGzip(entries: FixtureEntry[]): Promise<Buffer> {
  const pack = tarStream.pack();
  for (const entry of entries) {
    if (entry.content !== undefined) {
      pack.entry(entry.header, entry.content);
    } else {
      pack.entry(entry.header);
    }
  }
  pack.finalize();

  const chunks: Buffer[] = [];
  for await (const chunk of pack) {
    chunks.push(chunk as Buffer);
  }
  return gzipSync(Buffer.concat(chunks));
}

function toWebStream(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "archive-extractor-test-"));
}

async function listAllFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(root);
  return out.sort();
}

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function extract<T>(
  buffer: Buffer,
  overrides: Partial<ArchiveExtractorOptions> = {},
  onExtracted: (rootDir: string, summary: import("./archive-extractor.js").ExtractionSummary) => Promise<T> = async () =>
    undefined as T,
): Promise<{ result: T; tempRootDir: string }> {
  const tempRootDir = await makeTempRoot();
  tempRoots.push(tempRootDir);
  const result = await extractRepositoryArchive(toWebStream(buffer), {
    tempRootDir,
    jobId: randomUUID(),
    maxTotalBytes: 2 * 1024 ** 3,
    maxFileCount: 200_000,
    logger: noopLogger(),
    ...overrides,
  }, onExtracted);
  return { result, tempRootDir };
}

describe("resolveSafePath — the sibling-prefix defeat (§14/§15)", () => {
  it("rejects a sibling directory whose name merely extends the root's as a string", () => {
    // "/tmp/job10/evil.txt".startsWith("/tmp/job1") is true as a raw string comparison,
    // even though job10 is not inside job1 at all — the exact defeat a naive prefix
    // check falls for for. path.relative must not be fooled the same way.
    expect(resolveSafePath("/tmp/job1", "../job10/evil.txt")).toBeNull();
  });

  it("accepts an ordinary path that stays inside the root", () => {
    expect(resolveSafePath("/tmp/job1", "src/index.ts")).toBe(path.resolve("/tmp/job1", "src/index.ts"));
  });

  it("rejects the root itself (empty relative path)", () => {
    expect(resolveSafePath("/tmp/job1", ".")).toBeNull();
  });

  it("rejects straightforward traversal", () => {
    expect(resolveSafePath("/tmp/job1", "../../etc/passwd")).toBeNull();
  });
});

describe("extractRepositoryArchive — path traversal and absolute paths abort the whole archive (§12)", () => {
  it("rejects an entry named ../../etc/passwd with UNSAFE_ARCHIVE, and writes nothing", async () => {
    const buffer = await buildTarballGzip([
      { header: { name: `${TOP_LEVEL}/src/index.ts` }, content: "export {};" },
      { header: { name: `${TOP_LEVEL}/../../../etc/passwd` }, content: "root:x:0:0::/root:/bin/bash" },
    ]);

    const tempRootDir = await makeTempRoot();
    tempRoots.push(tempRootDir);

    await expect(
      extractRepositoryArchive(toWebStream(buffer), {
        tempRootDir,
        jobId: randomUUID(),
        maxTotalBytes: 2 * 1024 ** 3,
        maxFileCount: 200_000,
        logger: noopLogger(),
      }, async () => undefined),
    ).rejects.toBeInstanceOf(UnsafeArchiveError);

    // The strongest form of the assertion: nothing anywhere under the test root exists —
    // not the malicious file, not even the legitimate one that preceded it in the
    // archive, since the whole archive is aborted rather than partially extracted.
    expect(await listAllFiles(tempRootDir)).toEqual([]);
  });

  it("rejects an absolute path entry (/etc/passwd) with UNSAFE_ARCHIVE, and writes nothing", async () => {
    const buffer = await buildTarballGzip([{ header: { name: "/etc/passwd" }, content: "root:x:0:0::/root:/bin/bash" }]);
    const tempRootDir = await makeTempRoot();
    tempRoots.push(tempRootDir);

    await expect(
      extractRepositoryArchive(toWebStream(buffer), {
        tempRootDir,
        jobId: randomUUID(),
        maxTotalBytes: 2 * 1024 ** 3,
        maxFileCount: 200_000,
        logger: noopLogger(),
      }, async () => undefined),
    ).rejects.toBeInstanceOf(UnsafeArchiveError);
    expect(await listAllFiles(tempRootDir)).toEqual([]);
  });

  it("never surfaces the attacked path in the thrown error's own message (§12: no attack details to the UI)", async () => {
    const buffer = await buildTarballGzip([{ header: { name: "/etc/shadow" }, content: "x" }]);
    const error = await extract(buffer).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(UnsafeArchiveError);
    expect((error as Error).message).not.toContain("/etc/shadow");
  });
});

describe("extractRepositoryArchive — symlinks and hardlinks are skipped, not aborted (§13)", () => {
  it("skips a symlink whose target escapes the extraction root, and never creates it", async () => {
    const buffer = await buildTarballGzip([
      { header: { name: `${TOP_LEVEL}/evil-link`, type: "symlink", linkname: "/etc/passwd" } },
      { header: { name: `${TOP_LEVEL}/README.md` }, content: "hello" },
    ]);

    const { result, tempRootDir } = await extract(buffer, {}, async (rootDir, summary) => {
      expect(summary.skipped).toContainEqual({ rawPath: `${TOP_LEVEL}/evil-link`, reason: "SYMLINK" });
      // The legitimate entry alongside it still extracts — one hostile entry does not
      // sink the whole archive the way a path-traversal entry does.
      expect(await fs.readFile(path.join(rootDir, "README.md"), "utf-8")).toBe("hello");
      const files = await listAllFiles(rootDir);
      expect(files.some((f) => f.includes("evil-link"))).toBe(false);
      return "checked";
    });

    expect(result).toBe("checked");
    // And the temp directory is fully gone afterward, per the callback-scoped contract.
    expect(await listAllFiles(tempRootDir)).toEqual([]);
  });

  it("skips a hardlink entry and never creates it", async () => {
    const buffer = await buildTarballGzip([
      { header: { name: `${TOP_LEVEL}/passwd-link`, type: "link", linkname: "/etc/passwd" } },
    ]);
    await extract(buffer, {}, async (rootDir, summary) => {
      expect(summary.skipped).toEqual([{ rawPath: `${TOP_LEVEL}/passwd-link`, reason: "HARDLINK" }]);
      expect(await listAllFiles(rootDir)).toEqual([]);
    });
  });

  it("does not abort the archive when a symlink is present — a real repository shape", async () => {
    const buffer = await buildTarballGzip([
      { header: { name: `${TOP_LEVEL}/` , type: "directory" } },
      { header: { name: `${TOP_LEVEL}/link-to-readme`, type: "symlink", linkname: "README.md" } },
      { header: { name: `${TOP_LEVEL}/README.md` }, content: "hello" },
    ]);
    await extract(buffer, {}, async (rootDir) => {
      expect(await fs.readFile(path.join(rootDir, "README.md"), "utf-8")).toBe("hello");
    });
  });
});

describe("extractRepositoryArchive — caps (the zip-bomb defense, §4/§15)", () => {
  it("aborts once the entry count exceeds a (small, injected) INDEX_MAX_FILE_COUNT", async () => {
    const entries: FixtureEntry[] = Array.from({ length: 10 }, (_unused, i) => ({
      header: { name: `${TOP_LEVEL}/file-${i.toString()}.txt` },
      content: "x",
    }));
    const buffer = await buildTarballGzip(entries);

    const { tempRootDir } = await (async () => {
      const tempRootDir = await makeTempRoot();
      tempRoots.push(tempRootDir);
      await expect(
        extractRepositoryArchive(toWebStream(buffer), {
          tempRootDir,
          jobId: randomUUID(),
          maxTotalBytes: 2 * 1024 ** 3,
          maxFileCount: 5,
          logger: noopLogger(),
        }, async () => undefined),
      ).rejects.toBeInstanceOf(ArchiveTooLargeError);
      return { tempRootDir };
    })();

    expect(await listAllFiles(tempRootDir)).toEqual([]);
  });

  it("aborts once cumulative decompressed bytes exceed a (small, injected) INDEX_MAX_TOTAL_BYTES — proving the check runs on the STREAM, not a buffered total", async () => {
    // 5 MB of a single repeated character compresses to almost nothing — if the cap were
    // checked against the *compressed* download size (or after fully buffering), this
    // would sail through. It must not: the counter sits between gunzip and the tar
    // parser, on the decompressed bytes.
    const highlyCompressible = "a".repeat(5 * 1024 * 1024);
    const buffer = await buildTarballGzip([{ header: { name: `${TOP_LEVEL}/huge.txt` }, content: highlyCompressible }]);
    expect(buffer.byteLength).toBeLessThan(100_000); // sanity: the fixture really is tiny on the wire

    const tempRootDir = await makeTempRoot();
    tempRoots.push(tempRootDir);
    await expect(
      extractRepositoryArchive(toWebStream(buffer), {
        tempRootDir,
        jobId: randomUUID(),
        maxTotalBytes: 1000, // far smaller than the 5 MB the entry actually decompresses to
        maxFileCount: 200_000,
        logger: noopLogger(),
      }, async () => undefined),
    ).rejects.toBeInstanceOf(ArchiveTooLargeError);
    expect(await listAllFiles(tempRootDir)).toEqual([]);
  });

  it("rejects a single entry whose declared size alone exceeds the total cap, before reading any of it", async () => {
    const buffer = await buildTarballGzip([{ header: { name: `${TOP_LEVEL}/big.bin`, size: 5000 }, content: "x".repeat(5000) }]);
    await expect(extract(buffer, { maxTotalBytes: 1000 })).rejects.toBeInstanceOf(ArchiveTooLargeError);
  });
});

describe("extractRepositoryArchive — filename hygiene (§13): allow-list, not ASCII-only", () => {
  it("accepts legitimate non-ASCII filenames — the naive ^[\\w\\-./ ]+$ regex would wrongly reject these", async () => {
    const buffer = await buildTarballGzip([
      { header: { name: `${TOP_LEVEL}/日本語.md` }, content: "japanese" },
      { header: { name: `${TOP_LEVEL}/café-résumé.ts` }, content: "french" },
      { header: { name: `${TOP_LEVEL}/Ключ.txt` }, content: "cyrillic" },
    ]);
    await extract(buffer, {}, async (rootDir, summary) => {
      expect(summary.filesWritten).toBe(3);
      expect(summary.skipped).toEqual([]);
      expect(await fs.readFile(path.join(rootDir, "日本語.md"), "utf-8")).toBe("japanese");
    });
  });

  it("accepts an ordinary space in a filename — spaces are not control characters", async () => {
    const buffer = await buildTarballGzip([{ header: { name: `${TOP_LEVEL}/my notes.txt` }, content: "x" }]);
    await extract(buffer, {}, async (rootDir, summary) => {
      expect(summary.skipped).toEqual([]);
      expect(await fs.readFile(path.join(rootDir, "my notes.txt"), "utf-8")).toBe("x");
    });
  });

  it("rejects a control character in a filename as INVALID_FILENAME, and continues with the rest of the archive", async () => {
    const buffer = await buildTarballGzip([
      { header: { name: `${TOP_LEVEL}/bad\x07name.txt` }, content: "x" },
      { header: { name: `${TOP_LEVEL}/fine.txt` }, content: "ok" },
    ]);
    await extract(buffer, {}, async (rootDir, summary) => {
      expect(summary.skipped).toEqual([{ rawPath: `${TOP_LEVEL}/bad\x07name.txt`, reason: "INVALID_FILENAME" }]);
      expect(await fs.readFile(path.join(rootDir, "fine.txt"), "utf-8")).toBe("ok");
    });
  });

  it("rejects a Windows-reserved name (CON) as INVALID_FILENAME", async () => {
    const buffer = await buildTarballGzip([{ header: { name: `${TOP_LEVEL}/CON` }, content: "x" }]);
    await extract(buffer, {}, async (_rootDir, summary) => {
      expect(summary.skipped).toEqual([{ rawPath: `${TOP_LEVEL}/CON`, reason: "INVALID_FILENAME" }]);
    });
  });

  it("still treats a genuine .. traversal as UNSAFE_ARCHIVE, not INVALID_FILENAME (the regression this suite caught)", async () => {
    const buffer = await buildTarballGzip([{ header: { name: `${TOP_LEVEL}/../../etc/passwd` }, content: "x" }]);
    await expect(extract(buffer)).rejects.toBeInstanceOf(UnsafeArchiveError);
  });
});

describe("extractRepositoryArchive — unsupported entry types are skipped, not aborted", () => {
  it("skips a fifo entry", async () => {
    const buffer = await buildTarballGzip([{ header: { name: `${TOP_LEVEL}/pipe`, type: "fifo" } }]);
    await extract(buffer, {}, async (_rootDir, summary) => {
      expect(summary.skipped).toEqual([{ rawPath: `${TOP_LEVEL}/pipe`, reason: "UNSUPPORTED_ENTRY_TYPE" }]);
    });
  });
});

describe("extractRepositoryArchive — a truncated or corrupt gzip stream fails cleanly (§15)", () => {
  it("rejects with a normal Error rather than crashing or hanging, for a truncated stream", async () => {
    const full = await buildTarballGzip([{ header: { name: `${TOP_LEVEL}/README.md` }, content: "hello world, this is a real file" }]);
    const truncated = full.subarray(0, Math.floor(full.byteLength / 2));

    const tempRootDir = await makeTempRoot();
    tempRoots.push(tempRootDir);
    await expect(
      extractRepositoryArchive(toWebStream(truncated), {
        tempRootDir,
        jobId: randomUUID(),
        maxTotalBytes: 2 * 1024 ** 3,
        maxFileCount: 200_000,
        logger: noopLogger(),
      }, async () => undefined),
    ).rejects.toBeInstanceOf(Error);
    expect(await listAllFiles(tempRootDir)).toEqual([]);
  });

  it("rejects cleanly for a stream that is not gzip at all", async () => {
    const notGzip = Buffer.from("this is not a gzip file at all, just plain text");
    await expect(extract(notGzip)).rejects.toBeInstanceOf(Error);
  });
});

describe("extractRepositoryArchive — the legitimate archive (correctness, not just safety)", () => {
  it("extracts a normal archive, stripping the top-level directory", async () => {
    const buffer = await buildTarballGzip([
      { header: { name: `${TOP_LEVEL}/`, type: "directory" } },
      { header: { name: `${TOP_LEVEL}/README.md` }, content: "# hello" },
      { header: { name: `${TOP_LEVEL}/src/index.ts` }, content: "export const x = 1;" },
    ]);

    await extract(buffer, {}, async (rootDir, summary) => {
      expect(await fs.readFile(path.join(rootDir, "README.md"), "utf-8")).toBe("# hello");
      expect(await fs.readFile(path.join(rootDir, "src/index.ts"), "utf-8")).toBe("export const x = 1;");
      // The stored path is repository-relative — the top-level component is gone.
      const files = await listAllFiles(rootDir);
      expect(files.every((f) => !f.includes(TOP_LEVEL))).toBe(true);
      expect(summary.filesWritten).toBe(2);
      expect(summary.skipped).toEqual([]);
    });
  });

  it("removes the temp directory after a successful extraction too, not only on failure", async () => {
    const buffer = await buildTarballGzip([{ header: { name: `${TOP_LEVEL}/a.txt` }, content: "a" }]);
    const { tempRootDir } = await extract(buffer, {}, async (rootDir) => {
      // The directory exists WHILE the callback runs...
      expect(await fs.readFile(path.join(rootDir, "a.txt"), "utf-8")).toBe("a");
    });
    // ...and is gone once extractRepositoryArchive's promise has settled.
    expect(await listAllFiles(tempRootDir)).toEqual([]);
  });

  it("still cleans up the temp directory when the onExtracted callback itself throws", async () => {
    const buffer = await buildTarballGzip([{ header: { name: `${TOP_LEVEL}/a.txt` }, content: "a" }]);
    const tempRootDir = await makeTempRoot();
    tempRoots.push(tempRootDir);

    await expect(
      extractRepositoryArchive(toWebStream(buffer), {
        tempRootDir,
        jobId: randomUUID(),
        maxTotalBytes: 2 * 1024 ** 3,
        maxFileCount: 200_000,
        logger: noopLogger(),
      }, async () => {
        throw new Error("caller-side failure after a clean extraction");
      }),
    ).rejects.toThrow("caller-side failure after a clean extraction");

    expect(await listAllFiles(tempRootDir)).toEqual([]);
  });
});
