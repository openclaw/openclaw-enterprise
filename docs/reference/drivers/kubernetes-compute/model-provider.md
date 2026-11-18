# Configure model providers for Agent revisions

Set `drivers.compute.configuration.runtime.modelProvider` in the Installation
to set the default OpenAI-compatible endpoint for new Codex and OpenClaw revisions:

```yaml
modelProvider:
  protocol: openai-responses
  baseUrl: https://models.example.com/v1
```

Compute translates this object into each Harness's native configuration.
Model IDs and OpenClaw model metadata remain in the Agent's Configuration.
The setting applies to OpenAI API-key authentication, including source-backed
keys. Other providers and ChatGPT account authentication keep their existing paths.

| Field                         | Requirement                         | Behavior                                                                         |
| ----------------------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| `protocol`                    | Required when the object is present | `openai-responses` or `openai-completions`. Codex requires Responses.            |
| `baseUrl`                     | Required when the object is present | HTTPS endpoint ending in `/v1`, optionally after a prefix such as `/api`.        |
| `supportsStandaloneWebSearch` | Optional boolean                    | Defaults to `false`; declares the endpoint's Codex standalone-search capability. |

Omitting the object uses OpenAI's default endpoint and native API defaults.
Custom OpenAI URLs in Agent Configuration must match the resolved revision provider.
Source-backed OpenAI credentials
authorize the default `https://api.openai.com/v1` endpoint unless explicitly
authorized for the configured custom endpoint.

## Harness behavior

Codex receives the endpoint in its generated provider configuration. Its Gateway
keeps the fail-closed HTTP transport URL and uses authenticated app-server
transport. Source authorization never overrides the inference endpoint.

Embedded and dedicated native OpenClaw receive the shared API adapter and URL.
Compute translates the native default OpenAI URL in model metadata to the selected
endpoint. It checks every embedded model row and every row rendered for dedicated
native OpenClaw. A different custom URL or API adapter is rejected. Dedicated
native OpenClaw still requires complete model metadata and a Credential Source
for custom endpoints; direct Secret-backed keys remain restricted to OpenAI's
default endpoint.

New deployments save requested overrides in `harness.overrides` and resolved
settings in `harness.configuration`. Compute fingerprints the saved provider.
Preparation, activation, probes, retry, and recovery use that snapshot. Changing
or removing the Installation default affects future admissions only. Missing,
malformed, or unsupported saved settings refuse execution before credential delivery
or workload changes. An unavailable endpoint does not cause fallback to a default.
Stop the Agent or withdraw its credential authorization to revoke access; changing
a default is not revocation.

## Deploy with a named provider

When editing a provider through the API, send its last `settingsFingerprint` as
`expectedSettingsFingerprint`. If another administrator changed the settings,
read the provider again and review the changes before retrying.

Set `modelProviderId` on the Agent and select the model in Agent Configuration.
Use the ID of a Namespace credential created from the provider's static-key
Connection Template in `harnessAuth` and `credentialSources`. Deploy without
`harnessOverrides`. Admission refuses a credential approved for a different
template, destination or API format, even if the Secret is the same.

Dedicated Codex accepts Responses. Dedicated OpenClaw also accepts Chat
Completions and requires context and output limits and costs for each selected
model. The revision saves the provider ID, resolved Harness settings, and the
selected rows from the provider catalog. Updating that catalog affects future
admissions. Existing revisions keep their saved values.

### Private endpoints

Set the inference base URL to the endpoint's HTTPS hostname or canonical private IPv4 address. For an in-cluster Kubernetes Service, use its full `<service>.<namespace>.svc.cluster.local` DNS name, such as `https://inference.research.svc.cluster.local/v1`. The Connection Template authorizes the host, port, method and path; it does not store a separate private network target or Service identity.

At deployment, Kubernetes Compute resolves the approved host and permits the required private addresses and port. For a Service DNS name, Compute reads the named Service and permits both its ClusterIP and its selected backend Pods, with their respective ports. The Service owner must grant Compute permission to read that Service. The endpoint owner controls ingress, DNS and TLS trust. A hostname must present a certificate valid for that hostname; an IPv4 endpoint needs a certificate valid for its IP address.

Aliases for a Service and custom cluster DNS suffixes are not supported. A NetworkPolicy that permits only the resolved ClusterIP can block traffic after Kubernetes translates the address to a backend Pod.

A changed DNS answer or Service backend does not change the credential's approved HTTP destination. Redeploy the Agent to refresh network reachability after an address or Service backend changes. Changing the destination URL or protocol requires a new Connection Template version and credential approval.

## Deployment overrides

Ordinary and first-deployment requests accept optional `harnessOverrides`:

```json
{
  "harnessOverrides": {
    "modelProvider": {
      "protocol": "openai-responses",
      "baseUrl": "https://evaluation.example.com/v1"
    }
  }
}
```

The provider replaces the whole default object. Require `protocol` and `baseUrl`
together; omitted `supportsStandaloneWebSearch` means `false`. Omitted or empty
overrides inherit the current default. `null`, unknown fields, invalid values,
unsupported Harnesses, and Codex with Completions are refused.

Explicit provider overrides require source-backed OpenAI API-key authentication.
Direct Secret authentication uses Installation defaults. ChatGPT authentication
and unrelated providers do not accept this override. Existing topology limits
still apply: the bundled OpenShell source path requires a dedicated Harness.

An ordinary deployment without overrides uses current defaults. Console and CLI
submit overrides directly to admission; retaining previous requested overrides
submits them explicitly. Console labels the requested URL or inherited default;
the admitted revision records the resolved destination. Automated image upgrades submit the selected baseline revision's
requested overrides. A new revision of an Agent with a named provider reads the current provider and credential grant. Retrying an existing revision uses its snapshot. First-deployment identity includes normalized overrides;
receipt recovery must include the same values. See [Agent revisions](../../../guides/topics/agent-revisions.md).

## Credential destination authorization

An `openai` Credential Source supplies an `api_key` Secret reference.
Its immutable `config.authorized_base_url` permits one destination. Registration
can authorize a destination different from the Installation default. Deployment,
attachment, and protected dispatch require it to match the resolved revision provider. Omitting that field authorizes only
the default OpenAI endpoint. Registering a custom authorization still requires
the existing create-source and operate-Secret permissions.

Attachment, protected dispatch, and refresh reject destination mismatches.
Changing the Installation endpoint cannot expand an existing source's grant.
See [Credential Sources](../../credential-sources.md) for operations and permissions.

## Validation and recovery

URLs reject credentials, `@`, wildcards, whitespace, controls, queries, fragments,
port zero, and ambiguous IPv4 spellings. Named providers accept exact DNS hostnames and canonical private IPv4 addresses. Dedicated native OpenClaw retains its HTTPS port 443 restriction.
Existing [egress policies](networking-and-isolation.md) remain in force; endpoint
configuration or authorization does not grant network access.

The removed `runtime.codexModelBaseUrl` and
`runtime.codexModelSupportsStandaloneWebSearch` settings fail validation. Replace
them with the shared object and its capability field.

New source requests reject `config.base_url`. Stored sources containing that
field cannot be attached or refreshed, even when its value matches the new
endpoint. Existing Gateway copies retain their original destination until withdrawn. Register an explicitly authorized replacement, update the Agent's
source binding, and deploy a new Agent revision. Existing read and delete
operations retain their normal permissions and reference checks.
