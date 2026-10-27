import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { startPreparedGitHubGitOwner } from "../../apps/controller/src/backends/repository-credentials/prepared-git-owner.ts";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import { loadConfiguration } from "../../apps/controller/src/composition/repository-credentials/config.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import {
  PREPARED_REPOSITORY_DIRECTORY,
  REPOSITORY_CONTROL_SOCKET,
} from "../../scripts/lib/prepared-repository-installation.mjs";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";
import { createInstallationDriverConfiguration } from "../helpers/installation-driver-configuration.mjs";
import {
  applyQaRepositoryInstallation,
  grantQaRepositoryBranch,
  qaRepositoryServiceConfig,
} from "../helpers/qa-repository.mjs";
import { socketDirectory } from "../helpers/socket-directory.mjs";

// The QA matrix's repository leg (manual Full Integration only) writes these files
// for Compose and hands the registry to `occ dev up` for k3d. Nothing else loads
// them before a live run, so feed them through the same loaders the controller,
// the worker's prepared owner and the repository service run at startup. The k3d
// registry is also checked by `occ dev up` in Go (internal/occdev/repository_k3d.go),
// which this file does not run.

const suffix = "1a2b3c4d";
const host = "git.oce-system.svc.cluster.local";
const relayLabels = { "app.kubernetes.io/name": "qa-repository-relay" };

// An operator's QA input, written for the retired broker: two profiles, any branch.
function operatorRegistry(policy: Record<string, unknown> = {}) {
  return {
    version: 1,
    backendId: "github-qa",
    providerInstanceId: "github-com",
    appId: "12345",
    githubInstallationId: "67890",
    maximumDurationSeconds: 3600,
    repositories: [
      {
        repositoryRef: "qa",
        repositoryId: "34567",
        repository: "example/qa",
        namespaces: [{ namespaceId: "ns_qa", profiles: ["git-read", "git-full"], ...policy }],
      },
    ],
  };
}

// Lay the generated files out under a private root, as Compose bind-mounts them.
async function generatedInputs(
  t: TestContext,
  registry: unknown,
  installation: unknown,
  serviceConfig: unknown,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qa-repository-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sockets = await socketDirectory(t, "qa-rc-", { longest: "private/prepared-git-use.sock" });
  await mkdir(join(sockets, "private"), { mode: 0o700 });
  const relocate = (value: unknown) =>
    JSON.parse(
      JSON.stringify(value)
        .replaceAll(REPOSITORY_CONTROL_SOCKET, join(sockets, "private/control.sock"))
        .replaceAll("/etc/openclaw/", `${root}/etc/openclaw/`),
    );
  const tls = await createTlsMaterial(t);
  const files: Record<string, [string | Buffer, number]> = {
    "etc/openclaw/repository-registry/registry.json": [JSON.stringify(registry), 0o600],
    "etc/openclaw/repository-ca/ca.crt": [tls.cert, 0o644],
    "etc/openclaw/repository-inputs/tls.key": [tls.key, 0o600],
    "etc/openclaw/prepared-repository/private-key.pem": [tls.key, 0o600],
    "etc/openclaw/prepared-repository/custody.key": [randomBytes(32), 0o600],
    "installation.yaml": [JSON.stringify(relocate(installation)), 0o600],
    "service-config.json": [JSON.stringify(relocate(serviceConfig)), 0o600],
  };
  for (const [path, [data, mode]] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(root, path), data, { mode });
  }
  return { root, sockets };
}

type LoadedInstallation = Awaited<ReturnType<typeof loadInstallationConfiguration>>;

async function startWorkerOwner(loaded: LoadedInstallation) {
  assert.ok(loaded?.repositoryOwner && loaded.preparedRepositoryGit && loaded.repositoryRegistry);
  const { issuerCaPath, ...prepared } = loaded.preparedRepositoryGit;
  assert.equal(issuerCaPath, undefined);
  // The worker serves this socket; the policy and key checks come first.
  const { controlSocket, ...owner } = loaded.repositoryOwner;
  assert.equal(typeof controlSocket, "string");
  return startPreparedGitHubGitOwner({
    ...owner,
    ...prepared,
    // Startup validates before it touches the database; maintenance stays off.
    pool: {} as Parameters<typeof startPreparedGitHubGitOwner>[0]["pool"],
    startWorker: false,
    registry: loaded.repositoryRegistry,
  });
}

