# PluginDriver contract

## Overview

`PluginDriver` supplies a curated catalog, policy capabilities, and policy
validation for an Agent Harness. OpenClaw Control Plane (OCC) owns Agent
selections, authorization, and immutable revisions.
Compute owns native installation, runtime connections, readiness, activation,
and retirement. Bundled startup code also translates selected policy into native
configuration; those helpers are not methods on the exported Driver interface.

An Installation can select at most one bundled Plugin Driver. The default is no
Driver, which permits plugin-free deployments. External Plugin Driver packages
are not selectable. See [Driver selection](selection.md) and the
[Agent plugin reference](../agent-plugins.md).

## Interface

### Selection and catalogs

The [shared interface](../../../packages/contracts/src/index.ts) exposes:

- `policyCapabilities`: supported default/tool enablement, approval modes, and
  reviewer arrays per scope, plus the JSON Schema for `driverPolicy` fields.
  An empty reviewer array means explicit selection is unsupported at that scope.
- `validatePolicies(selections)`: validate requested policy without installation
  or authenticated discovery. OCC calls this before save and deployment admission.
- `listCatalog(context)`: read the catalog for a Namespace, Agent, Harness,
  native Configuration, and abort signal.

Catalog entries contain `id`, `name`, and `tools`. `tools:null` means unknown;
`tools:[]` means the observed inventory was empty for that read. Each tool has
an opaque `id`, `name`, and `ownerId`. Description, availability, and safe
unavailability reasons are optional metadata; `destructive` and `writes`
annotations are also optional. Missing classifications mean unknown. A Driver can set
`selectableWithoutTools` when selection is allowed despite an unknown inventory.
An entry does not grant access, select a plugin, or prove the policy can run.

Optional `logoUrl` supplies a public HTTPS presentation image. Bundled Codex reads
`release.interface.logo_url`, then `composer_icon_url`; missing or invalid URLs
are omitted. Console loads these images without PAT/account headers or referrers,
and shows initials if an image fails. URLs may expire and are never copied into
Agent selections. Console CSP permits HTTPS images while retaining same-origin
scripts and connections.

Optional `websiteUrl`, `privacyPolicyUrl`, and `termsOfServiceUrl` provide public
HTTPS links in plugin details. An unavailable entry can include `unavailableHelp`
as `{label, url}`. Discovery pages can include `setup: {message, links}`, where
each link has the same shape. The selected Driver owns these explanations and
destinations; Console renders them without vendor-specific setup logic. This
metadata never enters Agent selections and does not verify app connections,
grant access, or configure credentials. Connection verification and deployment
gates are not part of this metadata contract.

