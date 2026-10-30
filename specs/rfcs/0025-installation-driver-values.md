---
status: Proposed
implementation_status: Implemented
author: kevinlin-openai
---

# Proposal: Inspect accepted Installation Driver values

- **ID:** RFC-0025
- **Created:** 2026-10-29
- **RFC PR:** [#4092](https://github.com/openclaw/openclaw-enterprise/pull/4092)
- **Related:** [RFC-0022](0022-driver-configuration-contributions.md)

## Summary

Show accepted Driver startup values through one shared serializer using the
existing `configurationSchema`. Values are visible unless a schema
marks them `writeOnly: true`. The serializer replaces marked fields or complete
subtrees with the existing string marker `[redacted]`. Remove the per-Driver
projection methods and field allowlists. Keep the approved Fields/JSON Console
layout and existing Installation administrator authorization.

## Motivation

Installation administrators need configured values rather than schema definitions.
The first implementation added a separate projection method and copied field
inventories into each Driver. The existing schemas already describe the accepted
configuration. Standard `writeOnly` annotations let each owner identify confidential
fields without maintaining another public interface or an exposure allowlist.

This active proposal revises its earlier callback design. It changes
[RFC-0022](0022-driver-configuration-contributions.md#discovery-preview-and-editing)'s
schema-only inspection boundary while preserving that historical RFC.

## Proposal

Each Driver marks secret-bearing fields and opaque blocks in its existing
`configurationSchema` with `writeOnly: true`. Ordinary unmarked fields remain
visible, including dynamic keys and values accepted by an open nested object.
A marked object or array becomes one `[redacted]` value: its children and dynamic
keys do not appear. `writeOnly: false` cannot cancel a true annotation from another
schema branch. The string `[redacted]` is reserved for hidden values in this
inspection response; the Console renders it as **Hidden for security**.

Bundled schemas must mark operator resource bodies, confidential free-form maps,
and certificate bodies previously hidden by projections. Credential file paths
and other approved references remain visible, without reading their contents.
Where existing protection depends on a value, mark the containing field. For
example, Sandbox endpoint hosts can contain credential-bearing URL text, so the
host field is write-only even when a particular configured host is not sensitive. Removing a callback must not remove its protection.

The shared serializer walks only accepted values that are actually present. It
preserves JSON types, arrays, nesting, empty values, and ordinary unmarked fields.
It does not insert defaults or examples, resolve secrets, read files or environment
variables, or call providers. It follows references and schema branches through the existing resolver and
walker. An annotation in any alternative at a value path wins, even when another
branch could expose that value. This deliberate over-redaction avoids selecting
validation branches or building another schema evaluator. Ordinary paths with no
write-only annotation remain visible.

Inspection supports properties, pattern and additional properties, item and tuple
schemas, references, and composition keywords, combining redaction annotations conservatively. Schema-valued
`unevaluatedProperties` and `unevaluatedItems` require evaluated-location tracking;
encoded `contentSchema` objects require parsing nested content. These forms are
outside this serializer's scope. Such a definition reports values
unavailable rather than exposing raw input. Boolean forms need no redaction
traversal. Other inspection errors also fail closed without exception text.

Composition captures the redacted snapshot after startup validation and before
passing the accepted input to constructors or package factories. Factory mutation
cannot change the accepted values shown to an administrator. The constructor's
own input and lifecycle stay unchanged. The registry receives only the immutable
redacted snapshot, never the raw configuration. Startup-file edits take effect
only after restart; persisted Driver records and constructor defaults are not
inspection sources.

`GET /installation/driver-configurations` retains its Installation `administer`
check and optional `startupConfiguration` object. Missing means inspection is
unavailable, including a fully write-only root; `{}` means an available empty
object. Package Drivers use the same serializer with no projection callback.
Identity, scope, key, schemas, and existing actions remain unchanged. Agent
configuration discovery does not return startup values. There are no new writes,
grants, persistence, or configuration editing controls.

## Delivery and verification

Submit this revision before implementing its changed Driver contract. Remove
`projectStartupConfiguration`, its bindings and forwarding, `pickConfiguredFields`,
and handwritten projection trees. Update the owning current reference and flow.
The approved Console needs no redesign.

Extend the real startup and authorized API integration to prove unmarked values,
package behavior, marked fields and opaque blocks, snapshot isolation from factory
and file changes, and authorization denials. Shared redactor cases cover nested
arrays and objects, references and conservative branch handling, true-annotation precedence,
and failure without raw fallback. Remove obsolete missing-callback and callback
failure tests. Retain the meaningful Console interaction regression and refresh
media if its visible result changes. Fixture UI and in-memory API proof do not
establish live Kubernetes, gateway, or model execution.

The implementation now uses the shared serializer and annotated schemas. The
[Driver reference](../../docs/reference/drivers/selection.md#configuration-definitions-and-discovery)
owns the current contract; the approved Console layout remains unchanged.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-29: Replace per-Driver projections with shared opt-out serialization using schema `writeOnly` annotations.

- 2026-10-29: Renumber the provisional RFC-0024 to preserve the ID assigned on main.

- 2026-10-29: Propose Driver-owned inspection of accepted startup values.
