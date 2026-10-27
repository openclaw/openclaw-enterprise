import { GATEWAY_NAMESPACE_PROBE, type GatewayPidNamespace } from "../embedded-gateway-owner.ts";

// Docker owns container identity and exit status. A private PID namespace dies
// with its init. Capture the namespace through Engine while that exact init is
// running; neither the Gateway's status endpoint nor its writable state is proof.
type Engine = (
  method: string,
  path: string,
  body: unknown,
  expected: readonly number[],
) => Promise<unknown>;
export type EmbeddedContainerInspect = {
  Id?: string;
  State?: {
    Status?: string;
    Running?: boolean;
    Pid?: number;
    StartedAt?: string;
    FinishedAt?: string;
  };
  HostConfig?: {
    PidMode?: string;
    Privileged?: boolean;
    ReadonlyRootfs?: boolean;
    SecurityOpt?: string[];
    Tmpfs?: Record<string, string>;
    CapDrop?: string[];
    CapAdd?: string[];
  };
  Config?: { User?: string; Env?: readonly string[] };
  Mounts?: { Type?: string; Name?: string; Destination?: string; RW?: boolean }[];
};

export interface ObservedEmbeddedGateway {
  containerId: string;
  startedAt: string;
  volume: string;
  volumeCreatedAt: string;
  mountPath: string;
  namespace: GatewayPidNamespace;
}

const probe = "console.log(JSON.stringify(" + GATEWAY_NAMESPACE_PROBE + "))";
const id = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function stateMount(container: EmbeddedContainerInspect, volume: string) {
  // The state volume must back the lock files and SQLite database.
  // A more specific mount can silently replace either storage location.
  const mounts = container.Mounts ?? [];
  const mount = mounts.find(
    (item) =>
      item.Type === "volume" &&
      item.Name === volume &&
      item.RW === true &&
      item.Destination === "/home/node/.openclaw",
  );
  const paths = [
    ...mounts.filter((item) => item !== mount).map((item) => item.Destination),
    ...Object.keys(container.HostConfig?.Tmpfs ?? {}),
  ];
  const stateDir = "/home/node/.openclaw";
  const trustedRoots = [
    "/app",
    "/usr",
    "/bin",
    "/lib",
    "/lib64",
    "/opt",
    "/proc",
    "/sys",
    "/etc/ld.so.cache",
    "/etc/ld.so.preload",
  ];
  if (
    !mount ||
    paths.some(
      (path) =>
        !path ||
        path === "/" ||
        trustedRoots.some(
          (root) => path === root || path.startsWith(root + "/") || root.startsWith(path + "/"),
        ) ||
        path === stateDir ||
        (path.startsWith(stateDir + "/") && path !== stateDir + "/workspace") ||
        path === "/home",
    )
  ) {
    return;
  }
  return mount.Destination;
}

export async function embeddedGatewayVolumeInstance(engine: Engine, name: string) {
  const volume = (await engine(
    "GET",
    "/volumes/" + encodeURIComponent(name),
    undefined,
    [200],
  )) as { Name?: string; Driver?: string; Scope?: string; Options?: object; CreatedAt?: string };
  return volume.Name === name &&
    volume.Driver === "local" &&
    volume.Scope === "local" &&
    Object.keys(volume.Options ?? {}).length === 0 &&
    Number.isFinite(Date.parse(volume.CreatedAt ?? ""))
    ? volume.CreatedAt
    : undefined;
}

