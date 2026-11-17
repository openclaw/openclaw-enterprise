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
import {
  computeReleasePublicKey,
  signComputeExecutionRelease,
} from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import { ProtectedExecutionDriver } from "../../apps/controller/src/drivers/compute/protected-execution-driver.ts";
import { createRepositoryGitRequests } from "../../apps/controller/src/drivers/repo/github/access/protected-requests.ts";
import {
  verifyRelease,
  wiringConfiguration as hostWiring,
} from "../../deploy/examples/strands-box/host/control.ts";
import {
  CredentialSourceRelay,
  SOURCE_BEARER_ENV,
  SOURCE_MAX_BODY_BYTES,
  SOURCE_TIMEOUT_MS,
} from "../../deploy/examples/strands-box/host/credential-source.ts";
import { githubCredentials, policy } from "../../deploy/examples/strands-box/host/egress.ts";
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
import { boxGitHubEgress } from "./strands-box-egress.ts";
import { strandsRepositoryOriginFixture } from "./strands-rehearsal-repository.ts";
import { temporaryDirectory } from "./temporary-directory.ts";

// Shared fixture for the paired protected Strands Box registration. The
// baseline file (strands-box-protected.test.ts) and the manual stock-gh file
// (strands-box-protected-gh.test.ts) build the same installed package with it,
// and run the same Stage B end-to-end steps (stageBEndToEnd): the baseline file
// without gh, the manual file with it.
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

