import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { isDeepStrictEqual } from "node:util";
import test, { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createExternalDriver,
  createExternalProtectedDriver,
  loadDriverPackage,
} from "../../apps/controller/src/composition/driver-packages.ts";
import {
  computeReleasePublicKey,
  signComputeExecutionRelease,
} from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import {
  deliveredMaterial,
  verifyRelease,
  wiringConfiguration as hostWiring,
} from "../../deploy/examples/strands-box/host/control.ts";
import {
  githubCredentialEnvironment,
  githubCredentials,
  policy,
} from "../../deploy/examples/strands-box/host/egress.ts";
import type {
  AgentRevision,
  EgressInstallation,
  HarnessWorkloadRequirements,
  Namespace,
  ProtectedGitHubRepositoryMaterial,
  ProtectedRepositoryGitAuthority,
  ProxyPlan,
  ProxyRevisionContext,
  RepositoryGitInstallationFence,
  SandboxHarnessStatusContext,
} from "../../packages/contracts/src/index.ts";
import { boxGitHubEgress } from "../helpers/strands-box-egress.ts";
import { strandsRepositoryOriginFixture } from "../helpers/strands-rehearsal-repository.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const driverSource = join(root, "deploy/examples/strands-box/driver");
const packageName = "@openclaw-enterprise/example-strands-box-driver";
const id = "strands-box-demo";
const { version: packageVersion } = JSON.parse(
  await readFile(join(driverSource, "package.json"), "utf8"),
) as { version: string };
const implementation = `${packageName}@${packageVersion}`;
const endpoint = {
  url: "wss://box-harness.pilot.svc.cluster.local:8443/",
  workspaceRoot: "/home/node/workspace",
};
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const namespace: Namespace = {
  id: "ns_pilot",
  name: "pilot",
  status: "ready",
  createdAt: new Date(0).toISOString(),
};
const relay = {
  image: `registry.example/relay@sha256:${"f".repeat(64)}`,
  hostAddress: "10.0.0.7",
  installation: "pilot",
  workerPeer: { namespace: "control", podLabels: { app: "worker" } },
};
const RELEASE_KEY_ENV = "OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY";
const REVISION_ENV = "OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID";

const execute = promisify(execFile);

/**
 * Stock `gh`, as the runtime image installs it. GitHub-hosted runners ship it; where it is absent
 * the gh steps are reported as a diagnostic and the Git steps still run (a skip fails the lane).
 */
function stockGh(): string | undefined {
  for (const candidate of ["/usr/local/bin/gh", "/usr/bin/gh"]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 5_000 });
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  return undefined;
}
const gh = stockGh();

async function publicCa(directory: string): Promise<string> {
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-subj",
      "/CN=Strands Box paired CA",
      "-days",
      "1",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-keyout",
      join(directory, "ca.key"),
      "-out",
      join(directory, "ca.pem"),
    ],
    { stdio: "ignore" },
  );
  return readFile(join(directory, "ca.pem"), "utf8");
}

async function body(message: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Build and install the package the way `driver/README.md` says; peers resolve from the repo. */
async function installPackage(t: TestContext) {
  const directory = await temporaryDirectory(t, "strands-paired-");
  const packageRoot = join(directory, "controller");
  const scope = join(packageRoot, "node_modules/@openclaw-enterprise");
  const installed = join(scope, "example-strands-box-driver");
  await mkdir(installed, { recursive: true });
  await cp(join(driverSource, "package.json"), join(installed, "package.json"));
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ dependencies: { [packageName]: packageVersion } }),
  );
  for (const peer of ["occ", "utils", "contracts"]) {
    await symlink(join(root, "packages", peer), join(scope, peer), "dir");
  }
  execFileSync(process.execPath, [join(driverSource, "build.ts"), join(installed, "dist")], {
    cwd: root,
  });
  return { directory, packageRoot, dist: join(installed, "dist") };
}

