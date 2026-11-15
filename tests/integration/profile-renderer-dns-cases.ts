import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { temporaryDirectorySync } from "../helpers/temporary-directory.ts";
import { baseInput, codexInput, repositoryConfiguration } from "./profile-renderer-inputs.ts";
import {
  repository,
  helmSkip,
  loadYaml,
  helmTemplate,
  renderCli,
  renderError,
  readPreflight,
  propertyAt,
  objectAt,
  arrayAt,
  readJson,
} from "./profile-renderer-fixture.ts";

async function startDnsFixture(t: TestContext, records: Record<string, string[]>) {
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
        const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) }).then(
          () => undefined,
        );
        child.kill("SIGKILL");
        await exited;
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const [port]: unknown[] = await Promise.race([
    once(child, "message", { signal: AbortSignal.timeout(5000) }).then(
      (message: unknown[]) => message,
    ),
    once(child, "exit").then(() => {
      throw new Error("DNS fixture exited before listening");
    }),
  ]);
  assert.ok(typeof port === "number", "expected the DNS fixture port");
  return { directory, queriesPath, server: `127.0.0.1:${port}` };
}

function optionalMetadataName(document: unknown): unknown {
  const metadata = propertyAt(document, "metadata");
  return metadata === undefined || metadata === null ? undefined : propertyAt(metadata, "name");
}

export function registerDnsCases(): void {
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
        const directory = temporaryDirectorySync(t, `oce-profile-egress-${profile}-`);
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
          propertyAt(loadYaml(output.values), "api", "modelDiscoveryCidrs"),
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
      assert.deepEqual(propertyAt(loadYaml(external.values), "api", "modelDiscoveryCidrs"), []);
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
      assert.deepEqual(
        propertyAt(loadYaml(discovered.values), "api", "modelDiscoveryCidrs"),
        cidrs,
      );
      const queriedHosts = readFileSync(dns.queriesPath, "utf8").trim().split("\n").sort();
      assert.deepEqual(queriedHosts, ["auth.openai.com", "chatgpt.com"]);
      t.diagnostic(`Hosted discovery DNS queries: ${queriedHosts.join(", ")}`);
      const documents = helmTemplate(discovered)
        .split(/\n---\n/)
        .map((document) => readJson(JSON.stringify(loadYaml(document))));
      const policy = documents.find(
        (document) =>
          optionalMetadataName(document) === "openclaw-enterprise-api-model-discovery-egress",
      );
      assert.ok(policy, "omitted hosted discovery CIDRs must create the API HTTPS policy");
      assert.deepEqual(propertyAt(policy, "spec", "podSelector", "matchLabels"), {
        "app.kubernetes.io/name": "openclaw-enterprise",
        "app.kubernetes.io/instance": "oce",
        "app.kubernetes.io/component": "api",
      });
      assert.deepEqual(propertyAt(policy, "spec", "policyTypes"), ["Egress"]);
      assert.deepEqual(propertyAt(policy, "spec", "egress"), [
        {
          to: cidrs.map((cidr) => ({ ipBlock: { cidr } })),
          ports: [{ protocol: "TCP", port: 443 }],
        },
      ]);
      const deny = documents.find(
        (document) => optionalMetadataName(document) === "openclaw-enterprise-default-deny",
      );
      assert.deepEqual(propertyAt(deny, "spec", "policyTypes"), ["Ingress", "Egress"]);
      assert.equal(propertyAt(deny, "spec", "egress"), undefined);
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
    const preflight = readPreflight(dns.directory);
    assert.equal(preflight.ok, false);
    assert.ok(preflight.errors.join("\n").includes("IPv4 addresses for chatgpt.com."));
    // One host must resolve so a broken DNS fixture cannot satisfy the refusal case.
    assert.doesNotMatch(preflight.errors.join("\n"), /IPv4 addresses for auth\.openai\.com\./);
    assert.match(preflight.errors.join("\n"), /modelDiscoveryCidrs/);
    assert.match(preflight.errors.join("\n"), /retry|re-?render|supply|set|provide|configure/i);
    assert.equal(existsSync(join(dns.directory, "values.yaml")), false);
    assert.equal(existsSync(join(dns.directory, "installation.yaml")), false);
    assert.deepEqual(preflight.outputs, { preflight: join(dns.directory, "preflight.json") });
    assert.equal(propertyAt(error, "status"), 1);
    t.diagnostic(preflight.errors.join("\n"));
  });
}

