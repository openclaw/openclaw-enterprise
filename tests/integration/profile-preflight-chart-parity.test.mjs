import assert from "node:assert/strict";
import { ConfigurationValidationError } from "../../packages/contracts/src/index.ts";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { clientAddressConfiguration } from "../../apps/controller/src/auth/client-address.ts";
import { createKubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { immutableImageAccepted, imageReferenceCases } from "../fixtures/image-reference-cases.mjs";
import {
  RenderRefusal,
  renderInstallationProfile,
} from "../../scripts/render-installation-profile.mjs";

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
const { loadYaml } = createRequire(new URL("../../apps/controller/package.json", import.meta.url))(
  "@kubernetes/client-node",
);

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

// The codex profile's extra input, with optional codex settings.
function codexInput(codex = {}) {
  return {
    runtime: { ...input({}).runtime, codexSeccompProfile: "profiles/codex.json" },
    codex: { modelDiscoveryCidrs: [], ...codex },
  };
}

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

const oidcEndpoints = {
  issuer: "https://sso.example.com/realm",
  authorizationUrl: "https://sso.example.com/authorize",
  tokenUrl: "https://sso.example.com/token",
  jwksUrl: "https://sso.example.com/keys",
};

// Long values are labelled by their length.
const short = (value, max = 40) => (value.length > max ? `${value.length} characters` : value);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const namespaceRefusal = (field) =>
  new RegExp(
    `${escape(field)} must be a Kubernetes namespace name \\(a DNS label of at most 63 characters\\)`,
  );

// Each case renders its profile in-process, then spawns its helm child. A test runs its
// cases in at most one worker per CPU (and at least two), and the tests run one after
// another, so this file runs at most that many helm children at once (the CI lane may run
// other files beside it).
const slots = Math.max(2, availableParallelism());
async function each(cases, check) {
  let next = 0;
  let failure;
  await Promise.all(
    Array.from({ length: slots }, async () => {
      while (failure === undefined && next < cases.length) {
        try {
          await check(cases[next++]);
        } catch (error) {
          failure ??= { error };
        }
      }
    }),
  );
  // Every worker has stopped, so no child outlives its test; report the first failure.
  if (failure) {
    throw failure.error;
  }
}

// Runs one `helm template`. Each run exits within a fraction of a second, so Go's garbage
// collector only adds CPU: GOGC=off cuts about a quarter of helm's CPU time for under 10 MB
// more peak memory per child. GOMEMLIMIT still collects if a child nears 512 MiB.
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repository,
      env: { ...process.env, GOGC: "off", GOMEMLIMIT: "512MiB" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve(code === 0 ? { ok: true, output: stdout } : { ok: false, output: stdout + stderr }),
    );
  });
}