test(
  "only the paired loader admits a protectedRepository registration, and only with both capabilities",
  { timeout: 60_000 },
  async (t) => {
    const { directory, packageRoot } = await installPackage(t);
    const loaded = await loadDriverPackage({ package: packageName }, "sandbox", packageRoot, false);
    assert.ok(loaded);
    const ordinary = {
      namespace: namespace.name,
      controlSocket: join(directory, "control.sock"),
      nativeEndpoint: endpoint.url,
      nativeCaBundle: await publicCa(directory),
      workspaceRoot: endpoint.workspaceRoot,
      relay,
    };
    // Nothing about the repository, branch or sender is configured: OCE's grant selects it.
    const paired = { ...ordinary, protectedRepository: { provider: "github" } };
    assert.deepEqual(loaded.module.validateConfiguration?.(paired), []);
    assert.deepEqual(
      (loaded.module.configurationSchema as { properties: Record<string, unknown> }).properties
        .protectedRepository,
      {
        type: "object",
        additionalProperties: false,
        required: ["provider"],
        properties: { provider: { type: "string", enum: ["github"] } },
      },
    );
    const selection = (configuration: object) => ({
      id,
      implementation,
      configuration: configuration as Record<string, unknown>,
      definition: loaded.module,
    });
    // The ordinary loader refuses the registration; the paired loader refuses the plain Driver.
    assert.throws(
      () => createExternalDriver(loaded.module, selection(paired), "sandbox"),
      /unselected Driver identity/,
    );
    assert.throws(
      () => createExternalProtectedDriver(loaded.module, selection(ordinary)),
      /one Driver registration/,
    );
    const plain = createExternalDriver(loaded.module, selection(ordinary), "sandbox");
    assert.equal("repositoryAccess" in plain, false);
    assert.equal("enrollHarness" in plain, false);
    const owner = createExternalProtectedDriver(loaded.module, selection(paired));
    t.after(() => owner.close());
    assert.equal(typeof owner.requireRepositoryGitTransport(), "function");
    const sandbox = owner.require("sandbox");
    assert.ok(sandbox.repositoryAccess);
    assert.equal(typeof sandbox.enrollHarness, "function");
    assert.equal(
      typeof (sandbox as { protectedWorkspaceEndpoint?: unknown }).protectedWorkspaceEndpoint,
      "function",
    );
    const proxy = owner.require("credential_proxy");
    assert.deepEqual(
      await proxy.sourceControl.assertAvailable?.(AbortSignal.timeout(1_000), "github_repository"),
      { profile: "github_repository", authorization: "online-request" },
    );
    await assert.rejects(
      async () =>
        proxy.sourceControl.assertAvailable?.(AbortSignal.timeout(1_000), "github_installation"),
      /only one GitHub repository/,
    );
  },
);

