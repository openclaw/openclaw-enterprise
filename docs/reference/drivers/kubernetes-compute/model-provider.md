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

The static-key template can authorize one private receiver for its HTTPS POST route.

- For a private server, set `privatePeer` to `{"kind":"private_ipv4","address":"10.20.30.40"}`. Use the server’s DNS name in the base URL. DNS must resolve to the approved address, and its TLS certificate must cover that name.
- For a Kubernetes Service, use `{"kind":"kubernetes_service","namespace":"research","name":"inference"}` with `https://inference.research.svc.cluster.local/v1`. The Service owner gives Compute permission to `get` that named Service in the execution cluster. It must be an IPv4 ClusterIP Service with a Pod selector and a numeric TCP target port. Compute saves the Service UID, address, selector and target port with the template version.

Both destinations require a dedicated per-Sandbox OpenShell supervisor, DNS, and an HTTPS certificate trusted by that supervisor. The supervisor must connect to the validated address, including when it uses an upstream proxy. A shared supervisor or a proxy that resolves the hostname again cannot serve this route. For a cluster-local name, install the private issuing CA in the supervisor’s upstream trust store.

The credential owner approves the version. Compute checks the Service again at admission and when preparing and activating the Agent. If a Service is replaced or the mapping changes, save the updated template and register a credential for its new version. Stop the Agent or withdraw the key before transferring the Service name and address. A running supervisor checks the certificate and pinned address on requests. It does not watch the Kubernetes Service UID.

Compute creates an egress NetworkPolicy for the revision’s OpenShell supervisor. For a Service, the policy permits the ClusterIP and Service port, and the selected Pods and target port, so it can apply before or after Kubernetes translates the address. For a private server, the policy permits one `/32` and port. The destination owner still controls ingress. Kubernetes combines the allowances from all policies that select a Pod. Stock OpenShell 0.1.6 maintains an allow-all egress policy for supervisors and suspends the workload if that managed policy changes. On this release, OpenShell checks the approved hostname, resolved address, port and POST route before injecting the key.

An Agent that uses an ordinary private model credential cannot also use a separately protected Git connection. OCC refuses that combination before provisioning. For an ordinary private credential, OpenShell disables automatic Sandbox replacement. Start the replacement through OCC so it verifies the new supervisor before that supervisor can send an authenticated inference request.

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
