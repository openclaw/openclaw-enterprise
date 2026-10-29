import {
  requireConfiguration,
  ConfigurationValidationError as SharedConfigurationValidationError,
} from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  linkSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
import { fileTemporaryDirectory } from "../helpers/temporary-directory.mjs";
import { helmTemplate } from "../helpers/production-chart.mjs";
import {
  RenderRefusal,
  renderInstallationProfile,
} from "../../scripts/render-installation-profile.mjs";

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
    authority: "prepared-git",
    preparedCustodySecretName: "occ-repository-custody",
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

// Runs the renderer CLI as its own process. Cases about argv, the exit status, the
// stdout summary, a checkout copied elsewhere (`root`) or process-wide DNS settings
// (`dnsServer`) use it; the rest render in-process with `render` below.
function renderCli(
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

// Renders through the same entry point the CLI calls, without a Node start per case.
// A refusal throws like renderCli: profileRendererOutput is the preflight summary the
// CLI prints on stdout (the CLI writes nothing to stderr for a preflight refusal).
async function render(
  profile,
  input,
  directory = fileTemporaryDirectory(`oce-profile-${profile}-`),
) {
  const inputPath = join(directory, "input.json");
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`);
  let summary;
  try {
    summary = await renderInstallationProfile({ profile, input: inputPath, outDir: directory });
  } catch (error) {
    // Only a refusal carries renderer output; a renderer crash propagates without it.
    if (!(error instanceof RenderRefusal)) {
      throw error;
    }
    error.profileRendererOutput = `render-installation-profile: ${error.message}\n`;
    error.profileRendererDirectory = directory;
    throw error;
  }
  if (!summary.ok) {
    const output = `${JSON.stringify(summary, null, 2)}\n`;
    const error = new Error(`profile renderer refused the input\n${output}`);
    error.profileRendererOutput = output;
    error.profileRendererDirectory = directory;
    throw error;
  }
  return {
    directory,
    summary,
    values: readFileSync(join(directory, "values.yaml"), "utf8"),
    installation: readFileSync(join(directory, "installation.yaml"), "utf8"),
    preflight: JSON.parse(readFileSync(join(directory, "preflight.json"), "utf8")),
  };
}

async function startDnsFixture(t, records) {
  const directory = mkdtempSync(join(tmpdir(), "oce-profile-dns-"));
  const queriesPath = join(directory, "queries.txt");
  writeFileSync(queriesPath, "");
  // The CLI is synchronous in these tests; a separate process must answer its
  // real DNS queries while the test runner is blocked waiting for rendering.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        import { createSocket } from "node:dgram";
        import { appendFileSync } from "node:fs";
        const socket = createSocket("udp4");
        socket.on("message", (query, peer) => {
          let end = 12;
          const labels = [];
          while (query[end] !== 0) {
            const length = query[end++];
            labels.push(query.subarray(end, end + length).toString());
            end += length;
          }
          const hostname = labels.join(".");
          appendFileSync(${JSON.stringify(queriesPath)}, hostname + "\\n");
          const records = ${JSON.stringify(records)};
          const addresses = records[hostname];
          const header = Buffer.alloc(12);
          query.copy(header, 0, 0, 2);
          header.writeUInt16BE(addresses ? 0x8180 : 0x8183, 2);
          header.writeUInt16BE(1, 4);
          header.writeUInt16BE(addresses?.length ?? 0, 6);
          const answers = (addresses ?? []).map((address) => {
            const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 0, 0, 0, 0]);
            Buffer.from(address.split(".").map(Number)).copy(answer, 12);
            return answer;
          });
          socket.send(Buffer.concat([header, query.subarray(12, end + 5), ...answers]), peer.port, peer.address);
        });
        socket.bind(0, "127.0.0.1", () => process.send(socket.address().port));
        process.on("disconnect", () => socket.close());
      `,
    ],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] },
  );
  t.after(async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) });
        child.kill("SIGKILL");
        await exited;
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const [port] = await Promise.race([
    once(child, "message", { signal: AbortSignal.timeout(5000) }),
    once(child, "exit").then(() => {
      throw new Error("DNS fixture exited before listening");
    }),
  ]);
  return { directory, queriesPath, server: `127.0.0.1:${port}` };
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

async function renderError(callback) {
  try {
    await callback();
  } catch (error) {
    return error;
  }
  assert.fail("expected the profile renderer to reject the input");
}

