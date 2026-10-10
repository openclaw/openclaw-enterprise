import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { clientAddressConfiguration } from "../../apps/controller/src/auth/client-address.ts";
import { createKubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";

// Each case runs through the profile preflight and through `helm template`, so the
// renderer cannot accept a value the chart then refuses (or refuse one it accepts).
const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";
let helmSkip = false;
try {
  execFileSync(helm, ["version", "--short"], { cwd: repository, stdio: "ignore" });
} catch {
  helmSkip = "Install Helm, or set OCC_HELM_BIN, to compare the preflight with the chart.";
}

function input(controlPlane) {
  return {
    controlPlane: {
      releaseName: "oce",
      namespace: "openclaw-system",
      clusterName: "profile-qualification",
      controllerImage: `registry.example.invalid/openclaw-enterprise/controller@sha256:${"a".repeat(64)}`,
      authBaseUrl: "https://console.oce.example.internal",
      adminEmail: "admin@example.invalid",
      bootstrapPasswordClaimName: "occ-bootstrap-admin-password",
      apiClients: [{ namespace: "operator-tools", podLabels: { app: "occ-operator" } }],
      databaseCidrs: ["192.0.2.10/32"],
      clusterCidrs: ["192.0.2.11/32"],
      dns: { namespace: "kube-system", podLabels: { "k8s-app": "kube-dns" } },
      gatewayClassName: "eg",
      gatewayApiKeySecretName: "occ-private-gateway-key",
      gatewayTrustedProxyCidrs: ["192.0.2.12/32"],
      pluginStatusProxySourceCidrs: ["192.0.2.13/32"],
      nodeSelector: { "oce-role": "control" },
      metrics: {
        scraperNamespaceLabels: { name: "monitoring" },
        scraperPodLabels: { app: "prometheus" },
      },
      recoveryUserId: "recovery-admin_1",
      github: { egressCidrs: ["140.82.112.0/20"] },
      trustedProxy: { preset: "ingress-nginx", cidrs: ["10.42.0.0/16"] },
      ...controlPlane,
    },
    runtime: {
      image: `registry.example.invalid/openclaw-enterprise/runtime@sha256:${"b".repeat(64)}`,
      gatewayStorageClassName: "occ-gateway-rwo",
      nodeSelector: { "oce-role": "agents" },
      gatewayNodeSelector: { "oce-role": "control" },
      transportSecretPrefix: "openclaw-agent-transport",
    },
    channels: { managedSlackProxy: true },
  };
}

function run(command, args) {
  try {
    const output = execFileSync(command, args, {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 4_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

// Renders a known-good profile once; refused cases override one field of its values.
let baseline;
after(() => baseline && rmSync(baseline.directory, { recursive: true, force: true }));
function baselineDirectory() {
  baseline ??= renderProfile(input({}));
  assert.equal(baseline.renderer.ok, true, baseline.renderer.output);
  return baseline.directory;
}

function renderProfile(profileInput, profile = "openclaw") {
  const directory = mkdtempSync(join(tmpdir(), "oce-profile-parity-"));
  writeFileSync(join(directory, "input.json"), JSON.stringify(profileInput));
  const renderer = run(process.execPath, [
    "scripts/render-installation-profile.mjs",
    "--profile",
    profile,
    "--input",
    join(directory, "input.json"),
    "--out-dir",
    directory,
  ]);
  return { directory, renderer };
}

function helmTemplate(valueFiles) {
  return run(helm, [
    "template",
    "oce",
    "deploy/helm/openclaw-enterprise",
    "--namespace",
    "openclaw-system",
    ...valueFiles.flatMap((path) => ["--values", path]),
  ]);
}

// An override values file. Helm's YAML parser would drop or fold a raw U+FEFF, U+0085 or
// C1 control, so escape those (the cases below use no U+FFFE or U+FFFF).
function writeOverride(directory, values) {
  const path = join(directory, "override.json");
  writeFileSync(
    path,
    JSON.stringify(values).replace(
      /[\u007f-\u009f\u2028\u2029\ufeff]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ),
  );
  return path;
}

// The renderer's own values must render when it accepts. When it refuses, the same value
// placed over a good profile must make the chart refuse too, with the expected message.
// Returns the chart's manifests when both accept.
function assertParity({
  label,
  controlPlane,
  values,
  accepted,
  chartError,
  profile = "openclaw",
  extraInput = {},
}) {
  const { directory, renderer } = renderProfile({ ...input(controlPlane), ...extraInput }, profile);
  try {
    assert.equal(renderer.ok, accepted, `${label}: renderer\n${renderer.output}`);
    if (!accepted) {
      assert.equal(existsSync(join(directory, "values.yaml")), false);
      assert.equal(existsSync(join(directory, "installation.yaml")), false);
    }
    let chart;
    if (accepted) {
      chart = helmTemplate([join(directory, "values.yaml")]);
    } else {
      chart = helmTemplate([
        join(baselineDirectory(), "values.yaml"),
        writeOverride(directory, values),
      ]);
    }
    assert.equal(chart.ok, accepted, `${label}: helm template\n${chart.output}`);
    if (!accepted) {
      assert.match(chart.output, chartError, label);
    }
    return chart.output;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const cidrCases = [
  ["10.42.0.0/16", true],
  ["2001:db8::/32", true],
  ["2001:DB8::/32", true],
  ["2001:db8::1.2.3.4/64", true],
  ["::ffff:192.0.2.1/32", true],
  ["::ffff:192.0.2.0/24", true],
  ["::ffff:c000:201/32", true],
  ["::/96", true],
  ["::/81", true],
  ["::FFFF:C000:201/24", true],
  ["fe80::1%eth0/64", false, /contains an invalid IPv6 address|requires IPv4 or IPv6 CIDRs/],
  ["::ffff:192.0.2.1/96", false, /IPv4-mapped address, whose prefix must be 1 through 32/],
  ["::ffff:192.0.2.1/128", false, /IPv4-mapped address, whose prefix must be 1 through 32/],
  ["::ffff:0:0/96", false, /IPv4-mapped address, whose prefix must be 1 through 32/],
  ["::ffff:c000:201/64", false, /IPv4-mapped address, whose prefix must be 1 through 32/],
  ["::/80", false, /must not trust every address/],
  ["::/64", false, /must not trust every address/],
  ["::/1", false, /must not trust every address/],
  ["::fffe:0:0/95", false, /must not trust every address/],
  ["::1.2.3.4/80", false, /must not trust every address/],
  ["::8000:0:0/81", false, /must not trust every address/],
  ["0:0:0:0:0:ffff:192.0.2.1/33", false, /IPv4-mapped address, whose prefix must be 1 through 32/],
  ["2001:db8::/0", false, /requires IPv4 or IPv6 CIDRs with a nonzero prefix/],
  ["10.42.0.0/33", false, /requires IPv4 or IPv6 CIDRs with a nonzero prefix/],
];

test(
  "trusted proxy CIDRs get the same verdict from the preflight and the chart",
  {
    skip: helmSkip,
  },
  () => {
    for (const [cidr, accepted, chartError] of cidrCases) {
      assertParity({
        label: cidr,
        controlPlane: { trustedProxy: { preset: "ingress-nginx", cidrs: [cidr] } },
        values: { api: { trustedProxy: { preset: "ingress-nginx", cidrs: [cidr] } } },
        accepted,
        chartError,
      });
    }
  },
);

// A Kubernetes Namespace name is a DNS label of at most 63 characters, with no dots.
const namespaceCases = [
  ["envoy-gateway-system", true],
  ["a", true],
  ["1abc", true],
  ["a".repeat(63), true],
  ["a".repeat(64), false],
  ["a".repeat(253), false],
  ["gateway.example", false],
  ["a.b", false],
  ["Envoy", false],
  ["-system", false],
  ["system-", false],
  ["envoy/system", false],
  ["foo_bar", false],
];

test(
  "envoy namespaces get the same verdict from the preflight, the chart and Compute",
  { skip: helmSkip },
  () => {
    const configured = conformanceKubernetesOptions({
      gatewayTrustedProxyCidrs: ["10.42.0.0/16"],
    });
    const { gatewayClients: _gatewayClients, ...network } = configured.network;
    const routing = {
      hostname: "agents.example.internal",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
    };
    const chartError =
      /gatewayRouting\.envoyNamespace must be a Kubernetes namespace name \(a DNS label of at most 63 characters\)/;
    for (const [envoyNamespace, accepted] of namespaceCases) {
      const label =
        envoyNamespace.length > 40 ? `${envoyNamespace.length} characters` : envoyNamespace;
      assertParity({
        label,
        controlPlane: { envoyNamespace },
        values: { gatewayRouting: { envoyNamespace } },
        accepted,
        chartError,
      });
      let driverAccepted = true;
      try {
        createKubernetesComputeDriver({
          ...configured,
          network,
          gatewayRouting: { ...routing, envoyNamespace },
        });
      } catch (error) {
        assert.match(
          error.message,
          /Gateway routing Envoy namespace must be a Kubernetes namespace name/,
          label,
        );
        driverAccepted = false;
      }
      assert.equal(driverAccepted, accepted, `${label}: Compute`);
    }
  },
);

// The observability demo chart selects the same DNS peer; it has no renderer.
function renderDemoChart(values) {
  const directory = mkdtempSync(join(tmpdir(), "oce-demo-parity-"));
  try {
    const path = join(directory, "values.json");
    writeFileSync(path, JSON.stringify(values));
    return run(helm, [
      "template",
      "demo",
      "deploy/helm/openclaw-observability-demo",
      "--namespace",
      "oce-observability-demo",
      ...[
        "occ.namespace=openclaw-system",
        "occ.release=oce",
        "cluster.cidrs[0]=10.43.0.1/32",
        "grafana.adminSecretName=grafana-admin",
      ].flatMap((value) => ["--set", value]),
      "--values",
      path,
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test(
  "API client and DNS peer namespaces get the same verdict from the preflight, the charts and Compute",
  { skip: helmSkip },
  () => {
    const podLabels = { app: "occ-operator" };
    const dnsLabels = { "k8s-app": "kube-dns" };
    const configured = conformanceKubernetesOptions({
      gatewayTrustedProxyCidrs: ["10.42.0.0/16"],
    });
    for (const [namespace, accepted] of namespaceCases) {
      const label = namespace.length > 40 ? `${namespace.length} characters` : namespace;
      assertParity({
        label: `apiClients ${label}`,
        controlPlane: { apiClients: [{ namespace, podLabels }] },
        values: { api: { clients: [{ namespace, podLabels }] } },
        accepted,
        chartError:
          /api\.clients\[0\]\.namespace must be a Kubernetes namespace name \(a DNS label of at most 63 characters\)/,
      });
      assertParity({
        label: `dns ${label}`,
        controlPlane: { dns: { namespace, podLabels: dnsLabels } },
        values: { dns: { namespace, podLabels: dnsLabels } },
        accepted,
        chartError:
          /dns\.namespace must be a Kubernetes namespace name \(a DNS label of at most 63 characters\)/,
      });
      const demo = renderDemoChart({ dns: { namespace, podLabels: dnsLabels } });
      assert.equal(demo.ok, accepted, `dns ${label}: demo chart\n${demo.output}`);
      if (!accepted) {
        assert.match(
          demo.output,
          /dns\.namespace must be a Kubernetes namespace name \(a DNS label of at most 63 characters\)/,
          label,
        );
      }
      let driverAccepted = true;
      try {
        createKubernetesComputeDriver({
          ...configured,
          network: { ...configured.network, dns: { namespace, podLabels: dnsLabels } },
        });
      } catch (error) {
        assert.match(
          error.message,
          /DNS peer namespace must be a Kubernetes namespace name/,
          label,
        );
        driverAccepted = false;
      }
      assert.equal(driverAccepted, accepted, `dns ${label}: Compute`);
    }
  },
);

// The API is looser than the chart on input outside this table: it trims whitespace and
// takes a bare address as a single host. Preflight and the chart refuse both.
test("every trusted proxy CIDR in the table gets the API's verdict, apart from zone IDs", () => {
  for (const [cidr, accepted] of cidrCases) {
    const configure = () =>
      clientAddressConfiguration({
        OCC_AUTH_TRUSTED_PROXY_CIDRS: cidr,
        OCC_AUTH_TRUSTED_PROXY_PRESET: "ingress-nginx",
      });
    // The API takes a zone ID as Node's isIP does; the chart and the preflight refuse it.
    if (accepted || cidr.includes("%")) {
      assert.doesNotThrow(configure, cidr);
    } else {
      assert.throws(configure, /OCC_AUTH_TRUSTED_PROXY_CIDRS/, cidr);
    }
  }
});

test("node selectors get the same verdict from preflight and the chart", { skip: helmSkip }, () => {
  const selectors = [
    [{ "oce-role": "control" }, true],
    [{ "topology.kubernetes.io/zone": "east" }, true],
    [{ spot: "no", scale: "1e3", hex: "0x1f" }, true],
    [{ ["a".repeat(63)]: "b".repeat(63) }, true],
    // Kubernetes allows empty label values, a common node-role pattern.
    [{ "node-role.kubernetes.io/infra": "" }, true],
    [{ "node-role.kubernetes.io/infra": "", "oce-role": "control" }, true],
    [{ "oce-role": "a" }, true],
    [{ "oce-role": "A_b.c-9" }, true],
    [{ "oce-role": "-control" }, false],
    [{ "oce-role": "control-" }, false],
    [{ "oce-role": "_control" }, false],
    [{ "oce-role": "control." }, false],
    [{ "oce-role": " " }, false],
    [{ "oce-role": "not valid" }, false],
    [{ "oce-role": "control\n" }, false],
    [{ "zone\n": "east" }, false],
    [{ "example.com\n/zone": "east" }, false],
    [{ "oce-role": "@platform" }, false],
    [{ "oce-role": "a".repeat(64) }, false],
    [{ "bad key": "control" }, false],
    [{ ["a".repeat(64)]: "control" }, false],
    [{ "Example.com/zone": "east" }, false],
    [{ "example.com/": "east" }, false],
    [{ "example.com/a/b": "east" }, false],
    [{ [`${"a".repeat(64)}.example/zone`]: "east" }, true],
    [{ [`${"a".repeat(253)}/zone`]: "east" }, true],
    [{ [`${"a".repeat(254)}/zone`]: "east" }, false],
  ];
  for (const [nodeSelector, accepted] of selectors) {
    assertParity({
      label: JSON.stringify(nodeSelector),
      controlPlane: { nodeSelector },
      values: { controlPlane: { nodeSelector } },
      accepted,
      chartError: /controlPlane\.nodeSelector (keys|values) must be/,
    });
    // The runtime selectors reach no chart: Compute copies them into each Gateway and
    // Agent Pod's nodeSelector, where Kubernetes applies the same label rule at Pod
    // creation. Preflight must give them the verdict the chart gives the control plane.
    for (const field of ["nodeSelector", "gatewayNodeSelector"]) {
      const profile = input({});
      profile.runtime[field] = nodeSelector;
      const { directory, renderer } = renderProfile(profile);
      rmSync(directory, { recursive: true, force: true });
      assert.equal(renderer.ok, accepted, `runtime.${field} ${JSON.stringify(nodeSelector)}`);
      if (!accepted) {
        assert.match(renderer.output, new RegExp(`runtime\\.${field} (keys|values) must be`));
      }
    }
  }
});

// NetworkPolicy peer selectors. Compute applies this rule to the DNS peer at startup, and
// Kubernetes to every NetworkPolicy: empty values pass, and the key prefix is any DNS
// subdomain of at most 253 characters (no per-label cap, unlike the chart's nodeSelector).
const peerSelectorCases = [
  [{ "k8s-app": "kube-dns" }, true],
  [{ app: "" }, true],
  [{ "example.com/Name": "v.1_A-2" }, true],
  [{ [`example.com/${"a".repeat(63)}`]: "b".repeat(63) }, true],
  [{ [`${"a".repeat(253)}/Name`]: "" }, true],
  [{ [`${"a".repeat(64)}.example/zone`]: "east" }, true],
  [{ 123: "0" }, true],
  [{ app: "kube/dns" }, false],
  [{ app: "a".repeat(64) }, false],
  [{ app: "value\n" }, false],
  [{ app: "-dns" }, false],
  [{ app: "@platform" }, false],
  [{ "k8s.io/name/extra": "dns" }, false],
  [{ "example.com/": "dns" }, false],
  [{ "Example.com/Name": "dns" }, false],
  [{ ["a".repeat(64)]: "dns" }, false],
  [{ [`${"a".repeat(254)}/Name`]: "dns" }, false],
  [{ "example.com\n/Name": "dns" }, false],
  [{ "bad key": "dns" }, false],
];

test("peer Pod selectors get Compute's verdict in preflight, and the chart renders them", () => {
  const peers = [
    [
      "controlPlane.dns.podLabels",
      (profile, labels) => (profile.controlPlane.dns.podLabels = labels),
    ],
    [
      "controlPlane.apiClients.0.podLabels",
      (profile, labels) => (profile.controlPlane.apiClients[0].podLabels = labels),
    ],
    [
      "controlPlane.metrics.scraperNamespaceLabels",
      (profile, labels) => (profile.controlPlane.metrics.scraperNamespaceLabels = labels),
    ],
    [
      "controlPlane.metrics.scraperPodLabels",
      (profile, labels) => (profile.controlPlane.metrics.scraperPodLabels = labels),
    ],
  ];
  const { loadYaml } = createRequire(
    new URL("../../apps/controller/package.json", import.meta.url),
  )("@kubernetes/client-node");
  const admitDns = (dns) => {
    const configured = conformanceKubernetesOptions({
      gatewayTrustedProxyCidrs: ["10.42.0.0/16"],
    });
    createKubernetesComputeDriver({ ...configured, network: { ...configured.network, dns } });
  };
  for (const [podLabels, accepted] of peerSelectorCases) {
    const label = JSON.stringify(podLabels);
    if (accepted) {
      assert.doesNotThrow(() => admitDns({ namespace: "kube-system", podLabels }), label);
    } else {
      assert.throws(
        () => admitDns({ namespace: "kube-system", podLabels }),
        /DNS peer label (?:keys|values) must be Kubernetes/,
        label,
      );
    }
    const profile = input({});
    for (const [, configure] of peers) {
      configure(profile, podLabels);
    }
    const { directory, renderer } = renderProfile(profile);
    try {
      assert.equal(renderer.ok, accepted, `${label}: renderer\n${renderer.output}`);
      if (!accepted) {
        for (const [path] of peers) {
          const field = path.replaceAll(".", "\\.");
          assert.match(renderer.output, new RegExp(`${field} (?:keys|values) must be`), label);
        }
        continue;
      }
      // Compute admits the DNS peer exactly as the renderer wrote it.
      const installation = loadYaml(readFileSync(join(directory, "installation.yaml"), "utf8"));
      const dns = installation.drivers.compute.configuration.network.dns;
      assert.deepEqual(dns.podLabels, podLabels, label);
      assert.doesNotThrow(() => admitDns(dns), label);
      // The chart checks only that the selector is nonempty; Kubernetes applies the rule.
      if (!helmSkip) {
        const chart = helmTemplate([join(directory, "values.yaml")]);
        assert.equal(chart.ok, true, `${label}: helm template\n${chart.output}`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test(
  "external sign-in credential keys get the same verdict from preflight and the chart",
  { skip: helmSkip },
  () => {
    const keyCases = [
      [{}, true],
      [{ clientIdKey: "id" }, true],
      [{ clientSecretKey: "secret" }, true],
      [{ clientIdKey: "id", clientSecretKey: "secret" }, true],
      [{ clientIdKey: "same-key", clientSecretKey: "same-key" }, false],
      [{ clientIdKey: "client-secret" }, false],
      [{ clientSecretKey: "client-id" }, false],
    ];
    for (const provider of ["github", "google", "oidc"]) {
      const endpoints =
        provider === "oidc"
          ? {
              issuer: "https://sso.example.com/realm",
              authorizationUrl: "https://sso.example.com/authorize",
              tokenUrl: "https://sso.example.com/token",
              jwksUrl: "https://sso.example.com/keys",
            }
          : {};
      for (const [keys, accepted] of keyCases) {
        const settings = { ...endpoints, ...keys };
        assertParity({
          label: `${provider}: ${JSON.stringify(keys)}`,
          controlPlane: { github: undefined, [provider]: settings },
          values: {
            auth: { github: { enabled: false }, [provider]: { enabled: true, ...settings } },
          },
          accepted,
          chartError:
            /auth\.(github|google|oidc) client ID and client secret must use different Secret keys/,
        });
      }
    }
  },
);

test(
  "controller image references get the same verdict from preflight and the chart",
  { skip: helmSkip },
  () => {
    const digest = `@sha256:${"a".repeat(64)}`;
    const refs = [
      ["registry.example.invalid/controller", true],
      ["registry.example.invalid/foo_bar", true],
      ["registry.example.invalid:5000/team/controller:release_1", true],
      ["registry.example.invalid/foo+bar", false],
      ["registry.example.invalid/controller?tag", false],
      ["-registry.example.invalid/controller", false],
      ["_registry.example.invalid/controller", false],
    ];
    for (const [name, accepted] of refs) {
      const controllerImage = name + digest;
      assertParity({
        label: name,
        controlPlane: { controllerImage },
        values: { images: { controller: controllerImage } },
        accepted,
        chartError: /images\.controller must be an approved immutable SHA-256 image reference/,
      });
    }
  },
);

test(
  "external sign-in Secret names get the same verdict from preflight and the chart",
  { skip: helmSkip },
  () => {
    const endpoints = {
      issuer: "https://sso.example.com/realm",
      authorizationUrl: "https://sso.example.com/authorize",
      tokenUrl: "https://sso.example.com/token",
      jwksUrl: "https://sso.example.com/keys",
    };
    // The chart's openclaw.gatewayRouting.rootSecretName for release oce in openclaw-system.
    const gatewayRootSecret = `occ-gateway-${createHash("sha256").update("openclaw-system/oce-agent-gateways").digest("hex").slice(0, 12)}-root`;
    // [label, controlPlane providers, accepted]. The chart compares each enabled provider's
    // Secret, default or explicit, with the platform Secrets and each provider before it.
    const cases = [
      ["defaults", { github: {}, google: {}, oidc: endpoints }, true],
      [
        "distinct custom names",
        {
          github: { secretName: "login-a" },
          google: { secretName: "login-b" },
          oidc: { ...endpoints, secretName: "login-c" },
        },
        true,
      ],
      // GitHub is disabled, so Google may use GitHub's default name.
      ["google alone", { github: undefined, google: { secretName: "occ-github-login" } }, true],
      ["gateway API key", { github: { secretName: "occ-private-gateway-key" } }, false],
      // cert-manager writes the Gateway Secrets the chart generates (finding 1046).
      ["generated Gateway TLS", { github: { secretName: "oce-agent-gateways-tls" } }, false],
      ["generated Gateway root CA", { google: { secretName: gatewayRootSecret } }, false],
      ["installation", { github: { secretName: "occ-installation-startup" } }, false],
      ["database", { google: { secretName: "occ-database" } }, false],
      ["auth", { oidc: { ...endpoints, secretName: "occ-auth" } }, false],
      [
        "github and google share",
        { github: { secretName: "shared" }, google: { secretName: "shared" } },
        false,
      ],
      ["google default taken", { github: { secretName: "occ-google-login" }, google: {} }, false],
      [
        "oidc matches github",
        { github: {}, oidc: { ...endpoints, secretName: "occ-github-login" } },
        false,
      ],
      [
        "oidc default taken",
        { github: undefined, google: { secretName: "occ-oidc-login" }, oidc: endpoints },
        false,
      ],
    ];
    for (const [label, providers, accepted] of cases) {
      const auth = {};
      for (const name of ["github", "google", "oidc"]) {
        const settings = name in providers ? providers[name] : name === "github" ? {} : undefined;
        auth[name] = settings === undefined ? { enabled: false } : { enabled: true, ...settings };
      }
      assertParity({
        label,
        controlPlane: providers,
        values: { auth },
        accepted,
        chartError: /auth\.(github|google|oidc)\.secretName must name a dedicated Secret/,
      });
    }
  },
);

test(
  "bootstrap password claim names get the same verdict from preflight and the chart",
  { skip: helmSkip },
  () => {
    const label63 = "a".repeat(63);
    const claims = [
      ["occ-bootstrap-admin-password", true],
      [label63, true],
      [`${label63}.${label63}.${label63}.${"a".repeat(61)}`, true],
      [`${label63}.${label63}.${label63}.${"a".repeat(62)}`, false],
      // Kubernetes admits a long single-segment DNS-subdomain name.
      ["a".repeat(64), true],
      ["a".repeat(253), true],
      ["a".repeat(254), false],
      ["Occ-password", false],
      ["occ_password", false],
      ["occ-password-", false],
      ["occ..password", false],
      ["occ-password\n", false],
    ];
    for (const [claimName, accepted] of claims) {
      assertParity({
        label: claimName.length > 40 ? `${claimName.length} characters` : claimName,
        controlPlane: { bootstrapPasswordClaimName: claimName },
        values: { bootstrap: { password: { claimName } } },
        accepted,
        chartError: /bootstrap\.password\.claimName must be a DNS subdomain/,
      });
    }
  },
);

test(
  "repository Backend IDs get the same verdict from preflight and the chart",
  { skip: helmSkip },
  () => {
    function withRepository(backendId) {
      return {
        ...input({}),
        repository: {
          enabled: true,
          image: `registry.example.invalid/openclaw-enterprise/repository-credentials@sha256:${"c".repeat(64)}`,
          backendId,
          registryConfigMapName: "occ-repository-registry-v1",
          serviceConfigSecretName: "occ-repository-service-config",
          appKeySecretName: "occ-repository-app-key",
          tlsSecretName: "occ-repository-tls",
          publicCaSecretName: "occ-repository-public-ca",
          upstreamCidrs: ["192.0.2.30/32"],
        },
      };
    }
    const good = renderProfile(withRepository("github-primary"));
    try {
      assert.equal(good.renderer.ok, true, good.renderer.output);
      // Installation startup counts the ID in code points (isBackendId) and in UTF-16 code
      // units (the GitHub binding bound); an astral character counts once and twice.
      const ids = [
        ["github-primary", true],
        ["a".repeat(200), true],
        ["\u00e9".repeat(200), true],
        ["\u{1F600}".repeat(100), true],
        ["a".repeat(201), false],
        ["\u{1F600}".repeat(101), false],
        [" github", false],
        ["github ", false],
        ["\u00a0github", false],
        ["\ufeffgithub", false],
        ["git\u2028hub", false],
        ["git\u0085hub", false],
        ["github\u0085", false],
        ["git\u007fhub", false],
      ];
      for (const [backendId, accepted] of ids) {
        const label = JSON.stringify(
          backendId.length > 20 ? `${backendId.length} units` : backendId,
        );
        const { directory, renderer } = renderProfile(withRepository(backendId));
        try {
          assert.equal(renderer.ok, accepted, `${label}: renderer\n${renderer.output}`);
          let chart;
          if (accepted) {
            chart = helmTemplate([join(directory, "values.yaml")]);
          } else {
            assert.match(renderer.output, /repository\.backendId must be a Backend ID/, label);
            const override = writeOverride(directory, { repositoryCredentials: { backendId } });
            chart = helmTemplate([join(good.directory, "values.yaml"), override]);
          }
          assert.equal(chart.ok, accepted, `${label}: helm template\n${chart.output}`);
          if (!accepted) {
            assert.match(chart.output, /repositoryCredentials\.backendId must/, label);
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(good.directory, { recursive: true, force: true });
    }
  },
);

// Helm's `quote` writes Go string syntax; decode it to compare with the input. The cases
// below contain no backslash, so no escaped backslash precedes an escape it rewrites.
function jobEnv(manifests, name) {
  const match = new RegExp(`- name: ${name}\\n\\s+value: (".*")\\n`).exec(manifests);
  assert.ok(match, `expected ${name} in the bootstrap Job`);
  return JSON.parse(
    match[1]
      .replace(/\\x([0-9a-f]{2})/g, "\\u00$1")
      .replace(/\\a/g, "\\u0007")
      .replace(/\\v/g, "\\u000b"),
  );
}

test(
  "free-text profile values reach the bootstrap Job exactly as preflight checked them",
  { skip: helmSkip },
  () => {
    // values.yaml quotes strings YAML 1.1 would retype, and escapes characters Helm's YAML
    // parser folds into a space (U+0085) or refuses (DEL and the other C1 controls).
    const emails = [
      ["a\u0085@b.c", true],
      ["\u0085a@b.c", true],
      ["a\u007f@b.c", true],
      ["a\u0081@b.c", true],
      ["a\u2028@b.c", false],
      ["a\ufeff@b.c", false],
    ];
    for (const [adminEmail, accepted] of emails) {
      const manifests = assertParity({
        label: JSON.stringify(adminEmail),
        controlPlane: { adminEmail },
        values: { bootstrap: { adminEmail } },
        accepted,
        chartError: /bootstrap\.adminEmail must contain a valid administrator email/,
      });
      if (accepted) {
        assert.equal(jobEnv(manifests, "OCC_BOOTSTRAP_ADMIN_EMAIL"), adminEmail);
      }
    }
    for (const clusterName of [
      "1:20",
      ".inf",
      "@platform",
      "zone:",
      "no",
      "1e3",
      "0x1f",
      "2026-10-09",
      "null",
      "~",
      "a\u00a0b",
    ]) {
      const manifests = assertParity({
        label: clusterName,
        controlPlane: { clusterName },
        accepted: true,
      });
      assert.equal(jobEnv(manifests, "OCC_BOOTSTRAP_INSTALLATION_NAME"), clusterName);
    }
  },
);

test(
  "database CA mounts follow active profile features and the production chart",
  { skip: helmSkip },
  () => {
    const chartError = /database.caMountPath must be distinct from other active mounts/;
    const repositoryInput = {
      enabled: true,
      image: `registry.example.invalid/repository@sha256:${"c".repeat(64)}`,
      backendId: "github-primary",
      registryConfigMapName: "occ-repository-registry",
      serviceConfigSecretName: "occ-repository-config",
      appKeySecretName: "occ-repository-app-key",
      tlsSecretName: "occ-repository-tls",
      publicCaSecretName: "occ-repository-ca",
      upstreamCidrs: ["192.0.2.30/32"],
    };
    for (const profile of ["openclaw", "codex"]) {
      const extraInput =
        profile === "codex"
          ? {
              runtime: { ...input({}).runtime, codexSeccompProfile: "profiles/codex.json" },
              codex: { modelDiscoveryCidrs: [] },
            }
          : {};
      for (const mountPath of [
        undefined,
        "/etc/company/postgres-ca",
        "/etc/openclaw/execution", // Profiles do not enable executionCluster mounts.
        "/etc/openclaw/installation",
        "/run/openclaw-worker",
        "/var/lib/openclaw/bootstrap",
        "/etc/openclaw/gateway-api-key",
        "/etc/openclaw/gateway-ca",
      ]) {
        const accepted =
          mountPath === undefined ||
          ["/etc/company/postgres-ca", "/etc/openclaw/execution"].includes(mountPath);
        assertParity({
          label: `${profile}: ${mountPath ?? "default CA mount"}`,
          profile,
          extraInput,
          controlPlane: {
            databaseCa: {
              secretName: "occ-db-ca",
              ...(mountPath === undefined ? {} : { mountPath }),
            },
          },
          values: { database: { caSecretName: "occ-db-ca", caMountPath: mountPath } },
          accepted,
          chartError,
        });
      }
      // No CA mount creates no collision, even when every other feature uses its defaults.
      assertParity({ label: `${profile}: no database CA`, profile, extraInput, accepted: true });
      for (const mountPath of [
        "/etc/openclaw/repository-registry",
        "/etc/openclaw/repository-ca",
        "/var/run/secrets/kubernetes.io/serviceaccount",
        "/run/openclaw/repository-control",
        "/etc/openclaw/repository-inputs", // Broker-only mounts cannot collide with its absent CA.
      ]) {
        for (const enabled of [false, true]) {
          assertParity({
            label: `${profile}: repository ${enabled}: ${mountPath}`,
            profile,
            extraInput: { ...extraInput, repository: enabled ? repositoryInput : { enabled } },
            controlPlane: { databaseCa: { secretName: "occ-db-ca", mountPath } },
            values: {
              database: { caSecretName: "occ-db-ca", caMountPath: mountPath },
              repositoryCredentials: { ...repositoryInput, enabled },
            },
            accepted: !enabled || mountPath === "/etc/openclaw/repository-inputs",
            chartError,
          });
        }
      }
    }
    const mountPath = "/etc/openclaw/chatgpt";
    for (const enabled of [false, true]) {
      const accounts = {
        workspaceId: "11111111-1111-4111-8111-111111111111",
        adminSecretName: "occ-chatgpt-admin",
        providerCidr: "192.0.2.21/32",
      };
      assertParity({
        label: `codex: managed accounts ${enabled}`,
        profile: "codex",
        extraInput: {
          runtime: { ...input({}).runtime, codexSeccompProfile: "profiles/codex.json" },
          codex: {
            modelDiscoveryCidrs: [],
            ...(enabled ? { managedServiceAccounts: accounts } : {}),
          },
        },
        controlPlane: { databaseCa: { secretName: "occ-db-ca", mountPath } },
        values: {
          database: { caSecretName: "occ-db-ca", caMountPath: mountPath },
          backend: {
            chatgpt: {
              enabled,
              secretName: accounts.adminSecretName,
              providerCidr: accounts.providerCidr,
            },
          },
        },
        accepted: !enabled,
        chartError,
      });
    }
  },
);

test(
  "database CA Secret names get the same dedicated-Secret verdict from preflight and the chart",
  { skip: helmSkip },
  () => {
    // Envoy Gateway would accept the CA certificate entry as a client API key (finding 1044),
    // and the database CA Secret is as dedicated as the others (finding 1048).
    for (const [secretName, refusal] of [
      ["occ-db-ca", undefined],
      [
        "occ-private-gateway-key",
        "gatewayRouting.apiKeySecretName must name a dedicated Secret; occ-private-gateway-key is also database.caSecretName",
      ],
      [
        "occ-github-login",
        "auth.github.secretName must name a dedicated Secret; occ-github-login is also database.caSecretName",
      ],
      [
        "occ-database",
        "database.caSecretName must name a dedicated Secret; occ-database is also database.secretName",
      ],
      [
        "oce-agent-gateways-tls",
        "database.caSecretName must name a dedicated Secret; oce-agent-gateways-tls is also gatewayRouting.tlsSecretName",
      ],
    ]) {
      assertParity({
        label: secretName,
        controlPlane: { databaseCa: { secretName } },
        values: { database: { caSecretName: secretName } },
        accepted: refusal === undefined,
        chartError: new RegExp(refusal?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "^$"),
      });
    }
    // Finding 1059: the database and repository public CA settings may share one trust bundle,
    // but the bundle stays apart from the repository credentials.
    const repositoryInput = {
      enabled: true,
      image: `registry.example.invalid/repository@sha256:${"c".repeat(64)}`,
      backendId: "github-primary",
      registryConfigMapName: "occ-repository-registry",
      serviceConfigSecretName: "occ-repository-config",
      appKeySecretName: "occ-repository-app-key",
      tlsSecretName: "occ-repository-tls",
      publicCaSecretName: "occ-repository-ca",
      upstreamCidrs: ["192.0.2.30/32"],
    };
    for (const key of ["publicCaSecretName", "tlsSecretName"]) {
      const repositoryShared = { ...repositoryInput, [key]: "occ-trust-bundle" };
      assertParity({
        label: `trust bundle shared with repository ${key}`,
        extraInput: { repository: repositoryShared },
        controlPlane: { databaseCa: { secretName: "occ-trust-bundle" } },
        values: {
          database: { caSecretName: "occ-trust-bundle" },
          repositoryCredentials: repositoryShared,
        },
        accepted: key === "publicCaSecretName",
        chartError:
          /repositoryCredentials\.tlsSecretName must name a dedicated Secret; occ-trust-bundle is also database\.caSecretName/,
      });
    }
    // Finding 1054: the enabled log collector's Secrets are in the same table.
    for (const enabled of [false, true]) {
      const collector = enabled ? { enabled, exporter: { cidr: "192.0.2.40/32" } } : { enabled };
      assertParity({
        label: `collector ${enabled}`,
        controlPlane: {
          databaseCa: { secretName: "occ-otel-collector-config" },
          loggingCollector: collector,
        },
        values: {
          database: { caSecretName: "occ-otel-collector-config" },
          logging: { collector },
        },
        accepted: !enabled,
        chartError:
          /logging\.collector\.configSecretName must name a dedicated Secret; occ-otel-collector-config is also database\.caSecretName/,
      });
    }
  },
);

test(
  "log collector exporter CIDRs get the same verdict from preflight and the chart",
  { skip: helmSkip },
  () => {
    for (const [cidr, accepted] of [
      ["192.0.2.40/32", true],
      ["192.0.2.0/24", false],
      ["192.0.2.40", false],
      ["010.0.2.40/32", false],
      ["192.0.2.256/32", false],
    ]) {
      assertParity({
        label: cidr,
        controlPlane: { loggingCollector: { enabled: true, exporter: { cidr } } },
        values: { logging: { collector: { enabled: true, exporter: { cidr } } } },
        accepted,
        chartError:
          /logging\.collector\.exporter\.cidr must identify exactly one approved IPv4 exporter or proxy host with \/32/,
      });
    }
  },
);