export async function observeEmbeddedGateway(
  engine: Engine,
  container: EmbeddedContainerInspect,
  volume: string,
): Promise<ObservedEmbeddedGateway | undefined> {
  const state = container.State;
  const config = container.HostConfig;
  const mountPath = stateMount(container, volume);
  if (
    !id.test(container.Id ?? "") ||
    !mountPath ||
    state?.Status !== "running" ||
    state.Running !== true ||
    !state.Pid ||
    state.Pid <= 0 ||
    !state.StartedAt ||
    !Number.isFinite(Date.parse(state.StartedAt)) ||
    !config ||
    !["", "private"].includes(config.PidMode ?? "unknown") ||
    config.Privileged !== false ||
    config.ReadonlyRootfs !== true ||
    !config.SecurityOpt?.some((option) =>
      ["no-new-privileges", "no-new-privileges:true", "no-new-privileges=true"].includes(option),
    ) ||
    !config.CapDrop?.includes("ALL") ||
    config.CapAdd?.length ||
    container.Config?.User !== "1000:1000"
  ) {
    return;
  }
  const volumeCreatedAt = await embeddedGatewayVolumeInstance(engine, volume);
  if (!volumeCreatedAt) {
    return;
  }
  const containerId = container.Id!;
  // Different UID, immutable binary, no workload startup files or loader hooks.
  // A model command in the embedded UID cannot impersonate the response on the
  // Engine's private exec stream.
  const created = (await engine(
    "POST",
    "/containers/" + containerId + "/exec",
    {
      Cmd: ["/usr/bin/env", "-i", "/usr/local/bin/node", "-e", probe],
      Env: (container.Config.Env ?? []).map((entry) => entry.split("=", 1)[0] + "="),
      User: "65534:65534",
      WorkingDir: "/",
      AttachStdout: true,
      Tty: true,
    },
    [201],
  )) as { Id?: string };
  if (!id.test(created.Id ?? "")) {
    return;
  }
  const execPath = "/exec/" + created.Id;
  const output = await engine("POST", execPath + "/start", { Detach: false, Tty: true }, [200]);
  const result = (await engine("GET", execPath + "/json", undefined, [200])) as {
    Running?: boolean;
    ExitCode?: number;
    ContainerID?: string;
  };
  if (
    result.Running !== false ||
    result.ExitCode !== 0 ||
    result.ContainerID !== containerId ||
    typeof output !== "string" ||
    output.length > 512
  ) {
    return;
  }
  const namespace = JSON.parse(output) as GatewayPidNamespace;
  if (
    namespace?.platform !== "linux" ||
    !Number.isSafeInteger(namespace.pidNsInitStartTicks) ||
    namespace.pidNsInitStartTicks < 0 ||
    !uuid.test(namespace.identity) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,63}$/.test(namespace.host) ||
    !/^[1-9]\d{0,19}$/.test(namespace.pidNsInode)
  ) {
    return;
  }
  const after = (await engine(
    "GET",
    "/containers/" + containerId + "/json",
    undefined,
    [200],
  )) as EmbeddedContainerInspect;
  if (
    after.Id !== containerId ||
    after.State?.Running !== true ||
    after.State.Pid !== state.Pid ||
    after.State.StartedAt !== state.StartedAt ||
    stateMount(after, volume) !== mountPath
  ) {
    return;
  }
  return { containerId, startedAt: state.StartedAt, volume, volumeCreatedAt, mountPath, namespace };
}

export async function terminatedEmbeddedGateway(
  engine: Engine,
  observation: ObservedEmbeddedGateway,
  stopped: EmbeddedContainerInspect,
  volume: string,
): Promise<GatewayPidNamespace | undefined> {
  const state = stopped.State;
  if (
    observation.containerId !== stopped.Id ||
    observation.volume !== volume ||
    stateMount(stopped, volume) !== observation.mountPath ||
    state?.Status !== "exited" ||
    state.Running !== false ||
    state.Pid !== 0 ||
    state.StartedAt !== observation.startedAt ||
    !(Date.parse(state.FinishedAt ?? "") >= Date.parse(observation.startedAt)) ||
    // Engine exposes CreatedAt to whole seconds. A volume old enough at exit
    // cannot be deleted and recreated afterward with the same timestamp.
    !(Date.parse(state.FinishedAt ?? "") >= Date.parse(observation.volumeCreatedAt) + 1000) ||
    (await embeddedGatewayVolumeInstance(engine, volume)) !== observation.volumeCreatedAt
  ) {
    return;
  }
  return observation.namespace;
}
