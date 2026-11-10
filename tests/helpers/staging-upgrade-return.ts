import type { Agent } from "../../packages/contracts/src/index.ts";
import { imageReferenceProblem } from "../../packages/occ/src/index.ts";
import assert from "node:assert/strict";
import { chmod, copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ProductionTuiRequestError } from "./production-tui-request.ts";
import {
  assertProtectedEqual,
  protectedJSON,
  type FixtureRun,
  type LocalRehearsalCluster,
  type RehearsalCustody,
} from "./production-rehearsal-custody.ts";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;

type ControllerImage = {
  reference: string;
  configDigest: string;
  manifestDigest: string;
  platform: string;
  checkout: string;
  revision: string;
};

type InstallationSecret = {
  metadata: {
    name: string;
    uid: string;
    annotations: Record<string, string>;
    deletionTimestamp?: string;
  };
  immutable: boolean;
  type: string;
  data: Record<string, string> & { "installation.yaml": string };
};

export async function readImmutableInstallationSecret(
  run: FixtureRun,
  kubeArgs: string[],
  name: string,
) {
  const secret = protectedJSON<InstallationSecret>(
    await run("kubectl", [...kubeArgs, "get", `secret/${name}`, "-o", "json"], {
      protectedInput: true,
    }),
  );
  assert.equal(secret.metadata.name, name);
  assert.ok(secret.metadata.uid && !secret.metadata.deletionTimestamp);
  assert.equal(secret.immutable, true, "the Installation reference must be immutable");
  return secret;
}

export function assertInstallationSecretRetained(
  observed: InstallationSecret,
  expected: InstallationSecret,
) {
  assert.equal(observed.metadata.uid, expected.metadata.uid, "Installation Secret was replaced");
  assert.equal(observed.type, expected.type);
  assert.equal(
    observed.metadata.annotations["openclaw.dev/installation-id"],
    expected.metadata.annotations["openclaw.dev/installation-id"],
  );
  assertProtectedEqual(observed.data, expected.data, "Installation Secret bytes changed");
}

export function assertInstallationVolume(
  spec: { volumes?: { name: string; secret?: { secretName: string; items?: unknown } }[] },
  name: string,
) {
  const volumes = spec.volumes?.filter((volume) => volume.name === "installation-startup");
  assert.equal(volumes?.length, 1, "expected exactly one Installation volume");
  const volume = volumes?.[0];
  assert.ok(volume);
  assert.equal(volume.secret?.secretName, name, "workload uses the wrong Installation Secret");
  assert.deepEqual(volume.secret?.items, [{ key: "installation.yaml", path: "installation.yaml" }]);
}

type AgentIdentity = {
  id: string;
  namespaceId: string;
  name: string;
  configurationId: string;
};

function agentIdentity(value: unknown): AgentIdentity {
  const agent = value as Partial<AgentIdentity> | undefined;
  assert.ok(agent, "OCC did not return an Agent");
  const { id, namespaceId, name, configurationId } = agent;
  assert.ok(
    id && namespaceId && name && configurationId,
    "OCC returned an incomplete Agent identity",
  );
  for (const field of [id, namespaceId, name, configurationId]) {
    assert.equal(typeof field, "string", "Agent identity fields must be strings");
  }
  return { id, namespaceId, name, configurationId };
}

export function assertReturnedAgents(
  baseline: AgentIdentity,
  accepted: AgentIdentity,
  observed: readonly AgentIdentity[],
) {
  assert.notEqual(accepted.id, baseline.id, "the candidate must acknowledge a new Agent");
  assert.equal(
    accepted.namespaceId,
    baseline.namespaceId,
    "the write must use the original Namespace",
  );
  for (const [label, expected] of [
    ["preexisting", baseline],
    ["acknowledged", accepted],
  ] as const) {
    const matches = observed.filter((agent) => agent.id === expected.id);
    assert.deepEqual(matches, [expected], `missing or changed ${label} Agent ${expected.id}`);
  }
}

// Capture settings acknowledged by OCC, not just the row identity that remains
// readable when a previous controller cannot decode a saved configuration.
export function returnedAgentSnapshot(value: unknown) {
  const identity = agentIdentity(value);
  const agent = value as Partial<Agent>;
  assert.ok(!("configurationReadError" in agent), "OCC cannot read the saved Agent settings");
  assert.ok(
    agent.executionMode === "embedded" || agent.executionMode === "dedicated",
    "OCC did not return the Agent execution mode",
  );
  assert.equal(typeof agent.gatewayManagedMode, "boolean", "OCC omitted the gateway mode");
  assert.ok("backendId" in agent && "harnessAuth" in agent, "OCC omitted saved Agent settings");
  return {
    ...identity,
    executionMode: agent.executionMode,
    gatewayManagedMode: agent.gatewayManagedMode,
    backendId: agent.backendId,
    harnessAuth: agent.harnessAuth,
    plugins: agent.plugins,
    pluginApprovers: agent.pluginApprovers,
    repositoryBindings: agent.repositoryBindings,
    repositoryAccess: agent.repositoryAccess,
    credentialSources: agent.credentialSources,
  };
}

function assertControllerReference(reference: string | undefined): asserts reference is string {
  assert.ok(
    reference &&
      /@sha256:[a-f0-9]{64}$/u.test(reference) &&
      imageReferenceProblem(reference) === undefined,
    "select a canonical immutable controller image reference",
  );
}

export function assertDistinctControllers(
  previous: Pick<ControllerImage, "reference" | "configDigest" | "revision">,
  candidate: Pick<ControllerImage, "reference" | "configDigest" | "revision">,
) {
  for (const image of [previous, candidate]) {
    assertControllerReference(image.reference);
    assert.match(image.configDigest, digestPattern);
    assert.match(image.revision, commitPattern);
  }
  assert.notEqual(
    previous.reference.split("@")[1],
    candidate.reference.split("@")[1],
    "controller manifest digests must differ",
  );
  assert.notEqual(
    previous.configDigest,
    candidate.configDigest,
    "controller platform configs must differ",
  );
  assert.notEqual(previous.revision, candidate.revision, "controller source commits must differ");
}

export function assertLocalRehearsalSelection(env: NodeJS.ProcessEnv) {
  assert.ok(
    !env.CI &&
      !env.GITHUB_ACTIONS &&
      !env.OPENAI_API_KEY &&
      !env.CODEX_ACCESS_TOKEN &&
      !env.GITHUB_TOKEN &&
      !env.GH_TOKEN &&
      env.OCC_TEST_PRODUCTION_TUI_REAL !== "1" &&
      !env.OCC_TEST_PRODUCTION_UPGRADE_RUNTIME_IMAGE,
    "run the controller rehearsal locally without model credentials or the live TUI/runtime upgrade",
  );
}

