import { asRecord } from "../../packages/utils/src/index.ts";
import assert from "node:assert/strict";
import {
  ConfigurationValidationError as SharedConfigurationValidationError,
  presetTemplateDefaultsWithPlaceholders,
  type HarnessAuthSnapshot,
  type OpenClawConfigurationDocument,
  type OpenClawConfigurationValue,
  type RevisionHarnessDescriptor,
} from "../../packages/contracts/src/index.ts";
import {
  createKubernetesComputeDriver,
  KubernetesComputeDriver,
  kubernetesNamespaceName,
} from "../../apps/controller/src/drivers/compute/kubernetes/index.ts";
import { ConfigurationHarnessError } from "../../packages/occ/src/index.ts";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";
import { createOccLogger, emitOccLogEvent } from "../../apps/controller/src/logging.ts";
import { codexApiKeyRefusal } from "../helpers/refusal-text.mjs";
import {
  tenant,
  apiKeyAuth as routedApiKeyAuth,
  preparedAuth,
  options,
  routedRevision,
} from "../helpers/kubernetes-routed-scenarios.mjs";

// Keep the shared fixture's identity while recovering its JavaScript literal types.
const apiKeyAuth = {
  ...routedApiKeyAuth,
  method: "api_key",
  source: { ...routedApiKeyAuth.source, kind: "secret" },
} satisfies HarnessAuthSnapshot;

export function rejectRemovedModelProviderOptions() {
  const runtime = { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" };
  for (const extra of [
    { codexModelBaseUrl: "https://models.example.test/v1" },
    { codexModelSupportsStandaloneWebSearch: true },
    { modelProvider: { protocol: "openai-responses" } },
    { modelProvider: { baseUrl: "https://models.example.test/v1" } },
    ...["true", 1, null].map((value) => ({
      modelProvider: {
        protocol: "openai-responses",
        baseUrl: "https://models.example.test/v1",
        supportsStandaloneWebSearch: value,
      },
    })),
  ]) {
    assert.throws(
      () => createKubernetesComputeDriver(options({ runtime: { ...runtime, ...extra } })),
      SharedConfigurationValidationError,
    );
  }
}

export async function validateDedicatedCodexModelEndpoint() {
  const runtime = { transportSecretPrefix: "transport", gatewayStorageClassName: "local-path" };
  type Clients = Awaited<NonNullable<KubernetesComputeDriver["apiClients"]>>;
  const clients = {
    version: {
      async getCode() {
        return {
          gitVersion: "v1.35.0",
          major: "1",
          minor: "35",
          buildDate: "",
          compiler: "",
          gitCommit: "",
          gitTreeState: "",
          goVersion: "",
          platform: "",
        };
      },
    },
    core: {
      async listNamespace() {
        return { items: [] };
      },
    },
  } satisfies {
    version: Pick<Clients["version"], "getCode">;
    core: Pick<Clients["core"], "listNamespace">;
  };
  const started = (codexModelBaseUrl: string) => {
    const driver = createKubernetesComputeDriver(
      options({
        runtime: {
          ...runtime,
          modelProvider: { protocol: "openai-responses", baseUrl: codexModelBaseUrl },
        },
      }),
    );
    // Substitute only the two SDK reads used by single-cluster preflight.
    Object.assign(driver, { apiClients: Promise.resolve(clients) });
    return driver;
  };
  for (const codexModelBaseUrl of [
    "https://models.example.test/v1",
    "https://models.example.test/api/v1/",
    "https://API.OpenAI.com:443/v1/",
    "https://models.example.test:443/v1",
    "https://bücher.example.test/v1",
    "https://192.0.2.1/v1",
    "https://192.0.2.1\\v1",
    "https:\\\\192.0.2.1/v1",
    "HTTPS://192.0.2.1/v1",
    // Public IPv4 just outside each range the model egress policy excludes.
    "https://11.0.0.1/v1",
    "https://100.128.0.1/v1",
    "https://172.32.0.1/v1",
    "https://192.169.0.1/v1",
    "https://169.255.0.1/v1",
    "https://models.example.test./v1",
  ]) {
    assert.deepEqual(await started(codexModelBaseUrl).preflight(), { warnings: [] });
  }
  // The generated Harness model egress policy admits only TCP/443 to IPv4 outside its excluded
  // ranges. Kubernetes admits the union of NetworkPolicies, so an operator's own policy can open
  // these: startup accepts them and its preflight warns (findings 1740, 2284).
  const lines: string[] = [];
  const logger = createOccLogger({
    component: "occ-worker",
    destination: {
      write(chunk) {
        lines.push(String(chunk));
        return true;
      },
    },
  });
  const port = "uses port 8443 but Harness model egress allows only TCP/443";
  const ipv6 = "is an IPv6 address but Harness model egress allows only IPv4";
  const excluded = (cidr: string) =>
    `has an IPv4 host in ${cidr} which Harness model egress excludes`;
  for (const [codexModelBaseUrl, blocked] of [
    ["https://models.example.test:8443/v1", port],
    // Every blocked property is named in the one warning.
    ["https://10.0.0.5:8443/v1", `${port} and ${excluded("10.0.0.0/8")}`],
    ["https://192.0.2.1:444/v1", port.replace("8443", "444")],
    ["https://[2001:db8::1]/v1", ipv6],
    ["https://[::1]/v1", ipv6],
    ["https://[::ffff:203.0.113.1]/v1", ipv6],
    ["https://10.1.2.3/v1", excluded("10.0.0.0/8")],
    ["https://100.127.255.255/v1", excluded("100.64.0.0/10")],
    ["https://172.31.0.1/v1", excluded("172.16.0.0/12")],
    ["https://192.168.0.10/v1", excluded("192.168.0.0/16")],
    ["https://169.254.169.254/v1", excluded("169.254.0.0/16")],
  ] as const) {
    const message = `Model provider endpoint ${blocked}: the generated policy will not admit it unless another NetworkPolicy does.`;
    const result = await started(codexModelBaseUrl).preflight();
    assert.deepEqual(
      result,
      { warnings: [{ code: "KUBERNETES_MODEL_EGRESS_BLOCKED", message }] },
      codexModelBaseUrl,
    );
    // API and worker startup log each warning; the log keeps the plain text, never the URL.
    lines.length = 0;
    for (const warning of result.warnings) {
      emitOccLogEvent(logger, { event: "compute.preflight-warning", ...warning });
    }
    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.ok(line);
    const event = asRecord(JSON.parse(line));
    assert.ok(event);
    assert.deepEqual({ code: event.code, message: event.message }, result.warnings[0]);
    assert.equal(line.includes(new URL(codexModelBaseUrl).hostname), false);
    assert.equal(line.includes("://"), false);
  }
  // The warning changes no policy: the model egress grant is the one without the endpoint.
  const target = { name: kubernetesNamespaceName(tenant.id), plane: "execution" } as const;
  const modelEgress = (driver: KubernetesComputeDriver) => {
    const revision = routedRevision(driver, {
      id: "revision-model-egress-1",
      agentId: "agent-model-egress",
      servicePrincipalId: "service-principal-model-egress",
    });
    const policy = driver["agentAuthenticationNetworkPolicy"](revision, target);
    const egress = policy.spec?.egress;
    assert.ok(Array.isArray(egress) && egress.length > 0);
    return egress;
  };
  assert.deepEqual(
    modelEgress(started("https://10.0.0.5:8443/v1")),
    modelEgress(createKubernetesComputeDriver(options({ runtime }))),
  );
  for (const codexModelBaseUrl of [
    "not-a-url",
    "http://models.example.test/v1",
    syntheticCredentialUrl({
      username: "user",
      password: "password",
      host: "models.example.test",
      port: undefined,
      pathname: "/v1",
    }),
    "https://models.example.test/v2",
    "https://models.example.test/*/v1",
    "https://**/v1",
    "https://*.example.test/v1",
    "https://ex*ample.test/v1",
    "https://%2a%2A/v1",
    "https://%2A.example.test/v1",
    "https://ex%2aample.test/v1",
    "https://＊.example.test/v1",
    "https://models.example.test:0/v1",
    "https://models.example.test:000/v1",
    "https://models.example.test/v1?key=fixture",
    "https://models.example.test/v1#fragment",
  ]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(
          options({
            runtime: {
              ...runtime,
              modelProvider: { protocol: "openai-responses", baseUrl: codexModelBaseUrl },
            },
          }),
        ),
      SharedConfigurationValidationError,
    );
  }
  // IPv4 hosts the URL parser rewrites to another address name the IPv4 rule.
  for (const codexModelBaseUrl of [
    "https://192.168.1/v1",
    "https://2130706433/v1",
    "https://0177.0.0.1/v1",
    "https://127.1/v1",
  ]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(
          options({
            runtime: {
              ...runtime,
              modelProvider: { protocol: "openai-responses", baseUrl: codexModelBaseUrl },
            },
          }),
        ),
      SharedConfigurationValidationError,
      codexModelBaseUrl,
    );
  }
  // Spellings the URL parser rewrites to https://models.example.test/v1 (finding 1292), refused
  // as the shared baseUrl and auth.baseUrl rules refuse them.
  for (const [codexModelBaseUrl, message] of [
    ["https://@models.example.test/v1", /must not contain user info or an @ before the host/],
    ["https://:@models.example.test/v1", /must not contain user info or an @ before the host/],
    ["https:models.example.test/v1", /must start with https:\/\/ \(the \/\/ after the scheme/],
    ["https:/models.example.test/v1", /must start with https:\/\/ \(the \/\/ after the scheme/],
    ["https:///models.example.test/v1", /requires HTTPS/],
    [" https://models.example.test/v1 ", /must not contain spaces or control characters/],
    ["https://models.example.test\t/v1", /must not contain spaces or control characters/],
    ["https://models.exam\nple.test/v1", /must not contain spaces or control characters/],
    ["https://models.example.test/v1\u0000", /must not contain spaces or control characters/],
  ] as const) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(
          options({
            runtime: {
              ...runtime,
              modelProvider: { protocol: "openai-responses", baseUrl: codexModelBaseUrl },
            },
          }),
        ),
      (error) => {
        assert.ok(error instanceof SharedConfigurationValidationError);
        const detail = error.error.details?.find(
          ({ path }) => path === "/runtime/modelProvider/baseUrl",
        );
        assert.ok(detail);
        assert.equal(detail.code, "INVALID_FORMAT");
        assert.ok(detail.message, JSON.stringify(codexModelBaseUrl));
        assert.match(detail.message, message, JSON.stringify(codexModelBaseUrl));
        return true;
      },
    );
  }
}

