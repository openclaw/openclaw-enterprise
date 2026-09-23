import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, posix, relative, resolve } from "node:path";

const defaultProfileName = "openclaw/codex-bwrap.json";
const kubeletSeccompRoot = "/var/lib/kubelet/seccomp";
const codexProbeTimeoutMs = 180_000;
const kubectlRequestTimeout = "75s";

// The vendored Bubblewrap sources are byte-identical across the reviewed releases.
// Codex 0.156.0 adds socket masking with existing tmpfs and remount flags.
// Version admission does not change the syscall rules or the live positive/negative probes.
const codexBwrapSourceProvenance = Object.freeze([
  {
    name: "containerd RuntimeDefault seccomp",
    source: "actual CRI runtimeSpec.linux.seccomp from each selected k3d node",
  },
  {
    name: "Codex 0.152.1 and 0.154.0 bubblewrap launcher",
    source: "openai/codex rust-v0.152.1 and rust-v0.154.0 codex-rs/linux-sandbox/src/bwrap.rs",
    sha256: "bfce8aa44048b2441a7c02b301fe7366ae1b8b9ddd8ff8518711cd874a9e749e",
  },
  {
    name: "Codex 0.156.0 bubblewrap launcher",
    source: "openai/codex rust-v0.156.0 codex-rs/linux-sandbox/src/bwrap.rs",
    sha256: "e1c2a7a0ac805a70f3531ff7d584970b023da2d59fc221e0cb6bd0fa0c31729d",
  },
  {
    name: "bubblewrap mount setup",
    source:
      "openai/codex rust-v0.152.1, rust-v0.154.0 and rust-v0.156.0 codex-rs/vendor/bubblewrap/bubblewrap.c",
    sha256: "9bc38fb46080b6854e0c414ccb5fbd369d9d7c0230fdfa877283d31aef0c5720",
  },
  {
    name: "bubblewrap bind mount flags",
    source:
      "openai/codex rust-v0.152.1, rust-v0.154.0 and rust-v0.156.0 codex-rs/vendor/bubblewrap/bind-mount.c",
    sha256: "19a6ae020803e342667dd562efab027967b1c1f2965525ec7ee09521554f8f71",
  },
]);