// Git status alone trusts assume-unchanged/skip-worktree bits and excludes ignored
// files. Release inputs must contain the committed bytes without build shadows.
const verifyReleaseCheckout = String.raw`
import hashlib, os, stat, subprocess, sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
revision = sys.argv[2]
def fail():
    sys.exit("release checkout must contain only unmodified committed files")
def git(*args):
    return subprocess.check_output([
        "git", "--no-optional-locks", "--no-replace-objects",
        "--git-dir=" + str(root / ".git"), "--work-tree=" + str(root), *args
    ], cwd=root)

if git("rev-parse", "HEAD").decode().strip() != revision:
    fail()
if any(record[:2] != b"H " for record in git("ls-files", "-v", "-z").split(b"\0") if record):
    fail()
expected = set()
directories = set()
for record in git("ls-tree", "-rz", revision).split(b"\0"):
    if not record:
        continue
    metadata, raw_path = record.split(b"\t", 1)
    mode, kind, oid = metadata.split()
    relative = Path(os.fsdecode(raw_path))
    if kind != b"blob" or mode not in (b"100644", b"100755"):
        fail()
    path = root / relative
    for parent in relative.parents:
        if parent != Path("."):
            directories.add(parent)
            if not stat.S_ISDIR((root / parent).lstat().st_mode):
                fail()
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or bool(info.st_mode & 0o111) != (mode == b"100755"):
        fail()
    content = path.read_bytes()
    actual = hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest()
    if actual.encode() != oid:
        fail()
    expected.add(relative)
for directory, names, files in os.walk(root, followlinks=False):
    relative = Path(directory).relative_to(root)
    if relative == Path("."):
        names[:] = [name for name in names if name != ".git"]
        files = [name for name in files if name != ".git"]
    for name in names:
        if relative / name not in directories or not stat.S_ISDIR((root / relative / name).lstat().st_mode):
            fail()
    if any(relative / name not in expected for name in files):
        fail()
`;

