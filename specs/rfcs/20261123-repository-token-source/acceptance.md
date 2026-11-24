---
rfc: index.md
---

# Acceptance criteria and delivery of the repository token Source

This companion holds the acceptance criteria and the delivery status of [RFC-20261123-repository-token-source](index.md). Goals G1 to G5 are defined in the [RFC entry point](index.md#goals); installed copies, replacement, serialization and retirement are in [the lifecycle companion](lifecycle.md).

## Acceptance Criteria

Use an installed OpenShell environment, a controlled Git origin that accepts fake token values, regular saved Agents and an authorized Admin. AC-1 to AC-6 keep their numbers and are extended; AC-7 to AC-10 are new.

- **AC-1 (G1, G5).** With a Source-backed registration, repeat AC-1 and AC-2 of RFC-20261119 for Git: A read, B write, C none; forbidden operations are denied with zero origin requests; narrowing is confirmed by readback. Carry forward its AC-3 and AC-4 for the Source Provider: direct REST and GraphQL requests are denied with zero upstream requests, the Provider has zero endpoints, and the Sandbox binds exactly the saved repository paths to it. The App journey passes unchanged.
- **AC-2 (G2).** After deploy, after replacement and on a peer Agent, the token is absent from the Sandbox's process environments, command lines, Git configuration and files.
- **AC-3 (G3).** `PATCH` a new value; the origin receives it without a redeploy. Record replacement committed, delivery pending and delivery confirmed as separate timestamps; confirmed follows the target Sandbox's applied-generation report, and the policy read shows pending, then confirmed. After the replacement, repeat the AC-1 boundary checks: REST and GraphQL denials with zero upstream requests, zero Provider endpoints and the exact Sandbox binding. A classic token is refused at `PATCH`, and the earlier value keeps working.
- **AC-4 (G4).** Serialize native Provider writes with Source replacement and retirement. Exercise a paused Worker across replacement and across retirement. Make a Provider write whose response is lost: `PATCH` with a new value and `DELETE` answer `409` until the Worker reads the Provider back and reconciles, also across a Worker restart, and the late write never extends access beyond 15 minutes after its authority check or past the grant's expiry. A stale write never extends access or restores the old value after rotation.
- **AC-5 (G4).** Prove the 15-minute bound with a saved Agent whose Worker cannot renew and a fake token the test origin still accepts. The supervisor stops injecting at expiry, and a peer Agent is unaffected by the withdrawal. The bound stays provisional until observed.
- **AC-6 (G4).** Each refusal in [the save table](index.md#save-and-deploy) answers as listed at save and deploy, including differing registration permissions and a deploy with no saved policy, which never falls back to legacy delivery. Removing the Agent principal's `operate` refuses the next loan. With the Source missing, not `ready`, and with the caller's `operate` removed, clearing the saved grants succeeds and Stop retires the Sandbox. A policy reader without `credential_source:read` sees the saved grants and no Source ID, name, state, ceiling, effective access or delivery state. `DELETE` answers `409` while the registry names the Source. After Stop, no request receives the token.
- **AC-7 (G2).** For a bound and an unbound Source, `PATCH` that adds `github`, removes it, replaces it with another preset or clears `config` answers `409` and leaves the Source unchanged. A `github` Source is refused as Harness authentication and in an Agent's `credentialSources`.
- **AC-8 (G4).** Deploy a Source-backed Agent, remove the Source from the registry and restart the controller and Worker. While the Agent keeps running, `DELETE` answers `409` naming the unretired copy, and after the last loan ends the Sandbox's Git requests no longer receive the token. After Stop or a redeploy without the Source, the Worker confirms the Provider retired and `DELETE` succeeds. Repeat with a deployment still pending at the registry removal, and with the Worker stopped during retirement and restarted.
- **AC-9 (G5).** Install with a Source-only registry and no App key Secret or Helm App-key values. The controller and Worker start, and a saved Agent performs a Git read and a write. A registry with App fields and no key refuses start, and an App-backed installation keeps its key validation.
- **AC-10 (G1).** Two registrations select the same Source with contents read and contents write. Saving and deploying an Agent bound to both answers `409` naming the differing permissions; with identical permissions and saved grants A read and B write, the deploy succeeds and AC-1's enforcement holds.

## Delivery and verification

Implementation proceeds in parallel with this review, in three draft PRs: Source enrolment for Git (inert alone), native Git delivery with the saved-Agent tests, and the policy read, Console and docs. No criterion has run on this design; the file-based prototype is partial evidence for AC-1 to AC-3.

Implemented in a draft: the optional Helm App-key values and start without an App key (AC-9), in [#7153](https://github.com/openclaw/openclaw-enterprise/pull/7153). Implemented on a branch not yet merged into #7153: the copy record created at deploy, its retirement by the Worker with read-back, and the `DELETE` `409` that reads it (AC-8). Not yet implemented in any draft: the uncertain-write fence with its `PATCH` and `DELETE` refusals (AC-4), and delivery state and the Source metadata in the policy read (AC-3, AC-6).
