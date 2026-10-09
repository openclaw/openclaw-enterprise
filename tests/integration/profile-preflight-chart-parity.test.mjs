import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { clientAddressConfiguration } from "../../apps/controller/src/auth/client-address.ts";

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
    execFileSync(command, args, {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 4_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: "" };
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

function renderProfile(profileInput) {
  const directory = mkdtempSync(join(tmpdir(), "oce-profile-parity-"));
  writeFileSync(join(directory, "input.json"), JSON.stringify(profileInput));
  const renderer = run(process.execPath, [
    "scripts/render-installation-profile.mjs",
    "--profile",
    "openclaw",
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

// The renderer's own values must render when it accepts. When it refuses, the same value
// placed over a good profile must make the chart refuse too, with the expected message.
function assertParity({ label, controlPlane, values, accepted, chartError }) {
  const { directory, renderer } = renderProfile(input(controlPlane));
  try {
    assert.equal(renderer.ok, accepted, `${label}: renderer\n${renderer.output}`);
    let chart;
    if (accepted) {
      chart = helmTemplate([join(directory, "values.yaml")]);
    } else {
      const override = join(directory, "override.json");
      writeFileSync(override, JSON.stringify(values));
      chart = helmTemplate([join(baselineDirectory(), "values.yaml"), override]);
    }
    assert.equal(chart.ok, accepted, `${label}: helm template\n${chart.output}`);
    if (!accepted) {
      assert.match(chart.output, chartError, label);
    }
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