export async function selectRehearsalControllers(run: FixtureRun, env: NodeJS.ProcessEnv) {
  assertLocalRehearsalSelection(env);
  const imageIdentity = fileURLToPath(
    new URL("../../scripts/upgrade-image-identity.py", import.meta.url),
  );
  const select = async (
    reference: string | undefined,
    checkout: string | undefined,
    label: string,
  ) => {
    assertControllerReference(reference);
    assert.ok(checkout && isAbsolute(checkout), `select an absolute ${label} source checkout`);
    const revision = (await run("git", ["rev-parse", "HEAD"], { cwd: checkout })).trim();
    assert.match(revision, commitPattern);
    assert.equal(
      (await run("git", ["status", "--porcelain"], { cwd: checkout })).trim(),
      "",
      `the ${label} release checkout must be clean`,
    );
    await run("python3", ["-c", verifyReleaseCheckout, checkout, revision]);
    return { reference, checkout, revision };
  };
  const previousSource = await select(
    env.OCC_TEST_PRODUCTION_CONTROLLER_IMAGE,
    env.OCC_TEST_REHEARSAL_PREVIOUS_SOURCE,
    "previous",
  );
  const candidateSource = await select(
    env.OCC_TEST_PRODUCTION_UPGRADE_CONTROLLER_IMAGE,
    env.OCC_TEST_REHEARSAL_CANDIDATE_SOURCE,
    "candidate",
  );
  assert.notEqual(
    previousSource.reference.split("@")[1],
    candidateSource.reference.split("@")[1],
    "controller manifest digests must differ",
  );
  assert.notEqual(
    previousSource.revision,
    candidateSource.revision,
    "controller source commits must differ",
  );
  await run(
    "git",
    ["merge-base", "--is-ancestor", previousSource.revision, candidateSource.revision],
    {
      cwd: candidateSource.checkout,
    },
  );
  const platform = (
    await run("docker", ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"])
  ).trim();
  assert.match(platform, /^linux\/(amd64|arm64)$/u, "select a supported local Docker platform");
  const inspect = async (selection: typeof previousSource) => {
    const { reference, revision } = selection;
    const imageRevision = (
      await run("docker", [
        "image",
        "inspect",
        "--platform",
        platform,
        "--format",
        '{{index .Config.Labels "org.opencontainers.image.revision"}}',
        reference,
      ])
    ).trim();
    assert.equal(imageRevision, revision, "the controller must match its source checkout");
    const identity = JSON.parse(
      await run("python3", [imageIdentity, reference, platform], { timeout: 180_000 }),
    );
    assert.equal(identity.image, reference);
    assert.equal(identity.platform, platform);
    assert.equal(identity.rootDigest, reference.split("@")[1]);
    assert.match(identity.manifestDigest, digestPattern);
    assert.match(identity.configDigest, digestPattern);
    return {
      ...selection,
      manifestDigest: identity.manifestDigest as string,
      configDigest: identity.configDigest as string,
      platform,
    };
  };
  const previous = await inspect(previousSource);
  const candidate = await inspect(candidateSource);
  assertDistinctControllers(previous, candidate);
  return { previous, candidate };
}

type Controllers = Awaited<ReturnType<typeof selectRehearsalControllers>>;
type Api = (
  method: "GET" | "POST",
  path: string,
  body?: object,
  expected?: number,
) => Promise<unknown>;
type Kubectl = (...args: string[]) => Promise<string>;
type ExternalRequest = (
  method: "GET",
  path: string,
  body: undefined,
  options: { authenticated: boolean; signal?: AbortSignal },
) => Promise<{ status: number | undefined; requestId?: string; body: unknown }>;

// These observations describe the fixture's authenticated HTTPS route. They do
// not establish continuous availability between requests or gate the upgrade.
export async function measureUpgradeAvailability<T>(
  request: ExternalRequest,
  installationId: string,
  directory: string,
  upgrade: () => Promise<T>,
  record: (details: object) => Promise<void>,
) {
  const samples: {
    phase: "before" | "during" | "after";
    startedAt: string;
    finishedAt: string;
    elapsedMs: number;
    gapMs: number | null;
    outcome:
      "ok" | "http-error" | "invalid-response" | "wrong-installation" | "timeout" | "request-error";
    status: number | undefined;
    requestId?: string;
  }[] = [];
  let previousFinish: number | undefined;
  const evidenceErrors: unknown[] = [];
  const evidence = (upgradeSucceeded: boolean | null) => ({
    requestTimeoutMs: 5_000,
    intervalAfterResponseMs: 1_000,
    upgradeSucceeded,
    samples: samples.map((observation) => ({ ...observation })),
  });
  const sample = async (
    phase: (typeof samples)[number]["phase"],
    upgradeSucceeded: boolean | null = null,
  ) => {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const signal = AbortSignal.timeout(5_000);
    let outcome: (typeof samples)[number]["outcome"];
    let status: number | undefined;
    let requestId: string | undefined;
    try {
      const response = await request("GET", "/installation", undefined, {
        authenticated: true,
        signal,
      });
      status = response.status;
      const body = response.body as {
        data?: { id?: unknown };
      } | null;
      if (status !== 200) {
        outcome = "http-error";
      } else if (typeof body?.data?.id !== "string") {
        outcome = "invalid-response";
      } else if (body.data.id !== installationId) {
        outcome = "wrong-installation";
      } else {
        outcome = "ok";
        requestId = response.requestId;
      }
    } catch (error) {
      // Keep received status even when strict response parsing rejects the body.
      // Transport errors can contain private bytes; never retain their text.
      status = error instanceof ProductionTuiRequestError ? error.status : undefined;
      if (signal.aborted) {
        outcome = "timeout";
      } else if (status !== undefined && status !== 200) {
        outcome = "http-error";
      } else {
        outcome = "request-error";
      }
    }
    const finish = performance.now();
    samples.push({
      phase,
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Math.round(finish - start),
      gapMs: previousFinish === undefined ? null : Math.round(start - previousFinish),
      outcome,
      status,
      ...(requestId === undefined ? {} : { requestId }),
    });
    previousFinish = finish;
    try {
      // A killed runner leaves the last complete snapshot, never a truncated one.
      // Null means the action has not been recorded as settled.
      const path = join(directory, "forward-api-availability.json");
      await writeFile(`${path}.tmp`, JSON.stringify(evidence(upgradeSucceeded)) + "\n", {
        mode: 0o600,
      });
      await rename(`${path}.tmp`, path);
    } catch (error) {
      // Keep observing without rejecting in parallel with the running upgrade.
      if (evidenceErrors.length === 0) {
        evidenceErrors.push(error);
      }
    }
  };
  await sample("before");
  const stopped = new AbortController();
  let observing: Promise<void> | undefined;
  let outcome: { succeeded: true; value: T } | { succeeded: false; error: unknown };
  try {
    const upgrading = upgrade();
    observing = (async () => {
      while (!stopped.signal.aborted) {
        await sample("during");
        await delay(1_000, undefined, { signal: stopped.signal }).catch(() => {});
      }
    })();
    outcome = { succeeded: true, value: await upgrading };
  } catch (error) {
    outcome = { succeeded: false, error };
  }
  stopped.abort();
  // Join the final bounded request before taking the post-upgrade observation.
  await observing;
  await sample("after", outcome.succeeded);
  try {
    await record(evidence(outcome.succeeded));
  } catch (error) {
    evidenceErrors.push(error);
  }
  if (!outcome.succeeded) {
    if (evidenceErrors.length > 0) {
      throw new AggregateError(
        [outcome.error, ...evidenceErrors],
        "Upgrade failed and API availability observations could not be recorded",
        { cause: outcome.error },
      );
    }
    throw outcome.error;
  }
  if (evidenceErrors.length === 1) {
    throw evidenceErrors[0];
  }
  if (evidenceErrors.length > 1) {
    throw new AggregateError(evidenceErrors, "API availability observations could not be recorded");
  }
  return outcome.value;
}

async function assertReturnedInstallationAuthentication(
  request: ExternalRequest,
  installationId: string,
) {
  const denied = await request("GET", "/installation", undefined, { authenticated: false });
  assert.equal(denied.status, 401, "the returned OCC must deny anonymous Installation reads");
  const authorized = await request("GET", "/installation", undefined, { authenticated: true });
  assert.equal(authorized.status, 200, "the returned OCC must accept the original service key");
  const body = authorized.body as { data?: { id?: string } } | null;
  assert.ok(
    body?.data?.id === installationId,
    "the returned OCC must serve the original Installation",
  );
}
type Rehearsal = {
  controllers: Controllers;
  kubeconfig: string;
  context: string;
  namespace: string;
  release: string;
  directory: string;
  occ: string;
  occEnv: NodeJS.ProcessEnv;
  namespaceId: string;
  tenant: string;
  runtime: string;
  run: FixtureRun;
  kubectl: Kubectl;
  api: Api;
  externalRequest: ExternalRequest;
  custody: RehearsalCustody;
  localCluster: LocalRehearsalCluster;
  waitFor: <T>(
    description: string,
    check: () => Promise<T | false>,
    timeout?: number,
  ) => Promise<T>;
  record: (row: string, details?: object) => Promise<void>;
};

type ContainerStatus = {
  name: string;
  imageID: string;
  containerID: string;
  ready: boolean;
  state?: { terminated?: { exitCode: number } };
};

type Pod = {
  metadata: {
    name: string;
    uid: string;
    labels: Record<string, string>;
    annotations?: Record<string, string>;
    deletionTimestamp?: string;
    ownerReferences?: { uid: string; controller?: boolean }[];
  };
  spec: {
    nodeName: string;
    serviceAccountName: string;
    containers: { name: string; image: string }[];
    initContainers?: { name: string; image: string }[];
    volumes?: { name: string; secret?: { secretName: string; items?: unknown } }[];
  };
  status: {
    phase: string;
    podIP: string;
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
  };
};

export async function assertRunningController(
  image: Pick<ControllerImage, "reference" | "platform" | "manifestDigest" | "configDigest">,
  platform: string,
  imageID: string | undefined,
  readContainerImage: () => Promise<string | undefined>,
) {
  assert.equal(
    platform,
    image.platform,
    "controller Pod is scheduled on a different OS or architecture",
  );
  const observed = imageID?.match(/sha256:[a-f0-9]{64}$/u)?.[0];
  if (observed === image.manifestDigest || observed === image.configDigest) {
    return observed;
  }
  // Kubernetes can report the repository index instead of the selected child.
  // An index is only a locator. Prove the actual container's config separately.
  assert.ok(
    observed === image.reference.split("@")[1] &&
      (await readContainerImage()) === image.configDigest,
    "the running controller image ID differs from the selected platform image",
  );
  return image.configDigest;
}

const components = ["api", "worker"] as const;
const originalDatabase = "openclaw_enterprise";
const restoredDatabase = "occ_return";
const staleDatabase = "occ_stale";

export function returnedDatabaseConnections(active: readonly string[], podIPs: readonly string[]) {
  assert.equal(new Set(podIPs).size, 2, "expected distinct API and worker Pod addresses");
  assert.ok(
    active.every((client) => !client.startsWith(`${originalDatabase}:`)),
    "the retained candidate database still has an application connection",
  );
  return podIPs.every((ip) => active.includes(`${restoredDatabase}:${ip}`));
}

export async function verifyCompletedMigrationHistory(
  run: FixtureRun,
  kubeArgs: string[],
  podName: string,
) {
  const output = await run("kubectl", [...kubeArgs, "logs", `pod/${podName}`, "-c", "migration"], {
    protectedInput: true,
  });
  let receiptCount = 0;
  let completedReceiptCount = 0;
  try {
    for (const line of output.split("\n")) {
      if (line.trim() === "") {
        continue;
      }
      const entry = protectedJSON<unknown>(line);
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error("invalid log record");
      }
      // The structured companion event carries no history. Count receipts only.
      if ("event" in entry && entry.event === "migration.checked" && "history" in entry) {
        receiptCount++;
        if (entry.history === "completed") {
          completedReceiptCount++;
        }
      }
    }
  } catch {
    throw new Error("previous controller migration check returned invalid protected log records");
  }
  assert.ok(
    receiptCount === 1 && completedReceiptCount === 1,
    "previous controller migration check requires exactly one completed history receipt",
  );
}

