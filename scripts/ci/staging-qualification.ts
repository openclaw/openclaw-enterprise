import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validatePublicationRun, validateReceipt } from "./container-promote.ts";
import {
  github,
  githubPages,
  ghcrPackageName,
  repository,
  validateCi,
  validateContext,
} from "./container-release.mjs";
import { loadTestSuites } from "./test-suites.mjs";

const env = process.env;
// Staging communicates through receipt files, never Actions command files.
delete env.GITHUB_OUTPUT;
const workflow = ".github/workflows/staging-qualification.yml";
const maxReceiptBytes = 64 * 1024;
const startupFiles = [
  ["images-packaging", "tests/integration/production-image-startup.test.mjs"],
  ["images-runtime-startup", "tests/integration/runtime-image-startup.test.mjs"],
] as const;

function decimal(value: unknown): string {
  assert.ok(typeof value === "string" && /^[1-9][0-9]*$/.test(value));
  const id = Number(value);
  assert.ok(Number.isSafeInteger(id), "Require a positive safe decimal ID.");
  const canonical = id.toString(10);
  assert.equal(canonical, value, "Require a canonical decimal ID.");
  return canonical;
}

function subprocessEnv() {
  const clean = { ...env };
  delete clean.GH_TOKEN;
  delete clean.GITHUB_TOKEN;
  delete clean.GITHUB_OUTPUT;
  return clean;
}

function git(
  root: string,
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return execFileSync("git", args, {
    cwd: root,
    env: { ...subprocessEnv(), ...options.env },
    input: options.input,
    encoding: "utf8",
    maxBuffer: 128 * 1024,
    timeout: 30_000,
  });
}

function requireMainCommit(root: string, sha: string) {
  const objectType = () =>
    git(root, ["cat-file", "--batch-check=%(objecttype)"], {
      input: `${sha}\n`,
      env: { GIT_NO_LAZY_FETCH: "1" },
    }).trim();
  let type = objectType();
  if (type === `${sha} missing`) {
    // Main may advance after checkout. Fetch its observed commit and ancestry
    // without moving a ref or bringing in trees or blobs.
    const officialOrigin = `https://github.com/${repository}.git`;
    assert.equal(
      git(root, ["ls-remote", "--get-url", officialOrigin]).trim(),
      officialOrigin,
      "Git must use the official repository URL.",
    );
    git(
      root,
      [
        // Set both for this command so Git does not persist a promisor remote.
        "-c",
        `remote.${officialOrigin}.promisor=true`,
        "-c",
        `remote.${officialOrigin}.partialclonefilter=tree:0`,
        "-c",
        "credential.helper=",
        "-c",
        "http.extraHeader=",
        "-c",
        "http.followRedirects=false",
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-auto-maintenance",
        "--no-recurse-submodules",
        "--refmap=",
        "--filter=tree:0",
        officialOrigin,
        sha,
      ],
      { env: { GIT_TERMINAL_PROMPT: "0" } },
    );
    type = objectType();
  }
  assert.equal(type, "commit", "The observed main SHA must identify a commit.");
}

async function trustedSource(sourceSha = env.SOURCE_SHA) {
  assert.match(sourceSha ?? "", /^[a-f0-9]{40}$/);
  assert.equal(sourceSha?.length, 40);
  assert.match(env.GITHUB_WORKFLOW_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_WORKFLOW_SHA?.length, 40);
  assert.ok(env.GITHUB_WORKSPACE);
  const root = await realpath(env.GITHUB_WORKSPACE);
  assert.equal(await realpath(process.cwd()), root);
  assert.equal(git(root, ["rev-parse", "--show-toplevel"]).trim(), root);
  assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), env.GITHUB_WORKFLOW_SHA);
  assert.equal(
    git(root, ["status", "--porcelain", "--untracked-files=no"]),
    "",
    "Trusted checkout has tracked changes.",
  );
  git(root, ["merge-base", "--is-ancestor", env.GITHUB_WORKFLOW_SHA!, "refs/remotes/origin/main"]);
  git(root, ["merge-base", "--is-ancestor", sourceSha!, env.GITHUB_WORKFLOW_SHA!]);
  return root;
}