/**
 * Stock `gh`, as the runtime image installs it. CI does not stage it, so only the manual
 * strands-box-native lane runs the gh steps, and fails there without it.
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

  // The fake host serves the host-observed record and runs the real host release check and the
  // real host credential source (host/credential-source.ts): Box's socket and the queue the
  // Worker drains over the control socket. Its control process (this test process) is the
  // recipient; `box run` (the Box stand-in below) was started once, with the source routes.
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
    /** The live `box run` asking the source; one process for the whole execution. */
    sourceLive: true,
    collects: 0,
    answers: 0,
    deletes: 0,
  };
  const executionId = "box-execution";
  const sourceDirectory = join(directory, "source");
  await mkdir(sourceDirectory, { mode: 0o700 });
  const sourceSocket = join(sourceDirectory, "oce.sock");
  const source = new CredentialSourceRelay(
    host.bearerSha256,
    () => host.present && host.startup !== undefined,
  );
  await source.listen(sourceSocket);
  t.after(() => source.close());
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
      ...(host.sourceLive
        ? { source: { boxProcessInstanceId: `${boot.trim()}:${process.pid + 1}:${startTicks}` } }
        : {}),
    },
    protectedStartup: {
      plan,
      reservedAt: "2026-11-16T00:00:00.000Z",
      generationSha256: host.generationSha256,
      ...host.startup,
    },
  });
  const server = createHttpServer((req, res) => {
    void body(req).then(async (bytes) => {
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
      if (
        req.method === "POST" &&
        (req.url === "/v1/credential-asks" || req.url === "/v1/credential-answers")
      ) {
        const input = JSON.parse(bytes.toString()) as Record<string, unknown>;
        if (!host.present || input.executionId !== executionId) {
          reply(409, { error: "source_outside_execution" });
          return;
        }
        if (req.url === "/v1/credential-asks") {
          host.collects++;
          const stop = new AbortController();
          res.once("close", () => stop.abort());
          reply(200, { asks: await source.collect(Number(input.waitMs), stop.signal) });
        } else {
          host.answers++;
          reply(source.answer(String(input.askId), input.answer) ? 204 : 409);
        }
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
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  // The OCC authority stand-in: observation, install intent and the online request check. Each
  // allowed or denied owner decision is one row in `uses`, as prepared_repository_git_uses.
  const state = {
    withdrawn: false,
    observed: 0,
    installs: 0,
    confirms: 0,
    materialReads: 0,
    authorizations: 0,
    uses: [] as { exchangeId: string; operation: string; allowed: boolean }[],
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
          const use = (allowed: boolean) =>
            state.uses.push({ exchangeId: q.exchangeId, operation: q.operation, allowed });
          if (state.withdrawn) {
            use(false);
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
            use(false);
            return denied;
          }
          use(true);
          return {
            kind: "allow",
            exchangeId: q.exchangeId,
            requestDigestSha256: q.requestDigestSha256,
            preparationAttemptId: installed.preparationAttemptId,
            materialVersion: installed.materialVersion,
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
    /** OCE's own request decision, bound to the same authority, as the Worker hands it out. */
    requests: createRepositoryGitRequests(authority),
    custody,
    bearer,
    source,
    sourceSocket,
    /** The box.toml credential tables the host writes for this execution's source. */
    boxConfig: githubCredentials({
      socket: sourceSocket,
      bearerEnv: SOURCE_BEARER_ENV,
      timeoutMs: SOURCE_TIMEOUT_MS,
      maxBodyBytes: SOURCE_MAX_BODY_BYTES,
    }),
    committed: () => committed,
    material: () => material,
    /** OCE's renewal: a new attempt, version and token for the same session. */
    renew(value = origin.credential) {
      material = {
        ...material,
        value,
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

/**
 * The Stage B end-to-end steps: activation, request-time readiness (no delivery, no restart),
 * stock git push with one OCE decision per request, renewal while Box keeps running, the
 * wrong-repository refusal by OCE, a host outside policy refused by Box, and withdrawal refused
 * by OCE before any provider connection while the execution runs. With `ghPath` the stock gh
 * draft and its refusals run too (manual lane only).
 */
export async function stageBEndToEnd(t: TestContext, ghPath: string | undefined) {
  const f = await pairedFixture(t);
  const signal = AbortSignal.timeout(80_000);
  const wiring = await f.release.configure(f.context);
  const bind = f.owner.requireRepositoryGitTransport();
  let binding = await bind(f.authority, f.requests);
  assert.ok(binding.reconcile);
  // Before the release and activation OCE has no committed recipient and prepares nothing.
  await binding.reconcile(signal);
  assert.equal(f.state.materialReads, 0);
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
  // The host shows no live source (box run gone): nothing is declared ready.
  f.host.sourceLive = false;
  await binding.reconcile(signal);
  assert.equal(f.state.installs, 0);
  assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "pending");
  f.host.sourceLive = true;
  // Request-time readiness: one install intent and its confirmation, nothing sent to the host.
  await binding.reconcile(signal);
  assert.equal(f.state.installs, 1);
  assert.equal(f.state.confirms, 1);
  assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "ready");
  assert.equal(typeof f.sandbox.repositoryAccess!.materialSettledAt(f.revision.id), "number");
  // A Worker restart adopts the version OCC already holds confirmed for this recipient.
  await binding.close();
  binding = await bind(f.authority, f.requests);
  await binding.reconcile!(signal);
  assert.equal(f.state.installs, 1);
  assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "ready");
  const settledAt = f.sandbox.repositoryAccess!.materialSettledAt(f.revision.id);
  assert.equal(typeof settledAt, "number");

  // The host started `box run` once with exactly these routes, policy and environment: the
  // source bearer is the only value `box run` holds.
  const box = await boxGitHubEgress(t, {
    config: f.boxConfig,
    policy: policy([], true),
    boxEnvironment: { [SOURCE_BEARER_ENV]: f.bearer },
    upstream: f.origin.upstreamAgent,
  });
  const workload = box.workloadEnvironment;
  // The workload sees only placeholders: no token and no source bearer.
  for (const value of Object.values(workload)) {
    assert.ok(!value.includes(f.origin.credential));
    assert.ok(!value.includes(f.bearer));
  }
  assert.match(workload.GITHUB_TOKEN!, /^strands_box_[0-9a-f]{64}$/);
  assert.match(workload.OCE_GITHUB_GIT_CREDENTIAL!, /^strands_box_[0-9a-f]{64}$/);
  const git = (args: readonly string[]) => f.client(workload, "/usr/bin/git", args);
  const ghClient = (args: readonly string[]) => f.client(workload, ghPath!, args);
  const remote = `https://github.com/${f.origin.repository.repository}.git`;
  const decided = () => f.state.uses.length;
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
  // One OCE decision for every request Box sent: each asked, each released, each recorded.
  const pushed = box.requests.filter(({ outcome }) => outcome === "injected");
  assert.ok(pushed.length >= 4, "clone and push take several smart-HTTP requests");
  assert.equal(decided(), pushed.length);
  assert.ok(f.state.uses.every(({ allowed }) => allowed));
  assert.equal(new Set(f.state.uses.map(({ exchangeId }) => exchangeId)).size, decided());
  assert.deepEqual([...new Set(f.state.uses.map(({ operation }) => operation))].sort(), [
    "advertise-receive-pack",
    "advertise-upload-pack",
    "receive-pack",
    "upload-pack",
  ]);
  assert.equal(box.released.size, pushed.length);
  for (const value of box.released.values()) {
    assert.equal(value, `x-access-token:${f.origin.credential}`);
  }

  let drafts = 0;
  if (ghPath !== undefined) {
    const before = decided();
    const created = await ghClient([
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
    drafts = 1;
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
    // gh's GraphQL calls are decided one by one too, and Box placed the bare token.
    assert.ok(decided() > before);
    assert.ok(f.state.uses.slice(before).every(({ operation }) => operation === "github-graphql"));
  }

  // Renewal without restarting Box: until the Worker confirms the new version OCE refuses
  // (fail closed); after it, the same `box run` and placeholders work again.
  f.renew();
  await assert.rejects(git(["ls-remote", remote, "HEAD"]), {
    code: 128,
    stderr: /403|route_not_ready/,
  });
  assert.equal(box.requests.at(-1)?.sourceRefusal, "route_not_ready");
  await binding.reconcile!(signal);
  assert.equal(f.state.installs, 2);
  assert.equal(f.state.confirms, 2);
  assert.equal(f.sandbox.repositoryAccess!.materialSettledAt(f.revision.id), settledAt);
  assert.match((await git(["ls-remote", remote, "HEAD"])).stdout, /\tHEAD$/m);
  assert.equal(f.host.deletes, 0);

  // The wrong repository: OCE's classifier refuses it before Box opens a provider connection.
  const connections = f.origin.connections();
  await assert.rejects(git(["push", "https://github.com/example/other.git", "review"]), {
    code: 128,
    stderr: /403/,
  });
  assert.equal(box.requests.at(-1)?.sourceRefusal, "request_not_allowed");
  if (ghPath !== undefined) {
    await assert.rejects(ghClient(["api", "repos/example/other", "--jq", ".full_name"]), {
      code: 1,
    });
    assert.equal(box.requests.at(-1)?.sourceRefusal, "request_not_allowed");
  }
  assert.equal(f.origin.connections(), connections);
  // A host outside Box's policy is refused at CONNECT; OCE is never asked.
  const asked = decided();
  await assert.rejects(git(["ls-remote", "https://gitlab.com/example/review.git"]), {
    code: 128,
  });
  assert.equal(box.requests.at(-1)?.outcome, "refused");
  assert.equal(box.requests.at(-1)?.method, "CONNECT");
  assert.equal(decided(), asked);
  assert.equal(f.origin.pulls.length, drafts);

  // Withdrawal: OCE refuses the very next request before any provider connection. The Driver
  // sends nothing to the host, so `box run` and the chat keep running.
  assert.equal(
    await f.sandbox.repositoryAccess!.retireExpired({ revision: f.revision, signal } as never),
    "withdrawn",
  );
  f.state.withdrawn = true;
  const writes = f.origin.writes.length;
  const withdrawnAt = f.origin.connections();
  await assert.rejects(git(["push", remote, "review:refs/heads/again"]), {
    code: 128,
    stderr: /403/,
  });
  assert.equal(box.requests.at(-1)?.sourceRefusal, "access_withdrawn");
  if (ghPath !== undefined) {
    await assert.rejects(
      ghClient([
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
      { code: 1 },
    );
    assert.equal(box.requests.at(-1)?.sourceRefusal, "access_withdrawn");
  }
  assert.equal(f.origin.connections(), withdrawnAt);
  assert.equal(f.origin.writes.length, writes);
  assert.equal(f.origin.pulls.length, drafts);
  await binding.reconcile!(signal);
  assert.equal(f.host.deletes, 0);
  assert.equal(f.host.state, "running");
  // The host no longer reports the execution: the next pass retires the recipient, and an ask
  // arriving then is refused without asking OCE.
  f.host.present = false;
  await binding.reconcile!(signal);
  assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "pending");
  await binding.close();
  return { f, box };
}
