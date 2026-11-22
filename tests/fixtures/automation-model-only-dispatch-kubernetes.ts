import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createKubernetesClient,
  kubectlArguments,
  validateExplicitK3dLoopbackContext,
} from "../helpers/kubernetes-real.ts";
import { execute } from "../helpers/runtime-image-docker.ts";
import {
  assertDispatchReport,
  dispatchEffectsScript,
  prepareDispatchInputs,
  type DispatchProbe,
} from "./automation-model-only-dispatch-inputs.ts";

export async function runKubernetesAutomationDispatchProbe(
  t: TestContext,
  {
    selection,
    gatewayImage,
    agentImage,
    seccompProfile,
    probe,
  }: {
    selection: { kubeconfigPath: string; kubernetesContext: string };
    gatewayImage: string;
    agentImage: string;
    seccompProfile: string;
    probe: Exclude<DispatchProbe, "write">;
  },
) {
  await validateExplicitK3dLoopbackContext(selection);
  for (const image of [gatewayImage, agentImage]) {
    assert.match(image, /^\S+@sha256:[a-f0-9]{64}$/, "use the CI-imported immutable runtime");
  }
  assert.match(
    seccompProfile,
    /^openclaw\/[a-zA-Z0-9._-]+\.json$/,
    "use the prepared Codex Localhost profile",
  );
  const nonce = randomUUID();
  const namespace = `oce-dispatch-${nonce}`;
  const directory = await mkdtemp(join(tmpdir(), `${namespace}-`));
  const kubectl = async (...args: string[]) =>
    (
      await execute(process.env.OCC_KUBECTL_BIN ?? "kubectl", kubectlArguments(selection, args), {
        timeout: 130_000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
  const { applyManifest } = createKubernetesClient({ selection, kubectl });
  t.after(async () => {
    const present = await kubectl(
      "get",
      "namespace",
      namespace,
      "--ignore-not-found",
      "-o",
      "json",
    );
    if (present.trim()) {
      const observed = JSON.parse(present) as { metadata?: { labels?: Record<string, string> } };
      assert.equal(
        observed.metadata?.labels?.["openclaw.dev/probe-owner"],
        nonce,
        "delete only the namespace created by this probe",
      );
      await kubectl("delete", "namespace", namespace, "--wait=true", "--timeout=120s");
    }
    assert.equal(
      (await kubectl("get", "namespace", namespace, "--ignore-not-found", "-o", "json")).trim(),
      "",
      "owned namespace must be absent after cleanup",
    );
    // Preserve certificate/input material if namespace cleanup fails.
    await rm(directory, { recursive: true, force: true });
  });
  const input = await prepareDispatchInputs(directory, { nonce, harness: "codex", probe });
  const data: Record<string, string> = {};
  for (const file of [
    "ca.pem",
    "cert.pem",
    "key.pem",
    "input.json",
    "openclaw.json",
    ...input.fixtureFiles,
  ]) {
    data[file] = await readFile(join(directory, file), "utf8");
  }
  await applyManifest(
    JSON.stringify({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: namespace, labels: { "openclaw.dev/probe-owner": nonce } },
    }),
  );
  // All provider/transport traffic stays on Pod loopback. No provider fallback,
  // Kubernetes identity or external destination is available to either Harness.
  await applyManifest(
    JSON.stringify({
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { name: "deny-all", namespace },
      spec: { podSelector: {}, policyTypes: ["Ingress", "Egress"], ingress: [], egress: [] },
    }),
  );
  await applyManifest(
    JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "dispatch-fixture", namespace },
      data,
    }),
  );
  const restricted = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
  };
  const volumeNames = ["gateway-home", "gateway-tmp", "agent-home", "agent-tmp"];
  const mounts = (name: string) => [
    { name: "fixture", mountPath: "/fixture", readOnly: true },
    { name: `${name}-home`, mountPath: "/home/node", subPath: "private" },
    { name: `${name}-tmp`, mountPath: "/tmp", subPath: "private" },
  ];
  const agentEnvironment = {
    ...input.agentEnvironment,
    HOME: "/home/node",
    CODEX_HOME: "/home/node/.codex",
    CODEX_LOGIN_MODE: "api_key",
    OPENAI_API_KEY: input.dummyCredential,
    OPENCLAW_HARNESS_MODEL: "codex/gpt-5",
    APP_SERVER_TOKEN: input.transportToken,
    APP_SERVER_PORT: "18790",
    NODE_EXTRA_CA_CERTS: "/fixture/ca.pem",
    SSL_CERT_FILE: "/fixture/ca.pem",
    CODEX_CA_CERTIFICATE: "/fixture/ca.pem",
  };
  const resources = {
    requests: { cpu: "100m", memory: "512Mi" },
    limits: { cpu: "2", memory: "4Gi" },
  };
  await applyManifest(
    JSON.stringify({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "dispatch", namespace },
      spec: {
        restartPolicy: "Never",
        automountServiceAccountToken: false,
        terminationGracePeriodSeconds: 5,
        hostAliases: [{ ip: "127.0.0.1", hostnames: ["api.openai.com"] }],
        dnsPolicy: "None",
        dnsConfig: {
          nameservers: ["127.0.0.1"],
          options: [
            { name: "timeout", value: "1" },
            { name: "attempts", value: "1" },
          ],
        },
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
          sysctls: [{ name: "net.ipv4.ip_unprivileged_port_start", value: "0" }],
        },
        volumes: [
          { name: "fixture", configMap: { name: "dispatch-fixture" } },
          ...volumeNames.map((name) => ({ name, emptyDir: { sizeLimit: "1Gi" } })),
        ],
        // Match privateStateInitContainer: safe-temp checks require private children
        // of fsGroup-writable volume roots, initialized by the same non-root UID.
        initContainers: [
          {
            name: "prepare-private-state",
            image: gatewayImage,
            imagePullPolicy: "Never",
            command: [
              "node",
              "-e",
              `const fs=require("node:fs");for(const name of ${JSON.stringify(volumeNames)}){fs.mkdirSync("/setup/"+name+"/private",{mode:0o700});}`,
            ],
            securityContext: restricted,
            volumeMounts: volumeNames.map((name) => ({ name, mountPath: `/setup/${name}` })),
          },
        ],
        containers: [
          {
            name: "gateway",
            image: gatewayImage,
            imagePullPolicy: "Never",
            command: ["node", "/fixture/automation-model-only-dispatch-runtime.mjs"],
            securityContext: restricted,
            resources,
            volumeMounts: mounts("gateway"),
          },
          {
            name: "agent",
            image: agentImage,
            imagePullPolicy: "Never",
            command: ["node", "-e", ...input.agentEntrypoint],
            env: Object.entries(agentEnvironment).map(([name, value]) => ({ name, value })),
            securityContext: {
              ...restricted,
              seccompProfile: { type: "Localhost", localhostProfile: seccompProfile },
            },
            resources,
            volumeMounts: mounts("agent"),
          },
        ],
      },
    }),
  );
  await kubectl("wait", "-n", namespace, "pod/dispatch", "--for=condition=Ready", "--timeout=120s");
  let report: Record<string, unknown> | undefined;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const logs = await kubectl("logs", "-n", namespace, "dispatch", "-c", "gateway");
    for (const line of logs.split("\n")) {
      if (line.startsWith('{"kind":"supplemental-dispatch-projection')) {
        report = JSON.parse(line) as Record<string, unknown>;
      }
    }
    if (report) {
      break;
    }
    await delay(1500);
  }
  assertDispatchReport(report, "codex", probe);
  if (probe === "exec_command" || probe === "exec") {
    const effects = await kubectl(
      "exec",
      "-n",
      namespace,
      "dispatch",
      "-c",
      "agent",
      "--",
      "node",
      "-e",
      dispatchEffectsScript,
      "/home/node/workspace",
      nonce,
    );
    assert.deepEqual(
      JSON.parse(effects),
      { positiveMatches: true, negativeAbsent: true },
      JSON.stringify(report),
    );
  }
  await kubectl(
    "exec",
    "-n",
    namespace,
    "dispatch",
    "-c",
    "gateway",
    "--",
    "node",
    "-e",
    'require("node:fs").writeFileSync("/tmp/dispatch-proof-release", "done");',
  );
  t.diagnostic(
    JSON.stringify({
      ...report,
      ...(["exec_command", "exec"].includes(probe)
        ? { positiveFileEffect: true, negativeFileAbsent: true }
        : {}),
      gatewayImage,
      agentImage,
      placement:
        "same Pod loopback provider with separate Gateway/Codex filesystems; not separate-Pod workflow proof",
    }),
  );
}
