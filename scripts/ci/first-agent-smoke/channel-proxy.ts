import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer, isIP, type Socket } from "node:net";
import { join } from "node:path";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";

import { asRecord } from "../../../packages/utils/src/objects.ts";
import { selfSigned, signedLeaf } from "../../../tests/helpers/certificates.ts";
import {
  agentPods,
  chatTurn,
  deployAgent,
  readyGateway,
  stopAgent,
  type CodexAdmission,
  type GatewayPod,
} from "./agents.ts";
import {
  log,
  minute,
  modelAddress,
  run,
  waitFor,
  waitForChannelProxyReadiness,
  type SmokeStep,
} from "./process.ts";
import { kubectl, modelEvents, wireField, type SmokeStack } from "./setup.ts";

interface Observation {
  authority: string;
  authenticated: boolean;
  forwarded: boolean;
}
interface ControlledProxy {
  url: string;
  address: string;
  port: number;
  authorization: string;
  observations: Observation[];
  active: () => number;
  reject: () => void;
  recover: () => void;
  replaceCertificate: (material: { key: string; cert: string }) => void;
  close: () => Promise<void>;
  unref: () => void;
}

async function bridgeAddress(stack: SmokeStack): Promise<string> {
  const { stdout } = await run("docker", ["network", "inspect", `k3d-${stack.state.cluster}`]);
  const value = JSON.parse(stdout)[0]?.IPAM?.Config?.[0]?.Gateway;
  assert.equal(isIP(value), 4, "the owned k3d bridge needs an IPv4 gateway");
  return value as string;
}

