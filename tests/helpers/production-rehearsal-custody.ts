import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  protectedInput?: boolean;
  timeout?: number;
  allowFailure?: boolean;
};

export type FixtureRun = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<string>;

const activeCommands = new Set<(signal: NodeJS.Signals) => void>();
let interruptionTimer: ReturnType<typeof setTimeout> | undefined;

function signalActiveCommands(signal: NodeJS.Signals) {
  for (const command of activeCommands) {
    command(signal);
  }
}

function terminateActiveCommands() {
  signalActiveCommands("SIGKILL");
}

const interruptHandlers = {
  SIGINT: () => interruptCommands("SIGINT"),
  SIGTERM: () => interruptCommands("SIGTERM"),
};

function removeCommandHandlers() {
  process.off("SIGINT", interruptHandlers.SIGINT);
  process.off("SIGTERM", interruptHandlers.SIGTERM);
  process.off("exit", terminateActiveCommands);
}

function interruptCommands(signal: "SIGINT" | "SIGTERM") {
  signalActiveCommands(signal);
  if (interruptionTimer) {
    return;
  }
  const defaultDisposition = process.listenerCount(signal) === 1;
  interruptionTimer = setTimeout(() => {
    terminateActiveCommands();
    interruptionTimer = undefined;
    if (defaultDisposition) {
      // Restore the signal's normal exit status after all concurrent commands
      // have been stopped. Existing runner handlers own their usual disposition.
      removeCommandHandlers();
      process.kill(process.pid, signal);
    } else if (activeCommands.size === 0) {
      removeCommandHandlers();
    }
  }, 1_000);
}

function ownCommand(signal: (signal: NodeJS.Signals) => void) {
  if (activeCommands.size === 0 && !interruptionTimer) {
    process.on("SIGINT", interruptHandlers.SIGINT);
    process.on("SIGTERM", interruptHandlers.SIGTERM);
    // A runner's existing signal handler can exit before the grace period ends.
    process.on("exit", terminateActiveCommands);
  }
  activeCommands.add(signal);
  return (terminated = false) => {
    if (interruptionTimer && !terminated) {
      return;
    }
    activeCommands.delete(signal);
    if (activeCommands.size === 0 && !interruptionTimer) {
      removeCommandHandlers();
    }
  };
}

