import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  exportLane,
  exportWorkflow,
  validateExportRequest,
  validateHostedContext,
  validateLaneIdentity,
  validateOciArchive,
  validateOciLayout,
  validateServiceConfiguration,
  validateServiceRecipe,
  validateStagedServiceContext,
} from "../../scripts/ci/service-image-export.mjs";
import { prepareRepositoryCredentials } from "../../scripts/ci/repository-credentials.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const script = join(root, "scripts/ci/service-image-export.mjs");
const source = "a".repeat(40);
const sourceTree = "b".repeat(40);
const imageId = (character) => `sha256:${character.repeat(64)}`;

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function laneFixture() {
  const prefix = "openclaw-ci-123-1-service-export";
  const images = Object.fromEntries(
    [
      ["service", "c"],
      ["client", "d"],
      ["qualification", "e"],
    ].map(([role, character]) => [
      role,
      {
        tag: `localhost/openclaw-ci-image-123-1-service-export/${role}:local`,
        id: imageId(character),
      },
    ]),
  );
  return {
    env: { SOURCE_SHA: source, SOURCE_TREE: sourceTree },
    receipt: {
      version: 1,
      lane: exportLane,
      sourceCommit: source,
      sourceTree,
      ghVersion: "2.100.0",
      images,
    },
    state: {
      version: 1,
      repositoryRoot: root,
      lane: exportLane,
      prefix,
      resources: Object.entries(images).map(([role, image], index) => ({
        id: `image-tag-${String(index + 1).repeat(12)}`,
        kind: "image-tag",
        owner: prefix,
        status: "ready",
        name: image.tag,
        imageId: image.id,
        role,
      })),
    },
  };
}

test("service export is exactly opt-in and rejects every wrong-lane request", () => {
  assert.equal(validateExportRequest("checks-baseline", "false"), false);
  assert.equal(validateExportRequest(exportLane, "true"), true);
  for (const [lane, requested] of [
    ["images-packaging", "true"],
    ["repository-credentials-platform", "true"],
    [exportLane, "TRUE"],
    [exportLane, "1"],
    [exportLane, ""],
  ]) {
    assert.throws(() => validateExportRequest(lane, requested));
  }
});

