import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, posix, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertInsideDirectory } from "./assert-inside-directory.ts";
import { privateOwned } from "./private-owned-path.mjs";
import {
  assertReviewedCodexVersion,
  codexBwrapSourceProvenance,
  deriveCodexBwrapProfile,
  sha256Hex,
  stableJson,
} from "./codex-seccomp-profile.ts";

// Load before any preparation effects; the complete script travels through kubectl exec.
const sandboxProbeScript = await readFile(
  new URL("./codex-sandbox-probe.sh", import.meta.url),
  "utf8",
);

const defaultProfileName = "openclaw/codex-bwrap.json";
const kubeletSeccompRoot = "/var/lib/kubelet/seccomp";
const codexProbeTimeoutMs = 180_000;
const kubectlRequestTimeout = "75s";

type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  code?: number;
  signal?: NodeJS.Signals | null;
  killed?: boolean;
  timedOut?: boolean;
};

type CommandError = Error & {
  stdout?: string;
  stderr?: string;
  exitCode?: number | string | null | undefined;
  code?: number | string | null | undefined;
  signal?: NodeJS.Signals | null | undefined;
  killed?: boolean | undefined;
  timedOut?: boolean | undefined;
  codexSandboxProbe?: SandboxProbe | null;
};

type ExecFile = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<CommandResult>;

type ClusterSelection = { kubeconfig: string; context: string };
type OwnedK3dCluster = ClusterSelection & {
  name: string;
  directory: string;
  kubectl?: string;
};