Authorized `GET /installation` exposes the selected Driver's identity and policy
capabilities. See the [capability response](../agent-plugins.md#discover-policy-controls).

There is no exported install, enable, policy-translation, or preparation method.
The optional _backend reader_ in bundled Codex is different from the required
`listCatalog` method: without that reader, an explicit catalog call fails, but
saving Agent selections and deploying supported selections can still use the
Agent runtime's discovery path.

Two optional methods serve pre-Agent discovery: `discoverCatalog({accessToken?,
cursor?, q?}, signal?)` returns `{plugins, nextCursor, setup?}`, and
`getCatalogPlugin({accessToken?, pluginId}, signal?)` returns plugin details. Here
`pluginId` is the opaque `remoteId` from a discovery entry; the entry's `id` is
the stable selection key. The HTTP routes are `POST /namespaces/:namespaceId/agents/plugins`
and its `/details` child. The selected Driver reports `pluginDiscovery.credential`
in Installation capabilities as `required` or `none`. When required, supply
exactly one credential source: `accessToken`, or `secretRef` with the standard
`{kind, namespaceId, id}` Secret reference. When none is required, omit both.
For details also provide `pluginId`; for discovery you can provide `q` (up to
1,024 characters) and `cursor`. The Driver searches the complete catalog; an
empty query lists it. Keep the same query while paging and omit the cursor when
changing the query.
Both routes require Agent `create` in the Namespace. A Secret reference must
belong to that Namespace and additionally requires caller `operate` on the exact
Secret. OCC reads the current value through the selected SecretDriver and passes
it to the PluginDriver in server memory. The bundled Codex Driver derives the
account ID from that PAT; clients do not provide an account ID. A Secret reference
to another Namespace returns `400 INVALID_REQUEST`. A deleted Secret or backend
ownership mismatch returns `404`, a denied grant returns
`403`, and an unavailable backend returns a safe dependency error. A rejected PAT returns
`PLUGIN_DISCOVERY_CREDENTIALS_REJECTED`; rotate the Secret and retry.

Discovery performs no platform writes and returns `Cache-Control: no-store`.
Credential values do not appear in catalog responses or audit events; responses
that echo a credential are rejected. A missing PluginDriver method reports
unsupported discovery, and a SecretDriver without transient value use cannot
serve Secret-backed requests. These methods do not require an existing Agent,
plugin installation, or runtime connection.
See [bundled selection and catalog setup](plugin-bundled.md#selection-and-catalogs).

## IAM

OCC authorizes the exact Agent operation. Reading or changing Agent selections
does not grant provider access, plugin permissions, or approval to perform a
plugin action. Plugin approval settings are separate from platform IAM, workload
isolation, and the external provider's authentication. Runtime credentials use
the existing Harness and ServiceAccount path; never put credential values or
native command output in startup diagnostics. The Driver supplies no sandbox,
egress grant, filesystem grant, approval service, OAuth interface, or IAM hook.
See [Agent plugin permissions](../agent-plugins.md) and [authorization](../authorization.md).

## Lifecycle

### Preparation and security

Trusted startup creates the selected bundled Driver and validates its configuration.
The shared interface has no startup, shutdown, or uninstall operation. Saving an
Agent's requested plugin map validates supported policy, but does not perform
authenticated catalog discovery; saved entries remain readable even if the original Driver is unavailable. A revision with
nonempty selections records the selected Driver's ID and implementation and the
requested IDs and policies, not credential values or native release metadata.

At runtime, Compute and the bundled preparation helpers resolve current native
metadata, translate supported policy, and apply it to the specific revision
before declaring readiness. Nonempty selections cannot start with a missing,
changed, or Harness-incompatible Driver. An unsupported policy or unsafe native
configuration prevents startup or leaves the revision unready. Retries reuse the
requested IDs and policy; they may resolve a newer curated release at that later
startup. Saving a selection is not evidence that it can start.

Only two recognized native outcomes can become optional plugin warnings:
`PLUGIN_INSTALL_FAILED` and `PLUGIN_AUTH_REQUIRED`, attributed to the requested
`pluginId`. They contain no native output or credentials. Other discovery,
configuration, policy, transport, cancellation, or malformed-response errors
remain startup failures. See [bundled preparation and security](plugin-bundled.md#preparation-and-security)
and [Compute startup warnings](compute.md#plugin-startup-warnings).

## Limits

### Native mappings and limits

- A catalog entry does not guarantee that its policy can be enforced by a given
  Harness. The current bundles reject policy they cannot represent; see the
  [native support table](plugin-bundled.md#native-mappings-and-limits).
- Callers cannot choose arbitrary sources or versions. SSH Compute rejects every
  nonempty plugin map; an empty selection remains supported for its embedded Harness.
- Agent enablement does not manage account-wide installation. A disabled
  selection can remain installed while its execution is blocked locally.
- A catalog response, rendered configuration, or direct MCP call does not prove
  native Agent execution. See [current mappings](plugin-bundled.md#native-mappings-and-limits); the
  [feature matrix](plugin-matrix.md) preserves an older review snapshot.

## Troubleshooting

| Symptom                                                           | What to check                                                                                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A catalog call fails                                              | Check that the selected Driver matches the Harness. Bundled Codex also needs its optional controller catalog reader configured for this method.                     |
| A saved selection will not deploy                                 | Confirm the same Driver is still selected, the Harness is supported, and its native policy can represent the whole requested selection.                             |
| Startup reports `PLUGIN_AUTH_REQUIRED` or `PLUGIN_INSTALL_FAILED` | Check the selected plugin and its Harness/provider access. Other startup errors are not translated into these warnings; consult the selected backend's diagnostics. |
| A disabled plugin still appears installed                         | Installation and Agent-local execution are separate. Check effective Agent configuration and policy before treating the plugin as enabled.                          |

## Implementations

- [Bundled OpenClaw and Codex Drivers](plugin-bundled.md): `occ-plugin` serves
  embedded OpenClaw; `codex-plugin` serves dedicated Codex.
- [PluginDriver feature matrix](plugin-matrix.md): historical capability review
  with pinned source evidence.

## Related

### Source and verification

- [Bundled Driver source](../../../apps/controller/src/drivers/plugin/index.ts), [runtime translator](../../../apps/controller/src/drivers/plugin/runtime-translator.ts), and [trusted selection](../../../apps/controller/src/composition/installation-config.ts)
- [Agent plugin runtime flow](../../flows/agent-plugins.md), [deployment](../../guides/deploy.md), and [verification guide](../../testing/plugins.md)
- [Implementation proof requirements](../../../specs/plans/16-plugin-driver.md#verification)
