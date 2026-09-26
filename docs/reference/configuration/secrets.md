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
    "SLACK_BOT_TOKEN": {
      "source": {
        "kind": "secret",
        "namespaceId": "ns_123e4567-e89b-42d3-a456-426614174000",
        "id": "sec_123e4567-e89b-42d3-a456-426614174000"
      }
    }
  }
}
```

For example, native Slack configuration consumes `SLACK_BOT_TOKEN` with
`{ "source": "env", "provider": "default", "id": "SLACK_BOT_TOKEN" }`.
Supply model authentication through [Agent harnessAuth](../agents.md#harness-authentication),
not a Configuration binding.

Each binding value contains `source.kind: "secret"`, the source
`namespaceId`, the source Secret `id`, and optional `delivery.type: "env"`.
Omitting `delivery` normalizes to `{ "type": "env" }`; no other delivery mode is
implemented. Binding names must be valid environment variable names and cannot
use reserved process-control prefixes such as `OPENCLAW_`, `CODEX_`, `OCC_`,
`KUBERNETES_`, `OPENAI_`, `PATH`, `HOME`, or proxy variables. Model
authentication destinations are reserved for `harnessAuth`.

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

ConfigMaps are not secret storage. Use canonical inline SecretRefs and
`secretBindings` for gateway credentials. Use Agent `harnessAuth` for model
credentials. Never put plaintext values in Configuration `values`.

The Kubernetes and filesystem Configuration Drivers reject literal model API
keys, credential headers, and model credential environment values in their
known native fields before storage. Unresolved references remain valid
Configuration data; deployment separately rejects model credential selectors
that compete with the Agent's binding.

OpenClaw owns SecretRef syntax, provider configuration, and validation. OCC,
ConfigurationDriver, and Kubernetes Compute preserve native `env`, `file`, and
`exec` SecretRefs as unresolved JSON. The selected SecretDriver only stores OCC
Secret values and resolves approved env delivery metadata for the owning
gateway. A Namespace-scoped Secret Broker, CredentialGateway/OpenShell
substitution, value history, and automatic rotation remain unimplemented.

### Native channel configuration

Configure channels directly in the Agent's complete native OpenClaw
Configuration. Slack is the channel with live Enterprise integration coverage.
The Kubernetes Compute Driver recognizes enabled `slack` and `msteams`
configuration shapes; unknown enabled providers fail closed. Teams requires
operator-provided ingress and remains unverified end to end.
`channels.defaults` and `channels.modelByChannel` are shared settings, not
providers. The recognized native channel configurations consume these
gateway-only credential values:

| Provider  | Gateway Secret keys                     |
| --------- | --------------------------------------- |
| `slack`   | `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN` |
| `msteams` | `MSTEAMS_APP_PASSWORD`                  |

Every environment SecretRef used by an enabled native channel must have a
matching `secretBindings` entry before deployment admission. Disabled channel
provider blocks do not require bindings.

Add a native default Slack account with environment SecretRefs:

```json
{
  "channels": {
    "slack": {
      "enabled": true,
      "mode": "socket",
      "replyToModeByChatType": { "channel": "all" },
      "appToken": { "source": "env", "provider": "default", "id": "SLACK_APP_TOKEN" },
      "botToken": { "source": "env", "provider": "default", "id": "SLACK_BOT_TOKEN" },
      "dmPolicy": "allowlist",
      "allowFrom": ["U0123456789"],
      "channels": { "C0123456789": { "requireMention": true } }
    }
  }
}
```

The console's new Slack setup and bundled Slack Presets set
`channels.slack.replyToModeByChatType.channel: "all"`, which threads channel
replies without changing DM or group-DM reply behavior. Existing Slack blocks
keep their saved settings, including omissions and overrides. To disable the
channel default, set `replyToModeByChatType.channel: "off"` in native
Configuration JSON; per-channel overrides still take precedence. The API stores
the supplied native document unchanged, so API clients should include the
chat-type setting shown above. Save and redeploy to apply a change.

The console exposes **Direct-message policy** and **Allowed DM user IDs**
separately from channel access. New setup selects `allowlist` and requires sender
IDs before saving; choose `disabled` for channel-only access. `pairing` admits
approved senders, with optional preapproved IDs. Selecting `open` writes
`allowFrom: ["*"]`; switching to Allowlist or Pairing clears that wildcard in
the editor. Disabled preserves the saved sender list for later use. Existing
omitted policies remain omitted until explicitly selected. Organization-wide
installs support Disabled or Open when DMs are enabled; Disabled is recommended.
The editor preserves `enterpriseOrgInstall` and `dm.enabled`; a native
`dm.enabled: false` continues to block DMs regardless of the selected policy.

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

For Slack setup, set the Agent's `executionMode` to `dedicated`; embedded mode
is rejected because its combined gateway/Agent cannot isolate channel
credentials. Preserve existing Codex/model settings and enable the native Slack
plugin. Explicitly redeploy the Agent to snapshot the updated document. Store
each channel value as a Namespace Secret and bind its exact reference to the
native environment destination with `secretBindings`. Grant the consuming
Agent's returned `servicePrincipalId` access through the
[Namespace IAM APIs](../authorization.md#manage-namespace-policy). Only its
dedicated gateway receives these admitted bindings; generated runtime
credentials contain no channel tokens. See
[Kubernetes credential ownership](../drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials).

Teams message ingress requires a separately deployed and reviewed public Bot
Framework `/api/messages` webhook. Enterprise does not provide that webhook;
end-to-end Teams behavior remains unverified. See [Slack testing](../../testing/slack.md)
for channel integration coverage.