async function proxyServer(
  address: string,
  tls?: { key: string; cert: string },
): Promise<ControlledProxy> {
  const authorization = `Basic ${Buffer.from(`smoke:${randomBytes(24).toString("hex")}`).toString("base64")}`;
  const expected = Buffer.from(authorization);
  const observations: Observation[] = [];
  const sockets = new Set<Socket>();
  let accepting = true;
  const handle = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(15_000, () => socket.destroy());
    let buffered = Buffer.alloc(0);
    const receive = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 16 * 1024) {
        return socket.destroy();
      }
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        return;
      }
      socket.off("data", receive);
      const lines = buffered.subarray(0, end).toString("latin1").split("\r\n");
      const authority = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/.exec(lines.shift() ?? "")?.[1] ?? "";
      const header =
        lines
          .find((line) => /^proxy-authorization:/iu.test(line))
          ?.slice("proxy-authorization:".length)
          .trim() ?? "";
      const supplied = Buffer.from(header);
      const authenticated =
        supplied.length === expected.length && timingSafeEqual(supplied, expected);
      const observation = { authority, authenticated, forwarded: false };
      observations.push(observation);
      if (!authenticated || !accepting) {
        socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (!/^(?:slack\.com|wss-primary\.slack\.com):443$/iu.test(authority)) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const rest = buffered.subarray(end + 4);
      const upstream = connect(443, modelAddress);
      sockets.add(upstream);
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => {
        sockets.delete(upstream);
        socket.destroy();
      });
      upstream.on("error", () => socket.destroy());
      upstream.once("connect", () => {
        observation.forwarded = true;
        socket.setTimeout(0);
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        if (rest.length) {
          upstream.write(rest);
        }
        socket.pipe(upstream).pipe(socket);
      });
    };
    socket.on("data", receive);
  };
  const server = tls ? createTlsServer(tls, handle) : createServer(handle);
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const bound = server.address();
  assert.ok(bound && typeof bound !== "string");
  return {
    url: `${tls ? "https" : "http"}://${address}:${bound.port}`,
    address,
    port: bound.port,
    authorization,
    observations,
    active: () => sockets.size,
    reject: () => {
      accepting = false;
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    recover: () => {
      accepting = true;
    },
    replaceCertificate: (material) => {
      assert.ok("setSecureContext" in server, "certificate replacement needs a TLS proxy");
      (server as TlsServer).setSecureContext(material);
    },
    unref: () => {
      server.unref();
      for (const socket of sockets) {
        socket.unref();
      }
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Installation {
  drivers: { compute: { configuration: { runtime: { channelEgress: Record<string, unknown> } } } };
}
interface Values {
  channelEgress: Record<string, unknown>;
  controlPlane?: Record<string, unknown>;
}

async function kubectlPatch(stack: SmokeStack, args: string[], patch: unknown) {
  const path = join(stack.directory, `channel-proxy-patch-${randomUUID()}.json`);
  try {
    await writeFile(path, JSON.stringify(patch), { flag: "wx", mode: 0o600 });
    await kubectl(stack, [...args, `--patch-file=${path}`]);
  } finally {
    await rm(path, { force: true });
  }
}

async function configureInstallation(
  stack: SmokeStack,
  proxies: ControlledProxy[],
  ca: string,
  smokeStep: SmokeStep,
) {
  const valuesPath = join(stack.directory, "helm-values.json");
  const installationPath = join(stack.directory, "installation.yaml");
  const values = JSON.parse(await readFile(valuesPath, "utf8")) as Values;
  const installation = JSON.parse(
    (await run("yq", ["-o=json", ".", installationPath])).stdout,
  ) as Installation;
  const egress = installation.drivers.compute.configuration.runtime.channelEgress;
  assert.ok(
    egress && values.channelEgress.enabled === true,
    "Local Setup did not install managed channel egress",
  );
  const envoyNamespace = String(egress.envoyNamespace);
  const trust = { caSecretName: "smoke-channel-proxy-ca", caKey: "ca.pem" };
  await kubectl(stack, ["apply", "-f", "-"], {
    input: JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: trust.caSecretName, namespace: envoyNamespace },
      type: "Opaque",
      stringData: { [trust.caKey]: ca },
    }),
  });
  const upstreamProxies = proxies.map(({ url, address }) => ({
    url,
    addresses: [`${address}/32`],
  }));
  Object.assign(egress, { upstreamProxies, proxyTrust: trust });
  Object.assign(values.channelEgress, { upstreamProxies, proxyTrust: trust });
  const data = JSON.stringify(installation);
  await writeFile(installationPath, data, { mode: 0o600 });
  await kubectlPatch(
    stack,
    [
      "-n",
      stack.state.platformNamespace,
      "patch",
      "secret",
      "occ-installation-startup",
      "--type=merge",
    ],
    { stringData: { "installation.yaml": data } },
  );
  values.controlPlane = {
    ...values.controlPlane,
    installationChecksum: createHash("sha256").update(data).digest("hex"),
  };
  await writeFile(valuesPath, JSON.stringify(values), { mode: 0o600 });
  await smokeStep("channel-proxy-helm-wait", () =>
    run(
      "helm",
      [
        "upgrade",
        "openclaw-enterprise",
        "deploy/helm/openclaw-enterprise",
        "--namespace",
        stack.state.platformNamespace,
        "--kubeconfig",
        stack.kubeconfig,
        "--kube-context",
        stack.context,
        "-f",
        valuesPath,
        "--wait",
        "--timeout",
        "5m",
      ],
      { timeout: 6 * minute },
    ),
  );

  // Envoy Gateway reconciles its data-plane Deployment after Helm returns. Wait for
  // the new template and every live replica, including the CA Secret mount.
  const selector = [
    "app.kubernetes.io/component=proxy",
    "app.kubernetes.io/managed-by=envoy-gateway",
    `gateway.envoyproxy.io/owning-gateway-namespace=${String(egress.gatewayNamespace)}`,
    `gateway.envoyproxy.io/owning-gateway-name=${String(egress.gatewayName)}`,
  ].join(",");
  const hasTrust = (spec: Record<string, unknown>) => {
    const volumes = Array.isArray(spec.volumes) ? spec.volumes : [];
    const containers = Array.isArray(spec.containers) ? spec.containers : [];
    const volume = volumes
      .map(asRecord)
      .find((item) => asRecord(item?.secret)?.secretName === trust.caSecretName);
    return Boolean(
      volume &&
      containers
        .map(asRecord)
        .some((container) =>
          (Array.isArray(container?.volumeMounts) ? container.volumeMounts : [])
            .map(asRecord)
            .some(
              (mount) =>
                mount?.name === volume.name &&
                mount?.mountPath === "/etc/openclaw/channel-proxy-ca" &&
                mount?.readOnly === true,
            ),
        ),
    );
  };
  const envoyTrust = smokeStep("channel-proxy-envoy-trust-rollout", () =>
    waitFor(
      "channel Envoy data-plane trust rollout",
      async () => {
        const result = JSON.parse(
          (
            await kubectl(stack, [
              "-n",
              envoyNamespace,
              "get",
              "deployments,pods",
              "-l",
              selector,
              "-o",
              "json",
            ])
          ).stdout,
        ) as {
          items: {
            kind: string;
            metadata: { generation?: number; deletionTimestamp?: string };
            spec: Record<string, unknown>;
            status?: Record<string, unknown>;
          }[];
        };
        const deployments = result.items.filter((item) => item.kind === "Deployment");
        const pods = result.items.filter((item) => item.kind === "Pod");
        const desired = deployments.reduce(
          (total, item) => total + Number(item.spec.replicas ?? 1),
          0,
        );
        const deploymentsReady =
          deployments.length > 0 &&
          deployments.every((item) => {
            const status = item.status ?? {};
            const count = Number(item.spec.replicas ?? 1);
            return (
              Number(status.observedGeneration ?? 0) >= Number(item.metadata.generation ?? 1) &&
              Number(status.updatedReplicas ?? 0) === count &&
              Number(status.readyReplicas ?? 0) === count &&
              Number(status.replicas ?? 0) === count &&
              hasTrust(asRecord(asRecord(item.spec.template)?.spec) ?? {})
            );
          });
        const podsReady =
          pods.length === desired &&
          pods.every(
            (item) =>
              !item.metadata.deletionTimestamp &&
              hasTrust(item.spec) &&
              (Array.isArray(item.status?.conditions) ? item.status.conditions : [])
                .map(asRecord)
                .some((condition) => condition?.type === "Ready" && condition.status === "True"),
          );
        return {
          done: deploymentsReady && podsReady,
          state: { deployments: deployments.length, desired, pods: pods.length },
        };
      },
      4 * minute,
    ),
  );

  await waitForChannelProxyReadiness(envoyTrust, configureApiTrust(stack, ca, smokeStep));
}