test("hosted export accepts only the selected main workflow and exact source", () => {
  const env = {
    GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: `openclaw/openclaw-enterprise/${exportWorkflow}@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: source,
    GITHUB_SHA: source,
    SOURCE_SHA: source,
    CI_RUN_ID: "456",
    CI_ATTEMPT: "2",
  };
  const repository = {
    full_name: "openclaw/openclaw-enterprise",
    default_branch: "main",
    private: true,
  };
  validateHostedContext(env, repository);
  for (const patch of [
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/topic" },
    { GITHUB_WORKFLOW_SHA: "f".repeat(40) },
    { GITHUB_SHA: "f".repeat(40) },
    { SOURCE_SHA: "f".repeat(40) },
    { CI_ATTEMPT: "latest" },
  ]) {
    assert.throws(() => validateHostedContext({ ...env, ...patch }, repository));
  }
  const sentinel = "SAFE_REJECTED_SECRET_SENTINEL";
  for (const key of ["CI_RUN_ID", "CI_ATTEMPT"]) {
    assert.throws(
      () => validateHostedContext({ ...env, [key]: sentinel }, repository),
      (error) => !error.message.includes(sentinel),
    );
  }
});

test("lane receipt must equal all three owned ready cleanup resources", () => {
  const fixture = laneFixture();
  validateLaneIdentity(fixture.state, fixture.receipt, fixture.env);
  for (const mutate of [
    ({ state }) => state.resources.pop(),
    ({ state }) => (state.resources[0].status = "planned"),
    ({ state }) => (state.resources[0].owner = "openclaw-ci-foreign"),
    ({ receipt }) => (receipt.images.service.id = imageId("f")),
    ({ receipt }) => (receipt.sourceTree = "f".repeat(40)),
    ({ receipt }) => (receipt.images.extra = receipt.images.service),
  ]) {
    const changed = structuredClone(laneFixture());
    mutate(changed);
    assert.throws(() => validateLaneIdentity(changed.state, changed.receipt, changed.env));
  }
});

test("repository credential preparation records the exact source commit and tree", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "repository-credential-receipt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receiptPath = join(directory, "receipt.json");
  const calls = [];
  const ids = {
    service: imageId("c"),
    client: imageId("d"),
    qualification: imageId("e"),
  };
  await prepareRepositoryCredentials({
    repositoryRoot: root,
    imagePrefix: "localhost/openclaw-ci-image-123-1-service-export",
    receiptPath,
    execFile: async (command, args) => {
      calls.push([command, ...args]);
      if (command === "git" && args.at(-1) === "HEAD") {
        return { stdout: `${source}\n` };
      }
      if (command === "git" && args.at(-1) === "HEAD^{tree}") {
        return { stdout: `${sourceTree}\n` };
      }
      if (args[0] === "image" && args[1] === "inspect") {
        const role = /\/(service|client|qualification):local$/.exec(args.at(-1))?.[1];
        return { stdout: `${ids[role]}\n` };
      }
      return { stdout: "" };
    },
    registerImage: async (tag) => ({ tag }),
    markImageReady: async () => {},
  });
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.sourceCommit, source);
  assert.equal(receipt.sourceTree, sourceTree);
  assert.ok(calls.some((call) => call.at(-1) === "HEAD^{tree}"));
  assert.deepEqual(
    Object.fromEntries(Object.entries(receipt.images).map(([role, image]) => [role, image.id])),
    ids,
  );
});

test("service recipe and staged context reject any file outside the emitted closure", async () => {
  const dockerfile = await readFile(
    join(root, "deploy/runtime/repository-credentials/Dockerfile"),
    "utf8",
  );
  const base = /^FROM ([^\s]+)$/m.exec(dockerfile)[1];
  validateServiceRecipe(dockerfile, base);
  assert.throws(() =>
    validateServiceRecipe(`${dockerfile}\nCOPY credentials /root/credentials\n`, base),
  );
  for (const directive of [
    "# syntax=docker/dockerfile:1",
    "# escape=`",
    "# check=skip=JSONArgsRecommended",
  ]) {
    assert.throws(
      () => validateServiceRecipe(`${directive}\n${dockerfile}`, base),
      /parser directives are not allowed/,
    );
  }
  const ignoreSha = hash(Buffer.from("dist\n"));
  const records = [
    { path: ".dockerignore", type: "file", sha256: ignoreSha },
    { path: "package.json", type: "file", sha256: hash(Buffer.from("{}")) },
    { path: "dist/", type: "directory" },
    { path: "dist/service.js", type: "file", sha256: hash(Buffer.from("export {};")) },
  ];
  validateStagedServiceContext(records, ignoreSha, {
    name: "repository-credentials-service",
    type: "module",
  });
  assert.throws(() =>
    validateStagedServiceContext(
      [...records, { path: "provider-token", type: "file", sha256: hash(Buffer.from("x")) }],
      ignoreSha,
    ),
  );
  assert.throws(() =>
    validateStagedServiceContext(records, ignoreSha, {
      name: "repository-credentials-service",
      type: "module",
      scripts: { postinstall: "unexpected" },
    }),
  );
});

