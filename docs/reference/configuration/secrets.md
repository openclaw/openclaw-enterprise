# Configuration secrets and channels

Configure credential references and native channels for [Namespace Configuration resources](../configuration.md). Secret values stay in the selected SecretDriver or documented service-account credential path.

## Secret bindings

Use `Configuration.secretBindings` only to map a Namespace-owned OCC Secret to a
selected gateway environment variable. The referenced Secret must already belong
to the same Namespace as the Configuration and deploying Agent. The native
OpenClaw document in `values` then consumes that environment variable with its
normal `env` SecretRef:

```json
{
  "secretBindings": {
    "OPENAI_API_KEY": {
      "source": {
        "kind": "secret",
        "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
        "id": "sec_123e4567-e89b-42d3-a456-426614174000"
      }
    }
  },
  "values": {
    "secrets": {
      "providers": {
        "model": { "source": "env", "allowlist": ["OPENAI_API_KEY"] }
      }
    },
    "models": {
      "providers": {
        "openai": {
          "apiKey": {
            "source": "env",
            "provider": "model",
            "id": "OPENAI_API_KEY"
          }
        }
      }
    }
  }
}
```

Each binding value contains `source.kind: "secret"`, the source
`namespaceId`, the source Secret `id`, and optional `delivery.type: "env"`.
Omitting `delivery` normalizes to `{ "type": "env" }`; no other delivery mode is
implemented. Binding names must be valid environment variable names and cannot
use reserved process-control prefixes such as `OPENCLAW_`, `CODEX_`, `OCC_`,
`KUBERNETES_`, `PATH`, `HOME`, or proxy variables. `OPENAI_API_KEY` is the only
allowed `OPENAI_*` destination.

OCC rejects cross-Namespace references and missing or foreign backend objects
even if IAM would otherwise allow the operation. Creating or updating a
Configuration whose resulting document contains bindings requires the normal
Configuration mutation permission and `operate` on every selected Secret,
including retained bindings when PATCH omits `secretBindings`. Creating or
updating an Agent assignment to a bound Configuration requires the normal Agent
mutation permission and `operate` on each exact Secret. Namespace membership,
Configuration access, Agent access, or possession of a ref does not grant
consumption. Deployment stores normalized references and the selected
SecretDriver identity in the immutable AgentRevision; it does not store backend
locators or value bytes. Secret storage CRUD, update/restart semantics,
Kubernetes Secret RBAC, no-leakage rules, and troubleshooting are owned by the
[Kubernetes Secret Driver](../drivers/kubernetes-secret.md).

## Secret boundaries

ConfigMaps are not secret storage. Provide OpenClaw credentials as canonical
inline SecretRefs plus `secretBindings`, or by using the documented
service-account credential paths. Never place plaintext credential values in a
Configuration `values` document:

```json
{
  "models": {
    "providers": {
      "openai": {
        "apiKey": {
          "source": "env",
          "name": "OPENAI_API_KEY"
        }
      }
    }
  }
}
```

OpenClaw owns SecretRef syntax, provider configuration, and validation. OCC,
ConfigurationDriver, and Kubernetes Compute preserve native `env`, `file`, and
`exec` SecretRefs as unresolved JSON. The selected SecretDriver only stores OCC
Secret values and resolves approved env delivery metadata for the owning
gateway. A Namespace-scoped Secret Broker, CredentialGateway/OpenShell
substitution, value history, and automatic rotation remain unimplemented.

### Native channel configuration

Configure channels directly in the Agent's complete native OpenClaw
Configuration. The Kubernetes Compute Driver currently supports enabled
`slack` and `msteams` providers; unknown enabled providers fail closed.
`channels.defaults` and `channels.modelByChannel` are shared settings, not
providers. Each supported channel declares the gateway-only credential values
it needs:

| Provider  | Gateway Secret keys                     |
| --------- | --------------------------------------- |
| `slack`   | `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN` |
| `msteams` | `MSTEAMS_APP_PASSWORD`                  |

Add a native default Slack account with environment SecretRefs:

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "mode": "socket",
      "appToken": { "source": "env", "provider": "default", "id": "SLACK_APP_TOKEN" },
      "botToken": { "source": "env", "provider": "default", "id": "SLACK_BOT_TOKEN" },
      "dmPolicy": "allowlist",
      "allowFrom": ["U0123456789"],
      "channels": { "C0123456789": { "requireMention": true } }
    }
  }
}
```

Microsoft Teams uses the native `msteams` provider identifier. Its application
and tenant identifiers are ordinary nonsecret configuration strings; only the
application password is an environment SecretRef:

```json
{
  "channels": {
    "msteams": {
      "enabled": true,
      "appId": "00000000-0000-0000-0000-000000000000",
      "tenantId": "11111111-1111-1111-1111-111111111111",
      "appPassword": {
        "source": "env",
        "provider": "default",
        "id": "MSTEAMS_APP_PASSWORD"
      }
    }
  }
}
```

Set the Agent's `executionMode` to `dedicated`; embedded mode is rejected because
its combined gateway/Agent cannot isolate channel credentials. Preserve existing
Codex/model settings and enable each required native channel plugin. Explicitly
redeploy the Agent to snapshot the updated document; its gateway receives the
union of enabled providers' credentials from an Agent-specific Kubernetes
Secret. See
[Kubernetes runtime credentials](../drivers/kubernetes-compute.md#configuration).

Teams message ingress requires a separately deployed and reviewed public Bot
Framework `/api/messages` webhook. Enterprise does not provide that webhook;
end-to-end Teams behavior remains unverified. See [Slack testing](../../testing/slack.md)
for channel integration coverage.
