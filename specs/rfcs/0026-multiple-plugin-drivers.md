---
status: Proposed
implementation_status: Partially implemented
author: stevenlee-oai
---

# Select a plugin catalog for each Agent

- **ID:** RFC-0026
- **Created:** 2026-10-30

## Decision for review

An operator should be able to enable both bundled Plugin Drivers in one Installation. OpenClaw Control Plane (OCC) selects the driver by Harness family. A dedicated OpenClaw Agent can then select Google Workspace through `occ-plugin`, while a dedicated Codex Agent selects a Codex plugin through `codex-plugin`. Each Agent's plugin selections belong to one driver. OCC uses that driver for discovery, policy and credential checks, and deployment.

The previous [Plugin Driver contract](../../docs/reference/drivers/plugin.md) gives the whole Installation one catalog. [The original milestone](../plans/16-plugin-driver.md) made this an explicit limit. The [managed native OpenClaw proposal](https://github.com/openclaw/openclaw-enterprise/pull/3142) covers Google placement and access. This proposal changes how an Agent reaches that catalog.

## Enable the catalogs

Accept a list of existing bundled driver selections under `drivers.plugin`. For example:

```yaml
drivers:
  plugin:
    - id: occ-plugin
      configuration: {}
    - id: codex-plugin
      configuration:
        catalogSource: openai-curated
```

Each entry uses its existing configuration schema. Keep accepting the existing single-object form. Omitting the setting keeps plugin-free deployments available. Reject duplicate or unknown driver IDs at startup. List order carries no meaning. The API and worker must load the same trusted inventory. Installation administrators can inspect each registration under the existing authorization and redaction rules.

## Choose the driver

OCC selects `occ-plugin` for an OpenClaw Harness in embedded or dedicated mode, and `codex-plugin` for a dedicated Codex Harness. The Agent author chooses the Harness. The Installation operator chooses which catalogs to enable. With no matching driver, the Agent can deploy without plugins. Refuse nonempty selections and report catalog discovery as unavailable. Individual plugins retain their placement requirements. For example, Google Workspace still needs its supported dedicated OpenClaw placement and credential runtime.

This narrows the [previous placement rule](../../packages/contracts/src/index.ts), which also permitted `codex-plugin` on embedded OpenClaw. Apply the new rule at Agent save, provisioning, deployment admission and worker preparation. Keep existing selections readable so an operator can clear them. Refuse a new deployment or retry of an embedded OpenClaw revision pinned to the Codex driver before any change to the running workload. Check the pinned driver even when its selection map is empty, since that revision can still mount a Codex credential broker bridge. A plugin-free revision with no such pin stays eligible. Keep historical revisions decodable for inspection, Stop, retirement and deletion. An operator can clear the incompatible selections and admit a corrected revision even when an older revision used the retired pairing.

Each nonempty plugin selection has one owner. Preserve that owner when enabling a second catalog or changing an Agent's Configuration. If an old selection has no stored owner, use its previous trusted single-driver registration only when that registration can be established for the selection. When the owner cannot be established, require the operator to clear the old selections and save a new selection. A historical revision with different plugin selections does not establish the current selection's owner. Never reclassify stored plugin IDs by name or by the new Harness alone.

## Discover and deploy

Installation capabilities identify each enabled catalog and its discovery credential requirement. The create form derives its catalog from the chosen Harness. In a mixed Installation, namespace catalog and details requests must identify the target Harness before OCC opens a Secret or CredentialSource. If the target is missing or unsupported, refuse the request before provider access. Existing single-driver callers may omit the target. Changing Harness discards results, cursor and selections from the previous catalog. Keep the current scope of saved-Agent catalog browsing and plugin placement. In particular, an embedded OpenClaw Agent must not receive the dedicated Google catalog. Saved-Agent requests derive the Harness and owner from server-side state. The caller cannot substitute another driver for saved selections.

Keep the existing Namespace, Agent and credential grants. For discovery that awaits a credential read, recheck both the authorized binding and the selected driver before giving a credential to the provider. A credential-free driver never receives a Codex discovery credential. Use the same driver for policy capabilities, placement, credential slots, configuration validation and any repository credential broker network policy that depends on plugin execution.

Admission already records the driver ID, implementation and requested plugin map on the revision. A worker preparing an admitted revision uses that exact identity. Reordering the Installation list or editing the Agent cannot redirect it. If the selected implementation is unavailable or incompatible, fail before replacing a running revision. A new deployment takes the current Agent selection through admission again.

## Verification before implementation review

1. Load both drivers in one Installation. Through the supported Agent APIs, discover and save Google on an eligible dedicated OpenClaw Agent and a Codex plugin on a dedicated Codex Agent. Admit both revisions and verify the distinct native plugin preparations in the worker. Test native use separately with an authorized Google operation and a Codex plugin tool result.
2. Exercise an embedded OpenClaw Agent with supported OpenClaw selections and a previously admitted embedded Codex plugin revision. Verify refusal of the incompatible revision before cutover and preserve the operator's ability to stop it, clear selections and deploy a corrected revision. Check the repository broker network policy on these paths. Change the saved Agent's target during credential-backed discovery and verify that the wrong driver receives neither the credential nor the plugin selection.
3. Enable the second catalog for an existing single-driver Installation. Read and edit the existing selections, reorder the configuration and retry an admitted revision. Verify the same owner throughout. Remove its driver and verify refusal before cutover. Repeat a plugin-free deployment with the setting omitted.

## Implementation

[PR #4174](https://github.com/openclaw/openclaw-enterprise/pull/4174) implements Harness-based routing, persistent selection ownership and revision checks. The API, browser and PostgreSQL worker tests cover discovery, selection, and refusal before cutover. Live Google Workspace and Codex tool execution on the same Installation remains to be qualified.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-30: Propose per-Agent plugin catalog selection.