test("QA repository inputs start the controller, worker owner and repository service", async (t) => {
  const registry = grantQaRepositoryBranch(
    operatorRegistry({ pushRefAllowlist: ["refs/heads/*"] }),
    suffix,
  );
  assert.deepEqual(registry.repositories[0].namespaces, [
    {
      namespaceId: "ns_qa",
      profiles: ["git-write"],
      transport: "git-only",
      pushRefAllowlist: [`refs/heads/oce-qa-${suffix}`],
    },
  ]);
  const installation = applyQaRepositoryInstallation(
    createInstallationDriverConfiguration(),
    registry,
    relayLabels,
  );
  assert.equal(installation.drivers.repo, undefined);
  const { root } = await generatedInputs(
    t,
    registry,
    installation,
    qaRepositoryServiceConfig(registry, host),
  );

  const loaded = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: join(root, "installation.yaml") },
  });
  assert.ok(loaded?.repositoryOwner && loaded.repositoryPolicy && loaded.preparedRepositoryGit);
  assert.equal(loaded.repositoryGitDriver, undefined);
  assert.equal(typeof loaded.nativeRepositorySender, "object");
  assert.equal(loaded.repositoryOwner.backendId, "github-qa");
  assert.equal(
    loaded.repositoryPolicy.resolve({ namespaceId: "ns_qa", bindings: [{ repositoryRef: "qa" }] })
      .bindings[0]?.profile,
    "git-write",
  );

  // The owner refuses an App key it cannot sign with at startup (finding 2217).
  assert.equal(
    loaded.preparedRepositoryGit.privateKeyPath,
    `${root}${PREPARED_REPOSITORY_DIRECTORY}/private-key.pem`,
  );
  const owner = await startWorkerOwner(loaded);
  await owner.close();

  const service = await loadConfiguration(join(root, "service-config.json"), createSystemClock());
  try {
    assert.equal(service.authority, "github-prepared-git-registry");
  } finally {
    service.close();
  }
});

test("QA repository grant only narrows an operator's write grant", () => {
  // A read-only policy must not become git-write, whatever push refs it lists.
  assert.throws(
    () =>
      grantQaRepositoryBranch(
        operatorRegistry({ profiles: ["git-read"], pushRefAllowlist: ["refs/heads/*"] }),
        suffix,
      ),
    /must already grant git-write or git-full/,
  );
  assert.equal(
    grantQaRepositoryBranch(operatorRegistry({ profiles: ["git-write"] }), suffix).repositories[0]
      .namespaces[0].pushRefAllowlist[0],
    `refs/heads/oce-qa-${suffix}`,
  );
  assert.throws(
    () =>
      grantQaRepositoryBranch(
        operatorRegistry({ pushRefAllowlist: ["refs/heads/review/*"] }),
        suffix,
      ),
    /authorize the run-owned branch/,
  );
});

// The shape the QA helpers wrote before this change: each loader refuses it, so the
// test above passes only for the prepared shape.
test("the retired QA repository shape is refused at startup", async (t) => {
  const retired = operatorRegistry({
    pushRefAllowlist: ["openclaw-git-full", "codex-git-full", "codex-git-read"].map(
      (name) => `refs/heads/oce-qa-${suffix}-${name}`,
    ),
  });
  const base = createInstallationDriverConfiguration();
  const compute = base.drivers.compute;
  const installation = {
    ...base,
    backend: [
      {
        id: retired.backendId,
        type: "github",
        configuration: { registryPath: "/etc/openclaw/repository-registry/registry.json" },
        drivers: { repo: "repository-credentials" },
      },
    ],
    drivers: {
      ...base.drivers,
      repo: {
        id: "repository-credentials",
        configuration: {
          controlSocket: REPOSITORY_CONTROL_SOCKET,
          sessionDurationSeconds: retired.maximumDurationSeconds,
          publicCaPath: "/etc/openclaw/repository-ca/ca.crt",
        },
      },
      compute: {
        ...compute,
        configuration: {
          ...compute.configuration,
          network: {
            ...compute.configuration.network,
            repositoryCredentials: { namespace: "oce-system", podLabels: relayLabels, port: 8443 },
          },
        },
      },
    },
  };
  const prepared = qaRepositoryServiceConfig(retired, host);
  const service = {
    ...prepared,
    sessionPolicy: {
      ...prepared.sessionPolicy,
      defaultProfile: "git-full",
      allowedProfiles: ["git-read", "git-full"],
    },
    backend: {
      ...prepared.backend,
      kind: "github-app-registry",
      privateKeyFile: "/etc/openclaw/repository-inputs/private-key.pem",
    },
  };
  const { root } = await generatedInputs(t, retired, installation, service);
  await assert.rejects(
    loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: join(root, "installation.yaml") },
    }),
    /drivers\.repo native admission is retired/,
  );
  await assert.rejects(
    loadConfiguration(join(root, "service-config.json"), createSystemClock()),
    /signing gateway retired/,
  );

  // Even in the new Installation shape, the worker refuses three branches and no transport.
  const { root: current } = await generatedInputs(
    t,
    retired,
    applyQaRepositoryInstallation(createInstallationDriverConfiguration(), retired, relayLabels),
    qaRepositoryServiceConfig(retired, host),
  );
  const loaded = await loadInstallationConfiguration({
    mode: "production",
    environment: { OCC_CONFIG_PATH: join(current, "installation.yaml") },
  });
  await assert.rejects(
    startWorkerOwner(loaded),
    /PREPARED_REPOSITORY_REQUIRES_ONE_EXPLICIT_REVIEW_REF/,
  );
});
