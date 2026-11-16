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
import { validatePublicationRun, validateReceipt } from "./container-promote.ts";
import { ghcrPackageName, github, githubPages, repository } from "./container-release/admission.ts";
import {
  digestPattern,
  field,
  integerPattern,
  isPlatform,
  match,
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

async function selectNativeArtifact(env: NodeJS.ProcessEnv, signal: AbortSignal) {
  const { SOURCE_SHA, PUBLICATION_RUN_ID, PUBLICATION_ATTEMPT } = env;
  const runPath = `repos/${repository}/actions/runs/${PUBLICATION_RUN_ID}`;
  const run = await github(runPath, { signal });
  const workflow = await github(`repos/${repository}/actions/workflows/container-publish.yml`, {
    signal,
  });
  validatePublicationRun(run, workflow, env);
  const repo = field(run, "repository");
  assert.equal(field(repo, "private"), false, "Require a public Enterprise publication.");
  const repositoryId = field(repo, "id");
  assert.ok(
    typeof repositoryId === "number" && Number.isSafeInteger(repositoryId) && repositoryId > 0,
  );
  assert.equal(field(field(run, "head_repository"), "id"), repositoryId);

  const jobs = await githubPages(`${runPath}/attempts/${PUBLICATION_ATTEMPT}/jobs`, "jobs", signal);
  function successfulJob(name: string) {
    const matches = jobs.filter((job) => field(job, "name") === name);
    const [job] = matches;
    assert.ok(
      matches.length === 1 &&
        field(job, "head_sha") === SOURCE_SHA &&
        field(job, "status") === "completed" &&
        field(job, "conclusion") === "success",
      `Require a successful ${name} job for the original publication attempt.`,
    );
    return job;
  }
  successfulJob("Publish exact OCI digests to public GHCR");
  const smoke = successfulJob("prepare / Smoke runtime (amd64)");
  const artifactName = `platform-runtime-amd64-${PUBLICATION_RUN_ID}-${PUBLICATION_ATTEMPT}`;
  const artifacts = await githubPages(
    `${runPath}/artifacts?name=${artifactName}`,
    "artifacts",
    signal,
  );
  const matches = artifacts.filter((artifact) => field(artifact, "name") === artifactName);
  assert.equal(matches.length, 1, `Require exactly one Actions artifact named ${artifactName}.`);
  const [artifact] = matches;
  assert.equal(field(artifact, "expired"), false, "Require an unexpired native runtime artifact.");
  const producer = field(artifact, "workflow_run");
  assert.ok(
    String(field(producer, "id")) === PUBLICATION_RUN_ID &&
      field(producer, "repository_id") === repositoryId &&
      field(producer, "head_repository_id") === repositoryId &&
      field(producer, "head_branch") === "main" &&
      field(producer, "head_sha") === SOURCE_SHA,
    "The native runtime artifact is unbound to the original publication run.",
  );
  // The artifact API scopes records to the run. The name and creation time
  // bind the ZIP to the successful smoke job in the selected attempt.
  const created = Date.parse(String(field(artifact, "created_at")));
  assert.ok(
    created >= Date.parse(String(field(smoke, "started_at"))) &&
      created <= Date.parse(String(field(smoke, "completed_at"))),
    "The native runtime artifact was not uploaded during the selected smoke job.",
  );
  const id = field(artifact, "id");
  assert.ok(
    typeof id === "number" && Number.isSafeInteger(id) && id > 0,
    "Invalid native artifact ID.",
  );
  const digest = field(artifact, "digest");
  match(digest, digestPattern, "Require the GitHub Actions ZIP digest.");
  return { artifactId: String(id), artifactName, archiveSha256: digest.slice("sha256:".length) };
}

async function project(path: string, platform: Platform, signal: AbortSignal, native: boolean) {
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
  if (native) {
    assert.ok(
      Array.isArray(receipt),
      "Native selection requires an authenticated direct publication receipt and its original native preparation.",
    );
  }
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
  const artifact = native ? await selectNativeArtifact(env, signal) : undefined;

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
    const clients = downloadClients(
      metadata,
      platform === "linux/amd64" ? "x64" : "arm64",
      selection,
    );
    if (artifact) {
      return {
        sourceImage,
        platformImage,
        configDigest: selected.configDigest,
        archive: "platform.zip",
        ...artifact,
        sourceSha: SOURCE_SHA,
        workflowSha: SOURCE_SHA,
        runId: PUBLICATION_RUN_ID,
        attempt: PUBLICATION_ATTEMPT,
        ciRunId: runtime.ciRunId,
        ciAttempt: runtime.ciAttempt,
        nodeBaseImage: env.NODE_BASE_IMAGE,
      };
    }
    return { sourceImage, platformImage, platform, downloadClients: clients };
  } finally {
    try {
      await cleanup[0]?.();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

const [path, platform, mode, extra] = process.argv.slice(2);
const native = mode === "--native-selection";
assert.ok(
  path && isPlatform(platform) && (mode === undefined || native) && extra === undefined,
  "Usage: node scripts/ci/runtime-download-client-projection.ts PUBLICATION_JSON linux/amd64|linux/arm64 [--native-selection]",
);
assert.ok(!native || platform === "linux/amd64", "Native selection supports only linux/amd64.");
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
  const projection = await project(path, platform, cancellation.signal, native);
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
