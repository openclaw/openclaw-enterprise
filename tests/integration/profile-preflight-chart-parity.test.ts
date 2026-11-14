import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { clientAddressConfiguration } from "../../apps/controller/src/auth/client-address.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import {
  RenderRefusal,
  renderInstallationProfile,
} from "../../scripts/render-installation-profile.mjs";

import {
  profileComputeCases,
  type FieldParityCases,
  type ParityCase,
  type RenderedProfile,
  type TestInput,
  type VerdictCase,
} from "./profile-preflight-chart-compute-cases.ts";

// Each case runs through the profile preflight and through `helm template`, so the
// renderer cannot accept a value the chart then refuses (or refuse one it accepts).
const repository = fileURLToPath(new URL("../../", import.meta.url));
const helm = process.env.OCC_HELM_BIN ?? "helm";
let helmSkip: false | string = false;
try {
  execFileSync(helm, ["version", "--short"], { cwd: repository, stdio: "ignore" });
} catch {
  helmSkip = "Install Helm, or set OCC_HELM_BIN, to compare the preflight with the chart.";
}
const { loadYaml }: { loadYaml: (text: string) => unknown } = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
)("@kubernetes/client-node");

function input(controlPlane: TestInput = {}) {
  return {
    controlPlane: {
      releaseName: "oce",
      namespace: "openclaw-system",
      clusterName: "profile-qualification",
      controllerImage: `registry.example.invalid/openclaw-enterprise/controller@sha256:${"a".repeat(64)}`,
      authBaseUrl: "https://console.oce.example.internal",
      agentNativeAdminDomain: "agents.oce.example.internal",
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
      google: { egressCidrs: ["192.0.2.20/32"] },
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
function codexInput(codex: TestInput = {}) {
  return {
    runtime: { ...input({}).runtime, codexSeccompProfile: "profiles/codex.json" },
    codex: { modelDiscoveryCidrs: [], ...codex },
  };
}

const repositoryInput = {
  enabled: true,
  authority: "prepared-git",
  preparedCustodySecretName: "occ-repository-custody",
  image: `registry.example.invalid/repository@sha256:${"c".repeat(64)}`,
  backendId: "github-primary",
  registryConfigMapName: "occ-repository-registry",
  serviceConfigSecretName: "occ-repository-config",
  appKeySecretName: "occ-repository-app-key",
  tlsSecretName: "occ-repository-tls",
  publicCaSecretName: "occ-repository-ca",
  upstreamCidrs: ["192.0.2.30/32"],
};

test("profile renderer refuses the retired signing gateway without preparing outputs", async () => {
  for (const authority of [undefined, "github-app", "github-app-registry"]) {
    await withProfile(
      { ...input({}), ...codexInput(), repository: { ...repositoryInput, authority } },
      ({ directory, renderer }) => {
        assert.equal(renderer.ok, false);
        assert.match(renderer.output, /repository.authority must explicitly select prepared-git/);
        assert.equal(existsSync(join(directory, "values.yaml")), false);
        assert.equal(existsSync(join(directory, "installation.yaml")), false);
      },
      "codex",
    );
  }
});

const oidcEndpoints = {
  issuer: "https://sso.example.com/realm",
  authorizationUrl: "https://sso.example.com/authorize",
  tokenUrl: "https://sso.example.com/token",
  jwksUrl: "https://sso.example.com/keys",
};

// Long values are labelled by their length.
const short = (value: string, max = 40) =>
  value.length > max ? `${value.length} characters` : value;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Each case renders its profile in-process, then spawns its helm child. A test runs its
// cases in at most one worker per CPU (and at least two), and the tests run one after
// another, so this file runs at most that many helm children at once (the CI lane may run
// other files beside it).
const slots = Math.max(2, availableParallelism());
async function each<Row>(cases: readonly Row[], check: (row: Row) => unknown) {
  const pending = cases.values();
  const failures: unknown[] = [];
  await Promise.all(
    Array.from({ length: slots }, async () => {
      while (failures.length === 0) {
        const row = pending.next();
        if (row.done) {
          return;
        }
        try {
          await check(row.value);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  // Every worker has stopped, so no child outlives its test; report the first failure.
  if (failures.length > 0) {
    throw failures[0];
  }
}

// Runs one `helm template`. Each run exits within a fraction of a second, so Go's garbage
// collector only adds CPU: GOGC=off cuts about a quarter of helm's CPU time for under 10 MB
// more peak memory per child. GOMEMLIMIT still collects if a child nears 512 MiB.
function run(command: string, args: readonly string[]) {
  return new Promise<RenderedProfile["renderer"]>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repository,
      env: { ...process.env, GOGC: "off", GOMEMLIMIT: "512MiB" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve(code === 0 ? { ok: true, output: stdout } : { ok: false, output: stdout + stderr }),
    );
  });
}

// Renders in-process through the function the CLI calls. `renderer.output` is what the CLI
// prints: the preflight summary on stdout, or its stderr line for a refusal without one.
// profile-renderer.test.mjs covers the CLI process itself (argv, exit status, stdout).
async function renderProfile(
  profileInput: TestInput,
  profile = "openclaw",
): Promise<RenderedProfile> {
  const directory = mkdtempSync(join(tmpdir(), "oce-profile-parity-"));
  try {
    writeFileSync(join(directory, "input.json"), JSON.stringify(profileInput));
    let renderer: RenderedProfile["renderer"];
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
async function withProfile<Result>(
  profileInput: TestInput,
  check: (rendered: RenderedProfile) => Result | Promise<Result>,
  profile?: string,
): Promise<Result> {
  const rendered = await renderProfile(profileInput, profile);
  try {
    return await check(rendered);
  } finally {
    rmSync(rendered.directory, { recursive: true, force: true });
  }
}

// Renders a known-good profile once; refused cases override one field of its values.
let baseline: Promise<RenderedProfile> | undefined;
after(() => baseline?.then(({ directory }) => rmSync(directory, { recursive: true, force: true })));
async function baselineValues() {
  baseline ??= renderProfile(input({}));
  const { directory, renderer } = await baseline;
  assert.equal(renderer.ok, true, renderer.output);
  return join(directory, "values.yaml");
}

function helmTemplate(valueFiles: readonly string[]) {
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
function writeOverride(directory: string, values: TestInput) {
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
}: ParityCase) {
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
      let valueFiles = [join(directory, "values.yaml")];
      if (!accepted) {
        assert.ok(values, label);
        valueFiles = [await baselineValues(), writeOverride(directory, values)];
      }
      const chart = await helmTemplate(valueFiles);
      assert.equal(chart.ok, accepted, `${label}: helm template\n${chart.output}`);
      if (!accepted) {
        assert.ok(chartError, label);
        assert.match(chart.output, chartError, label);
      }
      return chart.output;
    },
    profile,
  );
}

// One Helm-backed test for one field: `cases` are [value, accepted, chartError?] rows.
function fieldParity(
  name: string,
  {
    cases,
    label = short,
    controlPlane,
    extraInput = () => ({}),
    values,
    chartError,
  }: FieldParityCases<string>,
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

const computeCases = profileComputeCases({
  repository,
  helm,
  helmSkip,
  repositoryInput,
  loadYaml,
  input,
  each,
  run,
  renderProfile,
  withProfile,
  baselineValues,
  helmTemplate,
  writeOverride,
  assertParity,
  fieldParity,
  escape,
  short,
});

const cidrCases: VerdictCase<string>[] = [
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
    each<VerdictCase<string>>(
      [
        ["x-real-ip", true],
        ["x-forwarded-for", true],
        // The chart lowercases the header first, so preflight does too.
        ["X-Real-IP", true],
        ["X-Forwarded-For", true],
        ...refusedClientAddressHeaders.map((header): VerdictCase<string> => [header, false]),
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

computeCases.registerNamespaces();

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

computeCases.registerSelectors();

test(
  "external sign-in credential keys get the same verdict from preflight and the chart",
  { skip: helmSkip },
  () => {
    const keyCases: VerdictCase<TestInput>[] = [
      [{}, true],
      [{ clientIdKey: "id" }, true],
      [{ clientSecretKey: "secret" }, true],
      [{ clientIdKey: "id", clientSecretKey: "secret" }, true],
      [{ clientIdKey: "same-key", clientSecretKey: "same-key" }, false],
      [{ clientIdKey: "client-secret" }, false],
      [{ clientSecretKey: "client-id" }, false],
    ];
    const cases = ["google", "oidc"].flatMap((provider) =>
      keyCases.map(([keys, accepted]) => [provider, keys, accepted] as const),
    );
    return each(cases, ([provider, keys, accepted]) => {
      const settings = { ...(provider === "oidc" ? oidcEndpoints : {}), ...keys };
      return assertParity({
        label: `${provider}: ${JSON.stringify(keys)}`,
        controlPlane: { google: undefined, [provider]: settings },
        values: {
          auth: { google: { enabled: false }, [provider]: { enabled: true, ...settings } },
        },
        accepted,
        chartError:
          /auth\.(google|oidc) client ID and client secret must use different Secret keys/,
      });
    });
  },
);

computeCases.registerImages();

// The chart checks the percent-decoded host for invisible characters that Node's host
// parser drops.
const invisibleHost = /auth\.baseUrl must not contain spaces, invisible characters, < or >/;
const sharedDnsSuffix =
  /auth\.baseUrl and agentNativeAdmin\.domain must share a non-public DNS suffix/;
fieldParity("auth base URLs get the same verdict from preflight and the chart", {
  cases: [
    ["https://[::1]", false, sharedDnsSuffix],
    ["https://[::192.0.2.1]", false, sharedDnsSuffix],
    ["https://[64:ff9b::192.0.2.1]:8443", false, sharedDnsSuffix],
    ["https://[::ffff:1:2:3]", false, sharedDnsSuffix],
    ["https://ex%C3%A4.oce.example.internal", true],
    ...["%C2%AD", "%E2%80%8B", "%E2%81%A0", "%EF%BB%BF", "%E1%A0%8E", "%F0%9D%85%B3"].map(
      (escaped): VerdictCase<string> => [`https://ex${escaped}ample.com`, false, invisibleHost],
    ),
    ["https://ex%e2%80%8bample.com:8443", false, invisibleHost],
    // A joiner may sit inside a label, encoded or not, but not at the start or end of the URL.
    ["https://\u0915\u094d\u200d\u0937.oce.example.internal", true],
    ["https://\u0915\u094d%E2%80%8D\u0937.oce.example.internal", true],
    [
      "https://example.\u0915\u094d\u200d",
      false,
      /auth\.baseUrl must not begin or end with Unicode spaces or invisible characters/,
    ],
    // Unmapped IPv6 still cannot share a DNS cookie scope.
    ["https://[::1:ffff:c000:201]", false, sharedDnsSuffix],
    // An uppercase scheme still gets the IPv4 and percent-escape checks.
    ["HTTPS://192.0.2.10", false, sharedDnsSuffix],
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
      syntheticCredentialUrl({
        username: "",
        password: "secret",
        host: "console.example.com",
        port: undefined,
      }),
      false,
      /auth\.baseUrl must be an absolute HTTP\(S\) origin/,
    ],
  ],
  label: (url) => url,
  controlPlane: (url) => ({ authBaseUrl: url }),
  values: (url) => ({ auth: { baseUrl: url } }),
});

// Helm built with Go 1.24.9 (Helm 3.19.2) refuses an IPv4-mapped IPv6 host in any spelling
// as an invalid IPv6 host; newer Go reaches shared DNS scope validation. Both layers
// refuse IP-based browser origins regardless of the Helm build.
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
          assert.equal(chart.ok, false, `${url}: helm template\n${chart.output}`);
          assert.match(
            chart.output,
            /invalid IPv6 host|auth\.baseUrl and agentNativeAdmin\.domain must share a non-public DNS suffix/,
            url,
          );
        }),
    ),
);

computeCases.registerRepositoryImage();

test(
  "external sign-in Secret names get the same verdict from preflight and the chart",
  { skip: helmSkip },
  () => {
    // The chart's openclaw.gatewayRouting.rootSecretName for release oce in openclaw-system.
    const gatewayRootSecret = `occ-gateway-${createHash("sha256").update("openclaw-system/oce-agent-gateways").digest("hex").slice(0, 12)}-root`;
    // [label, controlPlane providers, accepted]. The chart compares each enabled provider's
    // Secret, default or explicit, with the platform Secrets and each provider before it.
    const cases: Array<
      [string, Partial<Record<"google" | "oidc", TestInput | undefined>>, boolean]
    > = [
      ["defaults", { google: {}, oidc: oidcEndpoints }, true],
      [
        "distinct custom names",
        { google: { secretName: "login-a" }, oidc: { ...oidcEndpoints, secretName: "login-b" } },
        true,
      ],
      ["google alone", { google: { secretName: "custom-login" } }, true],
      ["gateway API key", { google: { secretName: "occ-private-gateway-key" } }, false],
      ["generated Gateway TLS", { google: { secretName: "oce-agent-gateways-tls" } }, false],
      ["generated Gateway root CA", { google: { secretName: gatewayRootSecret } }, false],
      ["installation", { google: { secretName: "occ-installation-startup" } }, false],
      ["database", { google: { secretName: "occ-database" } }, false],
      ["auth", { google: undefined, oidc: { ...oidcEndpoints, secretName: "occ-auth" } }, false],
      [
        "google and oidc share",
        { google: { secretName: "shared" }, oidc: { ...oidcEndpoints, secretName: "shared" } },
        false,
      ],
      [
        "google default taken",
        { google: {}, oidc: { ...oidcEndpoints, secretName: "occ-google-login" } },
        false,
      ],
      [
        "oidc default taken",
        { google: { secretName: "occ-oidc-login" }, oidc: oidcEndpoints },
        false,
      ],
    ];
    return each(cases, ([label, providers, accepted]) => {
      const auth: TestInput = {};
      for (const name of ["google", "oidc"] as const) {
        const settings = name in providers ? providers[name] : name === "google" ? {} : undefined;
        auth[name] = settings === undefined ? { enabled: false } : { enabled: true, ...settings };
      }
      return assertParity({
        label,
        controlPlane: providers,
        values: { auth },
        accepted,
        chartError: /auth\.(google|oidc)\.secretName must name a dedicated Secret/,
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
    const withRepository = (backendId: string) => ({
      ...input({}),
      repository: { ...repositoryInput, backendId },
    });
    // Installation startup counts the ID in code points (isBackendId) and in UTF-16 code
    // units (the GitHub binding bound); an astral character counts once and twice.
    const ids: VerdictCase<string>[] = [
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
function jobEnv(manifests: string, name: string): unknown {
  const match = new RegExp(`- name: ${name}\\n\\s+value: (".*")\\n`).exec(manifests);
  assert.ok(match?.[1], `expected ${name} in the bootstrap Job`);
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
    const emails: VerdictCase<string>[] = [
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
    const cases: ParityCase[] = [];
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
    const secretNames: Array<[string, string | undefined]> = [
      ["occ-db-ca", undefined],
      [
        "occ-private-gateway-key",
        "gatewayRouting.apiKeySecretName must name a dedicated Secret; occ-private-gateway-key is also database.caSecretName",
      ],
      [
        "occ-google-login",
        "auth.google.secretName must name a dedicated Secret; occ-google-login is also database.caSecretName",
      ],
      [
        "occ-database",
        "database.caSecretName must name a dedicated Secret; occ-database is also database.secretName",
      ],
      [
        "oce-agent-gateways-tls",
        "database.caSecretName must name a dedicated Secret; oce-agent-gateways-tls is also gatewayRouting.tlsSecretName",
      ],
    ];
    const cases: ParityCase[] = secretNames.map(([secretName, refusal]) => ({
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
const resourceNameRefusal = (field: string) =>
  new RegExp(`${escape(field)} must be a Kubernetes resource name of at most 253 characters`);
const resourceNameCases: VerdictCase<string>[] = [
  ["occ.custom-secret-v2", true],
  ["a".repeat(253), true],
  ["Bad_Name", false],
  ["-secret", false],
  ["secret.", false],
  ["a".repeat(254), false],
];
const resourceNames: Array<
  [string, string, (name: string) => TestInput, (name: string) => TestInput]
> = [
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
    "controlPlane.google.secretName",
    "auth.google.secretName",
    (secretName) => ({ google: { egressCidrs: ["192.0.2.20/32"], secretName } }),
    (secretName) => ({ auth: { google: { secretName } } }),
  ],
];
for (const [field, chartField, controlPlane, values] of resourceNames) {
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
