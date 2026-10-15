export function createHarnessConfiguration(harnessId, providerModel) {
  const modelReference = `${harnessId === "codex" ? "codex" : "openai"}/${providerModel}`;
  const reasoning = !/^gpt-4(?:o(?:-mini)?|\.1)(?:-|$)/u.test(providerModel);
  const provider =
    harnessId === "codex"
      ? {
          codex: {
            baseUrl: "http://127.0.0.1:9",
            api: "openai-responses",
            models: [{ id: providerModel, name: providerModel }],
          },
        }
      : {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            models: [
              {
                id: providerModel,
                name: providerModel,
                contextWindow: 128000,
                maxTokens: 8192,
                reasoning,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        };

  return {
    gateway: {
      mode: "local",
      bind: "lan",
      controlUi: { enabled: false },
      auth: {
        password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
      },
      http: { endpoints: { chatCompletions: { enabled: true } } },
    },
    agents: {
      defaults: {
        model: modelReference,
        models: { [modelReference]: { agentRuntime: { id: harnessId } } },
      },
    },
    models: { providers: provider },
    ...(harnessId === "codex"
      ? {
          // Codex model transport must use its authenticated app server, never direct HTTP.
          plugins: {
            allow: ["codex"],
            entries: {
              codex: {
                enabled: true,
                config: {
                  appServer: {
                    mode: "guardian",
                    approvalPolicy: "on-request",
                    sandbox: "read-only",
                    transport: "websocket",
                    url: "${APP_SERVER_URL}",
                    authToken: "${APP_SERVER_TOKEN}",
                  },
                },
              },
            },
          },
        }
      : {}),
  };
}

// For an image that stubs OpenClaw: names a provider endpoint that is not the
// real one, so the runtime's upfront credential check never sends a fixture key
// to the provider (it runs only against the default endpoint).
export function withStubbedProviderEndpoint(configuration) {
  const openai = configuration.models?.providers?.openai ?? { api: "openai-responses", models: [] };
  return {
    ...configuration,
    models: {
      ...configuration.models,
      providers: {
        ...configuration.models?.providers,
        openai: { ...openai, baseUrl: "https://model.stub.invalid/v1" },
      },
    },
  };
}
