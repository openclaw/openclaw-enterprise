import {
  requireConfiguration,
  ConfigurationValidationError as SharedConfigurationValidationError,
} from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadInstallationConfiguration } from "../../apps/controller/src/composition/installation-config.ts";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
  type KubernetesComputeDriverOptions,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { conformanceKubernetesOptions } from "../helpers/kubernetes-compute.mjs";
import { baseInput, codexInput, externalSignInInput } from "./profile-renderer-inputs.ts";
import {
  helmSkip,
  loadYaml,
  helmTemplate,
  syntheticCredentialUrl,
  render,
  assertPreflightFailure,
  assertFieldRefusals,
  propertyAt,
  objectAt,
  computeConfiguration,
} from "./profile-renderer-fixture.ts";

function modelProviderBaseUrl(compute: unknown): unknown {
  const modelProvider = propertyAt(compute, "runtime", "modelProvider");
  return modelProvider === undefined || modelProvider === null
    ? undefined
    : propertyAt(modelProvider, "baseUrl");
}

export function registerComputeCases(): void {
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
    const admit = (gatewayRouting: NonNullable<KubernetesComputeDriverOptions["gatewayRouting"]>) =>
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
      assert.throws(
        () => admit({ ...routing, envoyNamespace }),
        SharedConfigurationValidationError,
      );
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
      assert.ok(
        output.installation.includes(`gatewayStorageClassName: ${gatewayStorageClassName}`),
      );
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
    requireConfiguration(
      KubernetesComputeDriver,
      propertyAt(installation, "drivers", "compute", "configuration"),
    );
    assert.match(accepted.installation, /codexSeccompProfile: profiles\/codex\.json/);
  });

  test("both profiles carry the shared model endpoint under Compute startup's rule", async () => {
    const field = "runtime.modelProvider.baseUrl";
    const shared = { protocol: "openai-responses", baseUrl: "https://models.example.com/v1" };
    const native = await render("openclaw", {
      ...baseInput(),
      runtime: { ...baseInput().runtime, modelProvider: shared },
    });
    assert.deepEqual(
      propertyAt(computeConfiguration(native.installation), "runtime", "modelProvider"),
      shared,
    );
    const capable = await render(
      "codex",
      codexInput({ runtime: { modelProvider: { ...shared, supportsStandaloneWebSearch: true } } }),
    );
    assert.equal(
      propertyAt(
        computeConfiguration(capable.installation),
        "runtime",
        "modelProvider",
        "supportsStandaloneWebSearch",
      ),
      true,
    );
    const accepted = await render(
      "codex",
      codexInput({
        runtime: {
          modelProvider: {
            protocol: "openai-responses",
            baseUrl: "https://Models.Example.com:443/v1/",
          },
        },
      }),
    );
    const compute = computeConfiguration(accepted.installation);
    // Written as Compute normalizes it, and accepted by Compute startup.
    assert.equal(modelProviderBaseUrl(compute), "https://models.example.com/v1");
    const backslashScheme = await render(
      "codex",
      codexInput({
        runtime: {
          modelProvider: { protocol: "openai-responses", baseUrl: "https:\\\\192.0.2.1/v1" },
        },
      }),
    );
    assert.equal(
      modelProviderBaseUrl(computeConfiguration(backslashScheme.installation)),
      "https://192.0.2.1/v1",
    );
    requireConfiguration(KubernetesComputeDriver, compute);
    assert.equal(
      modelProviderBaseUrl(
        computeConfiguration((await render("codex", codexInput())).installation),
      ),
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
    ] satisfies [string | number, string][]) {
      await assertFieldRefusals(
        "codex",
        codexInput({ runtime: { modelProvider: shared } }),
        field,
        [value],
        message,
      );
      assert.throws(
        () =>
          requireConfiguration(KubernetesComputeDriver, {
            ...compute,
            runtime: {
              ...objectAt(compute, "runtime"),
              modelProvider: { protocol: "openai-responses", baseUrl: value },
            },
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
    ] satisfies [string, string][]) {
      const warned = await render(
        "codex",
        codexInput({
          runtime: { modelProvider: { protocol: "openai-responses", baseUrl: value } },
        }),
      );
      assert.ok(
        warned.preflight.warnings.includes(
          `${field} ${blocked}: the generated policy will not admit it unless another NetworkPolicy does.`,
        ),
        value,
      );
      const configured = computeConfiguration(warned.installation);
      assert.equal(modelProviderBaseUrl(configured), value);
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
    ] satisfies [string, boolean][];
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
        objectAt(
          installation,
          "drivers",
          "compute",
          "configuration",
          "runtime",
        ).transportSecretPrefix = prefix;
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

  test(
    "profiles explicitly opt guarded OIDC into host-only native admin",
    { skip: helmSkip },
    async () => {
      const input = externalSignInInput({
        google: undefined,
        oidc: {
          issuer: "https://sso.example.com/realms/acme",
          authorizationUrl: "https://sso.example.com/authorize",
          tokenUrl: "https://sso.example.com/token",
          jwksUrl: "https://sso.example.com/jwks",
          egressCidrs: ["198.51.100.0/24"],
        },
        authBaseUrl: "https://console.example.com",
        agentNativeAdminDomain: "agents.example.com",
        agentNativeAdminSessionMode: "host-only-exchange",
      });
      const output = await render("openclaw", input);
      assert.equal(output.summary.ok, true);
      assert.deepEqual(propertyAt(loadYaml(output.values), "agentNativeAdmin"), {
        enabled: true,
        domain: "agents.example.com",
        sessionMode: "host-only-exchange",
      });
      const shared = await render("openclaw", {
        ...input,
        controlPlane: { ...input.controlPlane, agentNativeAdminSessionMode: "shared-cookie" },
      });
      // The chart owns the shared default; profiles must not revive a manual cookie domain.
      assert.deepEqual(propertyAt(loadYaml(shared.values), "agentNativeAdmin"), {
        enabled: true,
        domain: "agents.example.com",
      });
      const manifests = helmTemplate(output);
      assert.match(
        manifests,
        /name: OCC_AGENT_NATIVE_ADMIN_SESSION_MODE\n\s+value: "host-only-exchange"/,
      );
      assert.doesNotMatch(manifests, /OCC_AUTH_COOKIE_DOMAIN/);
      assert.match(output.preflight.prerequisites.join("\n"), /External sign-in Secrets created/);
      for (const changes of [
        { sharedCookieDomain: "example.com" },
        { agentNativeAdminDomain: "agents.other.com" },
        { google: {} },
        { oidc: undefined },
        { agentNativeAdminSessionMode: "unknown" },
      ]) {
        await assert.rejects(
          render("openclaw", { ...input, controlPlane: { ...input.controlPlane, ...changes } }),
          /profile renderer refused/,
        );
      }
    },
  );
}
