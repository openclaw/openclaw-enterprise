---
published: false
---

# Harness Authentication Binding documentation history

This record preserves the dated changes to the harness authentication binding flow. See the [parent page](../native-service-account-credential-delivery.md) for its context.

## Changelog

- 2026-10-09 16:40: Replace the OAuth writer Deployment with a bounded Job and persist terminal failure with resumable cleanup in the accompanying change. (authoring-run/991ba230-4db6-45cb-8456-7561ee7bd446 - f92cf60b2ae4740a93bdd41e94e8f1c7fc92218f)

- 2026-10-09 17:37: Trace Refresh-owned device authorization in the accompanying merge. (01a11d95-ebef-76e1-b9b9-9d3d2e88e99e - 1c2fbd2bc2953430e3ddaf68882176c6943ea7b2)

- 2026-10-07 16:05: Select Harness authentication by source ID and validate the complete credential attachment set. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - 046c3d75e)

- 2026-10-07 13:44: Reject imported and managed PAT bindings outside dedicated Codex during admission. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - 09be9c241)

- 2026-10-07 12:07: Unify imported and managed PAT authentication while preserving source ownership and existing OAuth behavior. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - be5006e62)

- 2026-10-07 17:36: Replace runtime-owned OAuth custody with source-owned device login and warm discovery; unify PAT sources. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - da984340ae4aafb03bb0c66bfd94ba40252625a5)

- 2026-10-07 16:53: Normalize managed and supplied service-account credentials to token-only Codex login while preserving control-plane workspace ownership. (01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - daeb19dfb3aef5f083a73f25674bced40986f8d1)

- 2026-10-03 15:38: Merge current credential flow while preserving shared-namespace source placement. (01a0fe72-58b2-7cc3-b770-7310f5401deb - 94364ae9)

- 2026-10-02: Clarify shared namespace source custody. (01a0fe72-58b2-7cc3-b770-7310f5401deb)

- 2026-09-30 17:30: Preserve persistent OAuth startup alongside filtered Codex child environments in the merge integration. (codex/01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - c724fb7fee3790d9c122eb7dc2563869bad4a56e)

- 2026-09-30 23:49: Document the dedicated Codex transport-token child boundary in the accompanying change. (authoring-run/134e3f48-c97b-43d0-93ea-84497c29c940 - 704da0b47ea1973e4a9e7d18ef13d44414691eda)

- 2026-09-30 17:23: Remove the Installation opt-in for Codex device login while retaining Experimental status and topology checks in the accompanying change. (codex/01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - 9ae40ce59eadfd03d52c78086de92f0034dd9974)

- 2026-09-30 04:00: Record OAuth opt-in, admission topology check, clean reseed, and codex-home removal on method change. (aligner-524 - 591f553f6)

- 2026-09-29 03:12: Preserve persistent OAuth startup alongside bounded model-probe timeout recovery in the merge integration. (codex/01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - 64610f19dfec8996acab483c7bb4916be36a31a1)

- 2026-09-29 03:01: Keep OAuth source custody on control and bootstrap storage on execution when integrating explicit Kubernetes namespace addresses. (codex/01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - 7f02154e282919a033f7600daaf9f86972d21ac2)

- 2026-09-28 18:45: Document bounded Codex model-probe recovery and sanitized attempt evidence in the accompanying change. (authoring-run/3b7cc615-9e7b-416a-aec7-fe13c38cace1 - a14435c81e0d4020dd24568babddf95aba533da7)

- 2026-09-28 04:28: Add device acquisition, catalog use, and one-time persistent OAuth handoff in the accompanying change. (codex/01a0e5ec-d802-7800-9eb6-8022c1ac0d06 - ae31581574744bea2745066f189eea6e826fe823)

- 2026-09-23 12:22: Move canonical credential sources to CP and describe revision-scoped Harness delivery in the accompanying change. (codex/01a0cf72-6985-7712-ba92-d8cc32470f24 - 623d56dec26a8ef0f72b562254687cabecdbbf82)

- 2026-09-23 20:27: Filter OpenAI API-key discovery by provider-reported shutdown dates in UTC. (01a0cf27-71c6-7042-8357-74d1811a2ef8 - 9e0095c7)

- 2026-09-23 09:00: Extend exact Secret admission, retention and dedicated native login to directly supplied Codex PATs. (01a0cce9-23e3-7072-aa3f-a2e26d2dbf11 - c5524b59)

- 2026-09-23 06:27: Derive API-key credential delivery and startup probing from the selected model provider. (01a0cce9-23e3-7072-aa3f-a2e26d2dbf11 - a8272f4e2760e5ff06dc09c5658f48bea382c790)

- 2026-09-17 19:14: Add runtime binding admission and worker behavior without managed source delivery. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - b8cabaf9a49e069a7668ccf88b9e71a7484227b7)

- 2026-09-17 02:58: Remove embedded preflight and document one actual-gateway startup check with accepted replacement downtime. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - cfb384f22ebcbadcfb421b3020b4bb72fd657160)

- 2026-09-17 01:10: Trace bounded native model probes and predecessor-preserving embedded authentication checks. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - 177a24e4)

- 2026-09-17 00:48: Correct current harness admission and metadata-only dispatch boundaries after implementation review. (01a0acbf-4d5a-7413-9411-dce911f3ad23 - 107900e9551b90c3e9ac24d30f8ea866f17e5dbb)

- 2026-09-17 00:30: Unify Secret-backed keys and issued account credentials through immutable Agent harness authentication and workload rendering. (01a0acc2-a404-77e3-b1a0-9fa4ffbbdb04 - d2bcbd1c53acb2582a774b5158f254d726abd33f)

- 2026-09-01 19:09: Clarified native API-key source Secret references and linked the separate OCC Secret delivery path. (01a05f95-dd80-7011-990f-d1c46b5bb3cc - aa366c49c44834d59f74994c5fd37fb8096f169f)

- 2026-09-01 08:47: Preserve providerless API-key execution and document Provider metadata checks before workload effects. (01a05d97-f2b0-71d0-bfc3-01ee7d6d58f9 - b079c4b755ef336a9c65bb4eb737e3aedbfdaa7d)

- 2026-08-28 17:58: Updated moved feature-reference links for the documentation organization. (01a036f4-cf1d-7cc1-bbc1-000879038ac8 - 4270aa29b7015562049f46c6027962fd85b584a9)

- 2026-08-24 20:03: Documented native account authorization, immutable deployment snapshot, independent exact-Secret materialization, harness-specific credential projection, and genuine dual-runtime verification. (01a03542-30ff-77a1-9967-587d55548ace - 6ff8b1b)

- 2026-08-24 21:11: Condensed account delivery, exact authorization, stale-secret handling, worker revocation, and dual-runtime proof. (01a0355c-d4b3-7342-bdc2-3c96af543416 - 1aa89e8)
