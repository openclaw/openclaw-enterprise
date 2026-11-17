import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { validateBackendDefinitions } from "../../packages/occ/src/backends.ts";
import {
  digestD,
  baseInput,
  codexInput,
  managedCodexInput,
  repositoryConfiguration,
  withGoogleSignIn,
} from "./profile-renderer-inputs.ts";
import {
  helmSkip,
  loadYaml,
  helmTemplate,
  render,
  renderError,
  processOutput,
  assertPreflightFailure,
  escapeRegExp,
  assertFieldRefusals,
  propertyAt,
  arrayAt,
  readJson,
} from "./profile-renderer-fixture.ts";

function deploymentChecksum(manifests: string, component: string) {
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

// The Gateway TLS and root CA Secrets the chart generates for a release, with the role the
// preflight names and the refusal Helm gives when the gateway API key Secret reuses one.
// helmTemplate and baseInput both install into openclaw-system.
export function generatedGatewaySecrets(releaseName: string, namespace = "openclaw-system") {
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
  ] as const;
}

// The Secrets a ChatGPT admin or repository Secret may not reuse on the codex profile: the
// chart's own, the generated Gateway TLS and root CA, the gateway API key and the ChatGPT admin
// Secret, in managedCodexInput's names.
export const credentialSecretNames = [
  "occ-installation-startup",
  "occ-database",
  "occ-auth",
  ...generatedGatewaySecrets("oce").map(({ name }) => name),
  "occ-private-gateway-key",
  "occ-chatgpt-admin",
];
export const repositorySecretKeys = [
  "serviceConfigSecretName",
  "appKeySecretName",
  "preparedCustodySecretName",
  "tlsSecretName",
  "publicCaSecretName",
] as const;

type SecretCollision = [
  field: string,
  name: string,
  chartValues: Record<string, unknown>,
  refusal: RegExp,
  preflight?: string | RegExp,
];

export function registerHelmCases(): void {
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
      processOutput(error),
      /repositoryCredentials\.serviceConfigSecretName must name a dedicated Secret; occ-chatgpt-admin is also backend\.chatgpt\.secretName/,
    );
  });

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
          assert.match(
            `${propertyAt(error, "stdout") ?? ""}${propertyAt(error, "stderr") ?? ""}`,
            refusal,
          );
          await assertPreflightFailure(
            "openclaw",
            { ...input, controlPlane: { ...input.controlPlane, gatewayApiKeySecretName: name } },
            new RegExp(`the chart generates ${name} for the ${role}\\.`),
          );
        }
      }
    },
  );

  test("preflight refuses Backend ID collisions only when both Backends are configured", async (t) => {
    const repository = { ...repositoryConfiguration(), backendId: "chatgpt-primary" };
    await assertPreflightFailure(
      "codex",
      managedCodexInput({ repository }),
      /Generated Backend IDs must be unique; repository\.backendId .*chatgpt-primary.* is already used/,
    );

    // The name is not reserved: it is valid when no ChatGPT Backend is generated.
    const repositoryOnly = await render("codex", codexInput({ repository }));
    assert.equal(repositoryOnly.summary.ok, true);
    assert.match(repositoryOnly.installation, /id: chatgpt-primary\n {4}type: github/);
    const distinct = await render(
      "codex",
      managedCodexInput({ repository: repositoryConfiguration() }),
    );
    assert.equal(distinct.summary.ok, true);
    assert.match(distinct.installation, /id: chatgpt-primary\n {4}type: chatgpt/);
    assert.match(distinct.installation, /id: github-primary\n {4}type: github/);
    for (const output of [repositoryOnly, distinct]) {
      t.after(() => rmSync(output.directory, { recursive: true, force: true }));
      validateBackendDefinitions(propertyAt(loadYaml(output.installation), "backend"));
    }
  });

  test(
    "preflight refuses sign-in Secrets that ChatGPT or repository credentials use, as Helm does",
    { skip: helmSkip },
    async () => {
      const input = managedCodexInput({ repository: repositoryConfiguration() });
      const accepted = await render("codex", withGoogleSignIn(input, {}));
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
          withGoogleSignIn(input, { secretName }),
          /controlPlane\.google\.secretName must name a dedicated Secret|must name a dedicated Secret; \S+ is also controlPlane\.google\.secretName\./,
        );
        // The same name placed over the accepted values makes the chart refuse it too.
        const override = join(accepted.directory, `github-${secretName}.json`);
        writeFileSync(override, JSON.stringify({ auth: { google: { secretName } } }));
        const error = await renderError(() => helmTemplate(accepted, [override]));
        assert.match(
          processOutput(error),
          /auth\.google\.secretName must name a dedicated Secret|must name a dedicated Secret; \S+ is also auth\.google\.secretName/,
        );
      }
      // Without managed ChatGPT accounts the chart does not reserve that Secret name.
      const unmanaged = await render(
        "codex",
        withGoogleSignIn(codexInput(), { secretName: "occ-chatgpt-admin" }),
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
      const [{ name: tls }, { name: root }] = generatedGatewaySecrets("oce");
      // [input field, name, chart values, chart refusal, preflight refusal]: the cases bughunt probe R2 found
      // that only Helm refused, and the admin Secret shared with the gateway API key, which
      // neither refused (finding 1044). Both name the gateway API key, which comes second.
      for (const [
        field,
        name,
        chartValues,
        refusal,
        preflight = "must name a dedicated Secret",
      ] of [
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
        ...(
          [
            [tls, "gatewayRouting.tlsSecretName"],
            [root, "the generated Gateway root CA"],
            ["occ-database", "database.secretName"],
          ] as const
        ).map(([secretName, other]): SecretCollision => [
          "codex.managedServiceAccounts.adminSecretName",
          secretName,
          { backend: { chatgpt: { secretName } } },
          new RegExp(
            escapeRegExp(
              `backend.chatgpt.secretName must name a dedicated Secret; ${secretName} is also ${other}`,
            ),
          ),
        ]),
        ...(
          [
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
          ] as const
        ).map(([key, secretName, other]): SecretCollision => [
          `repository.${key}`,
          secretName,
          { repositoryCredentials: { [key]: secretName } },
          new RegExp(
            escapeRegExp(
              `repositoryCredentials.${key} must name a dedicated Secret; ${secretName} is also ${other}`,
            ),
          ),
        ]),
      ] satisfies SecretCollision[]) {
        await assertFieldRefusals("codex", input, field, [name], preflight);
        const override = join(accepted.directory, "secret-collision.json");
        writeFileSync(override, JSON.stringify(chartValues));
        const error = await renderError(() => helmTemplate(accepted, [override]));
        assert.match(processOutput(error), refusal, `${field} = ${name}`);
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
        processOutput(error),
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
      const egress = (output: { directory: string }) => {
        const manifests = helmTemplate(output);
        const policy = manifests
          .split(/^---$/m)
          .filter((document) => document.includes("name: openclaw-enterprise-collector-egress"))
          .map((document) => loadYaml(document))
          .find(
            (object) =>
              propertyAt(object, "metadata", "name") === "openclaw-enterprise-collector-egress",
          );
        // loadYaml builds client-node classes; compare plain data.
        return readJson(JSON.stringify(arrayAt(policy, "spec", "egress").at(-1)));
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
        assert.deepEqual(propertyAt(rule, "to"), [peer], JSON.stringify(exporter));
        assert.deepEqual(
          propertyAt(rule, "ports"),
          [{ protocol: "TCP", port }],
          JSON.stringify(exporter),
        );
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
}
