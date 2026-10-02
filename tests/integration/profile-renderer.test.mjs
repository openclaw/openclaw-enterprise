import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { loadStartupConfigurationSnapshot } from "../../apps/controller/src/composition/installation-config.ts";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";

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

function render(
  profile,
  input,
  directory = mkdtempSync(join(tmpdir(), `oce-profile-${profile}-`)),
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
      { cwd: repository, encoding: "utf8" },
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
const tenantRuntimeResources = {
  requests: { cpu: "100m", memory: "128Mi" },
  limits: { cpu: "4", memory: "2Gi" },
};
// An OpenClaw Gateway settles near 1.2 GiB once it has served a few turns, so
// its memory request reserves that much. A dedicated Codex Gateway with native
// admin chat peaked at 1.9 GiB and was OOM-killed at 2Gi, so its limit is 3Gi.
const gatewayResources = {
  requests: { cpu: "100m", memory: "1280Mi" },
  limits: { cpu: "4", memory: "3Gi" },
};

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
    assert.deepEqual(resources.agent, tenantRuntimeResources, `${name} Harness`);
    assert.deepEqual(
      resources.namespace.containerDefaults,
      tenantRuntimeResources,
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
        const gatewayName = gateway.match(/^ {2}name: (\S+)$/m)?.[1];
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
    input.repository = {
      enabled: true,
      image: `registry.example.invalid/openclaw-enterprise/repository-credentials@sha256:${digestC}`,
      backendId: "github-primary",
      registryConfigMapName: "occ-repository-registry-v1",
      serviceConfigSecretName: "occ-repository-service-config",
      appKeySecretName: "occ-repository-app-key",
      tlsSecretName: "occ-repository-tls",
      publicCaSecretName: "occ-repository-public-ca",
      upstreamCidrs: ["140.82.112.0/20", "192.30.252.0/22"],
    };
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

test("profile preset files reject malformed paths and unknown settings", () => {
  for (const files of ["presets/custom.json", [""], [42]]) {
    assertPreflightFailure("codex", codexInput({ presets: { files } }), /presets.files/);
  }
  assertPreflightFailure("codex", codexInput({ presets: { unknown: true } }), /presets.unknown/);
});

test("Helm catches generated profile Secret collisions", { skip: helmSkip }, () => {
  const repositoryOutput = render(
    "codex",
    managedCodexInput({
      repository: {
        enabled: true,
        image: `registry.example.invalid/openclaw-enterprise/repository-credentials@sha256:${digestC}`,
        backendId: "github-primary",
        registryConfigMapName: "occ-repository-registry-v1",
        serviceConfigSecretName: "occ-repository-service-config",
        appKeySecretName: "occ-repository-app-key",
        tlsSecretName: "occ-repository-tls",
        publicCaSecretName: "occ-repository-public-ca",
        upstreamCidrs: ["192.0.2.30/32"],
      },
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
    /repositoryCredentials\.serviceConfigSecretName must use a dedicated Secret distinct from chatgpt/,
  );
});

test("label values that YAML 1.1 would retype stay strings", () => {
  const labels = {
    spot: "no",
    enabled: "on",
    legacy: "Off",
    short: "y",
    scale: "1e3",
    hex: "0x1f",
    octal: "0o17",
    sexagesimal: "1:20",
    infinity: ".inf",
    team: "@platform",
    trailing: "zone:",
    yes: "keep",
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
  input.controlPlane.nodeSelector = { spot: "no", scale: "1e3", team: "@platform" };
  const manifests = helmTemplate(render("openclaw", input));
  assert.match(manifests, /spot: ["']no["']/);
  assert.match(manifests, /scale: ["']1e3["']/);
  assert.match(manifests, /team: ["']@platform["']/);
  assert.doesNotMatch(manifests, /spot: false/);
});

test("renderer rejects the removed default profile", () => {
  assert.throws(() => render("default", baseInput()), /--profile must be one of: openclaw, codex/);
});

test("repository opt-in is explicit and keeps the two-stage placeholders separate", () => {
  const output = render(
    "codex",
    codexInput({
      repository: {
        enabled: true,
        image: `registry.example.invalid/openclaw-enterprise/repository-credentials@sha256:${digestC}`,
        backendId: "github-primary",
        registryConfigMapName: "occ-repository-registry-v1",
        serviceConfigSecretName: "occ-repository-service-config",
        appKeySecretName: "occ-repository-app-key",
        tlsSecretName: "occ-repository-tls",
        publicCaSecretName: "occ-repository-public-ca",
        upstreamCidrs: ["192.0.2.30/32"],
      },
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
  const repositoryInput = {
    enabled: true,
    image: `registry.example.invalid/openclaw-enterprise/repository-credentials@sha256:${digestC}`,
    backendId: "github-primary",
    registryConfigMapName: "occ-repository-registry-v1",
    serviceConfigSecretName: "occ-repository-service-config",
    appKeySecretName: "occ-repository-app-key",
    tlsSecretName: "occ-repository-tls",
    publicCaSecretName: "occ-repository-public-ca",
    upstreamCidrs: ["192.0.2.30/32"],
  };
  const omitted = render("codex", codexInput({ repository: repositoryInput }));
  assert.doesNotMatch(omitted.values, /serviceName: git/);
  if (!helmSkip) {
    assert.match(helmTemplate(omitted), /name: git\n/);
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
    assert.match(helmTemplate(kept, [], "oce", ["--is-upgrade"]), /name: oce-git\n/);
  }
});

test("preflight rejects inputs that the selected profile does not consume", () => {
  assertPreflightFailure(
    "openclaw",
    baseInput({
      runtime: {
        ...baseInput().runtime,
        codexSeccompProfile: "profiles/codex.json",
      },
    }),
    /runtime.codexSeccompProfile is only consumed by the codex profile/,
  );

  assertPreflightFailure(
    "codex",
    codexInput({
      repository: {
        enabled: false,
        backendId: "github-primary",
      },
    }),
    /repository fields other than enabled are only consumed/,
  );
});

test("preflight rejects invalid CIDRs before rendering", () => {
  assertPreflightFailure(
    "codex",
    codexInput({
      controlPlane: {
        ...baseInput().controlPlane,
        databaseCidrs: ["999.999.999.999/32"],
      },
    }),
    /controlPlane.databaseCidrs\[0\] must be an IPv4 \/32 CIDR/,
  );

  assertPreflightFailure(
    "codex",
    managedCodexInput({
      codex: {
        modelDiscoveryCidrs: ["192.0.2.20/32"],
        managedServiceAccounts: {
          workspaceId: "11111111-1111-4111-8111-111111111111",
          adminSecretName: "occ-chatgpt-admin",
          providerCidr: "999.999.999.999/32",
        },
      },
    }),
    /codex.managedServiceAccounts.providerCidr must be an IPv4 \/32 CIDR/,
  );
});

test("preflight rejects metrics and native admin inputs that Helm would reject", () => {
  assertPreflightFailure(
    "codex",
    codexInput({
      controlPlane: {
        ...baseInput().controlPlane,
        metrics: {
          scraperNamespaceLabels: { name: "monitoring" },
        },
      },
    }),
    /controlPlane.metrics requires both scraperNamespaceLabels and scraperPodLabels, or neither/,
  );

  assertPreflightFailure(
    "codex",
    codexInput({
      controlPlane: {
        ...baseInput().controlPlane,
        agentNativeAdminDomain: "https://agents.oce.example.internal",
      },
    }),
    /controlPlane.agentNativeAdminDomain must be a DNS hostname without a wildcard, port, scheme, or path/,
  );

  assertPreflightFailure(
    "codex",
    codexInput({
      controlPlane: {
        ...baseInput().controlPlane,
        agentNativeAdminDomain: "agents.other.example.internal",
      },
    }),
    /controlPlane.agentNativeAdminDomain must be inside controlPlane.sharedCookieDomain/,
  );
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
    "https://user:pass@grafana.example.internal",
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

    // Password-only installs behind ingress-nginx keep native admin and still trust the proxy.
    const nativeAdmin = render(
      "openclaw",
      baseInput({ controlPlane: { ...baseInput().controlPlane, trustedProxy } }),
    );
    assert.match(nativeAdmin.values, /agentNativeAdmin:\n {2}enabled: true/);
    assert.match(helmTemplate(nativeAdmin), /name: OCC_AUTH_TRUSTED_PROXY_PRESET/);
  },
);

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
