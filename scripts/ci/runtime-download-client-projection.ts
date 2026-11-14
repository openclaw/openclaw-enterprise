import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  extractImageFile,
  type ImageFileArchiveOptions,
  type ImageFileCleanup,
  type ImageFileTextOptions,
} from "../lib/image-file.ts";
import { readReleaseDownloadClientSelection } from "../lib/runtime-download-clients.ts";
import { validateReceipt } from "./container-promote.ts";
import { ghcrPackageName } from "./container-release/admission.ts";
import {
  digestPattern,
  integerPattern,
  isPlatform,
  platforms,
  shaPattern,
  type Platform,
} from "./container-release/metadata.ts";

const execute = promisify(execFile);
const maxMetadataBytes = 64 * 1024;
const binaryDigest = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readReceipt(path: string): Promise<unknown> {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants;
  const file = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = await file.stat();
    assert.ok(
      stat.isFile() && stat.size <= maxMetadataBytes,
      "Publication receipt must be a regular file of at most 64 KiB.",
    );
    const bytes = Buffer.alloc(maxMetadataBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    assert.equal(length, stat.size, "Publication receipt size changed during read.");
    return JSON.parse(bytes.toString("utf8", 0, length));
  } finally {
    await file.close();
  }
}

function downloadClients(metadata: unknown, architecture: string, selection: Map<string, string>) {
  assert.ok(
    isRecord(metadata) && metadata.platform === "linux" && metadata.architecture === architecture,
    "Runtime provenance platform differs from the selected image.",
  );
  const recorded = metadata.downloadClients;
  assert.ok(isRecord(recorded), "Runtime image has no download client provenance.");
  assert.equal(
    Object.keys(recorded).length,
    selection.size,
    "Runtime client count differs from the release selection.",
  );
  const resolved = new Map<string, string>();
  return Object.fromEntries(
    [...selection].map(([installed, expected]) => {
      const client = recorded[installed];
      assert.ok(isRecord(client), `Missing runtime download client provenance for ${installed}.`);
      const { resolvedBinary, binarySha256 } = client;
      assert.equal(
        resolvedBinary,
        expected,
        `Runtime download client resolves to an unexpected path: ${installed}`,
      );
      assert.ok(
        typeof binarySha256 === "string" && binaryDigest.test(binarySha256),
        `Invalid executable SHA-256 for ${installed}.`,
      );
      const existing = resolved.get(expected);
      assert.ok(
        existing === undefined || existing === binarySha256,
        "Executable aliases disagree.",
      );
      resolved.set(expected, binarySha256);
      return [installed, { resolvedBinary, binarySha256 }];
    }),
  );
}

