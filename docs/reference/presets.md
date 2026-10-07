# Agent Presets

A Preset stores reusable Agent launch settings and variables in a Namespace.
Select it during Agent creation, fill its variables, and edit copied settings before
saving. Later Preset edits or deletion cannot change the Agent, Configuration, or
deployed revisions.
See [Create an Agent from a Preset](../guides/topics/agent-presets.md).

The checked-in [standard Codex Preset](../guides/topics/standard-codex-preset.md)
uses this same API and chooser. Install it manually or enable the
[Installation defaults](#installation-defaults); its native sandbox settings do not establish Pod-wide egress isolation.

## Installation defaults

The trusted Installation YAML can include bundled Presets and JSON files:

```yaml
presets:
  includeDefaults: true
  files:
    - /app/deploy/presets/swe-preset.json
```

`includeDefaults: true` seeds `default-codex`, **Standard Codex**, and **Standard OpenClaw**.
Omitting or disabling it stops bundled seeding; explicit `files`
still load. Each JSON file contains one `{ "name": "...", "template": { ... } }`
object. Relative paths resolve beside the Installation YAML. The Helm chart mounts
only that YAML, so on Helm list only files shipped in the controller image, by
absolute path. Missing, malformed, invalid, or duplicate-name files, and names
that break the API Name rule (edge whitespace, control characters, line or
paragraph separators, more than 200 characters), prevent
startup (`PRESET_FILE_INVALID`); a file named like a bundled default, such
as `default-codex`, replaces it; the API (not the worker, which never applies
defaults) logs `presets.bundled-default-shadowed`.
API startup adds missing defaults to ready
or provisioning Namespaces, including the bootstrap Namespace; new Namespaces
receive them atomically.

Each copy is an ordinary Namespace-owned Preset with its own ID and normal
read/update/delete permissions. Startup can restore a deleted or renamed
default while enabled. Removing the files and disabling
`includeDefaults` stops seeding and leaves saved Presets and Agents unchanged.
Restart the API after changing the YAML, keeping the worker configuration in sync.

### Bundled default upgrades

Earlier shipped versions of the bundled defaults are archived in
`deploy/presets/archive/`. While `includeDefaults` is enabled, startup replaces
a same-name copy that still equals an earlier version (normalized JSON) with the
current template, keeping its ID and AccessBindings, and audits
`openclaw.presets.update` with `source: installation-defaults-refresh`. Copies
matching no shipped version are operator edits and stay; so do `presets.files`
copies and retired names such as `standard-codex`. To keep an earlier version,
rename the copy or change any field. A refused refresh (say, a deny Restriction
on `preset:update`) keeps the copy and logs `presets.default-refresh-skipped`.

Namespace deletion removes copies that equal, by name and template, a configured
default or any shipped bundled version, even with `includeDefaults` disabled.
Other Presets block it with `409 NAMESPACE_NOT_EMPTY`.

Startup selects a persisted Principal authorized to administer the Installation
and requires `preset:create` wherever defaults are missing and `preset:update`
on each copy it refreshes; a deny Restriction on `preset:create` skips that
default and logs `presets.default-create-skipped`. Namespace creation with
defaults also needs `preset:create`. Other authorization or template
validation failures roll back initialization and prevent startup or Namespace
creation. The Configuration Driver validates native values; seeding creates no
workloads or credentials.

## Configuration inventory

These are the four shipped JSON definitions in `deploy/presets/`. Installed
same-name copies can differ; read the Namespace Preset and the Agent's saved
Configuration to inspect actual settings. Presets contain OpenClaw configuration,
including the Codex plugin's app-server options; none supplies a standalone
Codex `config.toml` or a reasoning-effort override.

| Preset / file                                                           | Agent and credential                                                            | OpenClaw gateway and tools                                                                                                                                 | Codex app-server policy                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [`default-codex`](../../deploy/presets/default-codex.json)              | Dedicated; choose name, model, and API key or service account token in the form | Local/LAN; Control UI enabled for loopback origins; Chat Completions enabled; `OPENCLAW_GATEWAY_PASSWORD` reference; browser/web/elevated settings omitted | Guardian WebSocket; `on-request`; `read-only`; reviewer and network proxy omitted                     |
| [**Standard Codex**](../../deploy/presets/standard-codex.json)          | Dedicated; name/model variables and masked API key                              | Standard gateway/tool policy below; cached Codex search                                                                                                    | Guardian WebSocket; `on-request`; `workspace-write`; reviewer `user`; limited workspace network proxy |
| [**Standard OpenClaw**](../../deploy/presets/standard-openclaw.json)    | Embedded; name/model variables and masked API key                               | Standard gateway/tool policy; web search enabled without the Codex override                                                                                | None: native OpenClaw, no Codex plugin                                                                |
| [`SWE Agent` / `swe-preset.json`](../../deploy/presets/swe-preset.json) | Dedicated; name/model variables; model defaults to `gpt-6-astra`; `codex_pat`   | Standard Codex settings plus Slack and workspace instructions                                                                                              | Same as Standard Codex, except `approvalPolicy: never`                                                |

### Plain console default

**Start with default Preset** reads the authorized `default-codex` copy in the
selected Namespace. Its shipped template has no variables, model, name, or
credential; the ordinary form collects them. An operator-customized copy with
variables opens the variable chooser first. Missing or unreadable defaults
disable quick-start; other readable Presets remain selectable. Install the file
through `includeDefaults`, `presets.files`, or Preset POST to enable it.
**Start without Preset** is independent of Namespace Presets; it uses the
console's shared configuration base and ordinary creation permissions.

The shipped default file also supplies the console's shared configuration base
for empty templates, **Reset template**, and provider/Harness switches. The
installed copy supplies initial draft settings, and field edits preserve unrelated
settings. **Reset template** returns to the shipped base with the selected model.
The public shared-default asset exposes no installed credential or private template.

### Standard harness presets

The standard gateway policy is local mode, LAN binding, Control UI enabled, and
an environment reference to `OPENCLAW_GATEWAY_PASSWORD`. Browser, elevated tools,
and web fetch are explicitly disabled; web search is enabled. Neither standard
file explicitly enables Chat Completions.

All Codex presets route `codex/<model>` through `agentRuntime.id: codex`, a
fail-closed `openai-responses` provider at `http://127.0.0.1:9`, and the Codex
plugin. The plain form adds this routing after model selection. Guardian
WebSocket transport uses `${APP_SERVER_URL}` and `${APP_SERVER_TOKEN}` at runtime.
OpenClaw instead routes `openai/<model>` through `agentRuntime.id: openclaw` and
`https://api.openai.com/v1` with `openai-responses`.

The standard Codex network proxy enables the `workspace` base profile in
`limited` mode. Its nine allowed build domains and disabled proxy/socket escape
options are listed in the [standard Codex guide](../guides/topics/standard-codex-preset.md#build-network-allowlist).
Cached search uses `tools.web.search.openaiCodex.mode: cached`.

Omitted fields inherit the selected native runtime's defaults; omission does
not establish a particular reviewer, network policy, or tool permission. Compute
adds managed identity, authentication, transport, and placement settings, while
selected Plugin and Sandbox Drivers can supply additional runtime configuration.
The [Harness contract](harness-execution.md) and
[standard policy boundary](../guides/topics/standard-codex-preset.md) explain those
limits. A saved template does not prove live Codex policy enforcement.

## SWE Agent preset

[`SWE Agent`](../../deploy/presets/swe-preset.json) copies **Standard Codex**
and adds Slack Socket Mode and workspace instructions for software engineering.
It uses the Codex harness with **Service Accounts** authentication (`codex_pat`).
The `model` variable defaults to `gpt-6-astra` and remains editable; its rendered
model reference is `codex/gpt-6-astra`. The preset exposes only `name` and `model`
variables. After **Use Preset**, choose an existing service account Secret or
**Create new Secret...** before creating the Agent.

List the shipped container file as above; `includeDefaults` alone does not add it.

In the Console, choose **SWE Agent**, fill its variables, then use **Edit Slack**
to configure channels, allowed senders, and Slack app/bot Secrets. No channels or
credentials are stored in the preset.

The preset includes the supplied instructions in
`template.agent.initialWorkspaceFiles.AGENTS.md`, including their draft decisions.
It uses `{{vars.name}}` in the heading, opening sentence, and other self-references,
filled from the entered `name` when applying the Preset. Later name edits do not
re-render the copied file. To revise the instructions, update that content and the
existing Namespace Preset through the API. Restarting with a changed JSON file
preserves already-installed same-name copies.

## Contents

A Preset has `id`, `namespaceId`, a Namespace-unique `name`, `template`, and
`createdAt`. OCC assigns the ID, Namespace, and creation time. An empty template
is valid. Its optional fields are:

| Field                          | Purpose                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `variables`                    | Scalar inputs with types, descriptions, and optional defaults.                    |
| `agent.name`                   | Suggested name; the saved Agent still needs a unique name.                        |
| `agent.executionMode`          | Embedded or dedicated.                                                            |
| `agent.backendId`              | Installation Backend ID, or null.                                                 |
| `agent.harnessAuth`            | Auth method, credential binding, password token, or null; never credential bytes. |
| `agent.initialWorkspaceFiles`  | Optional supported-file contents at creation.                                     |
| `agent.plugins`                | Plugin selections and policies.                                                   |
| `agent.pluginApprovers`        | Default plugin approvers for the editable draft.                                  |
| `configuration.values`         | Native Configuration JSON for models, Harness, channels, and sandbox settings.    |
| `configuration.secretBindings` | Namespace Secret bindings.                                                        |

These use the existing [Agent](agents.md) and [Configuration](configuration.md)
contracts. Installation-owned Driver selection, generated identities, runtime
state, and Agent revision IDs are not template settings. A supplied
`configuration.values` replaces the console's starter JSON; it does not merge
with it. Omitted settings use the form's normal defaults.

`agent.pluginApprovers` uses the Agent default plugin approver semantics from
[Agent Plugins](agent-plugins.md#slack-approver-users). Omit it to inherit
the form default. Use an empty array to select no Slack approvers, or a
list of channel user identities to prefill selected approvers. Variable tokens
can appear inside those identity strings; the completed Agent request still
validates the rendered approvers with the selected Plugin Driver.

## Workspace files

`template.agent.initialWorkspaceFiles` is a partial map for `AGENTS.md`, `SOUL.md`,
`IDENTITY.md`, and `USER.md`. Values must be valid Unicode strings without NUL,
at most 16 KiB of UTF-8 per file. Limits also apply after variable expansion.
Omitted files keep the Console defaults; an explicit empty string creates an
empty file. Users can review and edit the rendered contents in **Advanced settings →
Workspace files** before creation. Password variables are not allowed in files.

For example, add this within `template.agent`:

```json
{
  "initialWorkspaceFiles": {
    "IDENTITY.md": "# Identity\nName: {{ vars.name }}\n",
    "USER.md": ""
  }
}
```

The ordinary Agent/provisioning APIs stage these contents for first deployment.
Preset files embed workspace contents; they do not read arbitrary workspace paths.

## Variables

Declare variables inside `template.variables`, then refer to them with
`{{ vars.name }}` in a launch-setting string. For example:

```json
{
  "variables": {
    "name": { "type": "string", "description": "Agent name" },
    "model": { "type": "string", "default": "openai/gpt-5.1" }
  },
  "agent": { "name": "{{ vars.name }}", "executionMode": "embedded" },
  "configuration": {
    "values": { "agents": { "defaults": { "model": "{{ vars.model }}" } } }
  }
}
```

This is a partial template, not a complete deployment configuration. Add the
native settings and credentials required by your Installation before deploying.

- Names match `[A-Za-z_][A-Za-z0-9_]*`. Types are `string`, `number`, `boolean`, and
  `password`; numbers must be finite. Optional `description` text labels inputs.
- Defaults must match the declared type. Omitted inputs use defaults; `false`,
  `0`, and empty strings override them. Referenced variables without defaults
  require input. Unknown names and wrong types fail; the `400` message names the
  template path, such as `Preset variables.model:`, and what that field accepts,
  not the submitted value.
- Whole-string tokens retain scalar type; embedded tokens require strings.
  `"{{ vars.count }}"` can become a JSON number; `"worker-{{ vars.name }}"` stays a string.
- `configuration.values` keys, including model catalog keys, can use string
  variables. Duplicate rendered keys fail; other schema field names cannot vary.
- Rendering makes one JSON pass: quotes remain data and inputs are not re-evaluated.
  Expressions, filters, loops, environment lookups, and Secret reads are unsupported;
  malformed `vars.` expressions fail.
- Other placeholders, including `${NAME}` and unrelated `{{ ... }}` text, remain
  literal. Prefix a Preset token with a backslash to preserve it: JSON
  `"\\{{ vars.name }}"` renders as literal `{{ vars.name }}`.

Password variables are masked string inputs with no stored default. They may
appear only as a whole token in `agent.harnessAuth.secret`, with method
`api_key` or `codex_pat`, for example:

```json
{
  "variables": { "modelSecret": { "type": "password" } },
  "agent": {
    "harnessAuth": { "method": "api_key", "secret": "{{ vars.modelSecret }}" }
  }
}
```

A method-only `agent.harnessAuth`, such as `{ "method": "codex_pat" }`,
preselects authentication without supplying credentials. The creation form still
requires a Secret selection; a concrete Agent requires a complete credential binding.

For an authentication password variable, the Console offers **Create new Secret**
or **Use existing Secret**. Existing mode lists readable Namespace Secret metadata
and uses the selected reference without fetching its value. Switching modes clears
the entered token; the saved Preset remains unchanged.

In new mode, **Use Preset** carries the value into the masked credential input, and
**Create Agent** creates a Namespace Secret. Both modes then grant the Agent exact
access through the ordinary creation flow. The value never belongs in Preset
storage, Agent JSON, or Configuration JSON. API clients must create a Secret and
replace `secret` with `source: <SecretRef>` before submitting an ordinary Agent
request; rendering alone creates no resources. Partial saves follow normal
recovery; retrying credential access does not recreate the Agent.

String variables can still supply existing credential reference IDs.
[SecretRefs](configuration/secrets.md) remain structured, unresolved references;
ordinary Namespace and credential permissions still apply. In Preset write requests,
`agent.harnessAuth.source` and `configuration.secretBindings.*.source` may omit
`namespaceId`. OCC fills it from the request's Namespace before validating and
storing the template. A supplied Namespace is still validated; an explicit
cross-Namespace reference is rejected. This shorthand applies only to Preset
writes; ordinary Agent and Configuration APIs require complete references.

The template and
rendered JSON each have a 1 MiB size limit and a maximum depth of 64.

## CRUD and permissions

The collection path is `/namespaces/:namespaceId/presets`; an exact Preset adds
`/:presetId`. Use the [generated API reference](api.md#presets) for full schemas
and response envelopes.

| Request                                            | Result                  | Required permission                                             |
| -------------------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| `POST` collection with `{name, template}`          | `201`, created Preset   | `preset:create` on the Namespace collection.                    |
| `GET` collection                                   | `200`, readable Presets | Namespace `read`, then `preset:read` checked on each candidate. |
| `GET` exact Preset                                 | `200`, Preset           | `preset:read` on that Preset.                                   |
| `PATCH` exact Preset with `name` and/or `template` | `200`, updated Preset   | `preset:update` on that Preset.                                 |
| `DELETE` exact Preset                              | `204`                   | `preset:delete` on that Preset.                                 |

An included `template` replaces the whole template, including variable
definitions; omitted fields stay unchanged. Writes check the template structure,
variable syntax and default types, credential-binding structure, known
cross-Namespace credential references, and credential literals at their native
use sites. Ordinary launch-field errors, such as an invalid execution mode or
plugin policy, can remain in a saved Preset. The console checks values needed
to populate its form; the existing creation APIs validate completed settings.
The selected
[Configuration Driver](drivers/configuration.md#optional-validation) must support
value validation when a template contains `configuration.values`.

Fresh native-IAM bootstrap includes Preset CRUD permissions. On existing
Installations, the upgrade adds those four permissions only to the unchanged
built-in Installation administrator Role: its ID has the `role_admin_` UUID
format, its name is exactly `Installation administrator`, it has no Namespace,
and its permissions are exactly the 26 original grants, in any order.

Custom, renamed, reduced, or extended Roles retain their grants. Their IAM policy
owner must explicitly grant Preset access; rerunning bootstrap does not change
stored Roles. The public Namespace policy API supports exact-Preset access, but
cannot edit an Installation Role or grant collection-wide `create`.

Preset access grants no permission to create Agents or use referenced Secrets.
After rendering, Configuration and Agent creation enforce their existing schemas,
credential rules, and authorization before saving. Deployment rechecks admission.
Console checks do not replace server validation. Audit records omit templates and
variable values.

Invalid inputs return `400`; denied access returns `403`; a missing exact target
returns `404`; duplicate names or lifecycle conflicts return `409`; unavailable
IAM, persistence, or required Driver capability returns `503`. Delete Presets
before deleting their Namespace. Deleting one removes its resource-scoped IAM
bindings, but keeps copied Agents, Configurations, and credential sources.

## Limits and recovery

Create and update Presets through the HTTP API; `occ preset list`, `get`, and
`delete` cover the rest ([CLI reference](cli.md#resource-commands)). The console
only selects and applies them. There is no inheritance, version history, or Agent
metadata recording which Preset was used. Creation still saves a Configuration
and an Agent separately. Follow [partial-save recovery](console/create-and-deploy.md#create-an-agent)
if the second save fails or a response is lost.

A Preset is read once when selected. **Use Preset** renders its variables and
opens an ordinary editable Agent form. The chooser closes; changing the draft
does not update or reread the Preset. **Start over** discards the unsaved draft
and returns to the chooser, but is disabled once a Configuration has saved or a
save outcome is uncertain.

A valid Preset is not necessarily a valid Agent configuration. A later Agent
validation error can leave a saved Configuration; follow the recovery steps
above. Later deployments read the Agent's own draft.