export function validateNativeOpenClawSessionCapacity() {
  const runtime = {
    transportSecretPrefix: "transport",
    gatewayStorageClassName: "local-path",
  };
  for (const nativeOpenClawSessionCapacity of [1, 8, 1024]) {
    assert.doesNotThrow(() =>
      createKubernetesComputeDriver(
        options({ runtime: { ...runtime, nativeOpenClawSessionCapacity } }),
      ),
    );
  }
  for (const nativeOpenClawSessionCapacity of [0, 1.5, 1025, Number.NaN]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(
          options({ runtime: { ...runtime, nativeOpenClawSessionCapacity } }),
        ),
      SharedConfigurationValidationError,
    );
  }
}

export function renderDedicatedCodexSeccompProfile() {
  const runtime = {
    transportSecretPrefix: "transport",
    gatewayStorageClassName: "local-path",
  };
  const profile = "profiles/codex-0.156.0.json";
  const driver = createKubernetesComputeDriver(
    options({ runtime: { ...runtime, codexSeccompProfile: profile } }),
  );
  const defaultDriver = createKubernetesComputeDriver(options({ runtime }));
  const ownership = {
    namespaceId: tenant.id,
    agentId: "agent-seccomp",
    revisionId: "revision-seccomp",
  };
  const namespace = kubernetesNamespaceName(tenant.id);
  const workload = (
    computeDriver: KubernetesComputeDriver,
    role: "agent" | "gateway",
    embedded = false,
  ) => {
    // Keep the deployment renderer arguments used by the production preparation path.
    const deployment = computeDriver["deployment"](
      role,
      ownership,
      { name: namespace, plane: "execution" },
      `${role}:local`,
      role,
      role,
      {},
      "info",
      computeDriver["gatewayConfiguration"](
        routedRevision(computeDriver, { agentId: ownership.agentId }),
        undefined,
        { name: namespace, plane: "execution" },
      ),
      embedded,
      undefined,
      preparedAuth(computeDriver, namespace, embedded),
    );
    const pod = asRecord(asRecord(deployment.spec?.template)?.spec);
    const containers = pod?.containers;
    assert.ok(Array.isArray(containers));
    const podSecurityContext = asRecord(pod?.securityContext);
    const containerSecurityContext = asRecord(asRecord(containers[0])?.securityContext);
    assert.ok(podSecurityContext);
    assert.ok(containerSecurityContext);
    return { podSecurityContext, containerSecurityContext };
  };

  const agent = workload(driver, "agent");
  assert.deepEqual(agent.podSecurityContext.seccompProfile, { type: "RuntimeDefault" });
  assert.deepEqual(agent.containerSecurityContext.seccompProfile, {
    type: "Localhost",
    localhostProfile: profile,
  });

  for (const pod of [
    workload(driver, "gateway"),
    workload(driver, "gateway", true),
    workload(defaultDriver, "agent"),
  ]) {
    assert.deepEqual(pod.podSecurityContext.seccompProfile, { type: "RuntimeDefault" });
    assert.equal(pod.containerSecurityContext.seccompProfile, undefined);
  }

  for (const codexSeccompProfile of [
    "",
    " ",
    "/profiles/codex.json",
    "../codex.json",
    "profiles/../codex.json",
    "profiles//codex.json",
    "unconfined",
    "profiles/unconfined",
    { type: "Unconfined" },
  ]) {
    assert.throws(
      () =>
        createKubernetesComputeDriver(options({ runtime: { ...runtime, codexSeccompProfile } })),
      SharedConfigurationValidationError,
    );
  }

  assert.throws(
    () =>
      createKubernetesComputeDriver(
        options({
          runtime: {
            ...runtime,
            securityContext: { seccompProfile: { type: "Unconfined" } },
          },
        }),
      ),
    SharedConfigurationValidationError,
  );
}

