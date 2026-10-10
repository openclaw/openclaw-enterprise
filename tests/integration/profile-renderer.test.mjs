import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  loadInstallationConfiguration,
  loadStartupConfigurationSnapshot,
} from "../../apps/controller/src/composition/installation-config.ts";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const digestD = "d".repeat(64);
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

function managedCodexInput(overrides = {}) {
  return codexInput({
    ...overrides,
    codex: {
      managedServiceAccounts: {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        adminSecretName: "occ-chatgpt-admin",
        adminSecretKey: "admin-key",
        providerCidr: "192.0.2.21/32",
      },
      ...(overrides.codex ?? {}),
    },
  });
}

function repositoryConfiguration(upstreamCidrs = ["192.0.2.30/32"]) {
  return {
    enabled: true,
    image: `registry.example.invalid/openclaw-enterprise/repository-credentials@sha256:${digestC}`,
    backendId: "github-primary",
    registryConfigMapName: "occ-repository-registry-v1",
    serviceConfigSecretName: "occ-repository-service-config",
    appKeySecretName: "occ-repository-app-key",
    tlsSecretName: "occ-repository-tls",
    publicCaSecretName: "occ-repository-public-ca",
    upstreamCidrs,
  };
}

function render(
  profile,
  input,
  directory = mkdtempSync(join(tmpdir(), `oce-profile-${profile}-`)),
  root = repository,
) {
  const inputPath = join(directory, "input.json");
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  let summary;
  try {
    summary = execFileSync(
      process.execPath,
      [
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

function deploymentChecksum(manifests, component) {
  const document = manifests
    .split(/\n---\n/)
    .find(
      (entry) =>
        entry.includes("kind: Deployment") &&
        entry.includes(`app.kubernetes.io/component: ${component}`),
    );
  assert.ok(document, `expected ${component} Deployment in Helm output`);
  const match = document.match(/openclaw\.dev\/installation-checksum: "([a-f0-9]{64})"/);
  assert.ok(match, `expected ${component} installation checksum annotation`);
  return match[1];
}

function renderError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail("expected the profile renderer to reject the input");
}

function assertPreflightFailure(profile, input, expected) {
  const error = renderError(() => render(profile, input));
  assert.match(error.profileRendererOutput, expected);
  const directory = error.profileRendererDirectory;
  assert.equal(existsSync(join(directory, "preflight.json")), true);
  assert.equal(existsSync(join(directory, "values.yaml")), false);
  assert.equal(existsSync(join(directory, "installation.yaml")), false);
  const preflight = JSON.parse(readFileSync(join(directory, "preflight.json"), "utf8"));
  assert.equal(preflight.ok, false);
  assert.match(preflight.errors.join("\n"), expected);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// Sets `field`, a dotted path into a copy of `input`, to each value in turn and expects
// assertPreflightFailure to pass. A string message is the refusal text after the field name.
// A failure names the field and the value.
function assertFieldRefusals(profile, input, field, values, message) {
  const expected =
    typeof message === "string" ? new RegExp(escapeRegExp(`${field} ${message}`)) : message;
  const keys = field.split(".");
  for (const value of values) {
    const changed = structuredClone(input);
    const parent = keys.slice(0, -1).reduce((object, key) => (object[key] ??= {}), changed);
    parent[keys.at(-1)] = value;
    try {
      assertPreflightFailure(profile, changed, expected);
    } catch (error) {
      // The reporter prints error.stack, captured with the old message, so prefix both.
      const label = `${profile} ${field} = ${JSON.stringify(value)}: `;
      error.message = `${label}${error.message}`;
      error.stack = `${label}${error.stack}`;
      throw error;
    }
  }
}

test("renderer supports exactly the openclaw and codex profiles", () => {
  const openclaw = render("openclaw", baseInput());
  assert.equal(openclaw.summary.ok, true);
  assert.equal(openclaw.preflight.profile, "openclaw");
  assert.match(openclaw.installation, /id: occ-plugin/);
  assert.doesNotMatch(openclaw.installation, /id: codex-plugin/);
  assert.match(openclaw.values, /agentNativeAdmin:\n {2}enabled: true/);
  assert.match(openclaw.values, /repositoryCredentials:\n {2}enabled: false/);
  assert.match(openclaw.values, /slackProxy:\n {2}enabled: true/);
  assert.match(
    openclaw.installation,
    /channels:\n\s+proxyUrl: http:\/\/openclaw-enterprise-slack-proxy\.openclaw-system\.svc:3128/,
  );
  assert.match(
    openclaw.installation,
    /managedProxy:\n\s+hostname: openclaw-enterprise-slack-proxy\.openclaw-system\.svc/,
  );
  assert.match(openclaw.installation, /app\.kubernetes\.io\/component: slack-proxy/);

  const codex = render("codex", codexInput());
  assert.equal(codex.summary.ok, true);
  assert.equal(codex.preflight.profile, "codex");
  assert.match(codex.installation, /id: codex-plugin/);
  assert.match(codex.installation, /catalogSource: hosted/);
  assert.doesNotMatch(codex.installation, /service_account: chatgpt-service-accounts/);
  assert.match(codex.values, /slackProxy:\n {2}enabled: true/);
  assert.match(
    codex.installation,
    /channels:\n\s+proxyUrl: http:\/\/openclaw-enterprise-slack-proxy\.openclaw-system\.svc:3128/,
  );
  assert.match(codex.preflight.prerequisites.join("\n"), /Slack consumers remain inactive/);
  assert.match(codex.preflight.warnings.join("\n"), /existing codex_pat token/);
});

// Tenant runtimes may burst to four cores; 100m requests keep the scheduling
// reservation unchanged. The production example carries the same values.
const containerDefaultResources = {
  requests: { cpu: "100m", memory: "128Mi" },
  limits: { cpu: "4", memory: "2Gi" },
};
// Memory requests cover measured use between turns and limits cover measured
// peaks (see the renderer): Gateways hold 1.2-1.6 GiB and peak at 2.2 GiB; a
// Codex Harness holds about 0.5 GiB and reached a 4 GiB limit building and testing.
const gatewayResources = {
  requests: { cpu: "100m", memory: "1792Mi" },
  limits: { cpu: "4", memory: "3Gi" },
};
const harnessResources = {
  requests: { cpu: "100m", memory: "768Mi" },
  limits: { cpu: "4", memory: "6Gi" },
};

test("preflight rejects noncanonical SHA-256 image digests", (t) => {
  for (const profile of ["openclaw", "codex"]) {
    const input = profile === "codex" ? codexInput() : baseInput();
    input.repository = repositoryConfiguration();
    const directory = mkdtempSync(join(tmpdir(), "oce-profile-digest-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const [section, key] of [
      ["controlPlane", "controllerImage"],
      ["runtime", "image"],
      ["repository", "image"],
    ]) {
      const image = input[section][key];
      for (const invalid of [
        image.replace(/(?<=:)[a-f0-9]{64}$/, (digest) => digest.toUpperCase()),
        image.replace("@sha256:", "@SHA256:"),
      ]) {
        // A failed rerender must revoke the previously successful artifacts.
        assert.equal(render(profile, input, directory).preflight.ok, true);
        const changed = structuredClone(input);
        changed[section][key] = invalid;
        const error = renderError(() => render(profile, changed, directory));
        assert.match(
          error.profileRendererOutput,
          /immutable image reference with a SHA-256 digest/,
        );
        const preflight = JSON.parse(readFileSync(join(directory, "preflight.json"), "utf8"));
        assert.equal(preflight.ok, false);
        assert.match(preflight.errors.join("\n"), new RegExp(`${section}\\.${key}`));
        assert.equal(existsSync(join(directory, "values.yaml")), false);
        assert.equal(existsSync(join(directory, "installation.yaml")), false);
      }
    }
  }
});

test("profiles give tenant runtimes four-core CPU limits over unchanged 100m requests", () => {
  const example = loadYaml(
    readFileSync(
      new URL("../../deploy/examples/production/installation.yaml", import.meta.url),
      "utf8",
    ),
  );
  for (const [name, installation] of [
    ["openclaw", loadYaml(render("openclaw", baseInput()).installation)],
    ["codex", loadYaml(render("codex", codexInput()).installation)],
    ["production example", example],
  ]) {
    const { resources } = installation.drivers.compute.configuration;
    assert.deepEqual(resources.gateway, gatewayResources, `${name} Gateway`);
    assert.deepEqual(resources.agent, harnessResources, `${name} Harness`);
    assert.deepEqual(
      resources.namespace.containerDefaults,
      containerDefaultResources,
      `${name} namespace container default`,
    );
    assert.deepEqual(resources.namespace.quota, { pods: "10" }, `${name} quota`);
  }
  // The example's placeholder proxy CIDR is the only value operators must supply.
  const compute = structuredClone(example.drivers.compute.configuration);
  compute.network.gatewayTrustedProxyCidrs = ["192.0.2.10/32"];
  KubernetesComputeDriver.validateConfiguration(compute);
});

test("managed ChatGPT service-account wiring is optional and explicit", () => {
  const codex = render("codex", managedCodexInput());
  assert.equal(codex.summary.ok, true);
  assert.match(codex.values, /backend:\n {2}chatgpt:\n {4}enabled: true/);
  assert.match(codex.installation, /service_account: chatgpt-service-accounts/);
  assert.match(codex.preflight.warnings.join("\n"), /issuance is wired but remains unverified/);
});

test("profiles reject invalid Helm release names before emitting deployment files", (t) => {
  for (const profile of ["openclaw", "codex"]) {
    const input = profile === "codex" ? codexInput() : baseInput();
    const directory = mkdtempSync(join(tmpdir(), `oce-release-name-${profile}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const releaseName of ["r".repeat(54), "Oce", "oce-", "oce..example", "oce example"]) {
      // A failed rerender must also remove files from a previously valid release.
      render(profile, input, directory);
      assert.throws(
        () =>
          render(
            profile,
            { ...input, controlPlane: { ...input.controlPlane, releaseName } },
            directory,
          ),
        (error) =>
          error.status === 1 && /controlPlane.releaseName/.test(error.profileRendererOutput),
      );
      const preflight = JSON.parse(readFileSync(join(directory, "preflight.json"), "utf8"));
      assert.equal(preflight.ok, false);
      assert.match(preflight.errors.join("\n"), /controlPlane.releaseName/);
      assert.equal(existsSync(join(directory, "values.yaml")), false);
      assert.equal(existsSync(join(directory, "installation.yaml")), false);
    }
  }
});

test(
  "long release names keep Installation routing attached to the rendered Gateway",
  { skip: helmSkip },
  () => {
    for (const profile of ["openclaw", "codex"]) {
      // Exercise the DNS-name boundary and Helm's maximum supported release length.
      for (const length of [48, 49, 53]) {
        const input = profile === "codex" ? codexInput() : baseInput();
        const releaseName = "r".repeat(length);
        input.controlPlane.releaseName = releaseName;
        const output = render(profile, input);
        const gateway = helmTemplate(output, [], releaseName)
          .split(/\n---\n/)
          .find((document) => /\nkind: Gateway\n/.test(document));
        assert.ok(gateway, "Helm must render the Gateway referenced by Compute");
        const gatewayName = gateway.match(/^ {2}name: "([^"]+)"$/m)?.[1];
        const routingName = output.installation.match(/^\s+gatewayName: (\S+)$/m)?.[1];
        assert.ok(gatewayName && gatewayName.length <= 63);
        assert.equal(routingName, gatewayName, `${profile}: release length ${length}`);
      }
    }
  },
);

test("failed rerenders remove stale deployable artifacts from a reused directory", () => {
  for (const profile of ["openclaw", "codex"]) {
    const input = profile === "codex" ? codexInput() : baseInput();
    const output = render(profile, input);
    const notes = join(output.directory, "operator-notes.txt");
    writeFileSync(notes, "Retain operator-owned files.\n");

    // A failed second run must not leave the first run's configuration deployable.
    const invalid = structuredClone(input);
    invalid.controlPlane.databaseCidrs = ["invalid-cidr"];
    const error = renderError(() => render(profile, invalid, output.directory));
    assert.match(error.profileRendererOutput, /must be an IPv4 \/32 CIDR/);
    for (const name of ["values.yaml", "installation.yaml"]) {
      assert.equal(existsSync(join(output.directory, name)), false);
    }
    const preflight = JSON.parse(readFileSync(join(output.directory, "preflight.json"), "utf8"));
    assert.equal(preflight.ok, false);
    assert.deepEqual(preflight.outputs, { preflight: join(output.directory, "preflight.json") });
    assert.equal(readFileSync(notes, "utf8"), "Retain operator-owned files.\n");

    // Recovery regenerates both artifacts; malformed JSON must also invalidate that success.
    assert.equal(render(profile, input, output.directory).preflight.ok, true);
    writeFileSync(join(output.directory, "input.json"), "{");
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            "scripts/render-installation-profile.mjs",
            "--profile",
            profile,
            "--input",
            join(output.directory, "input.json"),
            "--out-dir",
            output.directory,
          ],
          { cwd: repository, stdio: "pipe" },
        ),
      /unavailable or invalid JSON/,
    );
    for (const name of ["values.yaml", "installation.yaml", "preflight.json"]) {
      assert.equal(existsSync(join(output.directory, name)), false);
    }
    assert.equal(readFileSync(notes, "utf8"), "Retain operator-owned files.\n");
  }
});

test("both profiles preserve provider ranges and public Slack egress", { skip: helmSkip }, () => {
  for (const profile of ["openclaw", "codex"]) {
    // Provider ranges must survive rendering; individual DNS answers are not stable.
    const input = profile === "codex" ? codexInput() : baseInput();
    input.repository = repositoryConfiguration(["140.82.112.0/20", "192.30.252.0/22"]);
    const output = render(profile, input);
    const manifests = helmTemplate(output);
    assert.match(manifests, /repository-credentials/);
    assert.match(manifests, /cidr: "140\.82\.112\.0\/20"/);
    assert.match(manifests, /cidr: "192\.30\.252\.0\/22"/);
    const slackPolicy = manifests
      .split(/\n---\n/)
      .find(
        (document) =>
          document.includes("kind: NetworkPolicy") &&
          document.includes("name: openclaw-enterprise-slack-proxy"),
      );
    assert.ok(slackPolicy);
    assert.match(slackPolicy, /cidr: 0\.0\.0\.0\/0\s+except:/);
    assert.doesNotMatch(output.values, /slackProxyUpstreamCidrs/);
  }
});

test(
  "startup-only installation changes roll API and worker pod templates",
  { skip: helmSkip },
  () => {
    const original = render("codex", codexInput());
    const changed = render(
      "codex",
      codexInput({
        runtime: {
          image: `registry.example.invalid/openclaw-enterprise/runtime@sha256:${digestD}`,
        },
      }),
    );

    assert.match(original.values, /installationChecksum: "?[a-f0-9]{64}"?$/m);
    assert.match(changed.values, /installationChecksum: "?[a-f0-9]{64}"?$/m);
    assert.notEqual(original.installation, changed.installation);

    const originalManifests = helmTemplate(original);
    const changedManifests = helmTemplate(changed);
    for (const component of ["api", "worker"]) {
      assert.notEqual(
        deploymentChecksum(originalManifests, component),
        deploymentChecksum(changedManifests, component),
        `${component} checksum annotation changes when only installation.yaml changes`,
      );
    }
  },
);

test(
  "profile preset files reach startup YAML and roll both controllers",
  { skip: helmSkip },
  () => {
    const original = render("codex", codexInput());
    const changed = render(
      "codex",
      codexInput({ presets: { files: ["/app/deploy/presets/swe-preset.json"] } }),
    );
    assert.match(
      changed.installation,
      /presets:\n {2}includeDefaults: true\n {2}files:\n {4}- \/app\/deploy\/presets\/swe-preset.json/,
    );
    const originalManifests = helmTemplate(original);
    const changedManifests = helmTemplate(changed);
    for (const component of ["api", "worker"]) {
      assert.notEqual(
        deploymentChecksum(originalManifests, component),
        deploymentChecksum(changedManifests, component),
      );
    }
  },
);

test("Helm catches generated profile Secret collisions", { skip: helmSkip }, () => {
  const repositoryOutput = render(
    "codex",
    managedCodexInput({
      repository: repositoryConfiguration(),
    }),
  );
  const collision = join(repositoryOutput.directory, "secret-collision.yaml");
  writeFileSync(
    collision,
    "repositoryCredentials:\n  serviceConfigSecretName: occ-chatgpt-admin\n",
  );

  const error = renderError(() => helmTemplate(repositoryOutput, [collision]));
  assert.match(
    `${error.stdout ?? ""}${error.stderr ?? ""}`,
    /repositoryCredentials\.serviceConfigSecretName must name a dedicated Secret; occ-chatgpt-admin is also backend\.chatgpt\.secretName/,
  );
});

// The Gateway TLS and root CA Secrets the chart generates for a release, with the role the
// preflight names and the refusal Helm gives when the gateway API key Secret reuses one.
// helmTemplate and baseInput both install into openclaw-system.
function generatedGatewaySecrets(releaseName, namespace = "openclaw-system") {
  const gatewayName = `${releaseName}-agent-gateways`.slice(0, 63).replace(/-$/, "");
  const routeLabel = createHash("sha256")
    .update(`${namespace}/${gatewayName}`)
    .digest("hex")
    .slice(0, 12);
  return [
    {
      name: `${gatewayName}-tls`.slice(0, 63).replace(/-$/, ""),
      role: "Gateway TLS certificate",
      helm: /gatewayRouting\.apiKeySecretName must name a dedicated Secret; \S+ is also gatewayRouting\.tlsSecretName/,
    },
    {
      name: `occ-gateway-${routeLabel}-root`,
      role: "Gateway root CA",
      helm: /gatewayRouting\.apiKeySecretName must name a dedicated Secret; \S+ is also the generated Gateway root CA/,
    },
  ];
}

test(
  "preflight refuses the gateway API key Secret names the chart generates, as Helm does",
  { skip: helmSkip },
  () => {
    // 47 is the only release length where the TLS name ends in "-" after truncation.
    for (const releaseName of ["oce", "r".repeat(47), "r".repeat(53)]) {
      const input = baseInput();
      input.controlPlane.releaseName = releaseName;
      const accepted = render("openclaw", input);
      const manifests = helmTemplate(accepted, [], releaseName);
      for (const { name, role, helm: refusal } of generatedGatewaySecrets(releaseName)) {
        assert.match(manifests, new RegExp(`\\n {2}secretName: "${name}"\\n`), name);
        const override = join(accepted.directory, "gateway-key-collision.yaml");
        writeFileSync(override, `gatewayRouting:\n  apiKeySecretName: ${name}\n`);
        const error = renderError(() => helmTemplate(accepted, [override], releaseName));
        assert.match(`${error.stdout ?? ""}${error.stderr ?? ""}`, refusal);
        assertPreflightFailure(
          "openclaw",
          { ...input, controlPlane: { ...input.controlPlane, gatewayApiKeySecretName: name } },
          new RegExp(`the chart generates ${name} for the ${role}\\.`),
        );
      }
    }
  },
);

// The Secrets a ChatGPT admin or repository Secret may not reuse on the codex profile: the
// chart's own, the generated Gateway TLS and root CA, the gateway API key and the ChatGPT admin
// Secret, in managedCodexInput's names.
const credentialSecretNames = [
  "occ-installation-startup",
  "occ-database",
  "occ-auth",
  ...generatedGatewaySecrets("oce").map(({ name }) => name),
  "occ-private-gateway-key",
  "occ-chatgpt-admin",
];
const repositorySecretKeys = [
  "serviceConfigSecretName",
  "appKeySecretName",
  "tlsSecretName",
  "publicCaSecretName",
];

function withGitHubSignIn(input, github) {
  const {
    agentNativeAdminDomain: _domain,
    sharedCookieDomain: _cookieDomain,
    ...controlPlane
  } = input.controlPlane;
  return {
    ...input,
    controlPlane: { ...controlPlane, recoveryUserId: "recovery-admin_1", github },
  };
}

test(
  "preflight refuses sign-in Secrets that ChatGPT or repository credentials use, as Helm does",
  { skip: helmSkip },
  () => {
    const input = managedCodexInput({ repository: repositoryConfiguration() });
    const accepted = render("codex", withGitHubSignIn(input, {}));
    assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
    helmTemplate(accepted);
    for (const secretName of [
      "occ-chatgpt-admin",
      "occ-repository-service-config",
      "occ-repository-app-key",
      "occ-repository-tls",
      "occ-repository-public-ca",
    ]) {
      // The ChatGPT admin Secret comes before sign-in and the repository Secrets after it, in
      // the chart's order, so either setting can be the one refused.
      assertPreflightFailure(
        "codex",
        withGitHubSignIn(input, { secretName }),
        /controlPlane\.github\.secretName must name a dedicated Secret|must name a dedicated Secret; \S+ is also controlPlane\.github\.secretName\./,
      );
      // The same name placed over the accepted values makes the chart refuse it too.
      const override = join(accepted.directory, `github-${secretName}.json`);
      writeFileSync(override, JSON.stringify({ auth: { github: { secretName } } }));
      const error = renderError(() => helmTemplate(accepted, [override]));
      assert.match(
        `${error.stdout ?? ""}${error.stderr ?? ""}`,
        /auth\.github\.secretName must name a dedicated Secret|must name a dedicated Secret; \S+ is also auth\.github\.secretName/,
      );
    }
    // Without managed ChatGPT accounts the chart does not reserve that Secret name.
    const unmanaged = render(
      "codex",
      withGitHubSignIn(codexInput(), { secretName: "occ-chatgpt-admin" }),
    );
    assert.equal(unmanaged.summary.ok, true, unmanaged.preflight.errors.join("\n"));
    helmTemplate(unmanaged);
  },
);

test(
  "preflight refuses ChatGPT admin and repository Secret collisions, as Helm does",
  { skip: helmSkip },
  () => {
    const input = managedCodexInput({ repository: repositoryConfiguration() });
    const accepted = render("codex", input);
    assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
    helmTemplate(accepted);
    const [tls, root] = generatedGatewaySecrets("oce").map(({ name }) => name);
    // [input field, name, chart values, chart refusal, preflight refusal]: the cases bughunt probe R2 found
    // that only Helm refused, and the admin Secret shared with the gateway API key, which
    // neither refused (finding 1044). Both name the gateway API key, which comes second.
    for (const [field, name, chartValues, refusal, preflight = "must name a dedicated Secret"] of [
      [
        "codex.managedServiceAccounts.adminSecretName",
        "occ-private-gateway-key",
        { backend: { chatgpt: { secretName: "occ-private-gateway-key" } } },
        /gatewayRouting\.apiKeySecretName must name a dedicated Secret; occ-private-gateway-key is also backend\.chatgpt\.secretName/,
        /controlPlane\.gatewayApiKeySecretName must name a dedicated Secret; occ-private-gateway-key is also codex\.managedServiceAccounts\.adminSecretName\./,
      ],
      [
        "controlPlane.gatewayApiKeySecretName",
        "occ-chatgpt-admin",
        { gatewayRouting: { apiKeySecretName: "occ-chatgpt-admin" } },
        /gatewayRouting\.apiKeySecretName must name a dedicated Secret; occ-chatgpt-admin is also backend\.chatgpt\.secretName/,
        /controlPlane\.gatewayApiKeySecretName must name a dedicated Secret; occ-chatgpt-admin is also codex\.managedServiceAccounts\.adminSecretName\./,
      ],
      ...[
        [tls, "gatewayRouting.tlsSecretName"],
        [root, "the generated Gateway root CA"],
        ["occ-database", "database.secretName"],
      ].map(([secretName, other]) => [
        "codex.managedServiceAccounts.adminSecretName",
        secretName,
        { backend: { chatgpt: { secretName } } },
        new RegExp(
          escapeRegExp(
            `backend.chatgpt.secretName must name a dedicated Secret; ${secretName} is also ${other}`,
          ),
        ),
      ]),
      ...[
        ["appKeySecretName", tls, "gatewayRouting.tlsSecretName"],
        ["appKeySecretName", root, "the generated Gateway root CA"],
        ["appKeySecretName", "occ-database", "database.secretName"],
        ["appKeySecretName", "occ-private-gateway-key", "gatewayRouting.apiKeySecretName"],
        ["tlsSecretName", "occ-chatgpt-admin", "backend.chatgpt.secretName"],
        ["tlsSecretName", "occ-repository-app-key", "repositoryCredentials.appKeySecretName"],
      ].map(([key, secretName, other]) => [
        `repository.${key}`,
        secretName,
        { repositoryCredentials: { [key]: secretName } },
        new RegExp(
          escapeRegExp(
            `repositoryCredentials.${key} must name a dedicated Secret; ${secretName} is also ${other}`,
          ),
        ),
      ]),
    ]) {
      assertFieldRefusals("codex", input, field, [name], preflight);
      const override = join(accepted.directory, "secret-collision.json");
      writeFileSync(override, JSON.stringify(chartValues));
      const error = renderError(() => helmTemplate(accepted, [override]));
      assert.match(`${error.stdout ?? ""}${error.stderr ?? ""}`, refusal, `${field} = ${name}`);
    }
  },
);

test(
  "preflight refuses credential Secrets named like the log collector's, as Helm does",
  { skip: helmSkip },
  () => {
    const input = managedCodexInput({ repository: repositoryConfiguration() });
    input.controlPlane.loggingCollector = { enabled: true, exporter: { cidr: "192.0.2.40/32" } };
    const accepted = render("codex", input);
    assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
    helmTemplate(accepted);
    const override = join(accepted.directory, "secret-collision.json");
    writeFileSync(
      override,
      JSON.stringify({ gatewayRouting: { apiKeySecretName: "occ-otel-collector-config" } }),
    );
    const error = renderError(() => helmTemplate(accepted, [override]));
    assert.match(
      `${error.stdout ?? ""}${error.stderr ?? ""}`,
      /logging\.collector\.configSecretName must name a dedicated Secret; occ-otel-collector-config is also gatewayRouting\.apiKeySecretName/,
    );
    assertFieldRefusals(
      "codex",
      input,
      "controlPlane.gatewayApiKeySecretName",
      ["occ-otel-collector-config"],
      "must name a dedicated Secret; the chart's log collector uses occ-otel-collector-config.",
    );
  },
);

// Finding 1047: the chart refuses an enabled log collector without an exporter, so the profile
// takes one and preflight refuses an enabled collector that lacks it.
test(
  "profile log collector exporters render values Helm accepts, and preflight requires one",
  { skip: helmSkip },
  () => {
    const egress = (output, extra) => {
      const manifests = helmTemplate(output, extra);
      const policy = manifests
        .split(/^---$/m)
        .filter((document) => document.includes("name: openclaw-enterprise-collector-egress"))
        .map((document) => loadYaml(document))
        .find((object) => object.metadata.name === "openclaw-enterprise-collector-egress");
      // loadYaml builds client-node classes; compare plain data.
      return JSON.parse(JSON.stringify(policy.spec.egress.at(-1)));
    };
    for (const [exporter, peer, port] of [
      [{ cidr: "192.0.2.40/32" }, { ipBlock: { cidr: "192.0.2.40/32" } }, 443],
      [
        {
          namespaceLabels: { name: "observability" },
          podLabels: { app: "otel-gateway" },
          port: 4318,
        },
        {
          namespaceSelector: { matchLabels: { name: "observability" } },
          podSelector: { matchLabels: { app: "otel-gateway" } },
        },
        4318,
      ],
    ]) {
      const input = baseInput();
      input.controlPlane.loggingCollector = { enabled: true, exporter };
      const output = render("openclaw", input);
      assert.equal(output.summary.ok, true, output.preflight.errors.join("\n"));
      const rule = egress(output);
      assert.deepEqual(rule.to, [peer], JSON.stringify(exporter));
      assert.deepEqual(rule.ports, [{ protocol: "TCP", port }], JSON.stringify(exporter));
    }
    const input = baseInput();
    input.controlPlane.loggingCollector = { enabled: true };
    assertPreflightFailure(
      "openclaw",
      input,
      /controlPlane\.loggingCollector\.exporter is required with enabled: true; set cidr to the one approved exporter or proxy IPv4 host as a \/32, or namespaceLabels and podLabels/,
    );
  },
);

// Preflight refusals of one input field each, on the openclaw profile and baseInput() unless an
// entry says otherwise. A case is [field, refused values, message]: field is a dotted path into
// a fresh input(), and a string message is the refusal text after it.
for (const { name, profile = "openclaw", input = baseInput, cases } of [
  {
    name: "profiles refuse ChatGPT workspace IDs the controller refuses",
    profile: "codex",
    input: managedCodexInput,
    cases: [
      [
        "codex.managedServiceAccounts.workspaceId",
        [
          "not-a-uuid",
          "00000000-0000-0000-0000-000000000000",
          "11111111-1111-4111-0111-111111111111",
          "11111111-1111-0111-8111-111111111111",
        ],
        "must be a UUID the controller accepts for a ChatGPT workspace",
      ],
    ],
  },
  {
    name: "preflight refuses ChatGPT admin and repository Secrets that hold other credentials",
    profile: "codex",
    input: () => managedCodexInput({ repository: repositoryConfiguration() }),
    cases: [
      // The gateway API key comes after the ChatGPT admin Secret, so preflight names it instead.
      [
        "codex.managedServiceAccounts.adminSecretName",
        credentialSecretNames.filter(
          (name) => name !== "occ-chatgpt-admin" && name !== "occ-private-gateway-key",
        ),
        "must name a dedicated Secret",
      ],
      // Each repository Secret is checked against the ChatGPT admin Secret and the repository
      // Secrets before it, in the chart's order.
      ...repositorySecretKeys.map((key, index) => [
        `repository.${key}`,
        [
          ...credentialSecretNames,
          ...repositorySecretKeys.slice(0, index).map((other) => repositoryConfiguration()[other]),
        ],
        "must name a dedicated Secret",
      ]),
    ],
  },
  {
    name: "preflight refuses credential Secrets named like the log collector's",
    profile: "codex",
    input: () => {
      const input = withGitHubSignIn(
        managedCodexInput({ repository: repositoryConfiguration() }),
        {},
      );
      input.controlPlane.loggingCollector = {
        enabled: true,
        exporter: { cidr: "192.0.2.40/32" },
      };
      return input;
    },
    // Finding 1054: the database CA Secret counts too, as in the chart's table.
    cases: [
      "controlPlane.gatewayApiKeySecretName",
      "controlPlane.github.secretName",
      "controlPlane.databaseCa.secretName",
      "codex.managedServiceAccounts.adminSecretName",
      ...repositorySecretKeys.map((key) => `repository.${key}`),
    ].map((field) => [
      field,
      ["occ-otel-collector-config", "occ-otel-collector-exporter"],
      "must name a dedicated Secret; the chart's log collector uses occ-otel-collector-",
    ]),
  },
  {
    // cert-manager writes these two Secrets, so it would overwrite a sign-in Secret sharing one
    // (finding 1046; the Helm-backed case is in profile-preflight-chart-parity).
    name: "preflight refuses sign-in Secrets named like the Gateway Secrets the chart generates",
    input: () => {
      const input = withGitHubSignIn(baseInput(), {});
      input.controlPlane.google = {};
      return input;
    },
    cases: ["github", "google"].flatMap((provider) =>
      generatedGatewaySecrets("oce").map(({ name, role }) => [
        `controlPlane.${provider}.secretName`,
        [name],
        `must name a dedicated Secret; the chart generates ${name} for the ${role}.`,
      ]),
    ),
  },
  {
    name: "preflight refuses log collector exporters the chart refuses",
    input: () => {
      const input = baseInput();
      input.controlPlane.loggingCollector = {
        enabled: true,
        exporter: { cidr: "192.0.2.40/32" },
      };
      return input;
    },
    cases: [
      [
        "controlPlane.loggingCollector.exporter.cidr",
        ["192.0.2.0/24", "192.0.2.40", "010.0.2.40/32", "192.0.2.256/32", " 192.0.2.40/32"],
        "must be one approved exporter or proxy IPv4 host with /32",
      ],
      [
        "controlPlane.loggingCollector.exporter.port",
        [0, 65536, "443", 44.5],
        "must be an integer from 1 through 65535 when supplied",
      ],
      [
        "controlPlane.loggingCollector.exporter.namespaceLabels",
        [{ name: "observability" }],
        /controlPlane\.loggingCollector\.exporter requires both namespaceLabels and podLabels\./,
      ],
      [
        "controlPlane.loggingCollector.exporter.podLabels",
        [{ app: "otel-gateway" }],
        /controlPlane\.loggingCollector\.exporter requires both namespaceLabels and podLabels\./,
      ],
      [
        "controlPlane.loggingCollector.exporter",
        [{}, { port: 443 }],
        /controlPlane\.loggingCollector\.exporter requires cidr or namespaceLabels and podLabels\./,
      ],
      [
        "controlPlane.loggingCollector.exporter",
        [
          {
            cidr: "192.0.2.40/32",
            namespaceLabels: { name: "observability" },
            podLabels: { app: "otel-gateway" },
          },
        ],
        /controlPlane\.loggingCollector\.exporter requires either cidr or namespaceLabels and podLabels, not both\./,
      ],
      [
        "controlPlane.loggingCollector.exporter",
        ["192.0.2.40/32", null],
        /controlPlane\.loggingCollector\.exporter must be an object\./,
      ],
      [
        "controlPlane.loggingCollector.exporter.endpoint",
        ["https://otel.example.invalid"],
        "is not supported by installation profiles.",
      ],
      [
        "controlPlane.loggingCollector.enabled",
        [false],
        /controlPlane\.loggingCollector\.exporter requires controlPlane\.loggingCollector\.enabled: true\./,
      ],
    ],
  },
  {
    name: "preflight refuses lone surrogates, which Helm cannot parse in values.yaml",
    cases: [
      ["controlPlane.adminEmail", ["a\ud800@b.c"], "must be well-formed Unicode text"],
      ["controlPlane.gatewayClassName", ["e\udc00g"], "must be well-formed"],
      [
        "controlPlane.dns.podLabels",
        [{ "k8s\ud800": "kube-dns" }],
        "keys must be well-formed Unicode text",
      ],
    ],
  },
  {
    name: "preflight refuses GatewayClass names that Kubernetes refuses",
    cases: [
      [
        "controlPlane.gatewayClassName",
        ["Bad Class", "-eg", "e".repeat(254)],
        "must be a Kubernetes resource name",
      ],
    ],
  },
  {
    name: "preflight refuses gateway API key Secret names that Kubernetes refuses",
    cases: [
      [
        "controlPlane.gatewayApiKeySecretName",
        ["Bad_Name", "-gateway-key", "g".repeat(254)],
        "must be a Kubernetes resource name",
      ],
    ],
  },
  {
    name: "preflight rejects a repository serviceName the chart refuses",
    profile: "codex",
    input: () => codexInput({ repository: repositoryConfiguration() }),
    cases: [
      [
        "repository.serviceName",
        ["1git", "git.openclaw-system.svc", "a".repeat(64), "Git"],
        "must be a Kubernetes Service DNS-1035 label of at most 63 characters",
      ],
    ],
  },
  {
    name: "preflight rejects invalid CIDRs before rendering",
    profile: "codex",
    input: codexInput,
    cases: [
      [
        "controlPlane.databaseCidrs",
        [["999.999.999.999/32"]],
        /controlPlane\.databaseCidrs\[0\] must be an IPv4 \/32 CIDR/,
      ],
      [
        "codex.managedServiceAccounts",
        [
          {
            workspaceId: "11111111-1111-4111-8111-111111111111",
            adminSecretName: "occ-chatgpt-admin",
            providerCidr: "999.999.999.999/32",
          },
        ],
        /codex\.managedServiceAccounts\.providerCidr must be an IPv4 \/32 CIDR/,
      ],
    ],
  },
  {
    name: "profile preset files reject malformed paths and unknown settings",
    profile: "codex",
    input: codexInput,
    cases: [
      ["presets.files", ["presets/custom.json", [""], [42]], /presets\.files/],
      ["presets.unknown", [true], /presets\.unknown/],
    ],
  },
]) {
  test(name, () => {
    for (const [field, values, message] of cases) {
      assertFieldRefusals(profile, input(), field, values, message);
    }
  });
}

test("label values that YAML 1.1 would retype stay strings", () => {
  const labels = {
    spot: "no",
    enabled: "on",
    legacy: "Off",
    short: "y",
    scale: "1e3",
    hex: "0x1f",
    octal: "0o17",
    yes: "keep",
    "node-role.kubernetes.io/infra": "",
  };
  const input = baseInput();
  input.controlPlane.nodeSelector = labels;
  const output = render("openclaw", input);
  for (const [key, value] of Object.entries(labels)) {
    const quotedValue = JSON.stringify(value);
    const expected = key === "yes" ? '"yes": keep' : `${key}: ${quotedValue}`;
    assert.ok(
      output.values.includes(expected),
      `expected ${key} to render as a quoted string in values.yaml`,
    );
  }
});

test("Helm renders YAML 1.1 lookalike label values as strings", { skip: helmSkip }, () => {
  const input = baseInput();
  input.controlPlane.nodeSelector = { spot: "no", scale: "1e3", hex: "0x1f" };
  const manifests = helmTemplate(render("openclaw", input));
  assert.match(manifests, /spot: ["']no["']/);
  assert.match(manifests, /scale: ["']1e3["']/);
  assert.match(manifests, /hex: ["']0x1f["']/);
  assert.doesNotMatch(manifests, /spot: false/);
  const rejected = baseInput();
  rejected.controlPlane.nodeSelector = { team: "@platform" };
  assertPreflightFailure(
    "openclaw",
    rejected,
    /controlPlane\.nodeSelector values must be Kubernetes label values/,
  );
});

test("renderer rejects the removed default profile", () => {
  assert.throws(() => render("default", baseInput()), /--profile must be one of: openclaw, codex/);
});

test("repository opt-in is explicit and keeps the two-stage placeholders separate", () => {
  const output = render(
    "codex",
    codexInput({
      repository: repositoryConfiguration(),
    }),
  );
  assert.equal(output.summary.ok, true);
  assert.match(output.values, /repositoryCredentials:\n {2}enabled: true/);
  assert.match(output.values, /registryConfigMapName: occ-repository-registry-v1/);
  assert.match(output.installation, /type: github/);
  assert.match(
    output.installation,
    /registryPath: \/etc\/openclaw\/repository-registry\/registry.json/,
  );
  assert.match(
    output.preflight.warnings.join("\n"),
    /Active repository sessions are not restored after broker loss/,
  );
});

test("repository serviceName is left to the chart so its upgrade guard applies", () => {
  const repositoryInput = repositoryConfiguration();
  const omitted = render("codex", codexInput({ repository: repositoryInput }));
  assert.doesNotMatch(omitted.values, /serviceName: git/);
  if (!helmSkip) {
    assert.match(helmTemplate(omitted), /name: "git"\n/);
    const error = renderError(() => helmTemplate(omitted, [], "oce", ["--is-upgrade"]));
    assert.match(
      `${error.stdout ?? ""}${error.stderr ?? ""}`,
      /repositoryCredentials\.serviceName must be explicit during upgrades/,
    );
  }

  const kept = render(
    "codex",
    codexInput({ repository: { ...repositoryInput, serviceName: "oce-git" } }),
  );
  assert.match(kept.values, /serviceName: oce-git/);
  if (!helmSkip) {
    assert.match(helmTemplate(kept, [], "oce", ["--is-upgrade"]), /name: "oce-git"\n/);
  }
});

test("preflight rejects inputs that the selected profile does not consume", () => {
  assertFieldRefusals(
    "openclaw",
    baseInput(),
    "runtime.codexSeccompProfile",
    ["profiles/codex.json"],
    "is only consumed by the codex profile",
  );
  assertFieldRefusals(
    "codex",
    codexInput(),
    "repository",
    [{ enabled: false, backendId: "github-primary" }],
    "fields other than enabled are only consumed",
  );
});

test("preflight rejects inputs that Helm would reject", () => {
  assertFieldRefusals(
    "openclaw",
    baseInput(),
    "controlPlane.gatewayApiKeySecretName",
    ["occ-installation-startup", "occ-database", "occ-auth"],
    "must name a dedicated Secret",
  );
  assertFieldRefusals(
    "openclaw",
    baseInput(),
    "controlPlane.gatewayApiKeySecretName",
    generatedGatewaySecrets("oce").map(({ name }) => name),
    "must name a dedicated Secret; the chart generates",
  );
  assertFieldRefusals(
    "codex",
    codexInput(),
    "controlPlane.metrics",
    [{ scraperNamespaceLabels: { name: "monitoring" } }],
    "requires both scraperNamespaceLabels and scraperPodLabels, or neither",
  );
  assertFieldRefusals(
    "codex",
    codexInput(),
    "controlPlane.agentNativeAdminDomain",
    ["https://agents.oce.example.internal"],
    "must be a DNS hostname without a wildcard, port, scheme, or path",
  );
  assertFieldRefusals(
    "codex",
    codexInput(),
    "controlPlane.agentNativeAdminDomain",
    ["agents.other.example.internal"],
    "must be inside controlPlane.sharedCookieDomain",
  );
  assertFieldRefusals(
    "codex",
    codexInput(),
    "controlPlane.authBaseUrl",
    ["https://console.example.internal"],
    "host must be inside controlPlane.sharedCookieDomain",
  );

  // The API refuses a public-suffix cookie domain at startup (tldts, private registries
  // included); preflight uses the same list. Helm has none, so the chart renders these.
  const nativeAdminUnder = (sharedCookieDomain) =>
    codexInput({
      controlPlane: {
        ...baseInput().controlPlane,
        authBaseUrl: `https://console.${sharedCookieDomain}`,
        agentNativeAdminDomain: `agents.${sharedCookieDomain}`,
        sharedCookieDomain,
      },
    });
  for (const sharedCookieDomain of ["co.uk", "github.io", "CO.UK", "192.0.2.1"]) {
    assertPreflightFailure(
      "codex",
      nativeAdminUnder(sharedCookieDomain),
      /controlPlane.sharedCookieDomain must not be a public suffix/,
    );
  }
  for (const sharedCookieDomain of ["example.co.uk", "oce.github.io"]) {
    assert.equal(render("codex", nativeAdminUnder(sharedCookieDomain)).summary.ok, true);
  }

  assertFieldRefusals(
    "codex",
    codexInput(),
    "controlPlane.authBaseUrl",
    ["http://console.oce.example.internal"],
    "must use HTTPS with native admin",
  );

  // The API and the bootstrap Job accept only an absolute HTTP(S) origin.
  const invalidOrigins = [
    "https://console.oce.example.internal/occ",
    "https://console.oce.example.internal?next=1",
    "https://console.oce.example.internal#console",
    // An empty query or fragment, which the API's URL serialization keeps (https://host/?).
    "https://console.oce.example.internal?",
    "https://console.oce.example.internal/?",
    "https://console.oce.example.internal#",
    "https://console.oce.example.internal/#",
    " https://console.oce.example.internal? ",
    "https://admin@console.oce.example.internal",
    "ftp://console.oce.example.internal",
    "console.oce.example.internal",
    // Stricter than the API, like the chart: URL parsing repairs these into an origin.
    "https:console.oce.example.internal",
    "https://console.oce.example.internal/.",
    "https://console.oce.example.internal/%2e",
    // Like the chart: Unicode spaces and invisible characters at either end, which URL
    // parsing keeps (it strips only C0 controls and spaces). URL parsing already refuses most
    // of these, and a trailing unassigned code point (U+0378); a trailing U+FEFF or U+200B,
    // which the host parser drops, is refused by the edge rule alone.
    ...["\u00a0", "\u2003", "\u3000", "\ufeff", "\u200b"].flatMap((space) => [
      `${space}https://console.oce.example.internal`,
      `https://console.oce.example.internal${space}`,
      ` ${space}https://console.oce.example.internal${space} `,
    ]),
    "https://console.oce.example.internal\u0378",
    // A leading zero is octal: 192.168.010.001 publishes 192.168.8.1.
    "https://192.168.010.001",
    "https://127.1",
    "http://0177.0.0.1",
    // Like the chart: spaces, < and > and invisible characters inside the host. The host parser
    // refuses spaces, < and >, and drops tabs and most invisible characters.
    ...[
      " ",
      "<",
      ">",
      "\u00a0",
      "\u2003",
      "\u3000",
      "\u2028",
      "\t",
      "\ufeff",
      "\u200b",
      "\u00ad",
    ].map((space) => `https://console${space}.oce.example.internal`),
  ];
  assertFieldRefusals(
    "codex",
    codexInput(),
    "controlPlane.authBaseUrl",
    invalidOrigins,
    "must be an absolute HTTP(S) origin URL without a path, query, fragment, or user info",
  );
  // The API accepts these, and so does the renderer: ASCII spaces and tabs at the ends, which
  // URL parsing strips, and hosts with non-ASCII letters, including the joiners U+200C and
  // U+200D that some IDN labels need.
  for (const authBaseUrl of [
    " \thttps://console.oce.example.internal\t ",
    "https://bücher.oce.example.internal",
    "https://\u0646\u0627\u0645\u0647\u200c\u0627\u06cc.oce.example.internal",
    "https://\u0915\u094d\u200d\u0937.oce.example.internal",
  ]) {
    const output = render(
      "codex",
      codexInput({ controlPlane: { ...baseInput().controlPlane, authBaseUrl } }),
    );
    assert.equal(output.summary.ok, true, output.preflight.errors.join("\n"));
  }
  // An unparsable value is reported once, not again by the native admin checks.
  const error = renderError(() =>
    render(
      "codex",
      codexInput({
        controlPlane: { ...baseInput().controlPlane, authBaseUrl: "console.oce.example.internal" },
      }),
    ),
  );
  const preflight = JSON.parse(
    readFileSync(join(error.profileRendererDirectory, "preflight.json"), "utf8"),
  );
  assert.deepEqual(
    preflight.errors.filter((message) => message.includes("authBaseUrl")),
    [
      "controlPlane.authBaseUrl must be an absolute HTTP(S) origin URL without a path, query, fragment, or user info.",
    ],
  );
});

// The API lowercases both domains at startup, and the chart accepts only lowercase.
test("native admin domains render lowercase for the chart", () => {
  const output = render(
    "codex",
    codexInput({
      controlPlane: {
        ...baseInput().controlPlane,
        authBaseUrl: "https://Console.Example.co.uk",
        agentNativeAdminDomain: "Agents.Example.co.uk",
        sharedCookieDomain: "Example.co.uk",
      },
    }),
  );
  assert.equal(output.summary.ok, true, output.preflight.errors.join("\n"));
  assert.match(
    output.values,
    /agentNativeAdmin:\n {2}enabled: true\n {2}domain: agents\.example\.co\.uk\n {2}sharedCookieDomain: example\.co\.uk\n/,
  );
  if (!helmSkip) {
    const manifests = helmTemplate(output);
    assert.match(
      manifests,
      /name: OCC_AGENT_NATIVE_ADMIN_DOMAIN\n\s+value: "agents\.example\.co\.uk"/,
    );
    assert.match(manifests, /name: OCC_AUTH_COOKIE_DOMAIN\n\s+value: "example\.co\.uk"/);
  }
});

test("profiles pass an optional observability URL to Installation startup YAML", async () => {
  const url = "https://grafana.oce.example.internal/d/occ-observability";
  const withoutUrl = render("openclaw", baseInput());
  assert.doesNotMatch(withoutUrl.installation, /observability:/);

  const output = render(
    "codex",
    codexInput({ controlPlane: { ...baseInput().controlPlane, observabilityUrl: url } }),
  );
  assert.equal(output.summary.ok, true);
  // The controller's own startup parser must accept the rendered block.
  const snapshot = await loadStartupConfigurationSnapshot({
    mode: "production",
    environment: { OCC_CONFIG_PATH: join(output.directory, "installation.yaml") },
  });
  assert.equal(snapshot.observability.url, url);

  for (const invalid of [
    "javascript:alert(1)",
    syntheticCredentialUrl({
      username: "user",
      password: "pass",
      host: "grafana.example.internal",
    }),
    "https://grafana.example.internal/#fragment",
    "grafana.example.internal",
  ]) {
    assertPreflightFailure(
      "openclaw",
      baseInput({ controlPlane: { ...baseInput().controlPlane, observabilityUrl: invalid } }),
      /controlPlane.observabilityUrl must be an absolute HTTP or HTTPS URL/,
    );
  }
});

function externalSignInInput(signIn = {}) {
  const { agentNativeAdminDomain, sharedCookieDomain, ...controlPlane } = baseInput().controlPlane;
  assert.ok(agentNativeAdminDomain && sharedCookieDomain);
  return baseInput({
    controlPlane: {
      ...controlPlane,
      recoveryUserId: "recovery-admin_1",
      github: { egressCidrs: ["140.82.112.0/20"] },
      ...signIn,
    },
  });
}

test(
  "profiles carry external sign-in and trusted proxy settings through rerenders",
  { skip: helmSkip },
  () => {
    const trustedProxy = { preset: "ingress-nginx", cidrs: ["10.42.0.0/16"] };
    const github = render("openclaw", externalSignInInput({ trustedProxy }));
    assert.equal(github.summary.ok, true);
    // GitHub and Google sign-in support host-only cookies only, so native admin stays off.
    assert.match(github.values, /agentNativeAdmin:\n {2}enabled: false\n/);
    assert.match(github.values, /recoveryUserId: recovery-admin_1/);
    assert.match(
      github.values,
      /github:\n {4}enabled: true\n {4}egressCidrs:\n {6}- 140\.82\.112\.0\/20/,
    );
    assert.match(github.values, /trustedProxy:\n {4}preset: ingress-nginx/);
    assert.doesNotMatch(github.preflight.warnings.join("\n"), /trustedProxy is not set/);
    assert.doesNotMatch(github.preflight.prerequisites.join("\n"), /native admin domain/);
    const manifests = helmTemplate(github);
    assert.match(manifests, /name: OCC_AUTH_GITHUB_CLIENT_ID/);
    assert.match(manifests, /name: OCC_AUTH_GITHUB_RECOVERY_USER_ID\n\s+value: "recovery-admin_1"/);
    assert.match(manifests, /name: OCC_AUTH_TRUSTED_PROXY_CIDRS\n\s+value: "10\.42\.0\.0\/16"/);
    assert.doesNotMatch(manifests, /OCC_AUTH_GITHUB_ALLOWED_/);
    // The API reads the scheme as URL parsing does, so an uppercase HTTPS origin is valid.
    const uppercase = render(
      "openclaw",
      externalSignInInput({ trustedProxy, authBaseUrl: "HTTPS://Console.OCE.example.internal" }),
    );
    assert.equal(uppercase.summary.ok, true, uppercase.preflight.errors.join("\n"));
    assert.match(
      helmTemplate(uppercase),
      /name: OCC_AUTH_BASE_URL\n\s+value: "HTTPS:\/\/Console\.OCE\.example\.internal"/,
    );
    const allowlisted = render(
      "openclaw",
      externalSignInInput({
        trustedProxy,
        github: { allowedOrgs: ["acme"], allowedTeams: ["other/platform"] },
      }),
    );
    assert.equal(allowlisted.summary.ok, true, allowlisted.preflight.errors.join("\n"));
    assert.match(
      allowlisted.values,
      /allowedOrgs:\n {6}- acme\n {4}allowedTeams:\n {6}- other\/platform/,
    );
    const allowlistManifests = helmTemplate(allowlisted);
    assert.match(allowlistManifests, /name: OCC_AUTH_GITHUB_ALLOWED_ORGS\n\s+value: "acme"/);
    assert.match(
      allowlistManifests,
      /name: OCC_AUTH_GITHUB_ALLOWED_TEAMS\n\s+value: "other\/platform"/,
    );
    // Password sign-in stays open to every account unless recovery-only is chosen.
    assert.doesNotMatch(github.values, /passwordSignIn/);
    assert.doesNotMatch(manifests, /OCC_AUTH_PASSWORD_SIGN_IN/);
    assert.doesNotMatch(github.preflight.prerequisites.join("\n"), /identity attached/);
    const recoveryOnly = render(
      "openclaw",
      externalSignInInput({ trustedProxy, passwordSignIn: "recovery-only" }),
    );
    assert.equal(recoveryOnly.summary.ok, true);
    assert.match(recoveryOnly.values, /passwordSignIn: recovery-only/);
    assert.match(
      recoveryOnly.preflight.prerequisites.join("\n"),
      /GitHub, Google or OIDC identity attached to every ordinary account/,
    );
    assert.match(
      helmTemplate(recoveryOnly),
      /name: OCC_AUTH_PASSWORD_SIGN_IN\n\s+value: recovery-only/,
    );

    const google = render(
      "codex",
      codexInput({
        controlPlane: externalSignInInput({
          github: undefined,
          google: { allowedDomains: ["example.com"] },
        }).controlPlane,
      }),
    );
    assert.equal(google.summary.ok, true);
    assert.match(
      google.values,
      /google:\n {4}enabled: true\n {4}allowedDomains:\n {6}- example\.com/,
    );
    assert.doesNotMatch(google.values, /github:/);
    assert.match(helmTemplate(google), /name: OCC_AUTH_GOOGLE_ALLOWED_DOMAINS/);

    const oidc = render(
      "openclaw",
      externalSignInInput({
        github: undefined,
        oidc: {
          issuer: "https://sso.example.com/realms/acme",
          authorizationUrl: "https://sso.example.com/realms/acme/protocol/openid-connect/auth",
          tokenUrl: "https://sso.example.com/realms/acme/protocol/openid-connect/token",
          jwksUrl: "https://sso.example.com/realms/acme/protocol/openid-connect/certs",
          tokenAuth: "client_secret_basic",
          displayName: "Acme SSO",
          egressCidrs: ["198.51.100.0/24"],
        },
      }),
    );
    assert.equal(oidc.summary.ok, true, oidc.preflight.errors.join("\n"));
    assert.match(oidc.values, /oidc:\n {4}enabled: true\n/);
    assert.match(oidc.values, /issuer: https:\/\/sso\.example\.com\/realms\/acme\n/);
    assert.doesNotMatch(oidc.values, /github:/);
    const oidcManifests = helmTemplate(oidc);
    assert.match(
      oidcManifests,
      /name: OCC_AUTH_OIDC_ISSUER\n\s+value: "https:\/\/sso\.example\.com\/realms\/acme"/,
    );
    assert.match(oidcManifests, /name: OCC_AUTH_OIDC_TOKEN_AUTH\n\s+value: "client_secret_basic"/);
    assert.match(oidcManifests, /name: OCC_AUTH_OIDC_DISPLAY_NAME\n\s+value: "Acme SSO"/);
    assert.match(oidcManifests, /name: openclaw-enterprise-api-oidc-login-egress/);
    // The API trims each OIDC URL with JavaScript's trim before its checks, and so do the chart
    // and the renderer, which keep the value as written.
    const padded = render(
      "openclaw",
      externalSignInInput({
        github: undefined,
        oidc: {
          issuer: " https://sso.example.com/realms/acme ",
          authorizationUrl: "\thttps://sso.example.com/realms/acme/protocol/openid-connect/auth",
          tokenUrl: "\u00a0https://sso.example.com/realms/acme/protocol/openid-connect/token\ufeff",
          jwksUrl: "https://sso.example.com/realms/acme/protocol/openid-connect/certs\u3000",
        },
      }),
    );
    assert.equal(padded.summary.ok, true, padded.preflight.errors.join("\n"));
    assert.match(
      helmTemplate(padded),
      /name: OCC_AUTH_OIDC_ISSUER\n\s+value: " https:\/\/sso\.example\.com\/realms\/acme "/,
    );

    // Password-only installs behind ingress-nginx keep native admin and still trust the proxy.
    const nativeAdmin = render(
      "openclaw",
      baseInput({ controlPlane: { ...baseInput().controlPlane, trustedProxy } }),
    );
    assert.match(nativeAdmin.values, /agentNativeAdmin:\n {2}enabled: true/);
    assert.match(helmTemplate(nativeAdmin), /name: OCC_AUTH_TRUSTED_PROXY_PRESET/);
  },
);

// Operators render from a plain checkout: installation-profiles.md asks for `pnpm install`
// only with native admin, whose public suffix check loads tldts. Copy the sources the renderer
// can import, without any node_modules, into a directory outside the repository.
function checkoutWithoutDependencies() {
  const root = mkdtempSync(join(tmpdir(), "oce-profile-checkout-"));
  const sources = [
    "package.json",
    "scripts/render-installation-profile.mjs",
    "deploy/profiles",
    "apps/controller/package.json",
    "apps/controller/src",
    ...readdirSync(join(repository, "packages"))
      // Skip leftovers of a branch switch, such as a directory holding only node_modules.
      .filter((name) => existsSync(join(repository, "packages", name, "package.json")))
      .flatMap((name) => [`packages/${name}/package.json`, `packages/${name}/src`]),
  ];
  for (const source of sources) {
    cpSync(join(repository, source), join(root, source), {
      recursive: true,
      filter: (path) => !path.split(sep).includes("node_modules"),
    });
  }
  return root;
}

test("profiles render without installed dependencies unless native admin is on", (t) => {
  const root = checkoutWithoutDependencies();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [profile, input] of [
    ["openclaw", externalSignInInput()],
    ["codex", codexInput({ controlPlane: externalSignInInput().controlPlane })],
  ]) {
    const directory = mkdtempSync(join(tmpdir(), `oce-profile-${profile}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    let output;
    try {
      output = render(profile, input, directory, root);
    } catch (error) {
      assert.fail(`${profile} render failed without node_modules:\n${error.profileRendererOutput}`);
    }
    assert.equal(output.summary.ok, true, output.preflight.errors.join("\n"));
    assert.match(output.values, /agentNativeAdmin:\n {2}enabled: false\n/);
  }

  // Native admin needs the API's public suffix list, so it asks for the install, with a preflight.
  const directory = mkdtempSync(join(tmpdir(), "oce-profile-native-admin-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const error = renderError(() => render("openclaw", baseInput(), directory, root));
  assert.match(
    error.profileRendererOutput,
    /controlPlane\.sharedCookieDomain needs the public suffix list: run pnpm install first\./,
  );
  const preflight = JSON.parse(readFileSync(join(directory, "preflight.json"), "utf8"));
  assert.equal(preflight.ok, false);
  assert.equal(existsSync(join(directory, "values.yaml")), false);
});

test("preflight warns, without failing, when no trusted proxy is set", () => {
  const github = render("openclaw", externalSignInInput());
  assert.equal(github.summary.ok, true);
  assert.match(
    github.preflight.warnings.join("\n"),
    /controlPlane\.trustedProxy is not set: .*external sign-in starts have no per-client limit/,
  );
  assert.doesNotMatch(github.values, /trustedProxy:/);
  const password = render("openclaw", baseInput());
  assert.equal(password.summary.ok, true);
  assert.match(
    password.preflight.warnings.join("\n"),
    /controlPlane\.trustedProxy is not set: failed password sign-ins are limited per email only/,
  );
});

test("preflight rejects external sign-in and trusted proxy inputs Helm would reject", () => {
  assertPreflightFailure(
    "openclaw",
    externalSignInInput({ github: { allowedTeams: ["platform"] } }),
    /controlPlane.github.allowedTeams\[0\] must be a lowercase org\/team-slug entry/,
  );
  assertPreflightFailure(
    "openclaw",
    externalSignInInput({
      github: { allowedOrgs: Array.from({ length: 11 }, (_, index) => `org${index}`) },
    }),
    /allowedOrgs and allowedTeams list at most 10 entries together/,
  );
  assertPreflightFailure(
    "openclaw",
    externalSignInInput({ recoveryUserId: undefined }),
    /controlPlane.recoveryUserId is required with controlPlane.github, controlPlane.google or controlPlane.oidc/,
  );
  assertPreflightFailure(
    "openclaw",
    baseInput({ controlPlane: { ...baseInput().controlPlane, recoveryUserId: "admin" } }),
    /controlPlane.recoveryUserId requires controlPlane.github, controlPlane.google or controlPlane.oidc/,
  );
  assertPreflightFailure(
    "openclaw",
    baseInput({ controlPlane: { ...baseInput().controlPlane, passwordSignIn: "recovery-only" } }),
    /controlPlane.passwordSignIn requires controlPlane.github, controlPlane.google or controlPlane.oidc/,
  );
  assertPreflightFailure(
    "openclaw",
    externalSignInInput({ passwordSignIn: "none" }),
    /controlPlane.passwordSignIn must be all or recovery-only/,
  );
  assertPreflightFailure(
    "openclaw",
    externalSignInInput({ agentNativeAdminDomain: "agents.oce.example.internal" }),
    /controlPlane.agentNativeAdminDomain is not consumed with external sign-in/,
  );
  assertPreflightFailure(
    "openclaw",
    externalSignInInput({ authBaseUrl: "http://console.oce.example.internal" }),
    /controlPlane.authBaseUrl must use HTTPS with external sign-in/,
  );
  assertPreflightFailure(
    "openclaw",
    externalSignInInput({ github: { clientSecret: "inline" } }),
    /controlPlane.github.clientSecret is not supported/,
  );
  const oidc = {
    issuer: "https://tenant.idp.example.test/",
    authorizationUrl: "https://tenant.idp.example.test/authorize",
    tokenUrl: "https://tenant.idp.example.test/oauth/token",
    jwksUrl: "https://tenant.idp.example.test/.well-known/jwks.json",
  };
  for (const [override, message] of [
    [
      { issuer: "http://tenant.idp.example.test/" },
      /controlPlane.oidc.issuer must be an https URL/,
    ],
    [{ issuer: "https://203.0.113.10/" }, /controlPlane.oidc.issuer must be an https URL/],
    // Like the chart and the API: an explicit port on the issuer, and a value padded with
    // U+0085, which JavaScript's trim keeps.
    [
      { issuer: "https://tenant.idp.example.test:443/" },
      /controlPlane.oidc.issuer must be an https URL/,
    ],
    [
      { issuer: "\u0085https://tenant.idp.example.test/" },
      /controlPlane.oidc.issuer must be an https URL/,
    ],
    // Like the chart, though URL parsing repairs these into the issuer's host: a tab or a
    // percent-escape in the host, backslashes, and a host that is not spelled in ASCII.
    ...[
      "https://tenant.idp.exam\tple.test/",
      "https://tenant.idp.example.%74est/",
      "https:\\\\tenant.idp.example.test\\",
      "https://tenant.idp.examplé.test/",
      // A host longer than 253 characters.
      `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}.test/`,
    ].map((issuer) => [{ issuer }, /controlPlane.oidc.issuer must be an https URL/]),
    [
      { tokenUrl: "https://tenant.idp.exam\tple.test/oauth/token" },
      /controlPlane.oidc.tokenUrl must be an https URL on port 443 on the issuer's host/,
    ],
    [
      { tokenUrl: "https://other.example.test/token" },
      /controlPlane.oidc.tokenUrl must be an https URL on port 443 on the issuer's host/,
    ],
    [
      { jwksUrl: "https://tenant.idp.example.test:8443/jwks" },
      /controlPlane.oidc.jwksUrl must be an https URL on port 443 on the issuer's host/,
    ],
    [
      { authorizationUrl: "https://tenant.idp.example.test/authorize?x=1" },
      /controlPlane.oidc.authorizationUrl must be an https URL/,
    ],
    [{ tokenAuth: "private_key_jwt" }, /controlPlane.oidc.tokenAuth must be client_secret_post/],
    [{ displayName: "x".repeat(41) }, /controlPlane.oidc.displayName must be 1 to 40/],
    [{ discoveryUrl: "https://tenant.idp.example.test/" }, /controlPlane.oidc.discoveryUrl/],
  ]) {
    assertPreflightFailure(
      "openclaw",
      externalSignInInput({ github: undefined, oidc: { ...oidc, ...override } }),
      message,
    );
  }
  assertPreflightFailure(
    "openclaw",
    externalSignInInput({ github: undefined, oidc: { ...oidc, jwksUrl: undefined } }),
    /controlPlane.oidc.jwksUrl must be a nonempty string/,
  );
  assertPreflightFailure(
    "openclaw",
    externalSignInInput({ trustedProxy: { preset: "generic", cidrs: ["10.42.0.0/16"] } }),
    /controlPlane.trustedProxy.clientAddressHeader is required for the generic preset/,
  );
  assertPreflightFailure(
    "openclaw",
    externalSignInInput({ trustedProxy: { preset: "ingress-nginx", cidrs: ["0.0.0.0/0"] } }),
    /controlPlane.trustedProxy.cidrs\[0\] must be/,
  );
});

test("profiles refuse installation names the chart and the bootstrap Job refuse", () => {
  const accepted = render(
    "openclaw",
    baseInput({
      controlPlane: { ...baseInput().controlPlane, clusterName: "n".repeat(200) },
    }),
  );
  assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
  assert.match(accepted.values, /name: n{200}\n/);
  for (const clusterName of [" profile", `${"n".repeat(201)}`, "bad\nname", "\uD800"]) {
    assertPreflightFailure(
      "openclaw",
      baseInput({ controlPlane: { ...baseInput().controlPlane, clusterName } }),
      /controlPlane.clusterName must be 1 to 200 characters/,
    );
  }
});

test("preflight rejects CIDR prefixes with a leading zero", () => {
  const controlPlane = baseInput().controlPlane;
  assertPreflightFailure(
    "openclaw",
    baseInput({
      controlPlane: { ...controlPlane, databaseCidrs: ["192.0.2.10/032"] },
    }),
    /controlPlane\.databaseCidrs\[0\] must be an IPv4 \/32 CIDR/,
  );
  assertPreflightFailure(
    "openclaw",
    baseInput({
      controlPlane: { ...controlPlane, gatewayTrustedProxyCidrs: ["192.0.2.12/08"] },
    }),
    /controlPlane\.gatewayTrustedProxyCidrs\[0\] must be an IPv4 CIDR/,
  );
  assertPreflightFailure(
    "openclaw",
    baseInput({
      controlPlane: {
        ...controlPlane,
        trustedProxy: { preset: "ingress-nginx", cidrs: ["2001:db8::/032"] },
      },
    }),
    /controlPlane\.trustedProxy\.cidrs\[0\] must be an IPv4 or IPv6 CIDR/,
  );
  const accepted = render(
    "openclaw",
    baseInput({
      controlPlane: { ...controlPlane, gatewayTrustedProxyCidrs: ["192.0.2.12/8"] },
    }),
  );
  assert.match(accepted.installation, /192\.0\.2\.12\/8/);
});

test("preflight rejects channel proxy URLs with an invalid octet or port", () => {
  const message = /must be an HTTP\(S\) literal IPv4 endpoint with an explicit port/;
  assertPreflightFailure(
    "openclaw",
    baseInput({ channels: { directoryProxyUrl: "http://192.0.2.999:8080" } }),
    message,
  );
  assertPreflightFailure(
    "openclaw",
    baseInput({ channels: { runtimeProxyUrl: "http://192.0.2.10:99999" } }),
    message,
  );
  const accepted = render(
    "openclaw",
    baseInput({
      channels: {
        directoryProxyUrl: "http://192.0.2.10:8080",
        runtimeProxyUrl: "http://192.0.2.10:8080",
      },
    }),
  );
  assert.match(accepted.values, /channelDirectoryProxyUrl: http:\/\/192\.0\.2\.10:8080/);
  assert.match(accepted.installation, /proxyUrl: http:\/\/192\.0\.2\.10:8080/);
  KubernetesComputeDriver.validateConfiguration(
    loadYaml(accepted.installation).drivers.compute.configuration,
  );
});

for (const profile of ["openclaw", "codex"]) {
  for (const proxyUrl of ["http://192.0.2.10:80", "https://192.0.2.10:443"]) {
    test(`${profile} preserves explicit default channel proxy port in ${proxyUrl}`, (t) => {
      const input = profile === "codex" ? codexInput() : baseInput();
      input.channels = { directoryProxyUrl: proxyUrl, runtimeProxyUrl: proxyUrl };
      const output = render(profile, input);
      t.after(() => rmSync(output.directory, { recursive: true, force: true }));
      assert.equal(output.preflight.ok, true);
      assert.equal(loadYaml(output.values).api.channelDirectoryProxyUrl, proxyUrl);
      const compute = loadYaml(output.installation).drivers.compute.configuration;
      assert.equal(compute.runtime.channels.proxyUrl, proxyUrl);
      // Installation validation runs even before an Agent enables a channel.
      assert.doesNotThrow(() => KubernetesComputeDriver.validateConfiguration(compute));
    });
  }
}

test("channel proxy validation preserves explicit ports and exact managed peers", (t) => {
  const output = render("openclaw", baseInput());
  t.after(() => rmSync(output.directory, { recursive: true, force: true }));
  const compute = loadYaml(output.installation).drivers.compute.configuration;
  const managed = structuredClone(compute.runtime.channels);
  assert.equal(managed.managedProxy.port, 3128);
  KubernetesComputeDriver.validateConfiguration(compute);

  // IPv6 is supported by Compute directly; profile input intentionally remains IPv4-only.
  for (const proxyUrl of [
    " http://192.0.2.10:8080 ",
    "http://[2001:db8::10]:80",
    "https://[2001:db8::10]:443/",
    "http://192.0.2.10:443",
    "https://192.0.2.10:80/",
  ]) {
    compute.runtime.channels = { proxyUrl };
    assert.doesNotThrow(() => KubernetesComputeDriver.validateConfiguration(compute), proxyUrl);
  }
  for (const [scheme, port] of [
    ["http", 80],
    ["https", 443],
  ]) {
    compute.runtime.channels = {
      ...managed,
      proxyUrl: `${scheme}://${managed.managedProxy.hostname}:${port}/`,
      managedProxy: { ...managed.managedProxy, port },
    };
    assert.doesNotThrow(() => KubernetesComputeDriver.validateConfiguration(compute));
  }

  for (const proxyUrl of [
    "http://192.0.2.10",
    "https://[2001:db8::10]",
    "http://192.0.2.10:0",
    "http://192.0.2.10:65536",
    syntheticCredentialUrl({
      protocol: "http",
      username: "proxy-user",
      password: "synthetic-password",
      host: "192.0.2.10",
      port: 80,
    }),
    "http://192.0.2.10:80/path",
    "http://192.0.2.10:80?query=1",
    "https://192.0.2.10:443#fragment",
    "ftp://192.0.2.10:80",
    "http://proxy.example.invalid:80",
  ]) {
    compute.runtime.channels = { proxyUrl };
    assert.throws(() => KubernetesComputeDriver.validateConfiguration(compute), /Channel proxy/i);
  }
  // A valid peer grant never authorizes a different Service, port, or URL credentials.
  for (const proxyUrl of [
    "http://other.openclaw-system.svc:80",
    `http://${managed.managedProxy.hostname}:443`,
    `http://${managed.managedProxy.hostname}`,
    syntheticCredentialUrl({
      protocol: "http",
      username: "proxy-user",
      password: "synthetic-password",
      host: managed.managedProxy.hostname,
      port: 80,
    }),
  ]) {
    compute.runtime.channels = {
      ...managed,
      proxyUrl,
      managedProxy: { ...managed.managedProxy, port: 80 },
    };
    assert.throws(() => KubernetesComputeDriver.validateConfiguration(compute), /channel proxy/i);
  }
});

test("channel proxy validation preserves omitted-port endpoint diagnostics", (t) => {
  const output = render("openclaw", baseInput());
  t.after(() => rmSync(output.directory, { recursive: true, force: true }));
  const compute = loadYaml(output.installation).drivers.compute.configuration;
  const managed = structuredClone(compute.runtime.channels);

  for (const proxyUrl of [
    "http://192.0.2.10",
    "https://[2001:db8::10]",
    "http://proxy.example.invalid:8080",
    "http://192.0.2.10:8080/path",
  ]) {
    compute.runtime.channels = { proxyUrl };
    assert.throws(() => KubernetesComputeDriver.validateConfiguration(compute), {
      message: "Channel proxy URL must identify one credential-free HTTP(S) IP endpoint.",
    });
  }
  for (const proxyUrl of [
    `http://${managed.managedProxy.hostname}`,
    `http://${managed.managedProxy.hostname}:8080`,
    "http://other.openclaw-system.svc:3128",
  ]) {
    compute.runtime.channels = { ...managed, proxyUrl };
    assert.throws(() => KubernetesComputeDriver.validateConfiguration(compute), {
      message: "Managed channel proxy URL must match the exact configured Service host and port.",
    });
  }
});

test("profiles refuse database CA keys the chart refuses", () => {
  const withCa = (key) =>
    baseInput({
      controlPlane: {
        ...baseInput().controlPlane,
        databaseCa: { secretName: "occ-db-ca", ...(key === undefined ? {} : { key }) },
      },
    });
  const accepted = render("openclaw", withCa("db_ca.pem"));
  assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
  assert.match(accepted.values, /caKey: db_ca.pem/);
  const omitted = render("openclaw", withCa(undefined));
  assert.equal(omitted.summary.ok, true, omitted.preflight.errors.join("\n"));
  assert.match(omitted.values, /caKey: ca.pem/);
  for (const key of [".", "..", "ca/pem", "ca pem"]) {
    assertPreflightFailure(
      "openclaw",
      withCa(key),
      /controlPlane.databaseCa.key must be a simple basename/,
    );
  }
});

test("profiles refuse ChatGPT credential lifetimes the API refuses", () => {
  const accounts = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    adminSecretName: "occ-chatgpt-admin",
    adminSecretKey: "admin-key",
    providerCidr: "192.0.2.21/32",
  };
  const accepted = render(
    "codex",
    managedCodexInput({
      codex: { managedServiceAccounts: { ...accounts, credentialTtlSeconds: 2_592_000 } },
    }),
  );
  assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
  assert.match(accepted.installation, /credentialTtlSeconds: 2592000/);
  assertPreflightFailure(
    "codex",
    managedCodexInput({
      codex: { managedServiceAccounts: { ...accounts, credentialTtlSeconds: 2_592_001 } },
    }),
    /codex.managedServiceAccounts.credentialTtlSeconds must be an integer from 1 through 2592000/,
  );
});

test("profiles refuse administrator emails the bootstrap Job refuses", () => {
  const accepted = render(
    "openclaw",
    baseInput({
      controlPlane: { ...baseInput().controlPlane, adminEmail: " Admin@Example.invalid " },
    }),
  );
  assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
  assert.match(accepted.values, /adminEmail: " Admin@Example.invalid "/);
  for (const adminEmail of ["not-an-email", "admin@example", "a @b.c"]) {
    assertPreflightFailure(
      "openclaw",
      baseInput({ controlPlane: { ...baseInput().controlPlane, adminEmail } }),
      /controlPlane.adminEmail must be a valid administrator email/,
    );
  }
});

test("preflight rejects a Google hosted domain the chart and API refuse", () => {
  const label63 = `a${"b".repeat(61)}c`;
  const domain254 = [label63, label63, label63, `d${"e".repeat(60)}f`].join(".");
  const domain253 = [label63, label63, label63, `d${"e".repeat(59)}f`].join(".");
  assert.equal(domain254.length, 254);
  assert.equal(domain253.length, 253);
  const googleInput = (allowedDomains) =>
    externalSignInInput({
      github: undefined,
      google: { allowedDomains },
    });
  for (const allowedDomains of [["example.123"], ["example.1"], [domain254]]) {
    assertPreflightFailure(
      "openclaw",
      googleInput(allowedDomains),
      /controlPlane\.google\.allowedDomains\[0\] must be a lowercase DNS domain name of at most 253 characters whose last label starts with a letter, such as example\.com/,
    );
  }
  const accepted = render("openclaw", googleInput([domain253]));
  assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
  assert.match(accepted.values, new RegExp(domain253));
});

test("profiles refuse gateway namespaces the compute driver refuses", () => {
  const configured = conformanceKubernetesOptions({
    gatewayTrustedProxyCidrs: ["10.42.0.0/16"],
  });
  const { gatewayClients: _gatewayClients, ...network } = configured.network;
  const routing = {
    hostname: "agents.example.internal",
    gatewayName: "oce-agent-gateways",
    gatewayNamespace: "openclaw-system",
    envoyNamespace: "envoy-gateway-system",
  };
  const admit = (gatewayRouting) =>
    createKubernetesComputeDriver({ ...configured, network, gatewayRouting });
  // A Kubernetes Namespace name is a DNS label of at most 63 characters, with no dots.
  // The Gateway namespace is also an owning-gateway-namespace label value.
  const namespaceMessage =
    /controlPlane\.namespace must be a Kubernetes namespace name \(a DNS label of at most 63 characters\)/;
  const envoyMessage =
    /controlPlane\.envoyNamespace must be a Kubernetes namespace name \(a DNS label of at most 63 characters\)/;
  const controlPlane = baseInput().controlPlane;
  const refused = [
    "openclaw/system",
    "OpenClaw",
    "foo_bar",
    "-system",
    "system-",
    "a".repeat(64),
    "a".repeat(253),
    "gateway.example",
    "openclaw-system ",
  ];
  for (const namespace of refused) {
    assertPreflightFailure(
      "openclaw",
      baseInput({ controlPlane: { ...controlPlane, namespace } }),
      namespaceMessage,
    );
    assert.throws(
      () => admit({ ...routing, gatewayNamespace: namespace }),
      /Gateway routing Gateway namespace must be a Kubernetes namespace name/,
    );
  }
  for (const envoyNamespace of refused) {
    assertPreflightFailure(
      "openclaw",
      baseInput({ controlPlane: { ...controlPlane, envoyNamespace } }),
      envoyMessage,
    );
    assert.throws(
      () => admit({ ...routing, envoyNamespace }),
      /Gateway routing Envoy namespace must be a Kubernetes namespace name/,
    );
  }
  const namespace = "a".repeat(63);
  const envoyNamespace = `${"b".repeat(62)}9`;
  const output = render(
    "openclaw",
    baseInput({ controlPlane: { ...controlPlane, namespace, envoyNamespace } }),
  );
  assert.equal(output.summary.ok, true);
  assert.match(output.installation, new RegExp(`gatewayNamespace: ${namespace}`));
  assert.match(output.installation, new RegExp(`envoyNamespace: ${envoyNamespace}`));
  assert.doesNotThrow(() => admit({ ...routing, gatewayNamespace: namespace, envoyNamespace }));
});

test("preflight rejects Codex seccomp paths the compute driver refuses", () => {
  const message =
    /runtime\.codexSeccompProfile must be a relative localhost profile path without traversal or unconfined mode/;
  for (const codexSeccompProfile of [
    "/profiles/codex.json",
    "../codex.json",
    "profiles/../codex.json",
    "profiles//codex.json",
    "unconfined",
    "profiles/unconfined",
    "profiles\\codex.json",
  ]) {
    assertPreflightFailure("codex", codexInput({ runtime: { codexSeccompProfile } }), message);
  }
  const accepted = render("codex", codexInput());
  const installation = loadYaml(accepted.installation);
  KubernetesComputeDriver.validateConfiguration(installation.drivers.compute.configuration);
  assert.match(accepted.installation, /codexSeccompProfile: profiles\/codex\.json/);
});

test("profile transport Secret prefixes agree with controller startup admission", async (t) => {
  const baseline = render("openclaw", baseInput());
  t.after(() => rmSync(baseline.directory, { recursive: true, force: true }));
  const prefixes = [
    ["transport", true],
    ["transport-", true],
    ["tenant.transport", true],
    ["a".repeat(240), true],
    ["Bad_Prefix", false],
    ["transport/agent", false],
    ["transport.", false],
    ["a".repeat(241), false],
  ];
  for (const [prefix, accepted] of prefixes) {
    const input = baseInput();
    input.runtime.transportSecretPrefix = prefix;
    if (accepted) {
      const output = render("openclaw", input);
      t.after(() => rmSync(output.directory, { recursive: true, force: true }));
      await loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: join(output.directory, "installation.yaml") },
      });
    } else {
      assertPreflightFailure("openclaw", input, /runtime\.transportSecretPrefix/);
      const installation = loadYaml(baseline.installation);
      installation.drivers.compute.configuration.runtime.transportSecretPrefix = prefix;
      const path = join(baseline.directory, "invalid-installation.json");
      writeFileSync(path, JSON.stringify(installation));
      await assert.rejects(
        loadInstallationConfiguration({
          mode: "production",
          environment: { OCC_CONFIG_PATH: path },
        }),
        /runtime\.transportSecretPrefix/,
      );
    }
  }
});
