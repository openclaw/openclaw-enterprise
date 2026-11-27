---
rfc: ../rfcs/20261126-credential-source-consolidation.md
---

# Implementation plan for Credential Source consolidation

- **ID** RFC-20261126-credential-source-consolidation
- **Delivery status** Planned.
- **Source baseline** `feb8e7e6e81cb98745a7ed301cd9e4230610ade0`

Users manage credentials in one Credential Source inventory. Slack user and
channel IDs stay in Configuration. TokenService keeps private Source and Client
storage. Compute keeps its workload delivery copies.

## Delivery order

1. **Move remaining callers.** Use exact Source references for model auth,
   Presets, guided provisioning, authenticated Gateway channel egress, and
   Gateway startup credentials. Keep provider credentials within the admitted
   recipient. The [current draft](https://github.com/openclaw/openclaw-enterprise/pull/7486)
   includes the Envoy, prebound Preset, guided dedicated model, and Slack
   upgrade changes.
2. **Qualify embedded model delivery.** Worker resolves the admitted Sources.
   Compute puts the values in the revision's Gateway Secret and starts the
   testing-only embedded Pod with its normal credential inputs. Verify an
   OpenClaw turn with its configured endpoint, update on managed redeploy,
   and withdrawal and cleanup while a second Agent keeps using the Source.
3. **Discard old records.** Retire revisions and settle queued work that use
   legacy bindings before dropping them. Check owner identity and confirm old
   material is absent before deleting its public record. A failed confirmation
   retains the record. Keep the schema removal blocked while public data remains.
4. **Remove the public surface.** Remove Namespace Secret CRUD and permission
   routes, binding shapes, grants, persistence, CLI commands and generated
   contracts, and the whole legacy Credentials section. Keep historical audit
   records readable. Verify real Source enrollment and reuse in the Console
   and that the old HTTP paths are gone. Confirm private Source and Client
   storage and Compute delivery still work after the schema change.

## Release gates

- A running Agent that the new version cannot redeploy blocks the upgrade
  before its first Stop. Users recreate credentials as Sources.
- A supported authenticated Envoy runtime proves use, refusal without
  fallback, and slot cleanup on retirement. Gateway startup and model delivery
  each need their own runtime proof.
- The isolated LAB update follows a reviewed candidate with green checks and
  current Credentials screenshots and walkthrough.
