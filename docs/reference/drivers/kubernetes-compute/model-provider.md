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
requested overrides. First-deployment identity includes normalized overrides;
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
port zero, and ambiguous IPv4 spellings. Gateway-backed sources require exact DNS
hostnames. Dedicated native OpenClaw retains its HTTPS port 443 restriction.
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