export function rejectRetiredOAuthHarnessAuthentication() {
  const driver = new KubernetesComputeDriver(options());
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        { id: "codex", version: "1.0.0", mode: "dedicated" },
        // @ts-expect-error The retired wire method must still be rejected at runtime.
        { ...apiKeyAuth, method: "oauth" },
        { agents: { defaults: { model: "codex/gpt-5" } } },
      ),
    {
      name: "ConfigurationHarnessError",
      message:
        "Agent setting harnessAuth.method must be api_key, codex_pat or credential_source for Dedicated Codex on Kubernetes Compute: change harnessAuth.",
    },
  );
}

export function validateHarnessAuthenticationMethod() {
  const driver = new KubernetesComputeDriver(options());
  const embedded = {
    id: "openclaw",
    version: "1.0.0",
    mode: "embedded",
  } satisfies RevisionHarnessDescriptor;
  const native = {
    id: "openclaw",
    version: "1.0.0",
    mode: "dedicated",
  } satisfies RevisionHarnessDescriptor;
  const codex = {
    id: "codex",
    version: "1.0.0",
    mode: "dedicated",
  } satisfies RevisionHarnessDescriptor;
  const openclawConfiguration = createHarnessConfiguration("openclaw", "gpt-4o-mini");
  const codexConfiguration = { agents: { defaults: { model: "codex/gpt-5" } } };
  const message = (accepted: string) =>
    `Agent setting harnessAuth.method must be ${accepted} on Kubernetes Compute: change harnessAuth${
      accepted.endsWith("Dedicated Codex") ? "" : " or executionMode"
    }.`;
  for (const [harness, configuration, accepted, refused] of [
    [
      embedded,
      openclawConfiguration,
      "api_key for embedded OpenClaw",
      ["runtime", "codex_pat", "oauth", "credential_source"],
    ],
    [
      native,
      openclawConfiguration,
      "api_key or credential_source for Dedicated OpenClaw",
      ["runtime", "codex_pat", "oauth"],
    ],
    [
      codex,
      codexConfiguration,
      "api_key, codex_pat or credential_source for Dedicated Codex",
      ["runtime", "oauth"],
    ],
  ] as const) {
    for (const method of refused) {
      const auth = method === "runtime" ? { method } : { ...apiKeyAuth, method };
      // Agent save (null bindings) and deployment give the same named refusal.
      for (const bindings of [null, {}]) {
        if (harness === native && bindings !== null) {
          continue; // Deployment refuses dedicated OpenClaw without a Sandbox Driver first.
        }
        assert.throws(
          () =>
            // @ts-expect-error Submit the malformed auth snapshots to the runtime boundary.
            driver.validateHarnessAuth(harness, auth, configuration, bindings),
          (error) =>
            error instanceof ConfigurationHarnessError && error.message === message(accepted),
          `${harness.mode} ${harness.id} ${method}`,
        );
      }
    }
  }
  // The accepted methods pass this rule; api_key passes admission on every topology.
  driver.validateHarnessAuth(embedded, apiKeyAuth, openclawConfiguration, null);
  driver.validateHarnessAuth(native, apiKeyAuth, openclawConfiguration, null);
  driver.validateHarnessAuth(codex, apiKeyAuth, codexConfiguration, null);
}

export function rejectUnrenderableCodexSettings() {
  // The Gateway entrypoint refuses to start on these shapes; admitting them let
  // a deployment replace a working Gateway with one that crash-looped (D201).
  const auth = { ...apiKeyAuth, method: "codex_pat" } satisfies HarnessAuthSnapshot;
  const codex = {
    id: "codex",
    version: "1.0.0",
    mode: "dedicated",
  } satisfies RevisionHarnessDescriptor;
  const base = { agents: { defaults: { model: "codex/gpt-5" } } };
  const withCodexConfig = (config: OpenClawConfigurationValue) => ({
    ...base,
    plugins: { entries: { codex: { config } } },
  });
  const driver = new KubernetesComputeDriver(options());
  for (const accepted of [
    base,
    withCodexConfig({ codexDynamicToolsExclude: ["tts"] }),
    withCodexConfig(null),
    { ...withCodexConfig({}), cron: { enabled: true, triggers: { enabled: true } } },
    { ...withCodexConfig({}), cron: null },
    {
      ...withCodexConfig({}),
      agents: {
        defaults: { ...base.agents.defaults, compaction: { memoryFlush: { enabled: true } } },
      },
    },

    {
      ...base,
      models: {
        providers: {
          Codex: { baseUrl: "https://model.example.test/v1", models: [{ id: "gpt-5" }] },
          openai: {},
          // Rows of other providers are not rewritten.
          anthropic: "unchanged",
        },
      },
    },
  ]) {
    driver.validateHarnessAuth(codex, auth, accepted);
  }
  for (const [rejected, message] of [
    [
      withCodexConfig({ codexDynamicToolsExclude: "tts" }),
      "plugins.entries.codex.config.codexDynamicToolsExclude must be a list",
    ],
    [withCodexConfig("on"), "plugins.entries.codex.config must be an object"],
    [{ ...withCodexConfig({}), cron: "off" }, "cron must be an object"],
    [{ ...withCodexConfig({}), cron: { triggers: true } }, "cron.triggers must be an object"],
    [
      {
        ...withCodexConfig({}),
        agents: { defaults: { ...base.agents.defaults, compaction: "off" } },
      },
      "agents.defaults.compaction must be an object",
    ],
    [
      {
        ...withCodexConfig({}),
        agents: { defaults: { ...base.agents.defaults, compaction: { memoryFlush: true } } },
      },
      "agents.defaults.compaction.memoryFlush must be an object",
    ],
    [{ ...base, models: "none" }, "models must be an object"],
    [{ ...base, models: { providers: [] } }, "models.providers must be an object"],
    [
      { ...base, models: { providers: { codex: "stub" } } },
      "models.providers.codex must be an object",
    ],
    [
      { ...base, models: { providers: { " OpenAI ": null } } },
      "models.providers. OpenAI  must be an object",
    ],
    [
      { ...base, models: { providers: { codex: { models: [null] } } } },
      "models.providers.codex.models must be a list of objects",
    ],
    [
      { ...base, models: { providers: { openai: { models: ["gpt-5"] } } } },
      "models.providers.openai.models must be a list of objects",
    ],
  ] as const) {
    // Admission returns this message to the Configuration owner (D321).
    assert.throws(
      () => driver.validateHarnessAuth(codex, auth, rejected),
      (error) =>
        error instanceof ConfigurationHarnessError &&
        error.message ===
          `Configuration setting ${message}: a dedicated Codex Gateway cannot apply it otherwise.`,
    );
  }
  assert.throws(
    () => driver.validateHarnessAuth(codex, auth, { ...base, cron: "off" }),
    /Configuration setting cron must be an object/,
    "the dedicated baseline now disables triggers even without a Codex plugin entry",
  );
  // A long submitted provider key (matched trimmed, so padded with whitespace) is cut, with
  // "…", so the message fits the 256-character error cap and keeps the rule wording
  // (finding 664).
  const wording = ": a dedicated Codex Gateway cannot apply it otherwise.";
  for (const [providers, start, rule] of [
    [{ [`${" ".repeat(300)}openai`]: "stub" }, " ".repeat(8), " must be an object"],
    [
      { [`Codex${"\u3000".repeat(400)}`]: { models: ["gpt-5"] } },
      `Codex${"\u3000".repeat(8)}`,
      ".models must be a list of objects",
    ],
  ] as const) {
    assert.throws(
      () => driver.validateHarnessAuth(codex, auth, { ...base, models: { providers } }),
      (error) => {
        assert.ok(error instanceof ConfigurationHarnessError);
        assert.equal(Array.from(error.message).length, 256, error.message);
        assert.ok(error.message.startsWith(`Configuration setting models.providers.${start}`));
        assert.ok(error.message.endsWith(`…${rule}${wording}`), error.message);
        return true;
      },
    );
  }
  // A key that exactly fills the cap stays whole; one character more is cut.
  const room = 256 - `Configuration setting models.providers. must be an object${wording}`.length;
  const padded = `${" ".repeat(room - 6)}OpenAI`;
  assert.throws(
    () =>
      driver.validateHarnessAuth(codex, auth, {
        ...base,
        models: { providers: { [padded]: "stub" } },
      }),
    { message: `Configuration setting models.providers.${padded} must be an object${wording}` },
  );
  assert.throws(
    () =>
      driver.validateHarnessAuth(codex, auth, {
        ...base,
        models: { providers: { [` ${padded}`]: "stub" } },
      }),
    {
      message: `Configuration setting models.providers.${" ".repeat(room - 5)}Open… must be an object${wording}`,
    },
  );
}

