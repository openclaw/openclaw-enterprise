import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const controllerImage =
  "registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2@sha256:dbbad861e6c2cc0df1f7ec37dd0e2827b3d2bc051eb45855e01f94e697440403";
const controller =
  "      - name: agent-sandbox-controller\n        image: registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2\n";

export async function preloadAgentSandboxController(
  manifestPath: string,
  registerImage: (image: string, description: string) => Promise<string>,
): Promise<string> {
  // The caller verified this release's checksum; preserve every other manifest byte.
  const manifest = await readFile(manifestPath, "utf8");
  const parts = manifest.split(controller);
  if (parts.length !== 2) {
    throw new Error(
      "Pinned Agent Sandbox manifest must contain exactly one expected controller image.",
    );
  }
  const image = await registerImage(controllerImage, "Agent Sandbox controller");
  const localManifest = join(dirname(manifestPath), "agent-sandbox-local.yaml");
  await writeFile(
    localManifest,
    `${parts[0]}      - name: agent-sandbox-controller\n        image: ${image}\n        imagePullPolicy: Never\n${parts[1]}`,
    { mode: 0o600, flag: "wx" },
  );
  return localManifest;
}