function randomSuffix(bytes = 6) {
  return randomUUID()
    .replaceAll("-", "")
    .slice(0, bytes * 2);
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function allowSyscall(name, index, value) {
  return {
    names: [name],
    action: "SCMP_ACT_ALLOW",
    ...(index === undefined ? {} : { args: [{ index, op: "SCMP_CMP_EQ", value }] }),
  };
}

const linuxCloneFlags = Object.freeze({
  SIGCHLD: 0x00000011,
  CLONE_NEWNS: 0x00020000,
  CLONE_NEWUSER: 0x10000000,
  CLONE_NEWIPC: 0x08000000,
  CLONE_NEWPID: 0x20000000,
  CLONE_NEWNET: 0x40000000,
});

const linuxMountFlags = Object.freeze({
  MS_RDONLY: 0x00000001,
  MS_NOSUID: 0x00000002,
  MS_NODEV: 0x00000004,
  MS_NOEXEC: 0x00000008,
  MS_BIND: 0x00001000,
  MS_REC: 0x00004000,
  MS_SILENT: 0x00008000,
  MS_PRIVATE: 0x00040000,
  MS_SLAVE: 0x00080000,
  MS_REMOUNT: 0x00000020,
  MS_NOATIME: 0x00000400,
  MS_NODIRATIME: 0x00000800,
  MS_RELATIME: 0x00200000,
  MS_MGC_VAL: 0xc0ed0000,
});

const mountNamespaceCloneFlags =
  linuxCloneFlags.CLONE_NEWUSER | linuxCloneFlags.CLONE_NEWNS | linuxCloneFlags.SIGCHLD;
const namespaceCloneFlags = Object.freeze([
  mountNamespaceCloneFlags,
  mountNamespaceCloneFlags | linuxCloneFlags.CLONE_NEWPID | linuxCloneFlags.CLONE_NEWIPC,
  mountNamespaceCloneFlags |
    linuxCloneFlags.CLONE_NEWNET |
    linuxCloneFlags.CLONE_NEWPID |
    linuxCloneFlags.CLONE_NEWIPC,
]);

function bindMountFlagAllowlist() {
  const base =
    linuxMountFlags.MS_BIND |
    linuxMountFlags.MS_SILENT |
    linuxMountFlags.MS_REMOUNT |
    linuxMountFlags.MS_NOSUID;
  const variable = [
    linuxMountFlags.MS_RDONLY,
    linuxMountFlags.MS_NODEV,
    linuxMountFlags.MS_NOEXEC,
    linuxMountFlags.MS_NOATIME,
    linuxMountFlags.MS_NODIRATIME,
    linuxMountFlags.MS_RELATIME,
  ];
  const flags = [];

  function append(index, value) {
    if (index === variable.length) {
      flags.push(value);
      return;
    }
    append(index + 1, value);
    append(index + 1, value | variable[index]);
  }

  append(0, base);
  return flags;
}

function codexBwrapAdditionalSyscalls() {
  const directMountFlags = [
    linuxMountFlags.MS_NOSUID | linuxMountFlags.MS_NODEV,
    linuxMountFlags.MS_NOSUID | linuxMountFlags.MS_NOEXEC,
    linuxMountFlags.MS_NOSUID | linuxMountFlags.MS_NODEV | linuxMountFlags.MS_NOEXEC,
    linuxMountFlags.MS_SILENT | linuxMountFlags.MS_BIND,
    linuxMountFlags.MS_SILENT | linuxMountFlags.MS_BIND | linuxMountFlags.MS_REC,
    linuxMountFlags.MS_SILENT | linuxMountFlags.MS_PRIVATE | linuxMountFlags.MS_REC,
    linuxMountFlags.MS_SILENT | linuxMountFlags.MS_SLAVE | linuxMountFlags.MS_REC,
    (linuxMountFlags.MS_MGC_VAL |
      linuxMountFlags.MS_BIND |
      linuxMountFlags.MS_SILENT |
      linuxMountFlags.MS_REC) >>>
      0,
  ].sort((left, right) => left - right);
  const mountFlags = [...directMountFlags, ...bindMountFlagAllowlist()];

  return [
    ...namespaceCloneFlags.map((flags) => allowSyscall("clone", 0, flags)),
    allowSyscall("unshare", 0, linuxCloneFlags.CLONE_NEWUSER),
    ...mountFlags.map((flags) => allowSyscall("mount", 3, flags)),
    allowSyscall("pivot_root"),
    allowSyscall("umount2", 1, 2),
  ];
}

function assertSyscallRule(rule, description) {
  assert.equal(typeof rule, "object", `${description} syscall rule must be an object.`);
  assert.ok(Array.isArray(rule.names), `${description} syscall rule names must be an array.`);
  assert.ok(rule.names.length > 0, `${description} syscall rule must name at least one syscall.`);
  for (const name of rule.names) {
    assert.equal(typeof name, "string", `${description} syscall names must be strings.`);
    assert.ok(name.length > 0, `${description} syscall names must be non-empty.`);
  }
  assert.equal(typeof rule.action, "string", `${description} syscall action must be a string.`);
  if (rule.args !== undefined) {
    assert.ok(Array.isArray(rule.args), `${description} syscall args must be an array.`);
    for (const arg of rule.args) {
      assert.equal(typeof arg.index, "number", `${description} syscall arg index must be numeric.`);
      assert.equal(typeof arg.op, "string", `${description} syscall arg op must be a string.`);
      assert.equal(typeof arg.value, "number", `${description} syscall arg value must be numeric.`);
    }
  }
}

function validateRuntimeDefaultSeccompProfile(
  profile,
  description = "RuntimeDefault seccomp profile",
) {
  assert.equal(typeof profile, "object", `${description} must be an object.`);
  assert.equal(
    profile.defaultAction,
    "SCMP_ACT_ERRNO",
    `${description} must default-deny with SCMP_ACT_ERRNO.`,
  );
  assert.ok(Array.isArray(profile.architectures), `${description} must name architectures.`);
  assert.ok(
    profile.architectures.length > 0,
    `${description} must name at least one architecture.`,
  );
  assert.ok(Array.isArray(profile.syscalls), `${description} must contain syscall rules.`);
  assert.ok(profile.syscalls.length > 0, `${description} syscall rules must be non-empty.`);
  for (const rule of profile.syscalls) {
    assertSyscallRule(rule, description);
  }
  assert.ok(
    profile.syscalls.some(
      (rule) =>
        rule.action === "SCMP_ACT_ERRNO" &&
        rule.errnoRet === 38 &&
        Array.isArray(rule.names) &&
        rule.names.includes("clone3"),
    ),
    `${description} must preserve the containerd clone3 ENOSYS rule.`,
  );
}

function deriveCodexBwrapProfile(baseline) {
  validateRuntimeDefaultSeccompProfile(baseline);
  const profile = structuredClone(baseline);
  profile.syscalls = [...profile.syscalls, ...codexBwrapAdditionalSyscalls()];
  return profile;
}

function assertImmutableImageReference(image, name = "Codex runtime image") {
  assert.match(
    image ?? "",
    /^\S+@sha256:[a-f0-9]{64}$/i,
    `${name} must be an immutable image@sha256 reference.`,
  );
}

function assertLocalhostProfileName(profileName) {
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

function requireExecFile(execFile) {
  if (typeof execFile !== "function") {
    throw new Error("Codex seccomp preparation requires execFile.");
  }
  return execFile;
}

function assertInsideDirectory(parent, child, description) {
  const relativePath = relative(parent, resolve(child));
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`${description} must stay inside ${parent}.`);
  }
}