test("service configuration binds the pinned base and excludes added environment or history credentials", () => {
  const base = {
    Config: {
      Env: ["PATH=/usr/local/bin", "NODE_VERSION=24"],
      Cmd: ["node"],
      Labels: { "org.opencontainers.image.base.name": "node" },
    },
    RootFS: { Layers: [imageId("1")] },
  };
  const service = {
    Config: {
      User: "node",
      WorkingDir: "/app",
      Entrypoint: ["node", "/app/dist/repository-credentials.js"],
      Cmd: ["node"],
      Env: [...base.Config.Env],
      Labels: { ...base.Config.Labels },
    },
    RootFS: { Layers: [...base.RootFS.Layers, imageId("2"), imageId("3")] },
  };
  const baseHistory = ["FROM pinned node", "base setup"];
  const serviceHistory = ["ENTRYPOINT", "USER node", "COPY closure", ...baseHistory];
  validateServiceConfiguration(service, base, serviceHistory, baseHistory);
  assert.throws(() =>
    validateServiceConfiguration(
      { ...service, Config: { ...service.Config, Env: [...service.Config.Env, "TOKEN=value"] } },
      base,
      serviceHistory,
      baseHistory,
    ),
  );
  assert.throws(() =>
    validateServiceConfiguration(
      { ...service, Config: { ...service.Config, Cmd: ["unexpected"] } },
      base,
      serviceHistory,
      baseHistory,
    ),
  );
  assert.throws(() =>
    validateServiceConfiguration(service, base, ["TOKEN=value", ...serviceHistory], baseHistory),
  );
  assert.throws(() =>
    validateServiceConfiguration(
      { ...service, RootFS: { Layers: [imageId("9"), ...service.RootFS.Layers.slice(1)] } },
      base,
      serviceHistory,
      baseHistory,
    ),
  );
  for (const Config of [
    {
      ...service.Config,
      Labels: { ...service.Config.Labels, "org.opencontainers.image.title": "unexpected" },
    },
    { ...service.Config, Healthcheck: { Test: ["CMD", "unexpected"] } },
    { ...service.Config, Volumes: { "/unexpected": {} } },
    { ...service.Config, StopSignal: "SIGKILL" },
  ]) {
    assert.throws(() =>
      validateServiceConfiguration({ ...service, Config }, base, serviceHistory, baseHistory),
    );
  }
  assert.throws(() =>
    validateServiceConfiguration(
      service,
      base,
      [{ createdBy: "COPY closure", comment: "unexpected" }, ...baseHistory],
      baseHistory,
    ),
  );
});

async function ociFixture(
  t,
  {
    expandedLayers = [
      Buffer.from("first filesystem layer"),
      Buffer.from("second filesystem layer"),
    ],
    storedLayers,
    mediaTypes = [
      "application/vnd.oci.image.layer.v1.tar+gzip",
      "application/vnd.oci.image.layer.v1.tar",
    ],
    diffIds = expandedLayers.map((bytes) => `sha256:${hash(bytes)}`),
    configEnvironment = ["PATH=/usr/bin"],
    serviceEnvironment = configEnvironment,
    configFields = {},
    serviceHistoryComment = "buildkit.dockerfile.v0",
    descriptorAnnotations = {},
    manifestFields = {},
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "service-oci-layout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const blobs = join(directory, "blobs/sha256");
  await mkdir(blobs, { recursive: true });
  const encoded =
    storedLayers ??
    expandedLayers.map((bytes, index) =>
      mediaTypes[index] === "application/vnd.oci.image.layer.v1.tar+gzip" ? gzipSync(bytes) : bytes,
    );
  const baseHistory = [{ created_by: "FROM pinned node" }];
  const serviceOwnedHistory = [{ createdBy: "COPY closure", comment: "buildkit.dockerfile.v0" }];
  const approvedConfig = {
    Env: configEnvironment,
    Cmd: ["node"],
    Labels: { "org.opencontainers.image.base.name": "node" },
    User: "node",
    WorkingDir: "/app",
    Entrypoint: ["node", "/app/dist/repository-credentials.js"],
  };
  const baseConfig = {
    architecture: "amd64",
    os: "linux",
    config: {
      Env: configEnvironment,
      Cmd: ["node"],
      Labels: { "org.opencontainers.image.base.name": "node" },
    },
    rootfs: { type: "layers", diff_ids: diffIds.slice(0, 1) },
    history: baseHistory,
  };
  const config = Buffer.from(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: { ...approvedConfig, ...configFields },
      rootfs: { type: "layers", diff_ids: diffIds },
      history: [
        ...baseHistory,
        {
          created_by: "COPY closure",
          comment: serviceHistoryComment,
          empty_layer: true,
        },
      ],
    }),
  );
  const configDigest = `sha256:${hash(config)}`;
  await writeFile(join(blobs, hash(config)), config);
  const layerDescriptors = [];
  for (const [index, bytes] of encoded.entries()) {
    const digest = `sha256:${hash(bytes)}`;
    await writeFile(join(blobs, hash(bytes)), bytes);
    layerDescriptors.push({ mediaType: mediaTypes[index], digest, size: bytes.length });
  }
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
        size: config.length,
      },
      layers: layerDescriptors,
      ...manifestFields,
    }),
  );
  const manifestDigest = `sha256:${hash(manifest)}`;
  await writeFile(join(blobs, hash(manifest)), manifest);
  await writeFile(join(directory, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(
    join(directory, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: manifestDigest,
          size: manifest.length,
          annotations: {
            "org.opencontainers.image.ref.name": "service",
            ...descriptorAnnotations,
          },
        },
      ],
    }),
  );
  const service = {
    Id: configDigest,
    Config: {
      User: "node",
      WorkingDir: "/app",
      Entrypoint: ["node", "/app/dist/repository-credentials.js"],
      Cmd: ["node"],
      Env: serviceEnvironment,
      Labels: { "org.opencontainers.image.base.name": "node" },
    },
    RootFS: { Layers: diffIds },
  };
  return {
    approval: { approvedConfig, baseConfig, serviceOwnedHistory },
    blobs,
    configDigest,
    directory,
    layerDescriptors,
    service,
  };
}