test("an explicit profile selects the startup PluginDriver and its credential diagnostics", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "oce-profile-selection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profileFile = join(directory, "selected-profile.json");
  const dns = await startDnsFixture(t, {
    "auth.openai.com": ["192.0.2.40"],
    "chatgpt.com": ["198.51.100.20"],
  });
  const cases: [
    string,
    string,
    { catalogSource: string } | undefined,
    { id: string; configuration: { catalogSource: string } }?,
  ][] = [
    ["openclaw", "occ-plugin", undefined],
    ["codex", "codex-plugin", undefined],
    ["codex", "codex-plugin", { catalogSource: "openai-curated" }],
    ["openclaw", "codex-plugin", { catalogSource: "hosted" }],
    ["openclaw", "codex-plugin", { catalogSource: "openai-curated" }],
    [
      "openclaw",
      "occ-plugin",
      undefined,
      { id: "codex-plugin", configuration: { catalogSource: "openai-curated" } },
    ],
  ];
  for (const [name, pluginId, configuration, additionalPlugin] of cases) {
    const profile = objectAt(
      readJson(readFileSync(join(repository, `deploy/profiles/${name}.json`), "utf8")),
    );
    const selected = arrayAt(profile, "installation", "drivers", "plugin");
    const driver = objectAt(selected[0]);
    driver.id = pluginId;
    if (configuration === undefined) {
      delete driver.configuration;
    } else {
      driver.configuration = configuration;
    }
    if (additionalPlugin !== undefined) {
      selected.push(additionalPlugin);
    }
    writeFileSync(profileFile, JSON.stringify(profile));

    // Profile families select runtime settings; the selected PluginDriver independently
    // determines catalog credentials, including an OpenClaw family with hosted Codex discovery.
    // Keep hosted discovery on the local DNS fixture, including the OpenClaw family.
    const output = renderCli(
      name,
      name === "codex" ? codexInput() : baseInput(),
      directory,
      repository,
      dns.server,
      profileFile,
    );
    let expectedCidrs: string[] = [];
    if (name === "codex") {
      expectedCidrs = ["192.0.2.20/32"];
    } else if (pluginId === "codex-plugin" && configuration?.catalogSource === "hosted") {
      expectedCidrs = ["192.0.2.40/32", "198.51.100.20/32"];
    }
    assert.deepEqual(
      propertyAt(loadYaml(output.values), "api", "modelDiscoveryCidrs"),
      expectedCidrs,
    );
    const runtime = await loadInstallationConfiguration({
      mode: "production",
      environment: { OCC_CONFIG_PATH: join(directory, "installation.yaml") },
    });
    assert.ok(runtime?.installation.drivers.plugin?.[0]);
    assert.equal(runtime.installation.drivers.plugin[0].id, pluginId);
    assert.deepEqual(
      runtime.installation.drivers.plugin.map(({ id, configuration }) => ({ id, configuration })),
      [
        { id: pluginId, configuration: configuration ?? {} },
        ...(additionalPlugin === undefined ? [] : [additionalPlugin]),
      ],
    );
    const diagnostics = [...output.preflight.prerequisites, ...output.preflight.warnings].join(
      "\n",
    );
    if (name === "codex") {
      assert.match(diagnostics, /runtime credentials.*Agent/);
      assert.match(diagnostics, /seccomp profile installed/);
    } else {
      assert.doesNotMatch(diagnostics, /runtime credentials.*Agent|seccomp profile installed/);
    }
    if (pluginId === "codex-plugin" && configuration?.catalogSource !== "openai-curated") {
      assert.match(diagnostics, /Hosted plugin discovery.*PAT/);
    } else {
      assert.doesNotMatch(diagnostics, /Hosted plugin discovery|codex_pat/);
    }
  }
});