export function bindAnthropicModelCredentials() {
  const driver = createKubernetesComputeDriver(options());
  const embedded = {
    id: "openclaw",
    version: "1.0.0",
    mode: "embedded",
  } satisfies RevisionHarnessDescriptor;
  const model = "anthropic/claude-sonnet-4-5";
  const configuration = {
    agents: { defaults: { model: { primary: model, fallbacks: ["anthropic/claude-haiku-4-5"] } } },
    secrets: { providers: { model: { source: "env", allowlist: ["ANTHROPIC_API_KEY"] } } },
  };
  for (const apiKey of [
    undefined,
    "${ANTHROPIC_API_KEY}",
    { source: "env", provider: "model", id: "ANTHROPIC_API_KEY" },
    // OpenClaw's built-in default env provider reads the process environment unconfigured.
    { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
  ]) {
    assert.doesNotThrow(() =>
      driver.validateHarnessAuth(embedded, apiKeyAuth, {
        ...configuration,
        // @ts-expect-error The existing admission case also supplies an explicit undefined key.
        models: { providers: { anthropic: { apiKey } } },
      }),
    );
  }
  // With secrets.defaults.env naming another alias, "default" is an unconfigured provider.
  assert.throws(
    () =>
      driver.validateHarnessAuth(embedded, apiKeyAuth, {
        ...configuration,
        secrets: { ...configuration.secrets, defaults: { env: "model" } },
        models: {
          providers: {
            anthropic: { apiKey: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" } },
          },
        },
      }),
    {
      name: "ConfigurationHarnessError",
      message:
        "Configuration setting models.providers.anthropic.apiKey must be ${ANTHROPIC_API_KEY} or an env SecretRef to ANTHROPIC_API_KEY, which the Agent's Harness authentication binding supplies.",
    },
  );
  for (const apiKey of [
    "plaintext-fixture",
    "${OPENAI_API_KEY}",
    "${ANTHROPIC_AUTH_TOKEN}",
    { source: "env", provider: "model", id: "OPENAI_API_KEY" },
  ]) {
    // The caller owns the Configuration, so admission names the setting (finding 1116).
    assert.throws(
      () =>
        driver.validateHarnessAuth(embedded, apiKeyAuth, {
          ...configuration,
          models: { providers: { anthropic: { apiKey } } },
        }),
      {
        name: "ConfigurationHarnessError",
        message:
          "Configuration setting models.providers.anthropic.apiKey must be ${ANTHROPIC_API_KEY} or an env SecretRef to ANTHROPIC_API_KEY, which the Agent's Harness authentication binding supplies.",
      },
    );
  }
  const binding = "model credentials come from the Agent's Harness authentication binding";
  const credentialHeader = (name: string) =>
    `must not set the credential header "${name}" (its name marks a credential)`;
  for (const [conflicting, message] of [
    [
      { env: { ANTHROPIC_API_KEY: "fixture" } },
      `Configuration setting env.ANTHROPIC_API_KEY must not be set: the Agent's Harness authentication binding owns model provider environment.`,
    ],
    [
      { env: { vars: { ANTHROPIC_AUTH_TOKEN: "fixture" } } },
      `Configuration setting env.vars.ANTHROPIC_AUTH_TOKEN must not be set: the Agent's Harness authentication binding owns model provider environment.`,
    ],
    [
      { auth: { profiles: { alternate: { provider: "anthropic", mode: "token" } } } },
      `Configuration setting auth must be empty: ${binding}.`,
    ],
    [
      { models: { providers: { anthropic: { headers: { "x-api-key": "fixture" } } } } },
      `Configuration setting models.providers.anthropic.headers ${credentialHeader("x-api-key")}: ${binding}.`,
    ],
    [
      {
        models: {
          providers: {
            anthropic: {
              models: [{ id: "claude-sonnet-4-5", headers: { "x-api-key": "fixture" } }],
            },
          },
        },
      },
      `Configuration setting models.providers.anthropic.models.0.headers ${credentialHeader("x-api-key")}: ${binding}.`,
    ],
  ] as const) {
    // Every topology refuses these, so Configuration save runs the same rule.
    for (const check of [
      () => driver.validateHarnessAuth(embedded, apiKeyAuth, { ...configuration, ...conflicting }),
      () => driver.validateConfiguration({ ...configuration, ...conflicting }),
    ]) {
      assert.throws(check, { name: "ConfigurationHarnessError", message });
    }
  }
  // A fallback on another provider names its setting (finding 1291).
  for (const [selection, refusal] of [
    [
      { primary: model, fallbacks: ["openai/gpt-5"] },
      "Configuration setting agents.defaults.model.fallbacks must select anthropic/<model>, the provider of the Agent's Harness authentication binding.",
    ],
    [
      { primary: "openai/gpt-5", fallbacks: [model] },
      "Configuration setting agents.defaults.model.fallbacks must select openai/<model>, the provider of the Agent's Harness authentication binding.",
    ],
    ["codex/gpt-5", /compatible model provider/i],
    ["ollama/llama3.2", /compatible model provider/i],
  ] as const) {
    assert.throws(
      () =>
        driver.validateHarnessAuth(embedded, apiKeyAuth, {
          agents: { defaults: { model: selection } },
        }),
      typeof refusal === "string"
        ? { name: "ConfigurationHarnessError", message: refusal }
        : refusal,
    );
  }
  assert.throws(
    () =>
      driver.validateHarnessAuth(
        { id: "codex", version: "1.0.0", mode: "dedicated" },
        apiKeyAuth,
        configuration,
      ),
    /compatible model provider/i,
  );
}

export function validateFilledPresetHeaderNames() {
  const driver = createKubernetesComputeDriver(options());
  const binding = "model credentials come from the Agent's Harness authentication binding";
  const credentialHeader = (name: string) =>
    `must not set the credential header "${name}" (its name marks a credential): ${binding}`;
  // The name up to its first invalid character, with a placeholder as written, or the code point
  // of an invalid first character (finding 1251).
  const invalidName =
    /^Configuration setting \S+ must use valid HTTP header names, not (?:"(?:[\w-]|\{\{ vars\.\w+ \}\})*…"|one that starts with U\+[0-9A-F]{4,})\.$/;
  const provider = (name: string, settings: OpenClawConfigurationDocument) => ({
    models: { providers: { [name]: settings } },
  });
  // The Preset save's render: the values with defaults, and where it left placeholders.
  const preset = (values: OpenClawConfigurationDocument) => {
    const { settings, unresolved } = presetTemplateDefaultsWithPlaceholders({
      variables: { header: { type: "string" }, p: { type: "string" } },
      configuration: { values },
    });
    const rendered = settings.configuration?.values;
    assert.ok(rendered);
    return [rendered, { unresolved }] as const;
  };
  // Finding 1207: on a Preset save, a header name that waits on an unfilled variable is checked
  // once filled, as on every Compute; a name the rule matches around it is still refused.
  for (const headers of [
    { headers: { "{{ vars.header }}": "v" } },
    { request: { headers: { "{{ vars.header }}": "v" } } },
    { models: [{ id: "m", headers: { "{{ vars.header }}": "v" } }] },
    { headers: { "Authorization-{{ vars.header }}": "v" } },
  ]) {
    const [values, saving] = preset(provider("p", headers));
    driver.validateConfiguration(values, saving);
    assert.throws(() => driver.validateConfiguration(values), {
      name: "ConfigurationHarnessError",
      message: invalidName,
    });
  }
  // Finding 1244: so is one the text around the variable names, as the variable filled empty.
  for (const name of [
    "{{ vars.p }}-Authorization",
    "Authorization{{ vars.p }}",
    "X-Api-Key{{ vars.p }}",
  ]) {
    assert.throws(
      () => driver.validateConfiguration(...preset(provider("p", { headers: { [name]: "v" } }))),
      {
        name: "ConfigurationHarnessError",
        message: `Configuration setting models.providers.p.headers ${credentialHeader(name)}.`,
      },
    );
  }
  // Finding 1221: the text around the variable must be valid too. Finding 1220: an escaped token
  // that reads like a placeholder in another provider stays literal.
  for (const values of [
    provider("p", { headers: { "{{ vars.header }} ": "v" } }),
    provider("p", { models: [{ id: "m", headers: { "{{ vars.header }}\u200b": "v" } }] }),
    provider("p", { request: { headers: { "\\{{ vars.p }}-{{ vars.header }}": "v" } } }),
    {
      models: {
        providers: {
          a: { headers: { "{{ vars.header }}": "v" } },
          b: { headers: { "\\{{ vars.header }}": "v" } },
        },
      },
    },
  ]) {
    assert.throws(() => driver.validateConfiguration(...preset(values)), {
      name: "ConfigurationHarnessError",
      message: invalidName,
    });
  }
}

export function enforceHarnessModelProvider() {
  const driver = createKubernetesComputeDriver(options());
  const codex = {
    id: "codex",
    version: "1.0.0",
    mode: "dedicated",
  } satisfies RevisionHarnessDescriptor;
  const embedded = {
    id: "openclaw",
    version: "1.0.0",
    mode: "embedded",
  } satisfies RevisionHarnessDescriptor;
  const catalog = (provider: string, ids: readonly string[]) => ({
    [provider]: {
      baseUrl: "http://127.0.0.1:9",
      api: "openai-responses",
      models: ids.map((id) => ({ id, name: id })),
    },
  });
  const requirement = (provider: string) =>
    `${provider}/<model>, the provider of the Agent's Harness authentication binding`;
  const refused = (setting: string, rule: string) => ({
    name: "ConfigurationHarnessError",
    message: `Configuration setting ${setting} ${rule}.`,
  });
  // Agent save (null bindings) and deployment admission.
  const admissions = (
    harness: RevisionHarnessDescriptor,
    configuration: OpenClawConfigurationDocument,
  ) => [
    () => driver.validateHarnessAuth(harness, apiKeyAuth, configuration, null),
    () => driver.validateHarnessAuth(harness, apiKeyAuth, configuration),
  ];
  const refuses = (
    harness: RevisionHarnessDescriptor,
    configuration: OpenClawConfigurationDocument,
    expected: ReturnType<typeof refused>,
    label?: string,
  ) => {
    for (const admit of admissions(harness, configuration)) {
      assert.throws(admit, expected, label);
    }
  };
  // B: mixed providers across defaults and an Agent entry.
  refuses(
    codex,
    {
      agents: {
        ownership: "explicit",
        defaults: { model: "openai/gpt-5" },
        entries: { main: {}, reviewer: { model: "codex/gpt-5-codex" } },
      },
      models: {
        providers: { ...catalog("openai", ["gpt-5"]), ...catalog("codex", ["gpt-5-codex"]) },
      },
    },
    refused("agents.entries.reviewer.model", `must select ${requirement("openai")}`),
    "B",
  );
  // C: a subagent on another provider, and that provider's inline key wherever it is configured.
  refuses(
    codex,
    {
      agents: {
        defaults: { model: "codex/gpt-5", subagents: { model: "anthropic/claude-opus-4" } },
      },
      models: {
        providers: {
          ...catalog("codex", ["gpt-5"]),
          anthropic: { baseUrl: "https://api.anthropic.com", models: [{ id: "claude-opus-4" }] },
        },
      },
    },
    refused("agents.defaults.subagents.model", `must select ${requirement("codex")}`),
    "C",
  );
  refuses(
    codex,
    {
      agents: { defaults: { model: "codex/gpt-5" } },
      models: {
        providers: {
          ...catalog("codex", ["gpt-5"]),
          anthropic: { baseUrl: "https://api.anthropic.com", apiKey: "sk-fixture-unselected" },
        },
      },
    },
    {
      name: "ConfigurationHarnessError",
      message: codexApiKeyRefusal("models.providers.anthropic.apiKey"),
    },
    "C: unselected provider key",
  );
  // OpenClaw accepts an apiKey only on the binding's provider: a bare model name can still reach
  // another configured provider. A key spelled differently is another provider entry.
  for (const provider of ["anthropic", "OpenAI"]) {
    refuses(
      embedded,
      {
        agents: { defaults: { model: "openai/gpt-5", imageModel: "claude-opus-4" } },
        models: {
          providers: {
            [provider]: { baseUrl: "https://models.example.test", apiKey: "sk-fixture-unselected" },
          },
        },
      },
      refused(
        `models.providers.${provider}.apiKey`,
        "must be unset: the Agent's Harness authentication binding serves only openai models",
      ),
      `OpenClaw: ${provider} key`,
    );
  }
  // D: a models policy key the Codex projection cannot qualify.
  refuses(
    codex,
    {
      agents: { defaults: { model: "codex/gpt-5", models: { codex: {} } } },
      models: { providers: catalog("codex", ["gpt-5"]) },
    },
    refused("agents.defaults.models", `keys must select ${requirement("codex")}`),
    "D",
  );
  // So is an allowlist entry, and an allowlist that is not a list (finding 1306).
  for (const [allow, rule] of [
    [["codex/gpt-5", "gpt-5"], `must select ${requirement("codex")}`],
    ["codex/*", "must be provider/model references"],
  ] as const) {
    refuses(
      codex,
      {
        agents: { defaults: { model: "codex/gpt-5", modelPolicy: { allow } } },
        models: { providers: catalog("codex", ["gpt-5"]) },
      },
      refused("agents.defaults.modelPolicy.allow", rule),
      `D: allow ${JSON.stringify(allow)}`,
    );
  }
  // A media or voice model with the binding's provider is still refused on Codex, and names the
  // setting, not its primary.
  refuses(
    codex,
    {
      agents: {
        defaults: {
          model: "codex/gpt-5",
          mediaModels: { image: { primary: "codex/gpt-image-1" } },
        },
      },
      models: { providers: catalog("codex", ["gpt-5"]) },
    },
    refused(
      "agents.defaults.mediaModels.image",
      "must be unset: Dedicated Codex serves chat models only, not media or voice models",
    ),
    "D: media",
  );
  // Embedded OpenClaw keeps them, on the binding's provider, and a bare allowlist alias.
  for (const admit of admissions(embedded, {
    agents: {
      defaults: {
        model: "openai/gpt-5",
        mediaModels: { image: "openai/gpt-image-1" },
        voiceModel: "openai/gpt-realtime",
        modelPolicy: { allow: ["openai/*", "small"] },
      },
    },
  })) {
    assert.doesNotThrow(admit, "embedded media, voice and allowlist");
  }
  // E: fallbacks that are not model references, named instead of failing at deployment.
  for (const [scope, setting] of [
    ["model", "agents.defaults.model.fallbacks"],
    ["subagents", "agents.defaults.subagents.model.fallbacks"],
  ] as const) {
    const selection = { primary: "codex/gpt-5", fallbacks: ["codex/gpt-5-mini", 7] };
    refuses(
      codex,
      {
        agents: {
          defaults:
            scope === "model"
              ? { model: selection }
              : { model: "codex/gpt-5", subagents: { model: selection } },
        },
        models: { providers: catalog("codex", ["gpt-5"]) },
      },
      refused(setting, "must be provider/model references"),
      `E: ${scope}`,
    );
  }
  // Every other selection the pinned Gateway honors, on Codex and embedded OpenClaw alike.
  for (const [values, setting] of [
    [{ agents: { defaults: { imageModel: "x/m" } } }, "agents.defaults.imageModel"],
    [
      { agents: { defaults: { pdfModel: { primary: "x/m" } } } },
      "agents.defaults.pdfModel.primary",
    ],
    [{ agents: { defaults: { voiceModel: "x/m" } } }, "agents.defaults.voiceModel"],
    [
      { agents: { defaults: { mediaModels: { video: "x/m" } } } },
      "agents.defaults.mediaModels.video",
    ],
    [
      { agents: { entries: { main: { mediaModels: { music: "x/m" } } } } },
      "agents.entries.main.mediaModels.music",
    ],
    [
      { agents: { defaults: { modelPolicy: { allow: ["x/m"] } } } },
      "agents.defaults.modelPolicy.allow",
    ],
    [
      { agents: { entries: { main: { modelPolicy: { allow: ["x/*"] } } } } },
      "agents.entries.main.modelPolicy.allow",
    ],
    [{ agents: { defaults: { utilityModel: "x/m" } } }, "agents.defaults.utilityModel"],
    [{ agents: { defaults: { decisionModel: "x/m" } } }, "agents.defaults.decisionModel"],
    [{ agents: { defaults: { heartbeat: { model: "x/m" } } } }, "agents.defaults.heartbeat.model"],
    [
      { agents: { entries: { main: { tools: { exec: { reviewer: { model: "x/m" } } } } } } },
      "agents.entries.main.tools.exec.reviewer.model",
    ],
    [
      { agents: { entries: { main: { tts: { summaryModel: "x/m" } } } } },
      "agents.entries.main.tts.summaryModel",
    ],
    [{ agents: { defaults: { models: { "x/m": {} } } } }, "agents.defaults.models"],
    [
      { tools: { exec: { reviewer: { model: { fallbacks: ["x/m"] } } } } },
      "tools.exec.reviewer.model.fallbacks",
    ],
    [{ hooks: { mappings: [{}, { model: "x/m" }] } }, "hooks.mappings.1.model"],
    [{ hooks: { gmail: { model: "x/m" } } }, "hooks.gmail.model"],
    [{ channels: { modelByChannel: { slack: { C1: "x/m" } } } }, "channels.modelByChannel.slack"],
  ] as const) {
    for (const [harness, model, provider] of [
      [codex, "codex/gpt-5", "codex"],
      [embedded, "openai/gpt-5", "openai"],
    ] as const) {
      const agents = values.agents ?? {};
      // Dedicated Codex refuses a media or voice model whatever its provider (finding 1306).
      const capability = harness === codex && /\.(?:mediaModels\.\w+|voiceModel)$/.test(setting);
      refuses(
        harness,
        { ...values, agents: { ...agents, defaults: { ...agents.defaults, model } } },
        refused(
          setting,
          capability
            ? "must be unset: Dedicated Codex serves chat models only, not media or voice models"
            : `${setting === "agents.defaults.models" ? "keys " : ""}must select ${requirement(provider)}`,
        ),
        `${harness.id}: ${setting}`,
      );
    }
  }
  // F, G, M: Codex selections under the source provider keep their native ID namespace, aliases
  // and synthesized catalog rows (docs/flows/harness-execution-topology.md), so they still save.
  for (const subagents of [
    { model: "codex/openai/gpt-5" },
    { model: "codex/o3-pro" },
    { model: "codex/openai-compatible/gpt-5" },
    { model: { primary: "codex/gpt-5", fallbacks: ["codex"] } },
  ]) {
    for (const admit of admissions(codex, {
      agents: {
        defaults: {
          model: "codex/gpt-5",
          models: { "codex/*": {} },
          modelPolicy: { allow: ["codex/*", "codex/gpt-5"] },
          subagents,
          decisionModel: "",
          // An empty media or voice model selects nothing, so Codex admits it.
          voiceModel: "",
        },
      },
      channels: { modelByChannel: { slack: { C1: "codex/gpt-5" } } },
      models: { providers: catalog("codex", ["gpt-5"]) },
    })) {
      assert.doesNotThrow(admit, JSON.stringify(subagents));
    }
  }
}

export function rejectModelCredentialHeadersAndRequestAuth() {
  // Findings 1142 and 1143: OpenClaw also merges request.headers and request.auth into provider
  // requests, and reaches providers the primary model does not select (imageModel, pdfModel,
  // subagents, channels.modelByChannel, /model switches). Every topology refuses them, so
  // Configuration save, Agent save and deployment give the same message.
  const driver = createKubernetesComputeDriver(options());
  const harnesses = [
    [{ id: "openclaw", version: "1.0.0", mode: "embedded" }, "openai/gpt-5"],
    [{ id: "codex", version: "1.0.0", mode: "dedicated" }, "codex/gpt-5"],
  ] as const;
  const binding = "model credentials come from the Agent's Harness authentication binding";
  // Finding 1208: the refusal names the header, never its value.
  const credentialHeader = (name: string) =>
    `must not set the credential header "${name}" (its name marks a credential): ${binding}`;
  const requestAuth = `must be unset or {mode: "provider-default"}: ${binding}`;
  // Finding 1218: the refusal names the header up to its first invalid character, never past it.
  const invalidName = (name: string) =>
    `must use valid HTTP header names, not ${JSON.stringify(name)}`;
  const provider = (name: string, settings: OpenClawConfigurationDocument) => ({
    models: { providers: { [name]: settings } },
  });
  type Refusal = readonly [
    configuration: OpenClawConfigurationDocument,
    path: string,
    requirement: string,
  ];
  const cases: readonly Refusal[] = [
    [
      provider("p", { request: { headers: { Authorization: "Bearer sk-literal" } } }),
      "models.providers.p.request.headers",
      credentialHeader("Authorization"),
    ],
    [
      provider("p", { request: { headers: { "x-api-key": "${K}" } } }),
      "models.providers.p.request.headers",
      credentialHeader("x-api-key"),
    ],
    [
      provider("p", { models: [{ id: "m", request: { headers: { authorization: "x" } } }] }),
      "models.providers.p.models.0.request.headers",
      credentialHeader("authorization"),
    ],
    [
      provider("p", { request: { auth: { mode: "authorization-bearer", token: "sk-literal" } } }),
      "models.providers.p.request.auth",
      requestAuth,
    ],
    [
      provider("p", {
        request: { auth: { mode: "header", headerName: "x-api-key", value: "${K}" } },
      }),
      "models.providers.p.request.auth",
      requestAuth,
    ],
    [
      provider("p", { request: { auth: { mode: "Authorization-Bearer", token: "x" } } }),
      "models.providers.p.request.auth",
      requestAuth,
    ],
    [provider("p", { request: { auth: null } }), "models.providers.p.request.auth", requestAuth],
    // Finding 1186: a models record would hide its rows' credentials from the walk above, and
    // OpenClaw accepts only a list there.
    ...[{ m: { id: "m", request: { headers: { authorization: "x" } } } }, null, "m"].map(
      (models): Refusal => [
        provider("p", { models }),
        "models.providers.p.models",
        "must be an array of model entries",
      ],
    ),
    [
      provider("p", { request: { auth: { mode: "provider-default", token: "${K}" } } }),
      "models.providers.p.request.auth",
      requestAuth,
    ],
    ...[
      "Proxy-Authorization",
      "x-goog-api-key",
      "x-auth-token",
      "Cookie",
      "apikey",
      "x-portkey-api-key",
      "helicone-auth",
      "ocp-apim-subscription-key",
      "x-amz-security-token",
      "x-client-secret",
      "x-password",
      "x_api_key",
      "api_key",
      "x-rapidapi-key",
      "x-functions-key",
      "x-aws-secret-access-key",
      "x-master-key",
      // Finding 1185: real-world credential headers whose last word is any key, or a
      // credential, passphrase, passcode, signature or bearer word.
      "Authorization",
      "x-api-key",
      "api-key",
      "Private-Token",
      "cf-aig-authorization",
      "CF-Access-Client-Secret",
      "x-litellm-api-key",
      "x-vault-token",
      "X-License-Key",
      "x-access-key",
      "X-Auth-Key",
      "DD-APPLICATION-KEY",
      "X-Private-Key",
      "X-Client-Key",
      "x-app-key",
      "X-Service-Key",
      "X-Account-Key",
      "X-Admin-Key",
      "x-key",
      "Key",
      "X-Signing-Key",
      "x-portkey-virtual-key",
      "X-Credential",
      "X-Credentials",
      "X-Passphrase",
      "X-Passcode",
      "X-Signature",
      "X-Hub-Signature-256",
      "X-Bearer",
      "x-tokens",
      "x-keys",
      // Finding 1189: authentication, JWT, assertion, HMAC, one-time and PIN words, short
      // password words, a license, a version suffix and dot separators. A request or routing
      // key can be a credential, and the WebSocket key is refused like any other key.
      "Authentication",
      "X-Authentication",
      "X-JWT",
      "X-JWT-Assertion",
      "X-Client-Assertion",
      "X-Hmac",
      "X-Otp",
      "X-Pin",
      "X-Pwd",
      "X-Pass",
      "X-License",
      "X-Api-Key-V2",
      "X-Auth-Token-V2",
      "x-signature-v1",
      "x.authorization",
      "x.token",
      "x.secret",
      "x.cookie",
      "X-Request-Key",
      "X-Routing-Key",
      "Sec-WebSocket-Key",
      "x-authorizations",
      "X-Bearers",
      "X-Otps",
      "X-Hmacs",
      // Finding 1196: a trailing algorithm word, a digit glued to a key and the Vercel
      // protection bypass secret.
      "X-Signature-Ed25519",
      "X-HMAC-SHA256",
      "x-signature-sha256",
      "X-Signature-SHA-256",
      "x-hub-signature-sha256-v2",
      "X-Signature-RS256",
      "x-signature-blake2b",
      "x-signature-rsa-sha256",
      "x-api-key2",
      "x-api-keyv2",
      "X-Api-Key2-V3",
      "x-vercel-protection-bypass",
    ].map((name): Refusal => [
      provider("p", { headers: { [name]: "${K}" } }),
      "models.providers.p.headers",
      credentialHeader(name),
    ]),
    // Finding 1251: an invalid first character is named by its code point.
    ...(
      [
        ["authorization ", invalidName("authorization…")],
        [" x-api-key", "must use valid HTTP header names, not one that starts with U+0020"],
        ["Authorization\u200b", invalidName("Authorization…")],
        ["\u0410uthorization", "must use valid HTTP header names, not one that starts with U+0410"],
        ["x api key", invalidName("x…")],
        ["", invalidName("")],
      ] as const
    ).map(([name, requirement]): Refusal => [
      provider("p", { headers: { [name]: "v" } }),
      "models.providers.p.headers",
      requirement,
    ]),
    [
      provider("p", { request: { headers: { "authorization\t": "v" } } }),
      "models.providers.p.request.headers",
      invalidName("authorization…"),
    ],
    [
      provider("p", { headers: { "X-Trace": "t", "Bad Header": "v" } }),
      "models.providers.p.headers",
      invalidName("Bad…"),
    ],
    // A value pasted into the name is never echoed.
    [
      provider("p", { headers: { "Authorization: Bearer sk-fixture-0123456789": "v" } }),
      "models.providers.p.headers",
      invalidName("Authorization…"),
    ],
  ];
  for (const [harness, model] of harnesses) {
    const selected = { agents: { defaults: { model } } };
    for (const [values, path, requirement] of cases) {
      const label = `${harness.id}: ${JSON.stringify(values)}`;
      const message = `Configuration setting ${path} ${requirement}.`;
      // Not selected by agents.*.model: the rule covers every configured provider.
      const configuration = { ...selected, ...values };
      for (const check of [
        () => driver.validateConfiguration(configuration),
        () => driver.validateHarnessAuth(harness, apiKeyAuth, configuration, null),
        () => driver.validateHarnessAuth(harness, apiKeyAuth, configuration),
      ]) {
        assert.throws(check, { name: "ConfigurationHarnessError", message }, label);
      }
    }
  }
  // Finding 1208: a long header name is cut so the message keeps its 256-character cap.
  const longName = `x-${"a".repeat(300)}-token`;
  assert.throws(
    () => driver.validateConfiguration(provider("p", { headers: { [longName]: "${K}" } })),
    (error) =>
      error instanceof ConfigurationHarnessError &&
      error.message.length <= 256 &&
      error.message ===
        `Configuration setting models.providers.p.headers ${credentialHeader(`x-${"a".repeat(37)}…`)}.`,
  );
  // A 40-character name, a credential by its -token suffix, is shown whole.
  const fullName = `x-${"a".repeat(32)}-token`;
  assert.throws(
    () => driver.validateConfiguration(provider("p", { headers: { [fullName]: "${K}" } })),
    {
      name: "ConfigurationHarnessError",
      message: `Configuration setting models.providers.p.headers ${credentialHeader(fullName)}.`,
    },
  );
  // Providers reached only through other selection keys are refused too.
  for (const agents of [
    { defaults: { model: "openai/gpt-5", imageModel: "anthropic/claude-x" } },
    { defaults: { model: "openai/gpt-5", pdfModel: { primary: "anthropic/claude-x" } } },
    { defaults: { model: "openai/gpt-5", subagents: { model: "anthropic/claude-x" } } },
    {
      defaults: { model: "openai/gpt-5" },
      entries: { main: { voiceModel: "anthropic/claude-x" } },
    },
  ]) {
    assert.throws(
      () =>
        driver.validateConfiguration({
          agents,
          ...provider("anthropic", { headers: { "x-api-key": "${K}" } }),
        }),
      {
        name: "ConfigurationHarnessError",
        message: `Configuration setting models.providers.anthropic.headers ${credentialHeader("x-api-key")}.`,
      },
    );
  }
  // Transport headers without a credential, and the provider's own authentication, still save.
  for (const values of [
    provider("p", {
      headers: {
        "X-Custom-Transport": "route",
        "x-api-key-id": "a",
        "x-auth-mode": "b",
        "anthropic-version": "2023-06-01",
        "idempotency-key": "c",
        "x-cache-key": "d",
        "x-stainless-retry-count": "0",
      },
    }),
    // Finding 1185: a key that names no credential (idempotency, cache, a key's id or name),
    // an id after a credential word, and common transport headers.
    ...[
      "Content-Type",
      "Idempotency-Key",
      "X-Idempotency-Key",
      "x_idempotency_key",
      "X-Cache-Key",
      "x-prompt-cache-key",
      "x-api-key-id",
      "x-api-key-name",
      "X-Token-Id",
      "X-Session",
      "OpenAI-Organization",
      "OpenAI-Project",
      "anthropic-beta",
      "X-Request-Id",
      "User-Agent",
      "X-Title",
      "HTTP-Referer",
      "x-stainless-lang",
      "X-Keyword",
      "x-cache-key-2",
      "X-Idempotent-Key",
      // Finding 1189: partition, shard, sort and deduplication keys, and words that only
      // start with a credential word.
      "X-Partition-Key",
      "X-Shard-Key",
      "X-Sort-Key",
      "X-Dedup-Key",
      "X-Deduplication-Key",
      "x-cache-key-v2",
      "X-Passthrough",
      "X-Bypass",
      "X-Pinned-Version",
      "Public-Key-Pins",
      "X-Licensed-To",
      "x-api-key-version",
      "x.trace.id",
      // Finding 1196: an algorithm word after a word that names no credential, a cache key
      // with a glued digit, and a bypass without the protection word.
      "x-amz-content-sha256",
      "X-Signature-Version",
      "x-cache-key2",
      "x-idempotency-key-sha256",
      "x-ed25519",
    ].map((name) => provider("p", { request: { headers: { [name]: "v" } } })),
    provider("p", {
      request: { headers: { "OpenAI-Organization": "org" }, auth: { mode: "provider-default" } },
    }),
    provider("p", { request: { proxy: { mode: "env-proxy" }, allowPrivateNetwork: true } }),
    provider("p", { models: [{ id: "m", headers: { "x-tokens-per-minute": "10" } }] }),
  ]) {
    assert.doesNotThrow(
      () =>
        driver.validateConfiguration({
          agents: { defaults: { model: "openai/gpt-5" } },
          ...values,
        }),
      JSON.stringify(values),
    );
  }
}

export function enforceImmutableImagePolicy() {
  assert.throws(
    () =>
      createKubernetesComputeDriver(
        options({
          images: {
            gateway: "registry.example/gateway:latest",
            agent: "registry.example/agent:latest",
            requireImmutableDigest: true,
          },
        }),
      ),
    SharedConfigurationValidationError,
  );
  // The OCI image specification allows only `sha256` and lowercase hex for SHA-256
  // digests; containerd refuses any other spelling at pull time, so the Driver refuses
  // it at configuration time instead of leaving every Agent Pod failing to pull.
  for (const [description, digest] of [
    ["uppercase hex", `sha256:${"A".repeat(64)}`],
    ["uppercase algorithm", `SHA256:${"a".repeat(64)}`],
  ] as const) {
    for (const role of ["gateway", "agent"]) {
      const images = {
        gateway: `registry.example/gateway@sha256:${"a".repeat(64)}`,
        agent: `registry.example/agent@sha256:${"b".repeat(64)}`,
        requireImmutableDigest: true,
        [role]: `registry.example/${role}@${digest}`,
      };
      assert.throws(
        () => createKubernetesComputeDriver(options({ images })),
        SharedConfigurationValidationError,
        `${role} ${description}`,
      );
    }
  }

  assert.doesNotThrow(() =>
    createKubernetesComputeDriver(
      options({
        images: {
          gateway: `registry.example/gateway@sha256:${"a".repeat(64)}`,
          agent: `registry.example/agent@sha256:${"b".repeat(64)}`,
          requireImmutableDigest: true,
        },
      }),
    ),
  );
}

export function rejectUppercaseImageRepository() {
  const digest = `@sha256:${"a".repeat(64)}`;
  for (const [requireImmutableDigest, suffix] of [
    [true, digest],
    [false, ""],
  ] as const) {
    for (const name of [
      "registry.example/Team/runtime",
      "registry.example:5000/team/Runtime:release_1",
      "Registry.Example/team/Runtime",
      "Runtime",
    ]) {
      for (const role of ["gateway", "agent"]) {
        const images = {
          gateway: `registry.example/gateway${suffix}`,
          agent: `registry.example/agent${suffix}`,
          requireImmutableDigest,
          [role]: `${name}${suffix}`,
        };
        assert.throws(
          () => createKubernetesComputeDriver(options({ images })),
          SharedConfigurationValidationError,
          `${role} ${name}${suffix}`,
        );
      }
    }
    for (const name of [
      "Registry.Example/team/runtime:Release_1",
      "registry.example:5000/runtime:RELEASE",
      "runtime:Release_1",
      "[FD00::1]:5000/team/runtime",
    ]) {
      const images = { gateway: `${name}${suffix}`, agent: `${name}${suffix}` };
      assert.doesNotThrow(
        () =>
          createKubernetesComputeDriver(options({ images: { ...images, requireImmutableDigest } })),
        `${name}${suffix}`,
      );
    }
  }
}

export function validateProjectedServicePrincipalTokens() {
  for (const credentials of [
    { mode: "projectedServiceAccountToken", audience: "", expirationSeconds: 900 },
    { mode: "projectedServiceAccountToken", audience: "occ", expirationSeconds: 599 },
    { mode: "projectedServiceAccountToken", audience: "occ", expirationSeconds: 86_401 },
  ]) {
    assert.throws(
      () => createKubernetesComputeDriver(options({ servicePrincipalCredentials: credentials })),
      SharedConfigurationValidationError,
    );
  }

  assert.doesNotThrow(() =>
    createKubernetesComputeDriver(
      options({
        servicePrincipalCredentials: {
          mode: "projectedServiceAccountToken",
          audience: "openclaw-controller",
          expirationSeconds: 900,
        },
      }),
    ),
  );
}