async function assertPreflightFailure(profile, input, expected) {
  const error = await renderError(() => render(profile, input));
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
async function assertFieldRefusals(profile, input, field, values, message) {
  const expected =
    typeof message === "string" ? new RegExp(escapeRegExp(`${field} ${message}`)) : message;
  const keys = field.split(".");
  for (const value of values) {
    const changed = structuredClone(input);
    const parent = keys.slice(0, -1).reduce((object, key) => (object[key] ??= {}), changed);
    parent[keys.at(-1)] = value;
    try {
      await assertPreflightFailure(profile, changed, expected);
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
  // A real process: the stdout summary and the files it writes.
  const openclaw = renderCli("openclaw", baseInput());
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

  const codex = renderCli("codex", codexInput());
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
// peaks (see the renderer): Gateways hold 2.3-2.4 GiB and peak at 2.8 GiB; a
// Codex Harness holds about 0.5 GiB and reached a 4 GiB limit building and testing.
const gatewayResources = {
  requests: { cpu: "100m", memory: "2560Mi" },
  limits: { cpu: "4", memory: "4Gi" },
};
const harnessResources = {
  requests: { cpu: "100m", memory: "768Mi" },
  limits: { cpu: "4", memory: "6Gi" },
};

test("preflight rejects noncanonical SHA-256 image digests", async (t) => {
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
        // A 65th hex digit is not a SHA-256 digest.
        `${image}0`,
      ]) {
        // A failed rerender must revoke the previously successful artifacts.
        assert.equal((await render(profile, input, directory)).preflight.ok, true);
        const changed = structuredClone(input);
        changed[section][key] = invalid;
        const error = await renderError(() => render(profile, changed, directory));
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

test("profiles give tenant runtimes four-core CPU limits over unchanged 100m requests", async () => {
  const example = loadYaml(
    readFileSync(
      new URL("../../deploy/examples/production/installation.yaml", import.meta.url),
      "utf8",
    ),
  );
  for (const [name, installation] of [
    ["openclaw", loadYaml((await render("openclaw", baseInput())).installation)],
    ["codex", loadYaml((await render("codex", codexInput())).installation)],
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
  requireConfiguration(KubernetesComputeDriver, compute);
});

test("managed ChatGPT service-account wiring is optional and explicit", async () => {
  const codex = await render("codex", managedCodexInput());
  assert.equal(codex.summary.ok, true);
  assert.match(codex.values, /backend:\n {2}chatgpt:\n {4}enabled: true/);
  assert.match(codex.installation, /service_account: chatgpt-service-accounts/);
  assert.match(codex.preflight.warnings.join("\n"), /issuance is wired but remains unverified/);
});

test("profiles reject invalid Helm release names before emitting deployment files", async (t) => {
  for (const profile of ["openclaw", "codex"]) {
    const input = profile === "codex" ? codexInput() : baseInput();
    const directory = mkdtempSync(join(tmpdir(), `oce-release-name-${profile}-`));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    for (const releaseName of ["r".repeat(54), "Oce", "oce-", "oce..example", "oce example"]) {
      // A failed rerender must also remove files from a previously valid release.
      await render(profile, input, directory);
      // A real process, so the refusal's exit status is checked.
      assert.throws(
        () =>
          renderCli(
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
  async () => {
    for (const profile of ["openclaw", "codex"]) {
      // Exercise the DNS-name boundary and Helm's maximum supported release length.
      for (const length of [48, 49, 53]) {
        const input = profile === "codex" ? codexInput() : baseInput();
        const releaseName = "r".repeat(length);
        input.controlPlane.releaseName = releaseName;
        const output = await render(profile, input);
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

test("profile renderer refuses input paths owned by its output directory without deleting files", async (t) => {
  for (const name of ["values.yaml", "installation.yaml", "preflight.json"]) {
    for (const alias of ["direct", "input-directory", "output-directory", "file", "hardlink"]) {
      await t.test(`${name}, alias=${alias}`, async () => {
        const directory = fileTemporaryDirectory("occ-profile-input-collision-");
        const output = join(directory, "output");
        mkdirSync(output);
        // Seed real rendered files. A naming mistake must not destroy the input or its siblings.
        await render("openclaw", baseInput(), output);
        const input = join(output, name);
        writeFileSync(input, JSON.stringify(baseInput()));
        const before = new Map(
          ["values.yaml", "installation.yaml", "preflight.json"].map((file) => [
            file,
            readFileSync(join(output, file)),
          ]),
        );
        let inputPath = input;
        let outputPath = output;
        if (alias === "input-directory" || alias === "output-directory") {
          const link = join(directory, "output-alias");
          symlinkSync(output, link, "dir");
          if (alias === "input-directory") {
            inputPath = join(link, name);
          } else {
            outputPath = link;
          }
        } else if (alias === "file" || alias === "hardlink") {
          inputPath = join(directory, "input-alias.json");
          if (alias === "file") {
            symlinkSync(input, inputPath);
          } else {
            linkSync(input, inputPath);
          }
        }
        assert.throws(
          () =>
            execFileSync(
              process.execPath,
              [
                "scripts/render-installation-profile.mjs",
                "--profile",
                "openclaw",
                "--input",
                inputPath,
                "--out-dir",
                outputPath,
              ],
              { cwd: repository, stdio: "pipe" },
            ),
          /input must not name a generated output file/,
        );
        for (const [file, contents] of before) {
          assert.deepEqual(readFileSync(join(output, file)), contents, file);
        }
      });
    }
  }
});

test("failed rerenders remove stale deployable artifacts from a reused directory", async () => {
  for (const profile of ["openclaw", "codex"]) {
    const input = profile === "codex" ? codexInput() : baseInput();
    const output = await render(profile, input);
    const notes = join(output.directory, "operator-notes.txt");
    writeFileSync(notes, "Retain operator-owned files.\n");

    // A failed second run must not leave the first run's configuration deployable.
    const invalid = structuredClone(input);
    invalid.controlPlane.databaseCidrs = ["invalid-cidr"];
    const error = await renderError(() => render(profile, invalid, output.directory));
    assert.match(error.profileRendererOutput, /must be an IPv4 \/32 CIDR/);
    for (const name of ["values.yaml", "installation.yaml"]) {
      assert.equal(existsSync(join(output.directory, name)), false);
    }
    const preflight = JSON.parse(readFileSync(join(output.directory, "preflight.json"), "utf8"));
    assert.equal(preflight.ok, false);
    assert.deepEqual(preflight.outputs, { preflight: join(output.directory, "preflight.json") });
    assert.equal(readFileSync(notes, "utf8"), "Retain operator-owned files.\n");

    // Recovery regenerates both artifacts; malformed JSON must also invalidate that success.
    assert.equal((await render(profile, input, output.directory)).preflight.ok, true);
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

    // A filesystem metadata failure must still revoke stale success before reporting bad input.
    assert.equal((await render(profile, input, output.directory)).preflight.ok, true);
    const loop = join(output.directory, "loop.json");
    symlinkSync(loop, loop);
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            "scripts/render-installation-profile.mjs",
            "--profile",
            profile,
            "--input",
            loop,
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

test(
  "profiles preserve provider ranges and configure hosted discovery egress",
  { skip: helmSkip },
  async (t) => {
    const dns = await startDnsFixture(t, {
      "auth.openai.com": ["198.51.100.20", "192.0.2.40"],
      "chatgpt.com": ["192.0.2.40"],
    });
    for (const profile of ["openclaw", "codex"]) {
      // Provider ranges must survive rendering; individual DNS answers are not stable.
      const input = profile === "codex" ? codexInput() : baseInput();
      input.repository = repositoryConfiguration(["140.82.112.0/20", "192.30.252.0/22"]);
      const directory = mkdtempSync(join(tmpdir(), `oce-profile-egress-${profile}-`));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const output = renderCli(profile, input, directory, repository, dns.server);
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
      assert.deepEqual(
        loadYaml(output.values).api.modelDiscoveryCidrs,
        profile === "codex" ? ["192.0.2.20/32"] : [],
      );
    }

    // Explicit [] leaves networking to an external FQDN policy. Neither explicit
    // form may need working DNS or silently grant additional destinations.
    const external = renderCli(
      "codex",
      codexInput({ codex: { modelDiscoveryCidrs: [] } }),
      dns.directory,
      repository,
      dns.server,
    );
    assert.deepEqual(loadYaml(external.values).api.modelDiscoveryCidrs, []);
    assert.doesNotMatch(
      helmTemplate(external),
      /name: openclaw-enterprise-api-model-discovery-egress/,
    );
    assert.equal(readFileSync(dns.queriesPath, "utf8"), "");

    const discovered = renderCli(
      "codex",
      codexInput({ codex: { modelDiscoveryCidrs: undefined } }),
      dns.directory,
      repository,
      dns.server,
    );
    const cidrs = ["192.0.2.40/32", "198.51.100.20/32"];
    assert.deepEqual(loadYaml(discovered.values).api.modelDiscoveryCidrs, cidrs);
    const queriedHosts = readFileSync(dns.queriesPath, "utf8").trim().split("\n").sort();
    assert.deepEqual(queriedHosts, ["auth.openai.com", "chatgpt.com"]);
    t.diagnostic(`Hosted discovery DNS queries: ${queriedHosts.join(", ")}`);
    const documents = helmTemplate(discovered)
      .split(/\n---\n/)
      .map((document) => JSON.parse(JSON.stringify(loadYaml(document))));
    const policy = documents.find(
      (document) => document.metadata?.name === "openclaw-enterprise-api-model-discovery-egress",
    );
    assert.ok(policy, "omitted hosted discovery CIDRs must create the API HTTPS policy");
    assert.deepEqual(policy.spec.podSelector.matchLabels, {
      "app.kubernetes.io/name": "openclaw-enterprise",
      "app.kubernetes.io/instance": "oce",
      "app.kubernetes.io/component": "api",
    });
    assert.deepEqual(policy.spec.policyTypes, ["Egress"]);
    assert.deepEqual(policy.spec.egress, [
      {
        to: cidrs.map((cidr) => ({ ipBlock: { cidr } })),
        ports: [{ protocol: "TCP", port: 443 }],
      },
    ]);
    const deny = documents.find(
      (document) => document.metadata?.name === "openclaw-enterprise-default-deny",
    );
    assert.deepEqual(deny.spec.policyTypes, ["Ingress", "Egress"]);
    assert.equal(deny.spec.egress, undefined);
  },
);

test("hosted discovery DNS failures revoke stale deployment artifacts", async (t) => {
  const dns = await startDnsFixture(t, { "auth.openai.com": ["192.0.2.40"] });
  // Explicit policy input stays usable with an unavailable hosted DNS name.
  assert.equal(
    renderCli("codex", codexInput(), dns.directory, repository, dns.server).preflight.ok,
    true,
  );
  const error = await renderError(() =>
    renderCli(
      "codex",
      codexInput({ codex: { modelDiscoveryCidrs: undefined } }),
      dns.directory,
      repository,
      dns.server,
    ),
  );
  const preflight = JSON.parse(readFileSync(join(dns.directory, "preflight.json"), "utf8"));
  assert.equal(preflight.ok, false);
  assert.ok(preflight.errors.join("\n").includes("IPv4 addresses for chatgpt.com."));
  assert.match(preflight.errors.join("\n"), /modelDiscoveryCidrs/);
  assert.match(preflight.errors.join("\n"), /retry|re-?render|supply|set|provide|configure/i);
  assert.equal(existsSync(join(dns.directory, "values.yaml")), false);
  assert.equal(existsSync(join(dns.directory, "installation.yaml")), false);
  assert.deepEqual(preflight.outputs, { preflight: join(dns.directory, "preflight.json") });
  assert.equal(error.status, 1);
  t.diagnostic(preflight.errors.join("\n"));
});

test(
  "startup-only installation changes roll API and worker pod templates",
  { skip: helmSkip },
  async () => {
    const original = await render("codex", codexInput());
    const changed = await render(
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
  async () => {
    const original = await render("codex", codexInput());
    const changed = await render(
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

test("Helm catches generated profile Secret collisions", { skip: helmSkip }, async () => {
  const repositoryOutput = await render(
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

  const error = await renderError(() => helmTemplate(repositoryOutput, [collision]));
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
  async () => {
    // 47 is the only release length where the TLS name ends in "-" after truncation.
    for (const releaseName of ["oce", "r".repeat(47), "r".repeat(53)]) {
      const input = baseInput();
      input.controlPlane.releaseName = releaseName;
      const accepted = await render("openclaw", input);
      const manifests = helmTemplate(accepted, [], releaseName);
      for (const { name, role, helm: refusal } of generatedGatewaySecrets(releaseName)) {
        assert.match(manifests, new RegExp(`\\n {2}secretName: "${name}"\\n`), name);
        const override = join(accepted.directory, "gateway-key-collision.yaml");
        writeFileSync(override, `gatewayRouting:\n  apiKeySecretName: ${name}\n`);
        const error = await renderError(() => helmTemplate(accepted, [override], releaseName));
        assert.match(`${error.stdout ?? ""}${error.stderr ?? ""}`, refusal);
        await assertPreflightFailure(
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
  "preparedCustodySecretName",
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
  async () => {
    const input = managedCodexInput({ repository: repositoryConfiguration() });
    const accepted = await render("codex", withGitHubSignIn(input, {}));
    assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
    helmTemplate(accepted);
    for (const secretName of [
      "occ-chatgpt-admin",
      "occ-repository-service-config",
      "occ-repository-app-key",
      "occ-repository-custody",
      "occ-repository-tls",
      "occ-repository-public-ca",
    ]) {
      // The ChatGPT admin Secret comes before sign-in and the repository Secrets after it, in
      // the chart's order, so either setting can be the one refused.
      await assertPreflightFailure(
        "codex",
        withGitHubSignIn(input, { secretName }),
        /controlPlane\.github\.secretName must name a dedicated Secret|must name a dedicated Secret; \S+ is also controlPlane\.github\.secretName\./,
      );
      // The same name placed over the accepted values makes the chart refuse it too.
      const override = join(accepted.directory, `github-${secretName}.json`);
      writeFileSync(override, JSON.stringify({ auth: { github: { secretName } } }));
      const error = await renderError(() => helmTemplate(accepted, [override]));
      assert.match(
        `${error.stdout ?? ""}${error.stderr ?? ""}`,
        /auth\.github\.secretName must name a dedicated Secret|must name a dedicated Secret; \S+ is also auth\.github\.secretName/,
      );
    }
    // Without managed ChatGPT accounts the chart does not reserve that Secret name.
    const unmanaged = await render(
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
  async () => {
    const input = managedCodexInput({ repository: repositoryConfiguration() });
    const accepted = await render("codex", input);
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
        ["preparedCustodySecretName", "occ-database", "database.secretName"],
        [
          "preparedCustodySecretName",
          "occ-repository-app-key",
          "repositoryCredentials.appKeySecretName",
        ],
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
      await assertFieldRefusals("codex", input, field, [name], preflight);
      const override = join(accepted.directory, "secret-collision.json");
      writeFileSync(override, JSON.stringify(chartValues));
      const error = await renderError(() => helmTemplate(accepted, [override]));
      assert.match(`${error.stdout ?? ""}${error.stderr ?? ""}`, refusal, `${field} = ${name}`);
    }
  },
);

test(
  "preflight refuses credential Secrets named like the log collector's, as Helm does",
  { skip: helmSkip },
  async () => {
    const input = managedCodexInput({ repository: repositoryConfiguration() });
    input.controlPlane.loggingCollector = { enabled: true, exporter: { cidr: "192.0.2.40/32" } };
    const accepted = await render("codex", input);
    assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
    helmTemplate(accepted);
    const override = join(accepted.directory, "secret-collision.json");
    writeFileSync(
      override,
      JSON.stringify({ gatewayRouting: { apiKeySecretName: "occ-otel-collector-config" } }),
    );
    const error = await renderError(() => helmTemplate(accepted, [override]));
    assert.match(
      `${error.stdout ?? ""}${error.stderr ?? ""}`,
      /logging\.collector\.configSecretName must name a dedicated Secret; occ-otel-collector-config is also gatewayRouting\.apiKeySecretName/,
    );
    await assertFieldRefusals(
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
  async () => {
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
      const output = await render("openclaw", input);
      assert.equal(output.summary.ok, true, output.preflight.errors.join("\n"));
      const rule = egress(output);
      assert.deepEqual(rule.to, [peer], JSON.stringify(exporter));
      assert.deepEqual(rule.ports, [{ protocol: "TCP", port }], JSON.stringify(exporter));
    }
    const input = baseInput();
    input.controlPlane.loggingCollector = { enabled: true };
    await assertPreflightFailure(
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
    name: "profiles refuse ChatGPT admin Secret references Kubernetes refuses",
    profile: "codex",
    input: managedCodexInput,
    cases: [
      [
        "codex.managedServiceAccounts.adminSecretName",
        ["Bad_Name", "-chatgpt-admin", "c".repeat(254)],
        "must be a Kubernetes resource name of at most 253 characters",
      ],
      [
        "codex.managedServiceAccounts.adminSecretKey",
        ["bad/key", ".", "..admin-key", "a".repeat(254)],
        "must be a Kubernetes Secret key of at most 253 characters",
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
      // Profiles leave the chart's default Collector image (a values file may override it, and the
      // chart checks it); this pins that preflight takes no image field.
      [
        "controlPlane.loggingCollector.image",
        [
          `docker.io/otel/opentelemetry-collector-contrib@sha256:${"d".repeat(64)}`,
          `docker.io/Otel/opentelemetry-collector-contrib@sha256:${"d".repeat(64)}`,
        ],
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
    name: "preflight refuses database CA Secret names that Kubernetes refuses",
    cases: [
      [
        "controlPlane.databaseCa.secretName",
        ["Bad_Name", "-db-ca", "d".repeat(254)],
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
    name: "preflight rejects repository resource names Kubernetes refuses",
    profile: "codex",
    input: () => codexInput({ repository: repositoryConfiguration() }),
    cases: [
      ...[
        "registryConfigMapName",
        "serviceConfigSecretName",
        "appKeySecretName",
        "tlsSecretName",
        "publicCaSecretName",
      ].map((field) => [
        `repository.${field}`,
        ["Bad_Name", "bad name", `-${field.toLowerCase()}`, "a".repeat(254)],
        "must be a Kubernetes resource name of at most 253 characters",
      ]),
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
  test(name, async () => {
    for (const [field, values, message] of cases) {
      await assertFieldRefusals(profile, input(), field, values, message);
    }
  });
}

test("label values that YAML 1.1 would retype stay strings", async () => {
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
  const output = await render("openclaw", input);
  for (const [key, value] of Object.entries(labels)) {
    const quotedValue = JSON.stringify(value);
    const expected = key === "yes" ? '"yes": keep' : `${key}: ${quotedValue}`;
    assert.ok(
      output.values.includes(expected),
      `expected ${key} to render as a quoted string in values.yaml`,
    );
  }
});

test("Helm renders YAML 1.1 lookalike label values as strings", { skip: helmSkip }, async () => {
  const input = baseInput();
  input.controlPlane.nodeSelector = { spot: "no", scale: "1e3", hex: "0x1f" };
  const manifests = helmTemplate(await render("openclaw", input));
  assert.match(manifests, /spot: ["']no["']/);
  assert.match(manifests, /scale: ["']1e3["']/);
  assert.match(manifests, /hex: ["']0x1f["']/);
  assert.doesNotMatch(manifests, /spot: false/);
  const rejected = baseInput();
  rejected.controlPlane.nodeSelector = { team: "@platform" };
  await assertPreflightFailure(
    "openclaw",
    rejected,
    /controlPlane\.nodeSelector values must be Kubernetes label values/,
  );
});

test("renderer rejects the removed default profile", () => {
  assert.throws(
    () => renderCli("default", baseInput()),
    /--profile must be one of: openclaw, codex/,
  );
});

test("repository opt-in is explicit and keeps the two-stage placeholders separate", async () => {
  const output = await render(
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

test("repository serviceName is left to the chart so its upgrade guard applies", async () => {
  const repositoryInput = repositoryConfiguration();
  const omitted = await render("codex", codexInput({ repository: repositoryInput }));
  assert.doesNotMatch(omitted.values, /serviceName: git/);
  if (!helmSkip) {
    assert.match(helmTemplate(omitted), /name: "git"\n/);
    const error = await renderError(() => helmTemplate(omitted, [], "oce", ["--is-upgrade"]));
    assert.match(
      `${error.stdout ?? ""}${error.stderr ?? ""}`,
      /repositoryCredentials\.serviceName must be explicit during upgrades/,
    );
  }

  const kept = await render(
    "codex",
    codexInput({ repository: { ...repositoryInput, serviceName: "oce-git" } }),
  );
  assert.match(kept.values, /serviceName: oce-git/);
  if (!helmSkip) {
    assert.match(helmTemplate(kept, [], "oce", ["--is-upgrade"]), /name: "oce-git"\n/);
  }
});

test("preflight rejects inputs that the selected profile does not consume", async () => {
  await assertFieldRefusals(
    "openclaw",
    baseInput(),
    "runtime.codexSeccompProfile",
    ["profiles/codex.json"],
    "is only consumed by the codex profile",
  );
  await assertFieldRefusals(
    "codex",
    codexInput(),
    "repository",
    [{ enabled: false, backendId: "github-primary" }],
    "fields other than enabled are only consumed",
  );
});

test("preflight rejects inputs that Helm would reject", async () => {
  await assertFieldRefusals(
    "openclaw",
    baseInput(),
    "controlPlane.gatewayApiKeySecretName",
    ["occ-installation-startup", "occ-database", "occ-auth"],
    "must name a dedicated Secret",
  );
  await assertFieldRefusals(
    "openclaw",
    baseInput(),
    "controlPlane.gatewayApiKeySecretName",
    generatedGatewaySecrets("oce").map(({ name }) => name),
    "must name a dedicated Secret; the chart generates",
  );
  await assertFieldRefusals(
    "codex",
    codexInput(),
    "controlPlane.metrics",
    [{ scraperNamespaceLabels: { name: "monitoring" } }],
    "requires both scraperNamespaceLabels and scraperPodLabels, or neither",
  );
  await assertFieldRefusals(
    "codex",
    codexInput(),
    "controlPlane.agentNativeAdminDomain",
    ["https://agents.oce.example.internal"],
    "must be a DNS hostname without a wildcard, port, scheme, or path",
  );
  await assertFieldRefusals(
    "codex",
    codexInput(),
    "controlPlane.agentNativeAdminDomain",
    ["agents.other.example.internal"],
    "must be inside controlPlane.sharedCookieDomain",
  );
  await assertFieldRefusals(
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
    await assertPreflightFailure(
      "codex",
      nativeAdminUnder(sharedCookieDomain),
      /controlPlane.sharedCookieDomain must not be a public suffix/,
    );
  }
  for (const sharedCookieDomain of ["example.co.uk", "oce.github.io"]) {
    assert.equal((await render("codex", nativeAdminUnder(sharedCookieDomain))).summary.ok, true);
  }

  await assertFieldRefusals(
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
  await assertFieldRefusals(
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
    const output = await render(
      "codex",
      codexInput({ controlPlane: { ...baseInput().controlPlane, authBaseUrl } }),
    );
    assert.equal(output.summary.ok, true, output.preflight.errors.join("\n"));
  }
  // An unparsable value is reported once, not again by the native admin checks.
  const error = await renderError(() =>
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

test("preflight rejects auth base URLs whose host percent-encodes an ASCII byte", async () => {
  const asciiEncoded = (authBaseUrl) =>
    codexInput({
      controlPlane: {
        ...baseInput().controlPlane,
        authBaseUrl,
        agentNativeAdminDomain: "agents.example.com",
        sharedCookieDomain: "example.com",
      },
    });
  const asciiRefusal =
    "controlPlane.authBaseUrl host must not percent-encode an ASCII byte; the chart's URL parser rejects it.";
  for (const authBaseUrl of ["https://ex%61mple.com", "https://example.com%2e"]) {
    // A real process, so the refusal's exit status is checked.
    const error = await renderError(() => renderCli("codex", asciiEncoded(authBaseUrl)));
    assert.equal(error.status, 1);
    assert.match(error.profileRendererOutput, new RegExp(escapeRegExp(asciiRefusal)));
    assert.doesNotMatch(
      error.profileRendererOutput,
      /must be an absolute HTTP\(S\) origin URL without a path, query, fragment, or user info/,
    );
    assert.equal(existsSync(join(error.profileRendererDirectory, "values.yaml")), false);
    const preflight = JSON.parse(
      readFileSync(join(error.profileRendererDirectory, "preflight.json"), "utf8"),
    );
    assert.equal(preflight.ok, false);
    assert.deepEqual(
      preflight.errors.filter((message) => message.includes("authBaseUrl")),
      [asciiRefusal],
    );
  }

  // A % that decodes to an IPv4 address stays on ipv4HostKept's existing origin refusal.
  const rewrittenIpv4 = await renderError(() =>
    render(
      "codex",
      codexInput({
        controlPlane: {
          ...baseInput().controlPlane,
          authBaseUrl: "https://192%2e168.1.1",
        },
      }),
    ),
  );
  assert.match(
    rewrittenIpv4.profileRendererOutput,
    /controlPlane\.authBaseUrl must be an absolute HTTP\(S\) origin URL without a path, query, fragment, or user info\./,
  );
  assert.doesNotMatch(rewrittenIpv4.profileRendererOutput, /percent-encode an ASCII byte/);

  const nonAscii = await render(
    "openclaw",
    externalSignInInput({
      trustedProxy: { preset: "ingress-nginx", cidrs: ["10.42.0.0/16"] },
      authBaseUrl: "https://ex%C3%A4.com",
    }),
  );
  assert.equal(nonAscii.summary.ok, true, nonAscii.preflight.errors.join("\n"));
  assert.match(nonAscii.values, /baseUrl: "https:\/\/ex%C3%A4\.com"/);
  if (!helmSkip) {
    helmTemplate(nonAscii);
  }
});

// Node accepts both and writes a deployable file; the chart then refuses it.
test("preflight rejects IPv4-mapped auth base URL hosts and encoded invisible characters", async () => {
  const refusals = [
    [
      "host must not be an IPv4-mapped IPv6 address, which Helm 3.19.2's URL parser rejects; write the IPv4 address instead.",
      ["https://[::ffff:192.0.2.1]", "https://[::FFFF:c000:201]:8443", "https://[::ffff:0:0]"],
    ],
    [
      "host must not percent-encode a space or invisible character; the chart refuses it in the decoded host.",
      [
        "https://ex%C2%ADample.com",
        "https://ex%E2%80%8Bample.com:8443",
        "https://ex%ef%bb%bfample.com",
      ],
    ],
  ];
  for (const [refusal, urls] of refusals) {
    for (const authBaseUrl of urls) {
      const error = await renderError(() =>
        render("openclaw", externalSignInInput({ authBaseUrl })),
      );
      assert.equal(existsSync(join(error.profileRendererDirectory, "values.yaml")), false);
      const preflight = JSON.parse(
        readFileSync(join(error.profileRendererDirectory, "preflight.json"), "utf8"),
      );
      assert.deepEqual(
        preflight.errors.filter((message) => message.includes("authBaseUrl")),
        [`controlPlane.authBaseUrl ${refusal}`],
        authBaseUrl,
      );
    }
  }
  for (const authBaseUrl of ["https://[::192.0.2.1]", "https://[::ffff:1:2:3]:8443"]) {
    const output = await render("openclaw", externalSignInInput({ authBaseUrl }));
    assert.equal(output.summary.ok, true, output.preflight.errors.join("\n"));
  }
});

// The chart lowercases the header before its checks and before OCC_AUTH_CLIENT_IP_HEADER.
test("trusted proxy client address headers render lowercase", async () => {
  const trustedProxy = (preset, clientAddressHeader) =>
    baseInput({
      controlPlane: {
        ...baseInput().controlPlane,
        trustedProxy: { preset, cidrs: ["10.42.0.0/16"], clientAddressHeader },
      },
    });
  for (const [preset, header] of [
    ["generic", "X-Real-IP"],
    ["ingress-nginx", "X-Forwarded-For"],
  ]) {
    const output = await render("openclaw", trustedProxy(preset, header));
    assert.equal(output.summary.ok, true, output.preflight.errors.join("\n"));
    assert.equal(
      loadYaml(output.values).api.trustedProxy.clientAddressHeader,
      header.toLowerCase(),
    );
  }
  await assertPreflightFailure(
    "openclaw",
    trustedProxy("generic", "Cookie"),
    /controlPlane\.trustedProxy\.clientAddressHeader cannot be cookie;/,
  );
});

// The API lowercases both domains at startup, and the chart accepts only lowercase.
test("native admin domains render lowercase for the chart", async () => {
  const output = await render(
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
  const withoutUrl = await render("openclaw", baseInput());
  assert.doesNotMatch(withoutUrl.installation, /observability:/);

  const output = await render(
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

  const genericObservabilityUrl =
    /controlPlane.observabilityUrl must be an absolute HTTP or HTTPS URL/;
  const rewrittenIpv4ObservabilityUrl =
    /controlPlane\.observabilityUrl IPv4 host must be four decimal octets from 0 to 255 with no leading zeros; other spellings parse as a different address\./;
  const assertObservabilityPreflight = async (observabilityUrl, expected, absent) => {
    const failure = await renderError(() =>
      render(
        "openclaw",
        baseInput({ controlPlane: { ...baseInput().controlPlane, observabilityUrl } }),
      ),
    );
    assert.match(failure.profileRendererOutput, expected);
    assert.doesNotMatch(failure.profileRendererOutput, absent);
    const directory = failure.profileRendererDirectory;
    assert.equal(existsSync(join(directory, "preflight.json")), true);
    assert.equal(existsSync(join(directory, "values.yaml")), false);
    assert.equal(existsSync(join(directory, "installation.yaml")), false);
    const preflight = JSON.parse(readFileSync(join(directory, "preflight.json"), "utf8"));
    assert.equal(preflight.ok, false);
    const errors = preflight.errors.join("\n");
    assert.match(errors, expected);
    assert.doesNotMatch(errors, absent);
  };
  for (const invalid of [
    "javascript:alert(1)",
    syntheticCredentialUrl({
      username: "user",
      password: "pass",
      host: "grafana.example.internal",
    }),
    "https://grafana.example.internal/#fragment",
    "grafana.example.internal",
    "ftp://grafana.example.internal/d/occ-observability",
    // Either credential alone is refused too.
    syntheticCredentialUrl({ username: "user", password: "", host: "grafana.example.internal" }),
    syntheticCredentialUrl({ username: "", password: "pass", host: "grafana.example.internal" }),
    // So is an empty user info, which Node drops: any @ before the host, with or without the
    // slashes, and before an IPv4 host too.
    "http://@grafana.example.internal/d",
    syntheticCredentialUrl({
      protocol: "https",
      username: "",
      password: "",
      host: "grafana.example.internal",
      pathname: "/d",
    }),
    "http:@grafana.example.internal/d",
    "http:\t//@grafana.example.internal/d",
    "http://@192.0.2.10:3000/d",
  ]) {
    await assertObservabilityPreflight(
      invalid,
      genericObservabilityUrl,
      rewrittenIpv4ObservabilityUrl,
    );
  }
  for (const shorthand of [
    "http://192.168.1",
    "http://2130706433",
    "http://127.1",
    "http://0177.0.0.1",
  ]) {
    await assertObservabilityPreflight(
      shorthand,
      rewrittenIpv4ObservabilityUrl,
      genericObservabilityUrl,
    );
  }
  const rewrittenHostChars =
    /controlPlane\.observabilityUrl must not contain a tab or newline, or a backslash before the query; the URL parser drops or rewrites them into a different host\./;
  for (const raw of [
    "http://good.example\tevil.com/x",
    "http://evil.com\\.good.example/path",
    "http://good.example\nevil.com/x",
    "http://good.example\revil.com/x",
  ]) {
    await assertObservabilityPreflight(raw, rewrittenHostChars, genericObservabilityUrl);
  }
  const queryBackslash = await render(
    "openclaw",
    baseInput({
      controlPlane: {
        ...baseInput().controlPlane,
        observabilityUrl: "https://grafana.example.test/d/operations?var-pattern=\\d+",
      },
    }),
  );
  assert.equal(queryBackslash.summary.ok, true);

  // URL parsing trims C0 controls and spaces and lowercases the scheme, so this is the
  // written address 192.0.2.10. Preflight and the startup parser must both accept it.
  const spaced = await render(
    "openclaw",
    baseInput({
      controlPlane: { ...baseInput().controlPlane, observabilityUrl: " HTTP://192.0.2.10 " },
    }),
  );
  assert.equal(spaced.summary.ok, true);
  const spacedSnapshot = await loadStartupConfigurationSnapshot({
    mode: "production",
    environment: { OCC_CONFIG_PATH: join(spaced.directory, "installation.yaml") },
  });
  assert.equal(spacedSnapshot.observability.url, "http://192.0.2.10/");
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
  async () => {
    const trustedProxy = { preset: "ingress-nginx", cidrs: ["10.42.0.0/16"] };
    const github = await render("openclaw", externalSignInInput({ trustedProxy }));
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
    const uppercase = await render(
      "openclaw",
      externalSignInInput({ trustedProxy, authBaseUrl: "HTTPS://Console.OCE.example.internal" }),
    );
    assert.equal(uppercase.summary.ok, true, uppercase.preflight.errors.join("\n"));
    assert.match(
      helmTemplate(uppercase),
      /name: OCC_AUTH_BASE_URL\n\s+value: "HTTPS:\/\/Console\.OCE\.example\.internal"/,
    );
    const allowlisted = await render(
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
    const recoveryOnly = await render(
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

    const google = await render(
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

    const oidc = await render(
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
    const padded = await render(
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
    const nativeAdmin = await render(
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
    "scripts/lib/prepared-repository-installation.mjs",
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

test("profiles render without installed dependencies unless native admin is on", async (t) => {
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
      output = renderCli(profile, input, directory, root);
    } catch (error) {
      assert.fail(`${profile} render failed without node_modules:\n${error.profileRendererOutput}`);
    }
    assert.equal(output.summary.ok, true, output.preflight.errors.join("\n"));
    assert.match(output.values, /agentNativeAdmin:\n {2}enabled: false\n/);
  }

  // Native admin needs the API's public suffix list, so it asks for the install, with a preflight.
  const directory = mkdtempSync(join(tmpdir(), "oce-profile-native-admin-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const error = await renderError(() => renderCli("openclaw", baseInput(), directory, root));
  assert.match(
    error.profileRendererOutput,
    /controlPlane\.sharedCookieDomain needs the public suffix list: run pnpm install first\./,
  );
  const preflight = JSON.parse(readFileSync(join(directory, "preflight.json"), "utf8"));
  assert.equal(preflight.ok, false);
  assert.equal(existsSync(join(directory, "values.yaml")), false);
});

test("preflight warns, without failing, when no trusted proxy is set", async () => {
  const github = await render("openclaw", externalSignInInput());
  assert.equal(github.summary.ok, true);
  assert.match(
    github.preflight.warnings.join("\n"),
    /controlPlane\.trustedProxy is not set: .*external sign-in starts have no per-client limit/,
  );
  assert.match(
    github.preflight.warnings.join("\n"),
    /trustedProxy is not set: .*Behind an HTTP proxy, API calls fail with 403 until it is set\./,
  );
  assert.doesNotMatch(github.values, /trustedProxy:/);
  const password = await render("openclaw", baseInput());
  assert.equal(password.summary.ok, true);
  assert.match(
    password.preflight.warnings.join("\n"),
    /controlPlane\.trustedProxy is not set: failed password sign-ins are limited per email only/,
  );
  assert.match(
    password.preflight.warnings.join("\n"),
    /trustedProxy is not set: failed password .*Behind an HTTP proxy, API calls fail with 403 until it is set\./,
  );
});

test("preflight rejects external sign-in Secret names Kubernetes refuses", async () => {
  const oidc = {
    issuer: "https://tenant.idp.example.test/",
    authorizationUrl: "https://tenant.idp.example.test/authorize",
    tokenUrl: "https://tenant.idp.example.test/oauth/token",
    jwksUrl: "https://tenant.idp.example.test/.well-known/jwks.json",
  };
  for (const [provider, signIn] of [
    ["github", { github: { secretName: "Bad_Name" } }],
    ["google", { github: undefined, google: { secretName: "Bad_Name" } }],
    ["oidc", { github: undefined, oidc: { ...oidc, secretName: "Bad_Name" } }],
  ]) {
    await assertPreflightFailure(
      "openclaw",
      externalSignInInput(signIn),
      new RegExp(`controlPlane\\.${provider}\\.secretName must be a Kubernetes resource name`),
    );
  }
  for (const signIn of [
    { github: { secretName: "github.login-v2" } },
    { github: undefined, google: { secretName: "google.login-v2" } },
    { github: undefined, oidc: { ...oidc, secretName: "oidc.login-v2" } },
  ]) {
    assert.equal((await render("openclaw", externalSignInInput(signIn))).summary.ok, true);
  }
});

test("preflight rejects external sign-in and trusted proxy inputs Helm would reject", async () => {
  await assertPreflightFailure(
    "openclaw",
    externalSignInInput({ github: { allowedTeams: ["platform"] } }),
    /controlPlane.github.allowedTeams\[0\] must be a lowercase org\/team-slug entry/,
  );
  await assertPreflightFailure(
    "openclaw",
    externalSignInInput({
      github: { allowedOrgs: Array.from({ length: 11 }, (_, index) => `org${index}`) },
    }),
    /allowedOrgs and allowedTeams list at most 10 entries together/,
  );
  await assertPreflightFailure(
    "openclaw",
    externalSignInInput({ recoveryUserId: undefined }),
    /controlPlane.recoveryUserId is required with controlPlane.github, controlPlane.google or controlPlane.oidc/,
  );
  await assertPreflightFailure(
    "openclaw",
    baseInput({ controlPlane: { ...baseInput().controlPlane, recoveryUserId: "admin" } }),
    /controlPlane.recoveryUserId requires controlPlane.github, controlPlane.google or controlPlane.oidc/,
  );
  await assertPreflightFailure(
    "openclaw",
    baseInput({ controlPlane: { ...baseInput().controlPlane, passwordSignIn: "recovery-only" } }),
    /controlPlane.passwordSignIn requires controlPlane.github, controlPlane.google or controlPlane.oidc/,
  );
  await assertPreflightFailure(
    "openclaw",
    externalSignInInput({ passwordSignIn: "none" }),
    /controlPlane.passwordSignIn must be all or recovery-only/,
  );
  await assertPreflightFailure(
    "openclaw",
    externalSignInInput({ agentNativeAdminDomain: "agents.oce.example.internal" }),
    /controlPlane.agentNativeAdminDomain is not consumed with external sign-in/,
  );
  await assertPreflightFailure(
    "openclaw",
    externalSignInInput({ authBaseUrl: "http://console.oce.example.internal" }),
    /controlPlane.authBaseUrl must use HTTPS with external sign-in/,
  );
  await assertPreflightFailure(
    "openclaw",
    externalSignInInput({ github: { clientSecret: "inline" } }),
    /controlPlane.github.clientSecret is not supported/,
  );
  for (const [provider, key, value] of [
    ["github", "clientIdKey", "bad/key"],
    ["github", "clientSecretKey", "."],
    ["google", "clientSecretKey", "a".repeat(254)],
    ["google", "clientIdKey", "..client-id"],
    ["oidc", "clientIdKey", "bad/key"],
    ["oidc", "clientSecretKey", "..client-secret"],
  ]) {
    await assertPreflightFailure(
      "openclaw",
      externalSignInInput({
        github: undefined,
        [provider]:
          provider === "oidc"
            ? {
                issuer: "https://tenant.idp.example.test/",
                authorizationUrl: "https://tenant.idp.example.test/authorize",
                tokenUrl: "https://tenant.idp.example.test/oauth/token",
                jwksUrl: "https://tenant.idp.example.test/.well-known/jwks.json",
                [key]: value,
              }
            : { [key]: value },
      }),
      new RegExp(`controlPlane\\.${provider}\\.${key} must be a Kubernetes Secret key`),
    );
  }
  for (const signIn of [
    { github: { clientIdKey: ".hidden" } },
    { github: undefined, google: { clientSecretKey: "a".repeat(253) } },
  ]) {
    assert.equal((await render("openclaw", externalSignInInput(signIn))).summary.ok, true);
  }
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
    await assertPreflightFailure(
      "openclaw",
      externalSignInInput({ github: undefined, oidc: { ...oidc, ...override } }),
      message,
    );
  }
  await assertPreflightFailure(
    "openclaw",
    externalSignInInput({ github: undefined, oidc: { ...oidc, jwksUrl: undefined } }),
    /controlPlane.oidc.jwksUrl must be a nonempty string/,
  );
  await assertPreflightFailure(
    "openclaw",
    externalSignInInput({ trustedProxy: { preset: "generic", cidrs: ["10.42.0.0/16"] } }),
    /controlPlane.trustedProxy.clientAddressHeader is required for the generic preset/,
  );
  await assertPreflightFailure(
    "openclaw",
    externalSignInInput({ trustedProxy: { preset: "ingress-nginx", cidrs: ["0.0.0.0/0"] } }),
    /controlPlane.trustedProxy.cidrs\[0\] must be/,
  );
});

test("profiles refuse installation names the chart and the bootstrap Job refuse", async () => {
  const accepted = await render(
    "openclaw",
    baseInput({
      controlPlane: { ...baseInput().controlPlane, clusterName: "n".repeat(200) },
    }),
  );
  assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
  assert.match(accepted.values, /name: n{200}\n/);
  for (const clusterName of [" profile", `${"n".repeat(201)}`, "bad\nname", "\uD800"]) {
    await assertPreflightFailure(
      "openclaw",
      baseInput({ controlPlane: { ...baseInput().controlPlane, clusterName } }),
      /controlPlane.clusterName must be 1 to 200 characters/,
    );
  }
});

test("preflight rejects CIDR prefixes with a leading zero", async () => {
  const controlPlane = baseInput().controlPlane;
  await assertPreflightFailure(
    "openclaw",
    baseInput({
      controlPlane: { ...controlPlane, databaseCidrs: ["192.0.2.10/032"] },
    }),
    /controlPlane\.databaseCidrs\[0\] must be an IPv4 \/32 CIDR/,
  );
  await assertPreflightFailure(
    "openclaw",
    baseInput({
      controlPlane: { ...controlPlane, gatewayTrustedProxyCidrs: ["192.0.2.12/08"] },
    }),
    /controlPlane\.gatewayTrustedProxyCidrs\[0\] must be an IPv4 CIDR/,
  );
  await assertPreflightFailure(
    "openclaw",
    baseInput({
      controlPlane: {
        ...controlPlane,
        trustedProxy: { preset: "ingress-nginx", cidrs: ["2001:db8::/032"] },
      },
    }),
    /controlPlane\.trustedProxy\.cidrs\[0\] must be an IPv4 or IPv6 CIDR/,
  );
  const accepted = await render(
    "openclaw",
    baseInput({
      controlPlane: { ...controlPlane, gatewayTrustedProxyCidrs: ["192.0.2.12/8"] },
    }),
  );
  assert.match(accepted.installation, /192\.0\.2\.12\/8/);
});

// Compute refuses a source range that covers every address (scopedCidr) in the same words;
// a status proxy source wider than one address only warns there and here (bughunt F2).
test("preflight refuses source CIDRs that cover every address and warns about wide status sources", async () => {
  const controlPlane = baseInput().controlPlane;
  for (const key of ["gatewayTrustedProxyCidrs", "pluginStatusProxySourceCidrs"]) {
    await assertPreflightFailure(
      "openclaw",
      baseInput({ controlPlane: { ...controlPlane, [key]: ["192.0.2.12/32", "0.0.0.0/0"] } }),
      new RegExp(`controlPlane\\.${key}\\[1\\] cannot cover every address\\.`),
    );
  }
  const wide = await render(
    "openclaw",
    baseInput({
      controlPlane: { ...controlPlane, pluginStatusProxySourceCidrs: ["10.42.0.0/16"] },
    }),
  );
  assert.match(
    wide.preflight.warnings.join("\n"),
    /controlPlane\.pluginStatusProxySourceCidrs\[0\] covers more than one address/,
  );
  const exact = await render("openclaw", baseInput());
  assert.doesNotMatch(exact.preflight.warnings.join("\n"), /covers more than one address/);
  const widerTrust = await render(
    "openclaw",
    baseInput({ controlPlane: { ...controlPlane, gatewayTrustedProxyCidrs: ["10.42.0.0/16"] } }),
  );
  assert.doesNotMatch(widerTrust.preflight.warnings.join("\n"), /covers more than one address/);
});

test("preflight rejects channel proxy URLs with an invalid octet or port", async () => {
  const message = /must be an HTTP\(S\) literal IPv4 endpoint with an explicit port/;
  await assertPreflightFailure(
    "openclaw",
    baseInput({ channels: { directoryProxyUrl: "http://192.0.2.999:8080" } }),
    message,
  );
  await assertPreflightFailure(
    "openclaw",
    baseInput({ channels: { runtimeProxyUrl: "http://192.0.2.10:99999" } }),
    message,
  );
  // Compute and the API's Slack directory refuse an unspecified proxy host, which names no proxy.
  for (const field of ["runtimeProxyUrl", "directoryProxyUrl"]) {
    await assertPreflightFailure(
      "openclaw",
      baseInput({ channels: { [field]: "http://0.0.0.0:3128" } }),
      new RegExp(
        `channels\\.${field} must not use host 0\\.0\\.0\\.0, which names no proxy address\\.`,
      ),
    );
  }
  const accepted = await render(
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
  requireConfiguration(
    KubernetesComputeDriver,
    loadYaml(accepted.installation).drivers.compute.configuration,
  );
});

for (const profile of ["openclaw", "codex"]) {
  for (const proxyUrl of ["http://192.0.2.10:80", "https://192.0.2.10:443"]) {
    test(`${profile} preserves explicit default channel proxy port in ${proxyUrl}`, async (t) => {
      const input = profile === "codex" ? codexInput() : baseInput();
      input.channels = { directoryProxyUrl: proxyUrl, runtimeProxyUrl: proxyUrl };
      const output = await render(profile, input);
      t.after(() => rmSync(output.directory, { recursive: true, force: true }));
      assert.equal(output.preflight.ok, true);
      assert.equal(loadYaml(output.values).api.channelDirectoryProxyUrl, proxyUrl);
      const compute = loadYaml(output.installation).drivers.compute.configuration;
      assert.equal(compute.runtime.channels.proxyUrl, proxyUrl);
      // Installation validation runs even before an Agent enables a channel.
      assert.doesNotThrow(() => requireConfiguration(KubernetesComputeDriver, compute));
    });
  }
}

test("channel proxy validation preserves explicit ports and exact managed peers", async (t) => {
  const output = await render("openclaw", baseInput());
  t.after(() => rmSync(output.directory, { recursive: true, force: true }));
  const compute = loadYaml(output.installation).drivers.compute.configuration;
  const managed = structuredClone(compute.runtime.channels);
  assert.equal(managed.managedProxy.port, 3128);
  requireConfiguration(KubernetesComputeDriver, compute);

  // IPv6 is supported by Compute directly; profile input intentionally remains IPv4-only.
  for (const proxyUrl of [
    " http://192.0.2.10:8080 ",
    "http://[2001:db8::10]:80",
    "https://[2001:db8::10]:443/",
    "http://192.0.2.10:443",
    "https://192.0.2.10:80/",
  ]) {
    compute.runtime.channels = { proxyUrl };
    assert.doesNotThrow(() => requireConfiguration(KubernetesComputeDriver, compute), proxyUrl);
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
    assert.doesNotThrow(() => requireConfiguration(KubernetesComputeDriver, compute));
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
    assert.throws(
      () => requireConfiguration(KubernetesComputeDriver, compute),
      SharedConfigurationValidationError,
    );
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
    assert.throws(
      () => requireConfiguration(KubernetesComputeDriver, compute),
      SharedConfigurationValidationError,
    );
  }
});

test("channel proxy validation preserves omitted-port endpoint diagnostics", async (t) => {
  const output = await render("openclaw", baseInput());
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
    assert.throws(
      () => requireConfiguration(KubernetesComputeDriver, compute),
      SharedConfigurationValidationError,
    );
  }
  for (const proxyUrl of [
    `http://${managed.managedProxy.hostname}`,
    `http://${managed.managedProxy.hostname}:8080`,
    "http://other.openclaw-system.svc:3128",
  ]) {
    compute.runtime.channels = { ...managed, proxyUrl };
    assert.throws(
      () => requireConfiguration(KubernetesComputeDriver, compute),
      SharedConfigurationValidationError,
    );
  }
});

test("profiles refuse database CA keys the chart refuses", async () => {
  const withCa = (key) =>
    baseInput({
      controlPlane: {
        ...baseInput().controlPlane,
        databaseCa: { secretName: "occ-db-ca", ...(key === undefined ? {} : { key }) },
      },
    });
  const accepted = await render("openclaw", withCa("db_ca.pem"));
  assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
  assert.match(accepted.values, /caKey: db_ca.pem/);
  const omitted = await render("openclaw", withCa(undefined));
  assert.equal(omitted.summary.ok, true, omitted.preflight.errors.join("\n"));
  assert.match(omitted.values, /caKey: ca.pem/);
  const maxKey = "a".repeat(253);
  const acceptedMax = await render("openclaw", withCa(maxKey));
  assert.equal(acceptedMax.summary.ok, true, acceptedMax.preflight.errors.join("\n"));
  assert.match(acceptedMax.values, new RegExp(`caKey: ${maxKey}`));
  for (const key of [".", "..", "..ca.pem", "ca/pem", "ca pem", "a".repeat(254)]) {
    await assertPreflightFailure(
      "openclaw",
      withCa(key),
      /controlPlane\.databaseCa\.key must be a Kubernetes Secret key of at most 253 characters/,
    );
  }
});

test("profiles refuse ChatGPT credential lifetimes the API refuses", async () => {
  const accounts = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    adminSecretName: "occ-chatgpt-admin",
    adminSecretKey: "admin-key",
    providerCidr: "192.0.2.21/32",
  };
  const accepted = await render(
    "codex",
    managedCodexInput({
      codex: { managedServiceAccounts: { ...accounts, credentialTtlSeconds: 2_592_000 } },
    }),
  );
  assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
  assert.match(accepted.installation, /credentialTtlSeconds: 2592000/);
  await assertPreflightFailure(
    "codex",
    managedCodexInput({
      codex: { managedServiceAccounts: { ...accounts, credentialTtlSeconds: 2_592_001 } },
    }),
    /codex.managedServiceAccounts.credentialTtlSeconds must be an integer from 1 through 2592000/,
  );
});

test("profiles refuse administrator emails the bootstrap Job refuses", async () => {
  const accepted = await render(
    "openclaw",
    baseInput({
      controlPlane: { ...baseInput().controlPlane, adminEmail: " Admin@Example.invalid " },
    }),
  );
  assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
  assert.match(accepted.values, /adminEmail: " Admin@Example.invalid "/);
  for (const adminEmail of ["not-an-email", "admin@example", "a @b.c"]) {
    await assertPreflightFailure(
      "openclaw",
      baseInput({ controlPlane: { ...baseInput().controlPlane, adminEmail } }),
      /controlPlane.adminEmail must be a valid administrator email/,
    );
  }
});

test("preflight rejects a Google hosted domain the chart and API refuse", async () => {
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
    await assertPreflightFailure(
      "openclaw",
      googleInput(allowedDomains),
      /controlPlane\.google\.allowedDomains\[0\] must be a lowercase DNS domain name of at most 253 characters whose last label starts with a letter, such as example\.com/,
    );
  }
  const accepted = await render("openclaw", googleInput([domain253]));
  assert.equal(accepted.summary.ok, true, accepted.preflight.errors.join("\n"));
  assert.match(accepted.values, new RegExp(domain253));
});

test("profiles refuse gateway namespaces the compute driver refuses", async () => {
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
    await assertPreflightFailure(
      "openclaw",
      baseInput({ controlPlane: { ...controlPlane, namespace } }),
      namespaceMessage,
    );
    assert.throws(
      () => admit({ ...routing, gatewayNamespace: namespace }),
      SharedConfigurationValidationError,
    );
  }
  for (const envoyNamespace of refused) {
    await assertPreflightFailure(
      "openclaw",
      baseInput({ controlPlane: { ...controlPlane, envoyNamespace } }),
      envoyMessage,
    );
    assert.throws(() => admit({ ...routing, envoyNamespace }), SharedConfigurationValidationError);
  }
  const namespace = "a".repeat(63);
  const envoyNamespace = `${"b".repeat(62)}9`;
  const output = await render(
    "openclaw",
    baseInput({ controlPlane: { ...controlPlane, namespace, envoyNamespace } }),
  );
  assert.equal(output.summary.ok, true);
  assert.match(output.installation, new RegExp(`gatewayNamespace: ${namespace}`));
  assert.match(output.installation, new RegExp(`envoyNamespace: ${envoyNamespace}`));
  assert.doesNotThrow(() => admit({ ...routing, gatewayNamespace: namespace, envoyNamespace }));
});

test("profiles refuse gateway storage class names the compute driver refuses", async () => {
  const runtime = baseInput().runtime;
  for (const gatewayStorageClassName of [
    "Bad_Class",
    "bad class",
    "-local-path",
    "a".repeat(254),
  ]) {
    await assertPreflightFailure(
      "openclaw",
      baseInput({ runtime: { ...runtime, gatewayStorageClassName } }),
      /runtime\.gatewayStorageClassName must be a Kubernetes resource name of at most 253 characters/,
    );
  }
  for (const gatewayStorageClassName of ["a".repeat(253), "gp3.encrypted"]) {
    const output = await render(
      "openclaw",
      baseInput({ runtime: { ...runtime, gatewayStorageClassName } }),
    );
    assert.equal(output.summary.ok, true, output.preflight.errors.join("\n"));
    assert.ok(output.installation.includes(`gatewayStorageClassName: ${gatewayStorageClassName}`));
  }
});

test("preflight rejects Codex seccomp paths the compute driver refuses", async () => {
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
    await assertPreflightFailure(
      "codex",
      codexInput({ runtime: { codexSeccompProfile } }),
      message,
    );
  }
  const accepted = await render("codex", codexInput());
  const installation = loadYaml(accepted.installation);
  requireConfiguration(KubernetesComputeDriver, installation.drivers.compute.configuration);
  assert.match(accepted.installation, /codexSeccompProfile: profiles\/codex\.json/);
});

test("the codex profile carries a Codex model endpoint under Compute startup's rule", async () => {
  const field = "runtime.codexModelBaseUrl";
  await assertFieldRefusals(
    "openclaw",
    baseInput(),
    field,
    ["https://models.example.com/v1"],
    "is only consumed by the codex profile",
  );
  const accepted = await render(
    "codex",
    codexInput({ runtime: { codexModelBaseUrl: "https://Models.Example.com:443/v1/" } }),
  );
  const compute = loadYaml(accepted.installation).drivers.compute.configuration;
  // Written as Compute normalizes it, and accepted by Compute startup.
  assert.equal(compute.runtime.codexModelBaseUrl, "https://models.example.com/v1");
  const backslashScheme = await render(
    "codex",
    codexInput({ runtime: { codexModelBaseUrl: "https:\\\\192.0.2.1/v1" } }),
  );
  assert.equal(
    loadYaml(backslashScheme.installation).drivers.compute.configuration.runtime.codexModelBaseUrl,
    "https://192.0.2.1/v1",
  );
  requireConfiguration(KubernetesComputeDriver, compute);
  assert.equal(
    loadYaml((await render("codex", codexInput())).installation).drivers.compute.configuration
      .runtime.codexModelBaseUrl,
    undefined,
  );
  // Each refusal is Compute startup's (finding 1292 spellings included), with its own message.
  const general =
    "requires HTTPS, a nonzero port, and a path ending in /v1 without credentials, wildcards, query, or fragment.";
  for (const [value, message] of [
    ["", "must be a nonempty string."],
    [7, "must be a nonempty string."],
    ["https://models.example.com/v1 ", "must not contain spaces or control characters."],
    ["https://models.example.com/\tv1", "must not contain spaces or control characters."],
    [
      "https:models.example.com/v1",
      "must start with https:// (the // after the scheme is missing).",
    ],
    ["https://@models.example.com/v1", "must not contain user info or an @ before the host."],
    [
      syntheticCredentialUrl({
        username: "fixture-user",
        password: "fixture-password",
        host: "models.example.com",
        pathname: "/v1",
      }),
      "must not contain user info or an @ before the host.",
    ],
    ["http://models.example.com/v1", general],
    ["https://models.example.com/v2", general],
    ["https://models.example.com/v1/responses", general],
    ["https://*.example.com/v1", general],
    ["https://models.example.com:0/v1", general],
    ["https://models.example.com/v1?key=1", general],
    ["https://models.example.com/v1#v1", general],
    [
      "https://192.168.1/v1",
      "IPv4 host must be four decimal octets from 0 to 255 with no leading zeros; other spellings parse as a different address.",
    ],
    [
      "https://2130706433/v1",
      "IPv4 host must be four decimal octets from 0 to 255 with no leading zeros; other spellings parse as a different address.",
    ],
    [
      "https://127.1/v1",
      "IPv4 host must be four decimal octets from 0 to 255 with no leading zeros; other spellings parse as a different address.",
    ],
    // A spelling refusal comes first, whatever host the parser would read.
    ["https:/192.168.1/v1", "must start with https:// (the // after the scheme is missing)."],
  ]) {
    await assertFieldRefusals("codex", codexInput(), field, [value], message);
    assert.throws(
      () =>
        requireConfiguration(KubernetesComputeDriver, {
          ...compute,
          runtime: { ...compute.runtime, codexModelBaseUrl: value },
        }),
      // Compute startup has no separate nonempty-string refusal; its general rule covers it.
      SharedConfigurationValidationError,
      JSON.stringify(value),
    );
  }
  // Generated Harness model egress is TCP/443 to non-excluded IPv4, but an operator's own
  // NetworkPolicy can admit more: preflight warns like Compute startup (findings 1740, 2284).
  assert.doesNotMatch(accepted.preflight.warnings.join("\n"), /model egress/);
  for (const [value, blocked] of [
    [
      "https://models.example.com:8443/v1",
      "uses port 8443 but Harness model egress allows only TCP/443",
    ],
    [
      "https://10.0.0.5:8443/v1",
      "uses port 8443 but Harness model egress allows only TCP/443 and has an IPv4 host in 10.0.0.0/8 which Harness model egress excludes",
    ],
    ["https://[2001:db8::1]/v1", "is an IPv6 address but Harness model egress allows only IPv4"],
    ["https://10.0.0.1/v1", "has an IPv4 host in 10.0.0.0/8 which Harness model egress excludes"],
  ]) {
    const warned = await render("codex", codexInput({ runtime: { codexModelBaseUrl: value } }));
    assert.ok(
      warned.preflight.warnings.includes(
        `${field} ${blocked}: the generated policy will not admit it unless another NetworkPolicy does.`,
      ),
      value,
    );
    const configured = loadYaml(warned.installation).drivers.compute.configuration;
    assert.equal(configured.runtime.codexModelBaseUrl, value);
    requireConfiguration(KubernetesComputeDriver, configured);
  }
});

test("profile transport Secret prefixes agree with controller startup admission", async (t) => {
  const baseline = await render("openclaw", baseInput());
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
      const output = await render("openclaw", input);
      t.after(() => rmSync(output.directory, { recursive: true, force: true }));
      await loadInstallationConfiguration({
        mode: "production",
        environment: { OCC_CONFIG_PATH: join(output.directory, "installation.yaml") },
      });
    } else {
      await assertPreflightFailure("openclaw", input, /runtime\.transportSecretPrefix/);
      const installation = loadYaml(baseline.installation);
      installation.drivers.compute.configuration.runtime.transportSecretPrefix = prefix;
      const path = join(baseline.directory, "invalid-installation.json");
      writeFileSync(path, JSON.stringify(installation));
      await assert.rejects(
        loadInstallationConfiguration({
          mode: "production",
          environment: { OCC_CONFIG_PATH: path },
        }),
        SharedConfigurationValidationError,
      );
    }
  }
});
