import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Native children/configs of the verified v0.5.2 index
// sha256:dbbad861e6c2cc0df1f7ec37dd0e2827b3d2bc051eb45855e01f94e697440403.
const controllerPlatforms = {
  "linux/amd64": {
    manifest: "c28ca6f2366160f2470013c4588821cf7ebd21538d62c1016b6afc93583830d6",
    config: "5b6c81129dc7491b3d260940e34ff68323fb6f7f21450d42129be5169e52ab17",
  },
  "linux/arm64": {
    manifest: "7e273b836b1f7e5e33c08c68bcf539959ca2b298cb29153e1fab60fd05851248",
    config: "850778443f8cc9a11d85dc345f9f8f26a1f2f651fd15271e0e2948206cc7fe67",
  },
};
const controller =
  "      - name: agent-sandbox-controller\n        image: registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2\n";

type NodeList = {
  items: {
    metadata: { name: string };
    status: { nodeInfo: { operatingSystem: string; architecture: string } };
  }[];
};

export function agentSandboxControllerForNodes(nodes: NodeList) {
  const platforms = new Set(
    nodes.items.map(
      ({ status }) => `${status.nodeInfo.operatingSystem}/${status.nodeInfo.architecture}`,
    ),
  );
  if (platforms.size !== 1) {
    throw new Error("Agent Sandbox requires one node platform.");
  }
  const platform = [...platforms][0];
  const selected = controllerPlatforms[platform as keyof typeof controllerPlatforms];
  if (!platform || !selected) {
    throw new Error(`Unsupported Agent Sandbox node platform ${platform}.`);
  }
  return {
    source: `registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2@sha256:${selected.manifest}`,
    config: `sha256:${selected.config}`,
    nativeSelection: {
      platform,
      configDigest: `sha256:${selected.config}`,
      cacheIndex:
        "registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2@sha256:dbbad861e6c2cc0df1f7ec37dd0e2827b3d2bc051eb45855e01f94e697440403",
    },
  };
}

export async function preloadAgentSandboxController(
  manifestPath: string,
  nodes: NodeList,
  registerImage: (
    image: string,
    description: string,
    nativeSelection: { platform: string; configDigest: string; cacheIndex: string },
  ) => Promise<string>,
): Promise<string> {
  // The caller verified this release's checksum; preserve every other manifest byte.
  const manifest = await readFile(manifestPath, "utf8");
  const parts = manifest.split(controller);
  if (parts.length !== 2) {
    throw new Error(
      "Pinned Agent Sandbox manifest must contain exactly one expected controller image.",
    );
  }
  const selected = agentSandboxControllerForNodes(nodes);
  const image = await registerImage(
    selected.source,
    "Agent Sandbox controller",
    selected.nativeSelection,
  );
  const localManifest = join(dirname(manifestPath), "agent-sandbox-local.yaml");
  await writeFile(
    localManifest,
    `${parts[0]}      - name: agent-sandbox-controller\n        image: ${image}\n        imagePullPolicy: Never\n${parts[1]}`,
    { mode: 0o600, flag: "wx" },
  );
  return localManifest;
}

// Used by both real dev-up cases and normal CI preparation. A digest-shaped Pod
// image alone is insufficient: bind the imported content and running CRI image
// to the native config from the pinned release.
export async function verifyPreloadedAgentSandbox({
  execFile,
  kubectl,
  kubectlCommand = "kubectl",
  engine,
  ownedNodes,
  source,
  reference,
}: {
  execFile: (file: string, args: string[]) => Promise<{ stdout: string }>;
  kubectl: string[];
  kubectlCommand?: string;
  engine: string;
  ownedNodes: string[];
  source: string;
  reference: string;
}) {
  const read = async (args: string[]) =>
    JSON.parse((await execFile(kubectlCommand, [...kubectl, ...args])).stdout);
  const nodes = (await read(["get", "nodes", "-o", "json"])) as NodeList;
  if (
    nodes.items.length !== ownedNodes.length ||
    nodes.items.some(({ metadata }) => !ownedNodes.includes(metadata.name))
  ) {
    throw new Error("Agent Sandbox verification requires the owned nodes.");
  }
  const expected = agentSandboxControllerForNodes(nodes);
  if (source !== expected.source) {
    throw new Error("Agent Sandbox import source does not match the node platform release.");
  }
  const { items } = await read([
    "get",
    "pods",
    "-n",
    "agent-sandbox-system",
    "-l",
    "app=agent-sandbox-controller",
    "-o",
    "json",
  ]);
  if (items.length !== 1) {
    throw new Error("Agent Sandbox must have exactly one controller Pod.");
  }
  const pod = items[0];
  const container = pod.spec.containers.find(
    ({ name }: { name: string }) => name === "agent-sandbox-controller",
  );
  const status = pod.status.containerStatuses?.find(
    ({ name }: { name: string }) => name === "agent-sandbox-controller",
  );
  if (
    container?.image !== reference ||
    container?.imagePullPolicy !== "Never" ||
    !status?.ready ||
    typeof status.imageID !== "string" ||
    status.imageID.length === 0 ||
    !status.state?.running ||
    !pod.status.conditions?.some(
      ({ type, status }: { type: string; status: string }) => type === "Ready" && status === "True",
    )
  ) {
    throw new Error(
      "Agent Sandbox must be Ready and running its exact imported reference with pull policy Never.",
    );
  }
  const node = pod.spec.nodeName;
  if (!ownedNodes.includes(node)) {
    throw new Error("Agent Sandbox is not running on an owned node.");
  }
  const digest = reference.split("@")[1];
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) {
    throw new Error("Agent Sandbox import must name an immutable manifest.");
  }
  const content = (
    await execFile(engine, ["exec", node, "ctr", "-n", "k8s.io", "content", "get", digest])
  ).stdout;
  if (
    `sha256:${createHash("sha256").update(content).digest("hex")}` !== digest ||
    JSON.parse(content).config?.digest !== expected.config
  ) {
    throw new Error("Agent Sandbox imported manifest does not match the native release config.");
  }
  for (const image of [reference, status.imageID.replace(/^[a-z-]+:\/\//, "")]) {
    const inspected = JSON.parse(
      (await execFile(engine, ["exec", node, "crictl", "inspecti", image])).stdout,
    );
    if (inspected.status?.id !== expected.config) {
      throw new Error("Agent Sandbox running image does not match the native release config.");
    }
  }
}
