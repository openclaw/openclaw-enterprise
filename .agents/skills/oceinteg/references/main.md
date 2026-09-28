# Main acceptance test

Run `oceinteg main` to prove a fresh supported Helm installation through the
Console and a real Slack-connected Agent. Run repository commands from the
repository root. Use current supported procedures from the
[testing index](../../../../docs/testing/README.md),
[production installation guide](../../../../docs/guides/deploy/production-installation.md),
[Agent setup guide](../../../../docs/guides/deploy/production-agents.md), and
[repository installation guide](../../../../docs/guides/repository-credentials/installation.md).

This scenario sends test messages in the selected Slack channel and creates and
deletes uniquely named disposable Git branches. Resolve the targets and existing
authorization before those actions. Do not open PRs, merge, force-push, alter
protected refs, or change unrelated installations. Use only test-owned resources.

## Resolve inputs before provisioning

Reuse inputs already supplied by the user; ask only for missing decisions. Record
nonsecret selections in the run report. Never record credential values.

| Input                   | Required selection                                                                                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Topology                | Resolve “two clusters”: two Kubernetes clusters or two OCE Namespaces. Record provider, region when applicable, exact contexts, release names, and which scenarios run on each. Helm installs into clusters; it does not create them. Do not infer cloud-creation authorization from an ambiguous count. |
| Images and source       | Choose a compatible published release or operator-supplied custom immutable controller/runtime/broker images. Record source revision, chart version, image digests, architecture, and runtime provenance. Resolve “latest” once; fail explicitly if no compatible published pair is available.           |
| Model authentication    | Use the user-selected existing service-account credential and supported model. For a directly supplied token, select dedicated Codex and Console **Service Accounts** (`codex_pat`). Do not silently substitute an API key or another account when authentication, quota, or model access fails.         |
| Slack                   | Resolve the supplied credential item to its app-level and bot tokens without printing either. Record workspace, bot identity, channel ID, and authorized test sender. Confirm app subscriptions/scopes and channel membership. Only one test deployment may consume the same Slack identity at a time.   |
| GitHub App              | Obtain operator-supplied App ID, installation ID, private-key reference, numeric repository IDs, and approved permissions for both repositories below. Keep inputs protected and outside chart values and Agent configuration.                                                                           |
| Linear                  | Supply the selected workspace, a known readable issue, and any required plugin authentication. Catalog visibility or an enabled badge alone is not authentication proof.                                                                                                                                 |
| Browser access          | Supply Console URL, operator login, native UI domain and certificate, and the required routing/cookie-domain inputs.                                                                                                                                                                                     |
| Ownership and retention | Record a run ID, disposable branch names, owned infrastructure and resource IDs, evidence directory outside the checkout, timeouts, and whether successful resources should be retained. Preserve unrelated state and the default kubeconfig/context.                                                    |

Credential-store item names are private runtime inputs, not repository defaults.
Use the host's supported credential tooling. Never expose credentials in commands,
logs, screenshots, transcripts, or reports, and never manually handle refresh
tokens. Credential failures block affected assertions; they are not permission
to weaken security or switch identities.

Before accessing a credential store or entering values in Console, follow
[Supply credentials](./credentials.md) for field selection, protected retrieval,
and the supported binding steps.

## Installation acceptance

Use standard Helm installation with the following profile:

- Enable standard presets and the DevDay preset set, including **Community
  Agent**. Verify the expected preset names in the Console of each selected OCE
  Namespace. Verify later Namespace seeding and that rerendering/reconciliation
  preserves an existing customized preset.
- Select `drivers.plugin.id: codex-plugin` with
  `drivers.plugin.configuration.catalogSource: openai-curated`. Verify the
  selected controller supports that catalog and the selection survives rerenders.
- Enable Envoy routing and native UI. Complete the
  [workspace routing](../../../../docs/guides/deploy/workspace-routing.md) and
  [native admin prerequisites](../../../../docs/guides/deploy/native-admin.md),
  including DNS, trusted HTTPS, Gateway API/controllers, scoped RoleBindings in
  both data-plane and Gateway namespaces, and reviewed Codex seccomp on eligible
  nodes. For EKS, follow its actual network/storage prerequisites; local k3d
  results do not establish EKS readiness.
- Exercise a fresh broker-omitted case: no App inputs are required, installation
  succeeds, and no broker workload or repository grant is created. Then exercise
  the configured case through the documented enablement path or a separate fresh
  release, according to the selected topology. Do not silently enable it.
- For the configured case, derive the origin and certificate DNS SAN from the
  rendered chart. Verify CA trust, Git routing, and the exact broker hostname in
  the effective Codex allowlist. Retain TLS validation, repository authorization,
  explicit network denies, `mode = "full"`, and `allow_local_binding = true`.
  Keep workspace sandboxing enabled; full network mode does not mean full
  filesystem access. Do not reintroduce patched private-endpoint capabilities.

Use real compatible runtime images and an isolated fresh database. Fixture
controllers, preexisting repaired deployments, and Helm rendering alone cannot
satisfy installation acceptance. Test both release and custom-image selection
paths if claiming support for both; otherwise name the untested path.

## Provision through Console only