async function pairedFixture(t: TestContext) {
  const origin = await strandsRepositoryOriginFixture(t);
  const { directory, dist } = await installPackage(t);
  await chmod(directory, 0o700);
  // The installed build's own module, loaded as the paired loader does.
  const module = (await import(pathToFileURL(join(dist, "index.js")).href)) as {
    createDriver: unknown;
  };
  const socket = join(directory, "control.sock");
  const configuration = {
    namespace: namespace.name,
    controlSocket: socket,
    nativeEndpoint: endpoint.url,
    nativeCaBundle: origin.caBundle.toString(),
    workspaceRoot: endpoint.workspaceRoot,
    relay,
    protectedRepository: { provider: "github" },
  };
  const owner = createExternalProtectedDriver(module as never, {
    id,
    implementation,
    configuration,
    definition: module as never,
  });
  t.after(() => owner.close());
  const grant = { providerInstanceId: "provider", repositoryId: "one-selection", grantId: "grant" };
  const plan: ProxyPlan = {
    id: "plan_pilot",
    generation: 1,
    execution: {
      installationId: "installation",
      namespaceId: namespace.id,
      agentId: "agt_pilot",
      servicePrincipalId: "sp_pilot",
      revisionId: "rev_pilot",
      executionId: "compute-execution",
    },
    sandboxDriverId: id,
    egressDriverId: id,
    driver: owner.ref,
    routes: [],
    repositoryGitAuthorization: "online-request",
    repositoryGit: {
      driver: { id: "repo", implementation: "fixture/repo" },
      deadlineWallMs: Date.now() + 600_000,
      bindings: [
        { repositoryRef: "selected", profile: "github-repository", backendId: "repo", grant },
      ],
    },
  };
  const revision = {
    id: "rev_pilot",
    namespaceId: namespace.id,
    agentId: "agt_pilot",
    revision: 1,
    backendId: null,
    configurationId: "cfg_pilot",
    configurationKind: "agent",
    configurationGeneration: 1,
    configuration: {},
    gatewayManagedMode: false,
    harness: { id: "codex", mode: "dedicated", version: "1", overrides: {}, configuration: {} },
    compute: { id: "compute-kubernetes", implementation: "kubernetes" },
    sandboxDriverId: id,
    executionAdmission: { version: 5, mode: "protected" },
    egressPlan: plan,
    harnessAuth: { method: "runtime" },
    servicePrincipalId: "sp_pilot",
    createdAt: namespace.createdAt,
  } as unknown as AgentRevision;
  const keys = generateKeyPairSync("ed25519");
  // The Driver states exactly the host's own wiring; the host compares it canonically.
  const wiringConfiguration = hostWiring("github");
  const requirements = {
    image: `registry.example/runtime@sha256:${"e".repeat(64)}`,
    command: ["node", "-e", "stock fixture command"],
    workspaceMounts: [],
    environment: [
      { name: REVISION_ENV, value: revision.id },
      { name: RELEASE_KEY_ENV, value: computeReleasePublicKey(keys.privateKey) },
    ],
    files: [],
    credentialAttachments: [],
    loginMode: "api_key",
    labels: {},
    proxyWiring: { plan, configuration: wiringConfiguration },
  } as unknown as HarnessWorkloadRequirements;
  const harness: SandboxHarnessStatusContext = {
    namespace,
    kubernetes: undefined,
    revision,
    requirements,
    transportToken: "synthetic-transport-capability",
    signal: AbortSignal.timeout(20_000),
  };
  const context: ProxyRevisionContext = {
    namespace,
    revision,
    plan,
    signal: AbortSignal.timeout(20_000),
  };

  // The fake host serves the host-observed record and runs the real host release and material
  // checks. Its control process (this test process) is the recipient; delivering material
  // restarts its `box run`, which this fake reports as a new process instance.
  const bearer = randomBytes(32).toString("base64url");
  const [boot, stat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile(`/proc/${process.pid}/stat`, "utf8"),
  ]);
  const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
  const host = {
    present: true,
    state: "starting" as "starting" | "running",
    bearerSha256: sha(bearer),
    processInstanceId: `${boot.trim()}:${process.pid}:${startTicks}`,
    generationSha256: sha("reservation"),
    startup: undefined as { startupId: string; startupSha256: string } | undefined,
    releases: [] as Record<string, unknown>[],
    deliveries: [] as ReturnType<typeof deliveredMaterial>[],
    installed: undefined as
      | { preparationAttemptId: string; materialVersion: string; boxProcessInstanceId: string }
      | undefined,
    /** Lose the reply to the next delivery after the host applied it. */
    loseDeliveryReply: false,
    deletes: 0,
  };
  const executionId = "box-execution";
  const record = () => ({
    owner: {
      driverId: id,
      implementation,
      namespaceId: namespace.id,
      namespaceName: namespace.name,
      agentId: revision.agentId,
      revisionId: revision.id,
    },
    requirementsDigest: "a".repeat(64),
    executionId,
    state: host.state,
    endpoint,
    repositoryRecipient: {
      bearerSha256: host.bearerSha256,
      processInstanceId: host.processInstanceId,
      ...(host.installed === undefined ? {} : { installed: host.installed }),
    },
    protectedStartup: {
      plan,
      reservedAt: "2026-11-16T00:00:00.000Z",
      generationSha256: host.generationSha256,
      ...host.startup,
    },
  });
  const server = createHttpServer((req, res) => {
    void body(req).then((bytes) => {
      const reply = (status: number, value?: unknown) =>
        res
          .writeHead(status, { "content-type": "application/json" })
          .end(value === undefined ? "" : JSON.stringify(value));
      if (req.method === "GET" && req.url === "/v1/execution") {
        reply(host.present ? 200 : 404, host.present ? record() : undefined);
        return;
      }
      if (req.method === "POST" && req.url === "/v1/release" && host.present) {
        const input = JSON.parse(bytes.toString()) as Record<string, unknown>;
        host.releases.push(input);
        try {
          host.startup = verifyRelease(
            { releaseKey: keys.publicKey, plan: plan as never },
            input.release,
            {
              executionId,
              processInstanceId: host.processInstanceId,
              bearerSha256: host.bearerSha256,
            },
          );
        } catch {
          reply(403);
          return;
        }
        host.state = "running";
        reply(200, record());
        return;
      }
      if (req.method === "POST" && req.url === "/v1/repository-material" && host.present) {
        const input = JSON.parse(bytes.toString()) as Record<string, unknown>;
        const material = deliveredMaterial(input.material);
        if (host.startup === undefined || input.executionId !== executionId) {
          reply(409, { error: "material_outside_released_execution" });
          return;
        }
        if (host.installed !== undefined) {
          const same =
            host.installed.preparationAttemptId === material.preparationAttemptId &&
            host.installed.materialVersion === material.materialVersion;
          reply(same ? 200 : 409, same ? record() : { error: "material_refresh_unsupported" });
          return;
        }
        host.deliveries.push(material);
        host.installed = {
          preparationAttemptId: material.preparationAttemptId,
          materialVersion: material.materialVersion,
          boxProcessInstanceId: `${boot.trim()}:${process.pid + 1}:${startTicks}`,
        };
        if (host.loseDeliveryReply) {
          host.loseDeliveryReply = false;
          res.destroy();
          return;
        }
        reply(200, record());
        return;
      }
      if (req.method === "DELETE") {
        host.deletes++;
      }
      reply(409);
    });
  });
  server.listen(socket);
  await once(server, "listening");
  await chmod(socket, 0o600);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  // The OCC authority stand-in: observation, install intent and the online request check.
  const state = {
    withdrawn: false,
    observed: 0,
    installs: 0,
    confirms: 0,
    materialReads: 0,
    authorizations: 0,
  };
  let fence: RepositoryGitInstallationFence | undefined;
  const version = { preparationAttemptId: "attempt", materialVersion: "version" };
  let material: ProtectedGitHubRepositoryMaterial = {
    scope: "github-repository",
    value: origin.credential,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    sessionId: "session",
    ...version,
    providerInstanceId: grant.providerInstanceId,
    grantId: grant.grantId,
    installationId: origin.repository.installationId,
    repositories: [
      { repositoryId: origin.repository.repositoryId, repository: origin.repository.repository },
    ],
    apiOrigin: "https://api.github.com",
  };
  let committed: EgressInstallation | undefined;
  let installedVersion: typeof version | undefined;
  let pending: typeof version | undefined;
  const denied = { kind: "denied", reason: "unavailable" } as const;
  const compatibility = { readMaterial: async () => undefined, authorize: async () => denied };
  const authority: ProtectedRepositoryGitAuthority = {
    ...compatibility,
    recipients: {
      async observe(installation) {
        state.observed++;
        // As OCC: no fence for an unknown recipient or while an install intent is pending.
        if (committed === undefined || pending !== undefined) {
          return undefined;
        }
        assert.deepEqual(installation, committed);
        return (fence = { revisionId: revision.id, fence: 1, observed: installation });
      },
      // As OCC's delivery row: an identical installed version or a pending intent is refused.
      async beginInstall(route, installed) {
        if (pending !== undefined || isDeepStrictEqual(installedVersion, installed)) {
          return undefined;
        }
        state.installs++;
        pending = { ...installed };
        return { ...route, ...installed };
      },
      async confirmInstall({ revisionId, fence: number, observed }) {
        state.confirms++;
        installedVersion = pending;
        pending = undefined;
        return { revisionId, fence: number, observed };
      },
    },
    online: {
      ...compatibility,
      githubRepository: {
        async readMaterial(route) {
          state.materialReads++;
          assert.deepEqual(route, fence);
          return state.withdrawn ? { absent: "withdrawn" } : material;
        },
        async authorize(q, installed) {
          state.authorizations++;
          if (state.withdrawn) {
            return { kind: "denied", reason: "access_withdrawn" };
          }
          // As OCC's installed-evidence check: only the confirmed version at the observed fence.
          if (
            !isDeepStrictEqual(
              {
                preparationAttemptId: installed.preparationAttemptId,
                materialVersion: installed.materialVersion,
              },
              installedVersion,
            ) ||
            !isDeepStrictEqual(installed.route, fence)
          ) {
            return denied;
          }
          return {
            kind: "allow",
            exchangeId: q.exchangeId,
            requestDigestSha256: q.requestDigestSha256,
            ...version,
            replyBy: q.deadlineAt,
          };
        },
      },
    },
  };
  const custody = {
    recordEgressInstallation: async (installation: EgressInstallation) => {
      committed = structuredClone(installation);
    },
    currentEgressInstallation: async () => committed,
  };
  // Stock clients in a workspace checkout, with exactly the environment Box gives the workload.
  const workspace = join(directory, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const home = join(directory, "home");
  await mkdir(join(home, "gh"), { recursive: true, mode: 0o700 });
  const client = async (
    workload: Readonly<Record<string, string>>,
    binary: string,
    args: readonly string[],
  ) =>
    execute(binary, args, {
      cwd: workspace,
      timeout: 20_000,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GH_CONFIG_DIR: join(home, "gh"),
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        NO_COLOR: "1",
        ...workload,
      },
    });
  return {
    origin,
    owner,
    sandbox: owner.require("sandbox"),
    proxy: owner.require("credential_proxy"),
    release: new ProtectedExecutionDriver(owner),
    plan,
    revision,
    harness,
    context,
    keys,
    host,
    state,
    authority,
    custody,
    committed: () => committed,
    material: () => material,
    /** OCE's renewal: a new attempt and version for the same session. */
    renew() {
      material = {
        ...material,
        preparationAttemptId: "renewed-attempt",
        materialVersion: "renewed-version",
      };
    },
    wiringConfiguration,
    client,
    workspace,
    root: directory,
  };
}

