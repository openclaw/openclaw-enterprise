import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import {
  arrangeProductionTopology,
  assertActualModelTurn,
} from "../tests/helpers/harness-topology-k3d-real.mjs";

const controlUiPort = 18888;
const consolePort = 18889;
const demoStatePath = process.env.OCC_K3D_DEMO_STATE;

async function main() {
  assert.ok(demoStatePath, "OCC_K3D_DEMO_STATE is required");
  const cleanups = [];
  const context = {
    after: (cleanup) => cleanups.push(cleanup),
    diagnostic: (message) => process.stderr.write(`[k3d:demo] ${message}\n`),
  };
  let stopDemo;
  const stopping = new Promise((resolve) => {
    stopDemo = resolve;
  });
  process.once("SIGINT", stopDemo);
  process.once("SIGTERM", stopDemo);
  let failure;
  try {
    process.stderr.write("[k3d:demo] Creating a dedicated Codex Agent and OCC console.\n");
    const topology = await arrangeProductionTopology(context, "dedicated", undefined, {
      bindingNegativeControl: false,
      controllerPort: consolePort,
      gatewayPassword: true,
      gatewayPort: controlUiPort,
      workspaceGateway: true,
      credentials: {
        email: process.env.OPENCLAW_DEV_EMAIL || "admin@openclaw.local",
        password: process.env.OPENCLAW_DEV_PASSWORD || "openclaw-development-password",
      },
      nativeOptions: {
        controlUi: {
          enabled: true,
          allowedOrigins: [
            `http://127.0.0.1:${controlUiPort}`,
            `http://localhost:${controlUiPort}`,
          ],
        },
      },
    });
    assert.equal(topology.controllerUrl, `http://127.0.0.1:${consolePort}`);
    assert.equal(topology.gatewayUrl, `http://127.0.0.1:${controlUiPort}`);
    assert.ok(topology.gatewayPassword, "the demo requires a direct Control UI password");
    await topology.workspaceGateway.connect(topology);

    process.stderr.write("[k3d:demo] Running a real model turn before exposing the demo.\n");
    await assertActualModelTurn(topology);

    const controlUiUrl = `${topology.gatewayUrl}/`;
    await writeFile(
      demoStatePath,
      `${JSON.stringify({
        namespace: topology.placement,
        namespaceId: topology.namespaceId,
        agentId: topology.agent.id,
        processId: String(process.pid),
        controlUiUrl,
        gatewayPassword: topology.gatewayPassword,
        consoleUrl: `${topology.controllerUrl}/console/agents?namespace=${topology.namespaceId}`,
        consoleUsername: topology.credentials.email,
        consolePassword: topology.credentials.password,
      })}\n`,
      { mode: 0o600 },
    );

    process.stdout.write(
      [
        "",
        "OpenClaw",
        `  Control UI:  ${controlUiUrl}`,
        "  Password:    ./scripts/k3d copy openclaw-password",
        "",
        "OpenClaw Control Plane (OCC)",
        `  Console:   ${topology.controllerUrl}/console/agents?namespace=${topology.namespaceId}`,
        `  Username:  ${topology.credentials.email}`,
        "  Password:  ./scripts/k3d copy occ-password",
        "",
        "Kubernetes",
        `  Namespace:     ${topology.placement}`,
        `  Namespace ID:  ${topology.namespaceId}`,
        `  Agent ID:      ${topology.agent.id}`,
        `  Kubeconfig:    ${process.env.OCC_TEST_KUBERNETES_KUBECONFIG}`,
        `  Context:       ${process.env.OCC_TEST_KUBERNETES_CONTEXT}`,
        "",
        "Both consoles are exposed only on loopback. Press Ctrl-C to remove the demo Agent resources.",
        "",
      ].join("\n"),
    );

    await stopping;
  } catch (error) {
    failure = error;
  } finally {
    process.removeListener("SIGINT", stopDemo);
    process.removeListener("SIGTERM", stopDemo);
    await rm(demoStatePath, { force: true });
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        failure =
          failure === undefined
            ? error
            : new AggregateError([failure, error], "k3d demo and cleanup both failed");
      }
    }
  }
  if (failure !== undefined) {
    throw failure;
  }
  process.stdout.write(
    [
      "k3d demo stopped; demo resources and port-forwards were removed.",
      "Cluster, images, and PostgreSQL remain available.",
      "Restart the demo and port-forwards with: ./scripts/k3d",
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
