# Feature Spec: Agent presets

**Date:** 2026-09-21 · **Status:** Implementing · **Owner:** OCC lifecycle and console

## Problem and Decision

A Preset is a Namespace-owned template for creating Agent drafts. It stores reusable launch settings
and variable definitions; a user supplies values and saves an independent Agent and Configuration
through the existing APIs. Deployment still creates an immutable AgentRevision. Preset edits and
deletion cannot change an existing draft, running Agent, or later deployment of that draft.

[NemoClaw
blueprints](https://github.com/NVIDIA/NemoClaw/blob/main/nemoclaw-blueprint/blueprint.yaml) bundle
sandbox, inference, and policy settings. This proposal takes the reusable configuration idea and
applies it to OCC's existing Agent creation contract.

## Scope

- Add the `preset` primitive, persistent CRUD APIs, IAM permissions, and audit.
- Make Presets selectable in the console's Create Agent form.
- Cover all currently caller-configurable Agent launch settings, allowing partial templates.
- Include typed template variables with optional defaults, filled before Agent creation.
- Defer Agent metadata recording Preset use.
- Defer a Preset management screen, CLI commands, inheritance, and version history.
  Operators manage Presets through the CRUD API initially.

## Contract

### Resource and contents

OCC owns each Preset within exactly one Namespace. A Namespace can contain many Presets, and one
Preset can supply many Agents in that same Namespace. Each Preset has `id`, `namespaceId`, a
Namespace-unique `name`, `template`, and `createdAt`. OCC assigns its immutable ID and Namespace.
Preset CRUD stores ordinary OCC state and starts no runtime work.

`template` contains optional `variables`, `agent`, and `configuration` objects.
Every launch setting below is optional; an empty template is valid.

| Template field                 | Existing owner and meaning                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent.name`                   | Suggested Agent name; the user must provide a unique name before saving.                                                                                                      |
| `agent.executionMode`          | Existing embedded or dedicated execution choice.                                                                                                                              |
| `agent.providerId`             | Existing Installation-configured Provider reference, or null.                                                                                                                 |
| `agent.harnessAuth`            | Existing credential-source binding or null; references only.                                                                                                                  |
| `agent.plugins`                | Existing desired plugin selections and policies.                                                                                                                              |
| `configuration.values`         | Native Agent Configuration JSON, including model/provider catalogs, Harness selection/settings, channels, sandbox options, repositories, and other supported native settings. |
| `configuration.secretBindings` | Existing Namespace-owned Secret bindings.                                                                                                                                     |

Reuse the [Agent schemas](../packages/contracts/src/api/common.ts) and [Configuration
contract](../docs/reference/configuration.md); model and Harness settings keep their native JSON
locations, with no duplicate schema or fields. Generated identities, runtime state, and
Installation-owned Driver/host choices remain platform-owned; presets cannot turn them into
per-Agent options.

Preset writes validate the envelope, variable declarations and syntax, default types,
JSON size/depth, credential-binding structure, and known same-Namespace references.
Ordinary launch fields may contain mistakes until creation. Keep existing SecretRef and
credential-literal restrictions on templates and defaults at their use sites.
The console checks values needed to populate form controls; Configuration and Agent creation
enforce their existing schemas and permissions. Deployment revalidates credentials,
Providers, and plugins.

### Variables

`template.variables` maps names to `{type, description?, default?}`; it defaults to
an empty map. Names match `[A-Za-z_][A-Za-z0-9_]*`. Types are `string`, `number`,
and `boolean`; defaults must match, with finite numbers and no null coercion.
For example, a partial template can ask for an Agent name and default its model:

```json
{
  "variables": {
    "name": { "type": "string", "description": "Agent name" },
    "model": { "type": "string", "default": "codex/gpt-5.1" }
  },
  "agent": { "name": "{{ vars.name }}" },
  "configuration": { "values": { "agents": { "defaults": { "model": "{{ vars.model }}" } } } }
}
```

Use Jinja-style `{{ vars.name }}` tokens, with optional whitespace inside braces. Only declared
`vars.<name>` references are recognized; this is substitution, not Jinja evaluation. There are no
expressions, filters, control blocks, environment lookups, or Secret reads. Invalid reserved `vars.`
expressions fail validation; unrelated `{{ ... }}` text remains literal. Prefix a token with a
backslash to keep it literal. In JSON, `"\\{{ vars.name }}"` renders as `{{ vars.name }}`.

Substitute string values in launch settings and object keys within `configuration.values`; schema
field names elsewhere remain literal. A whole-value token retains the variable's JSON scalar type;
embedded tokens and keys require string variables. Reject duplicate rendered keys. Walk parsed JSON
once: quotes remain data, and inserted values/defaults are never interpreted as more templates.
Omitted input uses its default; supplied false, zero, and empty string are values. Reject unknown
input names, wrong types, undeclared references, and missing values for referenced variables without
defaults, identifying the variable and field.

Existing [runtime placeholders and SecretRefs](../docs/reference/configuration/secrets.md) remain
unchanged: `${NAME}` stays literal and native `{source, provider, id}` SecretRefs stay unresolved.
Variables may supply credential reference IDs, subject to the same scope and authorization checks,
but must not carry credential bytes. The shared renderer and console form checks run before create requests; variable errors leave the
form editable and create nothing. Existing Agent/Configuration schema, native credential, and authorization checks
remain authoritative on the server before each resource is persisted. Do not persist input maps
separately on Agents, or log their contents. Rendered non-secret values are ordinary saved
Agent/Configuration settings.

### API, persistence, and IAM

| Method and path                                     | Result                                               |
| --------------------------------------------------- | ---------------------------------------------------- |
| `POST /namespaces/:namespaceId/presets`             | Create from `{name, template}`; 201 with the Preset. |
| `GET /namespaces/:namespaceId/presets`              | List readable Presets; 200.                          |
| `GET /namespaces/:namespaceId/presets/:presetId`    | Read one Preset; 200.                                |
| `PATCH /namespaces/:namespaceId/presets/:presetId`  | Update name and/or template; 200.                    |
| `DELETE /namespaces/:namespaceId/presets/:presetId` | Delete the Preset; 204.                              |

Use existing response envelopes and error codes. PATCH replaces an included template, including its
variable definitions, as a whole; omitted fields are unchanged. Concurrent edits follow ordinary
update ordering. Unknown envelope fields, malformed variables or credential bindings,
known cross-Namespace references, and duplicate names fail without partial writes.
Ordinary launch-field errors are deferred to the creation APIs. Missing targets return 404, denied access 403,
name/lifecycle conflicts 409, and unavailable IAM or storage 503. Preset names and ownership are DB
constraints.

Register `preset` in resource kinds and managed IAM policy. Creation requires `create` on the parent
Namespace's Preset collection; reads, updates, and deletes require the corresponding action on the
exact Preset. Lists filter by exact read permission. Preserve default-deny authorization and
attributable, sanitized mutation/denial audit. Do not log template documents, variable defaults, or
credential data. Preset access never grants access to its referenced credentials or to Agents.

Use the existing Namespace mutation lock and lifecycle admission rules. Presets count toward
Namespace non-emptiness and must be deleted before Namespace deletion. Deleting a Preset removes its
own record and resource-scoped bindings; it does not delete copied Configurations, Agents, or
credential sources.

### Select, edit, and deploy

The console lists readable Presets in the current Namespace and offers **Start without Preset**.
Selecting a Preset reads its complete template once and shows variable inputs with descriptions
and defaults. **Use Preset** renders that local copy and opens the ordinary Agent form.
A supplied `configuration.values` replaces the JSON editor contents without a deep merge;
absent fields use normal form defaults. Users edit copied values and complete missing settings.
The chooser is removed after rendering; the form has no ongoing variable or Preset state.
Invalid variables or values that cannot populate form controls leave the chooser open and create
nothing. **Start over** explicitly discards the unsaved draft and returns to a fresh chooser.

Save uses the existing Configuration-create then Agent-create sequence, copying `secretBindings` and
plugin selections as well as the current form fields. Each creation gets a new Configuration, Agent
ID, and service principal; neither the Agent nor its Configuration references the Preset. If a
Preset changes or disappears after selection, the displayed copy remains the user's draft; reread
only on explicit selection, never silently at save.

Existing creation, credential-use, and deployment permissions still apply. Retain [partial-save and
uncertain-response recovery](../docs/reference/console/create-and-deploy.md): show a saved
Configuration ID, reuse it on a safe retry, and inspect state after an uncertain result. Do not
introduce an atomic launch endpoint for this feature. Once Configuration creation succeeds,
lock Configuration-affecting controls; Agent retries reuse that Configuration.
A late Agent validation error can leave a saved Configuration. Preserve existing
Agent-only corrections during retry. API clients follow the same read, render, edit, and create flow.

After credential provisioning and grants, the user deploys the saved Agent. [Existing revision
admission](../docs/reference/agents/deployment.md#revisions-and-deployment) copies the Agent's own
Configuration and selected launch settings into a revision. Later deployments keep using that
Agent's draft, never reread the Preset. Credential rotation and other existing runtime dependencies
retain their current behavior.

## Implementation

1. Add Preset types, schemas, IDs, and route metadata in `packages/contracts/src/`;
   include the variable contract and extend OCC repositories, read views, unit-of-work adapters, PostgreSQL schema
   and migration, and in-memory state under `packages/occ/src/`.
2. Implement CRUD in OCC and controller routes, including IAM resource registration,
   Namespace deletion checks, policy cleanup, and audit. Reuse existing transactions.
3. Implement deterministic variable rendering and the selector, input form, and one-time prefill
   action in [console Agent creation](../apps/controller/src/console/agents/create.mjs);
   preserve auth/channel controls and partial-save recovery. Expose editable
   plugin selections and Secret bindings when needed to submit all template fields.
4. Add a current Preset reference and usage guide when implementation ships.
   Update Agent/console references, affected flows, navigation, and API, database,
   and permissions cheat sheets; regenerate OpenAPI and the API cheat sheet.

## Verification

| Required outcome                                     | Implementation proof                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRUD persists with correct isolation and permissions | Real HTTP and PostgreSQL integration: restart/read, rename conflict, denied actions, filtered lists, variable definition round trips, and Namespace deletion with a remaining Preset.                                                           |
| Partial templates cover the ordinary launch contract | Browser flow selects a model/Harness template, fills variables and missing fields, edits rendered values, saves all supported fields including plugins and Secret bindings, and deploys through existing APIs.                                  |
| Variables resolve predictably                        | Browser/API integration covers declared defaults, required inputs, scalar types, interpolation, key collisions, escaping, preserved runtime placeholders/SecretRefs, and invalid references; failures save nothing.                             |
| Copies are independent                               | Create two Agents, edit one, update/delete the Preset before and after deployment, then redeploy; saved drafts and prior revisions retain their own values.                                                                                     |
| Presets do not bypass admission                      | Deny cross-Namespace sources, missing credential grants, and invalid model/Harness combinations through the real creation/deployment path; no workload is admitted.                                                                             |
| Recovery retains user work                           | Browser integration covers one-time prefill, ordinary draft edits, explicit restart, Configuration-only success, locked Configuration inputs after partial save, lost responses, and explicit retry without duplicate silent creation. |
| Launch still works                                   | Extend the existing real-runtime Agent integration with a Preset-derived Agent and prove one real model response; unavailable credentials/infrastructure remain an explicit verification gap.                                                   |

## Implementation status

The branch implements Preset CRUD, PostgreSQL persistence, IAM, shared variable rendering, and
console selection. The upgrade adds Preset CRUD grants only to the unchanged built-in
Installation administrator Role; customized Roles require their policy owner's explicit update.
See [upgrade eligibility](../docs/reference/presets.md#crud-and-permissions).
Native template admission uses the Configuration Driver's optional
`validateValues` capability; a template with native values requires that capability. Bundled
filesystem and Kubernetes Drivers provide it. Current behavior is owned by the
[Preset reference](../docs/reference/presets.md), [usage guide](../docs/guides/topics/agent-presets.md),
and [execution flow](../docs/flows/agent-presets.md). Live Kubernetes and model-response proof remains
unverified after the local cluster failed during cgroup v2 startup.

## Manual Notes

## Changelog

- 2026-09-21 22:00: Simplify Preset selection to one-time prefill and defer ordinary launch-field validation to creation (codex/01a0b1f2-e696-7232-a439-5b668154bcd9 - f997fca7e7f739a460274c74396afbcfda63f53a).

- 2026-09-21 19:58: Record narrowly scoped administrator grant upgrade (session `01a0b1f2-e696-7232-a439-5b668154bcd9`, base `aa6dd7415d65ffba5fa40098b2142eb2a7d73df4`).

- 2026-09-21 19:48: Record implementation and authoritative server admission; live runtime proof remains pending (session `01a0b1f2-e696-7232-a439-5b668154bcd9`, base `aa6dd7415d65ffba5fa40098b2142eb2a7d73df4`).

- 2026-09-21 18:50: Initial proposal; session `01a0b1f2-e696-7232-a439-5b668154bcd9`, base `aa6dd7415d65ffba5fa40098b2142eb2a7d73df4`.
- 2026-09-21 19:00: Include Preset variables, typed substitution, defaults, and console input flow; preserve runtime placeholders and SecretRefs.
