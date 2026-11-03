---
rfc: index.md
---

# OCE managed mode for Gateway administration

This companion extends [RFC-0021](index.md) to direct human administration. OCE admins define the Agent's desired configuration, and OCC owns its deployment. A Gateway admin may also have permission to change OC directly. Managed mode is an OCE deployment setting that restricts those human actions while it is enabled.

Managed mode defaults on. Only an authorized OCE admin can change it; Gateway privileges cannot change or bypass the setting. Turning it off lets authorized Gateway users experiment with local configuration without updating the OCE deployment each time. Existing Gateway permissions and deployment limits still apply. Local edits do not change OCE's desired state and may be lost on redeployment. When turning managed mode back on, stop further Gateway-local admin mutations and quiesce or contain prior Gateway-hosted admin execution. Report the mode active only after restoring OCE's desired configuration and applying the restrictions.

OCE installs the saved Gateway tool policy in both modes. With managed mode off, an authorized Gateway admin can explicitly widen the local allowlist. After a native Gateway restart, subsequent model turns can use the newly allowed tools, including turns started by other people. Asking the Agent to act still uses the active tool policy. Redeploying with managed mode on restores the saved policy and blocks further local config writes.

## Initial restrictions

1. **Reject Gateway config writes.** OCE sets `OPENCLAW_CONFIG_READONLY=1` on the managed OC Gateway process for every launch and respawn, even if the effective config is writable. Clients using Gateway RPCs inherit the Gateway's guard; a CLI that writes configuration directly needs an OCE-controlled launch that enforces the same flag. Trusted OCE preparation must still be able to generate configuration. [OC config-write guard](https://github.com/openclaw/openclaw/blob/f8386bc7df0a6c9eda7a28ae81943c5c06a414ff/src/config/config-write-guard.ts#L45).
2. **Deny Gateway-local administrator terminals.** OC must enforce the denial at the server for direct and catalog terminal paths, including access to existing local sessions. Keep separately authorized node-relayed terminals and Harness-local shell work available; disabling the entire terminal feature would also remove node-relayed terminals. [OC terminal admission](https://github.com/openclaw/openclaw/blob/f8386bc7df0a6c9eda7a28ae81943c5c06a414ff/src/gateway/server-methods/terminal.ts#L169).
3. **Deny Gateway-hosted command jobs.** OC must reject human creation, conversion, modification, enablement, manual runs and scheduled execution of jobs that run commands on the Gateway, including jobs created before managed mode was enabled. Classify the whole job by where commands execute: on-exit and stream schedules can run Gateway commands even when the payload starts an Agent turn. Preserve ordinary timed Agent turns and trusted OCE operations. The P0 automation restriction separately applies to model-directed work. [OC job classification](https://github.com/openclaw/openclaw/blob/f8386bc7df0a6c9eda7a28ae81943c5c06a414ff/src/gateway/server-methods/cron-caller-scope.ts#L299), [on-exit watcher](https://github.com/openclaw/openclaw/blob/f8386bc7df0a6c9eda7a28ae81943c5c06a414ff/src/gateway/cron-exit-watchers.ts#L245), [stream source](https://github.com/openclaw/openclaw/blob/f8386bc7df0a6c9eda7a28ae81943c5c06a414ff/src/gateway/cron-stream-job-owner.ts#L389).

When a direct administration request is denied, the Gateway should explain that the change belongs in OCE and that only an OCE admin can disable managed mode.

## Coverage and remaining decisions

The config writer covers configuration saves and config-backed Agent, plugin and skill changes. It does not freeze all Gateway state. An operation that changes another resource before attempting a config write needs admission before its first effect if OCE owns that resource.

Actions outside the initial bundle require an ownership decision before restriction:

- Plugin reload and refresh, skill installation and software lifecycle can affect loaded code, assets or the Gateway process. Distinguish Gateway-owned resources from work in a separate Harness workspace and preserve trusted recovery.
- Standing execution approvals, pairing, roles and credential bindings can change authority outside the main config. Preserve trusted provisioning, bounded approvals and required credential refresh.
- Session and workspace operations must remain within mandatory Harness limits. Ordinary session and project work remains available; Agent document content remains out of scope.

## Configuration changes and protection

Keep the Gateway configuration watcher enabled. OCE uses live configuration application when a workspace node becomes available after Gateway startup and must confirm that the file-transfer plugin activated. Disabling the watcher would prevent that trusted update. The watcher observes the effective config and included files; valid changes may apply to the running Gateway or require a restart depending on the changed key. Invalid changes leave the last accepted runtime snapshot active. [Workspace-node binding](../../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts#L2966), [OC reload behavior](https://github.com/openclaw/openclaw/blob/f8386bc7df0a6c9eda7a28ae81943c5c06a414ff/src/gateway/config-reload-plan.ts#L152).

Workspace instructions, plugin code and operational stores follow their own activation paths; they are not all read again on the next Agent turn. The read-only config flag controls writes through OC's writer. It neither stops file observation nor protects separate stores or in-memory state.

Filesystem protection can remain follow-up hardening only if the initial managed-mode controls close administrator-reachable paths to the protected configuration. If the required guarantee is that the Gateway process and code running under its identity cannot change OCE-owned configuration, filesystem protection or equivalent separation of write authority is required. Protect the effective config, its parent and replacement paths, and included files; keep operational state writable and preserve trusted OCE configuration generation and recovery. Disabling reload would not protect the stored configuration.

## Qualification

Qualify the integrated behavior with the actual OCE image, OC binary, permissions and mounts. Verify that only authorized OCE admins can change the mode. With managed mode on, test local config writes, local terminals and Gateway-hosted commands, including preexisting jobs and watchers. With it off, have a Gateway admin explicitly add an excluded tool and verify a subsequent model turn can call it after a native restart. Redeploy with managed mode on and verify the same call is denied while a permitted call succeeds. Also check that launch, trusted live updates and recovery preserve the selected mode, and that permitted node terminals, timed Agent turns, Harness work, sessions and credential refresh continue to work.
