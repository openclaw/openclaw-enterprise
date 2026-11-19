import assert from "node:assert/strict";
import { isIP } from "node:net";
import { asRecord } from "../../packages/utils/src/objects.ts";
import { parseProductionChart, renderProductionChart } from "./production-chart.ts";
import { loadYaml } from "./kubernetes-yaml.ts";
import type { ChannelEgressOptions } from "../../apps/controller/src/drivers/compute/kubernetes/channel-egress-policy.ts";

interface Fixture {
  listenerCapacity?: number;
  namespace: string;
  controllerImage: string;
  workspaceGateway: {
    apiPodLabels: Readonly<Record<string, string>>;
    routing: { gatewayName: string; envoyNamespace: string };
  };
  controller: { account: string; apiAccount: string };
  resource: (...args: string[]) => Promise<unknown>;
  kubectl: (...args: string[]) => Promise<string>;
  applyManifest: (value: string) => Promise<unknown>;
}

/** Real chart resources; callers still need API/worker deployment and runtime proof. */
export async function installManagedChannelEgressFixture({
  listenerCapacity = 62,
  namespace,
  controllerImage,
  workspaceGateway,
  controller,
  resource,
  kubectl,
  applyManifest,
}: Fixture) {
  const release = workspaceGateway.apiPodLabels["app.kubernetes.io/instance"];
  assert.ok(release);
  const gateway = asRecord(
    await resource("gateway", workspaceGateway.routing.gatewayName, namespace),
  );
  const gatewayClassName = asRecord(gateway?.spec)?.gatewayClassName;
  assert.equal(typeof gatewayClassName, "string");
  const config = asRecord(
    await resource("configmap", "envoy-gateway-config", workspaceGateway.routing.envoyNamespace),
  );
  const raw = asRecord(config?.data)?.["envoy-gateway.yaml"];
  assert.equal(typeof raw, "string");
  const controllerConfig = asRecord(loadYaml(raw as string));
  assert.equal(
    asRecord(controllerConfig?.extensionApis)?.enableEnvoyPatchPolicy,
    true,
    "The selected disposable Envoy Gateway must enable EnvoyPatchPolicy before channel proof.",
  );

  const nodes = asRecord(JSON.parse(await kubectl("get", "nodes", "-o", "json")));
  const exclusions = new Set<string>();
  for (const value of Array.isArray(nodes?.items) ? nodes.items : []) {
    const node = asRecord(value);
    const spec = asRecord(node?.spec);
    for (const cidr of Array.isArray(spec?.podCIDRs) ? spec.podCIDRs : []) {
      assert.equal(typeof cidr, "string");
      exclusions.add(cidr as string);
    }
    const status = asRecord(node?.status);
    for (const address of Array.isArray(status?.addresses) ? status.addresses : []) {
      const ip = asRecord(address)?.address;
      if (typeof ip === "string" && isIP(ip)) {
        exclusions.add(`${ip}/${isIP(ip) === 4 ? 32 : 128}`);
      }
    }
  }
  const serviceRanges = asRecord(JSON.parse(await kubectl("get", "servicecidrs", "-o", "json")));
  for (const value of Array.isArray(serviceRanges?.items) ? serviceRanges.items : []) {
    const spec = asRecord(asRecord(value)?.spec);
    for (const cidr of Array.isArray(spec?.cidrs) ? spec.cidrs : []) {
      assert.equal(typeof cidr, "string");
      exclusions.add(cidr as string);
    }
  }
  assert.ok(exclusions.size >= 3, "the fixture must resolve real node, Pod and Service ranges");
  assert.ok(Number.isInteger(listenerCapacity) && listenerCapacity >= 1 && listenerCapacity <= 62);
  const channelEgress: ChannelEgressOptions = {
    gatewayName: `channel-egress-${namespace.slice(-12)}`,
    gatewayNamespace: namespace,
    envoyNamespace: workspaceGateway.routing.envoyNamespace,
    serviceName: `channel-egress-${namespace.slice(-12)}`,
    listenerPortStart: 10001,
    listenerPortEnd: 10000 + listenerCapacity,
    occListenerPort: 10000,
    inspectionPort: 19004,
    excludedCidrs: [...exclusions],
  };
  const values: Record<string, string | number | boolean> = {
    "images.controller": controllerImage,
    "channelEgress.enabled": true,
    "channelEgress.listenerPortEnd": channelEgress.listenerPortEnd,
    "channelEgress.gatewayName": channelEgress.gatewayName,
    "channelEgress.gatewayClassName": gatewayClassName as string,
    "channelEgress.envoyNamespace": channelEgress.envoyNamespace,
    "channelEgress.serviceName": channelEgress.serviceName,
  };
  channelEgress.excludedCidrs.forEach((cidr, index) => {
    values[`channelEgress.excludedCidrs[${index}]`] = cidr;
  });
  const { stdout } = await renderProductionChart(values, { namespace, release });
  const items = (await parseProductionChart(stdout)).map(asRecord).filter((item) => {
    const metadata = asRecord(item?.metadata);
    return typeof metadata?.name === "string" && metadata.name.includes(channelEgress.gatewayName);
  });
  assert.ok(
    items.length >= 12,
    "the chart must provide fleet, denial, inspection, network and RBAC resources",
  );
  for (const item of items) {
    assert.ok(item);
    if (item.kind === "RoleBinding" && Array.isArray(item.subjects)) {
      for (const value of item.subjects) {
        const subject = asRecord(value);
        if (subject?.name === "openclaw-enterprise-worker") {
          subject.name = controller.account;
        }
        if (subject?.name === "openclaw-enterprise-api") {
          subject.name = controller.apiAccount;
        }
      }
    }
  }
  await applyManifest(JSON.stringify({ apiVersion: "v1", kind: "List", items }));
  await kubectl(
    "wait",
    "gateway",
    channelEgress.gatewayName,
    "--namespace",
    namespace,
    "--for=condition=Programmed",
    "--timeout=180s",
  );
  return { channelEgress };
}
