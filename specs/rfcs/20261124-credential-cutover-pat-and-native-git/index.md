---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# Credential cutover: Codex PAT and Dedicated OpenClaw native Git

This RFC extends [Credential Design 1.0 (#7234)](https://github.com/openclaw/openclaw-enterprise/pull/7234) with two proposed cutover decisions:

- [Adopt an existing Codex PAT Source](codex-static-pat.md) into TokenService custody and deliver it to Dedicated Codex through Credential Proxy.
- [Place Dedicated OpenClaw and native Git](dedicated-openclaw-native-git.md) in the same qualified Sandbox so an Agent can combine model, Plugin, and Repository credentials.

The proposals are submitted in [#7217](https://github.com/openclaw/openclaw-enterprise/pull/7217). Implementation and live qualification remain separate.

## Lifetime of Source-backed Repository policy

An Agent revision using a shared TokenService Source records the approved Repository policy with a deadline only for a grant that has an explicit expiry. Native Git remains authorized during that deployment until the OpenClaw Control Plane withdraws the grant or its deadline passes. Legacy Repository sessions keep their configured deadlines, and TokenService continues to renew the separate GitHub installation token, which typically expires after one hour.
