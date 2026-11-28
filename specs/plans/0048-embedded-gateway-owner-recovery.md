---
rfc: ../rfcs/0021-managed-runtime-mode/index.md
---

# Prevent competing writers during embedded Gateway recovery

- **ID:** TASK-0048
- **Delivery status:** Planned
- **Source baseline:** `3cf3b894896a7d6c87d7016792537377cdeb3d37`

After an unclean stop, OC can find a Gateway lock on the Agent’s retained volume but cannot tell whether the holder has exited. Managed mode can ship with operator recovery. For new embedded deployments, an operator verifies that the old workload stopped and confirms the fingerprint of its locks before starting the replacement. This applies with managed mode on or off. At OCE `ef236876`, the image test waited for automatic takeover and the first chat never ran. In a separate Docker run with the packaged OC `9cc4450e`, the replacement answered its first chat with HTTP 200 and `READY` after operator confirmation. [Managed mode #2982](https://github.com/openclaw/openclaw-enterprise/pull/2982) · [Earlier restart failure](https://github.com/openclaw/openclaw-enterprise/actions/runs/40373715330/job/121751158800)

OCE #2633 implements unattended recovery when OC can match every lock holder to a container that Compute has verified stopped. Docker Compute checks the observed container ID, start time, exit and local volume. Kubernetes can recover the first Gateway container’s locks after a kubelet restart in the same eligible Pod. A lost Docker observation, a later Kubernetes owner or a new Pod still requires operator confirmation if owner records remain. Both provider cases answered their first post-restart chat in CI at `bb403839`. Dedicated Gateway recovery has its own workstream. [Embedded recovery #2633](https://github.com/openclaw/openclaw-enterprise/pull/2633) · [Passing restart checks](https://github.com/openclaw/openclaw-enterprise/actions/runs/40373315350/job/121750406274) · [Dedicated recovery #3355](https://github.com/openclaw/openclaw-enterprise/pull/3355)

## Proposed storage protection

Compute and runtime owners can review this follow-up independently of both PRs. It asks whether the provider can also prevent another workload from writing anywhere on the retained volume while the Gateway recovers. Start with an OCE-owned local volume on one Docker Engine. [Docker Compute lifecycle](../../apps/controller/src/drivers/compute/docker/index.ts)

On Docker Engine 29.9.0, a stopped Gateway held its container name and was the only listed attachment to its volume. A differently named initializer then mounted the volume and wrote a marker that a separate reader could see.

**Open decision.** How can Compute prevent the workspace initializer and other Docker clients from mounting the volume for writing between lock inspection and the end of native startup? The provider must identify the same volume and control every path that can attach a writer. On Kubernetes, it would also need to maintain that protection across forced Pod deletion or node loss. Several Pods on one node can mount a `ReadWriteOnce` claim. [Kubernetes storage contract](../../docs/reference/drivers/kubernetes-compute/storage-and-credentials.md)

## Verification for the follow-up

Use disposable retained state. While a replacement recovers, try the same competing mount and write that succeeded in the Docker experiment. Verify either that the other workload cannot write or that Compute refuses recovery while a competing writer has access. Then verify that the replacement on the intended volume answers its first chat after readiness. The existing stopped-owner checks and operator fallback still apply. Review the provider mechanism with Compute and runtime owners before implementing it. [RFC process](../../docs/contributing/rfcs.md)

## Changelog

- 2026-10-26 21:53 UTC — Scoped the follow-up to competing volume writes and recorded the operator and provider recovery paths.
- 2026-10-26 18:18 UTC — Updated the release evidence to OCE `ef236876`.
- 2026-10-26 17:09 UTC — Proposed embedded recovery against `3cf3b894` and recorded the Docker experiments (Codex/01a1558e-c27f-7bc0-a403-af59e9364ddf).