function archiveLayout(layout, archive, extra = []) {
  execFileSync("tar", [
    "-cf",
    archive,
    "-C",
    layout,
    "blobs",
    "index.json",
    "oci-layout",
    ...extra,
  ]);
}

test("OCI layers bind ordered gzip and plain payloads to every tested diff ID", async (t) => {
  const fixture = await ociFixture(t);
  const identity = await validateOciLayout(fixture.directory, fixture.service);
  assert.equal(identity.configDigest, fixture.configDigest);
  assert.deepEqual(identity.diffIds, fixture.service.RootFS.Layers);

  const repeatedLayer = Buffer.from("same filesystem layer");
  const repeated = await ociFixture(t, {
    expandedLayers: [repeatedLayer, repeatedLayer],
    mediaTypes: [
      "application/vnd.oci.image.layer.v1.tar",
      "application/vnd.oci.image.layer.v1.tar",
    ],
  });
  const repeatedIdentity = await validateOciLayout(repeated.directory, repeated.service);
  assert.equal(repeatedIdentity.layerDigests[0], repeatedIdentity.layerDigests[1]);
  const repeatedArchive = join(repeated.directory, "repeated.tar");
  archiveLayout(repeated.directory, repeatedArchive);
  assert.equal(
    (await validateOciArchive(repeatedArchive, repeated.service)).configDigest,
    repeated.configDigest,
  );

  const countMismatch = await ociFixture(t, {
    storedLayers: [gzipSync(Buffer.from("first filesystem layer"))],
    mediaTypes: ["application/vnd.oci.image.layer.v1.tar+gzip"],
  });
  await assert.rejects(() => validateOciLayout(countMismatch.directory, countMismatch.service));

  const unrelated = await ociFixture(t, {
    storedLayers: [
      gzipSync(Buffer.from("valid but unrelated layer")),
      Buffer.from("second filesystem layer"),
    ],
  });
  await assert.rejects(() => validateOciLayout(unrelated.directory, unrelated.service));

  for (const invalid of [
    await ociFixture(t, {
      storedLayers: [Buffer.from("not gzip"), Buffer.from("second filesystem layer")],
    }),
    await ociFixture(t, {
      mediaTypes: [
        "application/vnd.oci.image.layer.v1.tar+zstd",
        "application/vnd.oci.image.layer.v1.tar",
      ],
      storedLayers: [Buffer.from("unsupported zstd"), Buffer.from("second filesystem layer")],
    }),
  ]) {
    await assert.rejects(() => validateOciLayout(invalid.directory, invalid.service));
  }
});

