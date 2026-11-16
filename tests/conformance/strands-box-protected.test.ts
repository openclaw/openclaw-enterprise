import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { request } from "node:https";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
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
import { verifyRelease } from "../../deploy/examples/strands-box/host/control.ts";
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
import { signedLeaf } from "../helpers/certificates.ts";
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

async function freePort(): Promise<number> {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}

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
  "only the paired loader admits a repositorySender registration, and only with both capabilities",
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
    const repositorySender = {
      url: "https://sender.pilot.example:9443/",
      address: "10.0.0.9",
      peerAddress: "10.0.0.7",
      listenPort: 9443,
      certificateFile: "/var/run/sender/tls.crt",
      keyFile: "/var/run/sender/tls.key",
      journalDir: "/var/lib/sender",
      repository: {
        repository: "example/review",
        repositoryId: "1",
        installationId: "2",
        head: "review",
        base: "main",
      },
    };
    const paired = { ...ordinary, repositorySender };
    assert.deepEqual(loaded.module.validateConfiguration?.(paired), []);
    const refused = loaded.module.validateConfiguration?.({
      ...ordinary,
      repositorySender: {
        ...repositorySender,
        url: "https://sender.pilot.example:9443/path",
        address: "8.8.8.8",
        peerAddress: "127.0.0.1",
        journalDir: "relative",
        repository: { ...repositorySender.repository, head: "main" },
      },
    });
    assert.deepEqual(refused?.map(({ path }) => path).sort(), [
      "/repositorySender/address",
      "/repositorySender/journalDir",
      "/repositorySender/peerAddress",
      "/repositorySender/repository",
      "/repositorySender/url",
    ]);
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
  // The installed build's own modules. The registration factory is the one createDriver calls;
  // importing it directly adds only the test-origin agent, which configuration cannot select.
  const { StrandsBoxDriver } = (await import(pathToFileURL(join(dist, "index.js")).href)) as {
    StrandsBoxDriver: unknown;
  };
  const { createProtectedRegistration } = (await import(
    pathToFileURL(join(dist, "protected.js")).href
  )) as {
    createProtectedRegistration: (
      base: unknown,
      id: string,
      implementation: string,
      options: unknown,
      seams: { upstreamAgent?: unknown },
    ) => unknown;
  };
  const socket = join(directory, "control.sock");
  const journalDir = join(directory, "journal");
  await mkdir(journalDir, { mode: 0o700 });
  const leaf = await signedLeaf(directory, origin.authority, {
    name: "sender",
    commonName: "Sender",
    subjectAltName: "IP:127.0.0.1",
    keyPem: undefined,
  });
  const port = await freePort();
  const repositorySender = {
    url: `https://127.0.0.1:${port}/`,
    address: "127.0.0.1",
    peerAddress: "127.0.0.1",
    listenHost: "127.0.0.1",
    listenPort: port,
    certificateFile: leaf.certPath,
    keyFile: leaf.keyPath,
    journalDir,
    repository: origin.repository,
  };
  const configuration = {
    namespace: namespace.name,
    controlSocket: socket,
    nativeEndpoint: endpoint.url,
    nativeCaBundle: origin.caBundle.toString(),
    workspaceRoot: endpoint.workspaceRoot,
    relay,
    repositorySender,
  };
  const module = {
    createDriver: (input: { id: string; implementation: string; configuration: object }) =>
      createProtectedRegistration(
        StrandsBoxDriver,
        input.id,
        input.implementation,
        input.configuration,
        {
          upstreamAgent: origin.upstreamAgent,
        },
      ),
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
  const wiringConfiguration = {
    version: 1,
    repositorySender: { url: repositorySender.url, address: repositorySender.address },
  };
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

  // The fake host serves the host-observed record and runs the real host release check.
  const bearer = randomBytes(32).toString("base64url");
  const [boot, stat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile(`/proc/${process.pid}/stat`, "utf8"),
  ]);
  const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
  const host = {
    present: true,
    live: false,
    bearerSha256: sha(bearer),
    processInstanceId: `${boot.trim()}:${process.pid}:${startTicks}`,
    generationSha256: sha("reservation"),
    startup: undefined as { startupId: string; startupSha256: string } | undefined,
    releases: [] as Record<string, unknown>[],
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
    state: "starting",
    endpoint,
    repositorySender: {
      bearerSha256: host.bearerSha256,
      ...(host.live ? { processInstanceId: host.processInstanceId } : {}),
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
        reply(200, record());
        return;
      }
      reply(409);
    });
  });
  server.listen(socket);
  await once(server, "listening");
  await chmod(socket, 0o600);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  // The OCC authority stand-in: observation, install intent and the online request check.
  const state = { withdrawn: false, observed: 0, installs: 0, materialReads: 0 };
  let fence: RepositoryGitInstallationFence | undefined;
  const version = { preparationAttemptId: "attempt", materialVersion: "version" };
  const material: ProtectedGitHubRepositoryMaterial = {
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
  const denied = { kind: "denied", reason: "unavailable" } as const;
  const compatibility = { readMaterial: async () => undefined, authorize: async () => denied };
  const authority: ProtectedRepositoryGitAuthority = {
    ...compatibility,
    recipients: {
      async observe(installation) {
        state.observed++;
        if (committed === undefined) {
          return undefined;
        }
        assert.deepEqual(installation, committed);
        return (fence = { revisionId: revision.id, fence: 1, observed: installation });
      },
      async beginInstall(route, installed) {
        state.installs++;
        return { ...route, ...installed };
      },
      async confirmInstall({ revisionId, fence: number, observed }) {
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
        async authorize(q) {
          if (state.withdrawn) {
            return { kind: "denied", reason: "access_withdrawn" };
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
  const call = (
    path: string,
    input?: object,
    credential: string = bearer,
  ): Promise<{ status: number; body: Buffer }> =>
    new Promise((resolve, reject) => {
      const payload = input === undefined ? undefined : Buffer.from(JSON.stringify(input));
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: payload ? "POST" : "GET",
          ca: origin.caBundle,
          agent: false,
          headers: {
            authorization: `Bearer ${credential}`,
            ...(payload
              ? { "content-type": "application/json", "content-length": payload.length }
              : {}),
          },
        },
        (res) => {
          void body(res).then(
            (bytes) => resolve({ status: res.statusCode ?? 0, body: bytes }),
            reject,
          );
        },
      );
      req.once("error", reject);
      req.end(payload);
    });
  const remoteGit = (args: readonly string[], cwd?: string) =>
    origin.git(
      [
        "-c",
        `http.extraHeader=Authorization: Bearer ${bearer}`,
        "-c",
        `http.sslCAInfo=${origin.rootCertificatePath}`,
        "-c",
        "http.version=HTTP/1.1",
        ...args,
      ],
      cwd,
    );
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
    wiringConfiguration,
    call,
    remoteGit,
    remote: `https://127.0.0.1:${port}/repository.git`,
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

    // A held reservation without the live `box run` process is not an installation yet.
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
    assert.equal(await f.release.observe(f.context, wiring), undefined);
    f.host.live = true;
    const installed = await f.release.observe(f.context, wiring);
    assert.ok(installed);
    assert.equal(installed.sandboxId, "box-execution");
    assert.deepEqual(installed.enforcement.repositoryGitRecipient, {
      providerId: `${id}-repository-sender`,
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
  "the Worker binding pushes the selected branch and opens one draft, and withdrawal stops new sends",
  { timeout: 40_000 },
  async (t) => {
    const f = await pairedFixture(t);
    const signal = AbortSignal.timeout(30_000);
    f.host.live = true;
    const wiring = await f.release.configure(f.context);
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
    const bind = f.owner.requireRepositoryGitTransport();
    const binding = await bind(f.authority);
    assert.ok(binding.reconcile);
    // Before reconcile, the listener has no recipient and refuses before any provider use.
    assert.equal((await f.call("/repository.git/info/refs?service=git-upload-pack")).status, 403);
    assert.equal(f.state.materialReads, 0);
    await binding.reconcile(signal);
    assert.equal(f.state.installs, 1);
    assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "ready");
    assert.equal(typeof f.sandbox.repositoryAccess!.materialSettledAt(f.revision.id), "number");
    // A repeated pass with the same material version installs nothing new.
    await binding.reconcile(signal);
    assert.equal(f.state.installs, 1);
    await f.proxy.sourceControl.assertAvailable?.(signal, "github_repository");

    assert.equal(
      (await f.call("/repository.git/info/refs?service=git-upload-pack", undefined, "x".repeat(43)))
        .status,
      403,
    );
    const copy = join(f.root, "client");
    await f.remoteGit(["clone", f.remote, copy]);
    await writeFile(join(copy, "tracked.txt"), "review change\n");
    await f.origin.commit("review change", copy);
    const expected = (await f.origin.git(["rev-parse", "HEAD"], copy)).stdout.trim();
    await assert.rejects(f.remoteGit(["push", "origin", "HEAD:refs/heads/main"], copy), /403/);
    await f.remoteGit(["push", "origin", "HEAD:refs/heads/review"], copy);
    assert.equal(
      (
        await f.origin.git(["--git-dir", f.origin.repoPath, "rev-parse", "refs/heads/review"])
      ).stdout.trim(),
      expected,
    );
    const pr = await f.call("/draft-pull", { title: "Review change" });
    assert.equal(pr.status, 201);
    assert.equal(JSON.parse(pr.body.toString()).draft, true);

    // Withdrawal: the authority stops material; the execution keeps running.
    assert.equal(
      await f.sandbox.repositoryAccess!.retireExpired({ revision: f.revision, signal } as never),
      "withdrawn",
    );
    f.state.withdrawn = true;
    const writes = f.origin.writes.length;
    assert.equal((await f.call("/draft-pull", { title: "Again" })).status, 403);
    assert.equal(f.origin.writes.length, writes);
    // The host no longer reports the execution: the next pass retires the recipient.
    f.state.withdrawn = false;
    f.host.present = false;
    await binding.reconcile(signal);
    assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "pending");
    assert.equal((await f.call("/draft-pull", { title: "Again" })).status, 403);
    assert.equal(f.origin.writes.length, writes);
    await binding.close();
  },
);