export async function rehearsePopulatedReturn({
  controllers,
  kubeconfig,
  context,
  namespace,
  release,
  directory,
  occ,
  occEnv,
  namespaceId,
  tenant,
  runtime,
  run,
  kubectl,
  api,
  externalRequest,
  custody,
  localCluster,
  waitFor,
  record,
}: Rehearsal) {
  const { previous, candidate } = controllers;
  const helmArgs = [
    `--kubeconfig=${kubeconfig}`,
    `--kube-context=${context}`,
    `--namespace=${namespace}`,
  ];
  const helm = (...args: string[]) => run("helm", [...args, ...helmArgs], { timeout: 330_000 });
  const kubeArgs = [
    `--kubeconfig=${kubeconfig}`,
    `--context=${context}`,
    `--namespace=${namespace}`,
  ];
  const kube = (...args: string[]) => kubectl("--namespace", namespace, ...args);
  const get = async (resource: string) => JSON.parse(await kube("get", resource, "-o", "json"));
  const startupSecret = (name = "occ-installation-startup") =>
    readImmutableInstallationSecret(run, kubeArgs, name);
  const installationPath = "/installation";
  const namespacePath = `/namespaces/${encodeURIComponent(namespaceId)}`;
  const agentPath = `${namespacePath}/agents`;
  const readAgent = async (id: string) =>
    returnedAgentSnapshot(await api("GET", `${agentPath}/${encodeURIComponent(id)}`));
  const helmStatus = async () => JSON.parse(await helm("status", release, "-o", "json"));
  const phase = async <T>(name: string, action: () => Promise<T>) => {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    await writeFile(
      join(directory, "return-progress.json"),
      JSON.stringify({ phase: name, startedAt }) + "\n",
      { mode: 0o600 },
    );
    const result = await action();
    await record(name, {
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - start),
    });
    return result;
  };
  const { postgres } = custody;
  const sql = async (database: string, query: string) =>
    (
      await postgres("psql", "-XAt", "-v", "ON_ERROR_STOP=1", `--dbname=${database}`, "-c", query)
    ).trim();
  const dump = (file: string) =>
    postgres("pg_dump", "--format=custom", `--file=${file}`, originalDatabase);
  const restore = async (database: string, file: string) => {
    await postgres("createdb", "--template=template0", database);
    await postgres(
      "pg_restore",
      "--exit-on-error",
      "--single-transaction",
      `--dbname=${database}`,
      file,
    );
    await sql(database, `GRANT CREATE ON DATABASE ${database} TO occ_migrator`);
  };
  const migrationReceipts = (database: string) =>
    sql(database, "SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id");
  const databaseAgents = async (database: string) =>
    (
      JSON.parse(
        await sql(
          database,
          `SELECT COALESCE(json_agg(json_build_object(
      'id', id, 'namespaceId', namespace_id, 'name', name, 'configurationId', configuration_id
    )), '[]') FROM occ.agents`,
        ),
      ) as unknown[]
    ).map(agentIdentity);
  const pods = async () =>
    (
      JSON.parse(
        await kube(
          "get",
          "pods",
          "-l",
          `app.kubernetes.io/name=openclaw-enterprise,app.kubernetes.io/instance=${release},app.kubernetes.io/component in (api,worker)`,
          "-o",
          "json",
        ),
      ) as { items: Pod[] }
    ).items;
  const claimIdentity = async () =>
    Promise.all(
      ["postgres-data", "bootstrap-password"].map(async (name) => {
        const { metadata, spec } = await get(`pvc/${name}`);
        assert.ok(metadata.uid && spec.volumeName, `unbound claim ${name}`);
        return { name, uid: metadata.uid, volume: spec.volumeName };
      }),
    );
  const verifyPodImage = async (
    image: ControllerImage,
    pod: Pod,
    status: ContainerStatus | undefined,
  ) => {
    assert.equal(
      pod.spec.nodeName,
      localCluster.node,
      "controller Pod must use the owned k3d Node",
    );
    const node = await get(`node/${pod.spec.nodeName}`);
    assert.equal(node.metadata.uid, localCluster.nodeUID, "the owned k3d Node was replaced");
    const { operatingSystem, architecture } = node.status.nodeInfo;
    assert.ok(status, "the controller container has no runtime status");
    return assertRunningController(
      image,
      `${operatingSystem}/${architecture}`,
      status.imageID,
      () => localCluster.runningConfigDigest(status.containerID, pod.metadata.uid),
    );
  };
  const controlPlane = async (image: ControllerImage, database: string, secretName: string) => {
    const currentPods = await pods();
    assert.equal(currentPods.length, components.length, "expected one API and one worker Pod");
    return Promise.all(
      components.map(async (component) => {
        const deployment = await get(`deployment/openclaw-enterprise-${component}`);
        assert.equal(deployment.metadata.labels["app.kubernetes.io/instance"], release);
        assert.equal(deployment.spec.replicas, 1);
        assert.ok(deployment.metadata.uid);
        assertInstallationVolume(deployment.spec.template.spec, secretName);
        assert.equal(
          deployment.spec.template.spec.containers.find(
            (container: { name: string }) => container.name === component,
          )?.image,
          image.reference,
        );
        const pod = currentPods.find(
          (item) => item.metadata.labels["app.kubernetes.io/component"] === component,
        );
        assert.ok(
          pod?.metadata.uid && pod.status.podIP && pod.status.phase === "Running",
          `${component} Pod did not start`,
        );
        assert.equal(
          pod.spec.containers.find((container) => container.name === component)?.image,
          image.reference,
        );
        assertInstallationVolume(pod.spec, secretName);
        const status = pod.status.containerStatuses?.find((item) => item.name === component);
        assert.ok(status?.ready, `${component} container is not ready`);
        const imageDigest = await verifyPodImage(image, pod, status);
        assert.equal(pod.spec.serviceAccountName, `openclaw-enterprise-${component}`);
        const account = await get(`serviceaccount/${pod.spec.serviceAccountName}`);
        assert.ok(account.metadata.uid, `${component} ServiceAccount must have an identity`);
        const selectedDatabase = await run(
          "kubectl",
          [
            `--kubeconfig=${kubeconfig}`,
            `--context=${context}`,
            `--namespace=${namespace}`,
            "exec",
            `pod/${pod.metadata.name}`,
            "-c",
            component,
            "--",
            "node",
            "-e",
            "console.log(new URL(process.env.OCC_DATABASE_URL).pathname.slice(1))",
          ],
          { protectedInput: true },
        );
        assert.equal(selectedDatabase.trim(), database, `${component} uses the wrong database`);
        return {
          component,
          pod: pod.metadata.name,
          uid: pod.metadata.uid,
          deploymentUID: deployment.metadata.uid,
          serviceAccountUID: account.metadata.uid,
          ip: pod.status.podIP,
          imageID: status.imageID,
          imageDigest,
        };
      }),
    );
  };
  const candidateConnections = () =>
    sql(
      "postgres",
      `SELECT count(*) FROM pg_stat_activity
    WHERE datname = '${originalDatabase}' AND usename IN ('occ_app', 'occ_migrator')`,
    );
  const assertNoCandidateWriters = async () => {
    assert.deepEqual(await pods(), [], "API or worker Pods still exist");
    for (const component of components) {
      assert.equal((await get(`deployment/openclaw-enterprise-${component}`)).spec.replicas, 0);
    }
    assert.equal(await candidateConnections(), "0");
  };
  const baselineRelease = await helmStatus();
  const retiredPolicyName = "openclaw-enterprise-api-channel-directory-egress";
  const retiredPolicy = await get(`networkpolicy/${retiredPolicyName}`);
  assert.equal(retiredPolicy.metadata.annotations["meta.helm.sh/release-name"], release);
  assert.equal(retiredPolicy.metadata.annotations["meta.helm.sh/release-namespace"], namespace);
  const candidateValuesPath = join(directory, "return-candidate-values.json");
  const candidateValues = JSON.parse(await readFile(join(directory, "values.json"), "utf8"));
  assert.equal(candidateValues.api.channelDirectoryProxyUrl, "http://198.51.100.25:3128");
  candidateValues.api.channelDirectoryProxyUrl = "";
  assert.equal(baselineRelease.info.status, "deployed");
  assert.ok(Number.isSafeInteger(baselineRelease.version) && baselineRelease.version > 0);
  await custody.assertRelease();
  const postgresIdentity = await custody.assertPostgres();
  const namespaceUID = custody.namespaceUID(namespace);
  const tenantUID = custody.namespaceUID(tenant);
  const claims = await claimIdentity();
  const initialStartupSecret = await startupSecret();
  custody.assertUID("secret/occ-installation-startup", initialStartupSecret.metadata.uid);
  const startup = protectedJSON<{
    drivers?: { compute?: { configuration?: { images?: { gateway?: string; agent?: string } } } };
  }>(Buffer.from(initialStartupSecret.data["installation.yaml"], "base64").toString("utf8"));
  const startupImages = startup.drivers?.compute?.configuration?.images;
  assert.ok(
    startupImages?.gateway === runtime && startupImages?.agent === runtime,
    "installation startup Secret must retain the selected runtime image",
  );
  const { id: installationId } = (await api("GET", installationPath)) as { id: string };
  assert.ok(installationId && namespaceUID && tenantUID && initialStartupSecret.metadata.uid);
  assert.equal(
    initialStartupSecret.metadata.annotations["openclaw.dev/installation-id"],
    installationId,
  );
  // The operator stages a new immutable reference; neither the forward upgrade
  // nor returning to the previous release may rewrite either Secret.
  const successorName = "occ-installation-successor";
  const successorObject = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      ...custody.metadata(successorName),
      annotations: { "openclaw.dev/installation-id": installationId },
    },
    immutable: true,
    type: initialStartupSecret.type,
    data: initialStartupSecret.data,
  };
  const successorUID = await custody.create(successorObject);
  const successor = await startupSecret(successorName);
  assert.equal(successor.metadata.uid, successorUID, "staged Installation Secret was replaced");
  assert.notEqual(successor.metadata.uid, initialStartupSecret.metadata.uid);
  assertProtectedEqual(successor.data, initialStartupSecret.data, "staged configuration differs");
  candidateValues.installation.secretName = successorName;
  await writeFile(candidateValuesPath, JSON.stringify(candidateValues), {
    mode: 0o600,
    flag: "wx",
  });
  const retainInstallationSecrets = async () => {
    assertInstallationSecretRetained(await startupSecret(), initialStartupSecret);
    assertInstallationSecretRetained(await startupSecret(successorName), successor);
  };
  const verifyInstallation = async () => {
    const installation = (await api("GET", installationPath)) as { id: string };
    assert.equal(installation.id, installationId);
    const saved = (await api("GET", namespacePath)) as { id: string; status: string };
    assert.equal(saved.id, namespaceId);
    assert.equal(saved.status, "ready");
  };
  const previousPods = await controlPlane(
    previous,
    originalDatabase,
    initialStartupSecret.metadata.name,
  );
  const writerIdentities = (observed: typeof previousPods) =>
    observed.map(({ deploymentUID, serviceAccountUID }) => ({ deploymentUID, serviceAccountUID }));
  const previousJob = (await get(`job/${release}-initialization`)).spec.template;
  const priorMigration = previousJob.spec.initContainers.find(
    (container: { name: string }) => container.name === "migration",
  );
  assert.equal(
    priorMigration?.image,
    previous.reference,
    "previous migration image differs from the serving release",
  );

  // Create drafts through the production API. They populate both PostgreSQL and the
  // tenant Configuration Driver, without starting a runtime or sending a model request.
  const { id: configurationId } = (await api(
    "POST",
    `${namespacePath}/configurations`,
    {
      kind: "agent",
      values: {},
    },
    201,
  )) as { id: string };
  assert.ok(configurationId);
  const checkMigration = async (
    image: ControllerImage,
    template: typeof previousJob,
    database: string,
    probeName: string,
  ) => {
    const migration = template.spec.initContainers.find(
      (container: { name: string }) => container.name === "migration",
    );
    assert.equal(migration?.image, image.reference, "migration probe must use the selected image");
    const probeSecret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: custody.metadata(probeName),
      data: { "migration-url": await custody.restoredMigrationURL(database) },
    };
    const probe = {
      apiVersion: "v1",
      kind: "Pod",
      // Copy the chart's network policy labels, not the Job's ownership labels.
      metadata: custody.metadata(probeName, {
        "app.kubernetes.io/name": "openclaw-enterprise",
        "app.kubernetes.io/instance": release,
        "app.kubernetes.io/component": "initialization",
      }),
      spec: {
        restartPolicy: "Never",
        activeDeadlineSeconds: 120,
        automountServiceAccountToken: false,
        securityContext: template.spec.securityContext,
        volumes: template.spec.volumes?.filter((volume: { name: string }) =>
          migration.volumeMounts?.some((mount: { name: string }) => mount.name === volume.name),
        ),
        containers: [
          {
            ...migration,
            args: ["scripts/migrate-production.mjs", "--check"],
            env: [
              ...migration.env.filter(
                (entry: { name: string }) => entry.name !== "OCC_MIGRATION_DATABASE_URL",
              ),
              {
                name: "OCC_MIGRATION_DATABASE_URL",
                valueFrom: { secretKeyRef: { name: probeName, key: "migration-url" } },
              },
            ],
          },
        ],
      },
    };
    await custody.create(probeSecret);
    const probeUID = await custody.create(probe);
    const completed = await waitFor<Pod>("controller migration check", async () => {
      const pod: Pod = await get(`pod/${probeName}`);
      assert.equal(pod.metadata.uid, probeUID, "the compatibility Pod was replaced");
      return ["Succeeded", "Failed"].includes(pod.status.phase) ? pod : false;
    });
    await verifyPodImage(
      image,
      completed,
      completed.status.containerStatuses?.find(({ name }) => name === "migration"),
    );
    assert.equal(completed.status.phase, "Succeeded", "selected image cannot use the database");
    await verifyCompletedMigrationHistory(run, kubeArgs, probeName);
  };

  const createAgent = async (name: string) => {
    const agent = returnedAgentSnapshot(
      await api("POST", agentPath, { name, configurationId, executionMode: "embedded" }, 201),
    );
    assert.deepEqual(agentIdentity(agent), { id: agent.id, namespaceId, name, configurationId });
    assert.equal(agent.executionMode, "embedded", "OCC changed the submitted execution mode");
    return agent;
  };
  const baseline = await createAgent("before-upgrade");
  assert.deepEqual(await readAgent(baseline.id), baseline);
  await verifyInstallation();
  await record("Previous OCC serves the populated Installation", {
    installationId,
    namespaceId,
    namespaceUID,
    tenantUID,
    claims,
    postgres: postgresIdentity,
    baseline,
    previousPods,
    previous,
    candidate,
    runtime,
    helmRevision: baselineRelease.version,
  });

  const staleArchive = "/tmp/occ-before-upgrade.pgdump";
  const candidateArchive = "/tmp/occ-after-write.pgdump";
  await phase("Capture the pre-upgrade control archive", () => dump(staleArchive));

  const upgradeArgs = [
    "--kubeconfig",
    kubeconfig,
    "--context",
    context,
    "--namespace",
    namespace,
    "--release",
    release,
    "--values",
    join(directory, "values.json"),
    "--installation",
    join(directory, "installation.json"),
    "--candidate-values",
    candidateValuesPath,
    "--controller-image",
    candidate.reference,
    "--source-revision",
    candidate.revision,
    "--occ",
    occ,
    "--timeout-seconds",
    "300",
  ];
  const upgrade = async (args: string[], env = occEnv, stderrPath?: string) => {
    await localCluster.assertCluster();
    await custody.assertPostgres();
    await custody.assertRelease();
    const command = ["scripts/upgrade-production-images", ...upgradeArgs, ...args];
    return run(
      "bash",
      stderrPath
        ? ["-c", 'output=$1; shift; exec bash "$@" 2>"$output"', "recovery", stderrPath, ...command]
        : command,
      {
        cwd: candidate.checkout,
        env,
        protectedInput: true,
        timeout: 720_000,
      },
    );
  };
  await phase("Check the candidate without stopping writers", () =>
    upgrade(["--preflight-only", "--evidence-dir", join(directory, "preflight")]),
  );
  await phase("Recover the interrupted controller upgrade after committed initialization", () =>
    measureUpgradeAvailability(
      externalRequest,
      installationId,
      directory,
      async () => {
        const evidence = join(directory, "forward");
        const client = join(directory, "helm-client.json");
        const shimDirectory = join(directory, "helm-client-bin");
        const shim = join(shimDirectory, "helm");
        const controller = fileURLToPath(new URL("./rehearsal-helm-client.py", import.meta.url));
        const executable = (await run("sh", ["-c", "command -v helm"])).trim();
        assert.ok(isAbsolute(executable), "the real Helm executable must have an absolute path");
        await mkdir(shimDirectory, { mode: 0o700 });
        await copyFile(controller, shim);
        await chmod(shim, 0o700);
        const clientAction = (action: string) => run("python3", [controller, client, action]);
        const readIfPresent = async (path: string) => {
          try {
            return await readFile(path, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return undefined;
            }
            throw error;
          }
        };
        const save = (name: string, value: unknown) =>
          writeFile(join(directory, name), JSON.stringify(value) + "\n", {
            mode: 0o600,
            flag: "wx",
          });

        // The shim execs stock Helm with unchanged arguments. Only its exact PID and
        // Linux start time can be signalled; no API, chart hook or Helm record is faked.
        let ended = false;
        const command = upgrade(["--evidence-dir", evidence], {
          ...occEnv,
          PATH: `${shimDirectory}:${occEnv.PATH ?? process.env.PATH}`,
          OCE_REHEARSAL_HELM: executable,
          OCE_REHEARSAL_RELEASE: release,
          OCE_REHEARSAL_HELM_CLIENT: client,
        }).then(
          () => {
            ended = true;
            return undefined;
          },
          (error: unknown) => {
            ended = true;
            return error;
          },
        );
        const annotation = "openclaw.dev/upgrade-attempt";
        let intent = "";
        let initializer:
          | {
              metadata: { uid: string; annotations: Record<string, string> };
              spec: { template: typeof previousJob };
            }
          | undefined;
        let pending;
        let completedPod: Pod | undefined;
        try {
          initializer = await waitFor("the submitted candidate's initializer", async () => {
            assert.ok(!ended, "the upgrade ended before its Helm client could be interrupted");
            const submitted = await readIfPresent(join(evidence, "helm-started"));
            if (!submitted) {
              return false;
            }
            const { attempt, previousRevision, expectedRevision } = protectedJSON<{
              attempt: { nonce: string };
              previousRevision: number;
              expectedRevision: number;
            }>(submitted);
            assert.equal(previousRevision, baselineRelease.version);
            assert.equal(expectedRevision, baselineRelease.version + 1);
            const output = await kube(
              "get",
              `job/${release}-initialization`,
              "--ignore-not-found",
              "-o",
              "json",
            );
            if (!output.trim()) {
              return false;
            }
            const job = JSON.parse(output);
            if (job.metadata.annotations?.[annotation] !== attempt.nonce) {
              return false;
            }
            assert.equal(job.spec.template.metadata.annotations[annotation], attempt.nonce);
            intent = submitted;
            return job;
          });
          assert.ok(initializer);
          await save("helm-client-stopped.json", JSON.parse(await clientAction("stop")));
          pending = await helmStatus();
          assert.equal(pending.version, baselineRelease.version + 1);
          assert.equal(
            pending.info.status,
            "pending-upgrade",
            "the interruption lost the Helm completion race",
          );
          assert.equal(
            pending.config.installation.upgradeAttemptId,
            initializer.metadata.annotations[annotation],
          );
          await custody.bindPendingRelease(pending.version);
          const initializerUID = initializer.metadata.uid;
          assertInstallationVolume(initializer.spec.template.spec, successorName);
          await retainInstallationSecrets();

          // Kubernetes continues the real initialization while Helm is suspended.
          // A successful Job alone is insufficient: require its owned, successful
          // Pod, then independently check PostgreSQL with the candidate migrator.
          completedPod = await waitFor<Pod>("the interrupted initializer to complete", async () => {
            const job = await get(`job/${release}-initialization`);
            assert.equal(job.metadata.uid, initializerUID, "initializer Job was replaced");
            assert.ok(
              !job.metadata.deletionTimestamp && !job.status?.failed,
              "initializer failed or is deleting",
            );
            const result = JSON.parse(
              await kube(
                "get",
                "pods",
                "-l",
                `batch.kubernetes.io/controller-uid=${job.metadata.uid}`,
                "-o",
                "json",
              ),
            ) as { items: Pod[] };
            assert.ok(result.items.length <= 1, "initializer unexpectedly retried");
            const pod = result.items[0];
            if (
              !job.status?.conditions?.some(
                (condition: { type: string; status: string }) =>
                  condition.type === "Complete" && condition.status === "True",
              ) ||
              !pod ||
              pod.status.phase !== "Succeeded"
            ) {
              return false;
            }
            assert.ok(!pod.metadata.deletionTimestamp);
            assertInstallationVolume(pod.spec, successorName);
            assert.ok(
              pod.metadata.ownerReferences?.some(
                (owner) => owner.controller && owner.uid === job.metadata.uid,
              ),
            );
            assert.equal(
              pod.metadata.annotations?.[annotation],
              job.metadata.annotations[annotation],
            );
            const statuses = [
              ...(pod.status.initContainerStatuses ?? []),
              ...(pod.status.containerStatuses ?? []),
            ];
            assert.deepEqual(
              statuses.map(({ name }) => name).sort(),
              [...(pod.spec.initContainers ?? []), ...pod.spec.containers]
                .map(({ name }) => name)
                .sort(),
            );
            for (const status of statuses) {
              assert.equal(
                status.state?.terminated?.exitCode,
                0,
                "initializer container did not complete successfully",
              );
              await verifyPodImage(candidate, pod, status);
            }
            return pod;
          });
          await save("interrupted-initializer.json", {
            job: await get(`job/${release}-initialization`),
            pod: completedPod,
          });
          assertProtectedEqual(
            await helmStatus(),
            pending,
            "pending Helm state changed during initialization",
          );
        } finally {
          // Always reap this invocation before attempting recovery. If the race or
          // a real hook fails, leave the owned fixture for diagnosis, never replay.
          try {
            if (await readIfPresent(client)) {
              await save("helm-client-terminated.json", JSON.parse(await clientAction("kill")));
            }
          } finally {
            await command;
          }
        }
        const outcome = await command;
        assert.ok(
          outcome instanceof Error && /failed \(137\)/u.test(outcome.message),
          "the interrupted helper must exit with Helm's SIGKILL status",
        );
        await save("helm-client-reaped.json", {
          ...JSON.parse(await clientAction("absent")),
          helperExit: 137,
        });
        await assert.rejects(
          lstat(join(evidence, ".upgrade-lock")),
          { code: "ENOENT" },
          "the exited helper retained its evidence lock",
        );
        assert.ok(completedPod && initializer);
        await assertNoCandidateWriters();
        const committedHistory = await migrationReceipts(originalDatabase);
        assert.ok(
          committedHistory.length > 0,
          "the interrupted initializer left no committed history",
        );
        await checkMigration(
          candidate,
          initializer.spec.template,
          originalDatabase,
          "recovery-history",
        );
        assert.equal(await migrationReceipts(originalDatabase), committedHistory);
        await save("interrupted-migration-history.json", {
          history: committedHistory,
          check: "completed",
        });

        const recoveryArgs = [
          "--evidence-dir",
          evidence,
          "--resume",
          "--recover-helm",
          "--migration-history-checked",
          "--recovery-reviewed",
        ];
        // The interrupted pre-upgrade hook has not retired the old egress grant.
        // Automatic recovery must refuse, rather than leave it outside Helm's inventory.
        assert.deepEqual(await get(`networkpolicy/${retiredPolicyName}`), retiredPolicy);
        const refusalPath = join(directory, "retired-policy-refusal.stderr");
        await writeFile(refusalPath, "", { mode: 0o600, flag: "wx" });
        await assert.rejects(upgrade(recoveryArgs, occEnv, refusalPath), /failed \(1\)/u);
        assert.ok(
          /predecessor-only resource still exists/u.test(await readFile(refusalPath, "utf8")),
          "recovery did not report the retained policy; inspect the private refusal log",
        );
        assertProtectedEqual(await helmStatus(), pending, "pending Helm release changed");
        await assert.rejects(lstat(join(evidence, "helm-recovery")), { code: "ENOENT" });
        assert.deepEqual(await get(`networkpolicy/${retiredPolicyName}`), retiredPolicy);
        // This is explicit fixture-owned reconciliation, not product deletion.
        // Refuse a replacement or intervening edit rather than deleting by name.
        await run(
          "kubectl",
          [
            ...kubeArgs,
            "delete",
            `--raw=/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies/${retiredPolicyName}`,
            "-f",
            "-",
          ],
          {
            input: JSON.stringify({
              apiVersion: "v1",
              kind: "DeleteOptions",
              preconditions: {
                uid: retiredPolicy.metadata.uid,
                resourceVersion: retiredPolicy.metadata.resourceVersion,
              },
            }),
            protectedInput: true,
          },
        );
        await waitFor(
          "the retired proxy policy to disappear",
          async () =>
            !(
              await kube(
                "get",
                `networkpolicy/${retiredPolicyName}`,
                "--ignore-not-found",
                "-o",
                "json",
              )
            ).trim(),
          30_000,
        );
        await save("retired-policy-reconciled.json", {
          uid: retiredPolicy.metadata.uid,
          resourceVersion: retiredPolicy.metadata.resourceVersion,
          removed: true,
        });
        // Removing the policy alone is insufficient: an identical Helm candidate
        // also cannot prune the old named environment entry from the live template.
        const envRefusalPath = join(directory, "retired-env-refusal.stderr");
        await writeFile(envRefusalPath, "", { mode: 0o600, flag: "wx" });
        await assert.rejects(upgrade(recoveryArgs, occEnv, envRefusalPath), /failed \(1\)/u);
        assert.ok(
          /live environment differs/u.test(await readFile(envRefusalPath, "utf8")),
          "recovery did not report the retained environment; inspect the private refusal log",
        );
        assertProtectedEqual(await helmStatus(), pending, "pending Helm release changed");
        await assert.rejects(lstat(join(evidence, "helm-recovery")), { code: "ENOENT" });
        const stoppedAPI = await get("deployment/openclaw-enterprise-api");
        const quiescedAPI = JSON.parse(
          await readFile(join(evidence, "quiescence-api-deployment.json"), "utf8"),
        );
        assert.equal(stoppedAPI.metadata.uid, quiescedAPI.metadata.uid);
        assert.equal(stoppedAPI.spec.replicas, 0);
        const containerIndex = stoppedAPI.spec.template.spec.containers.findIndex(
          (item: { name: string }) => item.name === "api",
        );
        assert.ok(containerIndex >= 0);
        const envIndex = stoppedAPI.spec.template.spec.containers[containerIndex].env.findIndex(
          (item: { name: string }) => item.name === "OCC_CHANNEL_DIRECTORY_PROXY_URL",
        );
        assert.ok(envIndex >= 0);
        const envPointer = `/spec/template/spec/containers/${containerIndex}/env/${envIndex}`;
        await kube(
          "patch",
          "deployment/openclaw-enterprise-api",
          "--type=json",
          "-p",
          JSON.stringify([
            { op: "test", path: "/metadata/uid", value: stoppedAPI.metadata.uid },
            {
              op: "test",
              path: "/metadata/resourceVersion",
              value: stoppedAPI.metadata.resourceVersion,
            },
            { op: "test", path: "/spec/replicas", value: 0 },
            {
              op: "test",
              path: envPointer,
              value: {
                name: "OCC_CHANNEL_DIRECTORY_PROXY_URL",
                value: "http://198.51.100.25:3128",
              },
            },
            { op: "remove", path: envPointer },
          ]),
        );
        await save("retired-env-reconciled.json", {
          uid: stoppedAPI.metadata.uid,
          resourceVersion: stoppedAPI.metadata.resourceVersion,
          removed: true,
        });
        await upgrade(recoveryArgs);
        const recovered = await helmStatus();
        assert.equal(recovered.version, baselineRelease.version + 2);
        assert.equal(recovered.info.status, "deployed");
        assert.equal(recovered.info.description, `Rollback to ${baselineRelease.version + 1}`);
        for (const field of ["manifest", "config", "hooks"]) {
          assertProtectedEqual(
            recovered[field],
            pending[field],
            `recovery changed candidate ${field}`,
          );
        }
        assertProtectedEqual(
          await readFile(join(evidence, "helm-started"), "utf8"),
          intent,
          "recovery rewrote the original submission",
        );
        assert.equal(
          (await get(`job/${release}-initialization`)).metadata.uid,
          initializer.metadata.uid,
          "recovery reran initialization",
        );
        const retainedPod = await get(`pod/${completedPod.metadata.name}`);
        assert.equal(retainedPod.metadata.uid, completedPod.metadata.uid);
        assertProtectedEqual(
          retainedPod.status,
          completedPod.status,
          "recovery changed the completed initializer",
        );
        assert.equal(
          await migrationReceipts(originalDatabase),
          committedHistory,
          "recovery changed the committed migration history",
        );
        await verifyInstallation();
      },
      (details) => record("Forward upgrade API availability observations", details),
    ),
  );
  const candidateInitializerUID = (await get(`job/${release}-initialization`)).metadata.uid;
  const candidateRelease = await helmStatus();
  assert.equal(candidateRelease.info.status, "deployed");
  await custody.bindRelease(candidateRelease.version);
  await retainInstallationSecrets();
  const candidatePods = await controlPlane(candidate, originalDatabase, successorName);
  assert.deepEqual(writerIdentities(candidatePods), writerIdentities(previousPods));
  assert.deepEqual(await readAgent(baseline.id), baseline);
  const accepted = await createAgent("acknowledged-after-upgrade");
  assertReturnedAgents(baseline, accepted, [
    await readAgent(baseline.id),
    await readAgent(accepted.id),
  ]);
  await record("Candidate OCC acknowledged the new Agent", {
    accepted,
    candidatePods,
    helmRevision: candidateRelease.version,
  });

  await phase("Stop both candidate writers", async () => {
    await custody.assertPostgres();
    await custody.assertRelease();
    for (const { component, deploymentUID } of candidatePods) {
      const resource = `deployment/openclaw-enterprise-${component}`;
      const { metadata } = await get(resource);
      assert.ok(
        metadata.uid === deploymentUID && metadata.resourceVersion,
        `candidate ${component} Deployment was replaced`,
      );
      await kube(
        "scale",
        resource,
        "--current-replicas=1",
        "--replicas=0",
        `--resource-version=${metadata.resourceVersion}`,
      );
    }
    await waitFor(
      "candidate writer Pods and database connections to terminate",
      async () => (await pods()).length === 0 && (await candidateConnections()) === "0",
    );
    await assertNoCandidateWriters();
  });
  await phase("Restore the candidate archive and reject the stale archive", async () => {
    const receipts = await migrationReceipts(originalDatabase);
    assert.ok(receipts.length > 0, "no candidate migration receipts");
    await dump(candidateArchive);
    await restore(staleDatabase, staleArchive);
    const stale = await databaseAgents(staleDatabase);
    assert.deepEqual(stale, [agentIdentity(baseline)]);
    assert.throws(
      () => assertReturnedAgents(agentIdentity(baseline), agentIdentity(accepted), stale),
      /missing or changed acknowledged Agent/u,
    );
    await restore(restoredDatabase, candidateArchive);
    assert.equal(await migrationReceipts(restoredDatabase), receipts);
    assertReturnedAgents(
      agentIdentity(baseline),
      agentIdentity(accepted),
      await databaseAgents(restoredDatabase),
    );
  });

  await phase("Check the restored database with the previous controller", () =>
    checkMigration(previous, previousJob, restoredDatabase, "return-compatibility"),
  );

  await phase("Return to the previous Helm revision on the restored database", async () => {
    await localCluster.assertCluster();
    await custody.assertRelease();
    await assertNoCandidateWriters();
    await custody.replaceDatabase(restoredDatabase, directory);
    await custody.assertPostgres();
    await custody.assertRelease();
    await helm("rollback", release, String(baselineRelease.version), "--wait", "--timeout=5m");
    await verifyInstallation();
  });
  const returned = await helmStatus();
  assert.equal(returned.info.status, "deployed");
  await custody.bindRelease(returned.version);
  assert.deepEqual(await claimIdentity(), claims);
  assert.equal((await get(`namespace/${namespace}`)).metadata.uid, namespaceUID);
  assert.equal((await get(`namespace/${tenant}`)).metadata.uid, tenantUID);
  await retainInstallationSecrets();
  assert.equal(
    returned.config.installation.secretName ?? "occ-installation-startup",
    initialStartupSecret.metadata.name,
  );
  // Rollback has no initialization hook: retain the completed candidate Job.
  const retainedInitializer = await get(`job/${release}-initialization`);
  assert.equal(retainedInitializer.metadata.uid, candidateInitializerUID);
  assertInstallationVolume(retainedInitializer.spec.template.spec, successorName);
  await custody.assertPostgres();
  const returnedPods = await controlPlane(
    previous,
    restoredDatabase,
    initialStartupSecret.metadata.name,
  );
  assert.deepEqual(writerIdentities(returnedPods), writerIdentities(previousPods));
  for (const pod of returnedPods) {
    assert.ok(![...previousPods, ...candidatePods].some((earlier) => earlier.uid === pod.uid));
  }
  await phase(
    "Verify authentication and read the acknowledged write through the returned OCC",
    async () => {
      await assertReturnedInstallationAuthentication(externalRequest, installationId);
      // Bind the database readback to both serving controller Pods and check that
      // the retained candidate database has no application connections.
      await waitFor(
        "both returned controller connections on the restored database",
        async () => {
          assertReturnedAgents(baseline, accepted, [
            await readAgent(baseline.id),
            await readAgent(accepted.id),
          ]);
          const active = (
            await sql(
              "postgres",
              `SELECT datname || ':' || host(client_addr)
        FROM pg_stat_activity WHERE usename = 'occ_app'
          AND datname IN ('${originalDatabase}', '${restoredDatabase}')`,
            )
          ).split("\n");
          return returnedDatabaseConnections(
            active,
            returnedPods.map(({ ip }) => ip),
          );
        },
        30_000,
      );
      assertReturnedAgents(
        agentIdentity(baseline),
        agentIdentity(accepted),
        await databaseAgents(originalDatabase),
      );
    },
  );
  await record("Populated controller upgrade and compatible return", {
    installationId,
    namespaceId,
    baseline,
    accepted,
    returnedPods,
    restoredDatabase,
    returnedHelmRevision: returned.version,
    returnedToHelmRevision: baselineRelease.version,
    installationReferences: {
      original: {
        name: initialStartupSecret.metadata.name,
        uid: initialStartupSecret.metadata.uid,
      },
      successor: { name: successorName, uid: successor.metadata.uid },
      retained: true,
    },
  });
}
