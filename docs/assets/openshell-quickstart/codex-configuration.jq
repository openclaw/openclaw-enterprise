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
    # Select the dedicated Codex runtime for this model.
    agents: {
      defaults: {
        model: ("codex/" + $model),
        models: {("codex/" + $model): {agentRuntime: {id: "codex"}}}
      }
    },
    models: {
      providers: {
        codex: {
          api: "openai-responses",
          # Disable direct HTTP inference; the Gateway sends turns over the authenticated WebSocket.
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
              # OpenShell supplies the outer sandbox. Keep the human approval policy enabled.
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
