import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { isDeepStrictEqual } from "node:util";
import { type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createExternalProtectedDriver } from "../../apps/controller/src/composition/driver-packages.ts";
import { computeReleasePublicKey } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import {
  deliveredMaterial,
  verifyRelease,
  wiringConfiguration as hostWiring,
} from "../../deploy/examples/strands-box/host/control.ts";
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
import { strandsRepositoryOriginFixture } from "./strands-rehearsal-repository.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

// Shared fixture for the paired protected Strands Box registration. The
// baseline file (strands-box-protected.test.ts) and the manual stock-gh file
// (strands-box-protected-gh.test.ts) build the same installed package with it.
const root = fileURLToPath(new URL("../../", import.meta.url));
const driverSource = join(root, "deploy/examples/strands-box/driver");
export const packageName = "@openclaw-enterprise/example-strands-box-driver";
export const id = "strands-box-demo";
const { version: packageVersion } = JSON.parse(
  await readFile(join(driverSource, "package.json"), "utf8"),
) as { version: string };
export const implementation = `${packageName}@${packageVersion}`;
export const endpoint = {
  url: "wss://box-harness.pilot.svc.cluster.local:8443/",
  workspaceRoot: "/home/node/workspace",
};
export const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const namespace: Namespace = {
  id: "ns_pilot",
  name: "pilot",
  status: "ready",
  createdAt: new Date(0).toISOString(),
};
export const relay = {
  image: `registry.example/relay@sha256:${"f".repeat(64)}`,
  hostAddress: "10.0.0.7",
  installation: "pilot",
  workerPeer: { namespace: "control", podLabels: { app: "worker" } },
};
const RELEASE_KEY_ENV = "OPENCLAW_EGRESS_COMPUTE_RELEASE_PUBLIC_KEY";
const REVISION_ENV = "OPENCLAW_EGRESS_ENROLLMENT_REVISION_ID";

const execute = promisify(execFile);

/** Stock `gh` from PATH, as the runtime image installs it; absent here means a typed skip. */
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
export const gh = stockGh();

export async function publicCa(directory: string): Promise<string> {
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

export async function body(message: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Build and install the package the way `driver/README.md` says; peers resolve from the repo. */
export async function installPackage(t: TestContext) {
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

export async function pairedFixture(t: TestContext) {
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