async function configureApiTrust(stack: SmokeStack, ca: string, smokeStep: SmokeStep) {
  // The API keeps its ordinary Gateway CA and adds only the smoke provider's public CA.
  const current = (
    await kubectl(stack, [
      "-n",
      stack.state.platformNamespace,
      "exec",
      "deployment/openclaw-enterprise-api",
      "-c",
      "api",
      "--",
      "sh",
      "-c",
      'if [ -n "${NODE_EXTRA_CA_CERTS:-}" ]; then cat "$NODE_EXTRA_CA_CERTS"; fi',
    ])
  ).stdout;
  await kubectl(stack, ["apply", "-f", "-"], {
    input: JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "smoke-provider-ca", namespace: stack.state.platformNamespace },
      data: { "ca.pem": `${current.trim()}\n${ca.trim()}\n` },
    }),
  });
  const patch = {
    spec: {
      template: {
        spec: {
          volumes: [{ name: "smoke-provider-ca", configMap: { name: "smoke-provider-ca" } }],
          containers: [
            {
              name: "api",
              env: [
                { name: "NODE_EXTRA_CA_CERTS", value: "/etc/openclaw/smoke-provider-ca/ca.pem" },
              ],
              volumeMounts: [
                {
                  name: "smoke-provider-ca",
                  mountPath: "/etc/openclaw/smoke-provider-ca",
                  readOnly: true,
                },
              ],
            },
          ],
        },
      },
    },
  };
  await kubectlPatch(
    stack,
    [
      "-n",
      stack.state.platformNamespace,
      "patch",
      "deployment",
      "openclaw-enterprise-api",
      "--type=strategic",
    ],
    patch,
  );
  await smokeStep("channel-proxy-api-rollout", () =>
    kubectl(
      stack,
      [
        "-n",
        stack.state.platformNamespace,
        "rollout",
        "status",
        "deployment/openclaw-enterprise-api",
        "--timeout=180s",
      ],
      { timeout: 4 * minute },
    ),
  );
  // Deployment readiness does not mean the Local Setup NodePort has switched
  // from the retired Pod. Verify the same host path the smoke API client uses.
  let consecutive = 0;
  await smokeStep("channel-proxy-host-route-readiness", () =>
    waitFor(
      "Local Setup API host route after rollout",
      async () => {
        try {
          const response = await fetch(new URL("/readyz", stack.origin), {
            redirect: "error",
            headers: { connection: "close" },
            signal: AbortSignal.timeout(2_000),
          });
          await response.body?.cancel();
          consecutive = response.ok ? consecutive + 1 : 0;
          return { done: consecutive >= 2, state: { status: response.status, consecutive } };
        } catch (error) {
          consecutive = 0;
          return { done: false, state: { error: (error as Error).name } };
        }
      },
      2 * minute,
    ),
  );
}

