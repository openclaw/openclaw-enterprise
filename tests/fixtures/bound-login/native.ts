import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import {
  openshellHash,
  openShellGatewayNetworkPolicies,
  openShellChartImageValues,
} from "../../helpers/openshell-kubernetes-real.mjs";
import { nativeGatewayValues, type NativeGatewayTls } from "./native-gateway-values.ts";

type Run = (
  command: string,
  args: string[],
  options?: { input?: string; timeout?: number },
) => Promise<string>;

/** Installs the native supplier in the already prepared job cluster; final job cleanup owns it. */
export async function installNativeGateway(input: {
  namespace: string;
  directory: string;
  environment: NodeJS.ProcessEnv;
  run: Run;
  ca: string;
  tls: NativeGatewayTls;
}) {
  const { namespace, directory, environment: env, run, ca, tls } = input;
  const scope = [
    "--kubeconfig",
    env.OCC_TEST_KUBERNETES_KUBECONFIG!,
    "--context",
    env.OCC_TEST_KUBERNETES_CONTEXT!,
  ];
  const kubectl = (...args: string[]) => run("kubectl", [...scope, ...args]);
  const create = (object: unknown) =>
    run("kubectl", [...scope, "create", "-f", "-"], { input: JSON.stringify(object) });
  const instance = "openshell-" + openshellHash(namespace, 10);
  await kubectl(
    "label",
    "namespace",
    namespace,
    "openshell.ai/openclaw-workspace=true",
    "--overwrite",
  );
  const service = JSON.parse(
    await kubectl("get", "service", "kubernetes", "-n", "default", "-o", "json"),
  );
  const endpoints = JSON.parse(
    await kubectl("get", "endpoints", "kubernetes", "-n", "default", "-o", "json"),
  );
  const addresses = new Set<string>([service.spec.clusterIP]);
  for (const subset of endpoints.subsets ?? []) {
    for (const address of subset.addresses ?? []) {
      addresses.add(address.ip);
    }
  }
  await create(
    openShellGatewayNetworkPolicies(
      namespace,
      [...addresses].map((address) => ({
        ipBlock: { cidr: `${address}/${address.includes(":") ? 128 : 32}` },
      })),
    ),
  );
  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const keys = {
    "signing.pem": privateKey,
    "public.pem": publicKey,
    kid: `openshell-${openshellHash(namespace)}\n`,
  };
  for (const [name, value] of Object.entries(keys)) {
    await writeFile(join(directory, name), value, { mode: 0o600 });
  }
  await kubectl(
    "create",
    "secret",
    "generic",
    `${instance}-jwt-keys`,
    "-n",
    namespace,
    ...Object.keys(keys).map((name) => `--from-file=${name}=${join(directory, name)}`),
  );
  const helmScope = [
    "--namespace",
    namespace,
    "--kubeconfig",
    env.OCC_TEST_KUBERNETES_KUBECONFIG!,
    "--kube-context",
    env.OCC_TEST_KUBERNETES_CONTEXT!,
    "--wait",
    "--timeout",
    "240s",
  ];
  await run(env.OCC_TEST_OPENSHELL_HELM!, [
    "install",
    `${instance}-workspace`,
    env.OCC_TEST_OPENSHELL_WORKSPACE_HELM_CHART!,
    ...helmScope,
    `--set-string=fullnameOverride=${instance}-workspace`,
    "--set=gateway.allowDriverConfig=true",
    `--set-string=gateway.serviceAccount.name=${instance}`,
    `--set-string=gateway.serviceAccount.namespace=${namespace}`,
    `--set-string=gateway.networkPolicy.podSelector.app\\.kubernetes\\.io/instance=${instance}`,
  ]);
  const trust = "oce-gateway-extra-trust";
  await create({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: trust, namespace },
    data: { "ca.crt": [...rootCertificates, ca].join("\n") },
  });
  await run(env.OCC_TEST_OPENSHELL_HELM!, [
    "install",
    instance,
    env.OCC_TEST_OPENSHELL_HELM_CHART!,
    ...helmScope,
    `--set-string=fullnameOverride=${instance}`,
    "--set=pkiInitJob.enabled=false",
    ...nativeGatewayValues(tls),
    "--set=server.drivers.kubernetes.allowDriverConfig=true",
    '--set-json=gatewayConfig.openshell\\.drivers\\.kubernetes.allowed_pod_labels=["openclaw.dev/*","app.kubernetes.io/name","app.kubernetes.io/managed-by"]',
    "--set-string=server.drivers.kubernetes.workspaceMode=operator",
    "--set-string=server.drivers.kubernetes.operatorNamespaceLabel=openshell.ai/openclaw-workspace=true",
    "--set=workspaceResources.enabled=false",
    "--set=podSecurityContext.seccompProfile.type=RuntimeDefault",
    `--set-string=server.defaultRuntimeClassName=${env.OCC_TEST_OPENSHELL_RUNTIME_CLASS!}`,
    ...openShellChartImageValues("gateway.image", env.OCC_TEST_OPENSHELL_GATEWAY_IMAGE),
    ...openShellChartImageValues("sandboxRuntime.image", env.OCC_TEST_OPENSHELL_SANDBOX_IMAGE),
    ...openShellChartImageValues("supervisor.image", env.OCC_TEST_OPENSHELL_SUPERVISOR_IMAGE),
    `--set-string=server.extraVolumes[0].name=${trust}`,
    `--set-string=server.extraVolumes[0].configMap.name=${trust}`,
    `--set-string=server.extraVolumeMounts[0].name=${trust}`,
    "--set-string=server.extraVolumeMounts[0].mountPath=/etc/ssl/certs/ca-certificates.crt",
    "--set-string=server.extraVolumeMounts[0].subPath=ca.crt",
    "--set=server.extraVolumeMounts[0].readOnly=true",
  ]);
}