async function releaseProfile(root: string, sourceSha = env.SOURCE_SHA) {
  // Historical objects are data only. Never check out or import release code.
  const entry = git(root, ["ls-tree", sourceSha!, "--", "deploy/runtime/Dockerfile"]);
  const match = /^100644 blob ([a-f0-9]{40})\tdeploy\/runtime\/Dockerfile\n$/.exec(entry);
  const blob = match?.[1];
  assert.ok(blob && match?.[0] === entry, "Require one ordinary runtime Dockerfile blob.");
  assert.equal(git(root, ["cat-file", "-t", blob]), "blob\n");
  const size = Number(decimal(git(root, ["cat-file", "-s", blob]).trim()));
  assert.ok(size <= 64 * 1024, "Runtime recipe exceeds 64 KiB.");
  const recipe = git(root, ["cat-file", "blob", blob]);
  assert.equal(Buffer.byteLength(recipe), size);
  const field = (name: string) => {
    const values = [...recipe.matchAll(new RegExp(`^(?:ARG|ENV) ${name}=(.*)$`, "gm"))];
    const value = values[0]?.[1];
    assert.ok(values.length === 1 && value, `Require one literal ${name}.`);
    return value;
  };
  const nodeBaseImage = field("NODE_BASE_IMAGE");
  const codexVersion = field("OPENAI_CODEX_VERSION");
  assert.match(nodeBaseImage, /^docker\.io\/library\/node:24[.-][a-z0-9.-]+@sha256:[a-f0-9]{64}$/);
  const hash = createHash("sha256").update(recipe).digest("hex");
  if (codexVersion === "0.163.0-alpha.2") {
    assert.equal(sourceSha, "54bfa7fc1b99e362450beb5f9211e164991fa7b4");
    assert.equal(hash, "12d579bc223c90d7b3392651b986ed0ac33b5f7e1954bc2344a38190a2f9a8b5");
  } else {
    assert.equal(codexVersion, "0.164.0", "Unsupported release profile; refuse before pull.");
    assert.equal(
      recipe,
      await readFile(join(root, "deploy/runtime/Dockerfile"), "utf8"),
      "Unreviewed historical runtime recipe.",
    );
  }
  const suites = loadTestSuites(join(root, "scripts/ci/test-suites.json"));
  assert.equal(nodeBaseImage, suites.lanes["images-packaging"].prepare.defaultEnv.NODE_BASE_IMAGE);
  return { nodeBaseImage, codexVersion };
}

async function producer(
  selection = {
    SOURCE_SHA: env.SOURCE_SHA,
    PUBLICATION_RUN_ID: env.PUBLICATION_RUN_ID,
    PUBLICATION_ATTEMPT: env.PUBLICATION_ATTEMPT,
  },
) {
  decimal(selection.PUBLICATION_RUN_ID);
  decimal(selection.PUBLICATION_ATTEMPT);
  const root = await trustedSource(selection.SOURCE_SHA);
  assert.match(env.STAGING_INSTALLATION ?? "", /^[a-z][a-z0-9-]{0,62}$/);
  assert.equal(
    env.STAGING_INSTALLATION,
    env.CONFIGURED_STAGING_INSTALLATION,
    "Select the configured staging installation.",
  );
  validateContext(
    { ...env, SOURCE_SHA: selection.SOURCE_SHA },
    await github(`repos/${repository}`),
    workflow,
  );
  const main = await github(`repos/${repository}/branches/main`);
  assert.equal(main.name, "main");
  assert.equal(main.protected, true, "Main must be protected.");
  assert.match(main.commit?.sha ?? "", /^[a-f0-9]{40}$/);
  assert.equal(main.commit.sha.length, 40);
  requireMainCommit(root, main.commit.sha);
  git(root, ["merge-base", "--is-ancestor", env.GITHUB_WORKFLOW_SHA!, main.commit.sha]);
  const profile = await releaseProfile(root, selection.SOURCE_SHA);
  const run = await github(`repos/${repository}/actions/runs/${selection.PUBLICATION_RUN_ID}`);
  const definition = await github(`repos/${repository}/actions/workflows/container-publish.yml`);
  validatePublicationRun(run, definition, selection);
  const jobs = await githubPages(
    `repos/${repository}/actions/runs/${selection.PUBLICATION_RUN_ID}/attempts/${selection.PUBLICATION_ATTEMPT}/jobs`,
    "jobs",
  );
  const publish = jobs.filter(
    (job: { name: string }) => job.name === "Publish exact OCI digests to public GHCR",
  );
  assert.equal(publish.length, 1, "Require the exact image publication job.");
  assert.equal(publish[0].head_sha, selection.SOURCE_SHA);
  assert.equal(publish[0].status, "completed");
  assert.equal(publish[0].conclusion, "success", "The image publication job must succeed.");
  const artifacts = await githubPages(
    `repos/${repository}/actions/runs/${selection.PUBLICATION_RUN_ID}/artifacts`,
    "artifacts",
  );
  const matches = artifacts.filter(
    (artifact: { name: string }) =>
      artifact.name ===
      `container-publication-${selection.PUBLICATION_RUN_ID}-${selection.PUBLICATION_ATTEMPT}`,
  );
  assert.equal(matches.length, 1, "Require the exact publication artifact.");
  const artifact = matches[0];
  assert.equal(artifact.expired, false);
  assert.equal(String(artifact.workflow_run?.id), selection.PUBLICATION_RUN_ID);
  assert.equal(artifact.workflow_run?.head_sha, selection.SOURCE_SHA);
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0, "Require a numeric artifact ID.");
  const artifactId = Number(artifact.id).toString(10);
  assert.match(artifact.digest ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.ok(
    Number.isSafeInteger(artifact.size_in_bytes) &&
      artifact.size_in_bytes > 0 &&
      artifact.size_in_bytes <= 1024 * 1024,
    "Publication archive exceeds 1 MiB.",
  );
  return {
    root,
    selection,
    artifact: { digest: artifact.digest, size_in_bytes: artifact.size_in_bytes },
    artifactId,
    profile,
  };
}