function assertSelectedK3dCluster(cluster) {
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

function kubectlArgs(selection, args) {
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

async function kubectl(selection, args, options) {
  const result = await options.execFile(options.kubectl, kubectlArgs(selection, args), {
    timeoutMs: options.commandTimeoutMs,
  });
  return result.stdout;
}

async function kubectlJson(selection, args, options) {
  return JSON.parse(await kubectl(selection, [...args, "-o", "json"], options));
}

async function applyManifest(selection, manifest, options) {
  const manifestPath = join(options.directory, `${manifest.metadata.name}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  await options.execFile(options.kubectl, kubectlArgs(selection, ["apply", "-f", manifestPath]), {
    timeoutMs: options.commandTimeoutMs,
  });
}

async function waitFor(description, operation, timeoutMs = codexProbeTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
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
    `Timed out waiting for ${description}.${lastError ? ` Last error: ${lastError.message}` : ""}`,
  );
}

function restrictedProbePod({ name, namespace, nodeName, image, localhostProfile }) {
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

function extractContainerId(pod, containerName = "probe") {
  const status = pod.status?.containerStatuses?.find((entry) => entry.name === containerName);
  const id = status?.containerID?.replace(/^[^:]+:\/\//, "");
  assert.ok(id, `Pod ${pod.metadata?.name} did not expose a ${containerName} container ID.`);
  return id;
}

function extractRuntimeSpec(criInspect) {
  const runtimeSpec = criInspect.info?.runtimeSpec ?? criInspect.status?.info?.runtimeSpec;
  if (typeof runtimeSpec === "string") {
    return JSON.parse(runtimeSpec);
  }
  return runtimeSpec;
}

function codexSandboxProbeCommand(options) {
  return `set -eu; version=$(codex --version | awk '{print $NF}'); if [ "$version" != "${options.codexVersion}" ]; then echo "Codex version mismatch: expected ${options.codexVersion}, got $version" >&2; exit 64; fi; mkdir -p /home/node/.codex /workspace; cd /workspace; timeout 60s codex sandbox -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=false -- sh -c "echo ok > /workspace/codex-seccomp-ok"`;
}

async function inspectContainerRuntimeSpec(nodeName, containerId, options) {
  const result = await options.execFile(
    options.docker,
    ["exec", nodeName, "crictl", "inspect", containerId],
    { timeoutMs: options.commandTimeoutMs },
  );
  const runtimeSpec = extractRuntimeSpec(JSON.parse(result.stdout));
  assert.ok(runtimeSpec?.linux?.seccomp, "CRI inspect did not expose runtimeSpec.linux.seccomp.");
  return runtimeSpec;
}

async function execCodexSandboxProbe(selection, namespace, podName, options) {
  await kubectl(
    selection,
    [
      "exec",
      podName,
      "--namespace",
      namespace,
      "--",
      "sh",
      "-c",
      codexSandboxProbeCommand(options),
    ],
    options,
  );
}

async function verifyRuntimeDefaultDeniesCodexSandbox(selection, namespace, podName, options) {
  try {
    await execCodexSandboxProbe(selection, namespace, podName, options);
  } catch (error) {
    if (error.timedOut === true) {
      throw error;
    }
    const diagnostic = [error.stderr, error.stdout].filter(Boolean).join("\n");
    if (/codex version mismatch/i.test(diagnostic)) {
      throw error;
    }
    assert.match(
      diagnostic,
      /bwrap|bubblewrap|clone|namespace|operation not permitted|permission denied|seccomp|unshare/i,
      "RuntimeDefault Codex sandbox denial must mention a namespace or seccomp restriction.",
    );
    return;
  }
  throw new Error("RuntimeDefault unexpectedly allowed the Codex sandbox probe.");
}

async function listOwnedK3dNodes(selection, cluster, options) {
  const nodes = await kubectlJson(selection, ["get", "nodes"], options);
  const names = nodes.items?.map((node) => node.metadata?.name).filter(Boolean) ?? [];
  assert.ok(names.length > 0, "The selected k3d cluster must expose at least one node.");
  for (const name of names) {
    assert.ok(
      name.startsWith(`k3d-${cluster.name}-`),
      `Refusing to install seccomp profile on node outside the owned k3d cluster: ${name}`,
    );
  }
  return names;
}

async function waitForPodReady(selection, namespace, name, options) {
  return waitFor(
    `Pod ${namespace}/${name} to become ready`,
    async () => {
      const pod = await kubectlJson(
        selection,
        ["get", "pod", name, "--namespace", namespace],
        options,
      );
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

async function waitForMissingProfileFailure(selection, namespace, name, options) {
  return waitFor(
    `Pod ${namespace}/${name} to fail closed on a missing localhost seccomp profile`,
    async () => {
      const pod = await kubectlJson(
        selection,
        ["get", "pod", name, "--namespace", namespace],
        options,
      );
      const status = pod.status?.containerStatuses?.find((entry) => entry.name === "probe");
      if (status?.containerID) {
        throw new Error("Missing localhost seccomp profile unexpectedly started a container.");
      }
      const waiting = status?.state?.waiting;
      if (
        waiting?.reason === "CreateContainerError" &&
        /seccomp|profile/i.test(waiting.message ?? "")
      ) {
        return pod;
      }
      return false;
    },
    options.timeoutMs,
  );
}

async function runtimeDefaultProfileForNode(selection, namespace, nodeName, image, options) {
  const podName = `runtime-default-${slug(nodeName).slice(0, 40)}-${randomSuffix(3)}`;
  await applyManifest(
    selection,
    restrictedProbePod({ name: podName, namespace, nodeName, image }),
    options,
  );
  const pod = await waitForPodReady(selection, namespace, podName, options);
  await verifyRuntimeDefaultDeniesCodexSandbox(selection, namespace, podName, options);
  const runtimeSpec = await inspectContainerRuntimeSpec(nodeName, extractContainerId(pod), options);
  return runtimeSpec.linux.seccomp;
}

async function installProfileOnNode(nodeName, profileName, profile, directory, options) {
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
  return { path: destination, sha256: expectedSha256, bytes: Buffer.byteLength(profileData) };
}

async function verifyInstalledProfile(
  selection,
  namespace,
  nodeName,
  image,
  profileName,
  profile,
  options,
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
  const runtimeSpec = await inspectContainerRuntimeSpec(nodeName, extractContainerId(pod), options);
  assert.deepEqual(
    runtimeSpec.linux.seccomp,
    profile,
    `Effective seccomp profile on ${nodeName} must equal the installed profile.`,
  );
  await execCodexSandboxProbe(selection, namespace, podName, options);
}

async function verifyMissingProfileFailsClosed(
  selection,
  namespace,
  nodeName,
  image,
  profileName,
  options,
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
  await waitForMissingProfileFailure(selection, namespace, podName, options);
}

async function prepareCodexSeccompProfile({
  cluster,
  image,
  profileName = defaultProfileName,
  timeoutMs = codexProbeTimeoutMs,
  execFile,
  kubectl: kubectlBin,
  docker,
  codexVersion = "0.156.0",
  commandTimeoutMs = timeoutMs + 15_000,
  env = process.env,
} = {}) {
  const selectedCluster = assertSelectedK3dCluster(cluster);
  const exec = requireExecFile(execFile);
  assertImmutableImageReference(image);
  assertLocalhostProfileName(profileName);
  assert.ok(
    ["0.152.1", "0.154.0", "0.156.0"].includes(codexVersion),
    "Codex seccomp profile verification is limited to reviewed Codex versions: 0.152.1, 0.154.0, 0.156.0.",
  );
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
  const nodes = [];
  let primaryError;
  try {
    await kubectl(selection, ["create", "namespace", namespace], options);
    for (const nodeName of await listOwnedK3dNodes(selection, selectedCluster, options)) {
      const baseline = await runtimeDefaultProfileForNode(
        selection,
        namespace,
        nodeName,
        image,
        options,
      );
      const profile = deriveCodexBwrapProfile(baseline);
      const installation = await installProfileOnNode(
        nodeName,
        profileName,
        profile,
        directory,
        options,
      );
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
        addedRules: codexBwrapAdditionalSyscalls().length,
      });
    }
    assert.ok(nodes.length > 0, "Codex seccomp profile preparation must cover at least one node.");
    await verifyMissingProfileFailsClosed(
      selection,
      namespace,
      nodes[0].nodeName,
      image,
      profileName,
      options,
    );
    return {
      profileName,
      env: { OCC_TEST_KUBERNETES_CODEX_SECCOMP_PROFILE: profileName },
      nodes,
      sourceProvenance: codexBwrapSourceProvenance,
      proofLimits: [
        "Generated from each selected node's effective RuntimeDefault OCI profile.",
        "Architecture proof is limited to the selected cluster nodes.",
        "CI installs the localhost profile only into run-owned k3d nodes.",
      ],
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    try {
      await kubectl(
        selection,
        ["delete", "namespace", namespace, "--ignore-not-found=true", "--wait=false"],
        options,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      const cleanupMessage = cleanupErrors.map((error) => error.message).join("; ");
      const cleanupError = new AggregateError(
        cleanupErrors,
        `Codex seccomp cleanup failed: ${cleanupMessage}`,
      );
      if (primaryError) {
        primaryError.cleanupError = cleanupError;
        primaryError.message = `${primaryError.message}; cleanup also failed: ${cleanupMessage}`;
      } else {
        throw cleanupError;
      }
    }
  }
}

export {
  codexBwrapAdditionalSyscalls,
  codexBwrapSourceProvenance,
  defaultProfileName,
  deriveCodexBwrapProfile,
  prepareCodexSeccompProfile,
  validateRuntimeDefaultSeccompProfile,
};