test("OCI export admits only approved runtime, history, manifest, and descriptor metadata", async (t) => {
  const valid = await ociFixture(t);
  await validateOciLayout(valid.directory, valid.service, valid.approval);

  for (const [invalid, expectedFailure] of [
    [
      await ociFixture(t, {
        configFields: {
          Labels: {
            "org.opencontainers.image.base.name": "node",
            "org.opencontainers.image.title": "unexpected",
          },
        },
      }),
      /runtime configuration contains unapproved metadata/,
    ],
    [await ociFixture(t, { serviceHistoryComment: "unexpected" }), /history comment changed/],
    [
      await ociFixture(t, {
        descriptorAnnotations: { "org.opencontainers.image.description": "unexpected" },
      }),
      /service reference metadata changed/,
    ],
    [
      await ociFixture(t, {
        manifestFields: {
          annotations: { "org.opencontainers.image.description": "unexpected" },
        },
      }),
      /manifest contains unapproved metadata/,
    ],
  ]) {
    await assert.rejects(
      () => validateOciLayout(invalid.directory, invalid.service, invalid.approval),
      expectedFailure,
    );
  }
});

test("completed OCI archive rejects duplicates, links, and special members", async (t) => {
  const valid = await ociFixture(t);
  const archive = join(valid.directory, "valid.tar");
  archiveLayout(valid.directory, archive);
  assert.equal((await validateOciArchive(archive, valid.service)).configDigest, valid.configDigest);

  const linkedArchive = join(valid.directory, "linked-archive.tar");
  await link(archive, linkedArchive);
  await assert.rejects(() => validateOciArchive(linkedArchive, valid.service));
  await unlink(linkedArchive);
  const symlinkedArchive = join(valid.directory, "symlinked-archive.tar");
  await symlink("valid.tar", symlinkedArchive);
  await assert.rejects(() => validateOciArchive(symlinkedArchive, valid.service));

  await writeFile(join(valid.directory, "unexpected"), "unexpected archive member");
  const unexpected = join(valid.directory, "unexpected.tar");
  archiveLayout(valid.directory, unexpected, ["unexpected"]);
  await assert.rejects(() => validateOciArchive(unexpected, valid.service));

  await writeFile(
    join(valid.blobs, valid.layerDescriptors[0].digest.slice("sha256:".length)),
    "changed archived layer",
  );
  const changedBlob = join(valid.directory, "changed-blob.tar");
  archiveLayout(valid.directory, changedBlob);
  await assert.rejects(() => validateOciArchive(changedBlob, valid.service));

  const duplicateFixture = await ociFixture(t);
  const duplicate = join(duplicateFixture.directory, "duplicate.tar");
  archiveLayout(duplicateFixture.directory, duplicate);
  execFileSync("tar", [
    "--no-recursion",
    "-rf",
    duplicate,
    "-C",
    duplicateFixture.directory,
    "blobs/",
  ]);
  await assert.rejects(
    () => validateOciArchive(duplicate, duplicateFixture.service),
    /duplicate members/,
  );

  for (const kind of ["symlink", "hardlink", "fifo"]) {
    const fixture = await ociFixture(t);
    await unlink(join(fixture.directory, "oci-layout"));
    if (kind === "symlink") {
      await symlink("index.json", join(fixture.directory, "oci-layout"));
    } else if (kind === "hardlink") {
      await link(join(fixture.directory, "index.json"), join(fixture.directory, "oci-layout"));
    } else {
      execFileSync("mkfifo", [join(fixture.directory, "oci-layout")]);
    }
    const changed = join(fixture.directory, `${kind}.tar`);
    archiveLayout(fixture.directory, changed);
    await assert.rejects(() => validateOciArchive(changed, fixture.service));
  }
});

