# Credential sources

A CredentialSource is a Namespace resource. The selected TokenService maintains
Sources for static credentials, OAuth grants, and finite GitHub installation
tokens. A Source can reference a Connection Template. The Source API exposes
metadata and controls access to the Source. Ordinary credential-free metadata
reads use separate Sandbox network access and return the upstream response; they
do not need a Source. The older [protected metadata Source](credential-sources/protected-repository-metadata.md)
is deprecated and retired from Credential Design 1.0, pending code removal.
[Runtime Secret placement](drivers/kubernetes-compute/storage-and-credentials.md#runtime-credentials)
covers Channel and Gateway Secret delivery. An authorized caller can also select a ready static OCC-owned Source for a dedicated Kubernetes Gateway through [Configuration secret bindings](configuration/secrets.md#secret-bindings), independently of any Proxy binding.

<a id="intended-credential-flow"></a>

## How Agent credentials work

1. Select a model Source, a Source in a Plugin connection, or GitHub repositories for the Agent. The selection grants no access by itself.
2. OCC checks exact Source and repository permissions. It applies the Installation's network ceiling and matches the requested operations against a provider preset or the Source's Connection Template.
3. OCC saves the bindings and their policy in the Agent revision. The Sandbox enforces the network policy, and Credential Proxy injects credentials only for permitted requests. The Harness uses placeholders.
4. TokenService commits credential replacements. With OCC custody, Proxy updates existing delivery copies. With OpenShell custody, it checks the updated authoritative Provider. A failed delivery can be retried.

See [Credential Design 1.0](../../specs/rfcs/20261124-credential-design-1-0/index.md)
for the design and [Source lifecycle](../flows/credential-source-lifecycle.md)
for implementation details.

## Implementation status

| Path                   | Support and limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Managed model Source   | Dedicated OpenClaw and Codex support static OpenAI Responses credentials. OCC derives exact first-deployment requests when the Installation allows the stock runtime executable. Dedicated Codex also accepts a built-in device-login Source or a static Codex PAT. [Native model requests](credential-sources/managed-static.md#native-model-requests)                                                                                                                                             |
| Console and Agent API  | Credentials creates static or Template OAuth Sources and starts Codex login. Agent drafts reuse or switch compatible ready model Sources. See [Console Agent creation](console/create-and-deploy.md#create-an-agent). The Agent API requires the model Source in both `harnessAuth` and `credentialSources`; deploy the saved draft. Guided creation with a managed Source returns `409`.                                                                                                           |
| Native Git             | Native OpenShell Git supports Dedicated Codex. TokenService maintains a finite installation token for a Namespace Source. The Source uses an Installation or same-Namespace GitHub App Client. Each Agent gets its own admitted Repository policy. [Repository credentials](repository-credentials.md)                                                                                                                                                                                              |
| Plugin Sources         | OCC admits Template-backed OAuth and static MCP selections and freezes their Template policy. PluginDriver filters discovered tools to deployable selections. A live Slack OAuth Agent tool and an unselected-tool denial were verified in [#4673](https://github.com/openclaw/openclaw-enterprise/pull/4673). Live Google OAuth and static Slack execution remain unverified.                                                                                                                      |
| Custody and delivery   | OCC TokenService stores private material; Proxy owns delivery copies. The [OpenShell custody preview](credential-sources/managed-static.md#preview-openshell-custody) attaches authoritative Providers for static Bearer Sources, including generic keys and PATs, with one binding per Source per Sandbox. It does not support OAuth or GitHub App Sources. Stop and withdrawal detach Providers; Source deletion removes them. Use Stop before replacing an active managed-credential deployment. |
| Refresh and withdrawal | OCC custody updates delivery copies and checks serving receipts. For OpenShell custody, manual push verifies Provider metadata; verify the running Sandbox separately. Before renewal is due, Git maintenance retries recorded pending delivery with the committed version. See [retry](#retry-credential-delivery) and [withdrawal](credential-sources/withdrawal.md).                                                                                                                             |

OpenShell may inject a credential into a matching plaintext HTTP request on port 443. Executable rules include descendant processes. Substitution is not restricted
to exact Bearer presentation. Sandbox attach, detach, and activation address the
Sandbox by name. See [Credential Proxy](drivers/credential-proxy.md) for admission
and enforcement limits.

Live verification at `a009380c` covered Dedicated Codex OAuth and Git rotation in one
Agent, plus Git read, push, withdrawal and direct TCP denial. A fresh combined
deployment on the merged code and a genuine Codex PAT turn remain unverified. [Cutover verification](https://github.com/openclaw/openclaw-enterprise/pull/7224)

### Codex account model requests

Without a matching Agent grant, OCC adds the exact requests below when the
Installation ceiling allows one stock Codex executable. The built-in Codex
account Source permits only that executable and `chatgpt.com:443`:

- `POST /backend-api/codex/responses`
- `GET /backend-api/wham/accounts/check`
- `GET /backend-api/wham/config/bundle`

Alternate workspace origins are refused. The OpenShell HTTPS substitution limit
above applies to these matches.

## Register a source

For example, register an OpenAI API key as a managed static Source with `POST /namespaces/:namespaceId/credential-sources`:

```json
{
  "name": "Model access",
  "type": "static",
  "config": { "provider_preset": "openai" },
  "secret": "<credential>"
}
```

The caller needs `credential_source:create` on a ready Namespace. The response contains the Source ID and metadata, never the credential. See [managed static sources](credential-sources/managed-static.md) for the complete API and first-deployment example. To create a Template-backed OAuth Source, start the separate [browser consent workflow](connection-templates.md#connect-an-account). TokenService creates that Source only after the provider returns a grant. The built-in Codex OAuth choice uses Agent device login and requires both Namespace Agent `create` and Credential Source `create`.

## Read and list sources

Exact GET requires `credential_source:read` and returns all nonsecret metadata for that Source, even when TokenService cannot report refresh status. List requires Namespace `read` and includes only Sources the caller may read. A Source's saved `ready` state does not establish whether a particular deployment can use it.

OCC uses the recorded TokenService instance for Source status, replacement, refresh, and deletion.

An associated Source reports `connectionTemplateId`. For Template-based OAuth, `OAuthCredentialSource.consent` records the original Template version, OAuth client, principal and scopes. A successful Codex device login creates a `builtin_codex` Source with trusted account metadata and the fixed issuer/client preset. It needs no Template. Both kinds expose only nonsecret metadata.

## Bind a source to an Agent

For model authentication, specify the same Source in `credentialSources` and `harnessAuth`.

```json
{
  "credentialSources": [{ "sourceId": "cs_..." }],
  "harnessAuth": { "method": "credential_source", "sourceId": "cs_..." }
}
```

For a Plugin, select the Source once in its credential slot. OCC includes it in admission without a separate `credentialSources` entry. A Plugin Source must reference a Connection Template. A Source used only by the Harness can omit the Template.

OCC looks up only the Source-associated Template ID and resolves its approved version when it checks a selection and again at deployment. OAuth consent retains its separate original version and client. For an HTTP Plugin, a credential-bearing request must match a reviewed Plugin operation and a destination in that Template version. A manual OAuth Template can authorize a new destination for an existing Source. The grant still uses its original issuer and client and the scopes granted by the provider. An issuer change requires new consent. Each Agent revision records the admitted Template ID and version and keeps its executable, permitted requests and credential projection when the Template changes.

The caller needs the corresponding Agent permission and `credential_source:operate` on each affected Source. Deployment requires both the caller and the Agent service principal to have `credential_source:operate` on each Source. With OCC-managed transactional Native IAM, deployment can create a missing exact Agent grant when the caller may operate the Source. Otherwise, grant the Agent access with a [Namespace Role and AccessBinding](authorization.md#manage-namespace-policy). Saving an eligible Plugin selection under Native IAM grants the Agent service principal exact Source `operate` access in the same transaction.

OCC qualifies the complete policy against the selected OpenShell Sandbox and Credential Proxy before it saves a revision or queues work. See [implementation status](#implementation-status) for supported and verified Plugin paths. The static HTTP policy limits credential injection by endpoint, method, and path. The provider enforces the credential’s permissions. See the [Proxy Driver reference](drivers/credential-proxy.md) for the accepted MCP limits.

## Use a Codex PAT Source

Bind a static `codex-pat` Source for model access. First deployment can use the
[seven fixed PAT requests](credential-sources/managed-static.md#codex-pat) allowed
by the Installation. That reference also describes the temporary transport exception.
For hosted Apps, [enroll the PAT](../guides/deploy/credential-lifecycle.md#enroll-a-codex-pat-source)
and grant the caller Source operate access. The Codex Plugin Driver verifies the account with the issuer. This covers Codex hosted Apps, which use their own catalog.

## Update a source

Send PATCH with `credential_source:update`. [Managed static updates](credential-sources/managed-static.md#update-a-source) replace the write-only credential or change its provider association. TokenService renews OAuth grants with the original consent settings. Current delivery-update limitations are in [implementation status](#implementation-status).

## Request renewal

Send `POST /namespaces/:namespaceId/credential-sources/:credentialSourceId/rotate` with `credential_source:update` on the exact Source. The selected TokenService renews a ready OAuth or GitHub App installation credential, commits the replacement, and pushes it through Credential Proxy. Use `PATCH` to replace a static credential.

## Retry credential delivery

Send `POST /namespaces/:namespaceId/agents/:agentId/credentials/push` with `{"sources":"all"}` or a `sources` array of 1–64 distinct Source IDs. OCC selects Credential Proxy bindings from the deployed Agent revision and excludes a binding as soon as OCC records its withdrawal. The caller needs `agent:operate` on that exact Agent and `credential_source:update` on every selected Source. The Agent service principal must still have `credential_source:operate` on each Source. OCC rejects the whole request if any selected Source is ineligible or unauthorized, before it notifies Proxy or resolves a credential.

If the Agent service principal has lost Source access, ask an Installation administrator to restore its `credential_source:operate` grant, then retry credential delivery.

The response has one result per selected Source: `succeeded`, `resolution_failed`, or `delivery_failed`. Backend failures appear in these results with HTTP `200`; they do not hide successful results or roll back the credential held by TokenService. Retry does not replace the Source credential. In the native OpenShell preview, `succeeded` confirms Provider metadata; it does not prove that a running Harness used the replacement. A retry for a shared Source can affect other Agents bound to it. See the [OCC custody lifecycle flow](../flows/credential-source-lifecycle.md#retry-delivery) for execution.

## Withdraw a source from an Agent

Withdrawal removes an Agent's access without deleting the Source. See [withdrawal](credential-sources/withdrawal.md) and [implementation status](#implementation-status).

## Delete a source

Use `DELETE /namespaces/:namespaceId/credential-sources/:credentialSourceId` to retire a Source. With OCC custody, Proxy retires delivery copies before TokenService removes the credential. A Proxy failure returns `503` and retains the Source and credential for retry. With OpenShell custody, TokenService deletes the authoritative Provider and profile.

Static deletion requires `credential_source:delete`. An OAuth owner can disconnect with exact Source read and operate permissions. Other callers need `credential_source:delete`. A blocking reference, including a Configuration Gateway binding or saved Plugin selection, returns `409` before OCC changes the Source or records OAuth revocation. Clear the saved selection and, for a deployed binding, use the authorized Agent withdrawal and remove the remaining references. The Worker can retry pending OAuth retirement after a Proxy failure. See [managed static deletion](credential-sources/managed-static.md#delete-a-source) and [OAuth consent](connection-templates.md#connect-an-account).

## Errors

See the operation-specific [managed static reference](credential-sources/managed-static.md) and [OAuth consent reference](connection-templates.md#connect-an-account).

## Related

- [Credential source lifecycle flow](../flows/credential-source-lifecycle.md)
- [Connection Templates](connection-templates.md)
- [Credential Proxy](drivers/credential-proxy.md)