async function project(path: string, platform: Platform, signal: AbortSignal) {
  const env = process.env;
  const { SOURCE_SHA, PUBLICATION_RUN_ID, PUBLICATION_ATTEMPT, GHCR_RUNTIME_IMAGE } = env;
  assert.ok(SOURCE_SHA, "Select the exact publication source SHA.");
  assert.match(SOURCE_SHA, shaPattern, "Select the exact publication source SHA.");
  assert.match(PUBLICATION_RUN_ID ?? "", integerPattern, "Select the exact publication run ID.");
  assert.match(PUBLICATION_ATTEMPT ?? "", integerPattern, "Select the exact publication attempt.");
  ghcrPackageName(GHCR_RUNTIME_IMAGE);

  // The operator selects a receipt already authenticated against the release workflow.
  // Matching fields here prevents mixing receipts, images and platform variants.
  const receipt = await readReceipt(path);
  validateReceipt(receipt, env);
  const runtime = receipt[1];
  assert.equal(
    runtime.destination,
    GHCR_RUNTIME_IMAGE,
    "Publication runtime repository differs from configuration.",
  );
  assert.ok(Array.isArray(runtime.platformDigests), "Require sealed platform identities.");
  const rows = runtime.platformDigests.map((row: unknown) => {
    assert.ok(isRecord(row), "Invalid sealed runtime platform identity.");
    const { platform, digest, configDigest } = row;
    assert.ok(
      isPlatform(platform) &&
        typeof digest === "string" &&
        digestPattern.test(digest) &&
        typeof configDigest === "string" &&
        digestPattern.test(configDigest),
      "Invalid sealed runtime platform identity.",
    );
    return { platform, digest, configDigest };
  });
  assert.deepEqual(rows.map((row) => row.platform).sort(), platforms);
  const selected = rows.find((row) => row.platform === platform);
  assert.ok(selected, "Require a seal for the selected platform.");
  const sourceImage = `${GHCR_RUNTIME_IMAGE}@${runtime.digest}`;
  const platformImage = `${GHCR_RUNTIME_IMAGE}@${selected.digest}`;

  const commandEnv = { ...env };
  delete commandEnv.GH_TOKEN;
  delete commandEnv.GITHUB_TOKEN;
  const selection = await readReleaseDownloadClientSelection(SOURCE_SHA, {
    env: commandEnv,
    signal,
  });
  const verifier = fileURLToPath(new URL("../upgrade-image-identity.py", import.meta.url));
  const { stdout } = await execute(
    "python3",
    ["-I", "-S", verifier, sourceImage, platform, SOURCE_SHA],
    {
      env: commandEnv,
      encoding: "utf8",
      maxBuffer: maxMetadataBytes,
      timeout: 180_000,
      signal,
    },
  );
  const identity: unknown = JSON.parse(stdout);
  assert.deepEqual(
    identity,
    {
      image: sourceImage,
      platform,
      rootDigest: runtime.digest,
      manifestDigest: selected.digest,
      configDigest: selected.configDigest,
    },
    "Staged runtime image differs from the publication platform seal.",
  );

  const directory = await mkdtemp(join(tmpdir(), "oce-runtime-download-clients-"));
  const cleanup: ImageFileCleanup[] = [];
  function command(
    executable: "docker",
    args: string[],
    options: ImageFileArchiveOptions,
  ): Promise<Buffer>;
  function command(
    executable: "docker",
    args: string[],
    options?: ImageFileTextOptions,
  ): Promise<string>;
  async function command(
    executable: "docker",
    args: string[],
    options: ImageFileTextOptions | ImageFileArchiveOptions = {},
  ): Promise<string | Buffer> {
    const limits = {
      env: commandEnv,
      timeout: 30_000,
      maxBuffer: maxMetadataBytes,
      // Cleanup passes its own deadline and can reconcile an interrupted create.
      signal,
      ...options,
    };
    return options.encoding === "buffer"
      ? (await execute(executable, args, { ...limits, encoding: "buffer" })).stdout
      : (await execute(executable, args, { encoding: "utf8", ...limits })).stdout;
  }
  try {
    signal.throwIfAborted();
    const destination = join(directory, "provenance.json");
    await extractImageFile({
      command,
      cleanup,
      image: sourceImage,
      platform,
      pullNever: true,
      filename: "/opt/oce/runtime/provenance.json",
      destination,
      maxBytes: maxMetadataBytes,
    });
    const metadata: unknown = JSON.parse(await readFile(destination, { encoding: "utf8", signal }));
    return {
      sourceImage,
      platformImage,
      platform,
      downloadClients: downloadClients(
        metadata,
        platform === "linux/amd64" ? "x64" : "arm64",
        selection,
      ),
    };
  } finally {
    try {
      await cleanup[0]?.();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

const [path, platform, extra] = process.argv.slice(2);
assert.ok(
  path && isPlatform(platform) && extra === undefined,
  "Usage: node scripts/ci/runtime-download-client-projection.ts PUBLICATION_JSON linux/amd64|linux/arm64",
);
const cancellation = new AbortController();
const interrupt = (signal: NodeJS.Signals) => {
  if (!cancellation.signal.aborted) {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    cancellation.abort(new Error(`Interrupted by ${signal}.`));
  }
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
  const projection = await project(path, platform, cancellation.signal);
  cancellation.signal.throwIfAborted();
  process.stdout.write(`${JSON.stringify(projection, null, 2)}\n`);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Runtime download client projection failed.",
  );
  process.exitCode ??= 1;
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
