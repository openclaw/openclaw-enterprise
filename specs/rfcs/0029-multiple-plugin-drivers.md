---
status: Proposed
implementation_status: Partially implemented
author: stevenlee-oai
---

# Select a plugin catalog for each Agent

- **ID:** RFC-0029
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

Each entry uses its existing configuration schema. Use a one-entry list for one catalog. Omitting the setting keeps plugin-free deployments available. Reject duplicate or unknown driver IDs at startup. List order carries no meaning. The API and worker must load the same trusted inventory. Installation administrators can inspect each registration under the existing authorization and redaction rules.

## Choose the driver

OCC selects `occ-plugin` for an OpenClaw Harness in embedded or dedicated mode, and `codex-plugin` for a dedicated Codex Harness. The Agent author chooses the Harness. The Installation operator chooses which catalogs to enable. With no matching driver, the Agent can deploy without plugins. Refuse nonempty selections and report catalog discovery as unavailable. Individual plugins retain their placement requirements. For example, Google Workspace still needs its supported dedicated OpenClaw placement and credential runtime.

OCC checks the Harness at Agent save, provisioning and deployment admission. The worker checks the pinned Driver before it replaces a running workload.

OCC stores the admitting Driver's ID and implementation with each nonempty Agent selection. Changing the Installation list or editing the Configuration must preserve that owner. To switch catalogs, the operator clears the previous selections and chooses plugins for the new Harness.

## Discover and deploy

Installation capabilities identify each enabled catalog and its discovery credential requirement. The create form derives its catalog from the chosen Harness. Namespace catalog and details requests must identify the target Harness before OCC opens a Secret or CredentialSource. If the target is missing or unsupported, refuse the request before provider access. Changing Harness discards results, cursor, selections and approvers from the previous catalog. Keep the current scope of saved-Agent catalog browsing and plugin placement. In particular, an embedded OpenClaw Agent must not receive the dedicated Google catalog. Saved-Agent requests derive the Harness and owner from server-side state. The caller cannot substitute another driver for saved selections.

Keep the existing Namespace, Agent and credential grants. For discovery that awaits a credential read, recheck both the authorized binding and the selected driver before giving a credential to the provider. A credential-free driver never receives a Codex discovery credential. Use the same driver for policy capabilities, placement, credential slots, configuration validation and any repository credential broker network policy that depends on plugin execution.

Admission already records the driver ID, implementation and requested plugin map on the revision. A worker preparing an admitted revision uses that exact identity. Reordering the Installation list or editing the Agent cannot redirect it. If the selected implementation is unavailable or incompatible, fail before replacing a running revision. A new deployment takes the current Agent selection through admission again.

## Verification before implementation review

1. Load both drivers in one Installation. Through the supported Agent APIs, discover and save Google on an eligible dedicated OpenClaw Agent and a Codex plugin on a dedicated Codex Agent. Admit both revisions and verify the distinct native plugin preparations in the worker. Test native use separately with an authorized Google operation and a Codex plugin tool result.
2. Verify that embedded OpenClaw accepts supported OpenClaw selections and refuses Codex plugins. Check repository broker network policy for dedicated Codex. Change the saved Agent's target during credential-backed discovery and verify that the wrong driver receives neither the credential nor the plugin selection.
3. Enable the second catalog for an existing single-driver Installation. Read and edit the existing selections, reorder the configuration and retry an admitted revision. Verify the same owner throughout. Remove its driver and verify refusal before cutover. Repeat a plugin-free deployment with the setting omitted.

## Implementation

[PR #4174](https://github.com/openclaw/openclaw-enterprise/pull/4174) implements Harness-based routing, persistent selection ownership and revision checks. The API, browser and PostgreSQL worker tests cover discovery, selection, and refusal before cutover. Live Google Workspace and Codex tool execution on the same Installation remains to be qualified.

## Manual Notes

[keep this for the user to add notes. do not change between edits]

## Changelog

- 2026-10-30: Propose per-Agent plugin catalog selection.
