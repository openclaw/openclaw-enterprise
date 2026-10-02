---
rfc: ../rfcs/28-gateway-harness-storage-split.md
---

# Feature Spec: Initial Agent workspace files

**Date:** 2026-09-22\
**Status:** Implemented and reviewed; final verification in progress\
**Owner:** OpenClaw Control Plane (OCC) and Compute Drivers

## Problem and Decision

Allow a person creating a Claw to edit its four ordinary OpenClaw workspace
documents before its first run. The Console supplies the actual rendered defaults;
OCC accepts a create-only input and temporarily stages submitted bytes separately
from the Agent, Configuration, and AgentRevision. At first deployment, Compute
applies that input in the exact native workspace before starting anything that can
use it. After initialization, the gateway workspace owns the live files; setup
never restores them on restart or redeploy.

Today [Console creation](/apps/controller/src/console/agents/create.mjs#L385)
saves a Configuration and creates an undeployed Agent; [OCC](/packages/occ/src/index.ts#L1957)
starts it in desired state `stopped`. The [live editor](/docs/flows/workspace-files.md)
uses exact-Agent `agents.files.get` / `agents.files.set`, requires an active
revision, and treats uncertain writes as unknown. It cannot safely initialize the
first run. The separate [storage-split proposal](../rfcs/28-gateway-harness-storage-split.md#3-files-before-agent-creation-89)
already proposes first-start ordering and no replay; its future Harness-host
storage is not required here. Gateway authority does not dictate physical storage.

## Scope

- Create API and Console inputs for `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and
  `USER.md`; reliable first application for existing real Compute Drivers in the
  execution modes they support.
- No automatic deploy, new live editor, update-time reset, templates/presets,
  multi-native-Agent targeting, arbitrary file paths, or workspace content in
  Agent, Configuration, AgentRevision, or their read/list responses.
- `BOOTSTRAP.md` remains lifecycle-managed; `MEMORY.md` is special. `TOOLS.md`
  and `HEARTBEAT.md` are not setup fields. The [pinned OpenClaw source][native-files]
  lists the four ordinarily generated files; broader native names are not scope.

## Contract

### Creation and Console

- Add optional `initialWorkspaceFiles` to `POST /namespaces/:namespaceId/agents`:
  a closed partial object keyed by the four exact filenames, with string values.
  An omitted map, `{}`, or omitted key requests no override for those files;
  OpenClaw retains its own default behavior. Present `""` deliberately writes a
  zero-byte file. The HTTP API preserves submitted bytes without trimming; Console
  textareas use LF newlines. Never treat empty as omission.
- The Console renders four editable text fields populated with the exact stock
  template bodies for the deployed OpenClaw pin ([currently `2026.9.1`](/deploy/runtime/Dockerfile#L6));
  unchanged fields are submitted and therefore explicitly applied. Store copied
  defaults in one versioned Console source, with a parity check against [the
  pinned templates][native-templates] after [the native front-matter removal][native-render].
  Include whitespace and final newline. Console submits a defaults-set identity
  with its values; OCC validates and stages that identity privately. First deployment
  checks it against the actual runtime templates, including an Agent created before
  an upgrade. Mismatch fails before execution. API callers supplying their own
  explicit contents may omit that preview identity.
- Reuse the [live content rules](/docs/reference/agents.md#workspace-files): valid
  Unicode, no NUL, at most 16 KiB UTF-8 per file. Unknown keys or invalid content
  reject the entire request before writes. Keep the existing bounded HTTP request
  protection while admitting all four maximum valid strings, including JSON escape
  expansion. The create response and navigation remain unchanged; create never deploys.
- Agent creation retains its namespace-scoped `create` and Configuration access
  checks, with the same session CSRF boundary. OCC atomically creates one private
  staging record with the exact Namespace/Agent when at least one key is present;
  a rejected create leaves neither Agent nor staged content. This is setup delivery
  state, with no public read/edit endpoint and no change to later exact-Agent
  `read`/`operate` authorization. Request replay uses existing create outcome and
  conflict behavior; it must never rewrite an already-created Agent's staged input.

### First deployment, retry, and ownership

- The worker passes the exact Agent's pending setup to Compute via private startup
  delivery, outside the immutable revision and normal workload configuration. Use
  the native `main` workspace selected by the effective gateway configuration;
  reject unsupported locations outside the exact Agent's durable managed storage.
  Never send these documents through the post-activation workspace PUT sequence.
- Compute runs one initializer against that durable workspace before any gateway or
  Harness process can accept a model turn, inbound channel, or scheduled task. A
  single runtime-local completion marker scoped to the setup ID and Agent lives
  with that workspace. OCC exposes failure through
  existing revision/deployment status and withholds activation while unconfirmed.
  Failure or an unknown outcome must never open execution with partially applied input.
- Preserve native first-workspace provisioning by running the pinned native setup
  without starting runtime execution before applying overrides. Preserve native Git
  initialization and native BOOTSTRAP lifecycle for unchanged/customized profiles.
  For each supplied file, atomically replace an existing stock default or create it if
  absent; equality with the submitted bytes is already satisfied. Check/update under
  exclusive startup ownership with path/symlink containment. If interrupted, retry
  that same setup only: use stock/submitted-byte comparison without a per-file
  journal, preserve completed files, and reject unexpected differing
  content rather than overwrite it. Commit the local completion marker only after
  all supplied files have been durably applied; this allows retry after a lost
  acknowledgement without replaying a completed operation or damaging later edits.
- On completion, delete staged document bytes and private delivery copies; retain
  only the exact setup identity/completion metadata for lifecycle recovery. Delete
  pending bytes when the Agent is deleted; failed or never-deployed Agents retain
  them until successful initialization or deletion. Once complete, stop/start,
  failed deployment retry, and later revisions never reapply input. Unexpected
  loss/mismatch of an initialized workspace or its marker fails closed for operator
  recovery; initial payloads are not a backup. Agents created without supplied keys
  follow the current runtime path.
- Restrict OCC staging and runtime delivery to the exact Namespace/Agent and the
  controller/worker/runtime identities involved. Use protected database and delivery
  channels; no plaintext document values in audit, logs, tracing, errors, container
  environment/arguments, public responses, or post-completion records. Audit only
  actor/Agent, supplied filenames and lifecycle outcome; continue using the gateway
  and its native file API for all authorized edits after deployment.

## Implementation

1. Extend the [create schema](/packages/contracts/src/api/common.ts#L320),
   [HTTP adapter](/apps/controller/src/index.ts#L2519), [OCC create transaction](/packages/occ/src/index.ts#L1957),
   and existing [state implementations](/packages/occ/src/state/platform-state.ts)
   with private staged delivery and cleanup. Keep Agent/revision public schemas unchanged.
2. Extend [Compute startup context](/packages/contracts/src/index.ts#L212) and the
   [worker](/apps/controller/src/worker.ts#L1702). Kubernetes can use its current
   [dedicated and embedded durable mounts](/apps/controller/src/drivers/compute/kubernetes/index.ts#L4458);
   SSH can use its [exact-Agent state](/apps/controller/src/drivers/compute/ssh/remote-helper.cjs#L541).
   Docker needs an exact-Agent durable workspace across container replacement; its
   [current tmpfs](/apps/controller/src/drivers/compute/docker/index.ts#L654) cannot
   preserve files or the marker. Fail closed wherever private delivery or durable
   initialization is unsupported; provide the normal status reason without content.
3. Update the [Console create form](/apps/controller/src/console/agents/create.mjs#L464)
   and render defaults as text, never HTML. On implementation, update current
   [Agents](/docs/reference/agents.md#workspace-files), [deployment](/docs/reference/agents/deployment.md),
   [Console](/docs/reference/console.md#edit-workspace-files), and the [workspace flow](/docs/flows/workspace-files.md).

## Verification

| Required outcome                              | How to verify                                                                                                                                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preview and saved bytes match the runtime pin | Fixture parity against all four rendered release templates; Console submits unchanged and blank values; reject preview A with runtime B. Verify native Git and BOOTSTRAP behavior and browser LF semantics.                                                           |
| Ownership and request semantics               | Through the real Console/API and PostgreSQL, cover defaults, omission, a partial map, empty values, four maximum escaped documents, invalid input atomicity, and cross-Namespace denial. Confirm no contents in resource reads or captured telemetry/audit.           |
| First use cannot race setup                   | Extend real Agent workflow integration for supported Kubernetes embedded/dedicated, Docker modes, and SSH embedded; force a failure between file writes, prove channels/model/scheduled work cannot run, then recover and observe submitted content before first use. |
| No replay or edits lost                       | Lose acknowledgement after local completion; edit through the native gateway where available, then restart and redeploy and confirm content stays edited. Exercise unknown/diverged file, missing marker/storage, and deletion cleanup.                               |

## Manual Notes

- Real native setup and SSH/systemd workflow passed, including exact/empty bytes,
  native provisioning, restart protection, preserved edits, and a successful first
  model response after file setup. The response does not prove instruction obedience.
  A real SSH partial-write failure also withheld all runtime execution, preserved
  divergent content on retry, and recovered after the conflict was removed.
- Kubernetes live proof is blocked locally: k3s cannot start because this host lacks
  the required cpuset cgroup. Conformance checks do not replace that proof.
- Docker embedded and dedicated native proofs passed after correcting shared
  workspace mounts and existing model-probe environment delivery.
  The regular Docker API/model journey retains its documented authentication
  admission limitation.

## Changelog

- 2026-09-22: Implemented private staging, native initialization and restart guards, Console defaults, and real integration coverage; independent review fixes are complete; final verification and the full live acceptance matrix remain.

- 2026-09-22: User authorized implementation with sw-loop; incorporated both reviews: one marker, private preview identity, native setup before overrides, and API/browser newline semantics.

- 2026-09-22 03:50: Drafted from Enterprise `f3dbdd41c8f3b49573d1353a4b06ce510ee43a56` and the packaged OpenClaw pin (session `01a0c73a-cdc5-7e81-8c14-f1b59251894f`).

[native-files]: https://github.com/openclaw/openclaw/blob/v2026.9.1/src/agents/workspace.ts#L58-L70
[native-render]: https://github.com/openclaw/openclaw/blob/v2026.9.1/src/agents/workspace.ts#L190-L208
[native-templates]: https://github.com/openclaw/openclaw/tree/v2026.9.1/docs/reference/templates
