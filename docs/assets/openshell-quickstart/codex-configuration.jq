# Invoke with jq -n --arg model "$MODEL" -f codex-configuration.jq.
{
  kind: "agent",
  values: {
    gateway: {
      mode: "local",
      bind: "lan",
      auth: {
        password: {source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD"}
      }
    },
    agents: {
      defaults: {
        model: ("codex/" + $model),
        skipBootstrap: true,
        models: {("codex/" + $model): {agentRuntime: {id: "codex"}}}
      }
    },
    models: {
      providers: {
        codex: {
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:9",
          models: [{id: $model, name: $model}]
        }
      }
    },
    tools: {gatewayPolicy: {allow: [], actions: {}}, elevated: {enabled: false}},
    plugins: {
      allow: ["codex"],
      entries: {
        codex: {
          enabled: true,
          config: {
            appServer: {
              mode: "guardian",
              transport: "websocket",
              url: "${APP_SERVER_URL}",
              authToken: "${APP_SERVER_TOKEN}",
              approvalPolicy: "on-request",
              approvalsReviewer: "user",
              sandbox: "danger-full-access"
            }
          }
        }
      }
    }
  }
}
