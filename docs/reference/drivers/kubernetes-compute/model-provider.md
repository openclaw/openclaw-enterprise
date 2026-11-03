# Configure a shared model provider

Set `drivers.compute.configuration.runtime.modelProvider` in the Installation
to select an OpenAI-compatible endpoint for Codex and OpenClaw:

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
Custom OpenAI URLs in Agent Configuration require a matching shared provider.
Source-backed OpenAI credentials
authorize the default `https://api.openai.com/v1` endpoint unless explicitly
authorized for the configured custom endpoint.

## Harness behavior

Codex receives the endpoint in its generated provider configuration. Its Gateway
keeps the fail-closed HTTP transport URL and uses authenticated app-server
transport. Source authorization never overrides the inference endpoint.

Embedded and dedicated native OpenClaw receive the shared API adapter and URL.
Compute translates the native default OpenAI URL in model metadata to the selected
endpoint. A different custom URL or conflicting API adapter is rejected. Dedicated
native OpenClaw still requires complete model metadata and a Credential Source
for custom endpoints; direct Secret-backed keys remain restricted to OpenAI's
default endpoint.

New deployments record the selected provider in Compute admission. Changing or
removing it does not redirect an existing deployment: preparation and activation
fail until a new Agent revision is deployed. This also applies to changes in the
standalone-search declaration.

## Credential destination authorization

An `openai` Credential Source supplies an `api_key` Secret reference.
Its immutable `config.authorized_base_url` permits one destination and must
match the Installation's shared provider. Omitting that field authorizes only
the default OpenAI endpoint. Registering a custom authorization still requires
the existing create-source and operate-Secret permissions.

Registration, attachment, and protected dispatch reject destination mismatches.
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
