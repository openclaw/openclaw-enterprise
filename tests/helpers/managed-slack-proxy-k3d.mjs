import assert from "node:assert/strict";
import { parseProductionChart, renderProductionChart } from "./production-chart.mjs";

// Install the supported chart resources in the topology's disposable namespace.
// The release must match the API labels and the existing Gateway namespace grant.
export async function installManagedSlackProxyFixture({
  namespace,
  controllerImage,
  workspaceGateway,
  resource,
  kubectl,
  applyManifest,
}) {
  const release = workspaceGateway.apiPodLabels["app.kubernetes.io/instance"];
  const gateway = await resource("gateway", workspaceGateway.routing.gatewayName, namespace);
  const { stdout } = await renderProductionChart(
    {
      "images.controller": controllerImage,
      "slackProxy.enabled": true,
      "gatewayRouting.enabled": true,
      "gatewayRouting.gatewayName": workspaceGateway.routing.gatewayName,
      "gatewayRouting.gatewayClassName": gateway.spec.gatewayClassName,
      "gatewayRouting.envoyNamespace": workspaceGateway.routing.envoyNamespace,
      "gatewayRouting.apiKeySecretName": workspaceGateway.apiKeySecretName,
    },
    { namespace, release },
  );
  const name = "openclaw-enterprise-slack-proxy";
  const items = (await parseProductionChart(stdout)).filter(
    ({ kind, metadata }) =>
      (metadata.name === name &&
        ["Deployment", "Service", "ServiceAccount", "NetworkPolicy"].includes(kind)) ||
      (kind === "NetworkPolicy" &&
        metadata.name === "openclaw-enterprise-api-managed-slack-proxy-egress"),
  );
  assert.equal(items.length, 5, "the chart must supply the proxy and API egress resources");
  for (const item of items) {
    item.metadata.namespace = namespace;
  }
  await applyManifest(JSON.stringify({ apiVersion: "v1", kind: "List", items }));
  await kubectl(
    "rollout",
    "status",
    `deployment/${name}`,
    "--namespace",
    namespace,
    "--timeout=180s",
  );
  const service = await resource("service", name, namespace);
  const hostname = `${service.metadata.name}.${namespace}.svc`;
  const port = service.spec.ports[0].port;
  return {
    proxyUrl: `http://${hostname}:${port}`,
    managedProxy: { hostname, namespace, podLabels: service.spec.selector, port },
  };
}
