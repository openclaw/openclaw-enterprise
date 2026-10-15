import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";
const { loadYaml } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "@kubernetes/client-node",
);
let helmSkip = false;
try {
  execFileSync(helm, ["version", "--short"], { cwd: repository, stdio: "ignore" });
} catch {
  helmSkip = "Install Helm, or set OCC_HELM_BIN, to verify rendered profile values.";
}

function baseInput(overrides = {}) {
  return {
    controlPlane: {
      releaseName: "oce",
      namespace: "openclaw-system",
      clusterName: "profile-qualification",
      controllerImage: `registry.example.invalid/openclaw-enterprise/controller@sha256:${digestA}`,
      authBaseUrl: "https://console.oce.example.internal",
      adminEmail: "admin@example.invalid",
      bootstrapPasswordClaimName: "occ-bootstrap-admin-password",
      apiClients: [{ namespace: "operator-tools", podLabels: { app: "occ-operator" } }],
      databaseCidrs: ["192.0.2.10/32"],
      clusterCidrs: ["192.0.2.11/32"],
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayClassName: "eg",
      gatewayApiKeySecretName: "occ-private-gateway-key",
      agentNativeAdminDomain: "agents.oce.example.internal",
      sharedCookieDomain: "oce.example.internal",
      gatewayTrustedProxyCidrs: ["192.0.2.12/32"],
      pluginStatusProxySourceCidrs: ["192.0.2.13/32"],
      nodeSelector: { "oce-role": "control" },
      metrics: {
        scraperNamespaceLabels: { name: "monitoring" },
        scraperPodLabels: { app: "prometheus" },
      },
    },
    runtime: {
      image: `registry.example.invalid/openclaw-enterprise/runtime@sha256:${digestB}`,
      gatewayStorageClassName: "occ-gateway-rwo",
      nodeSelector: { "oce-role": "agents" },
      gatewayNodeSelector: { "oce-role": "control" },
      transportSecretPrefix: "openclaw-agent-transport",
    },
    channels: {
      managedSlackProxy: true,
    },
    ...overrides,
  };
}

function codexInput(overrides = {}) {
  const input = baseInput();
  return {
    ...input,
    ...overrides,
    runtime: {
      ...input.runtime,
      codexSeccompProfile: "profiles/codex.json",
      ...(overrides.runtime ?? {}),
    },
    codex: {
      modelDiscoveryCidrs: ["192.0.2.20/32"],
      ...(overrides.codex ?? {}),
    },
  };
}

function render(
  profile,
  input,
  directory = mkdtempSync(join(tmpdir(), `oce-profile-${profile}-`)),
  root = repository,
  dnsServer,
) {
  const inputPath = join(directory, "input.json");
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  const dnsPreload = join(directory, "dns-preload.mjs");
  if (dnsServer !== undefined) {
    writeFileSync(
      dnsPreload,
      `import dns from "node:dns/promises"; dns.setServers([${JSON.stringify(dnsServer)}]);\n`,
    );
  }
  let summary;
  try {
    summary = execFileSync(
      process.execPath,
      [
        ...(dnsServer === undefined ? [] : ["--import", dnsPreload]),
        "scripts/render-installation-profile.mjs",
        "--profile",
        profile,
        "--input",
        inputPath,
        "--out-dir",
        directory,
      ],
      { cwd: root, encoding: "utf8" },
    );
  } catch (error) {
    error.profileRendererOutput = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    error.profileRendererDirectory = directory;
    throw error;
  }
  return {
    directory,
    summary: JSON.parse(summary),
    values: readFileSync(join(directory, "values.yaml"), "utf8"),
    installation: readFileSync(join(directory, "installation.yaml"), "utf8"),
    preflight: JSON.parse(readFileSync(join(directory, "preflight.json"), "utf8")),
  };
}

function helmTemplate(output, extraValueFiles = [], releaseName = "oce", extraArgs = []) {
  return execFileSync(
    helm,
    [
      "template",
      releaseName,
      "deploy/helm/openclaw-enterprise",
      "--namespace",
      "openclaw-system",
      "--values",
      join(output.directory, "values.yaml"),
      ...extraValueFiles.flatMap((path) => ["--values", path]),
      ...extraArgs,
    ],
    {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 2_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

test(
  "Codex profile pairs tokenless public GitHub reader and the revision's exact network peer",
  { skip: helmSkip },
  (t) => {
    const clusterIP = "10.43.0.19";
    const output = render(
      "codex",
      codexInput({
        publicGithubRead: { enabled: true, clusterIP, upstreamCidrs: ["192.0.2.20/32"] },
      }),
    );
    t.after(() => rmSync(output.directory, { recursive: true, force: true }));
    const compute = loadYaml(output.installation).drivers.compute.configuration;
    assert.equal(compute.network.publicGithubRead.address, clusterIP);
    assert.match(output.values, /publicGithubRead:\n {2}enabled: true/);
    assert.doesNotMatch(output.installation, /repositoryCredentials:|registryPath:|controlSocket:/);
    KubernetesComputeDriver.validateConfiguration(compute);
    const name = "openclaw-enterprise-public-github-read";
    const objects = helmTemplate(output)
      .split(/\n---\n/)
      .map((doc) => JSON.parse(JSON.stringify(loadYaml(doc))))
      .filter((doc) => doc.metadata?.name === name);
    const reader = objects.find(({ kind }) => kind === "Deployment").spec.template;
    const service = objects.find(({ kind }) => kind === "Service").spec;
    const policy = objects.find(({ kind }) => kind === "NetworkPolicy").spec;
    assert.equal(service.clusterIP, clusterIP);
    assert.equal(service.type, "ClusterIP");
    assert.deepEqual(service.selector, reader.metadata.labels);
    assert.deepEqual(policy.podSelector.matchLabels, service.selector);
    for (const [key, label] of Object.entries(compute.network.publicGithubRead.podLabels)) {
      assert.equal(
        reader.metadata.labels[key],
        label,
        "the Agent peer must select the actual reader",
      );
    }
    assert.equal(reader.spec.automountServiceAccountToken, false);
    assert.equal(reader.spec.volumes, undefined);
    assert.equal(reader.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(policy.egress.at(-1).to, [{ ipBlock: { cidr: "192.0.2.20/32" } }]);
    assert.deepEqual(policy.ingress[0].ports, [{ port: 8080, protocol: "TCP" }]);

    const ordinary = render("codex", codexInput(), output.directory);
    assert.equal(
      loadYaml(ordinary.installation).drivers.compute.configuration.network.publicGithubRead,
      undefined,
    );
    assert.ok(
      !helmTemplate(ordinary).includes(name),
      "the reader must not be installed by default",
    );
  },
);