// Check publication eligibility before either archive is downloaded. This does not qualify
// the images, migration catalog, or behavior of the installed controller pair.
async function validatePair() {
  const previous = {
    SOURCE_SHA: env.PREVIOUS_SOURCE_SHA,
    PUBLICATION_RUN_ID: env.PREVIOUS_PUBLICATION_RUN_ID,
    PUBLICATION_ATTEMPT: env.PREVIOUS_PUBLICATION_ATTEMPT,
  };
  assert.ok(
    Object.values(previous).every((value) => value !== undefined && value !== ""),
    "Select the full previous source SHA, publication run ID and attempt.",
  );
  assert.notEqual(previous.SOURCE_SHA, env.SOURCE_SHA, "Select two distinct release sources.");
  assert.notEqual(
    previous.PUBLICATION_RUN_ID,
    env.PUBLICATION_RUN_ID,
    "Select two distinct publications.",
  );
  const predecessor = await producer(previous);
  const candidate = await producer();
  git(candidate.root, ["merge-base", "--is-ancestor", previous.SOURCE_SHA!, env.SOURCE_SHA!]);
  return { previous: predecessor, candidate };
}

async function publicationReceipt(
  directory: string,
  artifact: { digest: string; size_in_bytes: number },
) {
  assert.ok((await lstat(directory)).isDirectory());
  const entries = await readdir(directory);
  const [name] = entries;
  assert.ok(entries.length === 1 && name, "Require exactly one publication archive.");
  assert.ok(name.length <= 128 && !/[^a-zA-Z0-9._-]/.test(name), "Require a plain archive name.");
  const file = await open(
    join(directory, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes: Buffer;
  try {
    const stat = await file.stat();
    assert.ok(stat.isFile(), "Publication archive must be a regular file.");
    assert.equal(stat.size, artifact.size_in_bytes);
    // An extra byte detects growth between stat and read without unbounded I/O.
    const buffer = Buffer.alloc(artifact.size_in_bytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length);
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    assert.equal(length, artifact.size_in_bytes, "Publication archive size changed during read.");
    bytes = buffer.subarray(0, length);
  } finally {
    await file.close();
  }
  assert.equal(
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    artifact.digest,
    "Publication archive digest mismatch.",
  );
  // Give the decoder the authenticated snapshot and no pathname to reopen.
  const decoded = spawnSync(
    "python3",
    [
      "-I",
      "-S",
      "-c",
      `
import io
import stat
import sys
import zipfile

limit = ${maxReceiptBytes}
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    entries = archive.infolist()
    if len(entries) != 1:
        sys.exit(1)
    entry = entries[0]
    if (entry.orig_filename != "publication.json"
        or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
        or stat.S_IFMT(entry.external_attr >> 16) not in (0, stat.S_IFREG)):
        sys.exit(1)
    size = entry.file_size
    if size > limit:
        sys.exit(1)
    # ZipFile otherwise stops at the size claimed in the central directory.
    entry.file_size = limit + 1
    with archive.open(entry) as member:
        data = member.read(limit + 1)
    if len(data) != size:
        sys.exit(1)
    sys.stdout.buffer.write(data)
`,
    ],
    {
      env: subprocessEnv(),
      input: bytes,
      encoding: "utf8",
      maxBuffer: maxReceiptBytes,
      timeout: 10_000,
    },
  );
  assert.ok(
    !decoded.error && decoded.status === 0,
    "Publication archive must contain only publication.json, at most 64 KiB when decoded.",
  );
  try {
    return JSON.parse(decoded.stdout);
  } catch {
    throw new Error("Publication receipt must be valid JSON.");
  }
}

async function receiptCi(
  sourceSha: string,
  { ciRunId, ciAttempt }: { ciRunId: string; ciAttempt: string },
) {
  // The receipt can match service identities, but cannot select an API path.
  const runs = await githubPages(
    `repos/${repository}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&head_sha=${sourceSha}`,
    "workflow_runs",
  );
  const matches = runs.filter(
    (run: { id: number; run_attempt: number }) =>
      String(run.id) === ciRunId && String(run.run_attempt) === ciAttempt,
  );
  assert.equal(matches.length, 1, "Receipt CI identity is not bound to a service run.");
  const candidate = matches[0];
  const id = decimal(String(candidate.id));
  const attempt = decimal(String(candidate.run_attempt));
  const definition = await github(`repos/${repository}/actions/workflows/ci.yml`);
  assert.equal(candidate.repository?.full_name, repository);
  assert.equal(candidate.head_repository?.full_name, repository);
  assert.equal(candidate.head_branch, "main");
  assert.equal(candidate.head_sha, sourceSha);
  assert.equal(candidate.event, "push");
  assert.equal(candidate.status, "completed");
  assert.equal(candidate.conclusion, "success");
  assert.equal(candidate.workflow_id, definition.id);
  assert.equal(candidate.path, ".github/workflows/ci.yml");
  const run = await github(`repos/${repository}/actions/runs/${id}`);
  const jobs = await githubPages(
    `repos/${repository}/actions/runs/${id}/attempts/${attempt}/jobs`,
    "jobs",
  );
  validateCi(run, definition, jobs, sourceSha, id, attempt);
}

type PlatformSeal = { manifestDigest: string; configDigest: string };

function amd64Seal(rows: unknown): PlatformSeal {
  assert.ok(
    Array.isArray(rows) && rows.length === 2,
    "Pair staging requires sealed platform identities.",
  );
  assert.deepEqual(rows.map((row) => row?.platform).sort(), ["linux/amd64", "linux/arm64"]);
  const row = rows.find((item) => item?.platform === "linux/amd64");
  for (const digest of [row?.digest, row?.configDigest]) {
    assert.ok(
      typeof digest === "string" && digest.length === 71 && /^sha256:[a-f0-9]{64}$/.test(digest),
      "Invalid sealed platform digest.",
    );
  }
  return { manifestDigest: row.digest, configDigest: row.configDigest };
}

async function verifiedPublication(
  path: string,
  publication: Awaited<ReturnType<typeof producer>>,
  requireSeals: readonly string[] = [],
) {
  const { artifact, artifactId, profile, selection } = publication;
  const sourceSha = selection.SOURCE_SHA;
  assert.ok(sourceSha);
  const receipt = await publicationReceipt(path, artifact);
  validateReceipt(receipt, { ...selection, NODE_BASE_IMAGE: profile.nodeBaseImage });
  await receiptCi(sourceSha, receipt[0]);
  const selected: Record<string, string> = {};
  const seals: Record<string, PlatformSeal> = {};
  // Trust configured destinations only. Never pull a receipt-selected repository or mutable tag.
  for (const image of receipt) {
    const configured = env[`GHCR_${image.image.toUpperCase()}_IMAGE`];
    ghcrPackageName(configured);
    assert.equal(
      image.destination,
      configured,
      "Publication destination differs from configuration.",
    );
    selected[image.image] = `${configured}@${image.digest}`;
    if (requireSeals.includes(image.image)) {
      seals[image.image] = amd64Seal(image.platformDigests);
    }
  }
  return {
    sourceSha,
    publicationRunId: selection.PUBLICATION_RUN_ID,
    publicationAttempt: selection.PUBLICATION_ATTEMPT,
    artifactId,
    artifactDigest: artifact.digest,
    ciRunId: receipt[0].ciRunId,
    ciAttempt: receipt[0].ciAttempt,
    ...profile,
    selected,
    ...(requireSeals.length ? { seals } : {}),
  };
}

async function verifiedPair(previousPath: string, candidatePath: string, forPull: boolean) {
  const pair = await validatePair();
  const previous = await verifiedPublication(
    previousPath,
    pair.previous,
    forPull ? ["controller", "runtime"] : [],
  );
  const candidate = await verifiedPublication(
    candidatePath,
    pair.candidate,
    forPull ? ["controller"] : [],
  );
  assert.notEqual(
    previous.selected.controller,
    candidate.selected.controller,
    "Require distinct controller digests.",
  );
  return { previous, candidate };
}

async function verifyPair(previousPath: string, candidatePath: string, directory: string) {
  const { previous, candidate } = await verifiedPair(previousPath, candidatePath, false);
  // Keep the incumbent runtime fixed throughout this controller-only transition.
  await writeFile(
    join(directory, "staging-pair-inputs.json"),
    JSON.stringify({
      kind: "publication-pair-inputs",
      installation: env.STAGING_INSTALLATION,
      workflowSha: env.GITHUB_WORKFLOW_SHA,
      previous,
      candidate,
      fixedRuntime: previous.selected.runtime,
    }) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}

async function pullReferences(references: readonly string[], directory: string) {
  const actor = env.GITHUB_ACTOR;
  const token = env.GH_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  assert.ok(actor, "GITHUB_ACTOR is required for GHCR package read access.");
  assert.ok(token, "GH_TOKEN is required for GHCR package read access.");
  const dockerConfig = await mkdtemp(join(directory, "staging-docker-"));
  try {
    await writeFile(
      join(dockerConfig, "config.json"),
      JSON.stringify({
        auths: { "ghcr.io": { auth: Buffer.from(`${actor}:${token}`).toString("base64") } },
      }),
      { mode: 0o600 },
    );
    for (const reference of references) {
      try {
        execFileSync(
          "docker",
          [
            "--config",
            dockerConfig,
            "--host=unix:///var/run/docker.sock",
            "pull",
            "--platform",
            "linux/amd64",
            reference,
          ],
          { stdio: "ignore", env: { PATH: env.PATH } },
        );
      } catch {
        throw new Error(
          `Unable to pull ${reference}. Check GHCR package read access and image availability.`,
        );
      }
    }
  } finally {
    await rm(dockerConfig, { recursive: true, force: true });
  }
}

function stagedInput(
  publication: Awaited<ReturnType<typeof verifiedPublication>>,
  name: "controller" | "runtime",
) {
  const reference = publication.selected[name];
  const seal = publication.seals?.[name];
  assert.ok(reference && seal, "Missing selected image or platform seal.");
  return { reference, revision: publication.sourceSha, ...seal };
}

async function pullPair(previousPath: string, candidatePath: string, directory: string) {
  const pair = await verifiedPair(previousPath, candidatePath, true);
  const previousController = stagedInput(pair.previous, "controller");
  const candidateController = stagedInput(pair.candidate, "controller");
  const fixedRuntime = stagedInput(pair.previous, "runtime");
  assert.notEqual(
    previousController.manifestDigest,
    candidateController.manifestDigest,
    "Controller platform manifests must differ.",
  );
  assert.notEqual(
    previousController.configDigest,
    candidateController.configDigest,
    "Controller platform configs must differ.",
  );
  await pullReferences(
    [previousController.reference, candidateController.reference, fixedRuntime.reference],
    directory,
  );

  let images;
  const localConfig = await mkdtemp(join(directory, "staging-inspect-"));
  try {
    // Inspection runs after registry credentials are removed, on the same local Docker socket.
    const localEnv = {
      PATH: env.PATH,
      HOME: localConfig,
      DOCKER_CONFIG: localConfig,
      DOCKER_HOST: "unix:///var/run/docker.sock",
    };
    const observe = (input: ReturnType<typeof stagedInput>) => {
      const platform = "linux/amd64";
      const rootDigest = input.reference.split("@")[1];
      const [image] = JSON.parse(
        execFileSync("docker", ["image", "inspect", "--platform", platform, input.reference], {
          env: localEnv,
          encoding: "utf8",
          timeout: 30_000,
        }),
      );
      assert.ok(
        image?.Descriptor?.digest,
        "A platform descriptor is required for installed qualification.",
      );
      assert.equal(
        image.Config?.Labels?.["org.opencontainers.image.revision"],
        input.revision,
        "Pulled platform revision differs from publication.",
      );
      const identity = JSON.parse(
        execFileSync(
          "python3",
          ["-I", "scripts/upgrade-image-identity.py", input.reference, platform, input.revision],
          {
            env: localEnv,
            encoding: "utf8",
            timeout: 220_000,
          },
        ),
      );
      assert.deepEqual(
        identity,
        {
          image: input.reference,
          platform,
          rootDigest,
          manifestDigest: input.manifestDigest,
          configDigest: input.configDigest,
        },
        "Local platform identity differs from the publication seal.",
      );
      return { ...input, platform, rootDigest };
    };
    images = {
      kind: "staged-controller-pair",
      installation: env.STAGING_INSTALLATION,
      workflowSha: env.GITHUB_WORKFLOW_SHA,
      previousController: observe(previousController),
      candidateController: observe(candidateController),
      fixedRuntime: observe(fixedRuntime),
    };
  } finally {
    await rm(localConfig, { recursive: true, force: true });
  }
  const payload = JSON.stringify(images) + "\n";
  await writeFile(join(directory, "staging-pair-images.json"), payload, {
    flag: "wx",
    mode: 0o600,
  });
  return createHash("sha256").update(payload).digest("hex");
}

// This main revision binds the current v3 reader and migration catalog. Both
// releases must retain these production inputs; labels alone cannot establish
// compatibility. Historical v2-to-v3 qualification needs a separately reviewed pair.
const signinReferences = [
  { source: "7e1ac6d88e3893c3d4e6444fb3b9b9776519a3fb", version: 3 },
] as const;

function signinBuildInputs(root: string, revision: string) {
  // Superset of the COPY sources for the reviewed production Dockerfile target.
  // CI helpers are not copied into that target. A recipe or target change here
  // is unclassified until its build inputs and installed contract are reviewed.
  const projection = git(root, [
    "ls-tree",
    revision,
    "--",
    "Dockerfile",
    "Dockerfile.dockerignore",
    ".dockerignore",
    ".gitattributes",
    ".github/workflows/container-check.yml",
    "LICENSE",
    "apps",
    "packages",
    "deploy/presets",
    "migrations",
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "scripts/build-console-metadata.mjs",
    "scripts/migrate-production.mjs",
    "scripts/migration-history.mjs",
    "scripts/migration-catalog.mjs",
    "scripts/bootstrap-installation.mjs",
    "scripts/auth-maintain.mjs",
    "scripts/auth-maintain.ts",
    "scripts/lib",
    "scripts/production-healthcheck.mjs",
  ]);
  return createHash("sha256").update(projection).digest("hex");
}

async function signinPlan(directory: string, producedHash: string | undefined) {
  assert.ok(
    producedHash?.length === 64 && /^[a-f0-9]{64}$/.test(producedHash),
    "Require the digest returned by this job's successful pull.",
  );
  assert.ok(
    !env.GH_TOKEN && !env.GITHUB_TOKEN,
    "Do not pass registry credentials to the installed harness.",
  );
  const previousSha = env.PREVIOUS_SOURCE_SHA;
  const currentSha = env.SOURCE_SHA;
  assert.ok(
    previousSha && currentSha && previousSha !== currentSha,
    "Select two controller sources.",
  );
  const root = await trustedSource(currentSha);
  await trustedSource(previousSha);
  git(root, ["merge-base", "--is-ancestor", previousSha, currentSha]);
  assert.ok(
    env.STAGING_INSTALLATION && env.STAGING_INSTALLATION === env.CONFIGURED_STAGING_INSTALLATION,
    "Require the selected staging installation.",
  );
  const imagesPath = join(directory, "staging-pair-images.json");
  const handle = await open(
    imagesPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    assert.ok(
      stat.isFile() && stat.size > 0 && stat.size <= 16 * 1024,
      "Invalid job-owned image receipt.",
    );
    const buffer = Buffer.alloc(16 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer);
    assert.equal(bytesRead, stat.size);
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    producedHash,
    "Staged receipt differs from this job's pull.",
  );
  const images = JSON.parse(bytes.toString("utf8"));
  assert.equal(images.kind, "staged-controller-pair");
  assert.equal(images.workflowSha, env.GITHUB_WORKFLOW_SHA);
  assert.equal(images.installation, env.STAGING_INSTALLATION);
  for (const [image, revision, repositoryName] of [
    [images.previousController, previousSha, env.GHCR_CONTROLLER_IMAGE],
    [images.candidateController, currentSha, env.GHCR_CONTROLLER_IMAGE],
    [images.fixedRuntime, previousSha, env.GHCR_RUNTIME_IMAGE],
  ]) {
    ghcrPackageName(repositoryName);
    assert.equal(image.revision, revision);
    assert.equal(image.platform, "linux/amd64");
    for (const digest of [image.rootDigest, image.manifestDigest, image.configDigest]) {
      assert.ok(
        typeof digest === "string" && digest.length === 71 && /^sha256:[a-f0-9]{64}$/.test(digest),
      );
    }
    assert.equal(image.reference, repositoryName + "@" + image.rootDigest);
  }
  for (const key of ["rootDigest", "manifestDigest", "configDigest"]) {
    assert.notEqual(images.previousController[key], images.candidateController[key]);
  }

  const known = signinReferences.map(({ source, version }) => ({
    source,
    version,
    digest: signinBuildInputs(root, source),
  }));
  const select = (source: string) => {
    const digest = signinBuildInputs(root, source);
    const origin = known.find((entry) => entry.digest === digest);
    assert.ok(
      origin,
      "Unclassified sign-in reader: review the changed controller inputs before running this case.",
    );
    return { source, version: origin.version, reviewedSource: origin.source, buildInputs: digest };
  };
  const previous = select(previousSha);
  const candidate = select(currentSha);
  assert.equal(candidate.version, 3, "Select an activated candidate.");
  const reference = signinReferences[0].source;
  const tree = (source: string) => git(root, ["rev-parse", source + ":migrations"]).trim();
  const migrationTree = tree(reference);
  assert.equal(tree(previousSha), migrationTree);
  assert.equal(tree(currentSha), migrationTree);
  const manifestPath = reference + ":migrations/meta/_canonical-history.json";
  const catalogManifest = JSON.parse(git(root, ["cat-file", "blob", manifestPath]));
  const plan = {
    kind: "signin-rehearsal-expectations",
    fixture: "v3-to-v3",
    previous,
    candidate,
    migrationTree,
    catalogManifest,
    stagedImagesSha256: producedHash,
    workflowSha: env.GITHUB_WORKFLOW_SHA,
    installation: env.STAGING_INSTALLATION,
  };
  const payload = JSON.stringify(plan) + "\n";
  await writeFile(join(directory, "staging-signin-plan.json"), payload, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(createHash("sha256").update(payload).digest("hex"));
}

async function pull(path: string, directory: string) {
  const publication = await verifiedPublication(path, await producer());
  const { selected } = publication;
  await pullReferences(Object.values(selected), directory);
  const ids: Record<string, string> = {};
  for (const [name, reference] of Object.entries(selected)) {
    const [image] = JSON.parse(
      execFileSync("docker", ["image", "inspect", reference], { encoding: "utf8" }),
    );
    assert.ok(image.RepoDigests.includes(reference), "Pulled image digest differs from selection.");
    assert.equal(image.Os, "linux");
    assert.equal(image.Architecture, "amd64");
    assert.equal(image.Config.Labels["org.opencontainers.image.revision"], env.SOURCE_SHA);
    assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
    ids[name] = image.Id;
  }
  await writeFile(
    join(directory, "staging-pulled-images.json"),
    JSON.stringify({
      qualification: "container-startup",
      installation: env.STAGING_INSTALLATION,
      ...publication,
      workflowSha: env.GITHUB_WORKFLOW_SHA,
      imageIds: ids,
      liveInstall: false,
    }),
    { flag: "wx", mode: 0o600 },
  );
}

async function smoke(directory: string) {
  assert.ok(!env.GH_TOKEN && !env.GITHUB_TOKEN, "Startup must run without the GitHub token.");
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const proof = JSON.parse(await readFile(join(directory, "staging-pulled-images.json"), "utf8"));
  assert.equal(proof.sourceSha, env.SOURCE_SHA);
  assert.equal(proof.workflowSha, env.GITHUB_WORKFLOW_SHA);
  const root = await trustedSource();
  const profile = await releaseProfile(root);
  assert.equal(proof.codexVersion, profile.codexVersion);
  assert.equal(proof.nodeBaseImage, profile.nodeBaseImage);
  for (const id of Object.values(proof.imageIds)) {
    assert.match(String(id), /^sha256:[a-f0-9]{64}$/);
    const [image] = JSON.parse(
      execFileSync("docker", ["image", "inspect", String(id)], {
        encoding: "utf8",
        env: subprocessEnv(),
      }),
    );
    assert.equal(image.Id, id);
    assert.equal(image.Config.Labels["org.opencontainers.image.revision"], env.SOURCE_SHA);
  }
  const state = join(directory, "staging-runtime-state.json");
  const { prepareRuntimeImageSmoke } = await import(
    pathToFileURL(join(root, "scripts/ci/prepare.mjs")).href
  );
  const prepared = await prepareRuntimeImageSmoke({
    image: proof.imageIds.runtime,
    statePath: state,
    codexVersion: profile.codexVersion,
  });
  try {
    for (const [lane, file] of startupFiles) {
      execFileSync(
        process.execPath,
        [
          "scripts/ci/run-tests.mjs",
          "run",
          lane,
          "--file",
          file,
          "--root",
          root,
          "--state",
          state,
          "--results",
          join(directory, `staging-${lane}.json`),
        ],
        {
          cwd: root,
          stdio: "inherit",
          env: {
            ...env,
            ...prepared.env,
            // The CI runner binds test evidence to the checkout it executes.
            GITHUB_SHA: env.GITHUB_WORKFLOW_SHA,
            OCC_TEST_STAGING_CODEX_VERSION: profile.codexVersion,
            NODE_BASE_IMAGE: proof.nodeBaseImage,
            OCC_TEST_PRODUCTION_IMAGE: proof.imageIds.controller,
            OCC_TEST_RUNTIME_IMAGE: proof.imageIds.runtime,
            OCC_TEST_CODEX_PROBE_IMAGE: proof.nodeBaseImage,
            EXPECTED_OCC_REVISION: proof.sourceSha,
          },
        },
      );
    }
  } finally {
    await prepared.cleanup();
  }
  await writeFile(
    join(directory, "staging-qualification.json"),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
}

try {
  const [command, path, candidatePath, ...extra] = process.argv.slice(2);
  if (command === "validate-pair") {
    await validatePair();
  } else if (command === "validate") {
    await producer();
  } else {
    assert.ok(env.RUNNER_TEMP, "RUNNER_TEMP is required.");
    if (command === "plan-signin") {
      assert.equal(process.argv.length, 4);
      await signinPlan(env.RUNNER_TEMP, path);
    } else if (
      command === "verify-pair" ||
      command === "pull-pair" ||
      command === "prepare-signin"
    ) {
      assert.ok(
        path && candidatePath && extra.length === 0,
        "Require the previous and candidate archive directories.",
      );
      if (command === "prepare-signin") {
        // Never adopt an existing receipt. Its exclusive writer must succeed in this
        // invocation, then the planner must see exactly the bytes that writer returned.
        const producedHash = await pullPair(path, candidatePath, env.RUNNER_TEMP);
        await signinPlan(env.RUNNER_TEMP, producedHash);
      } else if (command === "pull-pair") {
        console.log(await pullPair(path, candidatePath, env.RUNNER_TEMP));
      } else {
        await verifyPair(path, candidatePath, env.RUNNER_TEMP);
      }
    } else if (command === "pull") {
      assert.ok(path, "Publication receipt path is required.");
      await pull(path, env.RUNNER_TEMP);
    } else {
      assert.equal(command, "smoke");
      await smoke(env.RUNNER_TEMP);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Staging qualification failed.");
  process.exitCode = 1;
}