test("rejected recipe, receipt, staged, configuration and OCI values stay out of failures", async (t) => {
  const sentinel = "SAFE_REJECTED_SECRET_SENTINEL";
  const fixture = await ociFixture(t, {
    configEnvironment: ["PATH=/usr/bin", `TOKEN=${sentinel}`],
    serviceEnvironment: ["PATH=/usr/bin"],
  });
  await assert.rejects(
    () => validateOciLayout(fixture.directory, fixture.service),
    (error) => !error.message.includes(sentinel),
  );
  for (const rejected of [
    await ociFixture(t, {
      configFields: {
        Labels: { "org.opencontainers.image.base.name": "node", credential: sentinel },
      },
    }),
    await ociFixture(t, { serviceHistoryComment: sentinel }),
    await ociFixture(t, { descriptorAnnotations: { unexpected: sentinel } }),
  ]) {
    await assert.rejects(
      () => validateOciLayout(rejected.directory, rejected.service, rejected.approval),
      (error) => !error.message.includes(sentinel),
    );
  }
  const base = {
    Config: { Env: ["PATH=/usr/bin"], Cmd: ["node"] },
    RootFS: { Layers: [imageId("1")] },
  };
  const service = {
    Config: {
      User: "node",
      WorkingDir: "/app",
      Entrypoint: ["node", "/app/dist/repository-credentials.js"],
      Cmd: ["node", sentinel],
      Env: ["PATH=/usr/bin", sentinel],
    },
    RootFS: { Layers: [imageId("1"), imageId("2")] },
  };
  for (const invocation of [
    () => validateServiceConfiguration(service, base, ["COPY closure", "base"], ["base"]),
    () =>
      validateServiceConfiguration(
        { ...service, Config: { ...service.Config, Cmd: ["node"], Env: ["PATH=/usr/bin"] } },
        base,
        [`TOKEN=${sentinel}`, "base"],
        ["base"],
      ),
  ]) {
    assert.throws(invocation, (error) => !error.message.includes(sentinel));
  }

  const dockerfile = await readFile(
    join(root, "deploy/runtime/repository-credentials/Dockerfile"),
    "utf8",
  );
  const baseReference = /^FROM ([^\s]+)$/m.exec(dockerfile)[1];
  const stagedRecords = [
    { path: ".dockerignore", type: "file", sha256: hash(Buffer.from("dist\n")) },
    { path: "package.json", type: "file", sha256: hash(Buffer.from("{}")) },
    { path: "dist/", type: "directory" },
    { path: "dist/service.js", type: "file", sha256: hash(Buffer.from("export {};")) },
  ];
  const lane = laneFixture();
  lane.receipt.images.service = { ...lane.receipt.images.service, credential: sentinel };
  for (const invocation of [
    () => validateServiceRecipe(`${dockerfile}\nLABEL credential=${sentinel}\n`, baseReference),
    () =>
      validateStagedServiceContext(stagedRecords, stagedRecords[0].sha256, {
        name: "repository-credentials-service",
        type: "module",
        credential: sentinel,
      }),
    () => validateLaneIdentity(lane.state, lane.receipt, lane.env),
  ]) {
    assert.throws(invocation, (error) => !error.message.includes(sentinel));
  }
});

test("export orchestration suppresses rejected subprocess output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "service-export-command-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  const sentinel = "SAFE_COMMAND_ERROR_SECRET_SENTINEL";
  const git = join(bin, "git");
  await writeFile(git, `#!/bin/sh\nprintf '%s\\n' '${sentinel}' >&2\nexit 2\n`);
  await chmod(git, 0o700);
  const fixture = laneFixture();
  const statePath = join(directory, "state.json");
  const receiptPath = join(directory, "receipt.json");
  await writeFile(statePath, JSON.stringify(fixture.state));
  await writeFile(receiptPath, JSON.stringify(fixture.receipt));
  const result = spawnSync(
    process.execPath,
    [script, "export", statePath, receiptPath, join(directory, "output")],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        OPENCLAW_EXPORT_SERVICE_IMAGE: "true",
        RUNNER_TEMP: directory,
        SOURCE_SHA: source,
        SOURCE_TREE: sourceTree,
        GITHUB_WORKFLOW_SHA: source,
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        CI_RUN_ID: "456",
        CI_ATTEMPT: "2",
      },
    },
  );
  assert.notEqual(result.status, 0);
  assert.ok(!result.stderr.includes(sentinel));
  assert.match(result.stderr, /git failed/);
});

