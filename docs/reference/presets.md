# Agent Presets

A Preset stores reusable Agent launch settings and variable definitions in one
Namespace. Select it when creating an Agent, fill its variables, and edit the
copied settings before saving. The new Agent and Configuration are independent:
editing or deleting the Preset cannot change them or their deployed revisions.
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
    - presets/swe-preset.json
```

`includeDefaults: true` seeds exactly **Standard Codex** and **Standard OpenClaw**.
Omitting it or setting it to `false` disables both bundled Presets; explicit
`files` still load. Each JSON file contains one
`{ "name": "...", "template": { ... } }` object. Relative file paths resolve beside
the Installation YAML, independent of the process working directory; absolute
paths are also supported. Mount the files readably for both the API and worker.
Missing, malformed, invalid, or duplicate-name definitions prevent startup.
Files are read at startup, not watched for changes. API startup adds missing defaults to existing ready or
provisioning Namespaces, including the bootstrap Namespace. New Namespace
creation includes the same defaults atomically. Failed or deleting Namespaces
are skipped during startup.

Each copy is an ordinary Namespace-owned Preset with its own ID and normal
read/update/delete permissions. Matching names are preserved without comparing
or overwriting their templates. Startup can restore a deleted or renamed
default while enabled; bundle updates do not replace existing copies. Removing the files and disabling
`includeDefaults` stops seeding and leaves saved Presets and Agents unchanged.
Namespace deletion removes copies that still match the current default by name
and template; edited copies block it with `409 NAMESPACE_NOT_EMPTY`.
Restart the API after changing the YAML, keeping the worker configuration in sync.

Startup selects a persisted Principal authorized to administer the Installation
and requires `preset:create` wherever defaults are missing. Namespace
creators likewise need `preset:create` when this option is enabled. Authorization
or template validation failure rolls back initialization and prevents startup
or Namespace creation. The selected Configuration Driver validates native
values; seeding does not create workloads or credentials.

## Standard harness presets

Both bundled presets ask for an Agent name, model ID, and masked model API key.
They share the gateway defaults and disabled browser, elevated tools, and web
fetch settings.

| Preset                                                               | Harness  | Execution mode | Model reference  |
| -------------------------------------------------------------------- | -------- | -------------- | ---------------- |
| **Standard Codex**                                                   | Codex    | Dedicated      | `codex/<model>`  |
| [**Standard OpenClaw**](../../deploy/presets/standard-openclaw.json) | OpenClaw | Embedded       | `openai/<model>` |

OpenClaw uses the ordinary OpenAI provider endpoint and native harness. It does
not load the Codex plugin, its app-server configuration, or its hosted cached-search override. The Codex-specific
sandbox and network proxy settings therefore apply only to **Standard Codex**.

## SWE Agent preset

[`SWE Agent`](../../deploy/presets/swe-preset.json) copies **Standard Codex**
and adds Slack Socket Mode and workspace instructions for software engineering.
It uses the Codex harness with **Service Accounts** authentication (`codex_pat`).
The `model` variable defaults to `gpt-6-astra` and remains editable; its rendered
model reference is `codex/gpt-6-astra`. The preset exposes only `name` and `model`
variables. After **Use Preset**, choose an existing service account Secret or
**Create new Secret...** before creating the Agent.

Load a copy beside your YAML as in the example above, or reference the shipped
container file at `/app/deploy/presets/swe-preset.json`. It is opt-in and is not
added by `includeDefaults` alone.

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

| Field                          | Purpose                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `variables`                    | Named scalar inputs, their types, descriptions, and optional defaults.                                    |
| `agent.name`                   | Suggested Agent name; the saved Agent still needs a unique name.                                          |
| `agent.executionMode`          | Embedded or dedicated execution.                                                                          |
| `agent.backendId`              | Installation-configured Backend ID, or null.                                                              |
| `agent.harnessAuth`            | Auth method default, credential binding, password variable token, or null; never stored credential bytes. |
| `agent.initialWorkspaceFiles`  | Optional creation-time workspace contents keyed by supported filename.                                    |
| `agent.plugins`                | Desired plugin selections and policies.                                                                   |
| `agent.pluginApprovers`        | Agent-wide default plugin approvers copied into the editable draft.                                       |
| `configuration.values`         | Native Agent Configuration JSON, including models, Harness settings, channels, and sandbox settings.      |
| `configuration.secretBindings` | Bindings to Secrets in this Namespace.                                                                    |

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
- A default must have the declared type. An omitted input uses its default;
  explicit `false`, `0`, and an empty string override defaults. Referenced
  variables without a default need an input. Unknown names and wrong types fail.
- A token occupying the entire string retains its scalar type. A token inside
  a longer string requires a string variable. For example, `"{{ vars.count }}"`
  can become a JSON number; `"worker-{{ vars.name }}"` stays a string.
- Object keys inside `configuration.values` can use string variables, including
  model catalog keys. Two keys that render to the same name are rejected.
  Other schema field names cannot be variables.
- Rendering makes one pass over JSON. Quotes in an input remain data, and input
  values are not evaluated again. There are no expressions, filters, loops,
  environment lookups, or Secret reads. Malformed `vars.` expressions fail.
- Other placeholders, including `${NAME}` and unrelated `{{ ... }}` text,
  remain literal. To preserve a Preset token itself, prefix it with a backslash:
  JSON `"\\{{ vars.name }}"` renders as literal `{{ vars.name }}`.

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

For the password variable bound to authentication, the Console offers **Create new Secret**
or **Use existing Secret**. Existing mode lists readable Secret metadata from the
current Namespace and uses the selected reference without fetching its value.
Switching modes clears any entered token. The saved Preset remains unchanged.

In new mode, **Use Preset** carries the entered value into the form's masked credential input.
**Create Agent** creates a Secret in the current Namespace, then uses its reference
for Agent authentication and grants the Agent access through the ordinary creation
flow. The value never belongs in Preset storage, Agent JSON, or Configuration JSON.
API clients rendering this form must likewise create a Secret and replace `secret`
with `source: <SecretRef>` before submitting an ordinary Agent request. Rendering
alone does not create resources. Existing mode reuses the selected Secret and
grants this Agent exact access through the same creation flow. Partial saves
follow normal creation recovery; retrying credential access does not recreate the Agent.

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

| Request                                            | Result                  | Required permission                          |
| -------------------------------------------------- | ----------------------- | -------------------------------------------- |
| `POST` collection with `{name, template}`          | `201`, created Preset   | `preset:create` on the Namespace collection. |
| `GET` collection                                   | `200`, readable Presets | `preset:read` checked on each candidate.     |
| `GET` exact Preset                                 | `200`, Preset           | `preset:read` on that Preset.                |
| `PATCH` exact Preset with `name` and/or `template` | `200`, updated Preset   | `preset:update` on that Preset.              |
| `DELETE` exact Preset                              | `204`                   | `preset:delete` on that Preset.              |

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
The console performs rendering and form checks first; these do not replace server
validation. Audit records omit templates and variable values.

Invalid inputs return `400`; denied access returns `403`; a missing exact target
returns `404`; duplicate names or lifecycle conflicts return `409`; unavailable
IAM, persistence, or required Driver capability returns `503`. Delete Presets
before deleting their Namespace. Deleting one removes its resource-scoped IAM
bindings, but keeps copied Agents, Configurations, and credential sources.

## Limits and recovery

Presets are managed through the HTTP API; the console only selects and applies
them. There are no Preset CLI commands, inheritance, version history, or Agent
metadata recording which Preset was used. Creation still saves a Configuration
and an Agent separately. Follow [partial-save recovery](console/create-and-deploy.md#create-an-agent)
if the second save fails or a response is lost.

A Preset is read once when selected. **Use Preset** renders its variables and
opens an ordinary editable Agent form. The chooser closes; changing the draft
does not update or reread the Preset. Before saving, **Start over** discards the
unsaved draft and returns to the chooser. Restart is disabled once a Configuration
has saved or a save outcome is uncertain. The saved Configuration remains available for recovery
if Agent creation fails.

A valid Preset is not necessarily a valid Agent configuration. A later Agent
validation error can leave a saved Configuration; follow the recovery steps
above. Later deployments read the Agent's own draft. Credential rotation retains
its normal behavior.