Infrastructure, chart bootstrap, and operator-owned installation inputs may use
their documented CLI procedures. After bootstrap, perform all Agent creation,
credential binding, permission selection, plugin selection, channel settings,
and deployment through the Console. Read-only API, Kubernetes, and provider
inspection may verify outcomes. A required SQL write, direct API mutation, pod
patch, or manual runtime-file repair fails the Console-only criterion.

1. Create `ted-backup` using **Community Agent** (the actual preset name), with
   the selected service-account authentication and dedicated Codex runtime.
   If that name already exists, do not overwrite it; resolve an isolated target.
2. Configure the test channel, default `oce-feedback-test`, using its exact ID.
   The preset's existing allowlist does not include this channel. Set no-mention
   handling and reply-in-thread behavior explicitly through supported controls.
3. Bind `openclaw/openclaw-enterprise` with `git-write` and
   `openclaw/openclaw` with `git-read`. Select permissions explicitly; do not
   infer them from the App's installation repository list or Console defaults.
   If Console cannot represent these different permissions, record a product
   failure rather than supplying the binding through an API.
4. Resolve the preset's read-only role before the Git-write test. Through the
   Console, add a narrow Agent-specific instruction authorizing the designated
   sender's disposable branch test in the two selected repositories. Preserve
   the preset globally and its other restrictions. If no supported Console path
   exists, report the conflict; a model refusal cannot prove broker enforcement.
5. Enable Linear from the curated catalog and complete its required authentication
   through supported Console/plugin flows. Keep the Community role's Linear
   access read-only.
6. Deploy. Require the selected revision to become active, its real workloads to
   become Ready, and a genuine model turn to succeed. Reload Console and confirm
   saved selections. Record the Agent and revision IDs for later attribution.

## Exercise the real Agent

Use an authorized human sender for the no-mention test, unless the user explicitly
selected and configured a bot sender. Existing
[Slack fixture settings](../../../../docs/testing/slack.md) require mentions and
override reply mode; that fixture is not proof of this scenario.

| Check                         | Required evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unmentioned channel message   | Send a relevant top-level question without mentioning the bot. Receive an answer from the selected Agent in that message's thread, with matching `thread_ts` and no stray top-level response.                                                                                                                                                                                                                                                                         |
| Thread follow-up              | Send an unmentioned follow-up in the same thread. Verify a contextual reply in the same thread from the same Agent.                                                                                                                                                                                                                                                                                                                                                   |
| Linear                        | Ask for the known permitted issue. Verify a real successful Linear tool call and accurate issue identity, title/status, and link. The preset's graceful fallback is useful behavior but is not a passed Linear test.                                                                                                                                                                                                                                                  |
| Allowed repository            | From Slack, request sandboxed clone, fetch, one harmless file/commit, and push to a unique disposable branch in `openclaw-enterprise`. Verify native tool execution and independently read back the remote SHA and exact file. No host-run push may substitute for the Agent operation.                                                                                                                                                                               |
| Read-only repository          | First prove clone/fetch of `openclaw` succeeds. Request a push to a unique disposable branch there. Require an actual authorization denial, not a model refusal, missing credential, timeout, DNS failure, or broken Git command. Independently confirm the remote ref stayed absent/unchanged. If it unexpectedly succeeds, record the failure and remove only that owned ref after verifying ownership.                                                             |
| Broker and sandbox boundaries | Confirm valid TLS to the rendered host, wrong-host/untrusted-CA rejection, an explicit Codex domain deny with a positive reachability control, and denied out-of-workspace writes with a writable positive control. Distinguish client-side refusal from server-side authorization. When needed, use a separately identified trusted observer probe with valid scoped credentials to establish broker denial; do not expose those credentials to the model or report. |
| Native Control UI             | Launch from the selected Agent's Console action. Require authenticated content, a live connection, a harmless read, and successful reload. Verify an unauthenticated browser cannot reach Agent content. Opening an empty tab is not a pass.                                                                                                                                                                                                                          |
| Persistence                   | Redeploy once through Console. Verify saved repository permissions, plugin and channel settings, then repeat a Slack/model response and Control UI launch. Verify working state survives the expected lifecycle.                                                                                                                                                                                                                                                      |

Keep each assertion tied to its actual installation, Agent revision, Slack
thread, and Git ref. If two targets are selected, state exactly which assertions
ran on each. Do not generalize one target's results to the other.

## Diagnose, clean up, and report

Set bounded deadlines before execution. Classify failures as product, harness,
infrastructure, or credentials using observed evidence. Do not weaken assertions
or repair the running Agent outside Console to obtain a pass. If a fix is within
the task's authorization, retain the failed evidence and rerun the affected
supported path from a clean state; otherwise report the blocker.

After an uncertain write or transport timeout, independently inspect provider
state before retrying. Never blindly replay a push. Verify ownership and the
current ref SHA before deleting only the run's branches. Stop the test Agent
through Console and verify runtime/material cleanup before removing owned
installation resources, unless the user requested retention. Do not falsify
repository disposal state or delete unknown historical cleanup records. Preserve
Slack evidence links; do not delete shared messages without explicit scope.

Return an acceptance matrix with **passed**, **failed**, **blocked**, or **not
run** for every required check and target. Include source/chart/image identities,
actual commands, Console screenshots or walkthrough, Slack links, sanitized tool
evidence, remote Git readback, failures/retries, and cleanup or retained-resource
status. State verification limits, particularly local versus EKS proof. A blocked
or unrun required assertion makes the overall scenario incomplete.
