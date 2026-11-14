import assert from "node:assert/strict";
import { test } from "node:test";
import {
  baseInput,
  codexInput,
  managedCodexInput,
  repositoryConfiguration,
  withGoogleSignIn,
} from "./profile-renderer-inputs.ts";
import {
  helmSkip,
  helmTemplate,
  render,
  renderCli,
  renderError,
  processOutput,
  assertPreflightFailure,
  assertFieldRefusals,
  type FieldRefusal,
} from "./profile-renderer-fixture.ts";
import {
  credentialSecretNames,
  repositorySecretKeys,
  generatedGatewaySecrets,
} from "./profile-renderer-helm-cases.ts";

interface RefusalGroup {
  name: string;
  profile?: string;
  input?: () => Record<string, unknown>;
  cases: FieldRefusal[];
}

export function registerInputMatrixCases(): void {
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
        ...repositorySecretKeys.map((key, index): FieldRefusal => [
          `repository.${key}`,
          [
            ...credentialSecretNames,
            ...repositorySecretKeys
              .slice(0, index)
              .map((other) => repositoryConfiguration()[other]),
          ],
          "must name a dedicated Secret",
        ]),
      ],
    },
    {
      name: "preflight refuses credential Secrets named like the log collector's",
      profile: "codex",
      input: () => {
        const input = withGoogleSignIn(
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
        "controlPlane.google.secretName",
        "controlPlane.databaseCa.secretName",
        "codex.managedServiceAccounts.adminSecretName",
        ...repositorySecretKeys.map((key) => `repository.${key}`),
      ].map((field): FieldRefusal => [
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
        const input = withGoogleSignIn(baseInput(), {});
        input.controlPlane.google = {};
        return input;
      },
      cases: ["google"].flatMap((provider) =>
        generatedGatewaySecrets("oce").map(({ name, role }): FieldRefusal => [
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
        ].map((field): FieldRefusal => [
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
  ] satisfies RefusalGroup[]) {
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
        processOutput(error),
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
}