test(
  "Compute's held enrollment releases one host-observed Box execution through the paired Driver",
  { timeout: 30_000 },
  async (t) => {
    const f = await pairedFixture(t);
    const signal = AbortSignal.timeout(20_000);
    assert.equal(f.release.admits(f.revision, "stored"), true);
    // Compute rechecks the sender guarantee and the paired wiring before anything is installed.
    await assert.rejects(
      f.release.configure({ ...f.context, plan: { ...f.plan, routes: [{} as never] } }),
      /no longer owns|one online-request/,
    );
    const wiring = await f.release.configure(f.context);
    assert.deepEqual(wiring, { plan: f.plan, configuration: f.wiringConfiguration });
    assert.equal(
      await f.proxy.wiringStatus(f.context, { ...wiring, configuration: { version: 2 } }),
      undefined,
    );

    // The held reservation is the installation: its recipient is the host control process and
    // the execution bearer, fixed before Box starts and unchanged when Box restarts to install.
    const endpoint = (
      f.sandbox as unknown as {
        protectedWorkspaceEndpoint(c: object): Promise<Record<string, unknown> | undefined>;
      }
    ).protectedWorkspaceEndpoint.bind(f.sandbox);
    const withdrawal = {
      namespace,
      kubernetes: undefined,
      revision: f.revision,
      signal,
    };
    assert.deepEqual((await endpoint(withdrawal))?.original, {
      purpose: "normal-protected-codex-workspace",
      generationSha256: f.host.generationSha256,
      state: "reserved",
    });
    const installed = await f.release.observe(f.context, wiring);
    assert.ok(installed);
    assert.equal(installed.sandboxId, "box-execution");
    assert.deepEqual(installed.enforcement.repositoryGitRecipient, {
      providerId: `${id}-box-egress`,
      attachmentEpoch: "box-execution",
      processInstanceId: f.host.processInstanceId,
      networkInstanceId: `box-phantom-sha256:${f.host.bearerSha256}`,
      authorization: "online-request",
      deliveryProfile: "github_repository",
    });
    assert.equal(installed.enforcement.peerKeyId, undefined);

    // An installation that is not the host's current one is refused before any release.
    const tampered = structuredClone(installed);
    (
      tampered.enforcement.repositoryGitRecipient as { processInstanceId: string }
    ).processInstanceId = `${f.host.processInstanceId.split(":")[0]}:2:1`;
    await assert.rejects(
      f.sandbox.enrollHarness!(f.harness, tampered, async () => {
        throw new Error("release must not be requested");
      }),
      /not the host's current held Box execution/,
    );
    assert.equal(f.host.releases.length, 0);

    assert.equal(
      await f.release.enroll(
        f.context,
        wiring,
        f.custody,
        async () => true,
        async () => f.harness,
        (startupId, current) => signComputeExecutionRelease(f.keys.privateKey, startupId, current),
      ),
      true,
    );
    assert.equal(f.host.releases.length, 1);
    assert.ok(f.host.startup);
    assert.deepEqual((await endpoint(withdrawal))?.original, {
      purpose: "normal-protected-codex-workspace",
      generationSha256: f.host.generationSha256,
      state: "release-acknowledged",
      startupSha256: f.host.startup.startupSha256,
    });
    // A repeated pass after the release acknowledges it without a second release.
    assert.equal(
      await f.release.enroll(
        f.context,
        wiring,
        f.custody,
        async () => true,
        async () => f.harness,
        (startupId, current) => signComputeExecutionRelease(f.keys.privateKey, startupId, current),
      ),
      true,
    );
    assert.equal(f.host.releases.length, 1);

    // A replaced `box run` (new bearer) no longer verifies as the committed installation.
    const committed = f.committed();
    assert.ok(committed);
    assert.equal(await f.release.verify(f.context, committed), true);
    const previous = f.host.bearerSha256;
    f.host.bearerSha256 = sha("replacement");
    assert.equal(await f.release.verify(f.context, committed), false);
    f.host.bearerSha256 = previous;
    const access = f.sandbox.repositoryAccess!;
    const verified = await access.verifyExecution({
      revision: f.revision,
      signal,
    } as never);
    assert.equal(verified?.executionId, f.plan.execution.executionId);
  },
);