type PreparationOptions = {
  cluster?: OwnedK3dCluster;
  image?: string;
  profileName?: string;
  timeoutMs?: number;
  execFile?: ExecFile;
  kubectl?: string;
  docker?: string;
  codexVersion?: string;
  commandTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

type DevelopmentPreparationOptions = {
  directory: string;
  image: string;
  execFile: ExecFile;
  timeoutMs: number;
};

type ProbeOptions = {
  execFile: ExecFile;
  kubectl: string;
  docker: string;
  timeoutMs: number;
  commandTimeoutMs: number;
  directory: string;
  codexVersion: string;
  allowRuntimeDefault?: boolean;
  reportRuntimeDefaultReadinessFailure?: boolean;
};

type ProfileMode = "RuntimeDefault" | "Localhost";
type SeccompProfile = ReturnType<typeof deriveCodexBwrapProfile>;
type PreparedNode = {
  nodeName: string;
  architectures: string[];
  runtimeDefaultSha256: string;
  profileSha256: string;
  profilePath: string;
  addedRules: number;
};

type SandboxProbe = { stage: string; exit: number; entered: boolean };
type ProfileObservation = {
  profileVerification: "not-checked" | "passed" | "failed";
  effectiveProfileSha256: string | null;
};

type ProbePodInput = {
  name: string;
  namespace: string;
  nodeName: string;
  image: string;
  localhostProfile?: string;
};

type PodSecurity = {
  runAsNonRoot?: boolean;
  runAsUser?: number;
  runAsGroup?: number;
  allowPrivilegeEscalation?: boolean;
  readOnlyRootFilesystem?: boolean;
  capabilities?: { drop?: string[]; add?: string[] };
};

type ObservedPod = {
  metadata?: { name?: string; uid?: string };
  spec?: {
    nodeName?: string;
    securityContext?: PodSecurity;
    containers?: { name: string; securityContext?: PodSecurity }[];
  };
  status?: {
    containerStatuses?: {
      name: string;
      containerID?: string;
      imageID?: string;
      ready?: boolean;
      state?: { waiting?: { reason?: string; message?: string } };
    }[];
  };
};

type ObservedNodeList = { items?: { metadata?: { name?: string } }[] };
type ObservedNode = {
  status?: {
    nodeInfo?: {
      architecture?: string;
      kernelVersion?: string;
      osImage?: string;
      containerRuntimeVersion?: string;
    };
  };
};

type RuntimeSpec = { linux?: { seccomp?: SeccompProfile } };
type CriInspectInfo = { runtimeSpec?: RuntimeSpec | string };
type CriInspect = { info?: CriInspectInfo; status?: { info?: CriInspectInfo } };

type DevelopmentState = {
  version?: number;
  computeDriver?: string;
  deploymentMode?: string;
  composeProject?: string;
  sandboxDriver?: string;
  cluster?: string;
  containerEngine?: string;
  dockerHost?: string;
  repository: string;
};

function randomSuffix(bytes = 6) {
  return randomUUID()
    .replaceAll("-", "")
    .slice(0, bytes * 2);
}

function slug(value: string) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function assertImmutableImageReference(
  image: string | undefined,
  name = "Codex runtime image",
): asserts image is string {
  assert.match(
    image ?? "",
    /^\S+@sha256:[a-f0-9]{64}$/i,
    `${name} must be an immutable image@sha256 reference.`,
  );
}

function assertLocalhostProfileName(profileName: string) {
  assert.equal(typeof profileName, "string", "Codex seccomp profile name must be a string.");
  assert.ok(profileName.length > 0, "Codex seccomp profile name must be non-empty.");
  assert.equal(
    posix.isAbsolute(profileName),
    false,
    "Codex seccomp profile name must be relative.",
  );
  assert.equal(
    profileName.split("/").some((part) => part === "" || part === "." || part === ".."),
    false,
    "Codex seccomp profile name must not traverse directories.",
  );
  assert.equal(
    profileName.includes("\\"),
    false,
    "Codex seccomp profile name must use POSIX path separators.",
  );
  assert.equal(
    profileName.toLowerCase().includes("unconfined"),
    false,
    "Codex seccomp profile name must not select unconfined mode.",
  );
}

function requireExecFile(execFile: ExecFile | undefined) {
  if (typeof execFile !== "function") {
    throw new Error("Codex seccomp preparation requires execFile.");
  }
  return execFile;
}

function assertSelectedK3dCluster(cluster: OwnedK3dCluster | undefined) {
  assert.ok(cluster?.name, "A run-owned k3d cluster is required.");
  assert.ok(cluster?.directory, "The k3d cluster resource must expose its owned directory.");
  assert.ok(cluster?.kubeconfig, "The k3d cluster resource must expose a kubeconfig path.");
  assert.ok(cluster?.context, "The k3d cluster resource must expose a context.");
  assert.match(
    cluster.name,
    /^openclaw-k8s-[a-z0-9-]+$/,
    "Codex seccomp requires a run-owned openclaw-k8s k3d cluster.",
  );
  if (!isAbsolute(cluster.directory)) {
    throw new Error("cluster.directory must be absolute.");
  }
  if (!isAbsolute(cluster.kubeconfig)) {
    throw new Error("cluster.kubeconfig must be absolute.");
  }
  const directory = resolve(cluster.directory);
  if (!basename(directory).startsWith(`${cluster.name}-`)) {
    throw new Error("cluster.directory must be owned by the selected k3d cluster.");
  }
  const kubeconfig = resolve(cluster.kubeconfig);
  assertInsideDirectory(directory, kubeconfig, "cluster.kubeconfig");
  if (kubeconfig !== join(directory, "kubeconfig")) {
    throw new Error("cluster.kubeconfig must be the selected cluster directory kubeconfig.");
  }
  if (cluster.context !== `k3d-${cluster.name}`) {
    throw new Error("cluster.context must select the owned k3d context.");
  }
  return { ...cluster, directory, kubeconfig };
}

function kubectlArgs(selection: ClusterSelection, args: string[]) {
  return [
    "--kubeconfig",
    selection.kubeconfig,
    "--context",
    selection.context,
    "--request-timeout",
    kubectlRequestTimeout,
    ...args,
  ];
}

async function kubectl(selection: ClusterSelection, args: string[], options: ProbeOptions) {
  const result = await options.execFile(options.kubectl, kubectlArgs(selection, args), {
    timeoutMs: options.commandTimeoutMs,
  });
  return result.stdout;
}

async function kubectlJson<T>(selection: ClusterSelection, args: string[], options: ProbeOptions) {
  return JSON.parse(await kubectl(selection, [...args, "-o", "json"], options)) as T;
}

async function applyManifest(
  selection: ClusterSelection,
  manifest: ReturnType<typeof restrictedProbePod>,
  options: ProbeOptions,
) {
  const manifestPath = join(options.directory, `${manifest.metadata.name}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  await options.execFile(options.kubectl, kubectlArgs(selection, ["apply", "-f", manifestPath]), {
    timeoutMs: options.commandTimeoutMs,
  });
}

async function waitFor<T>(
  description: string,
  operation: () => Promise<T | false | undefined>,
  timeoutMs = codexProbeTimeoutMs,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined && value !== false) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(
    `Timed out waiting for ${description}.${lastError instanceof Error ? ` Last error: ${lastError.message}` : ""}`,
  );
}

function restrictedProbePod({ name, namespace, nodeName, image, localhostProfile }: ProbePodInput) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace,
      labels: { "openclaw.dev/ci-seccomp-probe": "true" },
    },
    spec: {
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: "Never",
      // The probe's Node process runs as PID 1 and ignores SIGTERM. Without a
      // short grace period, the cleanup's Namespace deletion waits 30 seconds.
      terminationGracePeriodSeconds: 1,
      nodeName,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: "probe",
          image,
          imagePullPolicy: "Never",
          command: ["node", "-e", "setInterval(()=>{},1000)"],
          env: [{ name: "CODEX_HOME", value: "/home/node/.codex" }],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ["ALL"] },
            ...(localhostProfile === undefined
              ? {}
              : { seccompProfile: { type: "Localhost", localhostProfile } }),
          },
          volumeMounts: [
            { name: "tmp", mountPath: "/tmp" },
            { name: "work", mountPath: "/workspace" },
            { name: "home", mountPath: "/home/node" },
          ],
        },
      ],
      volumes: [
        { name: "tmp", emptyDir: {} },
        { name: "work", emptyDir: {} },
        { name: "home", emptyDir: {} },
      ],
    },
  };
}

function extractContainerId(pod: ObservedPod, containerName = "probe") {
  const status = pod.status?.containerStatuses?.find((entry) => entry.name === containerName);
  const id = status?.containerID?.replace(/^[^:]+:\/\//, "");
  assert.ok(id, `Pod ${pod.metadata?.name} did not expose a ${containerName} container ID.`);
  return id;
}

function extractRuntimeSpec(criInspect: CriInspect) {
  const runtimeSpec = criInspect.info?.runtimeSpec ?? criInspect.status?.info?.runtimeSpec;
  if (typeof runtimeSpec === "string") {
    return JSON.parse(runtimeSpec) as RuntimeSpec;
  }
  return runtimeSpec;
}

function receiveSandboxProbe(result: Pick<CommandError, "stdout" | "stderr">, nonce: string) {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (
    typeof stdout !== "string" ||
    typeof stderr !== "string" ||
    Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 4096
  ) {
    return null;
  }
  const prefix = "OCE_SANDBOX_PROBE_V1:";
  // Partial, duplicate and foreign invocation markers cannot qualify a failure.
  const lines = stderr.split("\n").filter((line) => line.includes(prefix));
  const entered = lines.length === 3;
  if (lines.length !== 2 && !entered) {
    return null;
  }
  if (lines[0] !== `${prefix}${nonce}:START`) {
    return null;
  }
  if (entered && lines[1] !== `${prefix}${nonce}:ENTERED`) {
    return null;
  }
  const terminal = lines
    .at(-1)
    ?.match(
      /^OCE_SANDBOX_PROBE_V1:([a-f0-9]{32}):END:(VERSION|PREPARE|SANDBOX|ASSERTIONS|CLEANUP|DONE):(0|[1-9][0-9]{0,2})$/,
    );
  if (
    !terminal ||
    terminal[1] !== nonce ||
    Number(terminal[3]) > 255 ||
    !stderr.endsWith("\n") ||
    stdout.includes(prefix)
  ) {
    return null;
  }
  const stage = terminal[2];
  const exit = Number(terminal[3]);
  if (
    stage === undefined ||
    (stage === "DONE") !== (exit === 0) ||
    (entered && ["VERSION", "PREPARE"].includes(stage)) ||
    (!entered && ["ASSERTIONS", "CLEANUP", "DONE"].includes(stage))
  ) {
    return null;
  }
  return { stage, exit, entered };
}

async function inspectContainerSeccompProfile(
  nodeName: string,
  containerId: string,
  options: ProbeOptions,
) {
  const result = await options.execFile(
    options.docker,
    ["exec", nodeName, "crictl", "inspect", containerId],
    { timeoutMs: options.commandTimeoutMs },
  );
  let runtimeSpec: RuntimeSpec | undefined;
  try {
    runtimeSpec = extractRuntimeSpec(JSON.parse(result.stdout) as CriInspect);
  } catch {
    throw new Error("CRI inspect returned an invalid runtime specification.");
  }
  assert.ok(runtimeSpec?.linux?.seccomp, "CRI inspect did not expose runtimeSpec.linux.seccomp.");
  return runtimeSpec.linux.seccomp;
}

function failedSandboxProbe(error: CommandError, nonce: string) {
  const status = error.exitCode ?? error.code;
  const definite =
    typeof status === "number" &&
    Number.isInteger(status) &&
    status > 0 &&
    status <= 255 &&
    error.signal === null &&
    error.timedOut === false &&
    (error.killed === undefined || error.killed === false) &&
    (error.exitCode === undefined || error.code === undefined || error.exitCode === error.code);
  const probe = definite ? receiveSandboxProbe(error, nonce) : null;
  return probe?.exit === status ? probe : null;
}

// execFile fulfills only after a zero exit; reject any contradictory explicit status.
function successfulCommandResult(result: CommandResult) {
  return (
    (result.exitCode === undefined || result.exitCode === 0) &&
    (result.code === undefined || result.code === 0) &&
    (result.signal === undefined || result.signal === null) &&
    (result.killed === undefined || result.killed === false) &&
    (result.timedOut === undefined || result.timedOut === false)
  );
}

async function execCodexSandboxProbe(
  selection: ClusterSelection,
  namespace: string,
  podName: string,
  options: ProbeOptions,
) {
  const nonce = randomUUID().replaceAll("-", "");
  let result: CommandResult;
  try {
    result = await options.execFile(
      options.kubectl,
      kubectlArgs(selection, [
        "exec",
        podName,
        "--namespace",
        namespace,
        "--",
        "sh",
        "-c",
        sandboxProbeScript,
        "codex-sandbox-probe",
        options.codexVersion,
        nonce,
      ]),
      { timeoutMs: options.commandTimeoutMs },
    );
  } catch (error) {
    if (error instanceof Error) {
      const failure: CommandError = error;
      failure.codexSandboxProbe = failedSandboxProbe(failure, nonce);
    }
    throw error;
  }
  const receipt = successfulCommandResult(result) ? receiveSandboxProbe(result, nonce) : null;
  assert.ok(
    receipt?.stage === "DONE" && receipt.exit === 0 && receipt.entered,
    "Codex sandbox probe did not return complete invocation-bound success evidence.",
  );
}

function safeProbeField(value: unknown, pattern: RegExp) {
  return typeof value === "string" && value.length <= 253 && value.match(pattern)?.[0] === value
    ? value
    : null;
}

function probeImageDigest(value: unknown) {
  return typeof value === "string"
    ? (value.match(/(?:^|@|:\/\/)(sha256:[a-f0-9]{64})$/i)?.[1] ?? null)
    : null;
}

function safeProbeSecurity(pod: ObservedPod) {
  const podSecurity = pod.spec?.securityContext;
  const container = pod.spec?.containers?.find((entry) => entry.name === "probe")?.securityContext;
  const bool = (value: unknown) => (typeof value === "boolean" ? value : null);
  const id = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    runAsNonRoot: bool(container?.runAsNonRoot ?? podSecurity?.runAsNonRoot),
    runAsUser: id(container?.runAsUser ?? podSecurity?.runAsUser),
    runAsGroup: id(container?.runAsGroup ?? podSecurity?.runAsGroup),
    allowPrivilegeEscalation: bool(container?.allowPrivilegeEscalation),
    readOnlyRootFilesystem: bool(container?.readOnlyRootFilesystem),
    dropAllCapabilities: Array.isArray(container?.capabilities?.drop)
      ? container.capabilities.drop.includes("ALL") && !container.capabilities.add?.length
      : null,
  };
}

async function withProbeFailureReport<T>(
  pod: ObservedPod,
  mode: ProfileMode,
  image: string,
  options: ProbeOptions,
  operation: (observation: ProfileObservation) => Promise<T>,
) {
  const startedAt = new Date().toISOString();
  const profile: ProfileObservation = {
    profileVerification: "not-checked",
    effectiveProfileSha256: null,
  };
  try {
    return await operation(profile);
  } catch (error) {
    try {
      const status = pod.status?.containerStatuses?.find((entry) => entry.name === "probe");
      const failure: CommandError | undefined = error instanceof Error ? error : undefined;
      const codexProbe = failure?.codexSandboxProbe;
      const probe =
        codexProbe &&
        ["VERSION", "PREPARE", "SANDBOX", "ASSERTIONS", "CLEANUP"].includes(codexProbe.stage) &&
        Number.isInteger(codexProbe.exit) &&
        codexProbe.exit >= 1 &&
        codexProbe.exit <= 255 &&
        typeof codexProbe.entered === "boolean"
          ? { stage: codexProbe.stage, exit: codexProbe.exit, entered: codexProbe.entered }
          : null;
      const report = {
        mode,
        podUid: safeProbeField(pod.metadata?.uid, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i),
        containerId: safeProbeField(
          typeof status?.containerID === "string"
            ? status.containerID.replace(/^[^:]+:\/\//, "")
            : null,
          /^[a-f0-9]{64}$/i,
        ),
        node: safeProbeField(pod.spec?.nodeName, /^[a-z0-9][a-z0-9.-]*$/),
        runtimeImageDigest: probeImageDigest(image),
        observedImageDigest: probeImageDigest(status?.imageID),
        ...profile,
        expectedCodexVersion: options.codexVersion,
        verifiedCodexVersion:
          probe !== null && probe.stage !== "VERSION" ? options.codexVersion : null,
        security: safeProbeSecurity(pod),
        probe,
        startedAt,
        finishedAt: new Date().toISOString(),
        guide: "docs/guides/deploy/codex-sandbox.md#identify-the-restriction",
      };
      // Emit while the probe's resources still exist; leave teardown and the
      // original failure authoritative even when diagnostic output is unavailable.
      process.stderr.write(`OCE_CODEX_SECCOMP_PROBE_FAILURE ${JSON.stringify(report)}\n`);
    } catch {
      // Diagnostic collection is best effort.
    }
    throw error;
  }
}

function isRuntimeDefaultSandboxDenial(error: CommandError) {
  const probe = error.codexSandboxProbe;
  if (
    error.timedOut === true ||
    error.killed === true ||
    error.signal ||
    probe?.stage !== "SANDBOX" ||
    probe.exit !== 1 ||
    probe.entered
  ) {
    return false;
  }
  const diagnostic = [error.stderr, error.stdout].filter(Boolean).join("\n");
  return (
    !/codex version mismatch/i.test(diagnostic) &&
    /bwrap|bubblewrap|clone|namespace|operation not permitted|permission denied|seccomp|unshare/i.test(
      diagnostic,
    )
  );
}

async function verifyRuntimeDefaultDeniesCodexSandbox(
  selection: ClusterSelection,
  namespace: string,
  podName: string,
  options: ProbeOptions,
) {
  try {
    await execCodexSandboxProbe(selection, namespace, podName, options);
  } catch (error) {
    if (!(error instanceof Error) || !isRuntimeDefaultSandboxDenial(error)) {
      throw error;
    }
    return false;
  }
  return true;
}

async function listOwnedK3dNodes(
  selection: ClusterSelection,
  cluster: OwnedK3dCluster,
  options: ProbeOptions,
) {
  const nodes = await kubectlJson<ObservedNodeList>(selection, ["get", "nodes"], options);
  const names =
    nodes.items
      ?.map((node) => node.metadata?.name)
      .filter((name): name is string => Boolean(name)) ?? [];
  assert.ok(names.length > 0, "The selected k3d cluster must expose at least one node.");
  for (const name of names) {
    assert.ok(
      name.startsWith(`k3d-${cluster.name}-`),
      `Refusing to install seccomp profile on node outside the owned k3d cluster: ${name}`,
    );
  }
  return names;
}

async function waitForPodReady(
  selection: ClusterSelection,
  namespace: string,
  name: string,
  options: ProbeOptions,
  observe?: (pod: ObservedPod) => void,
) {
  return waitFor(
    `Pod ${namespace}/${name} to become ready`,
    async () => {
      const pod = await kubectlJson<ObservedPod>(
        selection,
        ["get", "pod", name, "--namespace", namespace],
        options,
      );
      observe?.(pod);
      if (
        pod.status?.containerStatuses?.some(
          (status) => status.name === "probe" && status.ready === true,
        )
      ) {
        return pod;
      }
      return false;
    },
    options.timeoutMs,
  );
}

async function waitForMissingProfileFailure(
  selection: ClusterSelection,
  namespace: string,
  name: string,
  missingProfile: string,
  options: ProbeOptions,
) {
  const profilePath = posix.join(kubeletSeccompRoot, missingProfile);
  // containerd's WithProfile read error, optionally wrapped by CreateContainer.
  // Match the complete diagnostic: mentioning seccomp or another profile is not proof.
  const missingMessage = `cannot load seccomp profile ${JSON.stringify(profilePath)}: open ${profilePath}: no such file or directory`;
  const pod = await waitFor(
    `Pod ${namespace}/${name} to fail closed on a missing localhost seccomp profile`,
    async () => {
      const pod = await kubectlJson<ObservedPod>(
        selection,
        ["get", "pod", name, "--namespace", namespace],
        options,
      );
      const status = pod.status?.containerStatuses?.find((entry) => entry.name === "probe");
      if (status?.containerID) {
        // End polling before rejecting: waitFor retries thrown read failures.
        return pod;
      }
      const waiting = status?.state?.waiting;
      if (
        waiting?.reason === "CreateContainerError" &&
        (waiting.message === missingMessage ||
          waiting.message === `failed to create containerd container: ${missingMessage}`)
      ) {
        return pod;
      }
      return false;
    },
    options.timeoutMs,
  );
  const status = pod.status?.containerStatuses?.find((entry) => entry.name === "probe");
  if (status?.containerID) {
    throw new Error("Missing localhost seccomp profile unexpectedly started a container.");
  }
  return pod;
}

function runtimeDefaultProfileForNode(
  selection: ClusterSelection,
  namespace: string,
  nodeName: string,
  image: string,
  options: ProbeOptions & { allowRuntimeDefault?: false },
): Promise<SeccompProfile>;
function runtimeDefaultProfileForNode(
  selection: ClusterSelection,
  namespace: string,
  nodeName: string,
  image: string,
  options: ProbeOptions,
): Promise<SeccompProfile | null>;
async function runtimeDefaultProfileForNode(
  selection: ClusterSelection,
  namespace: string,
  nodeName: string,
  image: string,
  options: ProbeOptions,
) {
  const podName = `runtime-default-${slug(nodeName).slice(0, 40)}-${randomSuffix(3)}`;
  await applyManifest(
    selection,
    restrictedProbePod({ name: podName, namespace, nodeName, image }),
    options,
  );
  let pod: ObservedPod;
  const observation: { pod?: ObservedPod } = {};
  try {
    pod = await waitForPodReady(selection, namespace, podName, options, (observed) => {
      observation.pod = observed;
    });
  } catch (error) {
    if (options.reportRuntimeDefaultReadinessFailure) {
      try {
        const statuses = observation.pod?.status?.containerStatuses;
        const waitingReason = Array.isArray(statuses)
          ? statuses.find((status) => status?.name === "probe")?.state?.waiting?.reason
          : null;
        const reason = [
          "ErrImageNeverPull",
          "ErrImagePull",
          "ImagePullBackOff",
          "CreateContainerConfigError",
          "CreateContainerError",
          "ContainerCreating",
        ].includes(waitingReason ?? "")
          ? waitingReason
          : null;
        // A stream write can emit EPIPE after this catch, interrupting cleanup.
        writeSync(
          2,
          `OCE_CODEX_SECCOMP_READINESS_FAILURE ${JSON.stringify({
            operation: "runtime-default-pod-readiness",
            reason,
          })}\n`,
        );
      } catch {
        // Diagnostic failure must not replace the original readiness error.
      }
    }
    throw error;
  }
  return withProbeFailureReport(pod, "RuntimeDefault", image, options, async () => {
    if (await verifyRuntimeDefaultDeniesCodexSandbox(selection, namespace, podName, options)) {
      if (options.allowRuntimeDefault) {
        return null;
      }
      throw new Error("RuntimeDefault unexpectedly allowed the Codex sandbox probe.");
    }
    return inspectContainerSeccompProfile(nodeName, extractContainerId(pod), options);
  });
}

async function installProfileOnNode(
  nodeName: string,
  profileName: string,
  profile: SeccompProfile,
  directory: string,
  options: ProbeOptions,
) {
  const profileData = stableJson(profile);
  const expectedSha256 = sha256Hex(profileData);
  const source = join(directory, `${basename(profileName)}-${nodeName}-${expectedSha256}.json`);
  const destination = posix.join(kubeletSeccompRoot, profileName);
  await writeFile(source, profileData, { mode: 0o600 });
  await chmod(source, 0o600);
  await options.execFile(
    options.docker,
    ["exec", nodeName, "mkdir", "-p", posix.dirname(destination)],
    {
      timeoutMs: options.commandTimeoutMs,
    },
  );
  await options.execFile(options.docker, ["cp", source, `${nodeName}:${destination}`], {
    timeoutMs: options.commandTimeoutMs,
  });
  await options.execFile(options.docker, ["exec", nodeName, "chmod", "0644", destination], {
    timeoutMs: options.commandTimeoutMs,
  });
  const verified = await options.execFile(
    options.docker,
    ["exec", nodeName, "sha256sum", destination],
    { timeoutMs: options.commandTimeoutMs },
  );
  assert.ok(
    verified.stdout.trim().startsWith(expectedSha256),
    `Installed seccomp profile hash mismatch on ${nodeName}.`,
  );
  return {
    path: destination,
    sha256: expectedSha256,
    bytes: Buffer.byteLength(profileData),
    profileData,
  };
}

async function writeDockerSeccompProfile(
  directory: string,
  codexVersion: string,
  installation: Awaited<ReturnType<typeof installProfileOnNode>>,
) {
  const dockerDirectory = join(directory, "docker-seccomp");
  await mkdir(dockerDirectory, { recursive: true, mode: 0o700 });
  await chmod(dockerDirectory, 0o700);
  const profilePath = join(dockerDirectory, `codex-${codexVersion}-${installation.sha256}.json`);
  await writeFile(profilePath, installation.profileData, { mode: 0o600, flag: "wx" });
  await chmod(profilePath, 0o600);
  return profilePath;
}

async function verifyInstalledProfile(
  selection: ClusterSelection,
  namespace: string,
  nodeName: string,
  image: string,
  profileName: string,
  profile: SeccompProfile,
  options: ProbeOptions,
) {
  const podName = `codex-seccomp-${slug(nodeName).slice(0, 42)}-${randomSuffix(3)}`;
  await applyManifest(
    selection,
    restrictedProbePod({
      name: podName,
      namespace,
      nodeName,
      image,
      localhostProfile: profileName,
    }),
    options,
  );
  const pod = await waitForPodReady(selection, namespace, podName, options);
  await withProbeFailureReport(pod, "Localhost", image, options, async (observation) => {
    const effective = await inspectContainerSeccompProfile(
      nodeName,
      extractContainerId(pod),
      options,
    );
    observation.effectiveProfileSha256 = sha256Hex(stableJson(effective));
    const matches = isDeepStrictEqual(effective, profile);
    observation.profileVerification = matches ? "passed" : "failed";
    assert.ok(
      matches,
      `Effective seccomp profile on ${nodeName} must equal the installed profile.`,
    );
    await execCodexSandboxProbe(selection, namespace, podName, options);
  });
}

async function verifyMissingProfileFailsClosed(
  selection: ClusterSelection,
  namespace: string,
  nodeName: string,
  image: string,
  profileName: string,
  options: ProbeOptions,
) {
  const podName = `missing-seccomp-${slug(nodeName).slice(0, 38)}-${randomSuffix(3)}`;
  const missingProfile = posix.join(
    posix.dirname(profileName),
    `missing-${randomSuffix(4)}-${basename(profileName)}`,
  );
  await applyManifest(
    selection,
    restrictedProbePod({
      name: podName,
      namespace,
      nodeName,
      image,
      localhostProfile: missingProfile,
    }),
    options,
  );
  await waitForMissingProfileFailure(selection, namespace, podName, missingProfile, options);
}

async function withProbeCleanup<T>(
  selection: ClusterSelection,
  namespace: string,
  directory: string,
  options: ProbeOptions,
  isCreated: () => boolean,
  wait: boolean,
  label: string,
  operation: () => Promise<T>,
) {
  let outcome: { result: T } | { error: unknown };
  try {
    outcome = { result: await operation() };
  } catch (error) {
    outcome = { error };
  }
  const cleanupErrors: unknown[] = [];
  if (isCreated()) {
    try {
      await kubectl(
        selection,
        ["delete", "namespace", namespace, "--ignore-not-found=true", `--wait=${wait}`],
        options,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    const cleanupMessage = cleanupErrors
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join("; ");
    const cleanupError = new AggregateError(cleanupErrors, `${label}: ${cleanupMessage}`);
    if ("error" in outcome && outcome.error instanceof Error) {
      Object.assign(outcome.error, { cleanupError });
      outcome.error.message = `${outcome.error.message}; cleanup also failed: ${cleanupMessage}`;
    } else if ("result" in outcome) {
      throw cleanupError;
    }
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.result;
}

async function prepareCodexSeccompProfile({
  cluster,
  image,
  profileName = defaultProfileName,
  timeoutMs = codexProbeTimeoutMs,
  execFile,
  kubectl: kubectlBin,
  docker,
  codexVersion = "0.164.0",
  commandTimeoutMs = timeoutMs + 15_000,
  env = process.env,
}: PreparationOptions = {}) {
  const selectedCluster = assertSelectedK3dCluster(cluster);
  const exec = requireExecFile(execFile);
  assertImmutableImageReference(image);
  assertLocalhostProfileName(profileName);
  assertReviewedCodexVersion(codexVersion);
  const selection = { kubeconfig: selectedCluster.kubeconfig, context: selectedCluster.context };
  const namespace = `openclaw-ci-seccomp-${randomSuffix(4)}`;
  const directory = await mkdtemp(join(selectedCluster.directory, "codex-seccomp-"));
  await chmod(directory, 0o700);
  const options = {
    execFile: exec,
    kubectl: kubectlBin ?? selectedCluster.kubectl ?? env.OCC_KUBECTL_BIN ?? "kubectl",
    docker: docker ?? env.OCC_DOCKER_BIN ?? "docker",
    timeoutMs,
    commandTimeoutMs,
    directory,
    codexVersion,
  };
  const nodes: PreparedNode[] = [];
  let dockerProfilePath: string | undefined;
  let dockerProfileSha256: string | undefined;
  let namespaceCreated = false;
  return withProbeCleanup(
    selection,
    namespace,
    directory,
    options,
    () => namespaceCreated,
    false,
    "Codex seccomp cleanup failed",
    async () => {
      await kubectl(selection, ["create", "namespace", namespace], options);
      namespaceCreated = true;
      for (const nodeName of await listOwnedK3dNodes(selection, selectedCluster, options)) {
        const baseline = await runtimeDefaultProfileForNode(
          selection,
          namespace,
          nodeName,
          image,
          options,
        );
        const profile = deriveCodexBwrapProfile(baseline, { codexVersion });
        const installation = await installProfileOnNode(
          nodeName,
          profileName,
          profile,
          directory,
          options,
        );
        if (dockerProfileSha256 === undefined) {
          dockerProfileSha256 = installation.sha256;
          dockerProfilePath = await writeDockerSeccompProfile(
            selectedCluster.directory,
            codexVersion,
            installation,
          );
        } else if (dockerProfileSha256 !== installation.sha256) {
          throw new Error("Codex seccomp profile differs across selected k3d nodes.");
        }
        await verifyInstalledProfile(
          selection,
          namespace,
          nodeName,
          image,
          profileName,
          profile,
          options,
        );
        nodes.push({
          nodeName,
          architectures: profile.architectures,
          runtimeDefaultSha256: sha256Hex(stableJson(baseline)),
          profileSha256: installation.sha256,
          profilePath: installation.path,
          addedRules: profile.syscalls.length - baseline.syscalls.length,
        });
      }
      const firstNode = nodes[0];
      assert.ok(firstNode, "Codex seccomp profile preparation must cover at least one node.");
      await verifyMissingProfileFailsClosed(
        selection,
        namespace,
        firstNode.nodeName,
        image,
        profileName,
        options,
      );
      return {
        profileName,
        dockerProfilePath,
        profileSha256: dockerProfileSha256,
        env: { OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE: profileName },
        nodes,
        sourceProvenance: codexBwrapSourceProvenance,
        proofLimits: [
          "Generated from each selected node's effective RuntimeDefault OCI profile.",
          "Architecture proof is limited to the selected cluster nodes.",
          "CI installs the localhost profile only into run-owned k3d nodes.",
        ],
      };
    },
  );
}

// Development and CI have different ownership records; neither may bypass the other's checks.
async function selectedDevelopmentCluster(directory: string) {
  if (!isAbsolute(directory) || (await realpath(directory)) !== directory) {
    throw new Error("Development state directory must be an absolute canonical path.");
  }
  await privateOwned(directory, true);
  for (const name of [".openclaw-development", "state.json", "kubeconfig"]) {
    await privateOwned(join(directory, name));
  }
  if (
    (await readFile(join(directory, ".openclaw-development"), "utf8")) !==
    "openclaw-enterprise-development-v3\n"
  ) {
    throw new Error("The selected directory is not owned by the development launcher.");
  }
  const state = JSON.parse(
    await readFile(join(directory, "state.json"), "utf8"),
  ) as DevelopmentState;
  if (
    state.version !== 3 ||
    state.computeDriver !== "kubernetes" ||
    (state.deploymentMode !== "k3d" &&
      !(
        state.deploymentMode === undefined &&
        /^[a-z0-9][a-z0-9_-]*$/.test(state.composeProject ?? "")
      )) ||
    state.sandboxDriver !== "none" ||
    !state.cluster ||
    !/^occ-dev-[a-z0-9][a-z0-9-]*$/.test(state.cluster) ||
    state.cluster.length > 63 ||
    (state.containerEngine !== "docker" && state.containerEngine !== "podman") ||
    !state.dockerHost?.startsWith("unix:///") ||
    state.dockerHost !== process.env.DOCKER_HOST ||
    (await realpath(state.repository)) !== (await realpath(process.cwd()))
  ) {
    throw new Error("Invalid or mismatched Kubernetes development ownership state.");
  }
  try {
    await lstat(join(directory, "installation.yaml"));
    throw new Error("Codex profile preparation must precede Installation creation.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  return {
    name: state.cluster,
    directory,
    kubeconfig: join(directory, "kubeconfig"),
    context: `k3d-${state.cluster}`,
    engine: state.containerEngine,
  };
}

// Names the localhost profile installed for the dedicated Codex sandbox. The
// lifecycle in internal/occdev/openshell_k3d.go parses this name, so the format
// is a contract between the two; it matches the shape rather than repeating the
// reviewed version, which this module owns.
function developmentCodexProfileName(profile: SeccompProfile, codexVersion: string) {
  assertReviewedCodexVersion(codexVersion);
  const name = `openclaw/codex-${codexVersion}-${sha256Hex(stableJson(profile))}.json`;
  assertLocalhostProfileName(name);
  return name;
}

async function installDevelopmentProfile(
  nodeName: string,
  profileName: string,
  profile: SeccompProfile,
  directory: string,
  options: ProbeOptions,
) {
  const profileData = stableJson(profile);
  const digest = sha256Hex(profileData);
  const source = join(directory, `profile-${randomSuffix()}.json`);
  const destination = posix.join(kubeletSeccompRoot, profileName);
  const targetDirectory = posix.dirname(destination);
  const temporary = `${destination}.${randomSuffix()}.tmp`;
  await writeFile(source, profileData, { mode: 0o600, flag: "wx" });
  let temporaryClaimed = false;
  try {
    // Never replace an existing file at a content-addressed path.
    await options.execFile(options.docker, ["exec", nodeName, "mkdir", "-p", targetDirectory], {
      timeoutMs: options.commandTimeoutMs,
    });
    await options.execFile(
      options.docker,
      [
        "exec",
        nodeName,
        "sh",
        "-c",
        'test ! -L "$1" && test ! -e "$2" && test ! -L "$2"',
        "sh",
        targetDirectory,
        temporary,
      ],
      { timeoutMs: options.commandTimeoutMs },
    );
    temporaryClaimed = true;
    await options.execFile(options.docker, ["cp", source, `${nodeName}:${temporary}`], {
      timeoutMs: options.commandTimeoutMs,
    });
    await options.execFile(options.docker, ["exec", nodeName, "chown", "0:0", temporary], {
      timeoutMs: options.commandTimeoutMs,
    });
    await options.execFile(options.docker, ["exec", nodeName, "chmod", "0644", temporary], {
      timeoutMs: options.commandTimeoutMs,
    });
    await options.execFile(options.docker, ["exec", nodeName, "ln", temporary, destination], {
      timeoutMs: options.commandTimeoutMs,
    });
    const verified = await options.execFile(
      options.docker,
      ["exec", nodeName, "sha256sum", destination],
      { timeoutMs: options.commandTimeoutMs },
    );
    if (verified.stdout.trim().split(/\s+/)[0] !== digest) {
      throw new Error("Installed development Codex profile hash mismatch.");
    }
    const ownership = await options.execFile(
      options.docker,
      ["exec", nodeName, "stat", "-c", "%u:%g %a", destination],
      { timeoutMs: options.commandTimeoutMs },
    );
    if (ownership.stdout.trim() !== "0:0 644") {
      throw new Error("Installed development Codex profile has unexpected ownership or mode.");
    }
  } finally {
    if (temporaryClaimed) {
      await options.execFile(options.docker, ["exec", nodeName, "rm", "-f", temporary], {
        timeoutMs: options.commandTimeoutMs,
      });
    }
  }
}

async function prepareDevelopmentCodexSeccompProfile({
  directory,
  image,
  execFile,
  timeoutMs,
}: DevelopmentPreparationOptions) {
  const cluster = await selectedDevelopmentCluster(directory);
  assertImmutableImageReference(image);
  const execute = requireExecFile(execFile);
  const codexVersion = "0.164.0";
  assertReviewedCodexVersion(codexVersion);
  const selection = { kubeconfig: cluster.kubeconfig, context: cluster.context };
  const namespace = `openclaw-dev-seccomp-${randomSuffix(4)}`;
  const temporaryDirectory = await mkdtemp(join(cluster.directory, "codex-seccomp-"));
  await chmod(temporaryDirectory, 0o700);
  const options = {
    execFile: execute,
    kubectl: "kubectl",
    docker: cluster.engine,
    timeoutMs,
    commandTimeoutMs: timeoutMs + 15_000,
    directory: temporaryDirectory,
    codexVersion,
    allowRuntimeDefault: true,
    reportRuntimeDefaultReadinessFailure: true,
  };
  let namespaceCreated = false;
  return withProbeCleanup(
    selection,
    namespace,
    temporaryDirectory,
    options,
    () => namespaceCreated,
    true,
    "Development Codex probe cleanup failed",
    async () => {
      const nodes = await listOwnedK3dNodes(selection, cluster, options);
      if (nodes.length !== 1 || nodes[0] !== `k3d-${cluster.name}-server-0`) {
        throw new Error("Development Codex profile requires the owned single-node k3d cluster.");
      }
      await kubectl(selection, ["create", "namespace", namespace], options);
      namespaceCreated = true;
      const baseline = await runtimeDefaultProfileForNode(
        selection,
        namespace,
        nodes[0],
        image,
        options,
      );
      if (baseline === null) {
        return { mode: "RuntimeDefault", profileName: "" } as const;
      }
      const profile = deriveCodexBwrapProfile(baseline, { codexVersion });
      const digest = sha256Hex(stableJson(profile));
      const profileName = developmentCodexProfileName(profile, codexVersion);

      await installDevelopmentProfile(nodes[0], profileName, profile, temporaryDirectory, options);
      await verifyInstalledProfile(
        selection,
        namespace,
        nodes[0],
        image,
        profileName,
        profile,
        options,
      );
      await verifyMissingProfileFailsClosed(
        selection,
        namespace,
        nodes[0],
        image,
        profileName,
        options,
      );
      const node = await kubectlJson<ObservedNode>(selection, ["get", "node", nodes[0]], options);
      const nodeInfo = node.status?.nodeInfo;
      for (const name of [
        "architecture",
        "kernelVersion",
        "osImage",
        "containerRuntimeVersion",
      ] as const) {
        if (typeof nodeInfo?.[name] !== "string" || nodeInfo[name].length === 0) {
          throw new Error(`Development node is missing ${name} for Codex profile provenance.`);
        }
      }
      await writeFile(
        join(cluster.directory, "codex-seccomp-provenance.json"),
        stableJson({
          node: nodes[0],
          image,
          codexVersion,
          architecture: nodeInfo?.architecture,
          kernelVersion: nodeInfo?.kernelVersion,
          osImage: nodeInfo?.osImage,
          containerRuntimeVersion: nodeInfo?.containerRuntimeVersion,
          runtimeDefaultSha256: sha256Hex(stableJson(baseline)),
          profileSha256: digest,
          profileName,
          sourceProvenance: codexBwrapSourceProvenance,
        }),
        { mode: 0o600, flag: "wx" },
      );
      return { mode: "Localhost", profileName } as const;
    },
  );
}

export {
  developmentCodexProfileName,
  prepareCodexSeccompProfile,
  prepareDevelopmentCodexSeccompProfile,
};