// Renders in-process through the function the CLI calls. `renderer.output` is what the CLI
// prints: the preflight summary on stdout, or its stderr line for a refusal without one.
// profile-renderer.test.mjs covers the CLI process itself (argv, exit status, stdout).
async function renderProfile(profileInput, profile = "openclaw") {
  const directory = mkdtempSync(join(tmpdir(), "oce-profile-parity-"));
  try {
    writeFileSync(join(directory, "input.json"), JSON.stringify(profileInput));
    let renderer;
    try {
      const preflight = await renderInstallationProfile({
        profile,
        input: join(directory, "input.json"),
        outDir: directory,
      });
      renderer = { ok: preflight.ok, output: `${JSON.stringify(preflight, null, 2)}\n` };
    } catch (error) {
      // Only a refusal is a verdict; a renderer crash fails the case.
      if (!(error instanceof RenderRefusal)) {
        throw error;
      }
      renderer = { ok: false, output: `render-installation-profile: ${error.message}\n` };
    }
    return { directory, renderer };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

// Renders a profile, hands `{ directory, renderer }` to `check`, then removes the output.
async function withProfile(profileInput, check, profile) {
  const rendered = await renderProfile(profileInput, profile);
  try {
    return await check(rendered);
  } finally {
    rmSync(rendered.directory, { recursive: true, force: true });
  }
}

// Renders a known-good profile once; refused cases override one field of its values.
let baseline;
after(() => baseline?.then(({ directory }) => rmSync(directory, { recursive: true, force: true })));
async function baselineValues() {
  baseline ??= renderProfile(input({}));
  const { directory, renderer } = await baseline;
  assert.equal(renderer.ok, true, renderer.output);
  return join(directory, "values.yaml");
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
  rendererError,
  profile = "openclaw",
  extraInput = {},
}) {
  return withProfile(
    { ...input(controlPlane), ...extraInput },
    async ({ directory, renderer }) => {
      assert.equal(renderer.ok, accepted, `${label}: renderer\n${renderer.output}`);
      if (!accepted) {
        if (rendererError) {
          assert.match(renderer.output, rendererError, label);
        }
        assert.equal(existsSync(join(directory, "values.yaml")), false);
        assert.equal(existsSync(join(directory, "installation.yaml")), false);
      }
      const chart = await helmTemplate(
        accepted
          ? [join(directory, "values.yaml")]
          : [await baselineValues(), writeOverride(directory, values)],
      );
      assert.equal(chart.ok, accepted, `${label}: helm template\n${chart.output}`);
      if (!accepted) {
        assert.match(chart.output, chartError, label);
      }
      return chart.output;
    },
    profile,
  );
}

// One Helm-backed test for one field: `cases` are [value, accepted, chartError?] rows.
function fieldParity(
  name,
  { cases, label = short, controlPlane, extraInput = () => ({}), values, chartError },
) {
  test(name, { skip: helmSkip }, () =>
    each(cases, ([value, accepted, rowError = chartError]) =>
      assertParity({
        label: label(value),
        controlPlane: controlPlane(value),
        extraInput: extraInput(value),
        values: values(value),
        accepted,
        chartError: rowError,
      }),
    ),
  );
}

// Compute must admit or refuse the same value at Driver creation.
const configured = conformanceKubernetesOptions({ gatewayTrustedProxyCidrs: ["10.42.0.0/16"] });
function assertCompute(overrides, accepted, refusal, label, path, code = "INVALID_FORMAT") {
  const create = () => createKubernetesComputeDriver({ ...configured, ...overrides });
  if (accepted) {
    assert.doesNotThrow(create, label);
  } else {
    assert.throws(
      create,
      (error) => {
        assert.ok(error instanceof ConfigurationValidationError);
        assert.equal(error.error.details[0].path, path);
        assert.equal(error.error.details[0].code, code);
        assert.match(error.error.details[0].message, refusal);
        return true;
      },
      label,
    );
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

fieldParity("trusted proxy CIDRs get the same verdict from the preflight and the chart", {
  cases: cidrCases,
  controlPlane: (cidr) => ({ trustedProxy: { preset: "ingress-nginx", cidrs: [cidr] } }),
  values: (cidr) => ({ api: { trustedProxy: { preset: "ingress-nginx", cidrs: [cidr] } } }),
});

// The API's Slack directory proxy: one literal IPv4 endpoint, and not the unspecified address.
fieldParity("directory proxy URLs get the same verdict from the preflight and the chart", {
  cases: [
    ["http://192.0.2.10:3128", true],
    ["https://192.0.2.10:443", true],
    ["http://0.0.0.0:3128", false, /must not use host 0\.0\.0\.0, which names no proxy address/],
    ["http://192.0.2.999:3128", false, /must contain valid IPv4 octets/],
    ["http://192.0.2.10:65536", false, /must contain a TCP port from 1 to 65535/],
    ["http://010.0.0.1:3128", false, /must be an HTTP\(S\) literal IPv4 endpoint/],
    // Both edges of the octet and port ranges, port 0 or a leading zero, a path, and the
    // unspecified host over HTTPS.
    ["http://192.0.2.255:3128", true],
    ["http://192.0.2.256:3128", false, /must contain valid IPv4 octets/],
    ["http://192.0.2.10:65535", true],
    ["http://192.0.2.10:0", false, /must be an HTTP\(S\) literal IPv4 endpoint/],
    ["http://192.0.2.10:03128", false, /must be an HTTP\(S\) literal IPv4 endpoint/],
    ["http://192.0.2.10:3128/path", false, /must be an HTTP\(S\) literal IPv4 endpoint/],
    ["https://0.0.0.0:443", false, /must not use host 0\.0\.0\.0, which names no proxy address/],
  ],
  controlPlane: () => ({}),
  extraInput: (url) => ({ channels: { managedSlackProxy: false, directoryProxyUrl: url } }),
  values: (url) => ({ slackProxy: { enabled: false }, api: { channelDirectoryProxyUrl: url } }),
});

// The chart's clientAddressHeader refusal, in its order. generic still accepts a plain
// address header; named presets keep reading x-forwarded-for.
const refusedClientAddressHeaders = [
  "x-occ-client-ip",
  "cookie",
  "forwarded",
  "authorization",
  "host",
  "origin",
  "x-api-key",
];

test(
  "trusted proxy client address headers get the same verdict from the preflight and the chart",
  { skip: helmSkip },
  () =>
    each(
      [
        ["x-real-ip", true],
        ["x-forwarded-for", true],
        // The chart lowercases the header first, so preflight does too.
        ["X-Real-IP", true],
        ["X-Forwarded-For", true],
        ...refusedClientAddressHeaders.map((header) => [header, false]),
        ["Cookie", false],
        ["X-API-Key", false],
      ],
      async ([header, accepted]) => {
        const lowered = header.toLowerCase();
        const manifests = await assertParity({
          label: header,
          controlPlane: {
            trustedProxy: {
              preset: "generic",
              cidrs: ["10.42.0.0/16"],
              clientAddressHeader: header,
            },
          },
          values: {
            api: {
              trustedProxy: {
                preset: "generic",
                cidrs: ["10.42.0.0/16"],
                clientAddressHeader: header,
              },
            },
          },
          accepted,
          chartError: new RegExp(
            `api\\.trustedProxy\\.clientAddressHeader cannot be ${escape(lowered)}; use a header that carries plain client addresses, such as x-forwarded-for or x-real-ip`,
          ),
          rendererError: new RegExp(
            `controlPlane\\.trustedProxy\\.clientAddressHeader cannot be ${escape(lowered)}; use a header that carries plain client addresses, such as x-forwarded-for or x-real-ip\\.`,
          ),
        });
        if (accepted) {
          assert.match(
            manifests,
            new RegExp(`name: OCC_AUTH_CLIENT_IP_HEADER\\n\\s+value: "${escape(lowered)}"`),
          );
        }
      },
    ),
);

// The header name is at most 64 characters and starts with a letter or digit.
fieldParity("trusted proxy client address header names get the same length and shape verdict", {
  cases: [
    [`x-${"a".repeat(62)}`, true],
    [`x-${"a".repeat(63)}`, false],
    ["-x-real-ip", false],
  ],
  controlPlane: (header) => ({
    trustedProxy: { preset: "generic", cidrs: ["10.42.0.0/16"], clientAddressHeader: header },
  }),
  values: (header) => ({
    api: {
      trustedProxy: { preset: "generic", cidrs: ["10.42.0.0/16"], clientAddressHeader: header },
    },
  }),
  chartError:
    /api\.trustedProxy\.clientAddressHeader must be a single HTTP header name of at most 64 characters/,
});

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
    const { gatewayClients: _gatewayClients, ...network } = configured.network;
    const routing = {
      hostname: "agents.example.internal",
      gatewayName: "oce-agent-gateways",
      gatewayNamespace: "openclaw-system",
    };
    return each(namespaceCases, async ([envoyNamespace, accepted]) => {
      const label = short(envoyNamespace);
      await assertParity({
        label,
        controlPlane: { envoyNamespace },
        values: { gatewayRouting: { envoyNamespace } },
        accepted,
        chartError: namespaceRefusal("gatewayRouting.envoyNamespace"),
      });
      assertCompute(
        { network, gatewayRouting: { ...routing, envoyNamespace } },
        accepted,
        /Gateway routing Envoy namespace must be a Kubernetes namespace name/,
        `${label}: Compute`,
        "/gatewayRouting/envoyNamespace",
      );
    });
  },
);

// The observability demo chart selects the same DNS peer; it has no renderer.
async function renderDemoChart(values) {
  const directory = mkdtempSync(join(tmpdir(), "oce-demo-parity-"));
  try {
    const path = join(directory, "values.json");
    writeFileSync(path, JSON.stringify(values));
    return await run(helm, [
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
    const dnsRefusal = namespaceRefusal("dns.namespace");
    return each(namespaceCases, async ([namespace, accepted]) => {
      const label = short(namespace);
      await assertParity({
        label: `apiClients ${label}`,
        controlPlane: { apiClients: [{ namespace, podLabels }] },
        values: { api: { clients: [{ namespace, podLabels }] } },
        accepted,
        chartError: namespaceRefusal("api.clients[0].namespace"),
      });
      const dns = { namespace, podLabels: { "k8s-app": "kube-dns" } };
      await assertParity({
        label: `dns ${label}`,
        controlPlane: { dns },
        values: { dns },
        accepted,
        chartError: dnsRefusal,
      });
      const demo = await renderDemoChart({ dns });
      assert.equal(demo.ok, accepted, `dns ${label}: demo chart\n${demo.output}`);
      if (!accepted) {
        assert.match(demo.output, dnsRefusal, label);
      }
      assertCompute(
        { network: { ...configured.network, dns } },
        accepted,
        /DNS peer namespace must be a Kubernetes namespace name/,
        `dns ${label}: Compute`,
        "/network/dns/namespace",
      );
    });
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
  return each(selectors, async ([nodeSelector, accepted]) => {
    const label = JSON.stringify(nodeSelector);
    await assertParity({
      label,
      controlPlane: { nodeSelector },
      values: { controlPlane: { nodeSelector } },
      accepted,
      chartError: /controlPlane\.nodeSelector (keys|values) must be/,
    });
    // The runtime selectors reach no chart: Compute copies them into each Gateway and
    // Agent Pod's nodeSelector, where Kubernetes applies the same label rule at Pod
    // creation. Preflight must give them the verdict the chart gives the control plane, and
    // name each refused field (it reports every refusal, as the peer selectors below show).
    const fields = ["nodeSelector", "gatewayNodeSelector"];
    const profile = input({});
    for (const field of fields) {
      profile.runtime[field] = nodeSelector;
    }
    await withProfile(profile, ({ renderer }) => {
      assert.equal(renderer.ok, accepted, `runtime selectors ${label}\n${renderer.output}`);
      for (const field of accepted ? [] : fields) {
        assert.match(
          renderer.output,
          new RegExp(`runtime\\.${field} (keys|values) must be`),
          `runtime.${field} ${label}`,
        );
      }
    });
  });
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
  [{ app: "kube/dns" }, false, /^Configuration does not satisfy pattern\.$/],
  [{ app: "a".repeat(64) }, false, /^Configuration does not satisfy maxLength\.$/, "TOO_LONG"],
  [{ app: "value\n" }, false, /^Configuration does not satisfy pattern\.$/],
  [{ app: "-dns" }, false, /^Configuration does not satisfy pattern\.$/],
  [{ app: "@platform" }, false, /^Configuration does not satisfy pattern\.$/],
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
    "controlPlane.dns.podLabels",
    "controlPlane.apiClients.0.podLabels",
    "controlPlane.metrics.scraperNamespaceLabels",
    "controlPlane.metrics.scraperPodLabels",
  ];
  const admitDns = (dns, accepted, label, refusal, code) =>
    assertCompute(
      { network: { ...configured.network, dns } },
      accepted,
      refusal ?? /DNS peer label keys must be Kubernetes/,
      label,
      "/network/dns/podLabels",
      code,
    );
  return each(peerSelectorCases, async ([podLabels, accepted, refusal, code]) => {
    const label = JSON.stringify(podLabels);
    admitDns({ namespace: "kube-system", podLabels }, accepted, label, refusal, code);
    const profile = input({});
    // Each path names the field to set and, below, the field the refusal must name.
    for (const path of peers) {
      const keys = path.split(".");
      const field = keys.pop();
      keys.reduce((parent, key) => parent[key], profile)[field] = podLabels;
    }
    await withProfile(profile, async ({ directory, renderer }) => {
      assert.equal(renderer.ok, accepted, `${label}: renderer\n${renderer.output}`);
      if (!accepted) {
        for (const path of peers) {
          assert.match(
            renderer.output,
            new RegExp(`${escape(path)} (?:keys|values) must be`),
            label,
          );
        }
        return;
      }
      // Compute admits the DNS peer exactly as the renderer wrote it.
      const installation = loadYaml(readFileSync(join(directory, "installation.yaml"), "utf8"));
      const dns = installation.drivers.compute.configuration.network.dns;
      assert.deepEqual(dns.podLabels, podLabels, label);
      admitDns(dns, true, label);
      // The chart checks only that the selector is nonempty; Kubernetes applies the rule.
      if (!helmSkip) {
        const chart = await helmTemplate([join(directory, "values.yaml")]);
        assert.equal(chart.ok, true, `${label}: helm template\n${chart.output}`);
      }
    });
  });
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
    const cases = ["github", "google", "oidc"].flatMap((provider) =>
      keyCases.map(([keys, accepted]) => [provider, keys, accepted]),
    );
    return each(cases, ([provider, keys, accepted]) => {
      const settings = { ...(provider === "oidc" ? oidcEndpoints : {}), ...keys };
      return assertParity({
        label: `${provider}: ${JSON.stringify(keys)}`,
        controlPlane: { github: undefined, [provider]: settings },
        values: {
          auth: { github: { enabled: false }, [provider]: { enabled: true, ...settings } },
        },
        accepted,
        chartError:
          /auth\.(github|google|oidc) client ID and client secret must use different Secret keys/,
      });
    });
  },
);

// The chart checks every control-plane image with one rule.
const controlPlaneImageCases = [
  ["registry.example.invalid/controller", true],
  ["registry.example.invalid/foo_bar", true],
  ["registry.example.invalid:5000/team/controller:release_1", true],
  ["registry.example.invalid/foo+bar", false],
  ["registry.example.invalid/controller?tag", false],
  ["-registry.example.invalid/controller", false],
  ["_registry.example.invalid/controller", false],
  // An uppercase registry host or tag is allowed, and so is an IPv6 registry host. A second @
  // is refused, and so is a bracket after the first component.
  ["Registry.Example.invalid/team/controller", true],
  ["registry.example.invalid/team/controller:Release_1", true],
  ["[fd00::1]:5000/team/controller", true],
  ["registry.example.invalid/controller@extra", false],
  ["registry.example.invalid/[fd00::1]/controller", false],
];

fieldParity("controller image references get the same verdict from preflight and the chart", {
  cases: controlPlaneImageCases,
  label: (name) => name,
  controlPlane: (name) => ({ controllerImage: `${name}@sha256:${"a".repeat(64)}` }),
  values: (name) => ({ images: { controller: `${name}@sha256:${"a".repeat(64)}` } }),
  chartError: /images\.controller must be an approved immutable SHA-256 image reference/,
});

// Kubernetes refuses to pull an image whose repository path has an uppercase letter
// (InvalidImageName). Preflight refuses it in every image field, the chart in the images it
// renders, and Compute in runtime.image, which becomes its images.gateway and images.agent.
test(
  "images with an uppercase repository path fail preflight, the chart and Compute",
  { skip: helmSkip },
  () => {
    const refusal = (field) => new RegExp(`${escape(field)} repository path must be lowercase`);
    const fields = [
      [
        "controlPlane.controllerImage",
        (image) => input({ controllerImage: image }),
        "images.controller",
        (image) => ({ images: { controller: image } }),
      ],
      ["runtime.image", (image) => ({ ...input({}), runtime: { ...input({}).runtime, image } })],
      [
        "repository.image",
        (image) => ({ ...input({}), repository: { ...repositoryInput, image } }),
        "repositoryCredentials.image",
        (image) => ({ repositoryCredentials: { ...repositoryInput, image } }),
      ],
    ];
    const names = [
      "registry.example.invalid/Team/controller",
      "registry.example.invalid:5000/team/Controller:release_1",
      "Registry.Example.invalid/team/Controller",
      // Without a registry host, the image is docker.io/library/Controller.
      "Controller",
    ];
    return each(
      fields.flatMap((field) => names.map((name) => [field, name])),
      ([[field, profile, chartField, values], name]) => {
        const image = `${name}@sha256:${"a".repeat(64)}`;
        return withProfile(profile(image), async ({ directory, renderer }) => {
          assert.equal(renderer.ok, false, `${field} ${name}: renderer\n${renderer.output}`);
          assert.match(renderer.output, refusal(field), `${field} ${name}`);
          assert.equal(existsSync(join(directory, "values.yaml")), false);
          if (chartField === undefined) {
            assertCompute(
              { images: { gateway: image, agent: image, requireImmutableDigest: true } },
              false,
              /Gateway image repository path must be lowercase/,
              name,
              "/images/gateway",
            );
            return;
          }
          const chart = await helmTemplate([
            await baselineValues(),
            writeOverride(directory, values(image)),
          ]);
          assert.equal(chart.ok, false, `${chartField} ${name}: helm template\n${chart.output}`);
          assert.match(chart.output, refusal(chartField), `${chartField} ${name}`);
        });
      },
    );
  },
);

// Profiles take no Collector image: preflight refuses the field and writes none, so the chart
// renders its default. An operator values file can still set logging.collector.image, and the
// chart applies the images.* rule to it.
test(
  "logging.collector.image follows the images.* repository path rule; profiles leave the chart default",
  { skip: helmSkip },
  async () => {
    const collector = { enabled: true, exporter: { cidr: "192.0.2.40/32" } };
    await withProfile(
      input({
        loggingCollector: { ...collector, image: `otel/collector@sha256:${"d".repeat(64)}` },
      }),
      ({ renderer }) => {
        assert.equal(renderer.ok, false, renderer.output);
        assert.match(
          renderer.output,
          /controlPlane\.loggingCollector\.image is not supported by installation profiles/,
        );
      },
    );
    return withProfile(input({ loggingCollector: collector }), async ({ directory, renderer }) => {
      assert.equal(renderer.ok, true, renderer.output);
      const values = join(directory, "values.yaml");
      assert.equal(loadYaml(readFileSync(values, "utf8")).logging.collector.image, undefined);
      const chart = await helmTemplate([values]);
      assert.equal(chart.ok, true, chart.output);
      const chartDefault = loadYaml(
        readFileSync(join(repository, "deploy/helm/openclaw-enterprise/values.yaml"), "utf8"),
      ).logging.collector.image;
      assert.ok(chart.output.includes(`image: ${JSON.stringify(chartDefault)}`), chartDefault);
      await each(
        [
          ["registry.example.invalid/otel/collector", true],
          ["Registry.Example.invalid/otel/collector:Release_1", true],
          ["[fd00::1]:5000/otel/collector", true],
          ["[FD00::1]:5000/otel/collector", true],
          ["registry.example.invalid/Otel/collector", false],
          ["registry.example.invalid:5000/otel/Collector:release_1", false],
          ["Registry.Example.invalid/otel/Collector", false],
          ["[fd00::1]:5000/otel/Collector", false],
          // Without a registry host, the image is docker.io/library/Collector.
          ["Collector", false],
        ],
        async ([name, accepted]) => {
          const image = `${name}@sha256:${"d".repeat(64)}`;
          const chart = await helmTemplate([
            values,
            writeOverride(mkdtempSync(join(directory, "case-")), {
              logging: { collector: { image } },
            }),
          ]);
          assert.equal(chart.ok, accepted, `${name}: helm template\n${chart.output}`);
          if (accepted) {
            assert.ok(chart.output.includes(`image: ${JSON.stringify(image)}`), name);
          } else {
            assert.match(
              chart.output,
              /logging\.collector\.image repository path must be lowercase; Kubernetes refuses to pull an uppercase one/,
              name,
            );
          }
        },
      );
    });
  },
);

// runtime.image never reaches the chart: it becomes Compute's images.gateway and
// images.agent. Every reference preflight accepts, including an IPv6 registry host, must reach
// Compute as written and start it. Both refuse whitespace and a second @, which no runtime
// pulls.
test("runtime image references get Compute's verdict in preflight", () =>
  each(
    [
      ["registry.example.invalid/openclaw-enterprise/runtime", true],
      ["registry.example.invalid:5000/team/runtime:release_1", true],
      ["[fd00::1]:5000/openclaw-enterprise/runtime", true],
      ["[::1]:5000/runtime", true],
      ["Registry.Example.invalid/team/runtime:Release_1", true],
      ["registry.example.invalid/run time", false],
      ["registry.example.invalid/runtime\n", false],
      ["registry.example.invalid/runtime@extra", false],
    ],
    ([name, accepted]) => {
      const image = `${name}@sha256:${"b".repeat(64)}`;
      return withProfile(
        { ...input({}), runtime: { ...input({}).runtime, image } },
        ({ directory, renderer }) => {
          assert.equal(renderer.ok, accepted, `${name}: renderer\n${renderer.output}`);
          if (!accepted) {
            assert.match(
              renderer.output,
              /runtime\.image must be an immutable image reference with a SHA-256 digest/,
            );
            assert.equal(existsSync(join(directory, "installation.yaml")), false);
            return;
          }
          const installation = loadYaml(readFileSync(join(directory, "installation.yaml"), "utf8"));
          const images = installation.drivers.compute.configuration.images;
          assert.deepEqual(images, { gateway: image, agent: image, requireImmutableDigest: true });
          assertCompute({ images }, true, undefined, name);
        },
      );
    },
  ));

// Kubernetes refuses to pull a reference its parser refuses (InvalidImageName). Every image
// field in preflight, Compute and the chart takes exactly the references Kubernetes accepts,
// with a lowercase SHA-256 digest where the field requires one. tests/fixtures/image-reference-
// cases.mjs holds Kubernetes' verdicts.
function imageRefusal(field, image, problem) {
  return problem === "uppercase-repository" && /@sha256:[a-f0-9]{64}$/.test(image)
    ? new RegExp(`${escape(field)} repository path must be lowercase`)
    : new RegExp(
        `${escape(field)} must be an (immutable|approved immutable SHA-256) image reference`,
      );
}

test("image references get Kubernetes' verdict in preflight and Compute", () =>
  each(imageReferenceCases, ([label, image, problem]) => {
    // Compute without the immutable-image policy takes every reference Kubernetes accepts.
    assertCompute(
      { images: { gateway: image, agent: image, requireImmutableDigest: false } },
      problem === undefined,
      problem === "uppercase-repository"
        ? /Gateway image repository path must be lowercase/
        : /Gateway image must be a container image reference Kubernetes can pull/,
      label,
      "/images/gateway",
    );
    const accepted = immutableImageAccepted(image, problem);
    // One profile carries the reference in all three image fields; preflight refuses each.
    return withProfile(
      {
        ...input({ controllerImage: image }),
        runtime: { ...input({}).runtime, image },
        repository: { ...repositoryInput, image },
      },
      ({ directory, renderer }) => {
        assert.equal(renderer.ok, accepted, `${label}: renderer\n${renderer.output}`);
        if (!accepted) {
          for (const field of [
            "controlPlane.controllerImage",
            "runtime.image",
            "repository.image",
          ]) {
            assert.match(
              renderer.output,
              imageRefusal(field, image, problem),
              `${label}: ${field}`,
            );
          }
          return;
        }
        const values = loadYaml(readFileSync(join(directory, "values.yaml"), "utf8"));
        assert.equal(values.images.controller, image, label);
        assert.equal(values.repositoryCredentials.image, image, label);
        const installation = loadYaml(readFileSync(join(directory, "installation.yaml"), "utf8"));
        const images = installation.drivers.compute.configuration.images;
        assert.deepEqual(images, { gateway: image, agent: image, requireImmutableDigest: true });
        assertCompute({ images }, true, undefined, label);
      },
    );
  }));

test(
  "image references get Kubernetes' verdict in every chart image field",
  { skip: helmSkip },
  async () => {
    // A profile with the Collector and repository credentials enabled, so every chart image
    // field renders.
    const baselineProfile = await renderProfile({
      ...input({ loggingCollector: { enabled: true, exporter: { cidr: "192.0.2.40/32" } } }),
      repository: repositoryInput,
    });
    try {
      assert.equal(baselineProfile.renderer.ok, true, baselineProfile.renderer.output);
      const baselineValuesFile = join(baselineProfile.directory, "values.yaml");
      const fields = [
        ["images.controller", (image) => ({ images: { controller: image } })],
        ["repositoryCredentials.image", (image) => ({ repositoryCredentials: { image } })],
        ["logging.collector.image", (image) => ({ logging: { collector: { image } } })],
      ];
      await each(imageReferenceCases, async ([label, image, problem]) => {
        const directory = mkdtempSync(join(baselineProfile.directory, "case-"));
        if (immutableImageAccepted(image, problem)) {
          const chart = await helmTemplate([
            baselineValuesFile,
            writeOverride(
              directory,
              Object.assign({}, ...fields.map(([, values]) => values(image))),
            ),
          ]);
          assert.equal(chart.ok, true, `${label}: helm template\n${chart.output}`);
          // The controller, its Jobs, the Slack proxy, the repository broker and the Collector.
          assert.ok(chart.output.includes(`image: ${JSON.stringify(image)}`), label);
          return;
        }
        for (const [field, values] of fields) {
          const chart = await helmTemplate([
            baselineValuesFile,
            writeOverride(mkdtempSync(join(directory, "field-")), values(image)),
          ]);
          assert.equal(chart.ok, false, `${label}: ${field}: helm template\n${chart.output}`);
          assert.match(chart.output, imageRefusal(field, image, problem), `${label}: ${field}`);
        }
      });
    } finally {
      rmSync(baselineProfile.directory, { recursive: true, force: true });
    }
  },
);

// The chart checks the percent-decoded host for invisible characters that Node's host
// parser drops.
const invisibleHost = /auth\.baseUrl must not contain spaces, invisible characters, < or >/;
fieldParity("auth base URLs get the same verdict from preflight and the chart", {
  cases: [
    ["https://[::1]", true],
    ["https://[::192.0.2.1]", true],
    ["https://[64:ff9b::192.0.2.1]:8443", true],
    ["https://[::ffff:1:2:3]", true],
    ["https://ex%C3%A4.com", true],
    ...["%C2%AD", "%E2%80%8B", "%E2%81%A0", "%EF%BB%BF", "%E1%A0%8E", "%F0%9D%85%B3"].map(
      (escaped) => [`https://ex${escaped}ample.com`, false, invisibleHost],
    ),
    ["https://ex%e2%80%8bample.com:8443", false, invisibleHost],
    // A joiner may sit inside a label, encoded or not, but not at the start or end of the URL.
    ["https://\u0915\u094d\u200d\u0937.example", true],
    ["https://\u0915\u094d%E2%80%8D\u0937.example", true],
    [
      "https://example.\u0915\u094d\u200d",
      false,
      /auth\.baseUrl must not begin or end with Unicode spaces or invisible characters/,
    ],
    // Only ::ffff:0:0/96 is IPv4-mapped.
    ["https://[::1:ffff:c000:201]", true],
    // An uppercase scheme still gets the IPv4 and percent-escape checks.
    ["HTTPS://192.0.2.10", true],
    ["HTTPS://ex%61mple.com", false, /invalid URL escape "%61"/],
    // Sprig urlParse refuses every ASCII escape in the host, in either hex case.
    ["https://ex%7Eample.com", false, /invalid URL escape "%7E"/],
    ["https://example.com%2E", false, /invalid URL escape "%2E"/],
    // Node reads a backslash as a path separator; the chart refuses it in the host.
    ["https://console.example.com\\auth", false, /invalid character "\\\\" in host name/],
    // Node drops an empty user info and publishes the host alone; the chart refuses any @.
    ["https://@console.example.com", false, /auth\.baseUrl must be an absolute HTTP\(S\) origin/],
    ["https://:@console.example.com", false, /auth\.baseUrl must be an absolute HTTP\(S\) origin/],
    ["https://@192.0.2.10", false, /auth\.baseUrl must be an absolute HTTP\(S\) origin/],
    [
      syntheticCredentialUrl({ username: "", password: "secret", host: "console.example.com" }),
      false,
      /auth\.baseUrl must be an absolute HTTP\(S\) origin/,
    ],
  ],
  label: (url) => url,
  controlPlane: (url) => ({ authBaseUrl: url }),
  values: (url) => ({ auth: { baseUrl: url } }),
});

// Helm built with Go 1.24.9 (Helm 3.19.2) refuses an IPv4-mapped IPv6 host in any spelling
// as an invalid IPv6 host; Helm built with newer Go accepts it. Preflight refuses it, so the
// outcome does not depend on the Helm build.
test(
  "IPv4-mapped auth base URL hosts fail preflight under every Helm build",
  { skip: helmSkip },
  () =>
    each(
      [
        "https://[::ffff:192.0.2.1]",
        "https://[::FFFF:c000:201]:8443",
        "https://[0:0:0:0:0:ffff:0:1]",
        "https://[::ffff:0:0]",
      ],
      (url) =>
        withProfile(input({ authBaseUrl: url }), async ({ directory, renderer }) => {
          assert.equal(renderer.ok, false, `${url}: renderer\n${renderer.output}`);
          assert.match(renderer.output, /authBaseUrl host must not be an IPv4-mapped IPv6 address/);
          assert.equal(existsSync(join(directory, "values.yaml")), false);
          const chart = await helmTemplate([
            await baselineValues(),
            writeOverride(directory, { auth: { baseUrl: url } }),
          ]);
          if (!chart.ok) {
            assert.match(chart.output, /invalid IPv6 host/, url);
          }
        }),
    ),
);

fieldParity(
  "repository credential image references get the same verdict from preflight and the chart",
  {
    cases: controlPlaneImageCases,
    label: (name) => name,
    controlPlane: () => ({}),
    extraInput: (name) => ({
      repository: { ...repositoryInput, image: `${name}@sha256:${"c".repeat(64)}` },
    }),
    values: (name) => ({
      repositoryCredentials: { ...repositoryInput, image: `${name}@sha256:${"c".repeat(64)}` },
    }),
    chartError:
      /repositoryCredentials\.image must be an approved immutable SHA-256 image reference/,
  },
);

test(
  "external sign-in Secret names get the same verdict from preflight and the chart",
  { skip: helmSkip },
  () => {
    // The chart's openclaw.gatewayRouting.rootSecretName for release oce in openclaw-system.
    const gatewayRootSecret = `occ-gateway-${createHash("sha256").update("openclaw-system/oce-agent-gateways").digest("hex").slice(0, 12)}-root`;
    // [label, controlPlane providers, accepted]. The chart compares each enabled provider's
    // Secret, default or explicit, with the platform Secrets and each provider before it.
    const cases = [
      ["defaults", { github: {}, google: {}, oidc: oidcEndpoints }, true],
      [
        "distinct custom names",
        {
          github: { secretName: "login-a" },
          google: { secretName: "login-b" },
          oidc: { ...oidcEndpoints, secretName: "login-c" },
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
      ["auth", { oidc: { ...oidcEndpoints, secretName: "occ-auth" } }, false],
      [
        "github and google share",
        { github: { secretName: "shared" }, google: { secretName: "shared" } },
        false,
      ],
      ["google default taken", { github: { secretName: "occ-google-login" }, google: {} }, false],
      [
        "oidc matches github",
        { github: {}, oidc: { ...oidcEndpoints, secretName: "occ-github-login" } },
        false,
      ],
      [
        "oidc default taken",
        { github: undefined, google: { secretName: "occ-oidc-login" }, oidc: oidcEndpoints },
        false,
      ],
    ];
    return each(cases, ([label, providers, accepted]) => {
      const auth = {};
      for (const name of ["github", "google", "oidc"]) {
        const settings = name in providers ? providers[name] : name === "github" ? {} : undefined;
        auth[name] = settings === undefined ? { enabled: false } : { enabled: true, ...settings };
      }
      return assertParity({
        label,
        controlPlane: providers,
        values: { auth },
        accepted,
        chartError: /auth\.(github|google|oidc)\.secretName must name a dedicated Secret/,
      });
    });
  },
);

fieldParity("bootstrap password claim names get the same verdict from preflight and the chart", {
  cases: [
    ["occ-bootstrap-admin-password", true],
    ["a".repeat(63), true],
    [`${"a".repeat(63)}.`.repeat(3) + "a".repeat(61), true],
    [`${"a".repeat(63)}.`.repeat(3) + "a".repeat(62), false],
    // Kubernetes admits a long single-segment DNS-subdomain name.
    ["a".repeat(64), true],
    ["a".repeat(253), true],
    ["a".repeat(254), false],
    ["Occ-password", false],
    ["occ_password", false],
    ["occ-password-", false],
    ["occ..password", false],
    ["occ-password\n", false],
  ],
  controlPlane: (claimName) => ({ bootstrapPasswordClaimName: claimName }),
  values: (claimName) => ({ bootstrap: { password: { claimName } } }),
  chartError: /bootstrap\.password\.claimName must be a DNS subdomain/,
});

test(
  "repository Backend IDs get the same verdict from preflight and the chart",
  { skip: helmSkip },
  () => {
    const withRepository = (backendId) => ({
      ...input({}),
      repository: { ...repositoryInput, backendId },
    });
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
    return withProfile(withRepository("github-primary"), (good) => {
      assert.equal(good.renderer.ok, true, good.renderer.output);
      return each(ids, ([backendId, accepted]) => {
        const label = JSON.stringify(
          backendId.length > 20 ? `${backendId.length} units` : backendId,
        );
        return withProfile(withRepository(backendId), async ({ directory, renderer }) => {
          assert.equal(renderer.ok, accepted, `${label}: renderer\n${renderer.output}`);
          if (!accepted) {
            assert.match(renderer.output, /repository\.backendId must be a Backend ID/, label);
          }
          const chart = await helmTemplate(
            accepted
              ? [join(directory, "values.yaml")]
              : [
                  join(good.directory, "values.yaml"),
                  writeOverride(directory, { repositoryCredentials: { backendId } }),
                ],
          );
          assert.equal(chart.ok, accepted, `${label}: helm template\n${chart.output}`);
          if (!accepted) {
            assert.match(chart.output, /repositoryCredentials\.backendId must/, label);
          }
        });
      });
    });
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
    const clusterNames = [
      ...["1:20", ".inf", "@platform", "zone:", "no", "1e3", "0x1f", "2026-10-09", "null", "~"],
      "a\u00a0b",
    ];
    const cases = [
      ...emails.map(([adminEmail, accepted]) => ({
        env: "OCC_BOOTSTRAP_ADMIN_EMAIL",
        value: adminEmail,
        label: JSON.stringify(adminEmail),
        controlPlane: { adminEmail },
        values: { bootstrap: { adminEmail } },
        accepted,
        chartError: /bootstrap\.adminEmail must contain a valid administrator email/,
      })),
      ...clusterNames.map((clusterName) => ({
        env: "OCC_BOOTSTRAP_INSTALLATION_NAME",
        value: clusterName,
        label: clusterName,
        controlPlane: { clusterName },
        accepted: true,
      })),
    ];
    return each(cases, async ({ env, value, ...parity }) => {
      const manifests = await assertParity(parity);
      if (parity.accepted) {
        assert.equal(jobEnv(manifests, env), value);
      }
    });
  },
);

test(
  "database CA mounts follow active profile features and the production chart",
  { skip: helmSkip },
  () => {
    const chartError = /database.caMountPath must be distinct from other active mounts/;
    const cases = [];
    for (const profile of ["openclaw", "codex"]) {
      const extraInput = profile === "codex" ? codexInput() : {};
      for (const mountPath of [
        undefined,
        "/etc/company/postgres-ca",
        "etc/company/postgres-ca",
        "/etc/openclaw/./installation",
        "/etc/openclaw/database-ca/../installation",
        "/etc/openclaw/installation/",
        "etc/openclaw/installation",
        "/etc/openclaw/execution", // Profiles do not enable executionCluster mounts.
        "/etc/openclaw/installation",
        "/run/openclaw-worker",
        "/var/run/openclaw-worker", // The controller image links /var/run to /run.
        "/var/run/../var/lib/openclaw/bootstrap", // Dot segments apply after the link.
        "/var/lock/../openclaw-worker", // The image links /var/lock to /run/lock, so this is /run.
        "/run/lock/../openclaw-worker",
        "/var/lib/openclaw/bootstrap",
        "/etc/openclaw/gateway-api-key",
        "/etc/openclaw/gateway-ca",
      ]) {
        cases.push({
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
          accepted:
            mountPath === undefined ||
            [
              "/etc/company/postgres-ca",
              "etc/company/postgres-ca",
              "/etc/openclaw/execution",
            ].includes(mountPath),
          chartError,
        });
      }
      // No CA mount creates no collision, even when every other feature uses its defaults.
      cases.push({ label: `${profile}: no database CA`, profile, extraInput, accepted: true });
      for (const mountPath of [
        "/etc/openclaw/repository-registry",
        "/etc/openclaw/repository-ca",
        "/var/run/secrets/kubernetes.io/serviceaccount",
        "/run/secrets/kubernetes.io/serviceaccount",
        "/run/openclaw/repository-control",
        "/var/run/openclaw/repository-control",
        "/etc/openclaw/repository-inputs", // Broker-only mounts cannot collide with its absent CA.
      ]) {
        for (const enabled of [false, true]) {
          cases.push({
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
    const accounts = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      adminSecretName: "occ-chatgpt-admin",
      providerCidr: "192.0.2.21/32",
    };
    for (const enabled of [false, true]) {
      cases.push({
        label: `codex: managed accounts ${enabled}`,
        profile: "codex",
        extraInput: codexInput(enabled ? { managedServiceAccounts: accounts } : {}),
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
    return each(cases, assertParity);
  },
);

test(
  "database CA Secret names get the same dedicated-Secret verdict from preflight and the chart",
  { skip: helmSkip },
  () => {
    // Envoy Gateway would accept the CA certificate entry as a client API key (finding 1044),
    // and the database CA Secret is as dedicated as the others (finding 1048).
    const cases = [
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
    ].map(([secretName, refusal]) => ({
      label: secretName,
      controlPlane: { databaseCa: { secretName } },
      values: { database: { caSecretName: secretName } },
      accepted: refusal === undefined,
      chartError: new RegExp(refusal === undefined ? "^$" : escape(refusal)),
    }));
    // Finding 1059: the database and repository public CA settings may share one trust bundle,
    // but the bundle stays apart from the repository credentials.
    for (const key of ["publicCaSecretName", "tlsSecretName"]) {
      const repositoryShared = { ...repositoryInput, [key]: "occ-trust-bundle" };
      cases.push({
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
      cases.push({
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
    return each(cases, assertParity);
  },
);

fieldParity("log collector exporter CIDRs get the same verdict from preflight and the chart", {
  cases: [
    ["192.0.2.40/32", true],
    ["192.0.2.0/24", false],
    ["192.0.2.40", false],
    ["010.0.2.40/32", false],
    ["192.0.2.256/32", false],
  ],
  controlPlane: (cidr) => ({ loggingCollector: { enabled: true, exporter: { cidr } } }),
  values: (cidr) => ({ logging: { collector: { enabled: true, exporter: { cidr } } } }),
  chartError:
    /logging\.collector\.exporter\.cidr must identify exactly one approved IPv4 exporter or proxy host with \/32/,
});

// Findings 1065 and 1066: preflight (resourceNameRule) and the chart
// (openclaw.validateResourceName) refuse the same operator-set names, with the same rule.
const resourceNameRefusal = (field) =>
  new RegExp(`${escape(field)} must be a Kubernetes resource name of at most 253 characters`);
const resourceNameCases = [
  ["occ.custom-secret-v2", true],
  ["a".repeat(253), true],
  ["Bad_Name", false],
  ["-secret", false],
  ["secret.", false],
  ["a".repeat(254), false],
];
for (const [field, chartField, controlPlane, values] of [
  [
    "controlPlane.databaseCa.secretName",
    "database.caSecretName",
    (secretName) => ({ databaseCa: { secretName } }),
    (caSecretName) => ({ database: { caSecretName } }),
  ],
  [
    "controlPlane.gatewayApiKeySecretName",
    "gatewayRouting.apiKeySecretName",
    (gatewayApiKeySecretName) => ({ gatewayApiKeySecretName }),
    (apiKeySecretName) => ({ gatewayRouting: { apiKeySecretName } }),
  ],
  [
    "controlPlane.gatewayClassName",
    "gatewayRouting.gatewayClassName",
    (gatewayClassName) => ({ gatewayClassName }),
    (gatewayClassName) => ({ gatewayRouting: { gatewayClassName } }),
  ],
  [
    "controlPlane.github.secretName",
    "auth.github.secretName",
    (secretName) => ({ github: { egressCidrs: ["140.82.112.0/20"], secretName } }),
    (secretName) => ({ auth: { github: { secretName } } }),
  ],
]) {
  test(`${field} and ${chartField} refuse the same malformed names`, { skip: helmSkip }, () =>
    each(resourceNameCases, ([name, accepted]) =>
      assertParity({
        label: short(name),
        controlPlane: controlPlane(name),
        values: values(name),
        accepted,
        rendererError: resourceNameRefusal(field),
        chartError: resourceNameRefusal(chartField),
      }),
    ),
  );
}