async function cleanupFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "service-export-cleanup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "output");
  await mkdir(output);
  const oci = await ociFixture(t);
  const archivePath = join(output, "repository-credentials-service.oci.tar");
  archiveLayout(oci.directory, archivePath);
  const archive = await readFile(archivePath);
  const ociIdentity = await validateOciArchive(archivePath, oci.service);
  const receipt = laneFixture().receipt;
  const receiptPath = join(directory, "receipt.json");
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  await writeFile(receiptPath, receiptBytes);
  await writeFile(
    join(output, "export.json"),
    JSON.stringify({
      version: 1,
      kind: "repository-credentials-service-oci-preparation",
      lane: { receiptSha256: hash(receiptBytes) },
      tested: { configId: oci.service.Id },
      configuration: {
        user: oci.service.Config.User,
        workingDir: oci.service.Config.WorkingDir,
        entrypoint: oci.service.Config.Entrypoint,
        command: oci.service.Config.Cmd,
        environmentSha256: hash(Buffer.from(`${JSON.stringify(oci.service.Config.Env)}\n`)),
      },
      oci: ociIdentity,
      archive: { path: "repository-credentials-service.oci.tar", sha256: hash(archive) },
      cleanup: {
        status: "pending",
        ownedTags: [
          receipt.images.service.tag,
          receipt.images.client.tag,
          receipt.images.qualification.tag,
        ],
        container: "openclaw-service-export-123-1",
      },
    }),
  );
  const docker = join(directory, "docker");
  await writeFile(
    docker,
    `#!${process.execPath}\n` +
      "const args = process.argv.slice(2);\n" +
      "const target = args.at(-1);\n" +
      'if (process.env.SURVIVE_TAG && target === process.env.SURVIVE_TAG) { console.log("[]"); process.exit(0); }\n' +
      'if (process.env.SURVIVE_CONTAINER && args[0] === "container" && target === process.env.SURVIVE_CONTAINER) { console.log("[]"); process.exit(0); }\n' +
      'if (process.env.UNKNOWN_ABSENCE) { console.error(`daemon unavailable ${process.env.SUBPROCESS_SENTINEL ?? ""}`); process.exit(1); }\n' +
      'console.error(args[0] === "container" ? "No such container" : "No such image");\n' +
      "process.exit(1);\n",
  );
  await chmod(docker, 0o700);
  return { directory, docker, output, receiptPath, statePath: join(directory, "state.json") };
}

function reconcile(fixture, env = {}) {
  return spawnSync(
    process.execPath,
    [script, "reconcile", fixture.statePath, fixture.receiptPath, fixture.output],
    {
      cwd: root,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", OCC_DOCKER_BIN: fixture.docker, ...env },
    },
  );
}

test("cleanup reconciliation accepts only absent state, tags and inspection container", async (t) => {
  const successful = await cleanupFixture(t);
  const result = reconcile(successful);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(await readFile(join(successful.output, "export.json"))).cleanup.status,
    "verified",
  );

  const stateRetained = await cleanupFixture(t);
  await writeFile(stateRetained.statePath, "{}");
  assert.notEqual(reconcile(stateRetained).status, 0);

  const tagRetained = await cleanupFixture(t);
  assert.notEqual(
    reconcile(tagRetained, { SURVIVE_TAG: laneFixture().receipt.images.client.tag }).status,
    0,
  );

  const containerRetained = await cleanupFixture(t);
  assert.notEqual(
    reconcile(containerRetained, { SURVIVE_CONTAINER: "openclaw-service-export-123-1" }).status,
    0,
  );
  assert.equal(
    JSON.parse(await readFile(join(containerRetained.output, "export.json"))).cleanup.status,
    "pending",
  );

  const unknown = await cleanupFixture(t);
  const sentinel = "SAFE_SUBPROCESS_SECRET_SENTINEL";
  const unknownResult = reconcile(unknown, {
    UNKNOWN_ABSENCE: "1",
    SUBPROCESS_SENTINEL: sentinel,
  });
  assert.notEqual(unknownResult.status, 0);
  assert.ok(!unknownResult.stderr.includes(sentinel));

  const changedArchive = await cleanupFixture(t);
  await writeFile(join(changedArchive.output, "repository-credentials-service.oci.tar"), "changed");
  assert.notEqual(reconcile(changedArchive).status, 0);
});

function parseYaml(path) {
  const requireRootDependency = createRequire(join(root, "package.json"));
  const { parse } = requireRootDependency("yaml");
  return parse(readFileSync(path, "utf8"));
}

