import { requireConfiguration } from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { fileTemporaryDirectory } from "../helpers/temporary-directory.mjs";
import { chartTooling, helmTemplate } from "../helpers/production-chart.mjs";
import { selfSigned } from "../helpers/certificates.mjs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";

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
  directory = fileTemporaryDirectory(`oce-profile-${profile}-`),
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

async function readerInput(overrides = {}) {
  const directory = fileTemporaryDirectory("oce-profile-reader-tls-");
  const tls = await selfSigned(directory);
  return codexInput({
    publicGithubRead: {
      enabled: true,
      clusterIP: "10.43.0.19",
      upstreamCidrs: ["192.0.2.20/32", "192.0.2.21/32"],
      installationId: "ins_public_reader",
      authorizationConfigMapName: "public-reader-authorizations",
      tlsSecretName: "public-reader-tls",
      caBundleFile: tls.certPath,
      ...overrides,
    },
  });
}

test(
  "Codex profile pairs authenticated HTTPS public GitHub reader and the revision's exact network peer",
  { skip: helmSkip },
  async () => {
    const clusterIP = "10.43.0.19";
    const input = await readerInput();
    const output = render("codex", input);
    const compute = loadYaml(output.installation).drivers.compute.configuration;
    assert.equal(compute.network.publicGithubRead.address, clusterIP);
    assert.match(output.values, /publicGithubRead:\n {2}enabled: true/);
    assert.doesNotMatch(output.installation, /repositoryCredentials:|registryPath:|controlSocket:/);
    requireConfiguration(KubernetesComputeDriver, compute);
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
    assert.deepEqual(loadYaml(output.values).publicGithubRead.policy, {
      mode: "repositories",
      repositories: [],
    });
    assert.equal(
      compute.network.publicGithubRead.installationId,
      input.publicGithubRead.installationId,
    );
    assert.equal(
      compute.network.publicGithubRead.authorizationConfigMapName,
      "public-reader-authorizations",
    );
    assert.equal(
      compute.network.publicGithubRead.caBundle,
      readFileSync(input.publicGithubRead.caBundleFile, "utf8"),
    );
    const container = reader.spec.containers[0];
    assert.deepEqual(service.ports, [{ name: "https", port: 8080, targetPort: "https" }]);
    assert.equal(container.readinessProbe.httpGet.scheme, "HTTPS");
    assert.deepEqual(Object.fromEntries(container.env.map(({ name, value }) => [name, value])), {
      PUBLIC_GITHUB_READ_TLS_CERT_FILE: "/etc/public-read/tls/tls.crt",
      PUBLIC_GITHUB_READ_TLS_KEY_FILE: "/etc/public-read/tls/tls.key",
      PUBLIC_GITHUB_READ_POLICY_FILE: "/etc/public-read/policy/policy.json",
      PUBLIC_GITHUB_READ_AUTHORIZATIONS_FILE: "/etc/public-read/authorizations/authorizations.json",
    });
    assert.deepEqual(
      reader.spec.volumes.filter(({ secret }) => secret).map(({ secret }) => secret.secretName),
      ["public-reader-tls"],
    );
    const registryMount = container.volumeMounts.find(({ name }) => name === "authorizations");
    assert.equal(
      registryMount.subPath,
      undefined,
      "whole-directory mount receives registry updates",
    );
    assert.equal(registryMount.readOnly, true);
    const allObjects = helmTemplate(output)
      .split(/\n---\n/)
      .map((document) => JSON.parse(JSON.stringify(loadYaml(document))));
    const registry = allObjects.find(
      ({ kind, metadata }) =>
        kind === "ConfigMap" && metadata.name === "public-reader-authorizations",
    );
    assert.equal(
      registry,
      undefined,
      "Helm must never render mutable authorization data or restore stale grants on upgrade",
    );
    const readerConfiguration = JSON.stringify(
      allObjects.filter(
        ({ kind, metadata }) => kind === "ConfigMap" && metadata.name.startsWith(name),
      ),
    );
    assert.doesNotMatch(readerConfiguration, /PRIVATE KEY|clientSecret|appKey|tokenSha256/);
    const supervisor = policy.ingress[0]._from.find(
      ({ podSelector }) => podSelector.matchLabels["openshell.ai/boundary-role"] === "supervisor",
    );
    assert.deepEqual(supervisor.podSelector.matchLabels, {
      "openshell.ai/boundary-role": "supervisor",
    });
    assert.ok(
      supervisor.namespaceSelector.matchExpressions.some(
        ({ key }) => key === "openclaw.dev/namespace",
      ),
    );
    const ordinaryPeer = policy.ingress[0]._from.find(
      ({ podSelector }) => podSelector.matchLabels["openclaw.dev/workload-role"] === "agent",
    );
    assert.equal(
      ordinaryPeer.podSelector.matchLabels["openclaw.dev/network-profile"],
      "broad-egress-v1",
    );
    const role = allObjects.find(
      ({ kind, metadata }) => kind === "Role" && metadata.name === `${name}-authorizations`,
    );
    assert.deepEqual(role.rules, [
      {
        apiGroups: [""],
        resources: ["configmaps"],
        resourceNames: ["public-reader-authorizations"],
        verbs: ["get", "update"],
      },
    ]);
    const roleBinding = allObjects.find(
      ({ kind, metadata }) => kind === "RoleBinding" && metadata.name === role.metadata.name,
    );
    assert.deepEqual(roleBinding.subjects.map(({ name }) => name).sort(), [
      "openclaw-enterprise-api",
      "openclaw-enterprise-worker",
    ]);
    const controlPeers = policy.ingress[0]._from.filter(({ podSelector }) =>
      ["api", "worker"].includes(podSelector.matchLabels["app.kubernetes.io/component"]),
    );
    assert.equal(controlPeers.length, 2, "controllers can observe the loaded registry digest");
    assert.equal(reader.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(policy.egress.at(-1).to, [
      { ipBlock: { cidr: "192.0.2.20/32" } },
      { ipBlock: { cidr: "192.0.2.21/32" } },
    ]);
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

test(
  "public reader profile and chart require verified TLS and validate all/list ceilings",
  { skip: helmSkip },
  async () => {
    const input = await readerInput();
    for (const policy of [
      { mode: "all" },
      { mode: "repositories", repositories: ["OpenClaw/Example"] },
    ]) {
      const output = render("codex", {
        ...input,
        publicGithubRead: { ...input.publicGithubRead, policy },
      });
      const ceiling = loadYaml(output.values).publicGithubRead.policy;
      assert.deepEqual(
        ceiling,
        policy.mode === "all"
          ? policy
          : { mode: "repositories", repositories: ["openclaw/example"] },
      );
      const objects = helmTemplate(output)
        .split(/\n---\n/)
        .map((document) => JSON.parse(JSON.stringify(loadYaml(document))));
      const configuration = objects.find(
        ({ kind, metadata }) =>
          kind === "ConfigMap" && metadata.name === "openclaw-enterprise-public-github-read-policy",
      );
      assert.deepEqual(JSON.parse(configuration.data["policy.json"]), ceiling);
    }
    for (const field of [
      "tlsSecretName",
      "installationId",
      "authorizationConfigMapName",
      "caBundleFile",
    ]) {
      const incomplete = { ...input.publicGithubRead };
      delete incomplete[field];
      assert.throws(
        () => render("codex", { ...input, publicGithubRead: incomplete }),
        (error) => error.profileRendererOutput.includes(field),
      );
    }
    for (const policy of [
      { mode: "all", repositories: [] },
      { mode: "repositories", repositories: ["bad/path/extra"] },
      { mode: "repositories", repositories: Array(257).fill("owner/repo") },
    ]) {
      assert.throws(
        () =>
          render("codex", { ...input, publicGithubRead: { ...input.publicGithubRead, policy } }),
        (error) => error.profileRendererOutput.includes("policy"),
      );
    }
    const output = render("codex", input);
    for (const setting of [
      "publicGithubRead.tlsSecretName=",
      "publicGithubRead.caBundle=",
      "publicGithubRead.installationId=",
      "publicGithubRead.authorizationConfigMapName=",
      "publicGithubRead.policy.mode=invalid",
      "publicGithubRead.policy.repositories[0]=owner/repo/extra",
    ]) {
      assert.throws(
        () => helmTemplate(output, [], "oce", ["--set", setting]),
        (error) => error.stderr.includes(setting.split("=")[0].split(".").slice(0, 2).join(".")),
      );
    }
    const relative = {
      ...input,
      publicGithubRead: {
        ...input.publicGithubRead,
        caBundleFile: basename(input.publicGithubRead.caBundleFile),
      },
    };
    assert.equal(
      render("codex", relative, dirname(input.publicGithubRead.caBundleFile)).summary.ok,
      true,
      "public CA paths resolve relative to the profile input",
    );
    const oversized = join(output.directory, "oversized-ca.pem");
    writeFileSync(oversized, readFileSync(input.publicGithubRead.caBundleFile, "utf8").repeat(200));
    assert.throws(
      () =>
        render("codex", {
          ...input,
          publicGithubRead: { ...input.publicGithubRead, caBundleFile: oversized },
        }),
      (error) => error.profileRendererOutput.includes("65 KiB"),
    );
    assert.throws(
      () => helmTemplate(output, [], "oce", ["--set", "publicGithubRead.tlsSecretName=occ-auth"]),
      (error) => error.stderr.includes("dedicated Secret"),
    );
    const privateInput = await readerInput();
    privateInput.publicGithubRead.caBundleFile = privateInput.publicGithubRead.caBundleFile.replace(
      /\.crt$/,
      ".key",
    );
    assert.throws(
      () => render("codex", privateInput),
      (error) => error.profileRendererOutput.includes("public PEM"),
    );
  },
);

test(
  "Helm upgrades leave mutable authorization outside the release and refuse another Installation",
  { skip: helmSkip },
  async (t) => {
    const input = await readerInput();
    const output = render("codex", input);
    const name = input.publicGithubRead.authorizationConfigMapName;
    const label = createHash("sha256")
      .update(input.publicGithubRead.installationId)
      .digest("hex")
      .slice(0, 32);
    let registry = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name,
        namespace: "openclaw-system",
        resourceVersion: "42",
        labels: { "openclaw.dev/public-read-installation": label },
      },
      data: {
        "authorizations.json":
          JSON.stringify({
            revision: { tokenSha256: "a".repeat(64), validUntil: "2030-01-01T00:00:00.000Z" },
          }) + "\n",
        "operator-note": "preserve",
      },
    };
    const discovery = new Map();
    for (const document of helmTemplate(output).split(/\n---\n/)) {
      const object = loadYaml(document);
      const resources = discovery.get(object.apiVersion) ?? new Map();
      resources.set(object.kind, {
        name: object.kind === "ConfigMap" ? "configmaps" : object.kind.toLowerCase() + "s",
        singularName: object.kind.toLowerCase(),
        namespaced: !object.kind.startsWith("Cluster"),
        kind: object.kind,
        verbs: ["get"],
      });
      discovery.set(object.apiVersion, resources);
    }
    const apiGroups = [...discovery.keys()]
      .filter((version) => version.includes("/"))
      .map((groupVersion) => {
        const [name, version] = groupVersion.split("/");
        return {
          name,
          versions: [{ groupVersion, version }],
          preferredVersion: { groupVersion, version },
        };
      });
    let registryReads = 0;
    const server = createServer((request, response) => {
      const path = new URL(request.url, "http://localhost").pathname;
      response.setHeader("Content-Type", "application/json");
      const groupVersion = path.startsWith("/apis/")
        ? path.slice(6)
        : path === "/api/v1"
          ? "v1"
          : undefined;
      if (discovery.has(groupVersion)) {
        response.end(
          JSON.stringify({
            kind: "APIResourceList",
            apiVersion: "v1",
            groupVersion,
            resources: [...discovery.get(groupVersion).values()],
          }),
        );
      } else if (path === `/api/v1/namespaces/openclaw-system/configmaps/${name}`) {
        registryReads++;
        response.end(JSON.stringify(registry));
      } else if (path === "/version") {
        response.end(JSON.stringify({ major: "1", minor: "35", gitVersion: "v1.35.0" }));
      } else if (path === "/api") {
        response.end(JSON.stringify({ kind: "APIVersions", apiVersion: "v1", versions: ["v1"] }));
      } else if (path === "/apis") {
        response.end(JSON.stringify({ kind: "APIGroupList", apiVersion: "v1", groups: apiGroups }));
      } else {
        response.statusCode = 404;
        response.end(
          JSON.stringify({
            kind: "Status",
            apiVersion: "v1",
            status: "Failure",
            reason: "NotFound",
            code: 404,
          }),
        );
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const renderUpgrade = () =>
      promisify(execFile)(
        helm,
        [
          "template",
          "oce",
          "deploy/helm/openclaw-enterprise",
          "--namespace",
          "openclaw-system",
          "--values",
          join(output.directory, "values.yaml"),
          "--is-upgrade",
          "--dry-run=server",
          "--validate",
          "--disable-openapi-validation",
          "--kubeconfig",
          "/dev/null",
          "--kube-apiserver",
          `http://127.0.0.1:${server.address().port}`,
        ],
        { cwd: repository, maxBuffer: 2_000_000 },
      );
    const { stdout } = await renderUpgrade();
    const retained = stdout
      .split(/\n---\n/)
      .map((document) => JSON.parse(JSON.stringify(loadYaml(document))))
      .find(({ kind, metadata }) => kind === "ConfigMap" && metadata.name === name);
    assert.equal(
      retained,
      undefined,
      "an upgrade must not render even a previously observed registry",
    );
    assert.ok(registryReads > 0, "Helm must read the current registry");
    registry.metadata.labels["openclaw.dev/public-read-installation"] = "other-installation";
    await assert.rejects(renderUpgrade(), /authorization ConfigMap ownership mismatch/);
  },
);

test("reader fixture waits for a current ready endpoint owned by its Service", async (t) => {
  const tooling = await chartTooling();
  if (tooling.skip) {
    t.skip(tooling.skip);
    return;
  }
  const { installPublicGithubReadFixture } = await import("../helpers/public-github-read-k3d.mjs");
  const serviceUid = "reader-service-uid";
  const podUid = "reader-pod-uid";
  let selector;
  let sliceReads = 0;
  const slice = (ownerUid, targetUid, endpoints = true) => ({
    metadata: { ownerReferences: [{ kind: "Service", uid: ownerUid }] },
    endpoints: endpoints
      ? [{ conditions: { ready: true }, targetRef: { kind: "Pod", uid: targetUid } }]
      : [],
  });
  const observations = [
    [],
    [slice(serviceUid, podUid, false)],
    [slice(serviceUid, "other-pod")],
    [slice("other-service", podUid)],
    [slice(serviceUid, podUid)],
  ];
  const applyManifest = async (raw) => {
    const manifest = JSON.parse(raw);
    if (manifest.kind === "Service") {
      assert.equal(manifest.spec.selector, undefined, "reservation must not add a stale selector");
    } else {
      selector = manifest.items.find((item) => item.kind === "Service").spec.selector;
    }
  };
  const kubectl = async (...args) => {
    if (args[0] === "rollout") {
      return "";
    }
    if (args[1] === "service") {
      return JSON.stringify({
        metadata: { uid: serviceUid },
        spec: { clusterIP: "10.43.0.19", ...(selector && { selector }) },
      });
    }
    if (args[1] === "pods") {
      return JSON.stringify({
        items: [
          {
            metadata: { uid: podUid },
            status: { conditions: [{ type: "Ready", status: "True" }] },
          },
        ],
      });
    }
    if (args[1] === "endpointslices") {
      return JSON.stringify({ items: observations[sliceReads++] });
    }
    throw new Error(`unexpected kubectl operation ${args[0]} ${args[1]}`);
  };
  const waitFor = async (_description, observe) => {
    for (let i = 0; i < observations.length; i++) {
      if (await observe()) {
        return;
      }
    }
    throw new Error("reader endpoint remained unavailable");
  };
  const reader = await installPublicGithubReadFixture({
    namespace: "oce-system",
    installationId: "ins_reader_fixture",
    controllerImage: `registry.example.invalid/controller@sha256:${digestA}`,
    kubectl,
    applyManifest,
    waitFor,
  });
  assert.equal(sliceReads, observations.length);
  assert.deepEqual(reader.peer.podLabels, selector);
  assert.equal(reader.peer.address, "10.43.0.19");
});
