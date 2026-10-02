# Runtime and isolation acceptance

- [Installation baseline](#installation-baseline)
- [Standard runtime branches](#standard-runtime-branches)
- [Contributor repository access](#contributor-repository-access)
- [Linear human approval](#linear-human-approval)
- [Session continuity and lifecycle](#session-continuity-and-lifecycle)
- [Authorization and network boundaries](#authorization-and-network-boundaries)
- [Completion](#completion)

These cases are required by [main](./main.md). Use its Console-only provisioning,
credential handling, ownership, and evidence rules. Each selected supported
topology must report each applicable case; a quota or authentication failure
blocks the affected runtime, not the rest of the run. Never count preset visibility
as runtime execution. Historical QA results do not establish a new run's result.

## Installation baseline

Check the rendered inputs before deployment and verify the installed resources
as each baseline Agent becomes ready:

- Use a fresh isolated database and record its migration state. Verify the
  application uses its limited role rather than the migration/admin role.
- For EKS, verify encrypted block storage configuration before the first Agent
  (gp3 for the EKS QA profile), then its actual claim bindings after deployment.
  Verify private access with trusted TLS and reviewed Codex seccomp on every eligible
  Agent node. With the selected image, prove workspace writes succeed, writes
  outside the workspace fail, and a missing required profile prevents startup.
  Link the actual checks from the [Kubernetes testing guide](../../../../docs/testing/kubernetes.md).
- Configure the exact API-proxy sources from the
  [networking contract](../../../../docs/reference/drivers/kubernetes-compute/networking-and-isolation.md).
  Prove runtime status/workspace acknowledgement works across eligible nodes
  with NetworkPolicies enforced and no plugins enabled. Do not infer success
  from a populated `pluginStatusProxySourceCidrs` field.
- Before Slack Agent deployment, follow [both proxy paths](../../../../docs/guides/integrations/slack.md#configure-both-slack-proxies).
  Verify Console channel/user lookup and credential validation, then a real
  gateway message/reply. A working gateway does not prove API proxy configuration.
  Verify the managed proxy denies unrelated public and private destinations.

## Standard runtime branches

Provision from each standard preset through Console, separately from the
SWE Agent. Use unique names and record the actual Driver and image IDs.

| Branch            | Required evidence                                                                                                                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard Codex    | Dedicated execution, matching Codex Plugin Driver, selected service-account authentication, successful model response, and real shell write/read of a unique workspace marker. First prove deployment without plugins, then enable Linear and prove an actual authenticated tool read. |
| Standard OpenClaw | Embedded execution, matching OpenClaw Plugin Driver, authorized compatible model credential, successful model and shell turns, and an actual supported plugin invocation with an observable result. Also prove authenticated native UI access and contributor repository access below. |

Follow the current [bundled Driver catalog](../../../../docs/reference/drivers/plugin-bundled.md)
for exact Driver identifiers and supported plugins. Use a separate fresh
Installation when Driver selection differs; do not change a live Installation's
Driver to make both rows appear covered. Codex Linear authentication is not proof
of OpenClaw plugin access. Record a missing prerequisite as blocked.

Embedded OpenClaw with external Slack is unsupported under the current credential
isolation contract. Keep its Slack channel disabled and report that boundary;
exercise Slack through dedicated Codex only. Do not weaken isolation to obtain
an OpenClaw Slack pass.

## Contributor repository access

For each runtime branch, use its separate standard Agent and an explicitly
approved **Contributor** profile with issue management off (`git-write`). Keep
the SWE Agent's two read-only bindings and denial probes unchanged. Follow the
[repository permission guide](../../../../docs/guides/repository-credentials/installation.md)
for the supported profile and exact numeric repository scope.

1. Resolve one authorized repository and a unique disposable branch per runtime;
   independently verify the remote ref is absent. Authorize only the harmless
   commit, non-force push, and exact-ref cleanup. Preserve hooks and protected refs.
2. Through the Agent, clone/fetch the repository, create an empty or harmless
   commit, and push that branch. A host-side push cannot substitute for the Agent.
3. Independently read the remote ref and match its SHA to the Agent's commit.
4. Have the Agent delete only the owned ref with an exact-SHA lease; independently
   verify absence. If the SHA changed, stop cleanup and report the conflict.
   After an uncertain push or deletion, inspect remote state before retrying.

## Linear human approval

On Standard Codex, configure the supported
[write-action policy and human reviewer](../../../../docs/reference/agent-plugins.md#codex-specific-policy)
through Console and deploy. The selected tool must be enabled: a disabled-tool
rejection is not an approval prompt. Record the connected account, designated
human reviewer, and a unique disposable issue title without exposing credentials.

Request one bounded issue-creation attempt. Capture the actual tool approval,
have the designated human choose **Deny**, and verify the denied tool did not
execute. Independently query Linear for the exact title, covering pagination and
archived records, to prove no issue was created. Model refusal, automatic denial,
or unavailable authentication does not pass this case. If a write unexpectedly
succeeds, record failure and resolve cleanup within the run's explicit authority;
do not silently delete evidence or retry.

## Session continuity and lifecycle

For dedicated Codex, give the Slack thread a unique word and request a real
workspace tool read. Open that exact conversation from the authenticated native
UI and ask for the word without supplying it again. Verify the answer and
correlate the Slack thread, gateway identity, and persisted native session.
Use canonical runtime evidence rather than assuming a legacy session-file path.
A reply from another consumer of a shared app does not count. Report whether the
native reply also appears in Slack separately; mirroring is not this assertion.

For both standard runtimes, retain a unique workspace file and conversation
marker. Redeploy a revision, then separately stop and deploy again through
Console. After each transition, verify the expected storage identity, file
contents, conversation history, and a fresh real tool turn. Repeat the Slack
reply and native UI launch for the Codex branch. Saved configuration alone is
insufficient persistence evidence.

Record one deploy-request-to-ready duration and its subsequent tool-response
duration, with source/image identity and image-cache/storage state. Repeated
warm/cold cohorts and instrumentation are optional profiling work, not required
main acceptance. Do not label a start cold after safety probes warmed its image.

## Authorization and network boundaries

Use the real installed policies and documented read-only observer probes. Record
positive controls so broken connectivity or credentials cannot masquerade as denial.

- Verify exact Agent Secret grants and workload mounts: model credentials belong
  only in the selected Harness/embedded runtime, never a separate gateway or OCC.
  Record references and destinations, never values. Prove cross-Agent and
  cross-tenant Kubernetes Secret access is denied with the tested caller identity.
- For shared-session native administration, verify native UI permits the authorized human and rejects anonymous access,
  spoofed identity headers, and an OCC service key used as browser authentication.
- Prove permitted status/gateway traffic succeeds while an otherwise egress-enabled
  untrusted probe cannot reach protected Agent/gateway ingress. Distinguish an
  enforced destination policy from DNS failure or the probe's own egress denial.
- Retain attributable audit evidence for successful mutations and denials. Classify
  unexpected reconciliation failures even if a later deployment succeeds.

For Compose/Kubernetes, follow its setup reference's native-access boundary.
Password-authenticated local access is distinct from shared-session browser
administration; report unsupported shared-session checks explicitly, not passed.

## Completion

Merge these results into main's matrix with separate rows per runtime/topology.
Preserve original failures and repaired reruns. Honor the resolved retention
choice, including whether Agents must remain running. If shutdown is selected,
stop run-owned Agents and verify their runtime Pods are gone before closing
run-owned access processes or removing infrastructure. If running state is to
be retained, preserve its required services and access; record Agent states,
claims, infrastructure, access processes, and resume/cleanup instructions. An
ambiguous retention request requires clarification before destructive cleanup. Do not stop
other Slack consumers or delete shared credentials. A blocked required runtime
keeps overall acceptance incomplete even when every runnable Codex case passes.