function assertServiceExportGates(action, workflow) {
  assert.equal(action.inputs["export-service-image"].default, "false");
  const actionSteps = action.runs.steps;
  const exported = actionSteps.find(
    (step) => step.name === "Export the exact tested repository credential service image",
  );
  const cleanup = actionSteps.find((step) => step.name === "Cleanup lane");
  const reconcileStep = actionSteps.find(
    (step) => step.name === "Verify exact service export cleanup",
  );
  assert.equal(exported.if, "success() && inputs.export-service-image == 'true'");
  assert.equal(cleanup.if, "always()");
  assert.equal(reconcileStep.if, "always() && inputs.export-service-image == 'true'");
  assert.ok(actionSteps.indexOf(exported) < actionSteps.indexOf(cleanup));
  assert.ok(actionSteps.indexOf(cleanup) < actionSteps.indexOf(reconcileStep));
  assert.ok(actionSteps.every((step) => step["continue-on-error"] === undefined));

  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.validate.permissions, { actions: "read", contents: "read" });
  assert.equal(workflow.jobs.validate.if, undefined);
  const prepare = workflow.jobs.prepare;
  assert.equal(prepare.needs, "validate");
  assert.equal(prepare.if, undefined);
  assert.deepEqual(prepare.permissions, { contents: "read" });
  assert.ok(Object.values(workflow.jobs).every((job) => job["continue-on-error"] === undefined));
  const lane = prepare.steps.find((step) => step.uses === "./.github/actions/run-ci-lane");
  const upload = prepare.steps.find(
    (step) => step.name === "Upload preparation-only OCI archive for repository readers",
  );
  assert.deepEqual(
    {
      lane: lane.with.lane,
      profile: lane.with.profile,
      export: lane.with["export-service-image"],
    },
    { lane: "repository-credentials-container", profile: "images", export: "true" },
  );
  assert.equal(lane.if, undefined);
  assert.equal(lane["continue-on-error"], undefined);
  assert.equal(upload.if, undefined);
  assert.equal(upload["continue-on-error"], undefined);
  assert.ok(prepare.steps.indexOf(lane) < prepare.steps.indexOf(upload));
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["retention-days"], 1);
  assert.ok(
    Object.values(workflow.jobs).every((job) =>
      job.steps.every((step) => step["continue-on-error"] === undefined),
    ),
  );

  const commandSource = [
    ...actionSteps.map((step) => step.run ?? ""),
    ...Object.values(workflow.jobs).flatMap((job) => job.steps.map((step) => step.run ?? "")),
  ].join("\n");
  assert.doesNotMatch(commandSource, /docker push|skopeo copy[^\n]*docker:\/\//);
}

test("structured workflow gates upload on successful lane cleanup verification", () => {
  const action = parseYaml(join(root, ".github/actions/run-ci-lane/action.yml"));
  const workflow = parseYaml(join(root, ".github/workflows/repository-service-export.yml"));
  assertServiceExportGates(action, workflow);

  for (const mutate of [
    (candidateAction) => {
      candidateAction.runs.steps.find(
        (step) => step.name === "Verify exact service export cleanup",
      )["continue-on-error"] = true;
    },
    (_candidateAction, candidateWorkflow) => {
      candidateWorkflow.jobs.prepare.steps.find(
        (step) => step.name === "Upload preparation-only OCI archive for repository readers",
      ).if = "${{ always() }}";
    },
    (_candidateAction, candidateWorkflow) => {
      candidateWorkflow.jobs.prepare.steps.find(
        (step) => step.uses === "./.github/actions/run-ci-lane",
      )["continue-on-error"] = true;
    },
    (_candidateAction, candidateWorkflow) => {
      candidateWorkflow.jobs.prepare.needs = undefined;
    },
  ]) {
    const candidateAction = structuredClone(action);
    const candidateWorkflow = structuredClone(workflow);
    mutate(candidateAction, candidateWorkflow);
    assert.throws(() => assertServiceExportGates(candidateAction, candidateWorkflow));
  }
});
