import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, posix, relative, resolve } from "node:path";
import {
  assertReviewedCodexVersion,
  codexBwrapAdditionalSyscalls,
  codexBwrapSourceProvenance,
  deriveCodexBwrapProfile,
  sha256Hex,
  stableJson,
  validateRuntimeDefaultSeccompProfile,
} from "../lib/codex-seccomp-profile.mjs";

const defaultProfileName = "openclaw/codex-bwrap.json";
const kubeletSeccompRoot = "/var/lib/kubelet/seccomp";
const codexProbeTimeoutMs = 180_000;
const kubectlRequestTimeout = "75s";

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
  return `set -eu; version=$(codex --version | awk '{print $NF}'); if [ "$version" != "${options.codexVersion}" ]; then echo "Codex version mismatch: expected ${options.codexVersion}, got $version" >&2; exit 64; fi; mkdir -p /home/node/.codex /workspace; cd /workspace; outside=/home/node/codex-seccomp-outside; rm -f "$outside" /workspace/codex-seccomp-ok; echo outside-ok > "$outside"; timeout 60s codex sandbox -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=false -- sh -c "set -eu; echo ok > /workspace/codex-seccomp-ok; if echo escaped > /home/node/codex-seccomp-outside; then echo outside workspace write unexpectedly succeeded >&2; exit 70; fi"; test "$(cat /workspace/codex-seccomp-ok)" = ok; test "$(cat "$outside")" = outside-ok; rm -f "$outside" /workspace/codex-seccomp-ok`;
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
  return {
    path: destination,
    sha256: expectedSha256,
    bytes: Buffer.byteLength(profileData),
    profileData,
  };
}

async function writeDockerSeccompProfile(directory, codexVersion, installation) {
  const dockerDirectory = join(directory, "docker-seccomp");
  await mkdir(dockerDirectory, { recursive: true, mode: 0o700 });
  await chmod(dockerDirectory, 0o700);
  const profilePath = join(dockerDirectory, `codex-${codexVersion}-${installation.sha256}.json`);
  await writeFile(profilePath, installation.profileData, { mode: 0o644, flag: "wx" });
  await chmod(profilePath, 0o644);
  return profilePath;
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
  const nodes = [];
  let dockerProfilePath;
  let dockerProfileSha256;
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
