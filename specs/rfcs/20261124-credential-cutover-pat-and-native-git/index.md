---
status: Proposed
implementation_status: Not implemented
author: stevenlee-oai
---

# Credential cutover: Codex PAT and Dedicated OpenClaw native Git

This RFC extends [Credential Design 1.0 (#7234)](https://github.com/openclaw/openclaw-enterprise/pull/7234) with two proposed cutover decisions:

- [Enroll a Codex PAT Source](codex-static-pat.md) in TokenService and deliver it to Dedicated Codex through Credential Proxy.
- [Place Dedicated OpenClaw and native Git](dedicated-openclaw-native-git.md) in the same qualified Sandbox so an Agent can combine model, Plugin, and Repository credentials.

The proposals are submitted in [#7217](https://github.com/openclaw/openclaw-enterprise/pull/7217). Implementation and live qualification remain separate.

## Lifetime of Source-backed Repository policy

An Agent revision using a shared TokenService Source records the approved Repository grant, which remains valid until the OpenClaw Control Plane withdraws it or its explicit deadline passes. Each native Git request still requires a valid credential from the selected Source and must match the saved Repository policy. Legacy Repository sessions keep their configured deadlines, and under this design TokenService renews the separate GitHub installation token, which typically expires after one hour.
