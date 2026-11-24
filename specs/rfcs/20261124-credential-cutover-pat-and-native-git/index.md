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
