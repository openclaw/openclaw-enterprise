---
rfc: ../rfcs/0021-managed-runtime-mode/index.md
---

# Recover an embedded Gateway after an unclean stop

- **ID:** TASK-0048
- **Delivery status:** Planned
- **Source baseline:** `3cf3b894896a7d6c87d7016792537377cdeb3d37`

An embedded Agent can lose its Gateway container and retain its SQLite databases and owner locks. The replacement sees an owner from another PID namespace. A stale heartbeat cannot tell it whether that process can still write. The pinned OC therefore refuses takeover. OCE should recover unattended when Compute can prove the previous workload stopped and exclude every other writer until the replacement has taken custody. Otherwise the operator must verify ownership before confirming recovery. [Managed-mode failure](https://github.com/openclaw/openclaw-enterprise/actions/runs/40007750867/job/120629137870) · [Harness-policy failure](https://github.com/openclaw/openclaw-enterprise/actions/runs/40020642283/job/120644075211)

## Proposed first implementation

Qualify one Docker Engine managing a new, local, OCE-owned Agent state volume. The embedded Gateway and model run in the same workload. Files on that volume and replies from that Gateway cannot establish who else can write it. Compute must establish exclusive access outside the workload.

1. At creation, record the volume's identity and embedded origin in protected control-plane state. Admit only a deployment in which Compute controls every way to mount the volume. Inventory the Gateway, workspace initializer and any prior Harness. A volume name, Agent label or a one-time list of mounts cannot prevent a concurrent attachment. State once shared with a dedicated Harness or an unreviewed writer requires operator recovery.
2. When replacing the Gateway, record Engine's terminal state for the exact container ID and start time before removing it. Reserve the per-Agent Gateway slot and exclude every competing attachment or restart for the duration of handoff. The initializer uses a different container name, so reserving the Gateway name alone is insufficient. A missing container, stop request or elapsed deadline leaves custody unresolved. [Docker Compute lifecycle](../../apps/controller/src/drivers/compute/docker/index.ts)
3. Before running any model-controlled code, the replacement's image-owned bootstrap verifies that it holds the same volume exclusively. With reviewed paths, a trusted OC binary and no configuration or plugins from the retained workload influencing recovery, inspect the locks and pass the fresh fingerprint to `openclaw gateway recover-lock --confirm <fingerprint>`. Stop if the snapshot changes or OC finds a live owner. Keep exclusive access through native startup and Agent database inspection. The first chat after readiness must succeed on that same state. [OC recovery implementation](https://github.com/openclaw/openclaw/blob/9cc4450e9d79a993a51dc6fa362468f46c6f1819/src/infra/gateway-lock-recovery.ts)

**Decision for Compute and runtime owners.** Which deployment mechanism can enforce exclusive attachment across the Gateway, initializer and any other daemon clients throughout handoff? A disposable Docker Engine 29.9.0 experiment held the Gateway name on the stopped container and verified it was the volume’s only attachment. A differently named initializer then mounted and wrote the same volume. An independent reader saw the write. This excludes name reservation and a one-time inventory as sufficient mechanisms. Keep automated confirmation disabled until a provider enforces exclusivity. For Kubernetes, record kubelet-observed termination for the exact Pod UID and container ID and separately qualify fencing of the retained PVC across node loss or forced deletion. The current `ReadWriteOnce` claim does not establish that fence. Each provider needs its own qualification. [Kubernetes storage contract](../../docs/reference/drivers/kubernetes-compute/storage-and-credentials.md)

## Coordination and acceptance

This work unblocks upgrades shared by [OCE #2982](https://github.com/openclaw/openclaw-enterprise/pull/2982) and [OCE #2633](https://github.com/openclaw/openclaw-enterprise/pull/2633). Coordinate exact container termination checks with [dedicated recovery #3355](https://github.com/openclaw/openclaw-enterprise/pull/3355). Keep its private-state provenance scoped to dedicated deployments. If the provider proves exclusive custody of the entire embedded state volume, OC's existing fingerprinted CLI can bind confirmation to the current locks. If that proof is absent, structured owner observations from [OC #181813](https://github.com/openclaw/openclaw/pull/181813) alone still cannot authorize embedded takeover. Submit the change to required Compute behavior for [RFC review](../../docs/contributing/rfcs.md) before implementing it.

Keep two release checks:

- **Image.** Exercise a live foreign owner, an unclean stop and native database recovery on the retained image state. With independent confirmation of the stop, send the first chat immediately at readiness. Verify HTTP 200 and the controlled provider's response. On OC `9cc4450e`, a disposable Docker run with 1 CPU and 4 GiB refused the live contender, then returned HTTP 200 and `READY` after explicit operator confirmation. This qualified the operator path. The repository's [raw-image regression](../../tests/integration/runtime-image-gateway-unclean-restart.test.mjs) still expects automatic takeover from heartbeat age.
- **Compute.** Exercise the real replacement lifecycle without operator confirmation or artificial heartbeat aging. Kill the exact Gateway, preserve state, and require the first chat after readiness to return HTTP 200 and `READY`. Prove that a live second writer, a second attachment racing confirmation, a replaced volume, missing termination evidence or a changed fingerprint prevents clearance. Keep the unattended release gate until a qualified provider passes it.

## Changelog

- 2026-10-26 — Proposed embedded recovery against `3cf3b894` and recorded the operator-confirmed Docker experiment.