export function runFixtureCommand(
  command: string,
  args: string[],
  {
    cwd,
    input,
    env,
    timeout = 120_000,
    allowFailure = false,
    protectedInput = false,
  }: CommandOptions = {},
  redact = String,
  bounded = false,
): Promise<string> {
  assert.ok(!protectedInput || !allowFailure);
  if (interruptionTimer) {
    return Promise.reject(new Error("cannot start a fixture command during interruption"));
  }
  return new Promise((resolve, reject) => {
    const childEnv = env ? { ...process.env, ...env } : undefined;
    if (childEnv) {
      for (const [name, value] of Object.entries(childEnv)) {
        if (value === undefined) {
          delete childEnv[name];
        }
      }
    }
    const processGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
      detached: processGroup,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = false;
    let interruptionKilled = false;
    let closed = false;
    let killed = false;
    let cleanupFailed = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = () =>
      new Error(
        cleanupFailed
          ? `${command} could not terminate a timed-out fixture operation`
          : `${command} timed out${protectedInput ? " during a protected fixture operation" : ""}`,
      );
    const signal = (name: NodeJS.Signals) => {
      try {
        if (processGroup && child.pid) {
          process.kill(-child.pid, name);
        } else {
          child.kill(name);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          cleanupFailed = true;
        }
      }
    };
    const interruptedError = () =>
      new Error(
        cleanupFailed
          ? `${command} could not terminate an interrupted fixture operation`
          : `${command} interrupted${protectedInput ? " during a protected fixture operation" : ""}`,
      );
    const releaseCommand = ownCommand((name) => {
      interrupted = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      interruptionKilled ||= name === "SIGKILL";
      signal(name);
      if (interruptionKilled && closed) {
        if (!cleanupFailed) {
          releaseCommand(true);
        }
        reject(interruptedError());
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      signal("SIGTERM");
      // A shell can exit before its subprocesses. Always finish terminating the
      // owned process group before allowing the rehearsal to continue.
      cleanupTimer = setTimeout(() => {
        killed = true;
        signal("SIGKILL");
        if (closed) {
          releaseCommand();
          reject(timeoutError());
          return;
        }
        cleanupTimer = setTimeout(() => {
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          releaseCommand();
          reject(timeoutError());
        }, 1_000);
      }, 1_000);
    }, timeout);
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      if (!protectedInput) {
        stderr += data;
      }
    });
    child.on("error", (error) => {
      if (timedOut) {
        return;
      }
      clearTimeout(timer);
      releaseCommand();
      reject(
        protectedInput ? new Error(`${command} could not start a protected operation`) : error,
      );
    });
    child.on("close", (code) => {
      closed = true;
      clearTimeout(timer);
      if (interrupted) {
        if (interruptionKilled) {
          if (!cleanupFailed) {
            releaseCommand(true);
          }
          reject(interruptedError());
        }
        return;
      }
      if (timedOut) {
        if (killed) {
          clearTimeout(cleanupTimer);
          releaseCommand();
          reject(timeoutError());
        }
        return;
      }
      releaseCommand();
      if (code === 0 || (allowFailure && code === 1)) {
        resolve(stdout);
      } else {
        const output = protectedInput
          ? " during a protected fixture operation"
          : redact(`: ${stderr}\n${stdout}`);
        reject(new Error(`${command} failed (${code})${bounded ? output.slice(-4000) : output}`));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

type FixtureObject = {
  kind: string;
  metadata: { name: string; namespace?: string; labels?: Record<string, string> };
};

export function writeFixtureObject(
  run: FixtureRun,
  kubeArgs: string[],
  verb: "apply" | "create" | "replace",
  object: FixtureObject,
  output?: string,
) {
  return run("kubectl", [...kubeArgs, verb, "-f", "-", ...(output ? ["-o", output] : [])], {
    input: JSON.stringify(object),
    protectedInput: object.kind === "Secret",
  });
}

export function protectedJSON<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("invalid protected fixture response");
  }
}

const dockerSocket = "/var/run/docker.sock";

export function localRehearsalEnvironment(env: NodeJS.ProcessEnv) {
  const overrides: NodeJS.ProcessEnv = {
    DOCKER_HOST: `unix://${dockerSocket}`,
    DOCKER_CONTEXT: undefined,
    DOCKER_API_VERSION: undefined,
    DOCKER_TLS_VERIFY: undefined,
    DOCKER_CERT_PATH: undefined,
    KUBECONFIG: undefined,
    KUBECTL_KUBERC: "false",
    HELM_DRIVER: "secret",
  };
  for (const name of Object.keys(env)) {
    if (/^(?:https?_proxy|all_proxy|no_proxy|helm_kube.*)$/iu.test(name)) {
      overrides[name] = undefined;
    }
  }
  return overrides;
}

type K3dServer = {
  id: string;
  pid: number;
  running: boolean;
  app: string;
  cluster: string;
  role: string;
  loadBalancer: string;
  ports: { HostIp: string; HostPort: string }[] | null;
};

const serverFields = {
  id: ".Id",
  pid: ".State.Pid",
  running: ".State.Running",
  app: '(index .Config.Labels "app")',
  cluster: '(index .Config.Labels "k3d.cluster")',
  role: '(index .Config.Labels "k3d.role")',
  loadBalancer: '(index .Config.Labels "k3d.server.loadbalancer")',
  ports: '(index .NetworkSettings.Ports "6443/tcp")',
};
const serverFormat = `{${Object.entries(serverFields)
  .map(([key, field]) => `"${key}":{{json ${field}}}`)
  .join(",")}}`;

// Check the kernel peer before trusting Docker metadata. With socket activation,
// systemd can have opened the socket for dockerd. The server's cgroup must also
// exist in this host's PID namespace and contain its full Docker container ID.
const verifyDockerPeer = `
import os, socket, stat, struct, sys
path = sys.argv[1]
info = os.stat(path)
if info.st_uid != 0 or not stat.S_ISSOCK(info.st_mode):
    sys.exit("require the native root-owned Docker socket")
with socket.socket(socket.AF_UNIX) as client:
    client.settimeout(5)
    client.connect(path)
    pid, uid, _ = struct.unpack("3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
with open(f"/proc/{pid}/comm", encoding="ascii") as command:
    name = command.read().strip()
if uid != 0 or not (name == "dockerd" or (pid == 1 and name == "systemd")):
    sys.exit("the Docker socket peer is not the local daemon")
`;

const uidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const uidOutput = "jsonpath={.metadata.uid}";
const versionedUIDOutput = "jsonpath={.metadata.uid}{' '}{.metadata.resourceVersion}";
const protectedInput = { protectedInput: true } as const;
const containerIDPattern = /^[a-f0-9]{64}$/u;

type Kubeconfig = {
  contexts?: { name: string; context: { cluster: string; user: string } }[];
  clusters?: { name: string; cluster: Record<string, unknown> }[];
  users?: { name: string; user: Record<string, unknown> }[];
};

function assertDirectK3dConfig(config: Kubeconfig, context: string, endpoint: string) {
  const selected = config.contexts?.[0];
  const cluster = config.clusters?.[0];
  const user = config.users?.[0];
  assert.ok(
    config.contexts?.length === 1 &&
      selected?.name === context &&
      config.clusters?.length === 1 &&
      selected.context.cluster === cluster?.name &&
      config.users?.length === 1 &&
      selected.context.user === user?.name,
    "k3d must provide exactly one dedicated kubeconfig context",
  );
  const connection = cluster.cluster;
  assert.ok(
    connection.server === endpoint &&
      typeof connection["certificate-authority-data"] === "string" &&
      connection["certificate-authority-data"].length > 0 &&
      Object.keys(connection).every((key) =>
        ["server", "certificate-authority-data"].includes(key),
      ),
    "k3d must use the direct Docker API port with its embedded CA and no proxy",
  );
  assert.ok(
    ["client-certificate-data", "client-key-data"].every(
      (key) => typeof user.user[key] === "string" && user.user[key].length > 0,
    ) && Object.keys(user.user).length === 2,
    "k3d must use only its embedded client certificate and key",
  );
}

export async function bindLocalRehearsalCluster(
  run: FixtureRun,
  cluster: string,
  kubeconfigPath: string,
) {
  assert.match(
    cluster,
    /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u,
    "select a dedicated k3d cluster name",
  );
  const kubernetesContext = `k3d-${cluster}`;
  const node = `${kubernetesContext}-server-0`;
  const kubeArgs = ["--kubeconfig", kubeconfigPath, "--context", kubernetesContext];
  const dockerHost = `--host=unix://${dockerSocket}`;
  const docker = (...args: string[]) => run("docker", [dockerHost, ...args]);
  const kubectl = (...args: string[]) =>
    run("kubectl", [...kubeArgs, "--request-timeout=15s", ...args]);
  const inspectServer = async () => {
    await run("python3", ["-c", verifyDockerPeer, dockerSocket], { timeout: 10_000 });
    const server = JSON.parse(
      await docker("container", "inspect", "--format", serverFormat, node),
    ) as K3dServer;
    assert.ok(
      server.running &&
        server.app === "k3d" &&
        server.cluster === cluster &&
        server.role === "server" &&
        server.loadBalancer === "" &&
        containerIDPattern.test(server.id) &&
        Number.isSafeInteger(server.pid) &&
        server.pid > 1,
      "the selected cluster requires a running local k3d server created with --no-lb",
    );
    const binding = server.ports?.[0];
    assert.ok(
      server.ports?.length === 1 &&
        binding?.HostIp === "127.0.0.1" &&
        /^[0-9]{1,5}$/u.test(binding.HostPort) &&
        Number(binding.HostPort) > 0 &&
        Number(binding.HostPort) <= 65535,
      "k3d must publish its server API directly on one IPv4 loopback port",
    );
    const cgroup = await run("cat", [`/proc/${server.pid}/cgroup`]);
    assert.ok(
      cgroup
        .split(/[\n/:]/u)
        .some((part) => [server.id, `docker-${server.id}.scope`].includes(part)),
      "the k3d server container is not in the local Docker host cgroup",
    );
    return { id: server.id, endpoint: `https://127.0.0.1:${binding.HostPort}` };
  };
  const server = await inspectServer();
  const getClusterUID = ["get", "namespace", "kube-system", "-o", uidOutput];
  const internalUID = async () =>
    (
      await docker(
        "exec",
        server.id,
        "k3s",
        "kubectl",
        "--kubeconfig=/output/kubeconfig.yaml",
        "--server=https://127.0.0.1:6443",
        "--request-timeout=15s",
        ...getClusterUID,
      )
    ).trim();
  const externalUID = async () => (await kubectl(...getClusterUID)).trim();
  const kubeconfig = await run("k3d", ["kubeconfig", "get", cluster], {
    protectedInput: true,
    timeout: 30_000,
  });
  await writeFile(kubeconfigPath, kubeconfig, { flag: "wx", mode: 0o600 });
  const config = protectedJSON<Kubeconfig>(
    await run("kubectl", [...kubeArgs, "config", "view", "--raw", "-o", "json"], {
      protectedInput: true,
      timeout: 15_000,
    }),
  );
  assertDirectK3dConfig(config, kubernetesContext, server.endpoint);
  const clusterUID = await internalUID();
  assert.ok(
    uidPattern.test(clusterUID) && (await externalUID()) === clusterUID,
    "the Docker k3d server and the published Kubernetes API have different cluster identities",
  );
  const nodes = JSON.parse(await kubectl("get", "nodes", "-o", "json")) as {
    items: { metadata: { name: string; uid: string } }[];
  };
  const nodeUID = nodes.items[0]?.metadata.uid;
  assert.ok(
    nodes.items.length === 1 &&
      nodes.items[0]?.metadata.name === node &&
      uidPattern.test(nodeUID ?? ""),
    "the rehearsal requires the selected k3d server as its only Kubernetes Node",
  );

  return {
    selection: { kubeconfigPath, kubernetesContext },
    node,
    nodeUID,
    async assertCluster() {
      assert.deepEqual(await inspectServer(), server, "the local k3d server was replaced");
      assert.ok(
        (await internalUID()) === clusterUID && (await externalUID()) === clusterUID,
        "the selected Kubernetes cluster was replaced",
      );
    },
    async runningConfigDigest(containerID: string, podUID: string) {
      const id = /^containerd:\/\/([a-f0-9]{64})$/u.exec(containerID)?.[1];
      assert.ok(id, "expected an exact containerd container ID from the scheduled Pod");
      // CRI can report an index as the repository reference. The container's
      // image ID identifies the config it actually started with.
      // Kubelet sends the image service's config ID in the container create
      // request. Older CRI versions expose it there, not in status.imageId.
      const fields =
        '{{.status.id}}{{" "}}{{index .status.labels "io.kubernetes.pod.uid"}}{{" "}}{{if .status.imageId}}{{.status.imageId}}{{else}}{{.info.config.image.image}}{{end}}';
      const output = await run(
        "docker",
        [
          dockerHost,
          "exec",
          server.id,
          "k3s",
          "crictl",
          "inspect",
          "--output=go-template",
          "--template",
          fields,
          id,
        ],
        { protectedInput: true, timeout: 15_000 },
      );
      const [actualID, actualPodUID, digest] = output.trim().split(/ +/u);
      assert.ok(
        actualID === id && actualPodUID === podUID,
        "the runtime did not inspect the scheduled Pod's container",
      );
      return digest;
    },
  };
}

export type LocalRehearsalCluster = Awaited<ReturnType<typeof bindLocalRehearsalCluster>>;

const databaseUsers = {
  "application-url": "occ_app",
  "migration-url": "occ_migrator",
};
type DatabaseKey = keyof typeof databaseUsers;
type DatabaseSecret = FixtureObject & {
  metadata: { uid: string; resourceVersion: string; managedFields?: unknown };
  data: Record<DatabaseKey, string>;
};
const databaseKeys = Object.keys(databaseUsers) as DatabaseKey[];

function fixtureDatabaseURL(value: string, namespace: string, database: string, key: DatabaseKey) {
  let url: URL;
  try {
    url = new URL(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    throw new Error("invalid fixture database connection target");
  }
  assert.ok(
    url.protocol === "postgresql:" &&
      url.hostname === `postgres.${namespace}.svc.cluster.local` &&
      url.port === "5432" &&
      url.pathname === `/${database}` &&
      url.username === databaseUsers[key] &&
      url.password &&
      !url.search &&
      !url.hash,
    "database Secret must target the owned PostgreSQL Service and expected database",
  );
  return url;
}

type Metadata = { uid: string; deletionTimestamp?: string };
type PostgresPod = {
  metadata: Metadata;
  spec: {
    volumes: { name: string; persistentVolumeClaim?: { claimName: string } }[];
    nodeName: string;
  };
  status: { podIP: string; phase: string };
};
type PostgresClaim = {
  metadata: Metadata;
  spec: { volumeName?: string };
  status: { phase: string };
};
type PostgresService = {
  metadata: Metadata;
  spec: {
    type: string;
    selector: Record<string, string>;
    ports: { port: number; targetPort: number }[];
  };
};
type PostgresObject = FixtureObject & {
  spec: {
    containers?: { name: string; env: object[] }[];
    selector?: Record<string, string>;
  };
};
type EndpointSlices = {
  items: {
    metadata: { ownerReferences?: { kind: string; uid: string }[] };
    endpoints: { conditions?: { ready?: boolean }; addresses: string[]; targetRef?: Metadata }[];
  }[];
};

type WaitFor = <T>(
  description: string,
  check: () => Promise<T | false>,
  timeout?: number,
) => Promise<T>;

export function createRehearsalCustody({
  run,
  kubeArgs,
  namespace,
  release,
  suffix,
  cluster,
  waitFor,
}: {
  run: FixtureRun;
  kubeArgs: string[];
  namespace: string;
  release: string;
  suffix: string;
  cluster: Pick<LocalRehearsalCluster, "node" | "assertCluster">;
  waitFor: WaitFor;
}) {
  const owned = new Map<string, string | null>();
  let tenant: string | undefined;
  const helmUIDs = new Map<number, string>();
  let database = "openclaw_enterprise";
  let databaseVersion: string | undefined;
  const requestArgs = [...kubeArgs, "--request-timeout=30s"];
  const kube = (args: string[], options?: CommandOptions) =>
    run("kubectl", [...requestArgs, ...args], options);
  const inNamespace = (args: string[], options?: CommandOptions) =>
    kube(["-n", namespace, ...args], options);
  const acknowledged = (resource: string) => {
    const uid = owned.get(resource);
    assert.ok(uid, `no acknowledged creation of ${resource}`);
    return uid;
  };
  const assertNamespace = async (name: string) => {
    const resource = `namespace/${name}`;
    const uid = acknowledged(resource);
    const actual = (
      await kube(["get", resource, "-o", "jsonpath={.metadata.uid}{' '}{.status.phase}"])
    ).trim();
    assert.equal(
      actual,
      `${uid} Active`,
      `rehearsal namespace ${name} was replaced or is terminating`,
    );
  };
  const assertNamespaces = async () => {
    await assertNamespace(namespace);
    if (tenant) {
      await assertNamespace(tenant);
    }
  };
  const create = async (object: FixtureObject) => {
    const { kind, metadata } = object;
    assert.equal(metadata.labels?.["oce-test"], suffix, "fixture creation needs this run's label");
    const resource = `${kind.toLowerCase()}/${metadata.name}`;
    if (kind === "Namespace") {
      assert.equal(metadata.name, namespace);
      await cluster.assertCluster();
    } else {
      assert.ok(metadata.namespace === namespace || (tenant && metadata.namespace === tenant));
      await assertNamespaces();
    }
    const key = metadata.namespace === tenant && tenant ? `${tenant}/${resource}` : resource;
    assert.ok(!owned.has(key), `refusing to replay creation of ${key}`);
    owned.set(key, null);
    if (kind === "Pod" && metadata.name === "postgres") {
      const postgres = (object as PostgresObject).spec.containers?.find(
        ({ name }) => name === "postgres",
      );
      assert.ok(postgres);
      postgres.env.push({
        name: "OCE_TEST_POD_UID",
        valueFrom: { fieldRef: { fieldPath: "metadata.uid" } },
      });
    }
    if (kind === "Service" && metadata.name === "postgres") {
      (object as PostgresObject).spec.selector = { app: "postgres", "oce-test": suffix };
    }
    const databaseSecret = key === "secret/occ-database";
    const output = await writeFixtureObject(
      run,
      requestArgs,
      "create",
      object,
      databaseSecret ? versionedUIDOutput : uidOutput,
    );
    const [uid, version] = output.trim().split(/ +/u);
    assert.ok(
      uid && uidPattern.test(uid) && (!databaseSecret || version),
      `no valid create receipt for ${key}`,
    );
    if (databaseSecret) {
      databaseVersion = version;
    }
    owned.set(key, uid);
    return uid;
  };

  const readDatabaseSecret = async () => {
    const uid = acknowledged("secret/occ-database");
    const secret = protectedJSON<DatabaseSecret>(
      await inNamespace(["get", "secret/occ-database", "-o", "json"], protectedInput),
    );
    assert.ok(
      secret.metadata?.uid === uid &&
        databaseVersion &&
        secret.metadata.resourceVersion === databaseVersion,
      "the acknowledged fixture database Secret was replaced or modified",
    );
    for (const key of databaseKeys) {
      fixtureDatabaseURL(secret.data?.[key], namespace, database, key);
    }
    return secret;
  };
  const assertPostgres = async (waitForEndpoint = false) => {
    await assertNamespaces();
    const get = async <T>(resource: string): Promise<T> =>
      JSON.parse(await inNamespace(["get", resource, "-o", "json"])) as T;
    const [pod, claim, service, secret] = await Promise.all([
      get<PostgresPod>("pod/postgres"),
      get<PostgresClaim>("pvc/postgres-data"),
      get<PostgresService>("service/postgres"),
      readDatabaseSecret(),
    ]);
    for (const [resource, object] of [
      ["pod/postgres", pod],
      ["persistentvolumeclaim/postgres-data", claim],
      ["service/postgres", service],
    ] as const) {
      assert.ok(
        object.metadata.uid === acknowledged(resource) && !object.metadata.deletionTimestamp,
        `fixture ${resource} was replaced or is terminating`,
      );
    }
    assert.ok(
      claim.spec.volumeName &&
        claim.status.phase === "Bound" &&
        pod.spec.nodeName === cluster.node &&
        pod.status.phase === "Running" &&
        pod.status.podIP &&
        pod.spec.volumes.some(
          ({ name, persistentVolumeClaim }) =>
            name === "data" && persistentVolumeClaim?.claimName === "postgres-data",
        ),
      "PostgreSQL must be running on the owned server with the bound fixture claim",
    );
    assert.deepEqual(service.spec.selector, { app: "postgres", "oce-test": suffix });
    assert.ok(
      service.spec.type === "ClusterIP" &&
        service.spec.ports.length === 1 &&
        service.spec.ports[0]?.port === 5432 &&
        service.spec.ports[0].targetPort === 5432,
      "the owned PostgreSQL Service must publish the fixture's PostgreSQL port",
    );
    const endpoint = async () => {
      const { items } = JSON.parse(
        await inNamespace([
          "get",
          "endpointslices",
          "-l",
          "kubernetes.io/service-name=postgres",
          "-o",
          "json",
        ]),
      ) as EndpointSlices;
      const [slice] = items;
      if (!slice) {
        return false;
      }
      assert.ok(
        items.length === 1 &&
          slice.metadata.ownerReferences?.some(
            ({ kind, uid }) => kind === "Service" && uid === service.metadata.uid,
          ),
        "PostgreSQL endpoint must belong to the acknowledged fixture Service",
      );
      const [target] = slice.endpoints;
      if (!target) {
        return false;
      }
      assert.ok(
        slice.endpoints.length === 1 &&
          target.targetRef?.uid === pod.metadata.uid &&
          target.addresses.length === 1 &&
          target.addresses[0] === pod.status.podIP,
        "PostgreSQL Service endpoint does not select the acknowledged fixture Pod",
      );
      return target.conditions?.ready === true;
    };
    if (waitForEndpoint) {
      await waitFor("owned PostgreSQL Service endpoint", endpoint, 30_000);
    } else {
      assert.ok(await endpoint(), "the owned PostgreSQL Service endpoint is not ready");
    }
    return {
      identity: {
        podUID: pod.metadata.uid,
        pvcUID: claim.metadata.uid,
        serviceUID: service.metadata.uid,
        secretUID: secret.metadata.uid,
      },
      secret,
    };
  };
  const currentReleaseUID = async (version: number) => {
    await assertNamespaces();
    const namesAndUIDs =
      'jsonpath={range .items[*]}{.metadata.name}{" "}{.metadata.uid}{" "}{.metadata.labels.status}{"\\n"}{end}';
    const output = await inNamespace(
      ["get", "secrets", "-l", `owner=helm,name=${release}`, "-o", namesAndUIDs],
      protectedInput,
    );
    const lines = output.trim().split("\n");
    const history = new Map(
      lines.map((line) => {
        const [name, uid, status] = line.trim().split(/ +/u);
        return [name, { uid, status }] as const;
      }),
    );
    assert.ok(
      lines.length === version && history.size === version,
      "the acknowledged Helm release history was replaced",
    );
    for (let index = 1; index <= version; index++) {
      const entry = history.get(`sh.helm.release.v1.${release}.v${index}`);
      const expected = helmUIDs.get(index);
      assert.ok(
        entry?.uid &&
          uidPattern.test(entry.uid) &&
          (!expected || entry.uid === expected) &&
          entry.status === (index === version ? "deployed" : "superseded"),
        "the acknowledged Helm release revision was replaced or is not settled",
      );
    }
    const uid = history.get(`sh.helm.release.v1.${release}.v${version}`)?.uid;
    assert.ok(uid);
    return uid;
  };
  return {
    create,
    metadata: (name: string, labels: Record<string, string> = {}) => ({
      name,
      namespace,
      labels: { ...labels, "oce-test": suffix },
    }),
    async postgres(command: string, ...args: string[]) {
      const {
        identity: { podUID },
      } = await assertPostgres();
      // exec is addressed by Pod name. Check the Downward API UID in the
      // selected container before it can invoke any database command.
      const guard =
        'test "${OCE_TEST_POD_UID:-}" = "$1" || exit 42; shift; umask 077; export PGPASSWORD="$POSTGRES_PASSWORD"; exec "$@"';
      return inNamespace(
        [
          "exec",
          "pod/postgres",
          "-c",
          "postgres",
          "--",
          "sh",
          "-ec",
          guard,
          "postgres-fixture",
          podUID,
          command,
          "--host=127.0.0.1",
          "--username=postgres",
          ...args,
        ],
        protectedInput,
      );
    },
    async assertPostgres(waitForEndpoint = false) {
      return (await assertPostgres(waitForEndpoint)).identity;
    },
    async assertRelease() {
      assert.ok(helmUIDs.size, "no acknowledged Helm release revision");
      await currentReleaseUID(helmUIDs.size);
    },
    assertUID(resource: string, uid: string) {
      assert.equal(uid, acknowledged(resource), `fixture ${resource} was replaced`);
    },
    async annotateInstallation(installationId: string) {
      await assertNamespaces();
      const resource = "secret/occ-installation-startup";
      const output = await inNamespace(["get", resource, "-o", versionedUIDOutput], protectedInput);
      const [uid, version] = output.trim().split(/ +/u);
      assert.ok(
        uid === acknowledged(resource) && version,
        "the installation startup Secret was replaced",
      );
      await inNamespace(
        [
          "annotate",
          resource,
          `openclaw.dev/installation-id=${installationId}`,
          `--resource-version=${version}`,
        ],
        protectedInput,
      );
    },
    namespaceUID: (name: string) => acknowledged(`namespace/${name}`),
    async bindTenant(name: string, uid: string) {
      assert.ok(
        !tenant &&
          uidPattern.test(uid) &&
          /^[a-z0-9][a-z0-9-]{0,62}$/u.test(name) &&
          name !== namespace,
      );
      // OCC allocated the Namespace ID and reports its backing namespace.
      tenant = name;
      owned.set(`namespace/${name}`, uid);
      await assertNamespace(name);
    },
    async bindRelease(version: number) {
      assert.equal(version, helmUIDs.size + 1, "unexpected Helm release revision");
      helmUIDs.set(version, await currentReleaseUID(version));
    },
    async restoredMigrationURL(restored: string) {
      const { secret } = await assertPostgres();
      const key = "migration-url";
      const url = fixtureDatabaseURL(secret.data[key], namespace, database, key);
      url.pathname = `/${restored}`;
      return Buffer.from(url.toString()).toString("base64");
    },
    async replaceDatabase(restored: string, directory: string) {
      const { secret } = await assertPostgres();
      delete secret.metadata.managedFields;
      await writeFile(
        join(directory, "candidate-database-secret.json"),
        JSON.stringify(secret) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      for (const key of databaseKeys) {
        const url = fixtureDatabaseURL(secret.data[key], namespace, database, key);
        url.pathname = `/${restored}`;
        secret.data[key] = Buffer.from(url.toString()).toString("base64");
      }
      const output = await writeFixtureObject(
        run,
        requestArgs,
        "replace",
        secret,
        versionedUIDOutput,
      );
      const [uid, version] = output.trim().split(/ +/u);
      assert.ok(
        uid === acknowledged("secret/occ-database") && version && version !== databaseVersion,
        "no acknowledged replacement of the fixture database Secret",
      );
      database = restored;
      databaseVersion = version;
    },
    async teardown(uninstall: () => Promise<string>) {
      await cluster.assertCluster();
      await assertPostgres();
      assert.ok(helmUIDs.size, "no acknowledged Helm release revision");
      await currentReleaseUID(helmUIDs.size);
      await uninstall();
      await cluster.assertCluster();
      for (const name of [tenant, namespace]) {
        assert.ok(name, "no acknowledged tenant namespace");
        await assertNamespace(name);
        const resource = `namespace/${name}`;
        await kube(["delete", `--raw=/api/v1/namespaces/${name}`, "-f", "-"], {
          input: JSON.stringify({
            apiVersion: "v1",
            kind: "DeleteOptions",
            preconditions: { uid: acknowledged(resource) },
          }),
        });
        await waitFor(
          `deletion of owned namespace ${name}`,
          async () => {
            const uid = (
              await kube(["get", resource, "--ignore-not-found", "-o", uidOutput])
            ).trim();
            assert.ok(
              !uid || uid === acknowledged(resource),
              `namespace ${name} was replaced during cleanup`,
            );
            return !uid;
          },
          90_000,
        );
      }
    },
  };
}

export type RehearsalCustody = ReturnType<typeof createRehearsalCustody>;
