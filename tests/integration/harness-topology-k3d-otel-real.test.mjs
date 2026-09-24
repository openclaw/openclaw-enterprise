import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { installObservabilityControlPlane } from "../helpers/production-observability-k3d.mjs";
import {
  assertGatewayModelTurn,
  createRealKubernetesFixture,
  kubernetesHash,
} from "../helpers/kubernetes-real.mjs";
import {
  assertKubernetesRuntimeOtelSettings,
  createOtelLogObservation,
  OTEL_RESOURCE,
} from "../helpers/logging-otel-observation.mjs";

const selected =
  process.env.OCC_TEST_HARNESS_K3D_REAL === "1" && process.env.OCC_TEST_OTEL_LOGS === "1";
for (const mode of ["embedded", "dedicated"]) {
  test(
    `production ${mode} runtime emits actual OTLP logs during a real model turn`,
    {
      skip: selected
        ? false
        : "Run pnpm test:observability:models with approved runtime images and credentials.",
      timeout: 1_200_000,
    },
    async (t) => {
      const observation = createOtelLogObservation(t, { description: `Helm ${mode} runtime logs` });
      const f = await installObservabilityControlPlane(t, { modelTurns: true });
      const workflow = await f.createAgent(mode);
      const fixture = createRealKubernetesFixture(f.selection);
      const gatewayName = `gateway-${kubernetesHash(workflow.agent.id)}`;
      let previous;
      for (const round of [1, 2]) {
        // A second immutable revision must produce fresh, correctly attributed
        // native records after cutover, not satisfy assertions with the old Pod.
        const revision = await workflow.deploy();
        assert.notEqual(revision.id, previous);
        previous = revision.id;
        const runtimePods = (
          await Promise.all(
            [...new Set([workflow.tenant, workflow.gatewayPlacement])].map((namespace) =>
              f.kubernetes.resources(
                "pods",
                namespace,
                "-l",
                `openclaw.dev/agent=${workflow.agent.id}`,
              ),
            ),
          )
        ).flat();
        const pods = runtimePods.filter(
          (pod) => !pod.metadata.deletionTimestamp && pod.status.phase === "Running",
        );
        assertKubernetesRuntimeOtelSettings(observation, pods);
        const agentPods = pods.filter(
          (pod) => pod.metadata.labels["openclaw.dev/workload-role"] === "agent",
        );
        assert.equal(agentPods.length, mode === "dedicated" ? 1 : 0);
        const transport = await f.get(
          "secret",
          `openclaw-agent-transport-${kubernetesHash(workflow.agent.id)}`,
          workflow.tenant,
        );
        const password = Buffer.from(transport.data["gateway-password"], "base64").toString();
        f.secrets.push(password);
        const gateway = await f.get("service", gatewayName, workflow.gatewayPlacement);
        const url = `http://${gateway.spec.clusterIP}:8080/healthz`;
        assert.ok((await f.scrape("operator", f.system, url)).status > 0);
        assert.equal((await f.scrape("wrong-namespace", f.foreign, url)).status, 0);
        const forwarding = await fixture.startPortForward(workflow.gatewayPlacement, gatewayName);
        try {
          await assertGatewayModelTurn({
            gatewayUrl: forwarding.url,
            gatewayPassword: password,
            nonce: `OBS_${round}_${randomUUID()}`,
            secrets: [process.env.OPENAI_API_KEY],
          });
        } finally {
          await forwarding.stop();
        }
        await observation.assertRecords({
          forbidden: f.secrets,
          expected: [
            {
              label: "Helm API operational event",
              serviceName: "occ-api",
              attributes: { "event.name": "http.completed" },
              body: "http.completed",
            },
            {
              label: "Helm worker revision event",
              serviceName: "occ-worker",
              attributes: { "event.name": "worker.completed", "occ.revision.id": revision.id },
              body: "worker.completed",
            },
            ...["openclaw-gateway", ...(mode === "dedicated" ? ["codex-app-server"] : [])].map(
              (serviceName) => ({
                label: `${mode} revision ${round} ${serviceName}`,
                serviceName,
                resource: {
                  [OTEL_RESOURCE.namespaceId]: workflow.namespace.id,
                  [OTEL_RESOURCE.agentId]: workflow.agent.id,
                  [OTEL_RESOURCE.revisionId]: revision.id,
                },
                attributes: {
                  "event.name":
                    serviceName === "openclaw-gateway"
                      ? "gateway.operational"
                      : "codex.operational",
                },
                body:
                  serviceName === "openclaw-gateway" ? "gateway.operational" : "codex.operational",
              }),
            ),
          ],
        });
        for (const component of ["api", "worker"]) {
          const pod = await f.currentPod(component);
          const metrics = await f.node(
            pod.metadata.name,
            f.system,
            `console.log(await (await fetch('http://${pod.status.podIP}:9464/metrics')).text())`,
          );
          assert.match(
            metrics,
            component === "api"
              ? /occ_http_requests_total/
              : /occ_agent_operation_duration_seconds_count/,
          );
          const environment = await f.node(
            pod.metadata.name,
            f.system,
            "console.log(JSON.stringify(Boolean(process.env.OPENAI_API_KEY)))",
          );
          assert.equal(JSON.parse(environment), false);
        }
      }
      await workflow.stop();
    },
  );
}
