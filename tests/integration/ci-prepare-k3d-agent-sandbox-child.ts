import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mock } from "node:test";
import { asRecord } from "../../packages/utils/src/index.ts";
import { preloadAgentSandboxController } from "../../scripts/ci/agent-sandbox.ts";
import * as openshell from "../../scripts/ci/openshell.ts";
import * as routing from "../../scripts/ci/routing.ts";

const [, , statePath, k3sImage] = process.argv;
assert.ok(statePath && k3sImage, "expected the fixture state path and K3s image");
const root = dirname(statePath);
const kubectl = process.env.OCC_KUBECTL_BIN;
assert.ok(kubectl, "expected the fixture kubectl shim");

// Only unrelated installation/bootstrap work is bypassed. The prepare-lane
// closure owns registration, verification and the cleanup journal.
mock.module("../../scripts/ci/routing.ts", {
  exports: { ...routing, prepareGatewayRouting: async () => ({ env: {} }) },
});
mock.module("../../scripts/ci/openshell.ts", {
  exports: {
    ...openshell,
    prepareOpenShellClusterBootstrap: async () => ({
      k3sImage,
      kubectl,
      runtimeClass: "openshell-sandbox",
      runtimeHandler: "runc",
    }),
    prepareOpenShellPodSecurityAdmission: async () => ({ k3dArgs: [] }),
    prepareOpenShell: async ({
      cluster,
      registerImage,
    }: Parameters<typeof openshell.prepareOpenShell>[0]) => {
      const ownedNodes = asRecord(cluster)?.nodes;
      assert.ok(Array.isArray(ownedNodes), "expected the preparation cluster's node inventory");
      const nodes = {
        items: ownedNodes.map((name: unknown) => {
          assert.ok(typeof name === "string", "expected a node name");
          return {
            metadata: { name },
            status: { nodeInfo: { operatingSystem: "linux", architecture: "amd64" } },
          };
        }),
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const directory = join(cluster.directory, `preload-${attempt}`);
        await mkdir(directory);
        const manifest = join(directory, "sandbox.yaml");
        await writeFile(
          manifest,
          "      - name: agent-sandbox-controller\n        image: registry.k8s.io/agent-sandbox/agent-sandbox-controller:v0.5.2\n",
        );
        const result = await preloadAgentSandboxController(manifest, nodes, registerImage);
        await writeFile(join(root, `result-${attempt}`), await readFile(result));
        await writeFile(join(root, "reuse"), "reuse");
      }
      throw new Error("native-registration-complete");
    },
  },
});
const { prepareLane } = await import("../../scripts/ci/prepare.mjs");
try {
  await prepareLane({ lane: "openshell", statePath, file: undefined, cleanupOwner: undefined });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
