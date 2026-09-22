# Agent Presets

A Preset stores reusable Agent launch settings and variable definitions in one
Namespace. Select it when creating an Agent, fill its variables, and edit the
copied settings before saving. The new Agent and Configuration are independent:
editing or deleting the Preset cannot change them or their deployed revisions.
See [Create an Agent from a Preset](../guides/topics/agent-presets.md).

## Contents

A Preset has `id`, `namespaceId`, a Namespace-unique `name`, `template`, and
`createdAt`. OCC assigns the ID, Namespace, and creation time. An empty template
is valid. Its optional fields are:

| Field                          | Purpose                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `variables`                    | Named scalar inputs, their types, descriptions, and optional defaults.                               |
| `agent.name`                   | Suggested Agent name; the saved Agent still needs a unique name.                                     |
| `agent.executionMode`          | Embedded or dedicated execution.                                                                     |
| `agent.providerId`             | Installation-configured Provider ID, or null.                                                        |
| `agent.harnessAuth`            | Credential source binding, or null; contains references, never credential bytes.                     |
| `agent.plugins`                | Desired plugin selections and policies.                                                              |
| `configuration.values`         | Native Agent Configuration JSON, including models, Harness settings, channels, and sandbox settings. |
| `configuration.secretBindings` | Bindings to Secrets in this Namespace.                                                               |

These use the existing [Agent](agents.md) and [Configuration](configuration.md)
contracts. Installation-owned Driver selection, generated identities, runtime
state, and Agent revision IDs are not template settings. A supplied
`configuration.values` replaces the console's starter JSON; it does not merge
with it. Omitted settings use the form's normal defaults.

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

- Names match `[A-Za-z_][A-Za-z0-9_]*`. Types are `string`, `number`, and
  `boolean`; numbers must be finite. Optional `description` text labels inputs.
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

Use variables for credential reference IDs, not passwords or API keys.
[SecretRefs](configuration/secrets.md) remain structured, unresolved references;
ordinary Namespace and credential permissions still apply. The template and
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
