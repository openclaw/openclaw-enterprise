---
status: Proposed
implementation_status: Not implemented
author: kevinlin-openai
---

# Proposal: Revision-owned Codex permission profiles

- **ID:** RFC-0024
- **Created:** 2026-10-27
- **Last updated:** 2026-10-28
- **RFC PR:** [#3907](https://github.com/openclaw/openclaw-enterprise/pull/3907)
- **Implementation PR:** [#3909](https://github.com/openclaw/openclaw-enterprise/pull/3909)

## Decision and scope

Let an operator define named Codex permission profiles in the Codex Plugin Driver
configuration. Save the validated definitions with each Agent revision, including
revisions with no selected plugins. Render those saved definitions into the
generated native `config.toml`. The authentication probe must load that file while
keeping its explicit model endpoint, tool restrictions, timeout, and output checks.

This proposal changes the Plugin Driver contract. It must be submitted for human
review before implementation. Submission does not establish acceptance.

## Problem

Native Codex can receive managed requirements that name a permission profile
without receiving that profile's definition. Authentication can succeed, then the
model probe fails because native configuration cannot resolve the required name.
The operator must supply a definition that satisfies those requirements.

OCE already writes a generated `CODEX_HOME/config.toml`, but its authentication
probe uses `--ignore-user-config`. Removing that flag alone does not supply the
missing definitions. Today the [Codex Plugin Driver](../../apps/controller/src/drivers/plugin/index.ts)
does not accept them, and [revision admission](../../packages/occ/src/index.ts)
stores only Plugin Driver identity and plugin selections. It omits that state
when there are no selections. Reading live Driver settings during reconciliation
would let an operator edit change an existing revision's runtime files.

## Configuration and ownership

Add optional `permissionProfiles` to the Codex Plugin Driver's startup
configuration. Each key names a native profile. Each definition has exactly:

```json
{
  "permissionProfiles": {
    "custom-investigation": {
      "extends": ":workspace",
      "network": { "enabled": true }
    }
  }
}
```

Require `extends` and `network.enabled`. Reject unknown fields at every level,
nonboolean network values, empty names, control characters, reserved built-in
names, unknown parents, and inheritance cycles. Permit inheritance from
`:read-only`, `:workspace`, or another definition in the same map. Do not permit
`:danger-full-access` inheritance. Validate the supported shape against the pinned
native schema and inheritance behavior before delivery. Validation must run even
when native catalog discovery is not configured.

The definitions describe available profiles; they do not select a default
profile, set a session permission choice, or override managed requirements.
Native Codex retains responsibility for resolving its selected profile and
enforcing managed requirements. OCE retains its existing execution admission,
Sandbox, network, credential, and authorization boundaries. A definition that
native requirements reject must fail readiness.

This setting requires native managed policy to supply profile selection. With
the pinned CLI, an API-key or unauthenticated app-server can initialize but
reject configuration reads when definitions have no selected default. Such
deployments must leave this setting unset unless native policy supplies that
selection. This proposal adds no default-selection or authentication mechanism.

Do not accept raw TOML, native configuration fragments, credentials, arbitrary
filesystem grants, or corporate-specific defaults. Use neutral examples. Driver
configuration is operator-owned and must not be merged into Agent-authored
OpenClaw Configuration values.

## Immutable revision path

Extend `PluginDriver` with an optional, synchronous, side-effect-free
`snapshotRuntimeConfiguration()` method. It returns a JSON object or `undefined`.
The object contains only validated, nonsecret settings needed by that Driver's
runtime renderer. It excludes catalog executable paths, discovery credentials,
and other startup-only settings. The Codex implementation returns
`{ permissionProfiles }` when configured; other implementations can omit the
method. This is a Plugin Driver boundary, not a new general configuration store.

Add optional `runtimeConfiguration` to `PluginRevisionState` and its API schema.
OCC calls the selected Driver during revision admission and takes an immutable
copy with the Driver identity and selected plugins. It creates the state when
either plugins or runtime configuration exist. For a plugin-free revision,
`plugins` is `{}`. Admission must still reject an incompatible Harness.

The persisted revision owns this snapshot. Storage codecs and response schemas
must retain it and reject malformed state. The native renderer validates the
Driver-owned shape again before use. It must fail explicitly for unsupported
saved settings, without consulting current Driver configuration or falling back
to it. Editing or replacing a Driver affects only subsequent deployments.
An omitted snapshot means no operator-supplied profiles for that revision.

Keep the platform core unaware of permission-profile fields. The Codex Plugin
Driver owns their schema and validation; the existing Codex runtime translator
owns native rendering. Use the same saved state for Docker and Kubernetes.
Render only quoted table keys, quoted parent strings, and literal booleans.
Validate strings so JSON-style quoting cannot produce invalid TOML escapes.
The existing runtime artifact delivery limits still apply.

## Authentication probe

The generated launcher validates the runtime artifact and removes its prior
generated `CODEX_HOME/config.toml` before login. After authentication succeeds,
it writes the revision's saved configuration before the model probe and
app-server. Native login must establish authentication before it can load
managed policy; definitions without a local default can otherwise prevent
login. Apply this order on restart too. Failed authentication still prevents
the model probe and app-server from starting.

Remove `--ignore-user-config` from the probe so it can load the generated file
from its Agent-owned `CODEX_HOME`. Keep its temporary working directory and
temporary `HOME`; do not load an operator's home configuration.

Keep all other explicit guards: no approvals, ephemeral execution, ignored rules,
no project instructions, disabled tools and integrations, read-only sandbox,
explicit model and compatible endpoint, bounded execution and retry, and refusal
of tool events or invalid output. Keep endpoint overrides explicit even though
the generated file also supplies the endpoint. A successful login alone must not
make the Agent ready. Preserve the existing success rule: the probe must complete
one model turn with a nonempty assistant response and no disallowed events. The
verification prompt requests `READY`; this proposal does not tighten the runtime
check to an exact string match.

## Delivery and verification

Submit this RFC first, then deliver a linked implementation PR. Update the
[Plugin Driver reference](../../docs/reference/drivers/plugin.md) and the owning
[Harness execution flow](../../docs/flows/harness-execution-topology.md), plus
affected operator and testing instructions. Preserve this decision status until
there is evidence of human acceptance.

Required proof includes:

- Reject invalid and unknown nested fields, invalid inheritance, and unsupported
  saved runtime configuration. Validate without a catalog reader.
- Deploy through the supported Agent workflow, including a plugin-free Codex
  Agent. Verify the saved profiles reach generated native configuration and
  remain unchanged after Driver configuration changes.
- Verify native TOML parsing and preserve the probe's explicit restrictions,
  endpoint, failure handling, and readiness conditions. Cover fresh startup and
  retained generated configuration, with authentication before configuration
  installation and failed authentication preventing the model probe.
- Run the actual emitted OCE probe with the authorized named service-account
  token and native CLI. Compare a baseline with no definitions against the fixed
  generated configuration. Keep tokens, private profile names, and raw diagnostic
  output outside Git; retain only sanitized outcomes.

Named-token success does not establish that CI supplies an equivalent token or
policy. Report that separate proof gap. Fixture tests do not establish native
model execution or production deployment. No proof is claimed by this proposal.

## Alternatives

Reading live Driver configuration is smaller but breaks revision immutability.
Copying every Driver startup setting leaks unrelated configuration into revisions.
Using an Agent configuration hook would mix operator-owned definitions with
Agent-authored values and obscure the existing Plugin Driver rendering boundary.
The narrow snapshot keeps those owners distinct without introducing another
platform resource or persistence table.

Raw TOML would expose much more configuration than this task needs and permit
conflicts with generated settings. Hardcoded profile names would couple OCE to
one operator. Neither approach is needed for the observed failure.