async function grantSecret(
  stack: SmokeStack,
  admission: CodexAdmission,
  value: string,
  label: string,
) {
  const base = `/namespaces/${stack.namespaceId}`;
  const secret = await stack.api("POST", `${base}/secrets`, {
    name: `smoke-${label}-${randomUUID()}`,
    value,
  });
  const agent = await stack.api("GET", `${base}/agents/${admission.agent.id}`);
  const role = await stack.api("POST", `${base}/iam/roles`, {
    name: `Smoke ${label} ${randomUUID()}`,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  await stack.api("POST", `${base}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: wireField(agent, "servicePrincipalId"),
    roleId: wireField(role, "id"),
    resourceKind: "secret",
    resourceId: wireField(secret, "id"),
  });
  return { id: wireField(secret, "id") as string, ref: wireField(secret, "ref") };
}

function codexNetworkPolicy(configuration: unknown): unknown {
  const plugins = asRecord(asRecord(configuration)?.plugins);
  const entries = asRecord(plugins?.entries);
  const config = asRecord(asRecord(entries?.codex)?.config);
  return asRecord(config?.appServer)?.networkProxy;
}

async function enableSlack(
  stack: SmokeStack,
  admission: CodexAdmission,
  suffix: "a" | "b",
  proxy: ControlledProxy,
) {
  const base = `/namespaces/${stack.namespaceId}`;
  const configuration = (await stack.api(
    "GET",
    `${base}/configurations/${admission.configurationId}`,
  )) as { values: unknown; secretBindings?: Record<string, unknown> };
  const harnessPolicy = structuredClone(codexNetworkPolicy(configuration.values));
  const bindings = { ...configuration.secretBindings };
  let botSecretId = "";
  for (const [name, value] of [
    ["SLACK_APP_TOKEN", `xapp-1-smoke-${suffix}`],
    ["SLACK_BOT_TOKEN", `xoxb-smoke-${suffix}`],
  ]) {
    const secret = await grantSecret(stack, admission, value!, `${suffix}-${name!.toLowerCase()}`);
    if (name === "SLACK_BOT_TOKEN") {
      botSecretId = secret.id;
    }
    bindings[name!] = {
      source: { kind: "secret", namespaceId: stack.namespaceId, id: secret.id },
      delivery: { type: "env" },
    };
  }
  const values = asRecord(configuration.values);
  const plugins = asRecord(values?.plugins);
  const entries = asRecord(plugins?.entries);
  assert.ok(values && plugins && entries, "Codex Configuration has no plugin entries");
  plugins.allow = [...new Set([...(Array.isArray(plugins.allow) ? plugins.allow : []), "slack"])];
  entries.slack = { enabled: true };
  values.channels = {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      dmPolicy: "disabled",
      groupPolicy: "allowlist",
    },
  };
  await stack.api("PATCH", `${base}/configurations/${admission.configurationId}`, {
    values,
    secretBindings: bindings,
  });
  const credential = await grantSecret(stack, admission, proxy.authorization, `${suffix}-proxy`);
  await stack.api("PATCH", `${base}/agents/${admission.agent.id}`, {
    networkProxy: { url: proxy.url, credentialSecretId: credential.id },
  });
  return { credential, botSecretId, harnessPolicy };
}

async function rawConnect(
  stack: SmokeStack,
  gateway: GatewayPod,
  authority: string,
): Promise<number> {
  const script = String.raw`const n=require('node:net');const p=new URL(process.env.HTTPS_PROXY);const a=process.argv[1];const s=n.connect(Number(p.port),p.hostname,()=>s.write('CONNECT '+a+' HTTP/1.1\r\nHost: '+a+'\r\n\r\n'));let b='';s.setTimeout(10000,()=>s.destroy());s.on('data',x=>{b+=x;const m=/^HTTP\/1\.[01] (\d+)/.exec(b);if(m){console.log(m[1]);s.destroy()}});s.on('error',()=>process.exitCode=2);`;
  const { stdout } = await kubectl(
    stack,
    [
      "-n",
      gateway.namespace,
      "exec",
      gateway.pod,
      "-c",
      "gateway",
      "--",
      "node",
      "-e",
      script,
      authority,
    ],
    { timeout: 20_000 },
  );
  return Number(stdout.trim());
}

function proxyCounts(proxies: ControlledProxy[]): number[] {
  return proxies.map((proxy) => proxy.observations.length);
}

async function providerConnections(): Promise<number> {
  return (await modelEvents()).filter((event) => event.event === "connection").length;
}

async function managedProxy(stack: SmokeStack, gateway: GatewayPod): Promise<URL> {
  const { stdout } = await kubectl(stack, [
    "-n",
    gateway.namespace,
    "exec",
    gateway.pod,
    "-c",
    "gateway",
    "--",
    "node",
    "-p",
    "process.env.HTTPS_PROXY",
  ]);
  return new URL(stdout.trim());
}

async function deniedTcp(stack: SmokeStack, gateway: GatewayPod, host: string, port: number) {
  const script = `const net=require("node:net");const s=net.connect(Number(process.argv[2]),process.argv[1]);s.setTimeout(2000);s.once("connect",()=>{console.log("connected");s.destroy()});s.once("timeout",()=>{console.log("denied");s.destroy()});s.once("error",()=>console.log("denied"));`;
  const { stdout } = await kubectl(
    stack,
    [
      "-n",
      gateway.namespace,
      "exec",
      gateway.pod,
      "-c",
      "gateway",
      "--",
      "node",
      "-e",
      script,
      host,
      String(port),
    ],
    { timeout: 10_000 },
  );
  assert.equal(stdout.trim(), "denied", `Gateway unexpectedly connected to ${host}:${port}`);
}

async function socketCount(caller: string): Promise<number> {
  return (await modelEvents()).filter(
    (event) => event.event === "slack-socket" && event.caller === caller,
  ).length;
}

async function waitSocket(caller: string, previous = 0) {
  await waitFor(
    `controlled Slack Socket Mode ${caller}`,
    async () => ({ done: (await socketCount(caller)) > previous }),
    3 * minute,
  );
}

async function agentAuditRows(stack: SmokeStack, agentId: string): Promise<unknown[]> {
  assert.match(stack.namespaceId, /^ns_[a-f0-9-]+$/u);
  assert.match(agentId, /^agt_[a-f0-9-]+$/u);
  // The public audit endpoint requires a human session. Inspect the persisted
  // rows through the disposable PostgreSQL Pod's local socket instead.
  const sql = `SELECT coalesce(json_agg(to_jsonb(event)), '[]'::json)
    FROM occ.audit_events AS event
    WHERE namespace_id = '${stack.namespaceId}'
      AND (resource_id = '${agentId}' OR details->>'agentId' = '${agentId}');`;
  const { stdout } = await kubectl(
    stack,
    [
      "-n",
      stack.state.platformNamespace,
      "exec",
      "-i",
      "postgres-0",
      "-c",
      "postgres",
      "--",
      "sh",
      "-c",
      'exec psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d "$POSTGRES_DB"',
    ],
    { input: sql },
  );
  const rows: unknown = JSON.parse(stdout);
  assert.ok(Array.isArray(rows) && rows.length > 0, "Agent audit rows are missing");
  return rows;
}

async function containment(
  stack: SmokeStack,
  admission: CodexAdmission,
  revisionId: string,
  credentials: string[],
  harnessPolicy: unknown,
) {
  const credentialForms = credentials.flatMap((value) => {
    const token = value.replace(/^Basic /u, "");
    const decoded = Buffer.from(token, "base64").toString("utf8");
    const password = decoded.slice(decoded.indexOf(":") + 1);
    return [value, Buffer.from(value).toString("base64"), token, decoded, password];
  });
  const base = `/namespaces/${stack.namespaceId}/agents/${admission.agent.id}`;
  const gateway = await readyGateway(stack, admission.agent.id, revisionId);
  const pods = await agentPods(stack, admission.agent.id);
  const harness = pods.find(
    (pod) => pod.metadata.labels?.["openclaw.dev/workload-role"] === "agent",
  );
  assert.ok(harness, "dedicated Harness Pod is missing");
  const [
    agent,
    revision,
    audit,
    inspection,
    publicLogs,
    gatewayPod,
    harnessPod,
    gatewayLog,
    policies,
  ] = await Promise.all([
    stack.api("GET", base),
    stack.api("GET", `${base}/revisions/${revisionId}`),
    agentAuditRows(stack, admission.agent.id),
    stack.api("GET", `${base}/deployments/${revisionId}/runtime`),
    stack.api("GET", `${base}/deployments/${revisionId}/runtime/logs?source=gateway`),
    kubectl(stack, ["-n", gateway.namespace, "get", "pod", gateway.pod, "-o", "json"]),
    kubectl(stack, [
      "-n",
      harness.metadata.namespace,
      "get",
      "pod",
      harness.metadata.name,
      "-o",
      "json",
    ]),
    kubectl(stack, ["-n", gateway.namespace, "logs", gateway.pod, "-c", "gateway"]),
    kubectl(stack, ["-n", gateway.namespace, "get", "networkpolicy", "-o", "json"]),
  ]);
  for (const text of [
    JSON.stringify(agent),
    JSON.stringify(revision),
    JSON.stringify(audit),
    JSON.stringify(inspection),
    JSON.stringify(publicLogs),
    gatewayPod.stdout,
    harnessPod.stdout,
    gatewayLog.stdout,
  ]) {
    for (const credential of credentialForms) {
      assert.ok(
        !text.includes(credential),
        "proxy credential escaped its Envoy-only delivery boundary",
      );
    }
  }
  assert.deepEqual(
    codexNetworkPolicy(wireField(revision, "configuration")),
    harnessPolicy,
    "channel proxy changed the Harness network policy",
  );
  const harnessData = JSON.parse(harnessPod.stdout);
  const env = harnessData.spec.containers.flatMap(
    (container: { env?: { name: string; value?: string }[] }) => container.env ?? [],
  );
  assert.ok(
    !env.some((item: { name: string }) => item.name === "HTTPS_PROXY"),
    "Gateway channel proxy was injected into the Harness",
  );
  const policyList = JSON.parse(policies.stdout) as {
    items: { spec: { podSelector?: { matchLabels?: Record<string, string> } } }[];
  };
  const selected = policyList.items.filter(
    (policy) => policy.spec.podSelector?.matchLabels?.["openclaw.dev/workload-role"] === "agent",
  );
  for (const policy of selected) {
    assert.ok(
      !JSON.stringify(policy.spec).includes("channel-egress"),
      "Harness acquired a channel proxy grant",
    );
  }
  return gateway;
}

export async function proveControlledChannelProxy(
  stack: SmokeStack,
  admissions: [CodexAdmission, CodexAdmission],
  modelDirectory: string,
  smokeStep: SmokeStep,
) {
  const address = await bridgeAddress(stack);
  const ca = await readFile(join(modelDirectory, "ca.pem"), "utf8");
  const material = await signedLeaf(
    modelDirectory,
    { caPath: join(modelDirectory, "ca.pem"), caKeyPath: join(modelDirectory, "ca-key.pem") },
    { name: "channel-proxy", commonName: address, subjectAltName: `IP:${address}` },
  );
  const wrong = await signedLeaf(
    modelDirectory,
    { caPath: join(modelDirectory, "ca.pem"), caKeyPath: join(modelDirectory, "ca-key.pem") },
    {
      name: "channel-proxy-wrong",
      commonName: "wrong.invalid",
      subjectAltName: "DNS:wrong.invalid",
    },
  );
  const untrusted = await selfSigned(modelDirectory, {
    name: "channel-proxy-untrusted",
    commonName: address,
    subjectAltName: `IP:${address}`,
  });
  const http = await proxyServer(address);
  const https = await proxyServer(address, material);
  const bad = await proxyServer(address, wrong);
  const proxies = [http, https, bad];
  let scenarioError: unknown;
  let scenarioFailed = false;
  try {
    await configureInstallation(stack, proxies, ca, smokeStep);
    const [a, b] = admissions;
    const [aSetup, bSetup] = await Promise.all([
      enableSlack(stack, a, "a", http),
      enableSlack(stack, b, "b", https),
    ]);
    const [aRevision, bRevision] = await smokeStep("channel-proxy-initial-deploy", () =>
      Promise.all([
        deployAgent(stack, a.agent, { smokeStep, context: "channel-proxy-initial-deploy-a" }),
        deployAgent(stack, b.agent, { smokeStep, context: "channel-proxy-initial-deploy-b" }),
      ]),
    );
    await Promise.all([waitSocket("A"), waitSocket("B")]);
    const admissionEvents = await modelEvents();
    for (const caller of ["A", "B"]) {
      const peers = new Set(
        admissionEvents
          .filter(
            (event) =>
              event.event === "slack-api" &&
              event.method === "auth.test" &&
              event.caller === caller,
          )
          .map((event) => event.peer)
          .filter(Boolean),
      );
      assert.ok(
        peers.size >= 2,
        `${caller}: OCC validation and Gateway traffic did not use independent routes`,
      );
    }
    assert.ok(
      http.observations.some((item) => item.forwarded && item.authenticated),
      "HTTP proxy saw no authenticated Gateway tunnel",
    );
    assert.ok(
      https.observations.some((item) => item.forwarded && item.authenticated),
      "HTTPS/private-CA proxy saw no authenticated Gateway tunnel",
    );
    assert.ok(
      [...http.observations, ...https.observations].every((item) => item.authenticated),
      "a proxy received an unauthenticated CONNECT",
    );
    const [aGateway, bGateway] = await Promise.all([
      containment(
        stack,
        a,
        aRevision,
        proxies.map((proxy) => proxy.authorization),
        aSetup.harnessPolicy,
      ),
      containment(
        stack,
        b,
        bRevision,
        proxies.map((proxy) => proxy.authorization),
        bSetup.harnessPolicy,
      ),
    ]);
    const deniedAuthorities = [
      "example.org:443",
      "169.254.169.254:443",
      "10.0.0.1:443",
      "0xa.0x.0x.1:443",
      "slack.com:80",
    ];
    const deniedObservations = () =>
      proxies.map(
        (proxy) =>
          proxy.observations.filter((item) => deniedAuthorities.includes(item.authority)).length,
      );
    const before = deniedObservations();
    const peerListener = await managedProxy(stack, bGateway);
    const tcpDenials = await Promise.allSettled([
      deniedTcp(stack, aGateway, peerListener.hostname, Number(peerListener.port)),
      deniedTcp(stack, aGateway, modelAddress, 443),
    ]);
    for (const denial of tcpDenials) {
      if (denial.status === "rejected") {
        throw denial.reason;
      }
    }
    for (const authority of deniedAuthorities) {
      assert.equal(
        await rawConnect(stack, aGateway, authority),
        403,
        `Envoy accepted forbidden ${authority}`,
      );
    }
    assert.deepEqual(deniedObservations(), before, "a denied route reached an upstream proxy");
    const beforeModel = proxyCounts(proxies);
    await chatTurn(stack, a.agent, aRevision);
    assert.deepEqual(proxyCounts(proxies), beforeModel, "Harness model turn used a channel proxy");

    const beforeDirectory = proxyCounts(proxies);
    const directory = await stack.api(
      "POST",
      `/namespaces/${stack.namespaceId}/channel-directory/lookup`,
      {
        secretId: aSetup.botSecretId,
        kind: "channels",
        query: "smoke",
        agentId: a.agent.id,
      },
    );
    assert.ok(
      JSON.stringify(directory).includes("CSMOKE"),
      "OCC directory did not use the independent managed route",
    );
    assert.deepEqual(proxyCounts(proxies), beforeDirectory, "OCC directory used an Agent proxy");

    const bSockets = await socketCount("B");
    https.reject();
    const providerBefore407 = await providerConnections();
    const otherProxiesBefore407 = [http.observations.length, bad.observations.length];
    assert.equal(
      await rawConnect(stack, bGateway, "slack.com:443"),
      407,
      "proxy authentication failure did not reach the Gateway",
    );
    assert.equal(await providerConnections(), providerBefore407, "407 fell back to the provider");
    assert.deepEqual(
      [http.observations.length, bad.observations.length],
      otherProxiesBefore407,
      "407 fell back to another proxy",
    );
    assert.equal(
      await rawConnect(stack, aGateway, "slack.com:443"),
      200,
      "peer Agent failed during the other proxy's outage",
    );
    https.recover();
    await waitSocket("B", bSockets);

    const base = `/namespaces/${stack.namespaceId}/agents/${a.agent.id}`;
    const moved = await grantSecret(stack, a, https.authorization, "a-moved-proxy");
    const runningRevision = await stack.api("GET", `${base}/revisions/${aRevision}`);
    await stack.api("PATCH", base, {
      networkProxy: { url: https.url, credentialSecretId: moved.id },
    });
    const edited = await stack.api("GET", base);
    assert.equal(wireField(edited, "activeRevisionId"), aRevision);
    assert.deepEqual(
      await stack.api("GET", `${base}/revisions/${aRevision}`),
      runningRevision,
      "editing the Agent changed its running revision configuration",
    );
    assert.deepEqual(
      await readyGateway(stack, a.agent.id, aRevision),
      aGateway,
      "editing the Agent replaced its running Gateway before redeploy",
    );
    const movedRevision = await smokeStep("channel-proxy-move-deploy", () =>
      deployAgent(stack, a.agent, { smokeStep, context: "channel-proxy-move-deploy-a" }),
    );
    assert.notEqual(movedRevision, aRevision, "proxy edit did not create a new revision");
    await waitFor(
      "old HTTP proxy tunnels to retire",
      async () => ({ done: http.active() === 0 }),
      minute,
    );
    const movedGateway = await readyGateway(stack, a.agent.id, movedRevision);
    assert.equal(await rawConnect(stack, movedGateway, "slack.com:443"), 200);

    await stack.api("PATCH", base, { networkProxy: null });
    const aSocketsBeforeClear = await socketCount("A");
    const proxiesBeforeClear = proxyCounts(proxies);
    const directRevision = await smokeStep("channel-proxy-clear-deploy", () =>
      deployAgent(stack, a.agent, { smokeStep, context: "channel-proxy-clear-deploy-a" }),
    );
    await waitSocket("A", aSocketsBeforeClear);
    assert.deepEqual(
      proxyCounts(proxies),
      proxiesBeforeClear,
      "cleared selection contacted an upstream proxy",
    );
    const directGateway = await readyGateway(stack, a.agent.id, directRevision);
    assert.equal(
      await rawConnect(stack, directGateway, "slack.com:443"),
      200,
      "cleared selection did not restore managed direct routing",
    );
    assert.deepEqual(
      proxyCounts(proxies),
      proxiesBeforeClear,
      "cleared selection contacted an upstream proxy during the direct CONNECT check",
    );

    const badCredential = await grantSecret(stack, a, bad.authorization, "a-bad-cert");
    await stack.api("PATCH", base, {
      networkProxy: { url: bad.url, credentialSecretId: badCredential.id },
    });
    const badRevision = await smokeStep("channel-proxy-tls-control-deploy", () =>
      deployAgent(stack, a.agent, { smokeStep, context: "channel-proxy-tls-control-deploy-a" }),
    );
    const badGateway = await readyGateway(stack, a.agent.id, badRevision);
    assert.equal(
      await rawConnect(stack, badGateway, "slack.com:443"),
      503,
      "wrong-host proxy certificate did not fail closed",
    );
    assert.equal(
      bad.observations.length,
      0,
      "credential-bearing CONNECT reached a wrong-host proxy",
    );
    bad.replaceCertificate(untrusted);
    assert.equal(
      await rawConnect(stack, badGateway, "slack.com:443"),
      503,
      "untrusted proxy certificate did not fail closed",
    );
    assert.equal(
      bad.observations.length,
      0,
      "credential-bearing CONNECT reached an untrusted proxy",
    );

    // Restore trust on the same endpoint and verify the existing revision can use it.
    bad.replaceCertificate(material);
    assert.equal(
      await rawConnect(stack, badGateway, "slack.com:443"),
      200,
      "trusted certificate did not restore CONNECT on the same proxy endpoint",
    );
    assert.ok(
      bad.observations.some(
        (item) => item.authority === "slack.com:443" && item.authenticated && item.forwarded,
      ),
      "trusted proxy saw no authenticated forwarded tunnel after certificate replacement",
    );
    log(
      "controlled channel proxy: two dedicated Agents, HTTP/HTTPS private CA, policy denials, OCC isolation, 407 recovery, revision edit/clear, wrong-host/untrusted TLS refusal and trusted recovery, credential containment passed",
    );
  } catch (error) {
    scenarioError = error;
    scenarioFailed = true;
  }
  const failures: unknown[] = [];
  const stops = await Promise.allSettled(admissions.map(({ agent }) => stopAgent(stack, agent)));
  for (const result of stops) {
    if (result.status === "rejected") {
      failures.push(result.reason);
    }
  }
  const remaining = await Promise.allSettled(
    admissions.map(({ agent }) => agentPods(stack, agent.id, { includeTerminating: true })),
  );
  const shutdown = remaining.every(
    (result) =>
      result.status === "fulfilled" &&
      result.value.every(
        (pod) => pod.metadata.labels?.["openclaw.dev/workload-role"] !== "gateway",
      ),
  );
  for (const result of remaining) {
    if (result.status === "rejected") {
      failures.push(result.reason);
    }
  }
  if (shutdown) {
    const closes = await Promise.allSettled(proxies.map((proxy) => proxy.close()));
    for (const result of closes) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    }
  } else {
    failures.push(
      new Error("Gateway shutdown could not be verified; proxy services were left running"),
    );
    for (const proxy of proxies) {
      proxy.unref();
    }
  }
  if (scenarioFailed) {
    if (failures.length > 0) {
      log(
        `controlled channel proxy cleanup had ${failures.length} failure(s); preserving the scenario error`,
      );
    }
    throw scenarioError;
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "controlled channel proxy cleanup failed");
  }
}