test(
  "after activation the Worker installs OCE's token in Box once; stock git and gh push and open one draft, and withdrawal refuses fresh requests while the execution runs",
  { timeout: 90_000 },
  async (t) => {
    if (gh === undefined) {
      t.diagnostic("stock gh is not installed on this host: the gh steps did not run");
    }
    const f = await pairedFixture(t);
    const signal = AbortSignal.timeout(80_000);
    const wiring = await f.release.configure(f.context);
    const bind = f.owner.requireRepositoryGitTransport();
    let binding = await bind(f.authority);
    assert.ok(binding.reconcile);
    // Before the release and activation OCE has no committed recipient and prepares nothing.
    await binding.reconcile(signal);
    assert.equal(f.state.materialReads, 0);
    assert.equal(f.host.deliveries.length, 0);
    assert.equal(
      await f.release.enroll(
        f.context,
        wiring,
        f.custody,
        async () => true,
        async () => f.harness,
        (startupId, current) => signComputeExecutionRelease(f.keys.privateKey, startupId, current),
      ),
      true,
    );
    assert.equal(f.sandbox.repositoryAccess!.materialSettledAt(f.revision.id), undefined);
    // A lost delivery reply leaves the OCC intent pending; the next pass reads the host back and
    // confirms that exact version without a second intent or a second Box restart.
    f.host.loseDeliveryReply = true;
    await assert.rejects(binding.reconcile(signal), /did not confirm the repository material/);
    assert.equal(f.state.installs, 1);
    assert.equal(f.state.confirms, 0);
    await binding.reconcile(signal);
    assert.equal(f.state.installs, 1);
    assert.equal(f.state.confirms, 1);
    assert.equal(f.host.deliveries.length, 1);
    assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "ready");
    assert.equal(typeof f.sandbox.repositoryAccess!.materialSettledAt(f.revision.id), "number");
    const delivered = f.host.deliveries[0]!;
    assert.deepEqual(Object.keys(delivered).sort(), [
      "expiresAt",
      "installationId",
      "materialVersion",
      "preparationAttemptId",
      "repositories",
      "value",
    ]);
    // A Worker restart adopts the version the host shows in the live `box run`.
    await binding.close();
    binding = await bind(f.authority);
    await binding.reconcile!(signal);
    assert.equal(f.state.installs, 1);
    assert.equal(f.host.deliveries.length, 1);
    assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "ready");
    // STAGE_A_PROTOTYPE: a renewed version is not installed; Box keeps the one it read.
    f.renew();
    await binding.reconcile!(signal);
    assert.equal(f.state.installs, 1);
    assert.equal(f.host.deliveries.length, 1);

    // The host starts `box run` with exactly these routes, policy and environment.
    const box = await boxGitHubEgress(t, {
      config: githubCredentials(),
      policy: policy([], true),
      boxEnvironment: githubCredentialEnvironment(delivered.value),
      upstream: f.origin.upstreamAgent,
    });
    const workload = box.workloadEnvironment;
    for (const secret of box.secrets) {
      assert.ok(!Object.values(workload).some((value) => value.includes(f.origin.credential)));
      assert.ok(secret.includes(f.origin.credential));
    }
    const git = (args: readonly string[]) => f.client(workload, "/usr/bin/git", args);
    const ghClient = (path: string, args: readonly string[]) => f.client(workload, path, args);
    const remote = `https://github.com/${f.origin.repository.repository}.git`;
    await git(["clone", remote, "."]);
    await git(["switch", "-c", "review"]);
    await writeFile(join(f.workspace, "tracked.txt"), "review change\n");
    await git([
      "-c",
      "user.name=Agent",
      "-c",
      "user.email=agent@example.invalid",
      "commit",
      "-am",
      "review change",
    ]);
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["push", remote, "review"]);
    assert.equal(
      (
        await f.origin.git(["--git-dir", f.origin.repoPath, "rev-parse", "refs/heads/review"])
      ).stdout.trim(),
      head,
    );
    if (gh !== undefined) {
      const created = await ghClient(gh, [
        "pr",
        "create",
        "--draft",
        "--repo",
        f.origin.repository.repository,
        "--head",
        "review",
        "--base",
        "main",
        "--title",
        "Review change",
        "--body",
        "From the Box workload",
      ]);
      assert.match(created.stdout, /https:\/\/github\.com\/example\/review\/pull\/7/);
      assert.deepEqual(f.origin.pulls, [
        {
          number: 7,
          id: "PR_7",
          draft: true,
          head: "review",
          base: "main",
          title: "Review change",
          actor: "installation",
        },
      ]);
    }
    assert.ok(box.requests.every(({ outcome }) => outcome === "injected"));
    assert.deepEqual(
      [...new Set(box.requests.map(({ host }) => host))].sort(),
      gh === undefined ? ["github.com"] : ["api.github.com", "github.com"],
    );
    const drafts = gh === undefined ? 0 : 1;
    // Box's egress, not OCE, decided each request: Stage A has no per-request authorization.
    assert.equal(f.state.authorizations, 0);

    // The wrong repository: the installation token does not cover it, so GitHub refuses it.
    const refusedBefore = f.origin.refusals.length;
    await assert.rejects(git(["push", "https://github.com/example/other.git", "review"]), {
      code: 128,
      stderr: /Repository not found|not found/,
    });
    if (gh !== undefined) {
      await assert.rejects(
        ghClient(gh, [
          "pr",
          "create",
          "--draft",
          "--repo",
          "example/other",
          "--head",
          "review",
          "--base",
          "main",
          "--title",
          "Elsewhere",
          "--body",
          "x",
        ]),
        { code: 1, stderr: /Could not resolve to a Repository/ },
      );
    }
    assert.ok(f.origin.refusals.length > refusedBefore);
    // A host outside Box's policy is refused at CONNECT.
    await assert.rejects(git(["ls-remote", "https://gitlab.com/example/review.git"]), {
      code: 128,
    });
    assert.equal(box.requests.at(-1)?.outcome, "refused");
    assert.equal(f.origin.pulls.length, drafts);

    // Withdrawal: OCC stops the material and its retirement revokes the token at GitHub. The
    // Driver sends nothing to the host, so `box run` and the chat keep running.
    assert.equal(
      await f.sandbox.repositoryAccess!.retireExpired({ revision: f.revision, signal } as never),
      "withdrawn",
    );
    f.state.withdrawn = true;
    f.origin.revoke();
    await binding.reconcile!(signal);
    assert.equal(f.host.deliveries.length, 1);
    assert.equal(f.host.deletes, 0);
    assert.equal(f.host.state, "running");
    const writes = f.origin.writes.length;
    const revokedBefore = f.origin.refusals.filter(({ status }) => status === 401).length;
    // Git answers GitHub's 401 by asking for a credential, which the workload does not have.
    await assert.rejects(git(["push", remote, "review:refs/heads/again"]), {
      code: 128,
      stderr: /could not read Username|Authentication failed/,
    });
    if (gh !== undefined) {
      await assert.rejects(
        ghClient(gh, [
          "pr",
          "create",
          "--draft",
          "--repo",
          f.origin.repository.repository,
          "--head",
          "review",
          "--base",
          "main",
          "--title",
          "Again",
          "--body",
          "x",
        ]),
        { code: 1, stderr: /401|Bad credentials/ },
      );
    }
    assert.equal(f.origin.writes.length, writes);
    assert.equal(f.origin.pulls.length, drafts);
    assert.ok(
      f.origin.refusals.filter(({ status }) => status === 401).length >= revokedBefore + 1 + drafts,
    );
    // The host no longer reports the execution: the next pass retires the recipient.
    f.host.present = false;
    await binding.reconcile!(signal);
    assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "pending");
    await binding.close();
  },
);
