import { requireConfiguration } from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { KubernetesComputeDriver } from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { temporaryDirectorySync } from "../helpers/temporary-directory.ts";
import {
  baseInput,
  codexInput,
  managedCodexInput,
  repositoryConfiguration,
} from "./profile-renderer-inputs.ts";
import {
  repository,
  helmSkip,
  loadYaml,
  helmTemplate,
  render,
  renderCli,
  renderError,
  profileFailure,
  readPreflight,
  propertyAt,
  objectAt,
  textAt,
} from "./profile-renderer-fixture.ts";

export function registerCliCases(): void {
  test("renderer supports exactly the openclaw and codex profiles", (t) => {
    const renderer = join(repository, "scripts/render-installation-profile.ts");
    const directory = temporaryDirectorySync(t, "oce-profile-cli-");
    const link = join(directory, "renderer.ts");
    symlinkSync(renderer, link);
    const usage = [
      "Usage: node scripts/render-installation-profile.ts --profile openclaw|codex \\",
      "  --input <site-inputs.json> --out-dir <rendered-directory>",
      "",
      "The renderer writes values.yaml, installation.yaml, and preflight.json. Missing",
      "or invalid required inputs write preflight.json and exit nonzero.",
      "",
    ].join("\n");

    // Direct invocation and an external symlink must both execute the same command.
    for (const entry of [renderer, link]) {
      const help = spawnSync(process.execPath, [entry, "--help"], {
        cwd: repository,
        encoding: "utf8",
      });
      assert.equal(help.status, 0, help.stderr);
      assert.equal(help.signal, null);
      assert.equal(help.stdout, usage);
      assert.equal(help.stderr, "");
    }

    const unsupported = spawnSync(process.execPath, [renderer, "--unsupported"], {
      cwd: repository,
      encoding: "utf8",
    });
    assert.equal(unsupported.status, 1, unsupported.stderr);
    assert.equal(unsupported.signal, null);
    assert.equal(unsupported.stdout, "");
    assert.equal(
      unsupported.stderr,
      `render-installation-profile: unsupported argument --unsupported.\n\n${usage}\n`,
    );

    // Importing the renderer must stay inert even when argv[1] points to it.
    const imported = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(pathToFileURL(renderer).href)});`,
        renderer,
        "--unsupported",
      ],
      { cwd: repository, encoding: "utf8" },
    );
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.signal, null);
    assert.equal(imported.stdout, "");
    assert.equal(imported.stderr, "");

    // A real process: the stdout summary and the files it writes.
    const openclaw = renderCli("openclaw", baseInput());
    assert.equal(openclaw.summary.ok, true);
    assert.equal(openclaw.preflight.profile, "openclaw");
    assert.deepEqual(propertyAt(loadYaml(openclaw.installation), "drivers", "plugin"), [
      { id: "occ-plugin", configuration: {} },
    ]);
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
    assert.deepEqual(propertyAt(loadYaml(codex.installation), "drivers", "plugin"), [
      { id: "codex-plugin", configuration: { catalogSource: "hosted" } },
    ]);
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
      const directory = temporaryDirectorySync(t, "oce-profile-digest-");
      for (const [section, key] of [
        ["controlPlane", "controllerImage"],
        ["runtime", "image"],
        ["repository", "image"],
      ] as const) {
        const image = textAt(input, section, key);
        for (const invalid of [
          image.replace(/(?<=:)[a-f0-9]{64}$/, (digest) => digest.toUpperCase()),
          image.replace("@sha256:", "@SHA256:"),
          // A 65th hex digit is not a SHA-256 digest.
          `${image}0`,
        ]) {
          // A failed rerender must revoke the previously successful artifacts.
          assert.equal((await render(profile, input, directory)).preflight.ok, true);
          const changed = structuredClone(input);
          objectAt(changed, section)[key] = invalid;
          const error = await renderError(() => render(profile, changed, directory));
          assert.match(
            profileFailure(error).output,
            /immutable image reference with a SHA-256 digest/,
          );
          const preflight = readPreflight(directory);
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
    ] as const) {
      const resources = objectAt(installation, "drivers", "compute", "configuration", "resources");
      assert.deepEqual(resources.gateway, gatewayResources, `${name} Gateway`);
      assert.deepEqual(resources.agent, harnessResources, `${name} Harness`);
      assert.deepEqual(
        propertyAt(resources, "namespace", "containerDefaults"),
        containerDefaultResources,
        `${name} namespace container default`,
      );
      assert.deepEqual(
        propertyAt(resources, "namespace", "quota"),
        { pods: "10" },
        `${name} quota`,
      );
    }
    // The example's placeholder proxy CIDR is the only value operators must supply.
    const compute = structuredClone(objectAt(example, "drivers", "compute", "configuration"));
    objectAt(compute, "network").gatewayTrustedProxyCidrs = ["192.0.2.10/32"];
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
      const directory = temporaryDirectorySync(t, `oce-release-name-${profile}-`);
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
          (error) => {
            assert.equal(propertyAt(error, "status"), 1);
            assert.equal(propertyAt(error, "signal"), null);
            assert.equal(propertyAt(error, "stderr"), "");
            assert.equal(
              propertyAt(error, "stdout"),
              readFileSync(join(directory, "preflight.json"), "utf8"),
            );
            return true;
          },
        );
        const preflight = readPreflight(directory);
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
}
